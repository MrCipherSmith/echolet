import { createHash } from "crypto";
import { encodeBase64Url } from "../encoding/base64url";
import { signUtf8Message, verifyUtf8Message } from "../signatures/sign";

/**
 * The transcript `/v1/mailbox/poll` authenticates a recipient with.
 *
 * `readThrough` is the recipient's durable read position — the highest
 * relay-assigned position it has JUDGED, committed or permanently refused — and it
 * is optional because it is absent on the first page of every walk. When it is
 * present the transcript is a DIFFERENT string (`:v2:`, with the position
 * appended), so a poll that reports a position cannot be reshaped into one that
 * reports a different position, or none, under the same signature.
 *
 * Why it is bound at all: once a cursorless poll resumes at the stored mark
 * instead of at the head of the mailbox, a value that advances the mark past an
 * envelope makes that envelope unreachable for the rest of its lifetime (T5
 * design §4, R-4). A field with that power belongs inside the signature.
 *
 * Why v1 must keep existing rather than simply growing a field: an absent read
 * position and an empty one have to be different signed statements, and every
 * pre-existing signer and verifier of the four-argument form stays correct.
 *
 * The Go twin is `cryptoutil.CreateMailboxChallengeMessage` /
 * `CreateMailboxChallengeMessageV2` (apps/relay/internal/cryptoutil/signatures.go).
 * Both strings are pinned literally in both languages and the relay rebuilds them
 * byte for byte, so the two halves are a wire contract: change one only by minting
 * a new version prefix in both languages together.
 */
export function createMailboxChallengeMessage(
  challengeId: string,
  recipientMailboxId: string,
  deviceId: string,
  nonce: string,
  readThrough?: string,
): string {
  if (readThrough === undefined) {
    return `echolet-mailbox-challenge:v1:${challengeId}:${recipientMailboxId}:${deviceId}:${nonce}`;
  }
  return `echolet-mailbox-challenge:v2:${challengeId}:${recipientMailboxId}:${deviceId}:${nonce}:${readThrough}`;
}

export function createMailboxCreateChallengeMessage(
  recipientMailboxId: string,
  deviceId: string,
): string {
  return `echolet-mailbox-create-challenge:v1:${recipientMailboxId}:${deviceId}`;
}

/**
 * The transcript `/v1/mailbox/ack` authenticates a recipient with.
 *
 * The ids are sorted before signing, so a recipient and a relay that received
 * them in different orders still agree — unchanged, and unaffected by the
 * optional fourth argument.
 *
 * `readThrough` binds the recipient's durable read position for the case where an
 * acknowledgement and a read position are one signed statement. It follows the
 * same rule as the poll transcript above: absent means the v1 string exactly as
 * it always was, present means a distinct `:v2:` string. The Go twin is
 * `cryptoutil.CreateMailboxAckMessage` / `CreateMailboxAckMessageV2`.
 */
export function createMailboxAckMessage(
  recipientMailboxId: string,
  deviceId: string,
  envelopeIds: string[],
  readThrough?: string,
): string {
  const normalizedEnvelopeIds = [...envelopeIds].sort().join(",");
  if (readThrough === undefined) {
    return `echolet-mailbox-ack:v1:${recipientMailboxId}:${deviceId}:${normalizedEnvelopeIds}`;
  }
  return `echolet-mailbox-ack:v2:${recipientMailboxId}:${deviceId}:${normalizedEnvelopeIds}:${readThrough}`;
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
