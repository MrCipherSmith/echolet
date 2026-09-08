import { afterAll, beforeAll, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { LIMITS } from "@echolet/protocol";

// Flow 003 / T26 group E — the property the whole task exists for, against the REAL relay binary.
//
// Today a recipient publishes one bundle. It serves exactly ONE first-contact sender, anyone who
// knows an identity id can consume it in a single unauthenticated request, and the recipient has no
// entry point to allocate a replacement: rotation exists in the runtime and no command reaches it.
// That is a silent, permanent denial of first contact with no recovery.
//
// After T26 the recipient publishes a POOL of N = LIMITS.PREKEY_MIN_COUNT independently signed
// bundles through the unchanged publish route, and `relay publish` means "bring my pool back up to
// N". This file pins the two halves of that, end to end:
//
//   1. N distinct first-contact senders all deliver to one recipient's pool, and the recipient
//      decrypts all N in a single poll;
//   2. the (N+1)st sender sees today's answer unchanged — exit 3 under PREKEY_BUNDLE_UNAVAILABLE,
//      no new code and no new exit class — and then, after the recipient runs `relay publish`
//      ONCE, that same sender's own retry delivers with NO action on the sender's side. The refused
//      send stored its claim id, the retry replays it, the relay holds no binding for it, so a
//      fresh pool member is allocated. Nothing in the tree pins that recovery today.
//
// WHAT THIS IS NOT. It is not a fix for denial of first contact and must not be read as one.
// Measured (T26 §1.2, §3): one attacking source goes from 120 silenced victims per minute to 6 —
// a 20x price increase and nothing more — while per bundle the attacker pays 2.0 ms and the victim
// 61.6 ms to mint and publish, a 30.6x asymmetry running against the defender. Two source
// addresses drain a pool faster than its owner can refill it. What changes is that a drained
// recipient now has a way back at all.
//
// Signal's shared last-resort key is deliberately NOT adopted (T26 §4): it is refused by this wire
// in both of its possible shapes, it contradicts the permanent one-time-prekey reservation the Go
// guards enforce, and it trades away the per-session forward secrecy the one-time prekey exists
// for. So exhaustion still ends in a refusal here, by design.
//
// No store key, private key, plaintext or HTTP request body is printed. Every child's output is
// checked against the run's secret markers before anything about it is asserted.

const project = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const suite = mkdtempSync(join(tmpdir(), "echolet-prekey-pool-e2e-"));
const binary = join(suite, "relay"), cli = join(project, "apps/cli/dist/cli.js");
const poolTarget = LIMITS.PREKEY_MIN_COUNT;

interface Result { code: number | null; stdout: string; stderr: string }
function command(executable: string, args: string[], env: Record<string, string> = {}, timeoutMs = 30000): Promise<Result> {
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
  // may rebuild it. The relay binary is private to this suite and is stopped in the test's own
  // `finally`, so nothing here touches any deployed relay.
  expect(existsSync(cli)).toBe(true);
  expect((await command("go", ["-C", "apps/relay", "build", "-o", binary, "./cmd/relay"], { GOCACHE: join(project, ".gocache") }, 120000)).code).toBe(0);
}, 150000);
afterAll(() => rmSync(suite, { recursive: true, force: true }));

it("serves N first-contact senders from one pool, then recovers a refused sender through one `relay publish`", async () => {
  const directory = mkdtempSync(join(suite, "run-"));
  const recipient = join(directory, "recipient");
  // N senders drain the pool; the extra one is the sender the recovery is measured on.
  const senders = Array.from({ length: poolTarget + 1 }, (_, index) => join(directory, `sender-${String(index)}`));
  const profiles = [recipient, ...senders];
  const keys = new Map(profiles.map((profile) => [profile, randomBytes(32).toString("base64url")]));
  const texts = new Map(profiles.map((profile) => [profile, `E2E_POOL_${randomUUID()}`]));
  const markers = [...texts.values(), ...keys.values()];
  const data = join(directory, "relay-data");
  const reserved = createServer(); const relayPort = await listen(reserved); await close(reserved);
  const relayUrl = `http://127.0.0.1:${relayPort}`;
  const relay = spawn(binary, [], {
    cwd: project,
    // The limiter is not what is being measured here: at N = 20 one `relay publish` is 20 requests
    // and this test runs 22 of them, which would otherwise hit the shipped 120/min budget. That
    // traffic-shape cost is real and is documented in T26 §2.3; it is simply not this test's
    // subject.
    env: { ...process.env, ECHOLET_HTTP_ADDR: `127.0.0.1:${relayPort}`, ECHOLET_DATA_DIR: data, ECHOLET_RATE_LIMIT_PER_MINUTE: "100000" },
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
    const poolOf = (data: Record<string, unknown>, why: string) => {
      expect(data.pool, why).toBeDefined();
      return data.pool as { target?: number; claimable?: number; minted?: number };
    };

    for (const profile of profiles) {
      await run(profile, ["init", "--relay-url", relayUrl, "--store-key-env", "ECHOLET_E2E_KEY"]);
    }
    const recipientCard = join(directory, "recipient-card.json");
    await run(recipient, ["contact", "export", "--out", recipientCard]);
    const recipientIdentity = (JSON.parse(readFileSync(recipientCard, "utf8")) as { signal_bundle: { device_record: { identity_id: string } } }).signal_bundle.device_record.identity_id;
    for (const sender of senders) {
      await run(sender, ["contact", "import", "--from", recipientCard, "--yes"]);
      const senderCard = join(directory, `${sender.split("/").at(-1)!}-card.json`);
      await run(sender, ["contact", "export", "--out", senderCard]);
      await run(recipient, ["contact", "import", "--from", senderCard, "--yes"]);
    }

    // 1. One publication is now a pool of N.
    const published = await run(recipient, ["relay", "publish"]);
    expect(published.data.claimable).toBe(true);
    const pool = poolOf(
      published.data,
      "`relay publish` must publish a pool and report it: a single bundle serves exactly one first-contact sender, which is the denial this task is about",
    );
    expect(pool.target).toBe(poolTarget);
    expect(pool.claimable).toBe(poolTarget);
    const anchor = published.data.bundleId;

    // 2. N DISTINCT first-contact senders each deliver. Under a pool of one, only the first of them
    //    could ever have succeeded and every sender after her was refused permanently.
    for (const sender of senders.slice(0, poolTarget)) {
      await run(sender, ["relay", "publish"]);
      await run(sender, ["send", "--to", recipientIdentity, "--text", texts.get(sender)!]);
    }

    // 3. The recipient decrypts all N in one poll. This is the half that proves the pool's PRIVATE
    //    side survives: the recipient rotated past every slot while publishing, and previously
    //    allocated one-time prekey records are retained precisely so in-flight first contacts still
    //    resolve. A client that pruned them would leave these messages undecryptable.
    const drained = await run(recipient, ["poll"]);
    expect(drained.data.rejected).toEqual([]);
    expect(drained.data.received).toBe(poolTarget);

    // 4. The (N+1)st sender meets an exhausted pool, and is told exactly what she is told today:
    //    exit 3 under the relay's own PREKEY_BUNDLE_UNAVAILABLE. No last-resort key is handed to
    //    her, no new error code, no new exit class.
    const extra = senders[poolTarget]!;
    const retriedMessageId = randomUUID();
    await run(extra, ["relay", "publish"]);
    const refused = await run(extra, ["send", "--to", recipientIdentity, "--text", texts.get(extra)!, "--message-id", retriedMessageId], 3);
    expect(refused.errorCode).not.toBe("PROTOCOL_REJECTED");
    expect(
      refused.errorCode,
      "an exhausted pool must stay the exhausted-prekey condition, named under the relay's own code",
    ).toBe("PREKEY_BUNDLE_UNAVAILABLE");

    // 5. The recovery this task exists for: ONE `relay publish` by the recipient. Every member was
    //    consumed, so every slot is re-minted — and the anchor bundle id is only re-minted here
    //    because the pool was TOTALLY drained.
    const replenished = await run(recipient, ["relay", "publish"]);
    const restored = poolOf(replenished.data, "the recovery command must report the pool it restored");
    expect(restored.claimable).toBe(poolTarget);
    expect(restored.minted).toBe(poolTarget);
    expect(replenished.data.claimable).toBe(true);
    expect(typeof anchor).toBe("string");

    // 6. And the refused sender's OWN retry delivers, with nothing done on her side: same command,
    //    same message id, no re-import, no re-publish, no new state. Her stored claim id is
    //    replayed, the relay holds no binding for it, and a fresh pool member is allocated.
    const recovered = await run(extra, ["send", "--to", recipientIdentity, "--text", texts.get(extra)!, "--message-id", retriedMessageId]);
    expect(recovered.data.status).toBe("delivered");
    expect(recovered.data.messageId).toBe(retriedMessageId);

    const afterRecovery = await run(recipient, ["poll"]);
    expect(afterRecovery.data.rejected).toEqual([]);
    expect(afterRecovery.data.received).toBe(1);

    // 7. And the pool is down by exactly the one member that retry consumed — one claim consumes
    //    one member, never more.
    const remaining = await run(recipient, ["relay", "publish"]);
    expect(poolOf(remaining.data, "the pool report must survive a top-up").minted).toBe(1);
  } finally {
    await stop(relay);
  }
}, 600000);
