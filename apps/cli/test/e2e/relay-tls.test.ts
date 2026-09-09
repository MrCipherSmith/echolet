import { afterAll, beforeAll, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { request as httpsRequest } from "node:https";
import { connect as tlsConnect } from "node:tls";
import { randomBytes, randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, renameSync, rmSync } from "node:fs";
import { networkInterfaces, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { E2E_CHILD_TIMEOUT_MS, E2E_TEST_TIMEOUT_MS } from "../childProcessTimeouts";

/**
 * Flow 002 / T8 — the relay serves HTTPS, and it fails loudly rather than quietly
 * serving plain HTTP when TLS is half configured.
 *
 * This suite drives the REAL relay binary and the REAL `dist/cli.js`, the same way
 * `two-process.test.ts` does. The certificate comes from the relay module's own
 * `gencert` helper rather than from an `openssl` binary, so the suite does not
 * depend on which OpenSSL dialect a host happens to ship. On the deployment target
 * the pair comes from `tailscale cert` instead; the relay reads files either way.
 *
 * Where a non-loopback IPv4 address exists on this host the suite uses it, because
 * that is the case AC4 is about: `apps/cli/src/runtime/config.ts` refuses a
 * non-loopback relay URL that is not HTTPS, so the exchange below could not happen
 * at all without TLS. Verification from a genuinely different machine is T10's.
 */

const project = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const suite = mkdtempSync(join(tmpdir(), "echolet-tls-e2e-"));
const binary = join(suite, "relay"), cli = join(project, "apps/cli/dist/cli.js");
const tlsDir = join(suite, "tls"), renewalDir = join(suite, "tls-renewed");
const certPath = join(tlsDir, "cert.pem"), keyPath = join(tlsDir, "key.pem");
const renewedCert = join(renewalDir, "cert.pem"), renewedKey = join(renewalDir, "key.pem");

interface Result { code: number | null; stdout: string; stderr: string }
function command(executable: string, args: string[], env: Record<string, string> = {}, timeoutMs = E2E_CHILD_TIMEOUT_MS): Promise<Result> {
  return new Promise((done, reject) => {
    const child = spawn(executable, args, { cwd: project, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("TLS E2E child timeout")); }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", (code) => { clearTimeout(timer); done({ code, stdout, stderr }); });
  });
}

async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((done, reject) => {
    const force = setTimeout(() => child.kill("SIGKILL"), 1500);
    const limit = setTimeout(() => reject(new Error("Relay teardown timeout")), 4000);
    child.once("close", () => { clearTimeout(force); clearTimeout(limit); done(); });
    child.kill("SIGTERM");
  });
}

/** Reserve an ephemeral port on `host` and hand it back, the same trick two-process.test.ts uses. */
async function reservePort(host: string) {
  const server: Server = createServer();
  const port = await new Promise<number>((done, reject) => {
    const timer = setTimeout(() => reject(new Error("Port reservation timeout")), 3000);
    server.once("error", (error) => { clearTimeout(timer); reject(error); });
    server.listen(0, host, () => {
      clearTimeout(timer);
      const address = server.address();
      if (!address || typeof address === "string") { reject(new Error("Missing reserved address")); return; }
      done(address.port);
    });
  });
  await new Promise<void>((done, reject) => server.close((error) => (error ? reject(error) : done())));
  return port;
}

/** The first non-loopback IPv4 address on this host, if it has one. */
function nonLoopbackAddress(): string | undefined {
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) if (address.family === "IPv4" && !address.internal) return address.address;
  }
  return undefined;
}
const nonLoopback = nonLoopbackAddress();
const host = nonLoopback ?? "127.0.0.1";

interface HttpsAnswer { status: number; body: string }
/**
 * node:https rather than fetch, because the trust anchor has to be supplied per
 * request. `ca` is one certificate file, not a bundle: Node 26 loads only the
 * FIRST certificate from a multi-PEM trust file (measured - a second anchor in the
 * same file answers DEPTH_ZERO_SELF_SIGNED_CERT), and the same is true of
 * NODE_EXTRA_CA_CERTS, so the renewal below trusts each pair explicitly.
 */
function httpsGet(url: string, caPath: string, timeoutMs = 3000): Promise<HttpsAnswer> {
  return new Promise((done, reject) => {
    const request = httpsRequest(url, { ca: readFileSync(caPath), timeout: timeoutMs, minVersion: "TLSv1.2" }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => { body += chunk; });
      response.on("end", () => done({ status: response.statusCode ?? 0, body }));
    });
    request.once("timeout", () => { request.destroy(new Error("HTTPS request timeout")); });
    request.once("error", reject);
    request.end();
  });
}

/** The SHA-256 fingerprint of the certificate the relay is serving right now. */
function servedFingerprint(port: number, caPath: string, timeoutMs = 3000): Promise<string> {
  return new Promise((done, reject) => {
    const socket = tlsConnect({ host, port, ca: readFileSync(caPath), minVersion: "TLSv1.2", timeout: timeoutMs }, () => {
      const peer = socket.getPeerCertificate();
      const fingerprint = peer.fingerprint256;
      socket.end();
      if (!fingerprint) { reject(new Error("Peer presented no certificate")); return; }
      done(fingerprint);
    });
    socket.once("timeout", () => { socket.destroy(new Error("TLS connect timeout")); });
    socket.once("error", reject);
  });
}

async function relayReady(port: number, child: ChildProcess, caPath: string) {
  const end = Date.now() + 15000;
  while (Date.now() < end) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error("Relay exited during startup");
    try { if ((await httpsGet(`https://${host}:${port}/health`, caPath, 800)).status === 200) return; } catch { /* bounded startup retry */ }
    await delay(50);
  }
  throw new Error("Relay readiness timeout");
}

function startRelay(port: number, dataDir: string, extra: Record<string, string> = {}) {
  const relay = spawn(binary, [], {
    cwd: project,
    env: {
      ...process.env,
      ECHOLET_HTTP_ADDR: `${host}:${port}`,
      ECHOLET_DATA_DIR: dataDir,
      ECHOLET_RATE_LIMIT_PER_MINUTE: "1000",
      ECHOLET_TLS_CERT_FILE: certPath,
      ECHOLET_TLS_KEY_FILE: keyPath,
      ...extra,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  relay.stdout.on("data", (chunk: Buffer) => { log += chunk.toString(); });
  relay.stderr.on("data", (chunk: Buffer) => { log += chunk.toString(); });
  return { relay, readLog: () => log };
}

beforeAll(async () => {
  // dist/cli.js is built once by the vitest globalSetup (apps/cli/test/globalSetup.ts).
  expect(existsSync(cli)).toBe(true);
  const gocache = { GOCACHE: join(project, ".gocache") };
  expect((await command("go", ["-C", "apps/relay", "build", "-o", binary, "./cmd/relay"], gocache, 180000)).code).toBe(0);

  const hosts = ["localhost", "127.0.0.1", host].join(",");
  for (const out of [tlsDir, renewalDir]) {
    const generated = await command("go", ["-C", "apps/relay", "run", "./internal/devcert/gencert", "--out", out, "--hosts", hosts], gocache, 180000);
    expect(generated.code, "gencert must produce a key pair").toBe(0);
  }
  // Two independent self-signed pairs: the one the relay starts with, and the one
  // the renewal test drops in on top of it.
  expect(readFileSync(certPath, "utf8")).not.toBe(readFileSync(renewedCert, "utf8"));
}, 240000);

afterAll(() => rmSync(suite, { recursive: true, force: true }));

/**
 * The worst possible outcome of this task would be a relay that comes up on plain
 * HTTP after the operator asked for TLS: it answers /health, it looks healthy, and
 * every envelope crosses the network in the clear. Each case below must exit
 * non-zero and leave nothing listening.
 */
it("refuses to start on an incomplete TLS configuration instead of falling back to plain HTTP", async () => {
  const port = await reservePort(host);
  const dataDir = join(suite, "refusal-data");
  const cases: Array<{ name: string; env: Record<string, string>; expect: string[] }> = [
    { name: "certificate without key", env: { ECHOLET_TLS_CERT_FILE: certPath, ECHOLET_TLS_KEY_FILE: "" }, expect: ["ECHOLET_TLS_CERT_FILE", "ECHOLET_TLS_KEY_FILE"] },
    { name: "key without certificate", env: { ECHOLET_TLS_CERT_FILE: "", ECHOLET_TLS_KEY_FILE: keyPath }, expect: ["ECHOLET_TLS_CERT_FILE", "ECHOLET_TLS_KEY_FILE"] },
    { name: "certificate file missing", env: { ECHOLET_TLS_CERT_FILE: join(tlsDir, "absent.pem") }, expect: ["absent.pem"] },
    { name: "key that does not match the certificate", env: { ECHOLET_TLS_KEY_FILE: renewedKey }, expect: ["key pair"] },
  ];

  for (const scenario of cases) {
    const { relay, readLog } = startRelay(port, join(dataDir, scenario.name.replace(/\W+/g, "-")), scenario.env);
    const code = await new Promise<number | null>((done, reject) => {
      const timer = setTimeout(() => { relay.kill("SIGKILL"); reject(new Error(`Relay did not exit for: ${scenario.name}`)); }, 10000);
      relay.once("close", (value) => { clearTimeout(timer); done(value); });
    });
    expect(code, `${scenario.name}: the relay must exit non-zero`).not.toBe(0);
    for (const fragment of scenario.expect) {
      expect(readLog().includes(fragment), `${scenario.name}: the failure must name ${fragment}`).toBe(true);
    }
    // Nothing is listening: the refusal is total, not a downgrade.
    await expect(fetch(`http://${host}:${port}/health`, { signal: AbortSignal.timeout(1000) })).rejects.toThrow();
  }
}, E2E_TEST_TIMEOUT_MS);

it("serves HTTPS and completes a full two-party exchange with the real CLI", async () => {
  const port = await reservePort(host);
  const directory = join(suite, "scenario");
  const alice = join(directory, "alice"), bob = join(directory, "bob"), data = join(directory, "relay-data");
  const aliceKey = randomBytes(32).toString("base64url"), bobKey = randomBytes(32).toString("base64url");
  const firstText = `TLS_E2E_FIRST_${randomUUID()}`, replyText = `TLS_E2E_REPLY_${randomUUID()}`;
  const markers = [firstText, replyText, aliceKey, bobKey];
  const relayUrl = `https://${host}:${port}`;

  const { relay, readLog } = startRelay(port, data);
  try {
    await relayReady(port, relay, certPath);

    const health = await httpsGet(`${relayUrl}/health`, certPath);
    expect(health.status).toBe(200);
    expect(JSON.parse(health.body).data.status).toBe("healthy");

    async function run(profile: string, args: string[], expected = 0, history = false) {
      const result = await command(process.execPath, [cli, ...args, "--profile", profile, "--json"], {
        ECHOLET_E2E_KEY: profile === alice ? aliceKey : bobKey,
        NODE_EXTRA_CA_CERTS: certPath,
      });
      const value = JSON.parse(result.stdout) as { ok: boolean; data: Record<string, unknown>; error?: { code: string } };
      const safeCode = /^[A-Z_]+$/.test(value.error?.code ?? "") ? value.error!.code : "none";
      expect(result.code, `CLI ${args[0]} exit (${safeCode})`).toBe(expected);
      // No plaintext and no store key may appear on either stream.
      for (const marker of markers) { expect(result.stderr.includes(marker)).toBe(false); if (!history) expect(result.stdout.includes(marker)).toBe(false); }
      expect(value.ok).toBe(expected === 0);
      return value.data;
    }
    async function history(profile: string, identity: string) {
      return (await run(profile, ["history", "--with", identity], 0, true)).entries as Array<{ messageId: string; plaintext: string; sequence: number }>;
    }

    if (nonLoopback) {
      // AC4's non-loopback half, asserted rather than assumed: for this very host
      // the CLI refuses plain HTTP, so the exchange below is only possible over TLS.
      const refused = await command(process.execPath, [cli, "init", "--relay-url", `http://${host}:${port}`, "--store-key-env", "ECHOLET_E2E_KEY", "--profile", join(directory, "refused"), "--json"], {
        ECHOLET_E2E_KEY: aliceKey,
        NODE_EXTRA_CA_CERTS: certPath,
      });
      expect(refused.code, "a non-loopback plain HTTP relay URL must be refused").toBe(2);
      expect(JSON.parse(refused.stdout).error.code).toBe("INVALID_CONFIGURATION");
    }

    for (const profile of [alice, bob]) await run(profile, ["init", "--relay-url", relayUrl, "--store-key-env", "ECHOLET_E2E_KEY"]);
    const aliceCard = join(directory, "alice-card.json"), bobCard = join(directory, "bob-card.json");
    await run(alice, ["contact", "export", "--out", aliceCard]);
    await run(bob, ["contact", "export", "--out", bobCard]);
    const a = JSON.parse(readFileSync(aliceCard, "utf8")).signal_bundle.device_record.identity_id as string;
    const b = JSON.parse(readFileSync(bobCard, "utf8")).signal_bundle.device_record.identity_id as string;
    await run(alice, ["contact", "import", "--from", bobCard, "--yes"]);
    await run(bob, ["contact", "import", "--from", aliceCard, "--yes"]);
    await run(alice, ["relay", "publish"]);
    await run(bob, ["relay", "publish"]);

    // Offline delivery: Bob is simply not polling while Alice sends.
    await run(alice, ["send", "--to", b, "--text", firstText]);
    expect((await run(bob, ["poll"])).received).toBe(1);

    // Byte-identical exact retry, then deduplication on the receiving side.
    const messageId = randomUUID();
    const retryArgs = ["send", "--to", b, "--text", `${firstText}_RETRY`, "--message-id", messageId];
    const firstSend = await run(alice, retryArgs);
    const secondSend = await run(alice, retryArgs);
    expect(secondSend.envelopeId).toBe(firstSend.envelopeId);
    expect((await run(bob, ["poll"])).received).toBe(1);
    expect((await run(bob, ["poll"])).received).toBe(0);

    // Reply in the other direction.
    await run(bob, ["send", "--to", a, "--text", replyText]);
    expect((await run(alice, ["poll"])).received).toBe(1);

    const aliceHistory = await history(alice, b), bobHistory = await history(bob, a);
    expect(aliceHistory).toHaveLength(3);
    expect(bobHistory).toHaveLength(3);
    expect(aliceHistory.map((entry) => entry.plaintext)).toEqual(bobHistory.map((entry) => entry.plaintext));
    expect(aliceHistory[0]!.plaintext).toBe(firstText);
    expect(aliceHistory[2]!.plaintext).toBe(replyText);

    // The relay carried ciphertext only; nothing readable reached its log.
    for (const marker of markers) expect(readLog().includes(marker)).toBe(false);
  } finally {
    await stop(relay);
  }
}, E2E_TEST_TIMEOUT_MS);

/**
 * `tailscale cert` renews the pair on disk on its own schedule. A relay that has to
 * be restarted to notice is an outage waiting for renewal day, so the running
 * process must pick up the replacement and keep serving.
 */
it("picks up a renewed certificate without a restart", async () => {
  const port = await reservePort(host);
  const directory = join(suite, "renewal");
  const profile = join(directory, "alice");
  const storeKey = randomBytes(32).toString("base64url");
  const relayUrl = `https://${host}:${port}`;

  // interval 0 makes the recheck deterministic instead of waiting out the default.
  const { relay } = startRelay(port, join(directory, "relay-data"), { ECHOLET_TLS_RELOAD_INTERVAL_SECONDS: "0" });
  try {
    await relayReady(port, relay, certPath);
    const pid = relay.pid;
    // Validated against the pair the relay started with.
    const before = await servedFingerprint(port, certPath);

    // Replace both files by rename, the way a careful renewal writes them.
    for (const name of ["cert.pem", "key.pem"]) {
      const staged = join(tlsDir, `${name}.staged`);
      copyFileSync(join(renewalDir, name), staged);
      renameSync(staged, join(tlsDir, name));
    }

    // Validated against the RENEWED anchor: the served certificate not only has a
    // different fingerprint, it chains to a different self-signed root, so this
    // cannot pass on a cached or stale certificate.
    const after = await servedFingerprint(port, renewedCert);
    expect(after, "the relay kept serving the old certificate after renewal").not.toBe(before);
    expect(relay.pid, "the relay must be the same process").toBe(pid);
    expect(relay.exitCode).toBe(null);
    expect((await httpsGet(`${relayUrl}/health`, renewedCert)).status).toBe(200);

    // And the real client still completes a request against the renewed listener.
    const initialized = await command(process.execPath, [cli, "init", "--relay-url", relayUrl, "--store-key-env", "ECHOLET_E2E_KEY", "--profile", profile, "--json"], {
      ECHOLET_E2E_KEY: storeKey,
      NODE_EXTRA_CA_CERTS: renewedCert,
    });
    expect(initialized.code).toBe(0);
    const published = await command(process.execPath, [cli, "relay", "publish", "--profile", profile, "--json"], {
      ECHOLET_E2E_KEY: storeKey,
      NODE_EXTRA_CA_CERTS: renewedCert,
    });
    expect(published.code, "the CLI must reach the relay over the renewed certificate").toBe(0);
    expect(JSON.parse(published.stdout).ok).toBe(true);
  } finally {
    await stop(relay);
  }
}, E2E_TEST_TIMEOUT_MS);
