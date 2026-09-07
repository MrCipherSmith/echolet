import { describe, expect, it, vi } from "vitest";
import { SignalPreKeyBundleV2Schema } from "@echolet/protocol";
import relayV2Fixtures from "../../../../packages/protocol/src/types/fixtures/relay-v2.json";
import { RelayClient } from "./relayClient";

// T46 — `claimable` is part of the publish response contract, not an extra.
//
// T44-002 gave `relay publish` a claimability signal because a successful publish response was
// otherwise byte-identical on the relay's fresh-store and idempotent re-store paths: only the relay
// knows whether the stored bundle is still available for a first contact to claim. The Go handler
// therefore always emits the field, and always as a boolean.
//
// The CLI schema declared it `z.boolean().optional()`, which is a hole in a `.strict()` object: a
// publish response that omits `claimable` parses successfully, `publishBundle()` returns the key as
// `undefined`, and `relay publish` silently drops the very signal T44-002 added — reporting a
// no-op republish as plain success again. A schema may be widened to accept what the relay really
// sends; it may not be loosened to accept a response the relay never sends.
//
// The first test below is RED until `claimableSchema` in `relayClient.ts` becomes a required
// `z.boolean()`. The rest are green guards on both sides of that one-line change: the field stays
// closed (boolean only, never a string, never null), both values survive the transport intact, and
// the response object still refuses unknown keys.

const bundle = SignalPreKeyBundleV2Schema.parse(relayV2Fixtures.valid_publish_request.bundle);
const response = (body: unknown) => new Response(JSON.stringify(body), {
  status: 200,
  headers: { "content-type": "application/json" },
});
const publishing = (data: Record<string, unknown>) => new RelayClient({
  baseUrl: "http://127.0.0.1:8081",
  timeoutMs: 500,
  fetch: vi.fn(async () => response({ ok: true, data })),
}).publishBundle(bundle);

describe("RelayClient requires the relay's claimability answer on a publish success (T46)", () => {
  it("rejects a publish success envelope that omits claimable", async () => {
    // RED: with `claimable: z.boolean().optional()` this envelope parses and the promise resolves
    // to `{ stored: true, bundleId, claimable: undefined }`, so the rejection assertion fails.
    await expect(publishing({ stored: true, bundle_id: bundle.bundle_id }))
      .rejects.toMatchObject({ code: "INVALID_RELAY_RESPONSE", retryable: false });
  });

  it("carries both claimability answers through the transport unchanged", async () => {
    await expect(publishing({ stored: true, bundle_id: bundle.bundle_id, claimable: true }))
      .resolves.toEqual({ stored: true, bundleId: bundle.bundle_id, claimable: true });
    // `false` is the case T44-002 exists for: stored, but the bundle was already consumed, so the
    // republish restored nothing. It must never be lost or coerced on the way out.
    await expect(publishing({ stored: true, bundle_id: bundle.bundle_id, claimable: false }))
      .resolves.toEqual({ stored: true, bundleId: bundle.bundle_id, claimable: false });
  });

  it("keeps claimable closed to anything that is not a boolean, and the envelope closed to unknown keys", async () => {
    const rejected: Array<Record<string, unknown>> = [
      { stored: true, bundle_id: bundle.bundle_id, claimable: "true" },
      { stored: true, bundle_id: bundle.bundle_id, claimable: null },
      { stored: true, bundle_id: bundle.bundle_id, claimable: 1 },
      { stored: true, bundle_id: bundle.bundle_id, claimable: true, unexpected: true },
    ];
    for (const data of rejected) {
      await expect(publishing(data), JSON.stringify(Object.keys(data)))
        .rejects.toMatchObject({ code: "INVALID_RELAY_RESPONSE", retryable: false });
    }
  });
});
