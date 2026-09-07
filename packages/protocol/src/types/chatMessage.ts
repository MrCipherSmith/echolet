import { z } from "zod";

export const ChatMessageSchema = z.object({
  type: z.literal("chat_message"),
  version: z.literal(1),
  message_id: z.string().uuid(),
  conversation_id: z.string(),
  sender_identity_id: z.string(),
  sender_device_id: z.string().uuid(),
  created_at_ms: z.number(),
  body: z.string(),
  reply_to_message_id: z.string().uuid().nullable(),
});

export type ChatMessage = z.infer<typeof ChatMessageSchema>;
