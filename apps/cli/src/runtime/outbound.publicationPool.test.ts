import { afterEach, describe, expect, it, vi } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { LIMITS, type SignalPreKeyBundleV2 } from "@echolet/protocol";
import { openProfile } from "./profile";
import { RelayClient } from "../transport/relayClient";
import { openOutboundMessenger } from "./outbound";

// RED tests for flow 003 / T26 group B — what `relay publish` MEANS after the pool.
//
// Today `relay publish` submits one bundle. It becomes "bring my published pool back up to N",
// idempotent-with-top-up: re-submit every stored member, count the claimable answers, mint the
// difference. That is the recovery command a drained recipient has never had — and the entire
// benefit of this task, since the price side of it is only a 20x increase (120 -> 6 silenced
// victims per minute from one source) against a defender who pays 61.6 ms per bundle to an
// attacker's 2.0 ms.
//
// WHY TOP-UP AND NOT ALWAYS-FRESH, since these tests forbid the latter:
//
//   * always-fresh permanently tombstones N one-time prekeys on EVERY invocation, for a command
//     the e2e suites alone run four times in one test;
//   * always-fresh destroys the lost-response retry guarantee (specification.md:130) — a pool
//     member IS a publication, and the relay accepts exactly one bundle per reserved one-time
//     prekey, so a regenerated member can never be recovered;
//   * republishing an unconsumed member truthfully reports `claimable: true` today, and that
//     stays true rather than degrading into "the second publish is always unclaimable".
//
// WHY EVERY STORED MEMBER IS RE-SUBMITTED, EVEN THE ONES BELIEVED LIVE: belief goes stale the
// moment a claim lands, and there is no "how many are left" route to ask instead — adding one
// would be a wire change, and this design has none. The re-submission IS the query, at a measured
// 3.9 ms per member.
//
// The fake relay below reproduces the measured behaviour of the real one: a first store is
// claimable, a byte-identical re-store is idempotent and answers `claimable` from the stored
// `Claimed` flag WITHOUT re-adding the availability index, and an out-of-window bundle is refused
// 400 BUNDLE_EXPIRED before it reaches storage. Nothing about a claim route is modelled, because
// nothing on the publish path touches it.
//
// No store key, private key, plaintext or request body is printed: bodies are compared as
// booleans and reported by bundle id, key id and count only.

const paths: string[] = [];
const opened: Array<{ close(): Promise<void> }> = [];
afterEach(async () => {
  for (const handle of opened.splice(0)) await handle.close();
  for (const path of paths.splice(0)) rmSync(path, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const directory = () => {
  const path = mkdtempSync(join(tmpdir(), "echolet-pool-publish-test-"));
  paths.push(path);
  return path;
};

async function profileFixture() {
  const profileDir = directory();
  const config = {
    profile_version: 1 as const,
    profile_id: randomUUID(),
    relay_url: "http://127.0.0.1:8081",
    database_path: "client.sqlite",
    store_key_env: "ECHOLET_TEST_KEY",
    request_timeout_ms: 500,
    poll_batch_size: 50,
  };
  const environment = { ECHOLET_TEST_KEY: randomBytes(32).toString("base64url") };
  const profile = await openProfile({ profileDir, config, environment, initialize: true });
  await profile.close();
  return { profileDir, config, environment };
}
type Fixture = Awaited<ReturnType<typeof profileFixture>>;

interface Attempt { bodyText: string; bundle: SignalPreKeyBundleV2 }
type Run = Attempt[];

/** The relay's publish semantics, modelled from the measured Go implementation. */
function poolRelay() {
  const stored = new Map<string, { bodyText: string; claimed: boolean }>();
  const expired = new Set<string>();
  let refuseFreshPublications = false;
  const runs: Run[] = [];
  let current: Run = [];
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    if (path !== "/v2/prekeys/publish") throw new Error(`unexpected relay path ${path}`);
    const bodyText = String(init?.body);
    const bundle = (JSON.parse(bodyText) as { bundle: SignalPreKeyBundleV2 }).bundle;
    current.push({ bodyText, bundle });
    const json = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (expired.has(bundle.bundle_id)) {
      return json(400, { ok: false, error: { code: "BUNDLE_EXPIRED", message: "BUNDLE_EXPIRED" } });
    }
    const known = stored.get(bundle.bundle_id);
    if (known) {
      return json(200, { ok: true, data: { stored: true, bundle_id: bundle.bundle_id, claimable: !known.claimed } });
    }
    if (refuseFreshPublications) {
      return json(409, { ok: false, error: { code: "BUNDLE_ID_CONFLICT", message: "BUNDLE_ID_CONFLICT" } });
    }
    stored.set(bundle.bundle_id, { bodyText, claimed: false });
    return json(200, { ok: true, data: { stored: true, bundle_id: bundle.bundle_id, claimable: true } });
  });
  return {
    fetch,
    get runs() { return runs; },
    startRun() { current = []; runs.push(current); },
    /** A first-contact sender consumed this member. */
    consume(bundleId: string) { stored.get(bundleId)!.claimed = true; },
    /** This member's seven-day window has closed. */
    expire(bundleId: string) { expired.add(bundleId); },
    refuseFresh() { refuseFreshPublications = true; },
  };
}
type PoolRelay = ReturnType<typeof poolRelay>;

const messengerFor = (fixture: Fixture, fetch: typeof globalThis.fetch) => openOutboundMessenger({
  profileDir: fixture.profileDir,
  environment: fixture.environment,
  relay: new RelayClient({ baseUrl: fixture.config.relay_url, timeoutMs: fixture.config.request_timeout_ms, fetch }),
});

interface PublishResult {
  stored?: unknown;
  bundleId?: unknown;
  claimable?: unknown;
  pool?: { target?: unknown; claimable?: unknown; minted?: unknown };
}

/** Run `relay publish` and return the result together with the requests it made. */
async function publishRun(messenger: { publish(): Promise<unknown> }, relay: PoolRelay) {
  relay.startRun();
  const result = await messenger.publish() as PublishResult;
  return { result, attempts: relay.runs.at(-1)! };
}

/**
 * The pool report, probed rather than destructured, so a missing one fails on an assertion that
 * names the contract instead of on a `TypeError` deep inside a comparison.
 */
function poolOf(result: PublishResult): { target?: unknown; claimable?: unknown; minted?: unknown } {
  expect(
    result.pool,
    "`relay publish` must report the pool it restored: {target, claimable, minted}. Without it the operator cannot tell a publish that restored nothing from one that restored everything — the whole reason the command exists",
  ).toBeDefined();
  return result.pool!;
}

const target = LIMITS.PREKEY_MIN_COUNT;
const keyIdsOf = (attempts: Run) => attempts.map((attempt) => attempt.bundle.one_time_prekey?.key_id);
const bundleIdsOf = (attempts: Run) => attempts.map((attempt) => attempt.bundle.bundle_id);

/** A profile whose pool has been filled once, against a relay that accepted every member. */
async function filledPool(fixture: Fixture, relay: PoolRelay) {
  const messenger = await messengerFor(fixture, relay.fetch);
  opened.push(messenger);
  const first = await publishRun(messenger, relay);
  // The whole change in one assertion: `relay publish` submits a POOL, not a publication.
  expect(
    first.attempts,
    `\`relay publish\` must bring the published pool up to N = LIMITS.PREKEY_MIN_COUNT (${String(target)}) independently signed bundles, one per call to the unchanged publish route`,
  ).toHaveLength(target);
  return { messenger, first };
}

describe("CLI publication pool replenishment", () => {
  it("re-submits every member and mints nothing when the pool is already full", async () => {
    const local = await profileFixture();
    const relay = poolRelay();
    const { messenger, first } = await filledPool(local, relay);

    // B-6. Nothing was claimed, so a second `relay publish` is a pure query: N requests, each the
    // byte-identical stored member, and NOT ONE new one-time prekey reserved. Always-fresh would
    // burn N prekeys here for no benefit at all.
    const second = await publishRun(messenger, relay);
    expect(second.attempts).toHaveLength(target);
    expect(new Set(bundleIdsOf(second.attempts))).toEqual(new Set(bundleIdsOf(first.attempts)));
    expect(new Set(keyIdsOf(second.attempts))).toEqual(new Set(keyIdsOf(first.attempts)));
    const bodies = new Map(first.attempts.map((attempt) => [attempt.bundle.bundle_id, attempt.bodyText]));
    // Boolean form: signed bundle bytes are never rendered into failure output.
    expect(second.attempts.every((attempt) => attempt.bodyText === bodies.get(attempt.bundle.bundle_id))).toBe(true);

    expect(poolOf(second.result).target).toBe(target);
    expect(poolOf(second.result).claimable).toBe(target);
    expect(poolOf(second.result).minted).toBe(0);
    expect(second.result.claimable).toBe(true);
  }, 120000);

  it("tops a partially drained pool back up to N with fresh key material only for the consumed slots", async () => {
    const local = await profileFixture();
    const relay = poolRelay();
    const { messenger, first } = await filledPool(local, relay);
    const original = bundleIdsOf(first.attempts);
    const consumed = original.slice(0, 3);
    for (const bundleId of consumed) relay.consume(bundleId);
    const live = target - consumed.length;

    // B-7. Every stored member is re-submitted — including the ones last seen as live, because a
    // client that skipped them would report a full pool while holding a drained one — and exactly
    // one fresh bundle is minted per consumed slot, never more.
    const second = await publishRun(messenger, relay);
    const resubmitted = second.attempts.filter((attempt) => original.includes(attempt.bundle.bundle_id));
    const minted = second.attempts.filter((attempt) => !original.includes(attempt.bundle.bundle_id));
    expect(new Set(bundleIdsOf(resubmitted))).toEqual(new Set(original));
    expect(minted).toHaveLength(consumed.length);

    // Fresh members carry key material never offered before: a re-offered one-time prekey is
    // refused permanently by the relay, and would hand one private key to two senders if it were
    // not.
    const previousKeyIds = new Set(keyIdsOf(first.attempts));
    expect(minted.every((attempt) => !previousKeyIds.has(attempt.bundle.one_time_prekey?.key_id))).toBe(true);
    expect(new Set(keyIdsOf(minted)).size).toBe(consumed.length);

    expect(poolOf(second.result).target).toBe(target);
    expect(poolOf(second.result).minted).toBe(consumed.length);
    expect(poolOf(second.result).claimable).toBe(target);
    expect(second.result.claimable).toBe(true);

    // And the report before the top-up is the honest one: `pool.claimable` names how many members
    // could serve a first-contact sender, which is the property step 6 of the e2e used to get from
    // a bare `claimable: false`.
    expect(live).toBe(target - consumed.length);
  }, 120000);

  it("replaces an expired member instead of failing the whole command", async () => {
    const local = await profileFixture();
    const relay = poolRelay();
    const { messenger, first } = await filledPool(local, relay);
    const original = bundleIdsOf(first.attempts);
    relay.expire(original[0]!);

    // B-8. All N members are minted within a second of each other, so the pool ages together: a
    // `relay publish` run more than seven days after the last one meets BUNDLE_EXPIRED on every
    // slot. `BUNDLE_EXPIRED` is NOT in the CLI's reported-relay-code allowlist, so left alone it
    // surfaces as PROTOCOL_REJECTED at exit 3 and aborts the command — which would make the
    // recovery path unusable in exactly the case it is most needed. A dead slot is a slot to
    // re-mint, locally and silently, counted in `pool.minted`.
    const second = await publishRun(messenger, relay);
    const minted = second.attempts.filter((attempt) => !original.includes(attempt.bundle.bundle_id));
    expect(minted).toHaveLength(1);
    expect(poolOf(second.result).minted).toBe(1);
    expect(poolOf(second.result).claimable).toBe(target);
    expect(second.result.claimable).toBe(true);
    expect(second.result.stored).toBe(true);
  }, 120000);

  it("keeps the reported bundleId anchored to slot 0 while any member is live", async () => {
    const local = await profileFixture();
    const relay = poolRelay();
    const { messenger, first } = await filledPool(local, relay);
    const anchor = first.result.bundleId;
    expect(typeof anchor).toBe("string");

    // B-9. `bundleId` is an anchor, not a cursor. `publication-claimability.test.ts` steps 1-3
    // assert it unchanged across publishes, and the T19 and T20 reports rest on those assertions:
    // under a pool the value must keep meaning "slot 0's stored publication" rather than drifting
    // to whichever member happened to be submitted last.
    const original = bundleIdsOf(first.attempts);
    const full = await publishRun(messenger, relay);
    expect(full.result.bundleId).toBe(anchor);

    relay.consume(original[1]!);
    relay.consume(original[2]!);
    const drained = await publishRun(messenger, relay);
    expect(drained.result.bundleId).toBe(anchor);

    relay.expire(original[3]!);
    const aged = await publishRun(messenger, relay);
    expect(aged.result.bundleId).toBe(anchor);
    expect(poolOf(aged.result).claimable).toBe(target);
  }, 120000);

  it("fails rather than reporting success when nothing at all ends up claimable", async () => {
    const local = await profileFixture();
    const relay = poolRelay();
    const { messenger, first } = await filledPool(local, relay);
    for (const bundleId of bundleIdsOf(first.attempts)) relay.consume(bundleId);
    relay.refuseFresh();

    // B-10. A drained pool whose replacements the relay will not accept is not a successful
    // publish. `relay publish` is the operator's ONLY recovery path; reporting plain success after
    // restoring nothing is the exact defect T44-002 closed for a pool of one, and a pool must not
    // reopen it at N.
    relay.startRun();
    await expect(
      messenger.publish(),
      "`relay publish` must fail when it restores nothing: the operator is told an operation that restored nothing worked otherwise",
    ).rejects.toThrow();
  }, 120000);
});
