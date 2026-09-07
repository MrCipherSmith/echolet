import { describe, expect, it } from "vitest";
import { createIdentityProfile } from "./createIdentityProfile";
import { createSignedPreKeyBundle } from "./createSignedPreKeyBundle";
import { validatePreKeyBundle } from "@echolet/protocol";

describe("createSignedPreKeyBundle", () => {
  it("creates a schema-valid prekey bundle from an identity profile", async () => {
    const profile = await createIdentityProfile({
      seed: "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
      deviceLabel: "mobile-device",
    });

    const bundle = createSignedPreKeyBundle(profile, {
      oneTimePreKeyCount: 3,
      createdAtMs: 1770000000000,
    });

    const result = validatePreKeyBundle(bundle);
    expect(result.success).toBe(true);
    expect(bundle.signed_prekey.public_key).toBe(profile.sessionPubKey);
    expect(bundle.one_time_prekeys).toHaveLength(3);
  });
});
