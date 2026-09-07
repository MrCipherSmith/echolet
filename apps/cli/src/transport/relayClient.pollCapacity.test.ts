import { describe, expect, it, vi } from "vitest";
import type { MailboxEnvelope } from "@echolet/protocol";
import { RelayClient, RelayError } from "./relayClient";

/**
 * RED tests for review finding F-009 (client side).
 *
 * A mailbox filled with maximum-size valid envelopes produces more than the
 * 1 MiB the client accepts (relayClient.ts:86). The relay must bound each poll
 * response with a shared aggregate byte budget and signal that more work
 * remains; the client must forward its configured batch size and must accept
 * that "more remains" signal so repeated polls drain the mailbox instead of
 * rejecting the same batch forever.
 *
 * No plaintext, real ciphertext or key material appears here: envelope payloads
 * are inert padding and only byte counts and identifiers are asserted.
 */

/** The client's hard response bound at relayClient.ts:86. */
const responseByteBound = 1024 * 1024;
/** config.MaxMessageBytes: the largest ciphertext the relay accepts. */
const maxMessageBytes = 262144;
/** Shared cursor width, so the selection loop can reserve room for it. */
const cursorFor = (remaining: number) => `cursor-${String(remaining).padStart(8, "0")}`;

const authorization = {
  recipient_mailbox_id: "mailbox-under-test",
  device_id: "8cc8010b-d4a1-4ce7-8203-a8f6b055c1b9",
  signature: "c2lnbmF0dXJl",
};
const challengeId = "5f0f4a0e-0f7b-4f9b-9f1e-2f3a4b5c6d7e";

/** The poll request the CLI must send once the configured batch size reaches it. */
type PollRequest = Parameters<RelayClient["pollMailbox"]>[0] & { batch_size: number };

const paddedEnvelope = (index: number): MailboxEnvelope => ({
  type: "mailbox_envelope",
  version: 1,
  envelope_id: `7b95a59f-53f2-4d51-8e27-a659cf30${String(index).padStart(4, "0")}`,
  message_id: `09c2b413-41fe-46ac-9a7f-76aa87e1${String(index).padStart(4, "0")}`,
  sender_identity_id: "sender-identity",
  sender_device_id: "7319a570-67c7-4c8b-bb0b-4dcdf41de5ec",
  recipient_identity_id: "recipient-identity",
  recipient_device_id: authorization.device_id,
  recipient_mailbox_id: authorization.recipient_mailbox_id,
  payload_type: "ciphertext_message",
  ciphertext: "A".repeat(maxMessageBytes),
  created_at_ms: 1770000000000,
  expires_at_ms: 1770600000000,
  size_bytes: maxMessageBytes,
});

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

describe("RelayClient mailbox poll capacity (F-009)", () => {
  it("forwards the configured poll batch size to the relay poll request", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return json({ ok: true, data: { envelopes: [], next_cursor: null } });
    });
    const client = new RelayClient({ baseUrl: "http://127.0.0.1:8081", timeoutMs: 500, fetch });

    const request: PollRequest = { ...authorization, challenge_id: challengeId, batch_size: 25 };
    await client.pollMailbox(request);

    expect(bodies[0]).toMatchObject({ batch_size: 25 });
  });

  it("drains a mailbox of maximum-size envelopes across polls without ever accepting an over-limit response", async () => {
    const storedEnvelopes = 9;
    let pending = Array.from({ length: storedEnvelopes }, (_unused, index) => paddedEnvelope(index));
    const responseBytes: number[] = [];

    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      const body = JSON.parse(String(init?.body)) as { batch_size?: number; envelope_ids?: string[] };

      if (path === "/v1/mailbox/ack") {
        const acked = body.envelope_ids ?? [];
        pending = pending.filter((envelope) => !acked.includes(envelope.envelope_id));
        return json({ ok: true, data: { acked: acked.length } });
      }
      if (path !== "/v1/mailbox/poll") throw new Error(`unexpected path ${path}`);

      // A correct relay: honour the requested batch size AND a shared
      // aggregate response-byte budget, but always return at least one
      // envelope so the mailbox can always make progress.
      const requested = Math.min(body.batch_size ?? 100, pending.length);
      const chosen: MailboxEnvelope[] = [];
      for (const envelope of pending.slice(0, requested)) {
        const candidate = JSON.stringify({ ok: true, data: { envelopes: [...chosen, envelope], next_cursor: cursorFor(0) } });
        if (chosen.length > 0 && Buffer.byteLength(candidate) > responseByteBound) break;
        chosen.push(envelope);
      }
      const remaining = pending.length - chosen.length;
      const payload = JSON.stringify({ ok: true, data: { envelopes: chosen, next_cursor: remaining > 0 ? cursorFor(remaining) : null } });
      responseBytes.push(Buffer.byteLength(payload));
      return new Response(payload, { status: 200, headers: { "content-type": "application/json" } });
    });

    const client = new RelayClient({ baseUrl: "http://127.0.0.1:8081", timeoutMs: 5000, fetch });

    const received = new Set<string>();
    let polls = 0;
    for (;;) {
      polls++;
      expect(polls).toBeLessThanOrEqual(storedEnvelopes + 2);

      const request: PollRequest = { ...authorization, challenge_id: challengeId, batch_size: 100 };
      const batch = await client.pollMailbox(request);
      expect(batch.envelopes.length).toBeGreaterThan(0);

      const envelopeIds = batch.envelopes.map((envelope) => envelope.envelope_id);
      for (const id of envelopeIds) received.add(id);
      await client.ackMailbox({ ...authorization, envelope_ids: envelopeIds });

      if (batch.next_cursor === null) break;
    }

    expect(received.size).toBe(storedEnvelopes);
    expect(polls).toBeGreaterThan(1);
    // `responseBytes` is produced by this test's own mock, so on its own this line grades the
    // fixture rather than the client (review finding T38-TP-003 (2)). `responseByteBound` is made
    // load-bearing by the two cases below, which pin that the client really does refuse a
    // response above this bound and really does accept one below it.
    expect(Math.max(...responseBytes)).toBeLessThanOrEqual(responseByteBound);
  });

  /**
   * Repair for review finding T38-TP-003 (2): widening the client's reader bound at
   * relayClient.ts:96 from 1 MiB to 1 GiB previously left this whole file green, because no
   * assertion depended on the bound. These two cases sit on either side of it, so the constant
   * `responseByteBound` now governs a real outcome.
   */
  const pollRequest = (): PollRequest => ({ ...authorization, challenge_id: challengeId, batch_size: 100 });
  const pollResponseOf = (envelopeCount: number) =>
    JSON.stringify({
      ok: true,
      data: {
        envelopes: Array.from({ length: envelopeCount }, (_unused, index) => paddedEnvelope(index)),
        next_cursor: null,
      },
    });

  it("refuses a poll response larger than the client's own response byte bound", async () => {
    const payload = pollResponseOf(5);
    expect(Buffer.byteLength(payload)).toBeGreaterThan(responseByteBound);

    const fetch = vi.fn(async () => new Response(payload, { status: 200, headers: { "content-type": "application/json" } }));
    const client = new RelayClient({ baseUrl: "http://127.0.0.1:8081", timeoutMs: 5000, fetch });

    // Every field of this response is valid; the ONLY reason to refuse it is its size. The refusal
    // is non-retryable, so nothing is acked and the batch stays queued at the relay.
    // The rejection is captured rather than matched inline so that an accepted response reports
    // the missing refusal instead of dumping the whole oversized payload into the failure message.
    const raised = await client.pollMailbox(pollRequest()).then(() => undefined, (error: unknown) => error);
    expect(raised).toBeInstanceOf(RelayError);
    expect(raised).toMatchObject({ code: "INVALID_RELAY_RESPONSE", retryable: false });
  });

  it("accepts a poll response that stays within the client's response byte bound", async () => {
    const payload = pollResponseOf(3);
    expect(Buffer.byteLength(payload)).toBeLessThanOrEqual(responseByteBound);

    const fetch = vi.fn(async () => new Response(payload, { status: 200, headers: { "content-type": "application/json" } }));
    const client = new RelayClient({ baseUrl: "http://127.0.0.1:8081", timeoutMs: 5000, fetch });

    const batch = await client.pollMailbox(pollRequest());

    expect(batch.envelopes).toHaveLength(3);
    expect(batch.next_cursor).toBeNull();
  });
});
