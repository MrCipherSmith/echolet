import { describe, expect, it } from "vitest";
import { createIdentityProfile } from "./createIdentityProfile";

describe("createIdentityProfile", () => {
  it("derives the same identity and device keys from the same seed", async () => {
    const seed =
      "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

    const first = await createIdentityProfile({
      seed,
      suffix: "SKY",
      deviceLabel: "mobile-device",
    });
    const second = await createIdentityProfile({
      seed,
      suffix: "ALT",
      deviceLabel: "mobile-device",
    });

    expect(second.identityId).toBe(first.identityId);
    expect(second.deviceId).toBe(first.deviceId);
    expect(second.devicePubKey).toBe(first.devicePubKey);
    expect(second.sessionPubKey).toBe(first.sessionPubKey);
    expect(second.seed).toBe(seed);
    expect(first.callsign).not.toBe(second.callsign);
  });
});
