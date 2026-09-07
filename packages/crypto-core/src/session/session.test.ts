import { describe, expect, it } from "vitest";
import nacl from "tweetnacl";
import {
  createInboundSession,
  createOutboundSession,
  decryptMessage,
  encryptMessage,
} from "./session";

describe("session encryption", () => {
  it("encrypts and decrypts using paired X25519 bootstrap keys", () => {
    const alice = nacl.box.keyPair();
    const bob = nacl.box.keyPair();

    const { sessionState: outbound } = createOutboundSession(
      "alice-identity",
      "alice-device",
      "bob-identity",
      "bob-device",
      bob.publicKey,
      alice.secretKey,
    );
    const inbound = createInboundSession(
      "bob-identity",
      "bob-device",
      "alice-identity",
      "alice-device",
      bob.secretKey,
      alice.publicKey,
    );

    const { ciphertext, updatedSession: updatedOutbound } = encryptMessage(
      outbound,
      "hello echolet",
    );
    const { plaintext, updatedSession: updatedInbound } = decryptMessage(
      inbound,
      ciphertext,
    );

    expect(plaintext).toBe("hello echolet");
    expect(updatedOutbound.counter).toBe(1);
    expect(updatedInbound.counter).toBe(1);
  });
});
