import { createHash } from "crypto";
import { encodeBase64Url } from "../encoding/base64url";
import { signUtf8Message, verifyUtf8Message } from "../signatures/sign";

export function createMailboxChallengeMessage(
  challengeId: string,
  recipientMailboxId: string,
  deviceId: string,
  nonce: string,
): string {
  return `echolet-mailbox-challenge:v1:${challengeId}:${recipientMailboxId}:${deviceId}:${nonce}`;
}

export function createMailboxCreateChallengeMessage(
  recipientMailboxId: string,
  deviceId: string,
): string {
  return `echolet-mailbox-create-challenge:v1:${recipientMailboxId}:${deviceId}`;
}

export function createMailboxAckMessage(
  recipientMailboxId: string,
  deviceId: string,
  envelopeIds: string[],
): string {
  const normalizedEnvelopeIds = [...envelopeIds].sort().join(",");
  return `echolet-mailbox-ack:v1:${recipientMailboxId}:${deviceId}:${normalizedEnvelopeIds}`;
}

export function signMailboxChallengeMessage(
  challengeId: string,
  recipientMailboxId: string,
  deviceId: string,
  nonce: string,
  deviceSecretKey: string,
): string {
  return signUtf8Message(
    createMailboxChallengeMessage(
      challengeId,
      recipientMailboxId,
      deviceId,
      nonce,
    ),
    deviceSecretKey,
  );
}

export function signMailboxCreateChallengeMessage(
  recipientMailboxId: string,
  deviceId: string,
  deviceSecretKey: string,
): string {
  return signUtf8Message(
    createMailboxCreateChallengeMessage(recipientMailboxId, deviceId),
    deviceSecretKey,
  );
}

export function verifyMailboxChallengeMessage(
  challengeId: string,
  recipientMailboxId: string,
  deviceId: string,
  nonce: string,
  signature: string,
  devicePublicKey: string,
): boolean {
  return verifyUtf8Message(
    createMailboxChallengeMessage(
      challengeId,
      recipientMailboxId,
      deviceId,
      nonce,
    ),
    signature,
    devicePublicKey,
  );
}

export function verifyMailboxCreateChallengeMessage(
  recipientMailboxId: string,
  deviceId: string,
  signature: string,
  devicePublicKey: string,
): boolean {
  return verifyUtf8Message(
    createMailboxCreateChallengeMessage(recipientMailboxId, deviceId),
    signature,
    devicePublicKey,
  );
}

export function signMailboxAckMessage(
  recipientMailboxId: string,
  deviceId: string,
  envelopeIds: string[],
  deviceSecretKey: string,
): string {
  return signUtf8Message(
    createMailboxAckMessage(recipientMailboxId, deviceId, envelopeIds),
    deviceSecretKey,
  );
}

export function verifyMailboxAckMessage(
  recipientMailboxId: string,
  deviceId: string,
  envelopeIds: string[],
  signature: string,
  devicePublicKey: string,
): boolean {
  return verifyUtf8Message(
    createMailboxAckMessage(recipientMailboxId, deviceId, envelopeIds),
    signature,
    devicePublicKey,
  );
}

/**
 * Binds an envelope's payload into the sender transcript by digest rather than inline, so the
 * signed string stays a few hundred bytes for a 256 KiB ciphertext while still pinning the exact
 * payload bytes. Raw base64url of SHA-256 over the ciphertext's UTF-8 bytes; the relay reproduces
 * it with base64.RawURLEncoding over sha256.Sum256([]byte(ciphertext)).
 */
export function hashMailboxEnvelopeCiphertext(ciphertext: string): string {
  return encodeBase64Url(createHash("sha256").update(ciphertext, "utf8").digest());
}

/**
 * The transcript `/v1/messages/send` authenticates a sender with (T50, finding T49-F-001).
 *
 * It binds where the envelope lands, which envelope it is, who it claims to be from, what it
 * contains and how long it occupies the mailbox - every input to the mailbox-flooding capability
 * T49 measured. The relay reproduces this string byte for byte in Go and verifies it against the
 * sender's already-published, root-signed DeviceRecord, so the format is a wire contract: change it
 * only by minting a new version prefix on both sides together.
 */
export function createMailboxEnvelopeMessage(
  recipientMailboxId: string,
  envelopeId: string,
  senderIdentityId: string,
  senderDeviceId: string,
  ciphertextDigest: string,
  createdAtMs: number,
  expiresAtMs: number,
): string {
  return `echolet-mailbox-envelope:v1:${recipientMailboxId}:${envelopeId}:${senderIdentityId}:${senderDeviceId}:${ciphertextDigest}:${createdAtMs}:${expiresAtMs}`;
}

export function signMailboxEnvelopeMessage(
  recipientMailboxId: string,
  envelopeId: string,
  senderIdentityId: string,
  senderDeviceId: string,
  ciphertextDigest: string,
  createdAtMs: number,
  expiresAtMs: number,
  deviceSecretKey: Uint8Array | string,
): string {
  return signUtf8Message(
    createMailboxEnvelopeMessage(
      recipientMailboxId,
      envelopeId,
      senderIdentityId,
      senderDeviceId,
      ciphertextDigest,
      createdAtMs,
      expiresAtMs,
    ),
    deviceSecretKey,
  );
}

export function verifyMailboxEnvelopeMessage(
  recipientMailboxId: string,
  envelopeId: string,
  senderIdentityId: string,
  senderDeviceId: string,
  ciphertextDigest: string,
  createdAtMs: number,
  expiresAtMs: number,
  signature: string,
  devicePublicKey: Uint8Array | string,
): boolean {
  return verifyUtf8Message(
    createMailboxEnvelopeMessage(
      recipientMailboxId,
      envelopeId,
      senderIdentityId,
      senderDeviceId,
      ciphertextDigest,
      createdAtMs,
      expiresAtMs,
    ),
    signature,
    devicePublicKey,
  );
}
