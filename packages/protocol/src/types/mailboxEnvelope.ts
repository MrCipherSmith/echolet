import { z } from "zod";

export const MailboxEnvelopeSchema = z.object({
  type: z.literal("mailbox_envelope"),
  version: z.literal(1),
  envelope_id: z.string().uuid(),
  message_id: z.string().uuid(),
  sender_identity_id: z.string(),
  sender_device_id: z.string().uuid(),
  recipient_identity_id: z.string(),
  recipient_device_id: z.string().uuid(),
  recipient_mailbox_id: z.string(),
  payload_type: z.literal("ciphertext_message"),
  ciphertext: z.string(),
  created_at_ms: z.number(),
  expires_at_ms: z.number(),
  size_bytes: z.number(),
  // The sender binding `/v1/messages/send` authenticates against the sender's published,
  // root-signed DeviceRecord (T50, finding T49-F-001): base64url raw ed25519 over
  // `createMailboxEnvelopeMessage`.
  //
  // OPTIONAL here and REQUIRED at the relay, which is the only place the property that matters -
  // "an unauthenticated party cannot place an envelope in a victim's mailbox" - can be decided,
  // because only the relay holds the sender's DeviceRecord. The client parses whole poll batches as
  // `z.array(MailboxEnvelopeSchema.strict())`, so a record stored before this field existed must
  // still parse; making it required here would let one legacy envelope fail the batch and wedge the
  // mailbox, which is the class of defect this wave has been closing. Bounded like every other
  // attacker-supplied string that reaches the store and is echoed back to the victim.
  sender_signature: z.string().min(1).max(256).optional(),
});

export type MailboxEnvelope = z.infer<typeof MailboxEnvelopeSchema>;
