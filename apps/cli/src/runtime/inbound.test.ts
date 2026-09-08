import { afterEach, describe, expect, it, vi } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deriveMailboxId, verifyMailboxAckMessage, verifyMailboxChallengeMessage, verifyMailboxCreateChallengeMessage } from "@echolet/crypto-core";
import { signalAddressForDevice, type MailboxEnvelope } from "@echolet/protocol";
import { EncryptedSqliteStore, SignalClient, importVerifiedSignalBundleV2, type StoreTransaction } from "@echolet/session-node";
import { openProfile, PersistenceError } from "./profile";
import { openOutboundMessenger } from "./outbound";
import { RelayClient } from "../transport/relayClient";
import { InboundError, openInboundMessenger } from "./inbound";

const paths: string[] = [];
const handles: Array<{ close(): Promise<void> }> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const handle of handles.splice(0)) await handle.close();
  for (const path of paths.splice(0)) rmSync(path, { recursive: true, force: true });
});
const directory = () => { const path = mkdtempSync(join(tmpdir(), "echolet-inbound-test-")); paths.push(path); return path; };
const response = (data: unknown) => new Response(JSON.stringify({ ok: true, data }), { status: 200 });
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
async function local() {
  const profileDir = directory(), key = randomBytes(32);
  const config = { profile_version: 1, profile_id: randomUUID(), relay_url: "http://127.0.0.1:8081", database_path: "client.sqlite", store_key_env: "ECHOLET_TEST_KEY", request_timeout_ms: 500, poll_batch_size: 50 };
  const environment = { ECHOLET_TEST_KEY: key.toString("base64url") };
  const profile = await openProfile({ profileDir, config, environment, initialize: true }); handles.push(profile);
  const card = await profile.exportContact();
  return { profileDir, key, config, environment, profile, card, record: card.signal_bundle.device_record };
}
type Local = Awaited<ReturnType<typeof local>>;
async function pair(trustSender = true) {
  const alice = await local(), bob = await local();
  await alice.profile.importContact(bob.card, { confirm: async () => true });
  if (trustSender) await bob.profile.importContact(alice.card, { confirm: async () => true });
  await alice.profile.close(); await bob.profile.close();
  return { alice, bob };
}
async function snapshot(owner: Local, prefixes?: string[]) {
  const store = new EncryptedSqliteStore(join(owner.profileDir, "client.sqlite"), owner.key);
  try {
    return await store.transaction((tx) => Object.fromEntries(tx.keys().sort()
      .filter((key) => !prefixes || prefixes.some((prefix) => key.startsWith(prefix)))
      .map((key) => [key, Buffer.from(tx.get(key)!).toString("base64")]))) as Record<string, string>;
  } finally { await store.close(); }
}
const nativePrefixes = ["session:", "inbox:", "outbox:", "pre:", "used:"];
async function send(sender: Local, recipient: Local, plaintext: string, beforeAccept?: () => Promise<void>, afterPublish?: () => Promise<void>) {
  const envelopes: MailboxEnvelope[] = [];
  const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    if (path === "/v2/prekeys/claim") return response({ bundle: recipient.card.signal_bundle });
    // The SENDER's own publication. `send` presupposes `relay publish` (T19): since T50 the relay
    // authenticates a deposit against an already-published device record, and the client now refuses
    // locally, before any claim, when the profile has never published. This helper's job is to
    // produce one real, fully valid envelope, so it satisfies that precondition the way an operator
    // does. Nothing about the RECIPIENT's mailbox behaviour - which is what this file tests - is
    // touched, and every other path still raises.
    if (path === "/v2/prekeys/publish") {
      const bundle = (JSON.parse(String(init?.body)) as { bundle: { bundle_id: string } }).bundle;
      return response({ stored: true, bundle_id: bundle.bundle_id, claimable: true });
    }
    if (path === "/v1/messages/send") {
      const envelope = (JSON.parse(String(init?.body)) as { envelope: MailboxEnvelope }).envelope;
      envelopes.push(envelope);
      await beforeAccept?.();
      return response({ accepted: true, envelope_id: envelope.envelope_id, status: "relayed" });
    }
    throw new Error("Unexpected sender request");
  });
  const messenger = await openOutboundMessenger({ profileDir: sender.profileDir, environment: sender.environment,
    relay: new RelayClient({ baseUrl: sender.config.relay_url, timeoutMs: 500, fetch: fetcher }) });
  handles.push(messenger);
  try {
    await messenger.publish();
    await afterPublish?.();
    await messenger.send({ recipientIdentityId: recipient.record.identity_id, messageId: randomUUID(), plaintext });
  } finally { await messenger.close(); }
  expect(envelopes).toHaveLength(1);
  return envelopes[0]!;
}
type RequestBody = Record<string, unknown>;
function mailbox(owner: Local, initial: MailboxEnvelope[]) {
  const requests: Array<{ path: string; body: RequestBody }> = [];
  const state: { envelopes: MailboxEnvelope[]; intercept?: (path: string, body: RequestBody) => Promise<Response | undefined> } = { envelopes: initial };
  const challengeId = randomUUID(), nonce = randomBytes(32).toString("base64url");
  const mailboxId = deriveMailboxId(owner.record.identity_id);
  const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(input)).pathname, body = JSON.parse(String(init?.body)) as RequestBody;
    requests.push({ path, body });
    expect(body.recipient_mailbox_id).toBe(mailboxId);
    expect(body.device_id).toBe(owner.record.device_id);
    if (path === "/v1/mailbox/challenge") {
      expect(verifyMailboxCreateChallengeMessage(mailboxId, owner.record.device_id, String(body.signature), owner.record.device_pubkey)).toBe(true);
    } else if (path === "/v1/mailbox/poll") {
      expect(body.challenge_id).toBe(challengeId);
      expect(verifyMailboxChallengeMessage(challengeId, mailboxId, owner.record.device_id, nonce, String(body.signature), owner.record.device_pubkey)).toBe(true);
    } else if (path === "/v1/mailbox/ack") {
      expect(Array.isArray(body.envelope_ids)).toBe(true);
      expect(verifyMailboxAckMessage(mailboxId, owner.record.device_id, body.envelope_ids as string[], String(body.signature), owner.record.device_pubkey)).toBe(true);
    } else throw new Error("Unexpected recipient request");
    const overridden = await state.intercept?.(path, body);
    if (overridden) return overridden;
    if (path.endsWith("/challenge")) return response({ challenge_id: challengeId, nonce, expires_at_ms: Date.now() + 60000 });
    if (path.endsWith("/poll")) return response({ envelopes: state.envelopes, next_cursor: null });
    return response({ acked: (body.envelope_ids as string[]).length });
  });
  const relay = new RelayClient({ baseUrl: owner.config.relay_url, timeoutMs: 500, fetch: fetcher });
  return { requests, state, relay, fetcher, acks: () => requests.filter(({ path }) => path.endsWith("/ack")) };
}
async function inbound(owner: Local, fake: ReturnType<typeof mailbox>) {
  const messenger = await openInboundMessenger({ profileDir: owner.profileDir, environment: owner.environment, relay: fake.relay });
  handles.push(messenger);
  return messenger;
}
function failCommitOnce(predicate: (tx: StoreTransaction) => boolean) {
  const original = EncryptedSqliteStore.prototype.transaction;
  let injected = false;
  const spy = vi.spyOn(EncryptedSqliteStore.prototype, "transaction").mockImplementation(function<T>(this: EncryptedSqliteStore, operation: (tx: StoreTransaction) => T | Promise<T>): Promise<T> {
    return original.call(this, async (tx) => {
      const result = await operation(tx);
      if (!injected && predicate(tx)) { injected = true; throw new Error("SYNTHETIC_COMMIT_FAILURE"); }
      return result;
    }) as Promise<T>;
  });
  return { restore: () => spy.mockRestore(), wasInjected: () => injected };
}
/**
 * Pin the exact public rejection code of an inbound guard. `InboundError` is the exit-3 trust and
 * validation channel; a `PersistenceError` would be the exit-5 storage channel, so a guard that
 * disappears cannot be satisfied by an unrelated downstream throw.
 */
async function rejectsWith(operation: Promise<unknown>, code: string): Promise<InboundError> {
  const raised = await operation.then(() => undefined, (error: unknown) => error);
  expect(raised).toBeInstanceOf(InboundError);
  expect(raised).not.toBeInstanceOf(PersistenceError);
  expect((raised as InboundError).code).toBe(code);
  return raised as InboundError;
}

describe("CLI incoming messages and encrypted history", () => {
  it("signs stable mailbox requests and commits native inbox plus history before HTTP acknowledgement", async () => {
    const { alice, bob } = await pair(), text = "SYNTHETIC_PRIVATE_FIRST_MESSAGE";
    const envelope = await send(alice, bob, text), fake = mailbox(bob, [envelope]);
    let observedCommit = false;
    fake.state.intercept = async (path) => {
      if (path.endsWith("/ack")) {
        const native = await snapshot(bob, ["session:", "inbox:", "pre:"]);
        expect(Object.keys(native).filter((key) => key.startsWith("session:"))).toHaveLength(1);
        expect(Object.keys(native).filter((key) => key.startsWith("inbox:"))).toHaveLength(1);
        expect(native["pre:1"]).toBeUndefined();
        const history = await snapshot(bob, ["cli:history:"]);
        expect(Object.keys(history)).toHaveLength(1);
        expect(Object.values(history).map((value) => Buffer.from(value, "base64").toString()).join()).toContain(text);
        observedCommit = true;
      }
      return undefined;
    };
    const receiver = await inbound(bob, fake);
    await receiver.poll();
    expect(observedCommit).toBe(true);
    expect(fake.requests.map(({ path }) => path)).toEqual(["/v1/mailbox/challenge", "/v1/mailbox/poll", "/v1/mailbox/ack"]);
    expect(fake.acks()[0]!.body.envelope_ids).toEqual([envelope.envelope_id]);
    expect(await receiver.history({ contactIdentityId: alice.record.identity_id })).toEqual([expect.objectContaining({ messageId: envelope.message_id, direction: "inbound", plaintext: text })]);
  });

  it("rejects expired challenges and malformed or unknown relay response fields without acknowledgements", async () => {
    const { alice, bob } = await pair(), envelope = await send(alice, bob, "strict response");
    const before = await snapshot(bob);
    for (const variant of ["expired", "unknown-challenge", "unknown-poll", "invalid-envelope"] as const) {
      const fake = mailbox(bob, [envelope]);
      fake.state.intercept = async (path) => {
        if (variant === "expired" && path.endsWith("/challenge")) return response({ challenge_id: randomUUID(), nonce: "nonce", expires_at_ms: 1 });
        if (variant === "unknown-challenge" && path.endsWith("/challenge")) return response({ challenge_id: randomUUID(), nonce: "nonce", expires_at_ms: Date.now() + 60000, extra: true });
        if (path.endsWith("/poll") && variant === "unknown-poll") return response({ envelopes: [envelope], next_cursor: null, extra: true });
        if (path.endsWith("/poll") && variant === "invalid-envelope") return response({ envelopes: [{ ...envelope, extra: true }], next_cursor: null });
        return undefined;
      };
      const receiver = await inbound(bob, fake);
      await expect(receiver.poll()).rejects.toThrow();
      expect(fake.acks()).toEqual([]);
      await receiver.close();
      expect(await snapshot(bob)).toEqual(before);
    }
  });

  // The dedicated missing-contact guard owns this rejection; a generic `rejects.toThrow()` would
  // still pass if the guard were deleted and a later decode failed for an unrelated reason.
  it("rejects an envelope from an unpinned sender with CONTACT_NOT_TRUSTED before mutation", async () => {
    const { alice, bob } = await pair(false), envelope = await send(alice, bob, "untrusted");
    const before = await snapshot(bob);
    const fake = mailbox(bob, [envelope]), receiver = await inbound(bob, fake);
    await rejectsWith(receiver.poll(), "CONTACT_NOT_TRUSTED"); expect(fake.acks()).toEqual([]);
    await receiver.close(); expect(await snapshot(bob)).toEqual(before);
  });

  it("rejects a changed sender device and envelopes addressed to another recipient with their own typed failures", async () => {
    const { alice, bob } = await pair(false), envelope = await send(alice, bob, "pinned sender");
    const profile = await openProfile({ profileDir: bob.profileDir, environment: bob.environment });
    await profile.importContact(alice.card, { confirm: async () => true }); await profile.close();
    const pinned = await snapshot(bob);
    const variants = [
      { patch: { sender_device_id: randomUUID() }, code: "CONTACT_PIN_MISMATCH" },
      { patch: { recipient_identity_id: alice.record.identity_id }, code: "INVALID_ENVELOPE" },
      { patch: { recipient_device_id: randomUUID() }, code: "INVALID_ENVELOPE" },
      { patch: { recipient_mailbox_id: deriveMailboxId(alice.record.identity_id) }, code: "INVALID_ENVELOPE" },
    ];
    for (const { patch, code } of variants) {
      const bad = mailbox(bob, [{ ...envelope, ...patch }]), reader = await inbound(bob, bad);
      await rejectsWith(reader.poll(), code); expect(bad.acks()).toEqual([]);
      await reader.close(); expect(await snapshot(bob)).toEqual(pinned);
    }
  });

  it("rejects malformed native wrappers, tampering and authenticated message-ID mismatch while preserving a valid retry", async () => {
    const { alice, bob } = await pair(), envelope = await send(alice, bob, "valid retry");
    const before = await snapshot(bob), wrapper = JSON.parse(Buffer.from(envelope.ciphertext, "base64url").toString());
    const variants = [
      { envelope: { ...envelope, ciphertext: "%%%" }, code: "INBOUND_REJECTED" },
      { envelope: { ...envelope, ciphertext: Buffer.from(JSON.stringify({ ...wrapper, extra: true })).toString("base64url") }, code: "INBOUND_REJECTED" },
      { envelope: { ...envelope, ciphertext: Buffer.from(JSON.stringify({ ...wrapper, body: "AAAA" })).toString("base64url") }, code: "INBOUND_REJECTED" },
      { envelope: { ...envelope, message_id: randomUUID() }, code: "INBOUND_REJECTED" },
    ];
    for (const { envelope: bad, code } of variants) {
      bad.size_bytes = Buffer.byteLength(bad.ciphertext);
      const fake = mailbox(bob, [bad]), receiver = await inbound(bob, fake);
      await rejectsWith(receiver.poll(), code); expect(fake.acks()).toEqual([]);
      await receiver.close(); expect(await snapshot(bob)).toEqual(before);
    }
    const fake = mailbox(bob, [envelope]), receiver = await inbound(bob, fake);
    await receiver.poll(); expect(await receiver.history({ contactIdentityId: alice.record.identity_id })).toHaveLength(1);
  });

  it("rejects a different native Signal identity even when outer sender labels match the trusted contact", async () => {
    const { alice, bob } = await pair(), envelope = await send(alice, bob, "real sender");
    const store = new EncryptedSqliteStore(join(directory(), "impostor.sqlite"), randomBytes(32)); handles.push(store);
    const impostor = await SignalClient.create(store, signalAddressForDevice(alice.record.identity_id, alice.record.device_id));
    const verified = importVerifiedSignalBundleV2(bob.card.signal_bundle, { identityId: bob.record.identity_id, deviceId: bob.record.device_id });
    await impostor.approveRemote(verified.address, verified.bundle.identityKey().serialize());
    await impostor.establish(verified.address, verified.bundle);
    const message = await impostor.encrypt(verified.address, envelope.message_id, "impostor body");
    const ciphertext = Buffer.from(JSON.stringify({ version: 1, type: message.type, body: Buffer.from(message.body).toString("base64url") })).toString("base64url");
    const before = await snapshot(bob), fake = mailbox(bob, [{ ...envelope, ciphertext, size_bytes: Buffer.byteLength(ciphertext) }]);
    const receiver = await inbound(bob, fake);
    await expect(receiver.poll()).rejects.toThrow(); expect(fake.acks()).toEqual([]);
    await receiver.close(); expect(await snapshot(bob)).toEqual(before);
  });

  it("rolls back native decrypt, prekey consumption, inbox and history if persistence fails, then accepts redelivery", async () => {
    const { alice, bob } = await pair(), envelope = await send(alice, bob, "atomic inbound");
    const fake = mailbox(bob, [envelope]), receiver = await inbound(bob, fake), before = await snapshot(bob);
    const failure = failCommitOnce((tx) => tx.keys("inbox:").length > 0);
    await expect(receiver.poll()).rejects.toThrow();
    expect(failure.wasInjected()).toBe(true); failure.restore();
    expect(fake.acks()).toEqual([]); expect(await snapshot(bob)).toEqual(before);
    await receiver.poll(); expect(await receiver.history({ contactIdentityId: alice.record.identity_id })).toHaveLength(1);
  });

  it("recovers pending ack after restart without polling, decrypting again or duplicating history", async () => {
    const { alice, bob } = await pair(), envelope = await send(alice, bob, "ack recovery");
    const fake = mailbox(bob, [envelope]);
    fake.state.intercept = async (path) => { if (path.endsWith("/ack")) throw new DOMException("lost ack response", "AbortError"); return undefined; };
    const receiver = await inbound(bob, fake);
    await expect(receiver.poll()).rejects.toMatchObject({ code: "RELAY_TIMEOUT" });
    const history = await receiver.history({ contactIdentityId: alice.record.identity_id }); expect(history).toHaveLength(1);
    await receiver.close(); const native = await snapshot(bob, nativePrefixes);
    const retry = mailbox(bob, []), reopened = await inbound(bob, retry);
    await reopened.retryPendingAcks();
    expect(retry.requests.map(({ path }) => path)).toEqual(["/v1/mailbox/ack"]);
    expect(retry.acks()[0]!.body.envelope_ids).toEqual([envelope.envelope_id]);
    expect(await reopened.history({ contactIdentityId: alice.record.identity_id })).toEqual(history);
    expect(await snapshot(bob, nativePrefixes)).toEqual(native);
    await reopened.retryPendingAcks(); expect(retry.requests).toHaveLength(1);
  });

  it("acknowledges exact redelivery without a second decrypt but rejects changed ciphertext under a received message ID", async () => {
    const { alice, bob } = await pair(), envelope = await send(alice, bob, "deduplicate");
    const fake = mailbox(bob, [envelope]), receiver = await inbound(bob, fake);
    await receiver.poll(); const native = await snapshot(bob, nativePrefixes);
    fake.state.envelopes = [{ ...envelope, envelope_id: randomUUID() }];
    await receiver.poll();
    expect(await snapshot(bob, nativePrefixes)).toEqual(native);
    expect(await receiver.history({ contactIdentityId: alice.record.identity_id })).toHaveLength(1);
    expect(fake.acks().flatMap(({ body }) => body.envelope_ids as string[])).toContain(fake.state.envelopes[0]!.envelope_id);
    const bad = copy(envelope); bad.ciphertext = Buffer.from(JSON.stringify({ version: 1, type: 3, body: "AAAA" })).toString("base64url"); bad.size_bytes = Buffer.byteLength(bad.ciphertext);
    fake.state.envelopes = [bad]; const ackCount = fake.acks().length;
    await expect(receiver.poll()).rejects.toThrow(); expect(fake.acks()).toHaveLength(ackCount);
    expect(await snapshot(bob, nativePrefixes)).toEqual(native);
  });

  it("keeps chronological outbound and inbound history after restart while diagnostics and relay traffic omit plaintext", async () => {
    const { alice, bob } = await pair(), firstText = "SYNTHETIC_HISTORY_OUTBOUND", secondText = "SYNTHETIC_HISTORY_REPLY";
    const first = await send(alice, bob, firstText);
    const bobFake = mailbox(bob, [first]), bobReceiver = await inbound(bob, bobFake);
    await bobReceiver.poll(); await bobReceiver.close();
    const reply = await send(bob, alice, secondText);
    const aliceFake = mailbox(alice, [reply]), receiver = await inbound(alice, aliceFake);
    await receiver.poll();
    const history = await receiver.history({ contactIdentityId: bob.record.identity_id });
    expect(history).toEqual([
      expect.objectContaining({ messageId: first.message_id, direction: "outbound", plaintext: firstText }),
      expect.objectContaining({ messageId: reply.message_id, direction: "inbound", plaintext: secondText }),
    ]);
    expect(history[0]!.sequence).toBeLessThan(history[1]!.sequence);
    const publicText = JSON.stringify(await receiver.diagnostics()) + JSON.stringify(aliceFake.requests);
    expect(publicText).not.toContain(firstText); expect(publicText).not.toContain(secondText);
    expect(publicText).not.toContain(alice.environment.ECHOLET_TEST_KEY);
    expect(JSON.stringify(history)).not.toMatch(/deviceSecretKey|identitySecretKey|"seed"|ciphertext/);
    await receiver.close();
    const offline = mailbox(alice, []); offline.state.intercept = async () => { throw new Error("history must stay offline"); };
    const reopened = await inbound(alice, offline);
    expect(await reopened.history({ contactIdentityId: bob.record.identity_id })).toEqual(history); expect(offline.requests).toEqual([]);
    const disk = readFileSync(join(alice.profileDir, "client.sqlite"));
    expect(disk.includes(Buffer.from(firstText))).toBe(false); expect(disk.includes(Buffer.from(secondText))).toBe(false);
  });

  it("commits outbound plaintext history with native state/outbox before send and rolls all three back on persistence failure", async () => {
    const { alice, bob } = await pair();
    const failure = failCommitOnce((tx) => tx.keys("cli:outbox:").length > 0);
    const observedSend = vi.fn(async () => {});
    let beforeSend: Record<string, string> | undefined;
    // `send()` calls `publish()` first, and since T31 that durably mints alice's own first-contact
    // prekey pool (real, already-committed state, unrelated to the transactional write this test is
    // pinning) before `messenger.send()` ever runs. The property under test is that a persistence
    // failure inside `send()` rolls back exactly what `send()` itself attempted to write - so the
    // baseline is captured right after `publish()` finishes and right before `send()` starts, not
    // before either call. That baseline is unaffected by however large the published pool is.
    await expect(send(alice, bob, "atomic outbound history", observedSend, async () => {
      beforeSend = await snapshot(alice, nativePrefixes);
    })).rejects.toThrow();
    expect(failure.wasInjected()).toBe(true); failure.restore();
    expect(observedSend).not.toHaveBeenCalled();
    expect(beforeSend).toBeDefined();
    expect(await snapshot(alice, nativePrefixes)).toEqual(beforeSend);
    expect(await snapshot(alice, ["cli:outbox:", "cli:history:"])).toEqual({});
    let committed = false;
    await send(alice, bob, "atomic outbound history", async () => {
      expect(Object.keys(await snapshot(alice, ["session:"]))).toHaveLength(1);
      expect(Object.keys(await snapshot(alice, ["cli:outbox:"]))).toHaveLength(1);
      const entries = await snapshot(alice, ["cli:history:"]);
      expect(Object.keys(entries)).toHaveLength(1);
      expect(Object.values(entries).map((value) => Buffer.from(value, "base64").toString()).join()).toContain("atomic outbound history");
      committed = true;
    });
    expect(committed).toBe(true);
  });
});
