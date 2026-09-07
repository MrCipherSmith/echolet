import { afterEach, describe, expect, it, vi } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deriveMailboxId } from "@echolet/crypto-core";
import type { MailboxEnvelope } from "@echolet/protocol";
import { EncryptedSqliteStore, type StoreTransaction } from "@echolet/session-node";
import { openProfile, PersistenceError } from "./profile";
import { openOutboundMessenger } from "./outbound";
import { RelayClient } from "../transport/relayClient";
import { InboundError, openInboundMessenger } from "./inbound";

/**
 * RED tests for review finding HL-N-001 (major).
 *
 * `InboundMessenger.accept` processes a whole poll batch inside one `profile.withRuntime`
 * transaction (inbound.ts:47-78) and throws out of the loop on the first unacceptable envelope,
 * so `ackPending()` at inbound.ts:42 is never reached. `/v1/messages/send` has no sender
 * authentication, so anyone holding a published contact card can compute the mailbox id and place
 * one permanently-unacceptable envelope in it. The independent verifier reproduced the
 * consequence: three consecutive `poll()` calls all rejected, ZERO ack requests issued, history
 * empty, and the legitimate envelope queued behind the poison aged out UNDELIVERED at the CLI's
 * own declared 24h expiry (outbound.ts:83).
 *
 * The contract these tests pin, and the distinction that makes it correct:
 *
 *   PERMANENT rejection - untrusted sender, malformed ciphertext, wrong recipient. Retrying can
 *   never succeed. Such an envelope must NOT be decrypted, NOT be written to history and NOT be
 *   acked, and it must NOT stop the other envelopes in the same batch, or in any later batch,
 *   from being accepted and acked.
 *
 *   TRANSIENT failure - a local persistence failure, or a relay that is unavailable. Retrying can
 *   succeed, so nothing may be acked, the store must be left exactly as it was, and the envelope
 *   must stay queued for redelivery. This is the F-003 / exit-5 guarantee and nothing below
 *   relaxes it.
 *
 * Required `poll()` result shape (a superset of today's `{ received }`):
 *
 *   { received: number,                                   // envelopes accepted into history
 *     more: boolean,                                      // remaining-work signal, see HL-N-002
 *     rejected: Array<{ envelopeId: string; code: string }> }  // permanent rejections, in batch order
 *
 * When EVERY envelope in a batch is permanently rejected, `poll()` must still reject with the
 * first envelope's `InboundError` code, must still leave the store untouched and must still issue
 * no ack. That is the existing F-012 guarantee (inbound.test.ts:177) and it keeps holding here.
 *
 * No plaintext body, ciphertext, store key or HTTP request body is printed by this suite: it
 * asserts on counts, identifiers and typed error codes. The one history assertion that names a
 * body uses a synthetic literal that is not secret.
 */

const paths: string[] = [];
const handles: Array<{ close(): Promise<void> }> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const handle of handles.splice(0)) await handle.close();
  for (const path of paths.splice(0)) rmSync(path, { recursive: true, force: true });
});

const directory = () => { const path = mkdtempSync(join(tmpdir(), "echolet-batch-isolation-")); paths.push(path); return path; };
const response = (data: unknown) => new Response(JSON.stringify({ ok: true, data }), { status: 200 });

async function local() {
  const profileDir = directory(), key = randomBytes(32);
  const config = { profile_version: 1, profile_id: randomUUID(), relay_url: "http://127.0.0.1:8081", database_path: "client.sqlite", store_key_env: "ECHOLET_TEST_KEY", request_timeout_ms: 500, poll_batch_size: 50 };
  const environment = { ECHOLET_TEST_KEY: key.toString("base64url") };
  const profile = await openProfile({ profileDir, config, environment, initialize: true }); handles.push(profile);
  const card = await profile.exportContact();
  return { profileDir, key, config, environment, profile, card, record: card.signal_bundle.device_record };
}
type Local = Awaited<ReturnType<typeof local>>;

/**
 * `bob` is the recipient. `alice` is pinned by `bob`; `mallory` is not, and stands for any
 * unauthenticated sender that can compute `bob`'s mailbox id from a published contact card.
 */
async function cast() {
  const bob = await local(), alice = await local(), mallory = await local();
  await alice.profile.importContact(bob.card, { confirm: async () => true });
  await mallory.profile.importContact(bob.card, { confirm: async () => true });
  await bob.profile.importContact(alice.card, { confirm: async () => true });
  await bob.profile.close(); await alice.profile.close(); await mallory.profile.close();
  return { bob, alice, mallory };
}

async function snapshot(owner: Local) {
  const store = new EncryptedSqliteStore(join(owner.profileDir, "client.sqlite"), owner.key);
  try {
    return await store.transaction((tx) => Object.fromEntries(tx.keys().sort()
      .map((key) => [key, Buffer.from(tx.get(key)!).toString("base64")]))) as Record<string, string>;
  } finally { await store.close(); }
}

/** Produces one real, fully valid envelope addressed from `sender` to `recipient`. */
async function send(sender: Local, recipient: Local, plaintext: string) {
  const envelopes: MailboxEnvelope[] = [];
  const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    if (path === "/v2/prekeys/claim") return response({ bundle: recipient.card.signal_bundle });
    if (path === "/v1/messages/send") {
      const envelope = (JSON.parse(String(init?.body)) as { envelope: MailboxEnvelope }).envelope;
      envelopes.push(envelope);
      return response({ accepted: true, envelope_id: envelope.envelope_id, status: "relayed" });
    }
    throw new Error("Unexpected sender request");
  });
  const messenger = await openOutboundMessenger({ profileDir: sender.profileDir, environment: sender.environment,
    relay: new RelayClient({ baseUrl: sender.config.relay_url, timeoutMs: 500, fetch: fetcher }) });
  try { await messenger.send({ recipientIdentityId: recipient.record.identity_id, messageId: randomUUID(), plaintext }); }
  finally { await messenger.close(); }
  expect(envelopes).toHaveLength(1);
  return envelopes[0]!;
}

type RequestBody = Record<string, unknown>;

/**
 * A relay mailbox that behaves like the real one: acknowledged envelopes are removed, everything
 * else stays queued and is returned by the next poll. That is what makes "a later batch" a real
 * scenario rather than a fixture arrangement.
 */
function mailbox(owner: Local, initial: MailboxEnvelope[]) {
  const requests: Array<{ path: string; body: RequestBody }> = [];
  const state: { envelopes: MailboxEnvelope[]; nextCursor: string | null; intercept?: (path: string) => Promise<Response | undefined> } =
    { envelopes: [...initial], nextCursor: null };
  const challengeId = randomUUID(), nonce = randomBytes(32).toString("base64url");
  const mailboxId = deriveMailboxId(owner.record.identity_id);
  const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(input)).pathname, body = JSON.parse(String(init?.body)) as RequestBody;
    requests.push({ path, body });
    expect(body.recipient_mailbox_id).toBe(mailboxId);
    expect(body.device_id).toBe(owner.record.device_id);
    const overridden = await state.intercept?.(path);
    if (overridden) return overridden;
    if (path === "/v1/mailbox/challenge") return response({ challenge_id: challengeId, nonce, expires_at_ms: Date.now() + 60000 });
    if (path === "/v1/mailbox/poll") return response({ envelopes: state.envelopes, next_cursor: state.nextCursor });
    if (path === "/v1/mailbox/ack") {
      const acked = body.envelope_ids as string[];
      state.envelopes = state.envelopes.filter((envelope) => !acked.includes(envelope.envelope_id));
      return response({ acked: acked.length });
    }
    throw new Error("Unexpected recipient request");
  });
  const relay = new RelayClient({ baseUrl: owner.config.relay_url, timeoutMs: 500, fetch: fetcher });
  return {
    requests, state, relay,
    acks: () => requests.filter(({ path }) => path === "/v1/mailbox/ack"),
    ackedIds: () => requests.filter(({ path }) => path === "/v1/mailbox/ack").flatMap(({ body }) => body.envelope_ids as string[]),
    queuedIds: () => state.envelopes.map((envelope) => envelope.envelope_id),
  };
}

async function inbound(owner: Local, fake: ReturnType<typeof mailbox>) {
  const messenger = await openInboundMessenger({ profileDir: owner.profileDir, environment: owner.environment, relay: fake.relay });
  handles.push(messenger);
  return messenger;
}

/** Injects exactly one store-commit failure: the transient, retriable class. */
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

/** The poll result contract required by this suite. `poll()` returns `{ received }` only today. */
type PollResult = { received: number; more: boolean; rejected: Array<{ envelopeId: string; code: string }> };
const pollResult = async (operation: Promise<unknown>): Promise<PollResult> => await operation as PollResult;

async function rejectsWith(operation: Promise<unknown>, code: string): Promise<InboundError> {
  const raised = await operation.then(() => undefined, (error: unknown) => error);
  expect(raised).toBeInstanceOf(InboundError);
  expect(raised).not.toBeInstanceOf(PersistenceError);
  expect((raised as InboundError).code).toBe(code);
  return raised as InboundError;
}

describe("a permanently unacceptable envelope cannot block a poll batch (HL-N-001)", () => {
  for (const poisonFirst of [true, false]) {
    it(`delivers and acknowledges the legitimate envelope sharing a batch with an untrusted sender's envelope (poison ${poisonFirst ? "first" : "last"})`, async () => {
      const { bob, alice, mallory } = await cast();
      const text = "SYNTHETIC_BATCH_ISOLATION_BODY";
      const poison = await send(mallory, bob, "SYNTHETIC_POISON_BODY");
      const legitimate = await send(alice, bob, text);

      const fake = mailbox(bob, poisonFirst ? [poison, legitimate] : [legitimate, poison]);
      const receiver = await inbound(bob, fake);

      const result = await pollResult(receiver.poll());

      // The legitimate envelope is accepted, acknowledged and readable.
      expect(result.received).toBe(1);
      expect(fake.ackedIds()).toEqual([legitimate.envelope_id]);
      expect(await receiver.history({ contactIdentityId: alice.record.identity_id }))
        .toEqual([expect.objectContaining({ messageId: legitimate.message_id, direction: "inbound", plaintext: text })]);

      // The untrusted envelope is still rejected, still not acknowledged and still absent from
      // history: F-012 is preserved; it is merely no longer able to block the batch.
      expect(result.rejected).toEqual([{ envelopeId: poison.envelope_id, code: "CONTACT_NOT_TRUSTED" }]);
      expect(fake.ackedIds()).not.toContain(poison.envelope_id);
      expect(await receiver.history({ contactIdentityId: mallory.record.identity_id })).toEqual([]);
      expect(fake.queuedIds()).toEqual([poison.envelope_id]);
    }, 90000);
  }

  it("keeps delivering later batches while the same untrusted envelope stays queued", async () => {
    const { bob, alice, mallory } = await cast();
    const poison = await send(mallory, bob, "SYNTHETIC_POISON_BODY");
    const first = await send(alice, bob, "SYNTHETIC_FIRST_BODY");
    const second = await send(alice, bob, "SYNTHETIC_SECOND_BODY");

    const fake = mailbox(bob, [poison, first]);
    const receiver = await inbound(bob, fake);

    const firstPoll = await pollResult(receiver.poll());
    expect(firstPoll.received).toBe(1);
    expect(fake.ackedIds()).toEqual([first.envelope_id]);

    // The poison is still queued, exactly as an unacked envelope must be. A later legitimate
    // envelope arriving behind it must still be delivered rather than aging out undelivered.
    expect(fake.queuedIds()).toEqual([poison.envelope_id]);
    fake.state.envelopes = [...fake.state.envelopes, second];

    const secondPoll = await pollResult(receiver.poll());
    expect(secondPoll.received).toBe(1);
    expect(fake.ackedIds()).toEqual([first.envelope_id, second.envelope_id]);
    expect(await receiver.history({ contactIdentityId: alice.record.identity_id })).toHaveLength(2);
    expect(secondPoll.rejected).toEqual([{ envelopeId: poison.envelope_id, code: "CONTACT_NOT_TRUSTED" }]);
  }, 90000);

  for (const variant of ["malformed-ciphertext", "misaddressed"] as const) {
    it(`does not let a ${variant} envelope block the batch either`, async () => {
      const { bob, alice } = await cast();
      const legitimate = await send(alice, bob, "SYNTHETIC_SURVIVOR_BODY");
      const donor = await send(alice, bob, "SYNTHETIC_DONOR_BODY");

      const poison: MailboxEnvelope = variant === "malformed-ciphertext"
        ? { ...donor, envelope_id: randomUUID(), message_id: randomUUID(), ciphertext: "%%%", size_bytes: 3 }
        : { ...donor, envelope_id: randomUUID(), message_id: randomUUID(), recipient_identity_id: alice.record.identity_id };
      const code = variant === "malformed-ciphertext" ? "INBOUND_REJECTED" : "INVALID_ENVELOPE";

      const fake = mailbox(bob, [poison, legitimate]);
      const receiver = await inbound(bob, fake);

      const result = await pollResult(receiver.poll());

      expect(result.received).toBe(1);
      expect(result.rejected).toEqual([{ envelopeId: poison.envelope_id, code }]);
      expect(fake.ackedIds()).toEqual([legitimate.envelope_id]);
      expect(fake.queuedIds()).toEqual([poison.envelope_id]);
    }, 90000);
  }

  it("still rejects a batch whose every envelope is permanently unacceptable, without acking or mutating anything (F-012)", async () => {
    const { bob, mallory } = await cast();
    const poison = await send(mallory, bob, "SYNTHETIC_POISON_BODY");
    const before = await snapshot(bob);

    const fake = mailbox(bob, [poison]);
    const receiver = await inbound(bob, fake);

    await rejectsWith(receiver.poll(), "CONTACT_NOT_TRUSTED");

    expect(fake.acks()).toEqual([]);
    await receiver.close();
    expect(await snapshot(bob)).toEqual(before);
  }, 90000);
});

describe("a transient failure stays retriable and acknowledges nothing (HL-N-001, F-003)", () => {
  it("leaves both envelopes queued and the store untouched when the commit fails, then delivers them on retry", async () => {
    const { bob, alice } = await cast();
    const one = await send(alice, bob, "SYNTHETIC_TRANSIENT_ONE");
    const two = await send(alice, bob, "SYNTHETIC_TRANSIENT_TWO");

    const fake = mailbox(bob, [one, two]);
    const receiver = await inbound(bob, fake);
    const before = await snapshot(bob);

    const failure = failCommitOnce((tx) => tx.keys("inbox:").length > 0);
    await expect(receiver.poll()).rejects.toThrow();
    expect(failure.wasInjected()).toBe(true);
    failure.restore();

    // A store failure is not a verdict about the envelope: nothing acked, nothing committed,
    // both envelopes still queued for redelivery.
    expect(fake.acks()).toEqual([]);
    expect(await snapshot(bob)).toEqual(before);
    expect(fake.queuedIds()).toEqual([one.envelope_id, two.envelope_id]);

    const retry = await pollResult(receiver.poll());
    expect(retry.received).toBe(2);
    expect(retry.rejected).toEqual([]);
    expect(fake.ackedIds().sort()).toEqual([one.envelope_id, two.envelope_id].sort());
    expect(fake.queuedIds()).toEqual([]);
  }, 90000);

  it("keeps the pending acknowledgement of an accepted envelope when the ack request fails, and never acks the poison", async () => {
    const { bob, alice, mallory } = await cast();
    const poison = await send(mallory, bob, "SYNTHETIC_POISON_BODY");
    const legitimate = await send(alice, bob, "SYNTHETIC_PENDING_ACK_BODY");

    const fake = mailbox(bob, [poison, legitimate]);
    fake.state.intercept = async (path) => {
      if (path === "/v1/mailbox/ack") throw new DOMException("lost ack response", "AbortError");
      return undefined;
    };
    const receiver = await inbound(bob, fake);

    // A relay failure is transient: the poll fails loudly, but the accepted envelope is already
    // committed and its acknowledgement stays pending rather than being dropped.
    await expect(receiver.poll()).rejects.toMatchObject({ code: "RELAY_TIMEOUT" });
    expect(await receiver.history({ contactIdentityId: alice.record.identity_id })).toHaveLength(1);

    fake.state.intercept = undefined;
    await receiver.retryPendingAcks();

    // `mailbox()` records a request before `state.intercept` can reject it, so the intercepted
    // attempt and the successful retry are both in `requests`. Their number is an artefact of the
    // fixture, not a contract: what this test pins is WHICH envelopes were ever offered for
    // acknowledgement - the accepted one, and only ever that one.
    expect([...new Set(fake.ackedIds())]).toEqual([legitimate.envelope_id]);
    expect(fake.ackedIds()).not.toContain(poison.envelope_id);
    // The retry actually reached the relay: only the fake's ack branch drops an envelope from the
    // queue, so the pending acknowledgement survived the failed request and was replayed.
    expect(fake.queuedIds()).toEqual([poison.envelope_id]);
  }, 90000);
});

/**
 * RED tests for review finding HL-N-002 (minor).
 *
 * F-009 added `next_cursor` to the poll response as the relay's remaining-work signal, and
 * `relayClient.ts:24` parses it as a closed `string|null` union. `InboundMessenger.poll` then
 * discards it: `inbound.ts:38-43` returns `{ received }` only, so the whole operator-visible half
 * of F-009 is invisible at the CLI and the only read of `next_cursor` anywhere in the tree is a
 * transport test. The poll result must carry the signal through to its caller.
 */
describe("poll surfaces the relay's remaining-work signal to its caller (HL-N-002)", () => {
  it("reports more work while the relay withheld envelopes, and no more work once the mailbox is drained", async () => {
    const { bob, alice } = await cast();
    const first = await send(alice, bob, "SYNTHETIC_CURSOR_FIRST");
    const second = await send(alice, bob, "SYNTHETIC_CURSOR_SECOND");

    // The relay cut this response short at its own bound: one envelope now, one still queued.
    const fake = mailbox(bob, [first]);
    fake.state.nextCursor = "more";
    const receiver = await inbound(bob, fake);

    const cutShort = await pollResult(receiver.poll());
    expect(cutShort.received).toBe(1);
    expect(cutShort.more).toBe(true);

    // The caller polls again because it was told to, and the mailbox drains.
    fake.state.envelopes = [second];
    fake.state.nextCursor = null;
    const drained = await pollResult(receiver.poll());
    expect(drained.received).toBe(1);
    expect(drained.more).toBe(false);
    expect(await receiver.history({ contactIdentityId: alice.record.identity_id })).toHaveLength(2);
  }, 90000);

  it("reports no remaining work for an empty mailbox", async () => {
    const { bob } = await cast();
    const fake = mailbox(bob, []);
    const receiver = await inbound(bob, fake);

    const result = await pollResult(receiver.poll());

    expect(result).toMatchObject({ received: 0, more: false });
    expect(result.rejected).toEqual([]);
  }, 90000);
});
