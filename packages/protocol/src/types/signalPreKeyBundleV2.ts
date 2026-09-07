import { z } from "zod";

const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/** Validate canonical unpadded base64url without depending on Node or a native runtime. */
function encodedBytes(length: number, prefix?: number) {
  return z.string().refine((value) => {
    if (value.length !== Math.ceil(length * 8 / 6) || !/^[A-Za-z0-9_-]+$/.test(value)) return false;
    const unusedBits = (6 - (length * 8) % 6) % 6;
    if ((alphabet.indexOf(value[value.length - 1]!) & ((1 << unusedBits) - 1)) !== 0) return false;
    return prefix === undefined || ((alphabet.indexOf(value[0]!) << 2) | (alphabet.indexOf(value[1]!) >> 4)) === prefix;
  }, `Expected canonical base64url encoding of ${length} bytes${prefix === undefined ? "" : ` with prefix ${prefix}`}`);
}
const uuid = z.string().uuid().regex(/^[0-9a-f-]+$/);
const timestamp = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const keyId = z.number().int().min(0).max(0xffffffff);
const identity = encodedBytes(32);
const signature = encodedBytes(64);
const ecKey = encodedBytes(33, 0x05);
const signedDevice = z.object({
  type: z.literal("device_record"),
  version: z.literal(1),
  identity_id: identity,
  device_id: uuid,
  device_pubkey: identity,
  device_label: z.string().max(256).optional(),
  capabilities: z.object({
    mailbox_poll: z.boolean().optional(),
    receipts: z.boolean().optional(),
    attachments: z.boolean().optional(),
  }).strict(),
  created_at_ms: timestamp,
  signature,
}).strict();

// z.object reconstructs properties in schema order. The v1 signature covers the
// original nested object ordering, so validate strictly without reconstructing it.
const originalSignedDevice = z.custom<z.infer<typeof signedDevice>>(
  (value) => signedDevice.safeParse(value).success,
  "Invalid strict signed DeviceRecord",
);

export const SignalPreKeyBundleV2Schema = z.object({
  type: z.literal("signal_prekey_bundle"),
  version: z.literal(2),
  suite: z.literal("libsignal-pq-v1"),
  bundle_id: uuid,
  created_at_ms: timestamp,
  expires_at_ms: timestamp,
  device_record: originalSignedDevice,
  registration_id: z.number().int().min(1).max(16380),
  signal_identity_key: ecKey,
  signed_prekey: z.object({ key_id: keyId, public_key: ecKey, signature }).strict(),
  kyber_prekey: z.object({ key_id: keyId, public_key: encodedBytes(1569, 0x08), signature }).strict(),
  one_time_prekey: z.object({ key_id: keyId, public_key: ecKey }).strict().nullable(),
  signature,
}).strict().refine(
  (value) => value.expires_at_ms > value.created_at_ms && value.expires_at_ms - value.created_at_ms <= 7 * 24 * 60 * 60 * 1000,
  "Bundle lifetime must be positive and at most seven days",
);

/** Structural validation only; signatures and current-time validity require verified import. */
export type SignalPreKeyBundleV2 = z.infer<typeof SignalPreKeyBundleV2Schema>;

export function signalAddressForDevice(identityId: string, deviceId: string): { name: string; deviceId: 1 } {
  identity.parse(identityId);
  uuid.parse(deviceId);
  return { name: JSON.stringify([identityId, deviceId]), deviceId: 1 };
}

/** Fixed UTF-8 signing text; excludes only the outer signature, includes all nested signatures. */
export function signalBundleV2SigningText(bundle: SignalPreKeyBundleV2): string {
  const value = SignalPreKeyBundleV2Schema.parse(bundle);
  const device = value.device_record;
  return JSON.stringify([
    "echolet.signal.prekey_bundle.v2", value.bundle_id, value.suite,
    [device.type, device.version, device.identity_id, device.device_id,
      device.device_pubkey, device.device_label ?? null,
      [device.capabilities.mailbox_poll ?? null, device.capabilities.receipts ?? null, device.capabilities.attachments ?? null],
      device.created_at_ms, device.signature],
    value.created_at_ms, value.expires_at_ms, value.registration_id, value.signal_identity_key,
    [value.signed_prekey.key_id, value.signed_prekey.public_key, value.signed_prekey.signature],
    [value.kyber_prekey.key_id, value.kyber_prekey.public_key, value.kyber_prekey.signature],
    value.one_time_prekey === null ? null : [value.one_time_prekey.key_id, value.one_time_prekey.public_key],
  ]);
}
