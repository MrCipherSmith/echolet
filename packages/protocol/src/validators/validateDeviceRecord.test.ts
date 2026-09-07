import { describe, expect, it } from "vitest";
import { validateDeviceRecord } from "./validateDeviceRecord";
import { validatePreKeyBundle } from "./validatePreKeyBundle";

describe("protocol validators", () => {
  it("accepts a valid device record shape", () => {
    const result = validateDeviceRecord({
      type: "device_record",
      version: 1,
      identity_id: "identity",
      device_id: "8cc8010b-d4a1-4ce7-8203-a8f6b055c1b9",
      device_pubkey: "device-pubkey",
      capabilities: {
        mailbox_poll: true,
      },
      created_at_ms: 1770000000000,
      signature: "signature",
    });

    expect(result.success).toBe(true);
  });

  it("rejects an invalid prekey bundle shape", () => {
    const result = validatePreKeyBundle({
      type: "prekey_bundle",
      version: 1,
      bundle_id: "bf705c17-25fe-44e5-aec2-ef94d8de7796",
      identity_id: "identity",
      device_id: "not-a-uuid",
      device_pubkey: "device-pubkey",
      signed_prekey: {
        key_id: "spk-1",
        public_key: "pub",
        created_at_ms: 1,
        expires_at_ms: 2,
        signature: "signature",
      },
      one_time_prekeys: [],
      created_at_ms: 1770000000000,
      signature: "signature",
    });

    expect(result.success).toBe(false);
  });
});
