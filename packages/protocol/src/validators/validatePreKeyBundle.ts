import { PreKeyBundleSchema } from "../types/preKeyBundle";
import type { PreKeyBundle } from "../types/preKeyBundle";

export function validatePreKeyBundle(
  input: unknown,
): { success: true; data: PreKeyBundle } | { success: false; error: string } {
  const result = PreKeyBundleSchema.safeParse(input);
  if (result.success) {
    return { success: true, data: result.data };
  }
  return { success: false, error: result.error.message };
}
