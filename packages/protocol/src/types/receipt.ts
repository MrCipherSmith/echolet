import { z } from "zod";

export const ReceiptSchema = z.object({
  type: z.literal("receipt"),
  version: z.literal(1),
  receipt_id: z.string().uuid(),
  message_id: z.string().uuid(),
  status: z.enum(["queued", "relayed", "delivered", "read"]),
  created_at_ms: z.number(),
});

export type Receipt = z.infer<typeof ReceiptSchema>;
