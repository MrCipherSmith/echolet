import { z } from "zod";

export const DeviceRecordSchema = z.object({
  type: z.literal("device_record"),
  version: z.literal(1),
  identity_id: z.string(),
  device_id: z.string().uuid(),
  device_pubkey: z.string(),
  device_label: z.string().optional(),
  capabilities: z.object({
    mailbox_poll: z.boolean().optional(),
    receipts: z.boolean().optional(),
    attachments: z.boolean().optional(),
  }),
  created_at_ms: z.number(),
  signature: z.string(),
});

export type DeviceRecord = z.infer<typeof DeviceRecordSchema>;
