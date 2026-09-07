import { randomUUID } from "node:crypto";
import * as L from "@signalapp/libsignal-client";
import {
  decodeBase64Url, encodeBase64Url, signUtf8Message,
  verifyCanonicalJson, verifyUtf8Message,
} from "@echolet/crypto-core";
import {
  SignalPreKeyBundleV2Schema, signalAddressForDevice, signalBundleV2SigningText,
  type DeviceRecord, type SignalPreKeyBundleV2,
} from "@echolet/protocol";
import type { SignalClient, DeviceAddress } from "./SignalClient";

export interface ExportSignalBundleV2Options {
  deviceRecord: DeviceRecord;
  deviceSecretKey: Uint8Array;
  createdAtMs?: number;
  expiresAtMs?: number;
}
export interface ExpectedSignalContact {
  identityId: string;
  deviceId: string;
}
const bytes = (value: string): Uint8Array<ArrayBuffer> => Uint8Array.from(decodeBase64Url(value));
const copyJson = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

function requireDeviceSignature(record: DeviceRecord): void {
  if (!verifyCanonicalJson(record, record.signature, bytes(record.identity_id))) {
    throw new Error("Invalid root signature on DeviceRecord");
  }
}

/** Export public material only; this does not allocate a one-time prekey to a relay caller. */
export async function exportSignedSignalBundleV2(
  client: SignalClient,
  options: ExportSignalBundleV2Options,
): Promise<SignalPreKeyBundleV2> {
  const record = copyJson(options.deviceRecord);
  const signingKey = Uint8Array.from(options.deviceSecretKey);
  const created = options.createdAtMs ?? Date.now();
  const expires = options.expiresAtMs ?? created + 7 * 24 * 60 * 60 * 1000;
  try {
    const address = signalAddressForDevice(record.identity_id, record.device_id);
    if (client.address.name !== address.name || client.address.deviceId !== address.deviceId) {
      throw new Error("Local Signal address does not match DeviceRecord");
    }
    requireDeviceSignature(record);
    const bundle = await client.publicBundle();
    const prekey = bundle.preKeyPublic();
    const wire = SignalPreKeyBundleV2Schema.parse({
      type: "signal_prekey_bundle", version: 2, suite: "libsignal-pq-v1",
      bundle_id: randomUUID(), device_record: record,
      created_at_ms: created, expires_at_ms: expires,
      registration_id: bundle.registrationId(),
      signal_identity_key: encodeBase64Url(bundle.identityKey().serialize()),
      signed_prekey: { key_id: bundle.signedPreKeyId(), public_key: encodeBase64Url(bundle.signedPreKeyPublic().serialize()), signature: encodeBase64Url(bundle.signedPreKeySignature()) },
      kyber_prekey: { key_id: bundle.kyberPreKeyId(), public_key: encodeBase64Url(bundle.kyberPreKeyPublic().serialize()), signature: encodeBase64Url(bundle.kyberPreKeySignature()) },
      one_time_prekey: prekey === null ? null : { key_id: bundle.preKeyId(), public_key: encodeBase64Url(prekey.serialize()) },
      signature: encodeBase64Url(new Uint8Array(64)),
    });
    wire.signature = signUtf8Message(signalBundleV2SigningText(wire), signingKey);
    // Validate the signing key binding and all native signatures before returning.
    importVerifiedSignalBundleV2(wire, { identityId: record.identity_id, deviceId: record.device_id }, created);
    return wire;
  } finally {
    signingKey.fill(0);
  }
}

/** Verify against an independently trusted contact. Never changes trust/session state. */
export function importVerifiedSignalBundleV2(
  input: unknown,
  expected: ExpectedSignalContact,
  now: number = Date.now(),
): { address: DeviceAddress; bundle: L.PreKeyBundle } {
  const address = signalAddressForDevice(expected.identityId, expected.deviceId);
  // Validate first (no silently omitted signed fields), then own the original JSON ordering.
  const wire = copyJson(SignalPreKeyBundleV2Schema.parse(input));
  const record = wire.device_record;
  if (record.identity_id !== expected.identityId || record.device_id !== expected.deviceId) {
    throw new Error("Bundle does not match expected contact");
  }
  if (!Number.isSafeInteger(now) || now < 0 || now < wire.created_at_ms || now >= wire.expires_at_ms || record.created_at_ms > wire.created_at_ms) {
    throw new Error("Bundle is not currently valid");
  }
  requireDeviceSignature(record);
  if (!verifyUtf8Message(signalBundleV2SigningText(wire), wire.signature, bytes(record.device_pubkey))) {
    throw new Error("Invalid device signature on Signal bundle");
  }
  const identity = L.PublicKey.deserialize(bytes(wire.signal_identity_key));
  const signed = wire.signed_prekey;
  const kyber = wire.kyber_prekey;
  if (!identity.verify(bytes(signed.public_key), bytes(signed.signature)) || !identity.verify(bytes(kyber.public_key), bytes(kyber.signature))) {
    throw new Error("Invalid native prekey signature");
  }
  const oneTime = wire.one_time_prekey;
  return {
    address,
    bundle: L.PreKeyBundle.new(
      wire.registration_id, address.deviceId,
      oneTime?.key_id ?? null, oneTime === null ? null : L.PublicKey.deserialize(bytes(oneTime.public_key)),
      signed.key_id, L.PublicKey.deserialize(bytes(signed.public_key)), bytes(signed.signature), identity,
      kyber.key_id, L.KEMPublicKey.deserialize(bytes(kyber.public_key)), bytes(kyber.signature),
    ),
  };
}
