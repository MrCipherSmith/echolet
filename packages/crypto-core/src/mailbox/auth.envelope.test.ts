import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  createMailboxEnvelopeMessage,
  deriveIdentityKeyPairFromSeed,
  hashMailboxEnvelopeCiphertext,
  signMailboxEnvelopeMessage,
  verifyMailboxEnvelopeMessage,
} from "../index";

// RED tests for T50 / finding T49-F-001 (major): the shared sender-authentication transcript.
//
// Before T51, `/v1/messages/send` did not authenticate the sender, so anyone who knew a victim's
// recipient_mailbox_id - a digest of an identity id published in the victim's own contact card -
// could place envelopes in that mailbox. (T51 shipped the binding these tests pin; the capability
// is bounded rather than removed, because a sender identity still costs one unauthenticated
// /v1/device-records/publish - finding T52-F-001.) T49 measured the consequence on the real relay at default
// configuration: 49 unauthenticated POSTs (~12.8 MB, under 30 s inside the 120/min rate limit)
// wedge the mailbox for up to the 168 h retention cap, and 800 minimum-size envelopes do the same.
// The T48 page walk bounds that cost; it does not remove the capability.
//
// The fix is a sender binding the relay can verify against the sender's already-published,
// root-signed DeviceRecord - the same trust chain `authorizeMailboxDevice` uses for
// challenge / poll / ack. This file pins the transcript that binding is computed over. It is a
// plain UTF-8 string signed with the sender's device secret key, exactly like
// `createMailboxChallengeMessage` / `createMailboxAckMessage` in ./auth.ts, so both the CLI and the
// mobile demo can produce it and the Go relay can reproduce it byte for byte:
//
//   echolet-mailbox-envelope:v1:<recipient_mailbox_id>:<envelope_id>:<sender_identity_id>
//     :<sender_device_id>:<ciphertext_sha256_base64url>:<created_at_ms>:<expires_at_ms>
//
// The ciphertext is bound by its SHA-256 digest rather than inline, so the transcript stays a few
// hundred bytes for a 256 KiB envelope while still pinning the exact payload bytes.
//
// No plaintext, ciphertext or private key material is printed by these tests: the "ciphertext"
// below is inert base64url padding and only signatures, transcripts and booleans are asserted on.

const seed =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const keys = deriveIdentityKeyPairFromSeed(seed, "device:t50-sender");
const otherKeys = deriveIdentityKeyPairFromSeed(seed, "device:t50-impostor");

/** The seven fields the relay must find bound into the signature. */
const bound = {
  recipientMailboxId: "vJ4Q0Zt7c9m2n1xR5wKpLb8sT3yHgD6uAeF0iC7oQmU",
  envelopeId: "b1d4e7c2-5a63-4f18-9c07-2e8b6a4d3f51",
  senderIdentityId: "0nMxQ8kR2vT5wY7zB1dF4hJ6lN9pS3uX0aC2eG5iK8M",
  senderDeviceId: "7319a570-67c7-4c8b-bb0b-4dcdf41de5ec",
  ciphertext: "QUFBQUFBQUFBQUFB",
  createdAtMs: 1770000000000,
  expiresAtMs: 1770086400000,
};

const messageFor = (fields: typeof bound) =>
  createMailboxEnvelopeMessage(
    fields.recipientMailboxId,
    fields.envelopeId,
    fields.senderIdentityId,
    fields.senderDeviceId,
    hashMailboxEnvelopeCiphertext(fields.ciphertext),
    fields.createdAtMs,
    fields.expiresAtMs,
  );

const signFor = (fields: typeof bound, secretKey: string = keys.secretKey) =>
  signMailboxEnvelopeMessage(
    fields.recipientMailboxId,
    fields.envelopeId,
    fields.senderIdentityId,
    fields.senderDeviceId,
    hashMailboxEnvelopeCiphertext(fields.ciphertext),
    fields.createdAtMs,
    fields.expiresAtMs,
    secretKey,
  );

const verifyFor = (
  fields: typeof bound,
  signature: string,
  publicKey: string = keys.publicKey,
) =>
  verifyMailboxEnvelopeMessage(
    fields.recipientMailboxId,
    fields.envelopeId,
    fields.senderIdentityId,
    fields.senderDeviceId,
    hashMailboxEnvelopeCiphertext(fields.ciphertext),
    fields.createdAtMs,
    fields.expiresAtMs,
    signature,
    publicKey,
  );

describe("mailbox envelope sender transcript", () => {
  it("hashes the ciphertext as raw base64url SHA-256 of its UTF-8 bytes", () => {
    // The relay must be able to reproduce this from the envelope alone, in Go, with
    // base64.RawURLEncoding over sha256.Sum256([]byte(ciphertext)).
    expect(hashMailboxEnvelopeCiphertext(bound.ciphertext)).toBe(
      createHash("sha256").update(bound.ciphertext, "utf8").digest("base64url"),
    );
  });

  it("builds the exact versioned transcript the relay reproduces", () => {
    // Pinned literally rather than by re-calling the helper: this string IS the wire contract, and
    // a Go implementation that formats it differently must fail here, not silently diverge.
    expect(messageFor(bound)).toBe(
      "echolet-mailbox-envelope:v1:" +
        `${bound.recipientMailboxId}:${bound.envelopeId}:${bound.senderIdentityId}:` +
        `${bound.senderDeviceId}:${hashMailboxEnvelopeCiphertext(bound.ciphertext)}:` +
        `${bound.createdAtMs}:${bound.expiresAtMs}`,
    );
  });

  it("signs and verifies the transcript with the sender's device key", () => {
    expect(verifyFor(bound, signFor(bound))).toBe(true);
  });

  it("is deterministic, so a byte-identical retry replays byte-identical bytes", () => {
    // F-004: an ambiguous send is retried with the identical envelope, and the relay treats a
    // byte-identical replay as idempotent. A non-deterministic signature would turn every retry
    // into an ENVELOPE_ID_CONFLICT.
    expect(signFor(bound)).toBe(signFor(bound));
  });

  it.each([
    ["recipient mailbox (retargeting the envelope at another victim)", { recipientMailboxId: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" }],
    ["envelope id (re-injecting the same body as a fresh envelope)", { envelopeId: "00000000-0000-4000-8000-000000000001" }],
    ["sender identity id (claiming another sender)", { senderIdentityId: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" }],
    ["sender device id (claiming another device of the same sender)", { senderDeviceId: "8cc8010b-d4a1-4ce7-8203-a8f6b055c1b9" }],
    ["ciphertext (swapping the payload after signing)", { ciphertext: "QkJCQkJCQkJCQkJC" }],
    ["created_at_ms", { createdAtMs: bound.createdAtMs + 1 }],
    ["expires_at_ms (extending how long the envelope occupies the mailbox)", { expiresAtMs: bound.expiresAtMs + 1 }],
  ])("refuses a signature made over a different transcript: %s", (_label, change) => {
    // Every one of these is a field an attacker would want to change after obtaining a legitimate
    // signed envelope. If any of them verified, the binding would be decorative.
    const signature = signFor(bound);
    expect(verifyFor({ ...bound, ...change }, signature)).toBe(false);
  });

  it("refuses a signature made with a key that is not the sender's device key", () => {
    expect(verifyFor(bound, signFor(bound, otherKeys.secretKey))).toBe(false);
  });
});
