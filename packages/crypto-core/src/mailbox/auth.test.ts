import { describe, expect, it } from "vitest";
import {
  deriveIdentityKeyPairFromSeed,
  signMailboxAckMessage,
  signMailboxCreateChallengeMessage,
  signMailboxChallengeMessage,
  verifyMailboxAckMessage,
  verifyMailboxCreateChallengeMessage,
  verifyMailboxChallengeMessage,
} from "../index";

describe("mailbox auth helpers", () => {
  it("signs and verifies challenge messages", () => {
    const keys = deriveIdentityKeyPairFromSeed(
      "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
      "device:mobile-device",
    );

    const signature = signMailboxChallengeMessage(
      "challenge-1",
      "mailbox-1",
      "device-1",
      "nonce-1",
      keys.secretKey,
    );

    expect(
      verifyMailboxChallengeMessage(
        "challenge-1",
        "mailbox-1",
        "device-1",
        "nonce-1",
        signature,
        keys.publicKey,
      ),
    ).toBe(true);
    expect(
      verifyMailboxChallengeMessage(
        "challenge-1",
        "mailbox-1",
        "device-1",
        "nonce-2",
        signature,
        keys.publicKey,
      ),
    ).toBe(false);
  });

  it("signs and verifies create-challenge messages", () => {
    const keys = deriveIdentityKeyPairFromSeed(
      "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
      "device:mobile-device",
    );

    const signature = signMailboxCreateChallengeMessage(
      "mailbox-1",
      "device-1",
      keys.secretKey,
    );

    expect(
      verifyMailboxCreateChallengeMessage(
        "mailbox-1",
        "device-1",
        signature,
        keys.publicKey,
      ),
    ).toBe(true);
    expect(
      verifyMailboxCreateChallengeMessage(
        "mailbox-2",
        "device-1",
        signature,
        keys.publicKey,
      ),
    ).toBe(false);
  });

  it("normalizes ack envelope order before signing", () => {
    const keys = deriveIdentityKeyPairFromSeed(
      "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
      "device:mobile-device",
    );

    const signature = signMailboxAckMessage(
      "mailbox-1",
      "device-1",
      ["b", "a"],
      keys.secretKey,
    );

    expect(
      verifyMailboxAckMessage(
        "mailbox-1",
        "device-1",
        ["a", "b"],
        signature,
        keys.publicKey,
      ),
    ).toBe(true);
  });
});
