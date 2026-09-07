import { afterEach, describe, expect, it, vi } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createIdentityProfile, createSignedDeviceRecord } from "@echolet/client-core";
import { decodeBase64Url } from "@echolet/crypto-core";
import { signalAddressForDevice, type SignalPreKeyBundleV2 } from "@echolet/protocol";
import { EncryptedSqliteStore, SignalClient, exportSignedSignalBundleV2 } from "@echolet/session-node";
import { openProfile } from "./profile";
import { RelayClient, RelayError } from "../transport/relayClient";
import { OutboundError, openOutboundMessenger } from "./outbound";

// RED tests for flow 003 / T19 — `send` presupposes `relay publish`, and the client must say so
// BEFORE it spends anything belonging to a third party.
//
// The decision these tests implement (T13 §3 handed it back; T12 §5 R1 identified it):
//
//   Since T50 the relay authenticates a mailbox deposit against an already-published, root-signed
//   device record (cli.ts:40-46). A profile that has only run `init` and `contact import` is
//   therefore CERTAIN to be refused 403 UNAUTHORIZED_MAILBOX_ACCESS on `/v1/messages/send`. Yet
//   `/v2/prekeys/claim` carries no authentication at all (router.go), so the CLI happily takes the
//   irreversible step first: it claims the RECIPIENT's one-time prekey, permanently, on the way to a
//   send that could never have been accepted. Through the CLI a published bundle serves exactly one
//   first-contact sender and there is no command to replenish it (specification.md), so one
//   operator's own misconfiguration silently destroys somebody else's ability to receive first
//   contact.
//
// This is not a new restriction. Publication is ALREADY a hard precondition of a successful deposit.
// What changes is only WHEN the operator is told: locally, before the claim request is issued,
// instead of one request too late and at a third party's expense.
//
// Two things about the shape of the refusal, both pinned below because both are load-bearing:
//
//   * The predicate is the CONSERVATIVE one. `cli:publication` is written by `publicationBundle()`,
//     which only `publish()` and `rotateBundle()` reach, and it is written BEFORE the relay call —
//     so its absence is durable proof that `relay publish` was never even ATTEMPTED, and only then
//     is the deposit certain to fail. A profile whose publication the relay rejected has attempted
//     it, and the client must not second-guess that from local state: refusing only the provably
//     doomed send is what keeps this guard from ever blocking a send that could have succeeded.
//   * The refusal is ORDERED AFTER the contact-trust check. `CONTACT_NOT_TRUSTED` is the more
//     specific local diagnosis of the same send and predates this guard; an unpinned recipient must
//     keep reporting it. Both are local, so neither costs anything.
//
// The load-bearing assertion in every test here is on the requests actually ISSUED, not merely on
// the error that comes back: a refusal that still issued the claim would satisfy an error-only
// assertion while leaving the entire defect in place.
//
// No store key, private key, plaintext or HTTP request body is asserted on or printed here: the
// assertions carry request PATHS, error CODES, store KEY NAMES and booleans only.

const paths: string[] = [];
const opened: Array<{ close(): Promise<void> }> = [];
afterEach(async () => {
  for (const handle of opened.splice(0)) await handle.close();
  for (const path of paths.splice(0)) rmSync(path, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const directory = () => {
  const path = mkdtempSync(join(tmpdir(), "echolet-publication-precondition-test-"));
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
  opened.push(profile);
  return { profileDir, key, config, environment, profile };
}
type Fixture = Awaited<ReturnType<typeof profileFixture>>;

/** A recipient whose single published bundle serves exactly one first-contact sender. */
async function recipientPeer() {
  const identity = await createIdentityProfile({ deviceLabel: "recipient" });
  const record = createSignedDeviceRecord(identity.identityId, identity.deviceId, identity.devicePubKey, identity.identitySecretKey, "recipient");
  const store = new EncryptedSqliteStore(join(directory(), "recipient.sqlite"), randomBytes(32));
  opened.push(store);
  const client = await SignalClient.create(store, signalAddressForDevice(record.identity_id, record.device_id));
  const bundle = await exportSignedSignalBundleV2(client, { deviceRecord: record, deviceSecretKey: decodeBase64Url(identity.deviceSecretKey) });
  return { identity, bundle, card: { type: "echolet_contact_card" as const, version: 1 as const, signal_bundle: bundle } };
}

/** A CLI profile that has run `init` and `contact import`, and nothing else. */
async function senderProfile(recipient: Awaited<ReturnType<typeof recipientPeer>>) {
  const local = await profileFixture();
  await local.profile.importContact(recipient.card, { confirm: async () => true });
  await local.profile.close();
  return local;
}

interface WireEnvelope {
  envelope_id: string;
  sender_device_id: string;
}

/**
 * The relay's real semantics, as measured in T12 §1/§3 against the Go implementation:
 *
 *   - one claimable publication at a time, consumed permanently by the first claim,
 *   - a repeated `claim_id` replays the exact bundle bound to it,
 *   - nothing available answers 404 `PREKEY_BUNDLE_UNAVAILABLE`,
 *   - since T50 a deposit from a device the relay holds no published record for is refused
 *     403 `UNAUTHORIZED_MAILBOX_ACCESS`,
 *   - and `/v2/prekeys/claim` is UNAUTHENTICATED. That last one is not an oversight in the fake: it
 *     is the relay's behaviour, and it is precisely why the bound has to live on the client.
 */
function relayFake(available: SignalPreKeyBundleV2 | null) {
  const requestPaths: string[] = [];
  const claims = new Map<string, SignalPreKeyBundleV2>();
  const publishedDevices = new Set<string>();
  const state = { available };
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const failure = (status: number, code: string) => json(status, { ok: false, error: { code, message: code } });

  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    requestPaths.push(path);
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;

    if (path === "/v2/prekeys/publish") {
      const bundle = body.bundle as SignalPreKeyBundleV2;
      publishedDevices.add(bundle.device_record.device_id);
      return json(200, { ok: true, data: { stored: true, bundle_id: bundle.bundle_id, claimable: true } });
    }
    if (path === "/v2/prekeys/claim") {
      const claimId = String(body.claim_id);
      const replay = claims.get(claimId);
      if (replay) return json(200, { ok: true, data: { bundle: replay } });
      if (state.available === null) return failure(404, "PREKEY_BUNDLE_UNAVAILABLE");
      claims.set(claimId, state.available);
      const served = state.available;
      state.available = null;
      return json(200, { ok: true, data: { bundle: served } });
    }
    if (path === "/v1/messages/send") {
      const envelope = (body as unknown as { envelope: WireEnvelope }).envelope;
      if (!publishedDevices.has(envelope.sender_device_id)) return failure(403, "UNAUTHORIZED_MAILBOX_ACCESS");
      return json(200, { ok: true, data: { accepted: true, envelope_id: envelope.envelope_id, status: "relayed" } });
    }
    throw new Error(`unexpected relay path ${path}`);
  });

  return {
    fetch,
    state,
    paths: () => [...requestPaths],
    claimsIssued: () => claims.size,
  };
}

const messengerFor = (fixture: Fixture, fetch: typeof globalThis.fetch) =>
  openOutboundMessenger({
    profileDir: fixture.profileDir,
    environment: fixture.environment,
    relay: new RelayClient({ baseUrl: fixture.config.relay_url, timeoutMs: fixture.config.request_timeout_ms, fetch }),
  });

const codeOf = (error: unknown) => {
  const value = error as { remoteCode?: string; code?: string } | null;
  return value?.remoteCode ?? value?.code ?? "NO_ERROR";
};

/** Store KEY NAMES only; no stored value is ever read out of the profile database. */
async function storedKeys(fixture: Fixture, prefix: string) {
  const store = new EncryptedSqliteStore(join(fixture.profileDir, "client.sqlite"), fixture.key);
  opened.push(store);
  return store.transaction((tx) => tx.keys(prefix).sort());
}

describe("send presupposes relay publish", () => {
  it("refuses locally, issuing no relay request at all, when the profile has never published", async () => {
    // The whole defect in one assertion pair: today this profile's deposit CANNOT be accepted, and
    // the CLI discovers that only after it has permanently consumed the recipient's one-time prekey.
    const recipient = await recipientPeer();
    const unpublished = await senderProfile(recipient);
    const relay = relayFake(recipient.bundle);

    const messenger = await messengerFor(unpublished, relay.fetch);
    opened.push(messenger);
    const refusal = await messenger
      .send({ recipientIdentityId: recipient.identity.identityId, messageId: randomUUID(), plaintext: "never accepted" })
      .catch((error: unknown) => error);

    // The load-bearing property. Not "the send failed" — it already fails — but that it failed
    // WITHOUT talking to the relay, so nothing of the recipient's was spent on the way.
    expect(
      relay.paths(),
      "a send that cannot be accepted must refuse before it issues any request, above all the claim",
    ).toEqual([]);
    expect(relay.claimsIssued(), "the recipient's one-time prekey must be untouched").toBe(0);
    expect(relay.state.available, "the recipient's published bundle must still be available").not.toBeNull();

    // Typed and actionable: the operator's own missing `relay publish`, named as such. It is a local
    // client decision, so it is an OutboundError and never a relay transport failure.
    expect(refusal).toBeInstanceOf(OutboundError);
    expect(refusal).not.toBeInstanceOf(RelayError);
    expect(codeOf(refusal)).toBe("SENDER_NOT_PUBLISHED");
  }, 60000);

  it("leaves the recipient claimable by a different, properly published sender", async () => {
    // Stated as an outcome: an unpublished operator's misconfiguration is theirs, and must not cost
    // a third party the one first-contact bundle they have no CLI command to replace.
    const recipient = await recipientPeer();
    const unpublished = await senderProfile(recipient);
    const published = await senderProfile(recipient);
    const relay = relayFake(recipient.bundle);

    const doomed = await messengerFor(unpublished, relay.fetch);
    opened.push(doomed);
    await doomed
      .send({ recipientIdentityId: recipient.identity.identityId, messageId: randomUUID(), plaintext: "never accepted" })
      .catch(() => undefined);
    expect(relay.claimsIssued(), "a refused send must not have claimed anything").toBe(0);
    await doomed.close();

    const other = await messengerFor(published, relay.fetch);
    opened.push(other);
    await other.publish();
    await expect(
      other.send({ recipientIdentityId: recipient.identity.identityId, messageId: randomUUID(), plaintext: "first contact" }),
      "an unpublished sender's refused attempt must not deny first contact to every later sender",
    ).resolves.toMatchObject({ status: "delivered" });

    // Exactly one claim in total, and it belongs to the sender that actually delivered.
    expect(relay.claimsIssued()).toBe(1);
  }, 60000);

  it("leaves no durable trace of the refused send, so publishing and retrying starts clean", async () => {
    // Today the doomed send commits an outbox envelope and a Signal session before the relay refuses
    // the deposit, so the profile carries a pending record for a message it never sent and a session
    // built on a prekey it burned. A send refused before the claim must leave the profile exactly as
    // it found it — no claim id, no session, no outbox record — and the same send must then succeed
    // once the operator has done the one thing they were told to do.
    const recipient = await recipientPeer();
    const sender = await senderProfile(recipient);
    const relay = relayFake(recipient.bundle);

    const refused = await messengerFor(sender, relay.fetch);
    opened.push(refused);
    const messageId = randomUUID();
    await refused
      .send({ recipientIdentityId: recipient.identity.identityId, messageId, plaintext: "publish first" })
      .catch(() => undefined);
    await refused.close();

    expect(await storedKeys(sender, "cli:claim:"), "a refused send must not reserve a claim id").toEqual([]);
    expect(await storedKeys(sender, "cli:outbox:"), "a refused send must not commit an outbox envelope").toEqual([]);
    expect(await storedKeys(sender, "session:"), "a refused send must not establish a Signal session").toEqual([]);

    // The refusal names an action, and performing that action is enough: the guard is a precondition
    // on this profile's own state, not a permanent verdict.
    const retried = await messengerFor(sender, relay.fetch);
    opened.push(retried);
    await retried.publish();
    await expect(
      retried.send({ recipientIdentityId: recipient.identity.identityId, messageId, plaintext: "publish first" }),
      "`relay publish` must be sufficient to lift the refusal",
    ).resolves.toMatchObject({ status: "delivered" });
  }, 60000);

  it("keeps CONTACT_NOT_TRUSTED for an unpinned recipient, and still issues no request", async () => {
    // Ordering, pinned so it cannot drift: an unpublished profile sending to somebody it never
    // pinned keeps reporting the more specific pre-existing diagnosis. Both checks are local, so
    // this costs nothing and preserves the contract cli.processFailures.test.ts already relies on.
    const recipient = await recipientPeer();
    const stranger = await recipientPeer();
    const sender = await senderProfile(recipient);
    const relay = relayFake(recipient.bundle);

    const messenger = await messengerFor(sender, relay.fetch);
    opened.push(messenger);
    const refusal = await messenger
      .send({ recipientIdentityId: stranger.identity.identityId, messageId: randomUUID(), plaintext: "unknown recipient" })
      .catch((error: unknown) => error);

    expect(codeOf(refusal)).toBe("CONTACT_NOT_TRUSTED");
    expect(relay.paths(), "an unpinned recipient is refused before any relay request, as it always was").toEqual([]);

    // ... and the publication precondition still answers for a recipient that IS pinned, so the
    // ordering above is a priority between two live guards rather than one guard swallowing the
    // other.
    const pinned = await messenger
      .send({ recipientIdentityId: recipient.identity.identityId, messageId: randomUUID(), plaintext: "pinned recipient" })
      .catch((error: unknown) => error);
    expect(codeOf(pinned)).toBe("SENDER_NOT_PUBLISHED");
    expect(relay.claimsIssued()).toBe(0);
  }, 60000);
});
