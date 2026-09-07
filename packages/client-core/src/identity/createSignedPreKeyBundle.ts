import {
  decodeBase64Url,
  deriveSessionKeyPairFromSeed,
  signCanonicalJson,
} from "@echolet/crypto-core";
import type { PreKeyBundle } from "@echolet/protocol";
import { v7 as uuidv7 } from "uuid";
import type { IdentityProfile } from "./createIdentityProfile";

export interface CreateSignedPreKeyBundleOptions {
  oneTimePreKeyCount?: number;
  createdAtMs?: number;
}

export function createSignedPreKeyBundle(
  profile: IdentityProfile,
  options: CreateSignedPreKeyBundleOptions = {},
): PreKeyBundle {
  const createdAtMs = options.createdAtMs ?? Date.now();
  const oneTimePreKeyCount = options.oneTimePreKeyCount ?? 5;
  const signedPreKey = {
    key_id: "spk-001",
    public_key: profile.sessionPubKey,
    created_at_ms: createdAtMs,
    expires_at_ms: createdAtMs + 7 * 24 * 60 * 60 * 1000,
    signature: "",
  };

  signedPreKey.signature = signCanonicalJson(
    signedPreKey,
    decodeBase64Url(profile.deviceSecretKey),
  );

  const oneTimePreKeys = Array.from({ length: oneTimePreKeyCount }, (_, index) => {
    const keyId = `otk-${String(index + 1).padStart(3, "0")}`;
    const keyPair = deriveSessionKeyPairFromSeed(profile.seed, keyId);
    return {
      key_id: keyId,
      public_key: keyPair.publicKey,
    };
  });

  const bundle: PreKeyBundle = {
    type: "prekey_bundle",
    version: 1,
    bundle_id: uuidv7(),
    identity_id: profile.identityId,
    device_id: profile.deviceId,
    device_pubkey: profile.devicePubKey,
    signed_prekey: signedPreKey,
    one_time_prekeys: oneTimePreKeys,
    created_at_ms: createdAtMs,
    signature: "",
  };

  bundle.signature = signCanonicalJson(
    bundle,
    decodeBase64Url(profile.identitySecretKey),
  );

  return bundle;
}
