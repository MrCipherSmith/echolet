import { afterAll, beforeAll, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { EncryptedSqliteStore } from "@echolet/session-node";
import { createIdentityProfile } from "@echolet/client-core";
import { decodeBase64Url, signUtf8Message } from "@echolet/crypto-core";

const project = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const suite = mkdtempSync(join(tmpdir(), "echolet-real-e2e-"));
const binary = join(suite, "relay"), cli = join(project, "apps/cli/dist/cli.js");
interface Result { code: number | null; stdout: string; stderr: string }
function command(executable: string, args: string[], env: Record<string, string> = {}, timeoutMs = 20000): Promise<Result> {
  return new Promise((done, reject) => {
    const child = spawn(executable, args, { cwd: project, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("E2E child timeout")); }, timeoutMs);
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
async function listen(server: Server) {
  await new Promise<void>((done, reject) => {
    const timer = setTimeout(() => reject(new Error("Loopback listen timeout")), 3000);
    server.once("error", (error) => { clearTimeout(timer); reject(error); });
    server.listen(0, "127.0.0.1", () => { clearTimeout(timer); done(); });
  });
  const address = server.address(); if (!address || typeof address === "string") throw new Error("Missing loopback address");
  return address.port;
}
async function close(server: Server) {
  server.closeAllConnections();
  await new Promise<void>((done, reject) => {
    const timer = setTimeout(() => reject(new Error("Proxy teardown timeout")), 3000);
    server.close((error) => { clearTimeout(timer); error ? reject(error) : done(); });
  });
}
async function relayReady(url: string, child: ChildProcess) {
  const end = Date.now() + 10000;
  while (Date.now() < end) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error("Relay exited during startup");
    try { if ((await fetch(`${url}/health`, { signal: AbortSignal.timeout(500) })).ok) return; } catch { /* bounded startup retry */ }
    await delay(50);
  }
  throw new Error("Relay readiness timeout");
}
beforeAll(async () => {
  // dist/cli.js is built once by the vitest globalSetup (apps/cli/test/globalSetup.ts). Rebuilding
  // it here raced the command suite, which spawns the same binary.
  expect(existsSync(cli)).toBe(true);
  expect((await command("go", ["-C", "apps/relay", "build", "-o", binary, "./cmd/relay"], { GOCACHE: join(project, ".gocache") }, 120000)).code).toBe(0);
}, 150000);
afterAll(() => rmSync(suite, { recursive: true, force: true }));

type Envelope = { envelope_id: string; message_id: string; ciphertext: string; size_bytes: number; [key: string]: unknown };
type HistoryEntry = { messageId: string; direction: string; plaintext: string; sequence: number };
async function nativeSnapshot(profile: string, key: string) {
  const store = new EncryptedSqliteStore(join(profile, "client.sqlite"), Buffer.from(key, "base64url"));
  try { return await store.transaction((tx) => tx.keys().sort().filter((name) => /^(session:|inbox:|pre:|used:)/.test(name)).map((name) => [name, Buffer.from(tx.get(name)!).toString("base64")])); }
  finally { await store.close(); }
}
/**
 * The sender binding `/v1/messages/send` requires from T50 onward (finding T49-F-001), produced
 * here with the profile's real device key so this suite can still inject an envelope the relay
 * accepts. It is rebuilt from primitives rather than by calling the production helper, so the
 * transcript is pinned by this test rather than borrowed from the implementation.
 *
 * The device key is derived from the profile's own seed exactly as `Profile.mailboxAuthorization`
 * does, is zeroed immediately after use, and is never printed.
 */
async function senderSignature(profile: string, storeKey: string, envelope: Envelope) {
  const store = new EncryptedSqliteStore(join(profile, "client.sqlite"), Buffer.from(storeKey, "base64url"));
  try {
    const seed = await store.transaction((tx) => (JSON.parse(Buffer.from(tx.get("cli:profile")!).toString("utf8")) as { seed: string }).seed);
    const identity = await createIdentityProfile({ seed, deviceLabel: "cli-device" });
    const key = decodeBase64Url(identity.deviceSecretKey);
    try {
      const digest = createHash("sha256").update(envelope.ciphertext, "utf8").digest("base64url");
      return signUtf8Message(
        `echolet-mailbox-envelope:v1:${String(envelope.recipient_mailbox_id)}:${envelope.envelope_id}:` +
          `${String(envelope.sender_identity_id)}:${String(envelope.sender_device_id)}:${digest}:` +
          `${String(envelope.created_at_ms)}:${String(envelope.expires_at_ms)}`,
        key,
      );
    } finally { key.fill(0); }
  } finally { await store.close(); }
}
const postEnvelope = async (proxyUrl: string, envelope: Record<string, unknown>) =>
  (await fetch(`${proxyUrl}/v1/messages/send`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ envelope }), signal: AbortSignal.timeout(5000) })).status;
const bounded4xx = (status: number) => status >= 400 && status < 500;

function scan(directory: string, markers: string[]) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) scan(path, markers);
    else if (entry.isFile()) {
      const bytes = readFileSync(path);
      for (const marker of markers) expect(bytes.includes(Buffer.from(marker))).toBe(false);
    }
  }
}

it.each([1, 2, 3])("clean real two-process run %i: offline, restart, exact retry and ack recovery", async (iteration) => {
  const directory = mkdtempSync(join(suite, `run-${iteration}-`));
  const alice = join(directory, "alice"), bob = join(directory, "bob"), data = join(directory, "relay-data");
  const aliceKey = randomBytes(32).toString("base64url"), bobKey = randomBytes(32).toString("base64url");
  const firstText = `E2E_PRIVATE_FIRST_${randomUUID()}`, replyText = `E2E_PRIVATE_REPLY_${randomUUID()}`;
  const markers = [firstText, replyText, aliceKey, bobKey];
  const reserved = createServer(); const relayPort = await listen(reserved); await close(reserved);
  const relayUrl = `http://127.0.0.1:${relayPort}`;
  const relay = spawn(binary, [], { cwd: project, env: { ...process.env, ECHOLET_HTTP_ADDR: `127.0.0.1:${relayPort}`, ECHOLET_DATA_DIR: data, ECHOLET_RATE_LIMIT_PER_MINUTE: "1000" }, stdio: ["ignore", "pipe", "pipe"] });
  let relayLog = "";
  relay.stdout.on("data", (chunk: Buffer) => { relayLog += chunk.toString(); });
  relay.stderr.on("data", (chunk: Buffer) => { relayLog += chunk.toString(); });
  const traffic: Array<{ path: string; body: string; status: number }> = [];
  let dropSend = false, dropAck = false, droppedSend = false, droppedAck = false;
  const proxy = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks).toString(), path = request.url!;
      const upstream = await fetch(relayUrl + path, { method: request.method, headers: { "content-type": "application/json" }, body: request.method === "GET" ? undefined : body, signal: AbortSignal.timeout(5000) });
      const bytes = Buffer.from(await upstream.arrayBuffer());
      traffic.push({ path, body, status: upstream.status });
      if (upstream.ok && path === "/v1/messages/send" && dropSend) { dropSend = false; droppedSend = true; response.destroy(); return; }
      if (upstream.ok && path === "/v1/mailbox/ack" && dropAck) { dropAck = false; droppedAck = true; response.destroy(); return; }
      response.writeHead(upstream.status, { "content-type": "application/json" }); response.end(bytes);
    })().catch(() => { response.statusCode = 502; response.end("{}"); });
  });
  let listening = false;
  try {
    await relayReady(relayUrl, relay);
    const proxyPort = await listen(proxy); listening = true; const proxyUrl = `http://127.0.0.1:${proxyPort}`;
    async function run(profile: string, args: string[], expected = 0, history = false) {
      const result = await command(process.execPath, [cli, ...args, "--profile", profile, "--json"], { ECHOLET_E2E_KEY: profile === alice ? aliceKey : bobKey });
      const value = JSON.parse(result.stdout) as { ok: boolean; data: Record<string, unknown>; error?: { code: string } };
      // Never render stdout/plaintext/keys in failure diagnostics.
      const safeCode = /^[A-Z_]+$/.test(value.error?.code ?? "") ? value.error!.code : "none";
      expect(result.code, `CLI ${args[0]} exit (${safeCode})`).toBe(expected);
      for (const marker of markers) { expect(result.stderr.includes(marker)).toBe(false); if (!history) expect(result.stdout.includes(marker)).toBe(false); }
      expect(value.ok).toBe(expected === 0); return value.data;
    }
    async function history(profile: string, identity: string) {
      return (await run(profile, ["history", "--with", identity], 0, true)).entries as HistoryEntry[];
    }
    for (const profile of [alice, bob]) await run(profile, ["init", "--relay-url", proxyUrl, "--store-key-env", "ECHOLET_E2E_KEY"]);
    const aliceCardPath = join(directory, "alice-card.json"), bobCardPath = join(directory, "bob-card.json");
    await run(alice, ["contact", "export", "--out", aliceCardPath]); await run(bob, ["contact", "export", "--out", bobCardPath]);
    const a = JSON.parse(readFileSync(aliceCardPath, "utf8")).signal_bundle.device_record.identity_id as string;
    const b = JSON.parse(readFileSync(bobCardPath, "utf8")).signal_bundle.device_record.identity_id as string;
    await run(alice, ["contact", "import", "--from", bobCardPath, "--yes"]); await run(bob, ["contact", "import", "--from", aliceCardPath, "--yes"]);
    await run(alice, ["relay", "publish"]); await run(bob, ["relay", "publish"]);
    expect(traffic.filter((entry) => entry.path === "/v2/prekeys/publish" && entry.status === 200)).toHaveLength(2);
    const messageId = randomUUID();
    const sendArgs = ["send", "--to", b, "--text", firstText, "--message-id", messageId];
    dropSend = true;
    // Bob has no running process. Each command has a fresh PID and reloads its profile.
    await run(alice, sendArgs, 4); expect(droppedSend).toBe(true);
    await run(alice, sendArgs);
    const sends = traffic.filter((entry) => entry.path === "/v1/messages/send"); expect(sends).toHaveLength(2);
    expect(sends[0]!.body === sends[1]!.body).toBe(true);
    expect(traffic.filter((entry) => entry.path === "/v2/prekeys/claim")).toHaveLength(1);
    const envelope = (JSON.parse(sends[0]!.body) as { envelope: Envelope }).envelope;
    expect(envelope.message_id).toBe(messageId);
    dropAck = true; await run(bob, ["poll"], 4); expect(droppedAck).toBe(true);
    const bobHistory = await history(bob, a); expect(bobHistory).toHaveLength(1);
    expect(bobHistory[0]!.messageId === messageId && bobHistory[0]!.plaintext === firstText).toBe(true);
    const native = await nativeSnapshot(bob, bobKey);
    await run(bob, ["poll"]);
    expect(traffic.filter((entry) => entry.path === "/v1/mailbox/ack")).toHaveLength(2);
    expect(JSON.stringify(await nativeSnapshot(bob, bobKey)) === JSON.stringify(native)).toBe(true);
    expect(JSON.stringify(await history(bob, a)) === JSON.stringify(bobHistory)).toBe(true);
    // T50 / finding T49-F-001: a third party re-injecting a captured envelope under a fresh
    // envelope_id is refused at ingress, because envelope_id is bound by the sender's signature and
    // cannot be re-signed without Alice's device key. Before sender authentication this POST
    // answered 200 and the copy occupied Bob's mailbox until it expired - 49 of them wedged it.
    const replay = { ...envelope, envelope_id: randomUUID() };
    expect(bounded4xx(await postEnvelope(proxyUrl, replay)), "an unauthenticated re-injection must be refused with a bounded 4xx").toBe(true);
    await run(bob, ["poll"]);
    expect(JSON.stringify(await nativeSnapshot(bob, bobKey)) === JSON.stringify(native)).toBe(true);
    expect(await history(bob, a)).toHaveLength(1);
    await run(bob, ["send", "--to", a, "--text", replyText]); await run(alice, ["poll"]);
    const ah = await history(alice, b), bh = await history(bob, a);
    expect(ah).toHaveLength(2); expect(bh).toHaveLength(2);
    expect(ah.map((entry) => entry.plaintext).join() === [firstText, replyText].join()).toBe(true);
    expect(bh.map((entry) => entry.plaintext).join() === [firstText, replyText].join()).toBe(true);
    expect(ah[0]!.sequence < ah[1]!.sequence).toBe(true);
    const bad: Envelope = { ...envelope, envelope_id: randomUUID(), ciphertext: Buffer.from(JSON.stringify({ version: 1, type: 3, body: "AAAA" })).toString("base64url") }; bad.size_bytes = Buffer.byteLength(bad.ciphertext);
    // The same envelope carrying Alice's stale signature is refused: the ciphertext digest and the
    // envelope_id are both bound, so a captured signature cannot be reused for a different body.
    expect(bounded4xx(await postEnvelope(proxyUrl, bad)), "an envelope whose body no longer matches its signature must be refused").toBe(true);
    // F-012 still needs a stored envelope the recipient can never accept, and only an authenticated
    // sender can produce one now, so Alice's own device key signs this one. The poll must still
    // fail closed on exit 3 without acknowledging anything.
    bad.sender_signature = await senderSignature(alice, aliceKey, bad);
    expect(await postEnvelope(proxyUrl, bad)).toBe(200);
    const acksBefore = traffic.filter((entry) => entry.path === "/v1/mailbox/ack").length;
    await run(bob, ["poll"], 3);
    expect(traffic.filter((entry) => entry.path === "/v1/mailbox/ack")).toHaveLength(acksBefore);
    expect(await history(bob, a)).toHaveLength(2);
    for (const marker of markers) { expect(JSON.stringify(traffic).includes(marker)).toBe(false); expect(relayLog.includes(marker)).toBe(false); }
    await stop(relay); scan(data, markers);
  } finally {
    if (listening) await close(proxy);
    await stop(relay);
  }
}, 90000);
