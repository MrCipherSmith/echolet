import { describe, expect, it, vi } from "vitest";
import { SignalPreKeyBundleV2Schema } from "@echolet/protocol";
import relayV2Fixtures from "../../../../packages/protocol/src/types/fixtures/relay-v2.json";
import { RelayClient, type RelayError } from "./relayClient";

// T44-001, first flattening. The relay already returns exactly what specification.md:92 requires
// for an exhausted recipient: `404 PREKEY_BUNDLE_UNAVAILABLE`. The transport boundary drops that
// diagnosis because `PREKEY_BUNDLE_UNAVAILABLE` is absent from the `remoteCodes` allowlist, so the
// constructed RelayError carries `remoteCode: undefined` and the CLI classifier has nothing left to
// distinguish an ordinary exhausted prekey from a genuine trust/protocol violation.
//
// The allowlist itself is deliberate and must survive the fix: a relay-chosen code reaches the
// operator's machine-readable error output, so an unrecognised one must still be discarded.

const bundle = SignalPreKeyBundleV2Schema.parse(relayV2Fixtures.valid_publish_request.bundle);
const claim = { claimId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", identityId: bundle.device_record.identity_id, deviceId: null };
const response = (body: unknown, status: number) => new Response(JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json" },
});
const errorBody = (code: string, message: string) => ({ ok: false, error: { code, message } });
const clientFor = (fetch: typeof globalThis.fetch) => new RelayClient({ baseUrl: "http://127.0.0.1:8081", timeoutMs: 100, fetch });

describe("RelayClient preserves the relay's exhausted-prekey diagnosis (T44-001)", () => {
  it("carries PREKEY_BUNDLE_UNAVAILABLE out of a 404 claim rejection without leaking the response message", async () => {
    const secretMarker = "relay-supplied-detail";
    const fetch = vi.fn(async () => response(errorBody("PREKEY_BUNDLE_UNAVAILABLE", secretMarker), 404));

    const error = await clientFor(fetch).claimBundle(claim).catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      code: "RELAY_HTTP_ERROR",
      remoteCode: "PREKEY_BUNDLE_UNAVAILABLE",
      httpStatus: 404,
      retryable: false,
    });
    // Boolean form: never render a relay-controlled message into failure output.
    expect(String(error).includes(secretMarker)).toBe(false);
    expect(JSON.stringify(error).includes(secretMarker)).toBe(false);
  });

  it("still discards an unrecognised relay-chosen error code instead of forwarding it verbatim", async () => {
    const fetch = vi.fn(async () => response(errorBody("NOT_A_DECLARED_RELAY_CODE", "unlisted"), 404));

    const error = await clientFor(fetch).claimBundle(claim).catch((caught: unknown) => caught);

    expect(error).toMatchObject({ code: "RELAY_HTTP_ERROR", httpStatus: 404, retryable: false });
    expect((error as RelayError).remoteCode).toBeUndefined();
  });

  it("keeps the retryable classification of relay-side failures unchanged", async () => {
    const fetch = vi.fn(async () => response(errorBody("INTERNAL_ERROR", "temporary"), 503));

    const error = await clientFor(fetch).claimBundle(claim).catch((caught: unknown) => caught);

    expect(error).toMatchObject({ code: "RELAY_HTTP_ERROR", httpStatus: 503, retryable: true });
  });
});
