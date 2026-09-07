import { describe, expect, it } from "vitest";
import { MailboxEnvelopeSchema } from "../index";

// RED tests for T50 / finding T49-F-001 (major): the wire slot the sender binding travels in.
//
// The relay must refuse an envelope whose sender it cannot authenticate, so the signature has to
// reach `/v1/messages/send` inside the envelope object the CLI and the mobile demo already build.
// `MailboxEnvelopeSchema` is parsed `.strict()` on both directions of the wire
// (apps/cli/src/transport/relayClient.ts:78 for send, :89 for every polled envelope), so today a
// `sender_signature` key is refused as an unknown property and the field cannot exist at all.
//
// The field is deliberately OPTIONAL on this schema, exactly as T48 added `cursor` as an optional
// field to a still-`.strict()` poll request:
//
//   * the relay is the enforcement point, because the property that matters is "an unauthenticated
//     party cannot place an envelope in a victim's mailbox", and that can only be decided where the
//     sender's published DeviceRecord is;
//   * the recipient already authenticates the sender end-to-end through Signal, at decrypt, so this
//     signature is relay-facing admission control rather than a second end-to-end authentication;
//   * every existing poll and send fixture in the workspace (relayClient.test.ts:7,
//     relayClient.pollCapacity.test.ts:37, cli.processFailures.test.ts:292) builds an envelope
//     without one, and making the field required would break them without pinning anything the
//     relay-side tests do not already pin.
//
// `.strict()` itself is NOT relaxed: an unknown key is still refused.

const validEnvelope = {
  type: "mailbox_envelope" as const,
  version: 1 as const,
  envelope_id: "b1d4e7c2-5a63-4f18-9c07-2e8b6a4d3f51",
  message_id: "3f9a0c86-71b2-4d5e-8a14-6c9e2b7d0f43",
  sender_identity_id: "0nMxQ8kR2vT5wY7zB1dF4hJ6lN9pS3uX0aC2eG5iK8M",
  sender_device_id: "7319a570-67c7-4c8b-bb0b-4dcdf41de5ec",
  recipient_identity_id: "vJ4Q0Zt7c9m2n1xR5wKpLb8sT3yHgD6uAeF0iC7oQmU",
  recipient_device_id: "8cc8010b-d4a1-4ce7-8203-a8f6b055c1b9",
  recipient_mailbox_id: "Ecc0LqR3nT8vY1zB4dF7hJ0lN3pS6uX9aC2eG5iK8Mo",
  payload_type: "ciphertext_message" as const,
  ciphertext: "QUFBQUFBQUFBQUFB",
  created_at_ms: 1770000000000,
  expires_at_ms: 1770086400000,
  size_bytes: 16,
};

// A raw ed25519 signature is 64 bytes, which is 86 base64url characters.
const signature = "A".repeat(86);

describe("MailboxEnvelopeSchema sender_signature", () => {
  it("carries the sender binding through the strict wire schema", () => {
    // The load-bearing assertion. Today `.strict()` refuses `sender_signature` as an unknown key,
    // so the relay can never be handed one and the T49-F-001 flooding path stays open.
    const parsed = MailboxEnvelopeSchema.strict().parse({
      ...validEnvelope,
      sender_signature: signature,
    });
    expect(parsed.sender_signature).toBe(signature);
  });

  it("still refuses any other unknown property", () => {
    // `.strict()` is not relaxed to make room for the new field.
    expect(
      MailboxEnvelopeSchema.strict().safeParse({ ...validEnvelope, unknown_field: true }).success,
    ).toBe(false);
  });

  it("bounds the signature so a stored envelope cannot carry an unbounded sender-supplied string", () => {
    // recipient_mailbox_id and envelope_id are bounded at 256 bytes by
    // validation.MaxIdentifierBytes precisely because they are attacker-supplied and end up in a
    // Badger key; the signature is attacker-supplied too and is echoed back to the victim in every
    // poll response, which the client reads under a 1 MiB hard bound.
    expect(MailboxEnvelopeSchema.strict().safeParse({ ...validEnvelope, sender_signature: "" }).success).toBe(false);
    expect(MailboxEnvelopeSchema.strict().safeParse({ ...validEnvelope, sender_signature: "A".repeat(257) }).success).toBe(false);
    expect(MailboxEnvelopeSchema.strict().safeParse({ ...validEnvelope, sender_signature: "A".repeat(256) }).success).toBe(true);
  });

  it("keeps the field optional so existing poll and send fixtures still parse", () => {
    // Guard against the field being made required: three CLI suites and the T48 shape-parity
    // contract build envelopes without one, and a poll response the client cannot parse is exactly
    // the mailbox wedge this flow has been closing.
    expect(MailboxEnvelopeSchema.strict().safeParse(validEnvelope).success).toBe(true);
  });
});
