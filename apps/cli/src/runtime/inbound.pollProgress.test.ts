import { afterEach, describe, expect, it, vi } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deriveMailboxId } from "@echolet/crypto-core";
import type { MailboxEnvelope } from "@echolet/protocol";
import { EncryptedSqliteStore } from "@echolet/session-node";
import { openProfile, PersistenceError } from "./profile";
import { openOutboundMessenger } from "./outbound";
import { RelayClient } from "../transport/relayClient";
import { InboundError, openInboundMessenger } from "./inbound";

/**
 * RED tests for round-2 review finding R2-001 / R2-L-001 (major), path B: permanently rejected
 * envelopes monopolise the batch selection window, so the mailbox never makes progress.
 *
 * T41 isolates an unacceptable envelope inside `accept()`, and a permanently rejected envelope is
 * deliberately never acked (that is the F-012 guarantee). The relay therefore keeps returning it:
 * `GetEnvelopeBatch` re-selects unacked envelopes in key order under `limit`
 * (apps/relay/internal/storage/repository/mailbox_repo.go:169-173) and never skips one it has
 * already returned. An unauthenticated sender who fills one selection window with envelopes that
 * sort ahead of the legitimate ones makes every batch entirely poison: `received === 0`, so
 * `poll()` re-raises at inbound.ts:87 - BEFORE `ackPending()` at :88 - and the legitimate messages
 * queued behind the poison are never delivered. They are then lost at their declared 24h expiry.
 * That is the HL-N-001 harm, reached through a door per-envelope isolation does not close.
 *
 * The relay already publishes the signal that makes progress possible: `next_cursor` (HL-N-002,
 * surfaced as `PollResult.more`) is non-null exactly when selection stopped on a bound rather than
 * on the end of the mailbox. What these tests pin is the OUTCOME - a poison-filled window must not
 * prevent delivery of what is behind it - and they admit either shape of fix:
 *
 *   - `poll()` continues to the next page itself while `received === 0 && more === true`; or
 *   - `poll()` returns `{ received: 0, more: true }` without throwing and the caller polls again.
 *
 * `driveMailbox` below therefore keeps polling until progress is made, the relay reports no further
 * pages, or `poll()` throws. What it never tolerates is a throw while pages remain: that is the
 * wedge itself.
 *
 * The F-012 contract is preserved, not relaxed. `inbound.test.ts:177-183` and
 * `inbound.batchIsolation.test.ts:262-275` require that a poison-only batch acknowledges nothing
 * and leaves the store byte-identical; the second test below extends that requirement across
 * several pages, so "re-raise only when there are no further pages" cannot become "never re-raise".
 *
 * No plaintext body, ciphertext, store key or HTTP request body is printed by this suite: it
 * asserts on counts, identifiers and typed error codes. The one history assertion that names a body
 * uses a synthetic literal that is not secret.
 */

const paths: string[] = [];
const handles: Array<{ close(): Promise<void> }> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const handle of handles.splice(0)) await handle.close();
  for (const path of paths.splice(0)) rmSync(path, { recursive: true, force: true });
});

const directory = () => { const path = mkdtempSync(join(tmpdir(), "echolet-poll-progress-")); paths.push(path); return path; };
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
      return response({ accepted: true, envelope_id: envelope.envelope_id, status: "relayed" });
    }
    throw new Error("Unexpected sender request");
  });
  const messenger = await openOutboundMessenger({ profileDir: sender.profileDir, environment: sender.environment,
    relay: new RelayClient({ baseUrl: sender.config.relay_url, timeoutMs: 500, fetch: fetcher }) });
  try {
    await messenger.publish();
    await messenger.send({ recipientIdentityId: recipient.record.identity_id, messageId: randomUUID(), plaintext });
  } finally { await messenger.close(); }
  expect(envelopes).toHaveLength(1);
  return envelopes[0]!;
}

type RequestBody = Record<string, unknown>;

/**
 * A relay mailbox whose selection window is smaller than the queue, i.e. exactly the situation
 * `next_cursor` exists to describe.
 *
 * It behaves as the relay's own poll contract states (apps/relay/internal/api/handler/
 * mailbox_handler.go:58-62): a response cut short by a bound carries a non-null `next_cursor`
 * meaning "more envelopes remain, poll again", and the following poll resumes at the undelivered
 * set rather than replaying the page just handed out. Acknowledged envelopes are removed;
 * everything else stays queued and is offered again once the queue has been walked, so an unacked
 * envelope is never silently dropped.
 */
function mailbox(owner: Local, initial: MailboxEnvelope[], windowSize: number) {
  const requests: Array<{ path: string; body: RequestBody }> = [];
  const state: { envelopes: MailboxEnvelope[]; cursor: number; intercept?: (path: string) => Promise<Response | undefined> } =
    { envelopes: [...initial], cursor: 0 };
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
    if (path === "/v1/mailbox/poll") {
      if (state.cursor >= state.envelopes.length) state.cursor = 0;
      const page = state.envelopes.slice(state.cursor, state.cursor + windowSize);
      state.cursor += page.length;
      const hasMore = state.cursor < state.envelopes.length;
      if (!hasMore) state.cursor = 0;
      return response({ envelopes: page, next_cursor: hasMore ? "more" : null });
    }
    if (path === "/v1/mailbox/ack") {
      const acked = body.envelope_ids as string[];
      state.envelopes = state.envelopes.filter((envelope) => !acked.includes(envelope.envelope_id));
      state.cursor = 0;
      return response({ acked: acked.length });
    }
    throw new Error("Unexpected recipient request");
  });
  const relay = new RelayClient({ baseUrl: owner.config.relay_url, timeoutMs: 500, fetch: fetcher });
  return {
    requests, state, relay,
    polls: () => requests.filter(({ path }) => path === "/v1/mailbox/poll"),
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

type PollResult = { received: number; more: boolean; rejected: Array<{ envelopeId: string; code: string }> };
type Messenger = Awaited<ReturnType<typeof inbound>>;

/**
 * Polls until the mailbox makes progress, the relay reports no further pages, or `poll()` throws.
 *
 * This is what an operator with a wedged mailbox would do, and it deliberately admits both shapes
 * of fix: a `poll()` that walks the pages itself returns progress on the first call, and a `poll()`
 * that returns `{ received: 0, more: true }` per page gets called again here. `maxPolls` only stops
 * a runaway; a correct implementation needs far fewer.
 */
async function driveMailbox(receiver: Messenger, maxPolls = 6) {
  const results: PollResult[] = [];
  let error: unknown;
  for (let attempt = 0; attempt < maxPolls; attempt += 1) {
    try {
      const result = await receiver.poll() as PollResult;
      results.push(result);
      if (result.received > 0 || result.more === false) break;
    } catch (raised) { error = raised; break; }
  }
  return { results, error, received: results.reduce((total, result) => total + result.received, 0) };
}

describe("a batch monopolised by permanently rejected envelopes still makes progress (R2-001 path B)", () => {
  it("delivers and acknowledges the legitimate envelope queued behind a poison-filled selection window", async () => {
    const { bob, alice, mallory } = await cast();
    const text = "SYNTHETIC_POLL_PROGRESS_BODY";
    const firstPoison = await send(mallory, bob, "SYNTHETIC_POISON_BODY_ONE");
    const secondPoison = await send(mallory, bob, "SYNTHETIC_POISON_BODY_TWO");
    const legitimate = await send(alice, bob, text);

    // The window holds exactly the two poison envelopes, so the first page yields nothing and the
    // relay reports that more remain. This is the wedge: today `poll()` throws here, before
    // `ackPending()`, and the legitimate envelope is never reached.
    const fake = mailbox(bob, [firstPoison, secondPoison, legitimate], 2);
    const receiver = await inbound(bob, fake);

    const outcome = await driveMailbox(receiver);

    expect(outcome.error).toBeUndefined();
    expect(outcome.received).toBe(1);
    expect(fake.ackedIds()).toEqual([legitimate.envelope_id]);
    expect(await receiver.history({ contactIdentityId: alice.record.identity_id }))
      .toEqual([expect.objectContaining({ messageId: legitimate.message_id, direction: "inbound", plaintext: text })]);

    // The poison keeps its F-012 treatment: never acknowledged, never in history, still queued.
    expect(fake.ackedIds()).not.toContain(firstPoison.envelope_id);
    expect(fake.ackedIds()).not.toContain(secondPoison.envelope_id);
    expect(await receiver.history({ contactIdentityId: mallory.record.identity_id })).toEqual([]);
    expect(fake.queuedIds()).toEqual([firstPoison.envelope_id, secondPoison.envelope_id]);

    // Progress must come from honouring the relay's remaining-work signal, not from hammering it.
    expect(fake.polls().length).toBeLessThanOrEqual(4);
  }, 90000);

  it("still refuses, acknowledges nothing and mutates nothing when no page yields anything (F-012 across pages)", async () => {
    const { bob, alice } = await cast();
    const donor = await send(alice, bob, "SYNTHETIC_DONOR_BODY");
    const poison = [0, 1, 2].map(() => ({
      ...donor, envelope_id: randomUUID(), message_id: randomUUID(), ciphertext: "%%%", size_bytes: 3,
    }));

    const fake = mailbox(bob, poison, 2);
    const receiver = await inbound(bob, fake);
    const before = await snapshot(bob);

    const outcome = await driveMailbox(receiver);

    // Walking to the last page is progress toward an answer, not delivery: once no page remains,
    // the rejection must still surface as the typed InboundError it always was.
    expect(outcome.received).toBe(0);
    expect(outcome.error).toBeInstanceOf(InboundError);
    expect(outcome.error).not.toBeInstanceOf(PersistenceError);
    expect((outcome.error as InboundError).code).toBe("INBOUND_REJECTED");

    expect(fake.acks()).toEqual([]);
    expect(fake.queuedIds()).toEqual(poison.map((envelope) => envelope.envelope_id));
    await receiver.close();
    expect(await snapshot(bob)).toEqual(before);
  }, 90000);
});
