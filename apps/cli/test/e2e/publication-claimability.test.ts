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
//
// T19 additionally pins, against the same real relay binary, that `send` presupposes `relay
// publish`. Since T50 the relay authenticates a deposit against an already-published, root-signed
// device record, so a profile that has only run `init` and `contact import` is CERTAIN to be
// refused - yet `/v2/prekeys/claim` is unauthenticated, so before T19 that doomed send permanently
// consumed the RECIPIENT's only first-contact bundle on its way to failing. The refusal now happens
// locally, before the claim, and the relay itself is the witness: an unpublished sender's attempt
// leaves the recipient's bundle claimable, which the relay reports through `relay publish`.
//
// That is why step 5's original assertion moved rather than disappeared. It pinned that the CLI
// names an exhausted recipient prekey (`/PREKEY/`) instead of a protocol rejection, and it still
// does - from a sender that HAS published, which is the only sender that can reach the claim route
// at all now. What was added in front of it is the stronger property: the unpublished sender is
// refused without the relay observing any claim.

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
  // `dave` is added by T26: under a pool carol now DELIVERS (step 7), so the exhausted-prekey
  // vocabulary needs a sender who arrives after every member is gone (step 8).
  const bob = join(directory, "bob"), alice = join(directory, "alice"), carol = join(directory, "carol"), dave = join(directory, "dave");
  const keys = new Map([bob, alice, carol, dave].map((profile) => [profile, randomBytes(32).toString("base64url")]));
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

    for (const profile of [bob, alice, carol, dave]) {
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

    // 3. An unpublished sender's doomed attempt must cost the RECIPIENT nothing.
    //    Carol has run `init` and `contact import` and nothing else, so the relay is certain to
    //    refuse her deposit (T50). The CLI must therefore refuse locally, BEFORE it claims bob's
    //    only first-contact bundle: through the frozen eight-command surface bob has no way to
    //    allocate a replacement, so carol's own misconfiguration would otherwise permanently destroy
    //    a third party's ability to receive first contact.
    const unpublishedSender = await run(carol, ["send", "--to", bobIdentity, "--text", firstText], 3);

    //    The relay itself is the witness, and it is asserted FIRST because it is the load-bearing
    //    half: an error code says what the sender was told, only the relay says what the sender
    //    COST somebody else. If any claim had reached it, bob's bundle would already be unclaimable
    //    here - which is exactly what step 6 measures after a real claim. Still claimable, and still
    //    the identical stored bundle, is the end-to-end proof that the refusal happened before the
    //    irreversible step.
    const afterRefusedSend = await run(bob, ["relay", "publish"]);
    expect(
      afterRefusedSend.data.claimable,
      "an unpublished sender's refused send must leave the recipient's first-contact bundle intact",
    ).toBe(true);
    expect(afterRefusedSend.data.bundleId).toBe(firstPublish.data.bundleId);

    // 4. And what carol was told: the operator's own missing publication, named as such.
    expect(unpublishedSender.errorCode).not.toBe("PROTOCOL_REJECTED");
    //    Nothing was claimed, so this is not - and must not be reported as - an exhausted prekey.
    expect(unpublishedSender.errorCode).not.toMatch(/PREKEY/);
    expect(
      unpublishedSender.errorCode,
      "the operator must be told the one thing they have to do: `relay publish`",
    ).toBe("SENDER_NOT_PUBLISHED");

    // 5. The first sender consumes it.
    //    T50 (finding T49-F-001): /v1/messages/send authenticates the sender against a
    //    DeviceRecord the relay already holds, so a sender must have identified itself to the relay
    //    before it can send. `relay publish` is that step - it stores the sender's root-signed
    //    device record alongside its bundle (storage/repository/signal_prekey_bundle_v2.go:55,83).
    //    Alice's own publication is independent of Bob's and does not touch any assertion here.
    await run(alice, ["relay", "publish"]);
    await run(alice, ["send", "--to", bobIdentity, "--text", firstText]);

    // 6. The recovery attempt. REWRITTEN FOR T26, and the property it protects is unchanged and
    //    sharper: a publish that restored nothing must say so instead of reporting plain success.
    //
    //    What changed and why. Since T26 `relay publish` submits a POOL of
    //    N = LIMITS.PREKEY_MIN_COUNT independently signed bundles and means "bring my pool back up
    //    to N". After exactly one claim, N-1 members are still claimable, so the old assertion
    //    `claimable === false` is simply FALSE under a pool - and `claimable` now means "at least
    //    one member can serve a first-contact sender", which is the only question the operator is
    //    asking. The per-member truth did not disappear; it moved into `pool`, where it is more
    //    precise than the boolean ever was: this invocation both QUERIES and tops up, so
    //    `pool.minted === 1` is the direct, load-bearing statement that exactly one member had been
    //    consumed and exactly one was allocated to replace it. A publish that restored nothing
    //    would report `minted: 0` with `claimable` short of the target, and is still caught.
    //
    //    Nothing here is weakened: the boolean is replaced by a count, and the count is checked
    //    against an exact expected value rather than against "not success".
    const afterClaim = await run(bob, ["relay", "publish"]);
    const pool = afterClaim.data.pool as { target?: number; claimable?: number; minted?: number } | undefined;
    expect(
      pool,
      "`relay publish` must report the pool it restored: without it the operator is told an operation that restored nothing worked",
    ).toBeDefined();
    expect(pool!.target).toBe(LIMITS.PREKEY_MIN_COUNT);
    expect(
      pool!.minted,
      "alice's claim consumed exactly one pool member, so the top-up must allocate exactly one replacement",
    ).toBe(1);
    expect(pool!.claimable).toBe(LIMITS.PREKEY_MIN_COUNT);
    expect(afterClaim.data.claimable).toBe(true);
    //    UNCHANGED: `bundleId` is an anchor, not a cursor. Slot 0 is never re-minted while any
    //    member is live, so the value the T19 and T20 reports rest on keeps its meaning.
    expect(afterClaim.data.bundleId).toBe(firstPublish.data.bundleId);

    // 7. The originally reported symptom, and the reason this task exists: a second distinct
    //    sender. REWRITTEN FOR T26. Under a pool of one she was refused permanently and bob had no
    //    way to allocate a replacement; under a pool she DELIVERS. That inversion is the whole
    //    point, so the assertion is inverted rather than removed.
    //
    //    Carol publishes first - the precondition step 3 refused her for - so that her send reaches
    //    the claim route. Her publication is her own and touches no assertion about bob's.
    await run(carol, ["relay", "publish"]);
    const secondSender = await run(carol, ["send", "--to", bobIdentity, "--text", firstText]);
    expect(
      secondSender.data.status,
      "a pool must serve a SECOND distinct first-contact sender; that is the denial this task removes",
    ).toBe("delivered");

    // 8. The EXHAUSTED-PREKEY vocabulary, moved intact to a sender who arrives after all N members
    //    are gone. It is asserted here exactly as it was asserted at step 7 before T26 - same
    //    codes, same exit class, same negative on PROTOCOL_REJECTED - because T26 §4 deliberately
    //    does NOT adopt Signal's shared last-resort key: at exhaustion the sender must still see
    //    404 PREKEY_BUNDLE_UNAVAILABLE and nothing new.
    //
    //    The remaining members are drained with raw, unauthenticated claims, which is precisely the
    //    attack the pool prices rather than closes: /v2/prekeys/claim carries no authentication, so
    //    a stranger who knows an identity id destroys a member per request at a measured 2.0 ms
    //    while the victim pays 61.6 ms to mint and publish each one. Counting them here states the
    //    honest cost: the pool raises the price of silencing bob from ONE request to N, and no
    //    further.
    let drained = 0;
    let exhausted: { status: number; code: string } | undefined;
    for (let attempt = 0; attempt < LIMITS.PREKEY_MIN_COUNT + 2 && !exhausted; attempt += 1) {
      const response = await fetch(`${relayUrl}/v2/prekeys/claim`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        // Never rendered in diagnostics; only the status and the relay's own code are asserted.
        body: JSON.stringify({ claim_id: randomUUID(), identity_id: bobIdentity, device_id: null }),
        signal: AbortSignal.timeout(5000),
      });
      if (response.ok) { drained += 1; await response.arrayBuffer(); continue; }
      const failure = (await response.json()) as { error?: { code?: string } };
      exhausted = { status: response.status, code: failure.error?.code ?? "none" };
    }
    //    Alice and carol consumed one member each, and the step-6 top-up replaced alice's before
    //    carol's claim happened, so exactly N-1 remain for the raw claims: one claim consumes
    //    exactly one member, never more and never fewer.
    expect(drained).toBe(LIMITS.PREKEY_MIN_COUNT - 1);
    expect(exhausted).toEqual({ status: 404, code: "PREKEY_BUNDLE_UNAVAILABLE" });

    //    And what a real sender is told once that has happened - unchanged from before T26.
    await run(dave, ["contact", "import", "--from", bobCardPath, "--yes"]);
    await run(dave, ["relay", "publish"]);
    const exhaustedSender = await run(dave, ["send", "--to", bobIdentity, "--text", firstText], 3);
    expect(exhaustedSender.errorCode).not.toBe("PROTOCOL_REJECTED");
    expect(exhaustedSender.errorCode).toMatch(/PREKEY/);
  } finally {
    await stop(relay);
  }
}, 90000);
