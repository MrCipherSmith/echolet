import { afterEach, describe, expect, it, vi } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deriveMailboxId } from "@echolet/crypto-core";
import type { MailboxEnvelope } from "@echolet/protocol";
import { EncryptedSqliteStore } from "@echolet/session-node";
import { openProfile } from "./profile";
import { openOutboundMessenger } from "./outbound";
import { RelayClient } from "../transport/relayClient";
import { InboundError, openInboundMessenger } from "./inbound";

/**
 * RED tests for flow 002 / T5 design §3 C4-3 — the CLIENT half of the walk, and only that.
 *
 * The boundary this file must not cross
 * -------------------------------------
 * Finding T47-TP-001 caught a fixture-only proof of closure: a mocked `RelayClient` that modelled a
 * relay resuming at the undelivered set turned a client-only change green while the real binary
 * stayed wedged. The T5 design's governing rule for this wave is therefore explicit:
 *
 *     No test in this wave may assert closure through a mocked `RelayClient`. Client-side unit
 *     tests may pin walk logic; the closure claim rests only on the real-binary suite.
 *
 * Nothing in this file claims the flooding class is closed. That claim lives, and may only live, in
 * apps/cli/test/e2e/flood-closure.test.ts, against `apps/relay/cmd/relay` built from this tree and
 * the real `apps/cli/dist/cli.js`. What is pinned HERE is the one thing a real-binary test cannot
 * localise: which request `poll()` itself decides to make when a page walk judged nothing.
 *
 * The wire contract these tests assume
 * ------------------------------------
 * C4-2 keeps `next_cursor`'s exact wire shape and changes its meaning to "resume strictly after this
 * sequence", and the recipient reports `read_through`, "the highest sequence it has judged —
 * committed OR permanently refused". The fake relay below implements exactly that and nothing else:
 * `read_through` is an opaque, server-issued token that the recipient echoes back verbatim, the same
 * way `cursor` already is (relayClient.ts:41-45). A poll without a `cursor` resumes at the stored
 * mark rather than at the head.
 *
 * The design names `/v1/mailbox/ack` as the route that carries it. These tests deliberately do NOT
 * pin that choice: the fake accepts `read_through` on the poll request too, because the poll is
 * equally signed and challenge-bound, and carrying it there keeps `inbound.pollProgress.test.ts:248`
 * — which asserts "acknowledges nothing" as "no ack REQUEST at all" — literally true. Either shape
 * satisfies this file. What neither shape may do is discard the judgement.
 *
 * What is asserted
 * ----------------
 *   1. F-012 is unchanged on the accept-nothing path: the typed `InboundError` is still raised, no
 *      envelope id is acknowledged, no history is written and the store is byte-identical
 *      afterwards. `inbound.test.ts:177-183` and `inbound.pollProgress.test.ts:228-252` pin the same
 *      contract and must stay green.
 *   2. The read position nevertheless moves, so a walk that judged 32 poison envelopes and then gave
 *      up has not thrown that judgement away.
 *   3. Design §4 R-4: the mark may only advance to a position the poll ACTUALLY received. A client
 *      that advances past an envelope it never read skips that envelope permanently.
 *
 * No plaintext body, ciphertext, store key or HTTP request body is printed: the assertions are on
 * counts, identifiers, typed codes and opaque tokens. Bodies named here are synthetic literals.
 */

const paths: string[] = [];
const handles: Array<{ close(): Promise<void> }> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const handle of handles.splice(0)) await handle.close();
  for (const path of paths.splice(0)) rmSync(path, { recursive: true, force: true });
});

const directory = () => { const path = mkdtempSync(join(tmpdir(), "echolet-read-mark-")); paths.push(path); return path; };
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
 * A relay that keeps a per-(mailbox, device) read mark, as C4-2 requires.
 *
 * Sequences are 1-based positions assigned by this fake in STORE order, never derived from any
 * sender-supplied field — the whole point of C4-1. `next_cursor` is the sequence of the last
 * envelope on the page. A poll WITHOUT a cursor resumes strictly after the stored mark; a poll WITH
 * one resumes strictly after that token, so a full re-walk stays available.
 *
 * `read_through` on ack moves the mark, and only ever forward.
 */
function markedMailbox(owner: Local, initial: MailboxEnvelope[], windowSize: number) {
  const requests: Array<{ path: string; body: RequestBody }> = [];
  const sequences = new Map(initial.map((envelope, index) => [envelope.envelope_id, index + 1]));
  const state = { envelopes: [...initial], mark: 0, issuedCursors: [] as string[] };
  const nonce = randomBytes(32).toString("base64url");
  const mailboxId = deriveMailboxId(owner.record.identity_id);
  /**
   * The mark moves whenever the recipient presents a `read_through`, on WHICHEVER signed request it
   * chooses to carry it. The design names `/v1/mailbox/ack` (C4-2), but the poll request is also
   * signed and challenge-bound, and carrying it there would keep `inbound.pollProgress.test.ts:248`
   * ("acknowledges nothing" asserted as "no ack REQUEST at all") literally true. Nothing in this
   * file decides that; it accepts either, so a correct implementation of either shape is green.
   */
  const applyReadThrough = (body: RequestBody) => {
    const readThrough = body.read_through;
    if (readThrough === undefined || readThrough === null) return;
    const value = Number(readThrough);
    expect(Number.isSafeInteger(value), "read_through must be the opaque decimal token the relay issued as next_cursor").toBe(true);
    if (value > state.mark) state.mark = value;
  };
  const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(input)).pathname, body = JSON.parse(String(init?.body)) as RequestBody;
    requests.push({ path, body });
    expect(body.recipient_mailbox_id).toBe(mailboxId);
    expect(body.device_id).toBe(owner.record.device_id);
    if (path === "/v1/mailbox/challenge") return response({ challenge_id: randomUUID(), nonce, expires_at_ms: Date.now() + 60000 });
    if (path === "/v1/mailbox/poll") {
      applyReadThrough(body);
      const cursor = body.cursor;
      const resumeAfter = typeof cursor === "string" ? Number(cursor) : state.mark;
      expect(Number.isSafeInteger(resumeAfter), "the cursor must be an opaque decimal token this relay issued").toBe(true);
      const remaining = state.envelopes.filter((envelope) => sequences.get(envelope.envelope_id)! > resumeAfter);
      const page = remaining.slice(0, windowSize);
      const hasMore = remaining.length > page.length;
      const next = page.length > 0 ? String(sequences.get(page[page.length - 1]!.envelope_id)!) : null;
      if (hasMore && next !== null) state.issuedCursors.push(next);
      return response({ envelopes: page, next_cursor: hasMore ? next : null });
    }
    if (path === "/v1/mailbox/ack") {
      applyReadThrough(body);
      const acked = Array.isArray(body.envelope_ids) ? body.envelope_ids as string[] : [];
      state.envelopes = state.envelopes.filter((envelope) => !acked.includes(envelope.envelope_id));
      return response({ acked: acked.length });
    }
    throw new Error("Unexpected recipient request");
  });
  const relay = new RelayClient({ baseUrl: owner.config.relay_url, timeoutMs: 500, fetch: fetcher });
  return {
    requests, state, relay, sequences,
    polls: () => requests.filter(({ path }) => path === "/v1/mailbox/poll"),
    acks: () => requests.filter(({ path }) => path === "/v1/mailbox/ack"),
    ackedIds: () => requests.filter(({ path }) => path === "/v1/mailbox/ack").flatMap(({ body }) => (body.envelope_ids ?? []) as string[]),
    readThroughs: () => requests
      .map(({ body }) => body.read_through).filter((value) => value !== undefined && value !== null).map(String),
  };
}

async function inbound(owner: Local, fake: ReturnType<typeof markedMailbox>) {
  const messenger = await openInboundMessenger({ profileDir: owner.profileDir, environment: owner.environment, relay: fake.relay });
  handles.push(messenger);
  return messenger;
}

describe("a page walk that judged nothing still records what it judged (T5 C4-3)", () => {
  it("raises the typed rejection, acknowledges no envelope and mutates nothing, but advances the read position", async () => {
    const { bob, mallory } = await cast();
    const donor = await send(mallory, bob, "SYNTHETIC_READ_MARK_DONOR");
    // 40 poison at a two-envelope window is 20 pages: more than `maxPollPagesPerPoll` (16), so the
    // first poll hits the liveness valve having judged 32 of them and accepted none.
    const poison = Array.from({ length: 40 }, () => ({ ...donor, envelope_id: randomUUID(), message_id: randomUUID() }));
    const fake = markedMailbox(bob, poison, 2);
    const receiver = await inbound(bob, fake);
    const before = await snapshot(bob);

    await expect(receiver.poll()).rejects.toBeInstanceOf(InboundError);

    // F-012, unchanged. This is the guarantee the change must not spend.
    expect(fake.ackedIds(), "F-012: a batch that accepted nothing acknowledges no envelope, so nothing is deleted and nothing leaves the mailbox").toEqual([]);
    expect(state(fake), "no poison may be removed from the relay's queue").toBe(poison.length);
    expect(await receiver.history({ contactIdentityId: mallory.record.identity_id })).toEqual([]);

    // ...and the judgement is nevertheless durable.
    const readThroughs = fake.readThroughs();
    expect(
      readThroughs.length,
      `the walk judged ${String(fake.polls().length * 2)} permanently unacceptable envelopes across ${String(fake.polls().length)} pages and then reported the rejection, sending no read position at all. ` +
        "Every one of those pages is re-downloaded and re-judged on the next poll, for as long as the poison lives — up to the 168 h retention cap. " +
        "C4-3: `poll()` must advance the mark to the highest sequence on the last page it fully judged and send it with `ackPending()`, INCLUDING on the accept-nothing path that currently re-raises at inbound.ts:127 before `ackPending()` at :128",
    ).toBeGreaterThan(0);

    // Design §4, R-4: the mark may only advance to a position this poll actually received.
    const issued = fake.state.issuedCursors;
    for (const value of readThroughs) {
      expect(
        issued.includes(value),
        `read_through=${value} was never issued by any page of this walk (issued: ${issued.length} tokens). ` +
          "A mark that advances past an envelope the recipient never read skips that envelope permanently (design §4, R-4)",
      ).toBe(true);
    }
    // One page of lag is admitted, and only one: an implementation that presents page k's position
    // on page k+1's request (which costs no extra request and is what makes progress survive a
    // SIGKILL mid-walk - apps/cli/test/e2e/flood-closure.test.ts RED-4) cannot report the LAST page
    // it judged until the next poll. What is not admitted is a mark that crawls: the walk judged
    // every page it received, so the position it reports must cover all but the last of them.
    const highest = Math.max(...readThroughs.map(Number));
    expect(
      highest,
      `the highest read position presented was ${String(highest)} after a walk that judged ${String(issued.length)} pages, the last of which reported position ${issued[issued.length - 1]!}. ` +
        "The mark must cover every page the walk fully judged, allowing at most the final page to be reported by the following poll",
    ).toBeGreaterThanOrEqual(Number(issued[Math.max(0, issued.length - 2)]));

    await receiver.close();
    expect(await snapshot(bob), "F-012: the local store must be byte-identical after a poll that accepted nothing — no history, no session advance, no inbox entry").toEqual(before);
  }, 90000);

  it("resumes the next poll after the pages already judged instead of re-walking them", async () => {
    const { bob, alice, mallory } = await cast();
    const text = "SYNTHETIC_READ_MARK_DELIVERED";
    const donor = await send(mallory, bob, "SYNTHETIC_READ_MARK_DONOR_TWO");
    const poison = Array.from({ length: 40 }, () => ({ ...donor, envelope_id: randomUUID(), message_id: randomUUID() }));
    const legitimate = await send(alice, bob, text);

    const fake = markedMailbox(bob, [...poison, legitimate], 2);
    const receiver = await inbound(bob, fake);

    // Poll 1 walks the valve's worth of pages, judges only poison, and reports the rejection.
    await expect(receiver.poll()).rejects.toBeInstanceOf(InboundError);
    const firstWalkPages = fake.polls().length;

    // Poll 2 is a fresh cursorless walk: `inbound.ts:105` always starts with no cursor, so it is the
    // RELAY that must resume the recipient where it stopped.
    const outcome = await receiver.poll().then(
      (value) => ({ result: value as { received: number }, code: "" }),
      (error: unknown) => ({ result: { received: 0 }, code: error instanceof InboundError ? error.code : "UNKNOWN" }),
    );
    expect(
      outcome.code,
      `the second poll failed with ${outcome.code} after the first poll had already judged ${String(firstWalkPages * 2)} envelopes. ` +
        "It re-walked the same poison from the head, because the first poll sent no read position and a cursorless poll therefore resumes at the head of the mailbox. " +
        "No finite number of polls ever reaches the legitimate envelope behind the flood, which is the T52-F-001 wedge exactly as T55 measured it",
    ).toBe("");
    expect(outcome.result.received, "the legitimate envelope behind the poison must be delivered by the second poll").toBe(1);
    expect(fake.ackedIds()).toEqual([legitimate.envelope_id]);
    expect(await receiver.history({ contactIdentityId: alice.record.identity_id }))
      .toEqual([expect.objectContaining({ messageId: legitimate.message_id, direction: "inbound", plaintext: text })]);

    const totalPages = fake.polls().length;
    expect(
      totalPages,
      `${String(totalPages)} pages were walked in total for a mailbox of ${String(poison.length + 1)} envelopes at a two-envelope window (21 pages of real work), of which the first poll walked ${String(firstWalkPages)}. ` +
        "Total pages across K polls must be O(N), not O(N x K): a second poll that re-walks from the head re-pays for the entire flood every time, which is the unbounded amplification the design refuses to call a closure (§2)",
    ).toBeLessThanOrEqual(26);
  }, 90000);
});

/** How many envelopes the fake relay still holds. */
function state(fake: ReturnType<typeof markedMailbox>) {
  return fake.state.envelopes.length;
}
