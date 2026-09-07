import { describe, expect, it, vi } from "vitest";
import { MailboxEnvelopeSchema, SignalPreKeyBundleV2Schema } from "@echolet/protocol";
import relayV2Fixtures from "../../../../packages/protocol/src/types/fixtures/relay-v2.json";
import { RelayClient, type RelayError } from "./relayClient";

// RED tests for T53 / finding T52-F-001, at the transport boundary.
//
// T54 adds a per-sender unacked-envelope quota to the relay's /v1/messages/send. When a sender is
// at quota the relay declines the envelope with a bounded 4xx and its own code,
// SENDER_QUOTA_EXCEEDED. The condition is temporary and entirely outside the sender's control - it
// clears when the recipient acknowledges or the envelopes expire - so an operator has to be able to
// tell it apart from a genuine trust or protocol violation.
//
// The transport boundary is where that diagnosis is currently lost: `remoteCodes` in relayClient.ts
// is an allowlist, and a code absent from it is discarded, leaving `remoteCode: undefined` and
// nothing for classify() to report but the generic PROTOCOL_REJECTED. This is exactly the shape of
// the PREKEY_BUNDLE_UNAVAILABLE flattening (T44-001) and of UNAUTHORIZED_MAILBOX_ACCESS (T50-F-002),
// and it must be fixed the same way.
//
// The allowlist itself must survive: a relay-chosen code reaches the operator's machine-readable
// error output, so an unrecognised one still has to be dropped.
//
// No plaintext, ciphertext or relay-supplied message text is ever asserted on or printed.

const bundle = SignalPreKeyBundleV2Schema.parse(relayV2Fixtures.valid_publish_request.bundle);
const envelope = MailboxEnvelopeSchema.parse({
  type: "mailbox_envelope",
  version: 1,
  envelope_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  message_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  sender_identity_id: bundle.device_record.identity_id,
  sender_device_id: bundle.device_record.device_id,
  recipient_identity_id: bundle.device_record.identity_id,
  recipient_device_id: bundle.device_record.device_id,
  recipient_mailbox_id: "mailbox",
  payload_type: "ciphertext_message",
  ciphertext: "ciphertext",
  created_at_ms: relayV2Fixtures.now_ms,
  expires_at_ms: relayV2Fixtures.now_ms + 60_000,
  size_bytes: 10,
});

const response = (body: unknown, status: number) => new Response(JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json" },
});
const errorBody = (code: string, message: string) => ({ ok: false, error: { code, message } });
const clientFor = (fetch: typeof globalThis.fetch) => new RelayClient({ baseUrl: "http://127.0.0.1:8081", timeoutMs: 100, fetch });

describe("RelayClient preserves the relay's per-sender quota diagnosis (T52-F-001)", () => {
  it("carries SENDER_QUOTA_EXCEEDED out of a bounded 4xx send rejection without leaking the response message", async () => {
    const secretMarker = "relay-supplied-quota-detail";
    const fetch = vi.fn(async () => response(errorBody("SENDER_QUOTA_EXCEEDED", secretMarker), 403));

    const error = await clientFor(fetch).sendEnvelope(envelope).catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      code: "RELAY_HTTP_ERROR",
      remoteCode: "SENDER_QUOTA_EXCEEDED",
      httpStatus: 403,
      // Non-retryable: only the recipient can clear the condition, so blind retries are wrong, and
      // `retryable` is also what decides whether classify() keeps the code at all.
      retryable: false,
    });
    // Boolean form: never render a relay-controlled message into failure output.
    expect(String(error).includes(secretMarker)).toBe(false);
    expect(JSON.stringify(error).includes(secretMarker)).toBe(false);
  });

  it("still discards an unrecognised relay-chosen error code instead of forwarding it verbatim", async () => {
    const fetch = vi.fn(async () => response(errorBody("NOT_A_DECLARED_RELAY_CODE", "unlisted"), 403));

    const error = await clientFor(fetch).sendEnvelope(envelope).catch((caught: unknown) => caught);

    expect(error).toMatchObject({ code: "RELAY_HTTP_ERROR", httpStatus: 403, retryable: false });
    expect((error as RelayError).remoteCode).toBeUndefined();
  });

  it("keeps 429 and 5xx classified as retryable, which is why the quota must not be answered with 429", async () => {
    // Documented here so the relay side cannot quietly choose 429 for the quota: a 429 is retryable,
    // and classify() maps every retryable RelayError to RELAY_UNAVAILABLE (exit 4) WITHOUT reading
    // remoteCode - so the diagnosis would be discarded and the sender would retry a condition only
    // the recipient can clear. The Go half of this constraint is pinned in
    // apps/relay/internal/api/handler/mailbox_sender_quota_test.go.
    const rateLimited = await clientFor(vi.fn(async () => response(errorBody("RATE_LIMITED", "slow down"), 429)))
      .sendEnvelope(envelope).catch((caught: unknown) => caught);
    expect(rateLimited).toMatchObject({ code: "RELAY_HTTP_ERROR", httpStatus: 429, retryable: true });

    const unavailable = await clientFor(vi.fn(async () => response(errorBody("INTERNAL_ERROR", "temporary"), 503)))
      .sendEnvelope(envelope).catch((caught: unknown) => caught);
    expect(unavailable).toMatchObject({ code: "RELAY_HTTP_ERROR", httpStatus: 503, retryable: true });
  });
});
