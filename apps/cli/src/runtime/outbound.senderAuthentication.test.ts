import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createIdentityProfile, createSignedDeviceRecord } from "@echolet/client-core";
import { decodeBase64Url, verifyUtf8Message } from "@echolet/crypto-core";
import { signalAddressForDevice, type SignalPreKeyBundleV2 } from "@echolet/protocol";
import { EncryptedSqliteStore, SignalClient, exportSignedSignalBundleV2 } from "@echolet/session-node";
import { openProfile } from "./profile";
import { RelayClient } from "../transport/relayClient";
import { openOutboundMessenger } from "./outbound";
import { CLI_TEST_TIMEOUT_MS } from "../../test/childProcessTimeouts";

// RED tests for T50 / finding T49-F-001 (major), on the sender side.
//
// T49 measured, against the real relay binary at default configuration, that 49 unauthenticated
// POSTs of maximum-size envelopes (~12.8 MB, under 30 s inside the 120/min rate limit) permanently
// wedge a victim's mailbox for up to the 168 h retention cap, needing only the victim's mailbox id.
// 800 minimum-size envelopes do the same. The relay is where that is refused, but the refusal is
// only survivable if the CLI's own sends carry the binding the relay now requires - otherwise the
// fix closes the flooding path by closing the product.
//
// This file pins that `send` emits an envelope whose `sender_signature` verifies against the
// profile's own published device key, over the transcript the relay reproduces. The transcript is
// rebuilt here from primitives that already exist (`verifyUtf8Message`, node's SHA-256) rather than
// by calling the new helper, so these assertions pin the wire contract itself and stay independent
// of how the production helper is factored. Its canonical form is pinned in
// packages/crypto-core/src/mailbox/auth.envelope.test.ts and, on the Go side, in
// apps/relay/internal/api/handler/mailbox_sender_authentication_test.go.
//
// No plaintext, ciphertext, store key or private key material is asserted on or printed.

const paths: string[] = [];
const opened: Array<{ close(): Promise<void> }> = [];
afterEach(async () => {
  for (const handle of opened.splice(0)) await handle.close();
  for (const path of paths.splice(0)) rmSync(path, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const directory = () => {
  const path = mkdtempSync(join(tmpdir(), "echolet-sender-auth-test-"));
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
    // The profile's own publication. It is answered rather than refused because `send` presupposes
    // `relay publish` (T19): T50's sender authentication is exactly what this file is about, and the
    // client now refuses locally, before any claim, when the profile has never published. Every
    // other path still raises, so the fake keeps reporting requests this suite does not expect.
    if (request.path === "/v2/prekeys/publish") {
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

interface WireEnvelope {
  envelope_id: string;
  message_id: string;
  sender_identity_id: string;
  sender_device_id: string;
  recipient_mailbox_id: string;
  ciphertext: string;
  created_at_ms: number;
  expires_at_ms: number;
  sender_signature?: string;
}

/**
 * The transcript the relay reproduces, rebuilt from the envelope alone. Nothing outside the
 * envelope's own fields is required to verify it, which is what lets the relay check it against the
 * sender's published DeviceRecord without any session state.
 */
const senderTranscript = (envelope: WireEnvelope) =>
  "echolet-mailbox-envelope:v1:" +
  `${envelope.recipient_mailbox_id}:${envelope.envelope_id}:${envelope.sender_identity_id}:` +
  `${envelope.sender_device_id}:${createHash("sha256").update(envelope.ciphertext, "utf8").digest("base64url")}:` +
  `${envelope.created_at_ms}:${envelope.expires_at_ms}`;

/** The profile's own device public key, read from the durable device record it publishes. */
async function localDevicePubKey(profileDir: string, key: Buffer) {
  const store = new EncryptedSqliteStore(join(profileDir, "client.sqlite"), key);
  opened.push(store);
  return store.transaction((tx) => {
    const metadata = JSON.parse(Buffer.from(tx.get("cli:profile")!).toString("utf8")) as {
      device_record: { device_pubkey: string; identity_id: string; device_id: string };
    };
    return metadata.device_record;
  });
}

const sentEnvelope = (requests: RecordedRequest[]) =>
  (requests.find(({ path }) => path === "/v1/messages/send")!.body as { envelope: WireEnvelope }).envelope;

describe("CLI outbound sender authentication", () => {
  it("signs every envelope it sends with the profile's own device key", async () => {
    const { local, remote } = await trustedPair();
    const fake = relayFetch(remote.bundle, success);
    const relay = new RelayClient({ baseUrl: local.config.relay_url, timeoutMs: local.config.request_timeout_ms, fetch: fake.fetch });
    const messenger = await openOutboundMessenger({ profileDir: local.profileDir, environment: local.environment, relay });
    opened.push(messenger);

    // T19: the profile publishes before it sends, which is the very device record the relay
    // resolves this signature against.
    await messenger.publish();
    await expect(messenger.send({ recipientIdentityId: remote.identity.identityId, messageId: randomUUID(), plaintext: "authenticated send" }))
      .resolves.toMatchObject({ status: "delivered" });
    await messenger.close();

    const envelope = sentEnvelope(fake.requests);
    const record = await localDevicePubKey(local.profileDir, local.key);

    // The load-bearing assertion. Without it the relay has nothing to verify, and an
    // authenticating relay refuses every message this CLI sends.
    expect(typeof envelope.sender_signature, "send must emit a sender_signature the relay can verify").toBe("string");
    expect(envelope.sender_signature!.length).toBeGreaterThan(0);
    expect(envelope.sender_signature!.length).toBeLessThanOrEqual(256);
    expect(envelope.sender_signature!).toMatch(/^[A-Za-z0-9_-]+$/);

    // The envelope names the profile's own device, and the signature verifies under that device's
    // published public key - the same key the relay resolves through the (mailbox identity,
    // device UUID) binding.
    expect(envelope.sender_identity_id).toBe(record.identity_id);
    expect(envelope.sender_device_id).toBe(record.device_id);
    expect(verifyUtf8Message(senderTranscript(envelope), envelope.sender_signature!, record.device_pubkey)).toBe(true);
  }, CLI_TEST_TIMEOUT_MS);

  it("binds the signature to this envelope, so no field can be swapped after signing", async () => {
    const { local, remote } = await trustedPair();
    const fake = relayFetch(remote.bundle, success);
    const relay = new RelayClient({ baseUrl: local.config.relay_url, timeoutMs: local.config.request_timeout_ms, fetch: fake.fetch });
    const messenger = await openOutboundMessenger({ profileDir: local.profileDir, environment: local.environment, relay });
    opened.push(messenger);

    // T19: the profile publishes before it sends.
    await messenger.publish();
    await messenger.send({ recipientIdentityId: remote.identity.identityId, messageId: randomUUID(), plaintext: "bound to this envelope" });
    await messenger.close();

    const envelope = sentEnvelope(fake.requests);
    const record = await localDevicePubKey(local.profileDir, local.key);
    expect(typeof envelope.sender_signature, "send must emit a sender_signature before it can be bound to anything").toBe("string");
    const signature = envelope.sender_signature!;

    const tampered: Array<[string, Partial<WireEnvelope>]> = [
      ["recipient_mailbox_id", { recipient_mailbox_id: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" }],
      ["envelope_id", { envelope_id: "00000000-0000-4000-8000-000000000001" }],
      ["sender_identity_id", { sender_identity_id: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" }],
      ["sender_device_id", { sender_device_id: "8cc8010b-d4a1-4ce7-8203-a8f6b055c1b9" }],
      ["ciphertext", { ciphertext: "QkJCQkJCQkJCQkJC" }],
      ["created_at_ms", { created_at_ms: envelope.created_at_ms + 1 }],
      ["expires_at_ms", { expires_at_ms: envelope.expires_at_ms + 1 }],
    ];
    for (const [field, change] of tampered) {
      expect(
        verifyUtf8Message(senderTranscript({ ...envelope, ...change }), signature, record.device_pubkey),
        `${field} must be bound by the signature, otherwise the binding is decorative`,
      ).toBe(false);
    }
  }, CLI_TEST_TIMEOUT_MS);

  it("replays the identical signature on an exact retry, so an idempotent replay stays idempotent", async () => {
    // F-004: a lost response is retried with the byte-identical envelope and the relay treats a
    // byte-identical replay as idempotent. A signature that changed per attempt would turn every
    // retry into an ENVELOPE_ID_CONFLICT.
    const { local, remote } = await trustedPair();
    const firstFake = relayFetch(remote.bundle, async () => { throw new DOMException("response lost", "AbortError"); });
    const firstRelay = new RelayClient({ baseUrl: local.config.relay_url, timeoutMs: local.config.request_timeout_ms, fetch: firstFake.fetch });
    const first = await openOutboundMessenger({ profileDir: local.profileDir, environment: local.environment, relay: firstRelay });
    const messageId = randomUUID();
    // T19: the first attempt has to reach /v1/messages/send to be an ambiguous send at all, so the
    // profile publishes first. The retry replays a committed envelope and never re-enters the
    // precondition.
    await first.publish();
    await expect(first.send({ recipientIdentityId: remote.identity.identityId, messageId, plaintext: "retry exact body" }))
      .rejects.toMatchObject({ code: "RELAY_TIMEOUT" });
    await first.close();

    const retryFake = relayFetch(remote.bundle, success);
    const retryRelay = new RelayClient({ baseUrl: local.config.relay_url, timeoutMs: local.config.request_timeout_ms, fetch: retryFake.fetch });
    const reopened = await openOutboundMessenger({ profileDir: local.profileDir, environment: local.environment, relay: retryRelay });
    opened.push(reopened);
    await expect(reopened.retryPending()).resolves.toMatchObject([{ messageId, status: "delivered" }]);
    await reopened.close();

    const original = sentEnvelope(firstFake.requests);
    const replayed = sentEnvelope(retryFake.requests);
    expect(typeof original.sender_signature).toBe("string");
    expect(replayed.sender_signature).toBe(original.sender_signature);
  }, CLI_TEST_TIMEOUT_MS);
});
