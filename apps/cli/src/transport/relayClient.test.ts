import { describe, expect, it, vi } from "vitest";
import { MailboxEnvelopeSchema, SignalPreKeyBundleV2Schema } from "@echolet/protocol";
import relayV2Fixtures from "../../../../packages/protocol/src/types/fixtures/relay-v2.json";
import { RelayClient } from "./relayClient";

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
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json" },
});

describe("RelayClient strict transport boundary", () => {
  it("sends exact publish, claim, and message requests and validates their success envelopes", async () => {
    const fetch = vi.fn(async (input: string | URL | Request, _init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      // A first publication of a freshly signed bundle: the relay stores it and the bundle is
      // immediately available for a first contact to claim, so `claimable` is true.
      if (path === "/v2/prekeys/publish") return response({ ok: true, data: { stored: true, bundle_id: bundle.bundle_id, claimable: true } });
      if (path === "/v2/prekeys/claim") return response({ ok: true, data: { bundle } });
      if (path === "/v1/messages/send") return response({ ok: true, data: { accepted: true, envelope_id: envelope.envelope_id, status: "relayed" } });
      throw new Error(`unexpected path ${path}`);
    });
    const client = new RelayClient({ baseUrl: "http://127.0.0.1:8081", timeoutMs: 500, fetch });

    await expect(client.publishBundle(bundle)).resolves.toEqual({ stored: true, bundleId: bundle.bundle_id, claimable: true });
    await expect(client.claimBundle({ claimId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", identityId: bundle.device_record.identity_id, deviceId: null })).resolves.toEqual(bundle);
    await expect(client.sendEnvelope(envelope)).resolves.toEqual({ accepted: true, envelopeId: envelope.envelope_id, status: "relayed" });

    expect(fetch.mock.calls.map(([input, init]) => ({
      path: new URL(String(input)).pathname,
      method: init?.method,
      body: JSON.parse(String(init?.body)),
    }))).toEqual([
      { path: "/v2/prekeys/publish", method: "POST", body: { bundle } },
      { path: "/v2/prekeys/claim", method: "POST", body: { claim_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", identity_id: bundle.device_record.identity_id, device_id: null } },
      { path: "/v1/messages/send", method: "POST", body: { envelope } },
    ]);
  });

  it("rejects malformed or contradictory success envelopes", async () => {
    const invalid = [
      { ok: true, data: { stored: "yes", bundle_id: bundle.bundle_id } },
      { ok: true, data: { bundle: { ...bundle, unknown: true } } },
      { ok: true, data: { accepted: true, envelope_id: "different", status: "relayed" } },
      { ok: true, data: { accepted: true, envelope_id: envelope.envelope_id, status: "invented" } },
    ];
    for (const body of invalid) {
      const client = new RelayClient({ baseUrl: "http://127.0.0.1:8081", timeoutMs: 500, fetch: vi.fn(async () => response(body)) });
      const operation = "stored" in (body.data as object)
        ? client.publishBundle(bundle)
        : "bundle" in (body.data as object)
          ? client.claimBundle({ claimId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", identityId: bundle.device_record.identity_id, deviceId: null })
          : client.sendEnvelope(envelope);
      await expect(operation, JSON.stringify(body)).rejects.toMatchObject({ code: "INVALID_RELAY_RESPONSE", retryable: false });
    }
  });

  it("maps timeout, network, and HTTP error envelopes to stable typed errors without leaking request data", async () => {
    const secretMarker = "secret-device-material";
    const cases = [
      {
        fetch: vi.fn(async () => { throw new DOMException(`aborted ${secretMarker}`, "AbortError"); }),
        expected: { code: "RELAY_TIMEOUT", retryable: true },
      },
      {
        fetch: vi.fn(async () => { throw new Error(`socket failed ${secretMarker}`); }),
        expected: { code: "RELAY_UNAVAILABLE", retryable: true },
      },
      {
        fetch: vi.fn(async () => response({ ok: false, error: { code: "BUNDLE_ID_CONFLICT", message: secretMarker } }, 409)),
        expected: { code: "RELAY_HTTP_ERROR", remoteCode: "BUNDLE_ID_CONFLICT", httpStatus: 409, retryable: false },
      },
    ];
    for (const testCase of cases) {
      const client = new RelayClient({ baseUrl: "http://127.0.0.1:8081", timeoutMs: 100, fetch: testCase.fetch });
      const error = await client.publishBundle(bundle).catch((caught: unknown) => caught);
      expect(error).toMatchObject(testCase.expected);
      expect(String(error)).not.toContain(secretMarker);
      expect(JSON.stringify(error)).not.toContain(secretMarker);
      expect(String(error)).not.toContain(bundle.device_record.device_pubkey);
    }
  });
});
