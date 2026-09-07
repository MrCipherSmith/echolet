import { DeviceRecordSchema } from "../types/deviceRecord";
import type { DeviceRecord } from "../types/deviceRecord";

export function validateDeviceRecord(
  input: unknown,
): { success: true; data: DeviceRecord } | { success: false; error: string } {
  const result = DeviceRecordSchema.safeParse(input);
  if (result.success) {
    return { success: true, data: result.data };
  }
  return { success: false, error: result.error.message };
}
