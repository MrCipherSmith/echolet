import { afterEach, describe, expect, it, vi } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { LIMITS, type SignalPreKeyBundleV2 } from "@echolet/protocol";
import { openProfile } from "./profile";
import { RelayClient } from "../transport/relayClient";
import { openOutboundMessenger } from "./outbound";

// Review finding F-001: repeated `relay publish` must resubmit the exact previously signed
// bundle. Regenerating a bundle_id around the same reserved one-time prekey is permanently
// rejected by the relay, so a lost publish response currently cannot be recovered.

const paths: string[] = [];
const opened: Array<{ close(): Promise<void> }> = [];
afterEach(async () => {
  for (const handle of opened.splice(0)) await handle.close();
  for (const path of paths.splice(0)) rmSync(path, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const directory = () => {
  const path = mkdtempSync(join(tmpdir(), "echolet-publish-test-"));
  paths.push(path);
  return path;
};

async function profileFixture() {
  const profileDir = directory();
  const key = randomBytes(32);
  const config = {
    profile_version: 1 as const,
    profile_id: randomUUID(),
    relay_url: "http://127.0.0.1:8081",
    database_path: "client.sqlite",
    store_key_env: "ECHOLET_TEST_KEY",
    request_timeout_ms: 500,
    poll_batch_size: 50,
  };
  const environment = { ECHOLET_TEST_KEY: key.toString("base64url") };
  const profile = await openProfile({ profileDir, config, environment, initialize: true });
  // The profile is opened only to create the durable identity; publishing reopens it.
  await profile.close();
  return { profileDir, key, config, environment };
}

type PublishAttempt = { bodyText: string; bundle: SignalPreKeyBundleV2 };

/** Records every publication attempt without ever rendering the request body in diagnostics. */
function publishRelay(handler: (attempt: PublishAttempt) => Promise<Response>) {
  const attempts: PublishAttempt[] = [];
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    if (path !== "/v2/prekeys/publish") throw new Error(`unexpected relay path ${path}`);
    const bodyText = String(init?.body);
    const attempt: PublishAttempt = { bodyText, bundle: (JSON.parse(bodyText) as { bundle: SignalPreKeyBundleV2 }).bundle };
    attempts.push(attempt);
    return handler(attempt);
  });
  return { fetch, attempts };
}

// No scenario in this file claims the published bundle, so every publication here — the first
// store, the byte-identical retry after a lost response, and the post-rotation publish — leaves an
// unclaimed bundle behind. The relay answers `claimable: true` in exactly those cases.
const stored = (attempt: PublishAttempt) =>
  Promise.resolve(new Response(JSON.stringify({ ok: true, data: { stored: true, bundle_id: attempt.bundle.bundle_id, claimable: true } }), {
    status: 200, headers: { "content-type": "application/json" },
  }));

type Fixture = Awaited<ReturnType<typeof profileFixture>>;
const messengerFor = (fixture: Fixture, fetch: typeof globalThis.fetch) => openOutboundMessenger({
  profileDir: fixture.profileDir,
  environment: fixture.environment,
  relay: new RelayClient({ baseUrl: fixture.config.relay_url, timeoutMs: fixture.config.request_timeout_ms, fetch }),
});

describe("CLI relay publication idempotence", () => {
  it("resubmits the byte-identical signed bundle after a lost publish response and a restart", async () => {
    const local = await profileFixture();

    const lost = publishRelay(() => { throw new DOMException("response lost", "AbortError"); });
    const first = await messengerFor(local, lost.fetch);
    await expect(first.publish()).rejects.toMatchObject({ code: "RELAY_TIMEOUT", retryable: true });
    await first.close();
    expect(lost.attempts).toHaveLength(1);

    const replayed = publishRelay(stored);
    const reopened = await messengerFor(local, replayed.fetch);
    opened.push(reopened);
    await expect(reopened.publish()).resolves.toMatchObject({ stored: true });
    // Flow 003 / T26: the retry completes the pool. Slot 0 was already durable (stored before the
    // lost request above) so it is resubmitted idempotently first; the remaining
    // LIMITS.PREKEY_MIN_COUNT - 1 empty slots are freshly minted, stored, and published. The total
    // is the full pool, not the single retried request.
    expect(replayed.attempts).toHaveLength(LIMITS.PREKEY_MIN_COUNT);

    const original = lost.attempts[0]!;
    const retry = replayed.attempts[0]!;
    // The relay stores one bundle per reserved one-time prekey: an identical retry must carry
    // the identical bundle_id, otherwise the retry is rejected under OTK uniqueness forever.
    expect(retry.bundle.one_time_prekey?.key_id).toBe(original.bundle.one_time_prekey?.key_id);
    expect(retry.bundle.one_time_prekey?.public_key === original.bundle.one_time_prekey?.public_key).toBe(true);
    expect(retry.bundle.bundle_id).toBe(original.bundle.bundle_id);
    expect(retry.bundle.created_at_ms).toBe(original.bundle.created_at_ms);
    expect(retry.bundle.expires_at_ms).toBe(original.bundle.expires_at_ms);
    // Boolean form: never render signed bundle bytes into failure output.
    expect(retry.bodyText === original.bodyText).toBe(true);
  }, 30000);

  it("repeats an already successful publication without allocating a new bundle", async () => {
    const local = await profileFixture();
    const relay = publishRelay(stored);
    const messenger = await messengerFor(local, relay.fetch);
    opened.push(messenger);

    await expect(messenger.publish()).resolves.toMatchObject({ stored: true });
    await expect(messenger.publish()).resolves.toMatchObject({ stored: true });
    // Flow 003 / T26: each call resubmits/mints the full LIMITS.PREKEY_MIN_COUNT-member pool, so
    // two calls issue two full pools of requests, not two requests.
    expect(relay.attempts).toHaveLength(2 * LIMITS.PREKEY_MIN_COUNT);

    const original = relay.attempts[0]!;
    // The second call's FIRST attempt is slot 0 resubmitted idempotently - every stored member is
    // read and resubmitted in slot order, slot 0 first - so it is the byte-identical repeat, not
    // whatever request happens to be second in the combined array.
    const repeat = relay.attempts[LIMITS.PREKEY_MIN_COUNT]!;
    expect(repeat.bundle.bundle_id).toBe(original.bundle.bundle_id);
    expect(repeat.bodyText === original.bodyText).toBe(true);
  }, 30000);

  it("allocates a fresh bundle and one-time prekey only through an explicit rotation operation", async () => {
    const local = await profileFixture();
    const relay = publishRelay(stored);
    const messenger = await messengerFor(local, relay.fetch);
    opened.push(messenger);

    await messenger.publish();
    const original = relay.attempts[0]!;

    // Intended public API: rotation is explicit and separate from publish/retry.
    const rotate = (messenger as unknown as { rotateBundle?: () => Promise<unknown> }).rotateBundle;
    expect(typeof rotate).toBe("function");
    await (rotate as () => Promise<unknown>).call(messenger);
    await messenger.publish();

    // Flow 003 / T26: `rotateBundle()` only ever replaces slot 0 (the anchor); slots 1..N-1 stay
    // untouched. This second `publish()` resubmits every stored member in slot order, slot 0 first,
    // so the rotated bundle is the FIRST attempt of this call - at index LIMITS.PREKEY_MIN_COUNT in
    // the combined array - not the LAST attempt of the whole run. `.at(-1)` would silently read
    // slot N-1, which was never rotated and would make this assertion pass for the wrong reason.
    // The length check fails on its own assertion, rather than an out-of-bounds TypeError, until
    // publish() actually resubmits the full pool on every call.
    expect(relay.attempts.length).toBeGreaterThan(LIMITS.PREKEY_MIN_COUNT);
    const rotated = relay.attempts[LIMITS.PREKEY_MIN_COUNT]!;
    expect(rotated.bundle.bundle_id).not.toBe(original.bundle.bundle_id);
    expect(rotated.bundle.one_time_prekey?.public_key === original.bundle.one_time_prekey?.public_key).toBe(false);

    // The rotated bundle is then itself stable across retries: it is again the first attempt of
    // the next full-pool publish.
    await messenger.publish();
    expect(relay.attempts.length).toBeGreaterThan(2 * LIMITS.PREKEY_MIN_COUNT);
    const afterRotation = relay.attempts[2 * LIMITS.PREKEY_MIN_COUNT]!;
    expect(afterRotation.bundle.bundle_id).toBe(rotated.bundle.bundle_id);
    expect(afterRotation.bodyText === rotated.bodyText).toBe(true);
  }, 30000);
});
