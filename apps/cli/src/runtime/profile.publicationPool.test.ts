import { afterEach, describe, expect, it, vi } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { LIMITS, SignalPreKeyBundleV2Schema, type SignalPreKeyBundleV2 } from "@echolet/protocol";
import { EncryptedSqliteStore, importVerifiedSignalBundleV2, type StoreTransaction } from "@echolet/session-node";
import { openProfile, type Profile } from "./profile";

// RED tests for flow 003 / T26 group A — the local half of a published prekey POOL.
//
// WHAT IS BEING BUILT, AND WHAT IT IS NOT. Today a recipient publishes ONE bundle, so it serves
// exactly one first-contact sender and anybody who knows an identity id can consume it in a single
// unauthenticated request. T26 measured the answer: publish N = LIMITS.PREKEY_MIN_COUNT = 20
// independently signed bundles through the UNCHANGED publish route, and change what `relay publish`
// MEANS from "submit my publication" to "bring my pool back up to N".
//
// The honest size of that: it takes an attacker from 120 silenced victims per minute from one
// source to 6 — a 20x price increase and nothing more — while the per-unit asymmetry runs AGAINST
// the defender, who spends 61.6 ms minting and publishing each bundle the attacker destroys for
// 2.0 ms (T26 §1.2, C1/C2/C3). Nothing in this file should be read as pinning a closure of denial
// of first contact. What it pins is that the pool exists, that it is durable, and that refilling it
// can never destroy key material a sender is still relying on.
//
// THE LOAD-BEARING NEGATIVE IS TEST A-5. The one change that would make this feature worse than
// the problem it addresses is a client that PRUNES `pre:` records when a pool slot is refilled.
// That would not re-offer a key on the relay — the relay's tombstones forbid that permanently and
// prekey_pool_test.go / prekey_bundle_v2_test.go pin it — it would do something worse: leave the
// relay correctly serving a bundle whose private half the recipient has thrown away, turning a
// refusable first contact into an UNDECRYPTABLE message. A-5 is written as a negative assertion on
// purpose, so a future tidying pass cannot land that quietly.
//
// No store key, private key, plaintext or HTTP request body is printed or asserted on here.
// Bundle bytes are compared as booleans, never rendered.

const paths: string[] = [];
const opened: Array<{ close(): Promise<void> }> = [];
afterEach(async () => {
  for (const handle of opened.splice(0)) await handle.close();
  for (const path of paths.splice(0)) rmSync(path, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const directory = () => {
  const path = mkdtempSync(join(tmpdir(), "echolet-publication-pool-test-"));
  paths.push(path);
  return path;
};

async function profileFixture() {
  const profileDir = directory();
  const key = randomBytes(32);
  const environment = { ECHOLET_TEST_KEY: key.toString("base64url") };
  const config = {
    profile_version: 1 as const,
    profile_id: randomUUID(),
    relay_url: "http://127.0.0.1:8081",
    database_path: "client.sqlite",
    store_key_env: "ECHOLET_TEST_KEY",
    request_timeout_ms: 500,
    poll_batch_size: 50,
  };
  const profile = await openProfile({ profileDir, config, environment, initialize: true });
  opened.push(profile);
  return { profileDir, key, environment, profile };
}

/**
 * The pool accessor, probed rather than called directly.
 *
 * Probing keeps a missing implementation an ASSERTION failure with a sentence saying what is
 * missing, instead of a bare `TypeError: profile.publicationPool is not a function` that says
 * nothing about the contract. `outbound.publish.test.ts` already uses this idiom for
 * `rotateBundle`.
 */
function publicationPoolOf(profile: Profile): () => Promise<SignalPreKeyBundleV2[]> {
  const accessor = (profile as unknown as { publicationPool?: () => Promise<SignalPreKeyBundleV2[]> }).publicationPool;
  expect(
    typeof accessor,
    "Profile.publicationPool() must exist: `relay publish` becomes 'bring my published pool up to N', and N durably stored, independently signed publication bundles are what it submits",
  ).toBe("function");
  return (accessor as () => Promise<SignalPreKeyBundleV2[]>).bind(profile);
}

/** Read raw durable records without decoding anything secret. */
async function withStore<T>(fixture: Awaited<ReturnType<typeof profileFixture>>, read: (tx: StoreTransaction) => T): Promise<T> {
  const store = new EncryptedSqliteStore(join(fixture.profileDir, "client.sqlite"), fixture.key);
  try { return await store.transaction((tx) => read(tx)); } finally { await store.close(); }
}

const decodeRecord = (value: Uint8Array): unknown => JSON.parse(new TextDecoder().decode(value));

describe("CLI publication pool", () => {
  it("targets the protocol's own PREKEY_MIN_COUNT and mints no second number for it", async () => {
    // A-1. N is not invented here. `LIMITS.PREKEY_MIN_COUNT` already sits in
    // packages/protocol/src/constants/limits.ts beside `PREKEY_REFILL_THRESHOLD`, declared for
    // exactly this quantity and referenced by no source file — the pool was specified and never
    // built. Building it against a fresh literal would leave the tree with two numbers for one
    // quantity, which is how they drift.
    //
    // The source check runs BEFORE the behavioural one so this test fails on the property it is
    // about rather than on the missing accessor every other test in this file already reports.
    const runtimeDir = dirname(fileURLToPath(import.meta.url));
    const sources = ["profile.ts", "outbound.ts"].map((name) => readFileSync(resolve(runtimeDir, name), "utf8"));
    expect(
      sources.some((source) => source.includes("PREKEY_MIN_COUNT")),
      "the pool target must be read from LIMITS.PREKEY_MIN_COUNT, not transcribed into the runtime",
    ).toBe(true);
    for (const source of sources) {
      expect(
        /(?:pool|target|count|size)\s*[:=]\s*20\b/i.test(source),
        "no runtime file may carry a second literal for the pool target",
      ).toBe(false);
    }

    const local = await profileFixture();
    expect(await publicationPoolOf(local.profile)()).toHaveLength(LIMITS.PREKEY_MIN_COUNT);
  }, 60000);

  it("yields N independent members, each verifiable on its own against this device record", async () => {
    const local = await profileFixture();
    const pool = await publicationPoolOf(local.profile)();
    const target = LIMITS.PREKEY_MIN_COUNT;
    expect(pool).toHaveLength(target);

    // A-2. Independent means independent: a claim consumes one member, so two members sharing a
    // bundle id, a one-time prekey id or a one-time prekey public key would collapse the pool back
    // towards a pool of one — and the relay refuses the second of them permanently
    // (ONE_TIME_PREKEY_REUSED), so an overlapping pool would also be a pool that cannot publish.
    expect(new Set(pool.map((bundle) => bundle.bundle_id)).size).toBe(target);
    expect(new Set(pool.map((bundle) => bundle.one_time_prekey?.key_id)).size).toBe(target);
    expect(new Set(pool.map((bundle) => bundle.one_time_prekey?.public_key)).size).toBe(target);

    for (const bundle of pool) {
      expect(bundle.one_time_prekey).not.toBeNull();
      // Each member must stand alone on the wire: same device record, own signature.
      expect(SignalPreKeyBundleV2Schema.safeParse(bundle).success).toBe(true);
      expect(bundle.device_record.identity_id).toBe(pool[0]!.device_record.identity_id);
      expect(bundle.device_record.device_id).toBe(pool[0]!.device_record.device_id);
      expect(() => importVerifiedSignalBundleV2(
        JSON.parse(JSON.stringify(bundle)) as SignalPreKeyBundleV2,
        { identityId: bundle.device_record.identity_id, deviceId: bundle.device_record.device_id },
      )).not.toThrow();
    }
  }, 60000);

  it("returns byte-identical members on every call and after a restart", async () => {
    const local = await profileFixture();
    const first = await publicationPoolOf(local.profile)();
    const second = await publicationPoolOf(local.profile)();
    await local.profile.close();

    // A-3. The lost-response retry guarantee (specification.md:130) is per PUBLICATION, and under a
    // pool every member is a publication: the relay stores one bundle per reserved one-time prekey
    // and refuses a re-signed bundle around the same prekey forever, so a retry that regenerated
    // any member could never be recovered. Byte comparison, never rendered.
    expect(second).toHaveLength(first.length);
    expect(second.every((bundle, index) => JSON.stringify(bundle) === JSON.stringify(first[index]))).toBe(true);

    const reopened = await openProfile({ profileDir: local.profileDir, environment: local.environment });
    opened.push(reopened);
    const afterRestart = await publicationPoolOf(reopened)();
    expect(afterRestart).toHaveLength(first.length);
    expect(afterRestart.every((bundle, index) => JSON.stringify(bundle) === JSON.stringify(first[index]))).toBe(true);
  }, 60000);

  it("keeps slot 0 under the unchanged publication record so the send precondition does not regress", async () => {
    const local = await profileFixture();
    expect(await local.profile.hasPublication()).toBe(false);
    const pool = await publicationPoolOf(local.profile)();
    expect(await local.profile.hasPublication()).toBe(true);
    await local.profile.close();

    // A-4. `cli:publication` is the sole witness `hasPublication()` consults for the T19/T20 send
    // precondition, and its absence is what makes a doomed send refusable locally BEFORE it spends
    // the recipient's key material. Slot 0 must keep writing that key, with the same schema and the
    // same bytes it would have had, or the precondition tests stop meaning what they mean.
    const stored = await withStore(local, (tx) => tx.get("cli:publication"));
    expect(stored, "slot 0 must keep writing `cli:publication` unchanged").toBeDefined();
    const record = decodeRecord(stored!) as { version?: unknown; bundle?: unknown };
    expect(Object.keys(record).sort()).toEqual(["bundle", "version"]);
    expect(record.version).toBe(1);
    expect(JSON.stringify(record.bundle) === JSON.stringify(pool[0])).toBe(true);
  }, 60000);

  it("never prunes or re-uses allocated one-time prekey records when the pool is filled or refilled", async () => {
    const local = await profileFixture();
    const pool = await publicationPoolOf(local.profile)();
    const allocated = pool.map((bundle) => `pre:${String(bundle.one_time_prekey!.key_id)}`);
    await local.profile.close();

    const beforeRefill = await withStore(local, (tx) => tx.keys("pre:").sort());
    for (const key of allocated) {
      expect(beforeRefill.includes(key), "every published member's private half must remain resolvable").toBe(true);
    }

    // A-5, the load-bearing negative. Refill the pool and rotate past every slot, then require that
    // NOT ONE previously allocated record has been removed. A recipient may hold a claim, and a
    // sender may hold a durable outbox record, for days: the relay replays the exact bundle bytes
    // bound to a claim id forever, so the recipient must still be able to resolve that member's
    // one-time prekey when the message finally arrives. Pruning would leave the relay correctly
    // serving a bundle whose private half no longer exists — an undecryptable message rather than a
    // refused one, which is strictly worse than the denial the pool exists to make rarer.
    //
    // Written as "nothing disappeared", not as "the mechanism is X": it forbids a regression, it
    // does not prescribe an implementation.
    const reopened = await openProfile({ profileDir: local.profileDir, environment: local.environment });
    opened.push(reopened);
    const refilled = await publicationPoolOf(reopened)();
    await reopened.rotatePublicationBundle();
    await reopened.rotatePublicationBundle();
    await publicationPoolOf(reopened)();
    await reopened.close();

    const afterRefill = await withStore(local, (tx) => tx.keys("pre:").sort());
    for (const key of beforeRefill) {
      expect(afterRefill.includes(key), "a refilled pool must not delete any previously allocated one-time prekey record").toBe(true);
    }
    for (const bundle of refilled) {
      expect(afterRefill.includes(`pre:${String(bundle.one_time_prekey!.key_id)}`)).toBe(true);
    }
    // And no allocated id is ever handed out twice: a recycled id would let two senders reach one
    // private key, which is the same failure seen from the client's side.
    expect(new Set(afterRefill).size).toBe(afterRefill.length);
    expect(afterRefill.length).toBeGreaterThanOrEqual(beforeRefill.length);
  }, 90000);
});
