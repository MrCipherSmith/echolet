import { describe, expect, it, vi } from "vitest";
import type { MailboxEnvelope } from "@echolet/protocol";
import { RelayClient, RelayError } from "./relayClient";

/**
 * RED test for residual RI-09, CLIENT half (flow 003 T10; finding T8-F-001).
 *
 * RI-09 is a relationship between two numbers that nothing keeps in agreement:
 *
 *   apps/relay/internal/config/config.go:37   MaxMessageBytes `env:"ECHOLET_MAX_MESSAGE_BYTES" envDefault:"262144"`
 *   apps/cli/src/transport/relayClient.ts:144 if (size > 1024 * 1024) { ... throw invalid(); }
 *
 * The relay accepts a ciphertext of exactly its configured maximum (pinned by
 * TestSendEnvelopeBodyLimitIsDerivedFromMaxMessageBytes, mailbox_poll_capacity_test.go:200).
 * The client's response bound is a compile-time literal that knows nothing about
 * that maximum. Measured by T8 at ECHOLET_MAX_MESSAGE_BYTES = 2 MiB: the relay
 * accepted a maximum-size envelope and answered the poll with 2 097 917 bytes,
 * above the 1 048 576 this client enforces, so the whole batch is refused,
 * nothing in it is ever acknowledged, and the mailbox is silently undeliverable.
 *
 * WHY THIS TEST NEEDS NO NEW SURFACE AT ALL. Every other way of stating the
 * property has to tell the client what the maximum is, which means picking a
 * plumbing (a config field, a shared constant, or a relay-advertised value) and
 * so pre-deciding the fix. This one does not: it asks only that the client's two
 * opinions about size agree with each other. The client is willing to SERIALIZE
 * AND POST an envelope of a given ciphertext size - it applies no send-side
 * bound whatsoever - and then refuses to READ that same envelope back. Whatever
 * the maximum turns out to be and wherever it comes from, a client that will put
 * an envelope into a mailbox must be a client that can take it out again.
 *
 * WHAT IS AND IS NOT PINNED. Like the relay-side test it partners
 * (mailbox_poll_byte_budget_derivation_test.go), this deliberately allows EITHER
 * coherent answer and the choice belongs to the implementer:
 *
 *   (a) the receive side is made to fit the send side - the response bound moves
 *       with the maximum message size, so the envelope comes back; or
 *   (b) the send side is made to fit the receive side - the client refuses,
 *       locally and non-retryably, to post a ciphertext it could never poll back,
 *       without putting it on the wire.
 *
 * What it refuses is exactly today's behaviour: post it, then throw away the
 * response that returns it. Note that (b) is available to the CLIENT even though
 * the equivalent is NOT available to the relay - refusing at /v1/messages/send
 * collides with the acceptance pin named above (finding T8-F-001) - because
 * nothing pins the client's willingness to send an arbitrarily large ciphertext.
 *
 * The 2 MiB used here is the operator action RI-09 describes, not an asserted
 * value: the only property that matters is that it is above the literal at
 * relayClient.ts:144, and no assertion anywhere reads it as a bound.
 *
 * No plaintext, ciphertext, key material or request body is printed. Envelope
 * payloads are inert padding and only byte counts, error codes and envelope
 * identifiers reach failure output.
 */

/**
 * A ciphertext size above the literal response bound at relayClient.ts:144 -
 * ECHOLET_MAX_MESSAGE_BYTES raised to 2 MiB, the configuration T8 measured.
 */
const raisedCiphertextBytes = 2 * 1024 * 1024;

const authorization = {
  recipient_mailbox_id: "mailbox-under-test",
  device_id: "8cc8010b-d4a1-4ce7-8203-a8f6b055c1b9",
  signature: "c2lnbmF0dXJl",
};
const challengeId = "5f0f4a0e-0f7b-4f9b-9f1e-2f3a4b5c6d7e";
const pollRequest = () => ({ ...authorization, challenge_id: challengeId, batch_size: 100 });

const paddedEnvelope = (ciphertextBytes: number): MailboxEnvelope => ({
  type: "mailbox_envelope",
  version: 1,
  envelope_id: "7b95a59f-53f2-4d51-8e27-a659cf300001",
  message_id: "09c2b413-41fe-46ac-9a7f-76aa87e10001",
  sender_identity_id: "sender-identity",
  sender_device_id: "7319a570-67c7-4c8b-bb0b-4dcdf41de5ec",
  recipient_identity_id: "recipient-identity",
  recipient_device_id: authorization.device_id,
  recipient_mailbox_id: authorization.recipient_mailbox_id,
  payload_type: "ciphertext_message",
  ciphertext: "A".repeat(ciphertextBytes),
  created_at_ms: 1770000000000,
  expires_at_ms: 1770600000000,
  size_bytes: ciphertextBytes,
});

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

describe("RelayClient send/receive size symmetry (RI-09)", () => {
  it("must not accept sending an envelope whose poll response it will refuse", async () => {
    const envelope = paddedEnvelope(raisedCiphertextBytes);
    const paths: string[] = [];
    let pollResponseBytes = 0;

    const fetch = vi.fn(async (input: string | URL | Request) => {
      const path = new URL(String(input)).pathname;
      paths.push(path);
      if (path === "/v1/messages/send") {
        return json({ ok: true, data: { accepted: true, envelope_id: envelope.envelope_id, status: "relayed" } });
      }
      if (path === "/v1/mailbox/poll") {
        const payload = JSON.stringify({ ok: true, data: { envelopes: [envelope], next_cursor: null } });
        pollResponseBytes = Buffer.byteLength(payload);
        return new Response(payload, { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error(`unexpected path ${path}`);
    });

    const client = new RelayClient({ baseUrl: "http://127.0.0.1:8081", timeoutMs: 20_000, fetch });

    // The outcomes are captured rather than matched inline so that a failure reports a code and a
    // byte count instead of dumping a multi-megabyte envelope into the diff.
    const sent = await client.sendEnvelope(envelope).then(() => ({ refused: false as const }), (error: unknown) => ({ refused: true as const, error }));

    if (sent.refused) {
      // Answer (b): the client declined to put an envelope on the wire that it could never poll
      // back. Coherent - but it has to be a local, non-retryable refusal, and nothing may have
      // been posted, or the envelope is in the mailbox anyway and the mailbox is still stuck.
      expect(sent.error).toBeInstanceOf(RelayError);
      expect(sent.error).toMatchObject({ retryable: false });
      expect(paths).not.toContain("/v1/messages/send");
      return;
    }

    // Answer (a): the client posted the envelope, so it has undertaken to be able to read it back.
    const polled = await client.pollMailbox(pollRequest()).then((batch) => ({ refused: false as const, batch }), (error: unknown) => ({ refused: true as const, error }));

    if (polled.refused) {
      if (!(polled.error instanceof RelayError)) throw polled.error;
      const refusal = polled.error;
      expect.fail(
        `the client serialized and posted an envelope whose ciphertext is ${raisedCiphertextBytes} bytes and then ` +
          `refused the ${pollResponseBytes}-byte poll response carrying that same envelope back (${refusal.code}, ` +
          `retryable=${refusal.retryable}). The refusal is non-retryable, so nothing in the batch is ever acknowledged ` +
          `and the mailbox cannot drain. The response bound at relayClient.ts:144 is the literal 1024 * 1024 with no ` +
          `relation to the maximum message size the relay is configured with, while this client applies no send-side ` +
          `bound at all; the two opinions must agree. Either the bound moves with the configured maximum, or the ` +
          `client refuses the send locally before it reaches the wire`,
      );
      return;
    }

    expect(polled.batch.envelopes.map((returned) => returned.envelope_id)).toContain(envelope.envelope_id);
  });
});
