import { afterEach, describe, expect, it, vi } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createIdentityProfile, createSignedDeviceRecord } from "@echolet/client-core";
import { decodeBase64Url } from "@echolet/crypto-core";
import { MailboxEnvelopeSchema, signalAddressForDevice, type SignalPreKeyBundleV2 } from "@echolet/protocol";
import { EncryptedSqliteStore, SignalClient, exportSignedSignalBundleV2 } from "@echolet/session-node";
import { openProfile } from "./profile";
import { RelayClient } from "../transport/relayClient";
import { openOutboundMessenger } from "./outbound";

const paths: string[] = [];
const opened: Array<{ close(): Promise<void> }> = [];
afterEach(async () => {
  for (const handle of opened.splice(0)) await handle.close();
  for (const path of paths.splice(0)) rmSync(path, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const directory = () => {
  const path = mkdtempSync(join(tmpdir(), "echolet-outbound-test-"));
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

async function untrustedRemote() {
  const identity = await createIdentityProfile({ deviceLabel: "remote" });
  const record = createSignedDeviceRecord(identity.identityId, identity.deviceId, identity.devicePubKey, identity.identitySecretKey, "remote");
  const store = new EncryptedSqliteStore(join(directory(), "remote.sqlite"), randomBytes(32));
  opened.push(store);
  const client = await SignalClient.create(store, signalAddressForDevice(record.identity_id, record.device_id));
  const bundle = await exportSignedSignalBundleV2(client, { deviceRecord: record, deviceSecretKey: decodeBase64Url(identity.deviceSecretKey) });
  return { identity, bundle, card: { type: "echolet_contact_card" as const, version: 1 as const, signal_bundle: bundle } };
}

async function trustedPair() {
  const local = await profileFixture();
  const remote = await untrustedRemote();
  await local.profile.importContact(remote.card, { confirm: async () => true });
  await local.profile.close();
  return { local, remote };
}

type RecordedRequest = { path: string; bodyText: string; body: Record<string, unknown> };
const relayResponse = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
function relayFetch(claimedBundle: SignalPreKeyBundleV2, send: (request: RecordedRequest) => Promise<Response>) {
  const requests: RecordedRequest[] = [];
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const request = {
      path: new URL(String(input)).pathname,
      bodyText: String(init?.body),
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
    };
    requests.push(request);
    if (request.path === "/v2/prekeys/claim") return relayResponse({ ok: true, data: { bundle: claimedBundle } });
    if (request.path === "/v2/prekeys/publish") {
      // The local profile's own bundle is published here and claimed by nobody in these scenarios
      // (the claim path serves the remote peer's bundle), so it remains available for a claim.
      const published = request.body.bundle as SignalPreKeyBundleV2;
      return relayResponse({ ok: true, data: { stored: true, bundle_id: published.bundle_id, claimable: true } });
    }
    if (request.path === "/v1/messages/send") return send(request);
    throw new Error(`unexpected relay path ${request.path}`);
  });
  return { fetch, requests };
}

const success = (request: RecordedRequest) => {
  const envelope = (request.body as { envelope: { envelope_id: string } }).envelope;
  return Promise.resolve(relayResponse({ ok: true, data: { accepted: true, envelope_id: envelope.envelope_id, status: "relayed" } }));
};
const claimID = "11111111-1111-4111-8111-111111111111";
const envelopeID = "22222222-2222-4222-8222-222222222222";
const messageID = "33333333-3333-4333-8333-333333333333";
const ids = (kind: "claim" | "envelope") => kind === "claim" ? claimID : envelopeID;

describe("CLI outbound messaging", () => {
  it("publishes the profile's complete signed Signal bundle v2", async () => {
    const local = await profileFixture();
    await local.profile.close();
    const remote = await untrustedRemote();
    const fake = relayFetch(remote.bundle, success);
    const relay = new RelayClient({ baseUrl: local.config.relay_url, timeoutMs: local.config.request_timeout_ms, fetch: fake.fetch });
    const messenger = await openOutboundMessenger({ profileDir: local.profileDir, environment: local.environment, relay, idFactory: ids, now: () => Date.now() });
    opened.push(messenger);

    await messenger.publish();
    const request = fake.requests.find(({ path }) => path === "/v2/prekeys/publish");
    expect(request).toBeDefined();
    expect(request!.body).toEqual({ bundle: expect.objectContaining({
      type: "signal_prekey_bundle",
      version: 2,
      suite: "libsignal-pq-v1",
      device_record: expect.objectContaining({ type: "device_record", version: 1 }),
      signed_prekey: expect.any(Object),
      kyber_prekey: expect.any(Object),
      one_time_prekey: expect.any(Object),
      signature: expect.any(String),
    }) });
  });

  it("claims the pinned contact, establishes Signal, and durably sends a valid mailbox envelope", async () => {
    const { local, remote } = await trustedPair();
    const fake = relayFetch(remote.bundle, success);
    const relay = new RelayClient({ baseUrl: local.config.relay_url, timeoutMs: local.config.request_timeout_ms, fetch: fake.fetch });
    const sendNow = Date.now();
    const messenger = await openOutboundMessenger({ profileDir: local.profileDir, environment: local.environment, relay, idFactory: ids, now: () => sendNow });
    opened.push(messenger);

    // `send` presupposes `relay publish` (T19): since T50 the relay authenticates the deposit
    // against an already-published device record, so a profile that never published is refused - and
    // must be refused BEFORE it claims the recipient's one-time prekey. The scenario this test is
    // about is a send that SUCCEEDS, so the profile publishes first, exactly as an operator does.
    await messenger.publish();
    await expect(messenger.send({ recipientIdentityId: remote.identity.identityId, messageId: messageID, plaintext: "first private message" }))
      .resolves.toEqual({ messageId: messageID, envelopeId: envelopeID, status: "delivered" });

    // The exact request sequence, unchanged in what it pins about the send: the claim comes first,
    // the deposit second, and nothing else is issued - now prefixed by the one publication the send
    // presupposes.
    expect(fake.requests.map(({ path }) => path)).toEqual(["/v2/prekeys/publish", "/v2/prekeys/claim", "/v1/messages/send"]);
    const claimRequest = fake.requests.find(({ path }) => path === "/v2/prekeys/claim")!;
    const sendRequest = fake.requests.find(({ path }) => path === "/v1/messages/send")!;
    expect(claimRequest.body).toEqual({ claim_id: claimID, identity_id: remote.identity.identityId, device_id: remote.identity.deviceId });
    const envelope = MailboxEnvelopeSchema.parse((sendRequest.body as { envelope: unknown }).envelope);
    expect(envelope).toMatchObject({
      envelope_id: envelopeID,
      message_id: messageID,
      recipient_identity_id: remote.identity.identityId,
      recipient_device_id: remote.identity.deviceId,
      payload_type: "ciphertext_message",
      created_at_ms: sendNow,
    });
    expect(envelope.ciphertext).not.toContain("first private message");

    await messenger.close();
    const store = new EncryptedSqliteStore(join(local.profileDir, "client.sqlite"), local.key);
    opened.push(store);
    await store.transaction((tx) => {
      expect(tx.keys("session:")).toHaveLength(1);
      expect(tx.keys("cli:outbox:")).toHaveLength(1);
    });
    const disk = readFileSync(join(local.profileDir, "client.sqlite"));
    expect(disk.includes(Buffer.from("first private message"))).toBe(false);
    expect(disk.includes(local.key)).toBe(false);
  });

  it("rejects a claimed bundle that differs from the imported contact pin before session or send mutation", async () => {
    const { local, remote } = await trustedPair();
    const impostor = await untrustedRemote();
    const fake = relayFetch(impostor.bundle, success);
    const relay = new RelayClient({ baseUrl: local.config.relay_url, timeoutMs: local.config.request_timeout_ms, fetch: fake.fetch });
    const messenger = await openOutboundMessenger({ profileDir: local.profileDir, environment: local.environment, relay, idFactory: ids, now: () => Date.now() });
    opened.push(messenger);

    // This test's subject is the trust decision on a CLAIMED bundle, so the profile must get as far
    // as the claim: it publishes first (T19 - `send` presupposes `relay publish`).
    await messenger.publish();
    await expect(messenger.send({ recipientIdentityId: remote.identity.identityId, messageId: messageID, plaintext: "must stay local" }))
      .rejects.toMatchObject({ code: "CONTACT_PIN_MISMATCH" });
    // Still exactly one claim and NO deposit: the pin is judged before anything is sent or stored.
    expect(fake.requests.map(({ path }) => path)).toEqual(["/v2/prekeys/publish", "/v2/prekeys/claim"]);
    await messenger.close();
    const store = new EncryptedSqliteStore(join(local.profileDir, "client.sqlite"), local.key);
    opened.push(store);
    await store.transaction((tx) => {
      expect(tx.keys("session:")).toEqual([]);
      expect(tx.keys("cli:outbox:")).toEqual([]);
    });
  });

  it("keeps an ambiguous send pending and reuses byte-identical IDs, ciphertext, and envelope after restart", async () => {
    const { local, remote } = await trustedPair();
    const firstFake = relayFetch(remote.bundle, async () => { throw new DOMException("response lost", "AbortError"); });
    const firstRelay = new RelayClient({ baseUrl: local.config.relay_url, timeoutMs: local.config.request_timeout_ms, fetch: firstFake.fetch });
    const first = await openOutboundMessenger({ profileDir: local.profileDir, environment: local.environment, relay: firstRelay, idFactory: ids, now: () => Date.now() });

    // The ambiguous send has to REACH /v1/messages/send to be ambiguous, so the profile publishes
    // first (T19). The retry below still publishes nothing: `retryPending` replays a committed
    // envelope and never re-enters the precondition.
    await first.publish();
    await expect(first.send({ recipientIdentityId: remote.identity.identityId, messageId: messageID, plaintext: "retry exact body" }))
      .rejects.toMatchObject({ code: "RELAY_TIMEOUT", retryable: true });
    const originalSend = firstFake.requests.find(({ path }) => path === "/v1/messages/send")!;
    await first.close();

    const retryFake = relayFetch(remote.bundle, success);
    const retryRelay = new RelayClient({ baseUrl: local.config.relay_url, timeoutMs: local.config.request_timeout_ms, fetch: retryFake.fetch });
    const reopened = await openOutboundMessenger({ profileDir: local.profileDir, environment: local.environment, relay: retryRelay, idFactory: () => { throw new Error("retry must not allocate ids"); }, now: () => Date.now() });
    opened.push(reopened);
    await expect(reopened.retryPending()).resolves.toEqual([{ messageId: messageID, envelopeId: envelopeID, status: "delivered" }]);

    const replayedSend = retryFake.requests.find(({ path }) => path === "/v1/messages/send")!;
    expect(replayedSend.bodyText).toBe(originalSend.bodyText);
    expect(replayedSend.body).toEqual(originalSend.body);
    expect(retryFake.requests.map(({ path }) => path)).toEqual(["/v1/messages/send"]);
  });

  it("rejects message-id content changes locally and treats an identical delivered replay idempotently", async () => {
    const { local, remote } = await trustedPair();
    const fake = relayFetch(remote.bundle, success);
    const relay = new RelayClient({ baseUrl: local.config.relay_url, timeoutMs: local.config.request_timeout_ms, fetch: fake.fetch });
    const messenger = await openOutboundMessenger({ profileDir: local.profileDir, environment: local.environment, relay, idFactory: ids, now: () => Date.now() });
    opened.push(messenger);

    const input = { recipientIdentityId: remote.identity.identityId, messageId: messageID, plaintext: "immutable plaintext" };
    // The first send must succeed for the replay/conflict comparison to mean anything (T19).
    await messenger.publish();
    await expect(messenger.send(input)).resolves.toMatchObject({ status: "delivered" });
    const callsAfterDelivery = fake.fetch.mock.calls.length;
    await expect(messenger.send(input)).resolves.toEqual({ messageId: messageID, envelopeId: envelopeID, status: "delivered" });
    await expect(messenger.send({ ...input, plaintext: "changed plaintext" })).rejects.toMatchObject({ code: "MESSAGE_ID_CONFLICT" });
    expect(fake.fetch).toHaveBeenCalledTimes(callsAfterDelivery);
    await expect(messenger.retryPending()).resolves.toEqual([]);
  });

  it("redacts plaintext and key material from typed errors and diagnostics", async () => {
    const { local, remote } = await trustedPair();
    const marker = "never-print-this-plaintext";
    const fake = relayFetch(remote.bundle, async () => { throw new Error(marker); });
    const relay = new RelayClient({ baseUrl: local.config.relay_url, timeoutMs: local.config.request_timeout_ms, fetch: fake.fetch });
    const messenger = await openOutboundMessenger({ profileDir: local.profileDir, environment: local.environment, relay, idFactory: ids, now: () => Date.now() });
    opened.push(messenger);

    const error = await messenger.send({ recipientIdentityId: remote.identity.identityId, messageId: messageID, plaintext: marker }).catch((caught: unknown) => caught);
    const publicText = `${String(error)} ${JSON.stringify(error)} ${JSON.stringify(await messenger.diagnostics())}`;
    expect(publicText).not.toContain(marker);
    expect(publicText).not.toContain(local.environment.ECHOLET_TEST_KEY);
    expect(publicText).not.toMatch(/deviceSecretKey|identitySecretKey|session|ciphertext/);
  });
});
