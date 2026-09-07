import { afterAll, beforeAll, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

// T44-002 (and the end-to-end reproduction of T44-001) against the real relay binary.
//
// A published bundle serves exactly one first-contact sender. Once it has been claimed the relay
// deletes its availability index, and a re-publish is idempotent: it re-stores byte-identical bytes
// and never re-adds that index. The recipient's `relay publish` - the operator's only recovery
// attempt through the frozen eight-command surface - nevertheless reports plain success, so the
// operator is told an operation that restored nothing worked.
//
// The result of `relay publish` must therefore state truthfully whether the published bundle is
// available for claiming. Truthfully means exactly that: a repeat publish while the bundle is still
// unclaimed must keep reporting it as claimable, so a "second publish is always unclaimable" rule
// is not a fix either.
//
// The publish path must stay a resubmission of the identical stored bundle: `bundle_id` is asserted
// unchanged across every publish here, because implicit rotation would break the lost-response
// retry guarantee (specification.md:130) and collide with the permanent one-time-prekey
// reservation.

const project = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const suite = mkdtempSync(join(tmpdir(), "echolet-claimability-e2e-"));
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
    const timer = setTimeout(() => reject(new Error("Reservation teardown timeout")), 3000);
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
  // dist/cli.js is built once by the vitest globalSetup (apps/cli/test/globalSetup.ts); no suite
  // may rebuild it. The relay binary is private to this suite.
  expect(existsSync(cli)).toBe(true);
  expect((await command("go", ["-C", "apps/relay", "build", "-o", binary, "./cmd/relay"], { GOCACHE: join(project, ".gocache") }, 120000)).code).toBe(0);
}, 150000);
afterAll(() => rmSync(suite, { recursive: true, force: true }));

it("reports whether a republished bundle is still claimable, and names an exhausted prekey for a later sender", async () => {
  const directory = mkdtempSync(join(suite, "run-"));
  const bob = join(directory, "bob"), alice = join(directory, "alice"), carol = join(directory, "carol");
  const keys = new Map([[bob, randomBytes(32).toString("base64url")], [alice, randomBytes(32).toString("base64url")], [carol, randomBytes(32).toString("base64url")]]);
  const firstText = `E2E_CLAIMABILITY_${randomUUID()}`;
  const markers = [firstText, ...keys.values()];
  const data = join(directory, "relay-data");
  const reserved = createServer(); const relayPort = await listen(reserved); await close(reserved);
  const relayUrl = `http://127.0.0.1:${relayPort}`;
  const relay = spawn(binary, [], {
    cwd: project,
    env: { ...process.env, ECHOLET_HTTP_ADDR: `127.0.0.1:${relayPort}`, ECHOLET_DATA_DIR: data, ECHOLET_RATE_LIMIT_PER_MINUTE: "1000" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  relay.stdout.on("data", () => { /* relay output is never rendered by this suite */ });
  relay.stderr.on("data", () => { /* relay output is never rendered by this suite */ });

  try {
    await relayReady(relayUrl, relay);
    async function run(profile: string, args: string[], expected: number | null = 0) {
      const result = await command(process.execPath, [cli, ...args, "--profile", profile, "--json"], { ECHOLET_E2E_KEY: keys.get(profile)! });
      const value = JSON.parse(result.stdout) as { ok: boolean; data?: Record<string, unknown>; error?: { code: string } };
      const errorCode = /^[A-Z_]+$/.test(value.error?.code ?? "") ? value.error!.code : "none";
      if (expected !== null) expect(result.code, `CLI ${args.join(" ")} exit (${errorCode})`).toBe(expected);
      // Never render plaintext or store keys in failure diagnostics.
      for (const marker of markers) {
        expect(result.stdout.includes(marker)).toBe(false);
        expect(result.stderr.includes(marker)).toBe(false);
      }
      return { code: result.code, errorCode, data: value.data ?? {} };
    }

    for (const profile of [bob, alice, carol]) {
      await run(profile, ["init", "--relay-url", relayUrl, "--store-key-env", "ECHOLET_E2E_KEY"]);
    }
    const bobCardPath = join(directory, "bob-card.json");
    await run(bob, ["contact", "export", "--out", bobCardPath]);
    const bobIdentity = (JSON.parse(readFileSync(bobCardPath, "utf8")) as { signal_bundle: { device_record: { identity_id: string } } }).signal_bundle.device_record.identity_id;
    await run(alice, ["contact", "import", "--from", bobCardPath, "--yes"]);
    await run(carol, ["contact", "import", "--from", bobCardPath, "--yes"]);

    // 1. The first publication stores a bundle that any first-contact sender can claim.
    const firstPublish = await run(bob, ["relay", "publish"]);
    expect(firstPublish.data.claimable).toBe(true);

    // 2. Repeating it while nothing has claimed it must keep reporting the truth: still claimable,
    //    and still the identical stored bundle (no implicit rotation).
    const repeatPublish = await run(bob, ["relay", "publish"]);
    expect(repeatPublish.data.claimable).toBe(true);
    expect(repeatPublish.data.bundleId).toBe(firstPublish.data.bundleId);

    // 3. The first sender consumes it.
    //    T50 (finding T49-F-001): /v1/messages/send authenticates the sender against a
    //    DeviceRecord the relay already holds, so a sender must have identified itself to the relay
    //    before it can send. `relay publish` is that step - it stores the sender's root-signed
    //    device record alongside its bundle (storage/repository/signal_prekey_bundle_v2.go:55,83).
    //    Alice's own publication is independent of Bob's and does not touch any assertion here.
    await run(alice, ["relay", "publish"]);
    await run(alice, ["send", "--to", bobIdentity, "--text", firstText]);

    // 4. The recovery attempt: the same publish now restores nothing, and must say so instead of
    //    reporting plain success.
    const afterClaim = await run(bob, ["relay", "publish"]);
    expect(afterClaim.data.claimable).toBe(false);
    expect(afterClaim.data.bundleId).toBe(firstPublish.data.bundleId);

    // 5. The originally reported symptom: a second distinct sender. The relay answers
    //    404 PREKEY_BUNDLE_UNAVAILABLE, so the CLI must name that condition rather than reporting
    //    the recipient's exhausted prekey as a trust/protocol rejection.
    const secondSender = await run(carol, ["send", "--to", bobIdentity, "--text", firstText], 3);
    expect(secondSender.errorCode).not.toBe("PROTOCOL_REJECTED");
    expect(secondSender.errorCode).toMatch(/PREKEY/);
  } finally {
    await stop(relay);
  }
}, 90000);
