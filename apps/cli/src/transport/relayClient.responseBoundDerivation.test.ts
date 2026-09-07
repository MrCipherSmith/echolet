import { describe, expect, it, vi } from "vitest";
import { LIMITS, type MailboxEnvelope } from "@echolet/protocol";
import { RelayClient, RelayError } from "./relayClient";

/**
 * RED test for residual RI-09, CLIENT half (flow 003 T10; finding T8-F-001).
 *
 * Its sibling `relayClient.sizeSymmetry.test.ts` pins the CONSEQUENCE - a client
 * that will post an envelope must be able to poll it back - without naming where
 * the maximum message size comes from, so that it cannot pre-decide the fix.
 * This one pins the MECHANISM the relay-side test needs in order to go green:
 * the client's response bound must be a FUNCTION of the maximum message size,
 * not an independent literal.
 *
 * WHY THE MECHANISM HAS TO BE PINNED SEPARATELY. The relay-side RED test
 * (mailbox_poll_byte_budget_derivation_test.go) admits two answers, and finding
 * T8-F-001 has already established that one of them is unavailable: refusing an
 * over-large ciphertext at /v1/messages/send collides with
 * TestSendEnvelopeBodyLimitIsDerivedFromMaxMessageBytes, which pins acceptance of
 * an envelope of exactly ECHOLET_MAX_MESSAGE_BYTES at the same 2 MiB. So the only
 * answer left for the relay is that a poll response carrying a maximum-size
 * envelope must be one the client accepts - which is a statement about THIS
 * client's bound, and is false for every maximum above ~1 MiB while
 * relayClient.ts:144 reads `size > 1024 * 1024`.
 *
 * WHAT IS ASSERTED, AND WHY IT IS NOT "2 MiB INSTEAD OF 1 MiB". Two things
 * together, and neither is a constant:
 *
 *   1. a poll response carrying exactly ONE envelope of the maximum message size
 *      is accepted - so the bound is at least as large as the largest single
 *      thing the relay is allowed to store for this recipient; and
 *   2. a response far above that is STILL refused, non-retryably - so the bound
 *      has not simply been deleted, and the client is still protected from an
 *      unbounded relay response.
 *
 * Replacing the literal 1 MiB with a literal 2 MiB satisfies neither: it fails
 * (1) at any larger configured maximum, and it is exactly the "move the defect"
 * outcome this pair of assertions exists to refuse.
 *
 * WHERE THE MAXIMUM COMES FROM - ESTABLISHED, NOT INVENTED. Read on the current
 * tree (T10 analysis, t10-size-derivation-analysis.md):
 *
 *   - the client's bound is COMPILED IN. `RelayClient`'s constructor takes only
 *     `{ baseUrl, timeoutMs, fetch }` and the CLI profile schema
 *     (`runtime/config.ts`) has no size field at all, so nothing an operator can
 *     set reaches relayClient.ts:144 today;
 *   - a shared protocol constant DOES already exist - `LIMITS.MAX_MESSAGE_BYTES`
 *     in `packages/protocol/src/constants/limits.ts`, 262144, the same number as
 *     `ECHOLET_MAX_MESSAGE_BYTES`'s default and as the relay's own
 *     `defaultMaxMessageBytes` (request_body.go:26) - but it is exported and
 *     consumed by NOTHING. The shared notion is present in the tree and
 *     triplicated by hand rather than absent;
 *   - the relay does NOT advertise its configured maximum anywhere on the wire.
 *     No response field, no limits endpoint. Making the client track a maximum
 *     an operator raised per-deployment therefore requires a wire change, which
 *     this test does not invent and must not pre-empt.
 *
 * So this test supplies the raised maximum through BOTH seams that exist without
 * a wire change - the shared protocol constant, mocked, and a constructor option -
 * and asserts only on the behaviour. It does not care which of the two the
 * implementer wires up; it cares that ONE of them reaches the bound. If the
 * closure chosen is instead a relay-advertised maximum (a wire change), the
 * plumbing in `clientAtRaisedMaximum` is the part that changes and the two
 * assertions are the part that must not.
 *
 * No plaintext, ciphertext, key material or request body is printed. Envelope
 * payloads are inert padding and only byte counts and error codes reach failure
 * output.
 */

/** The operator action RI-09 describes: ECHOLET_MAX_MESSAGE_BYTES raised to 2 MiB. */
const { raisedMaxMessageBytes } = vi.hoisted(() => ({ raisedMaxMessageBytes: 2 * 1024 * 1024 }));

// Seam 1: the shared protocol constant. Mocked rather than edited, because
// packages/protocol is production code and this task writes tests only.
vi.mock("@echolet/protocol", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@echolet/protocol")>();
  return { ...actual, LIMITS: { ...actual.LIMITS, MAX_MESSAGE_BYTES: raisedMaxMessageBytes } };
});

/**
 * How many maximum-size envelopes must STILL be refused. A derivation that
 * carries one maximum-size envelope plus the response wrapper is what assertion
 * (1) asks for; the relay's own aggregate poll budget at the default is 1 MiB =
 * 4 x 262144 (mailbox_handler.go:67), so eight of them is far outside any
 * derivation that keeps a poll response bounded at all, and a bound that admits
 * ~16 MB of relay-chosen response is a bound that has been removed.
 */
const refusedEnvelopeCount = 8;

const authorization = {
  recipient_mailbox_id: "mailbox-under-test",
  device_id: "8cc8010b-d4a1-4ce7-8203-a8f6b055c1b9",
  signature: "c2lnbmF0dXJl",
};
const challengeId = "5f0f4a0e-0f7b-4f9b-9f1e-2f3a4b5c6d7e";
const pollRequest = () => ({ ...authorization, challenge_id: challengeId, batch_size: 100 });

const paddedEnvelope = (index: number, ciphertextBytes: number): MailboxEnvelope => ({
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
  ciphertext: "A".repeat(ciphertextBytes),
  created_at_ms: 1770000000000,
  expires_at_ms: 1770600000000,
  size_bytes: ciphertextBytes,
});

const pollResponseOf = (envelopeCount: number, ciphertextBytes: number) =>
  JSON.stringify({
    ok: true,
    data: {
      envelopes: Array.from({ length: envelopeCount }, (_unused, index) => paddedEnvelope(index, ciphertextBytes)),
      next_cursor: null,
    },
  });

/**
 * Seam 2: a constructor option carrying the same maximum. `RelayClient` already
 * receives its other operational bound (`timeoutMs`) this way, so this is the
 * smallest surface a configured maximum could arrive through. The assertion is
 * cast rather than typed because the option does not exist yet - an implementer
 * who closes this through the shared constant instead may leave it unused, and
 * an implementer who closes it through configuration may name it differently;
 * either way the client is told the same number.
 */
const clientAtRaisedMaximum = (fetch: typeof globalThis.fetch) =>
  new RelayClient({
    baseUrl: "http://127.0.0.1:8081",
    timeoutMs: 20_000,
    fetch,
    maxMessageBytes: raisedMaxMessageBytes,
  } as ConstructorParameters<typeof RelayClient>[0]);

describe("RelayClient response bound derivation (RI-09)", () => {
  it("derives its response bound from the maximum message size instead of a fixed literal", async () => {
    // Precondition, not the property: if the seam were not live the test would still be red, and
    // would be red for the wrong reason. This proves the raised maximum really does reach the
    // module under test.
    expect(LIMITS.MAX_MESSAGE_BYTES).toBe(raisedMaxMessageBytes);

    const deliverable = pollResponseOf(1, raisedMaxMessageBytes);
    const deliverableBytes = Buffer.byteLength(deliverable);
    const deliverableFetch = vi.fn(async () => new Response(deliverable, { status: 200, headers: { "content-type": "application/json" } }));

    // (1) One envelope of exactly the configured maximum - the largest single thing the relay may
    // hold for this recipient, and the one thing a poll MUST be able to carry, because the relay
    // has already accepted it (TestSendEnvelopeBodyLimitIsDerivedFromMaxMessageBytes) and no relay
    // fix can shrink it (finding T8-F-001).
    const accepted = await clientAtRaisedMaximum(deliverableFetch).pollMailbox(pollRequest())
      .then((batch) => ({ refused: false as const, batch }), (error: unknown) => ({ refused: true as const, error }));

    if (accepted.refused) {
      if (!(accepted.error instanceof RelayError)) throw accepted.error;
      const refusal = accepted.error;
      expect.fail(
        `with the maximum message size raised to ${raisedMaxMessageBytes} the client refused a ${deliverableBytes}-byte ` +
          `poll response carrying exactly one envelope of that size (${refusal.code}, retryable=${refusal.retryable}). ` +
          `The bound at relayClient.ts:144 is the literal 1024 * 1024 and is independent of the maximum, so every ` +
          `maximum-size envelope the relay accepts above ~1 MiB is refused here, is never acknowledged, and leaves the ` +
          `mailbox undeliverable. The bound must be derived from the same maximum the relay is configured with - ` +
          `raising the literal is not a fix, which is what the second half of this test pins`,
      );
      return;
    }
    expect(accepted.batch.envelopes).toHaveLength(1);

    // (2) The bound must still BE a bound. A response far beyond one maximum-size envelope is still
    // refused, and still non-retryably, so that deleting the check at relayClient.ts:144 - which
    // would satisfy (1) on its own - does not pass for a fix.
    const oversized = pollResponseOf(refusedEnvelopeCount, raisedMaxMessageBytes);
    const oversizedBytes = Buffer.byteLength(oversized);
    const oversizedFetch = vi.fn(async () => new Response(oversized, { status: 200, headers: { "content-type": "application/json" } }));

    const refused = await clientAtRaisedMaximum(oversizedFetch).pollMailbox(pollRequest()).then(() => undefined, (error: unknown) => error);

    expect(refused, `a ${oversizedBytes}-byte poll response (${refusedEnvelopeCount} maximum-size envelopes) was accepted; the response bound must scale with the maximum, not disappear`).toBeInstanceOf(RelayError);
    expect(refused).toMatchObject({ code: "INVALID_RELAY_RESPONSE", retryable: false });
  });
});
