import { z } from "zod";

export const PreKeyBundleSchema = z.object({
  type: z.literal("prekey_bundle"),
  version: z.literal(1),
  bundle_id: z.string().uuid(),
  identity_id: z.string(),
  device_id: z.string().uuid(),
  device_pubkey: z.string(),
  signed_prekey: z.object({
    key_id: z.string(),
    public_key: z.string(),
    created_at_ms: z.number(),
    expires_at_ms: z.number(),
    signature: z.string(),
  }),
  one_time_prekeys: z.array(
    z.object({
      key_id: z.string(),
      public_key: z.string(),
    }),
  ),
  created_at_ms: z.number(),
  signature: z.string(),
});

export type PreKeyBundle = z.infer<typeof PreKeyBundleSchema>;
