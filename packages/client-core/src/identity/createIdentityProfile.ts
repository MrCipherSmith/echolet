import {
  generateSeed,
  deriveIdentityKeyPairFromSeed,
  deriveSessionKeyPairFromSeed,
} from "@echolet/crypto-core";
import { v5 as uuidv5 } from "uuid";

export interface IdentityProfile {
  identityId: string;
  identityPubKey: string;
  identitySecretKey: string;
  deviceId: string;
  devicePubKey: string;
  deviceSecretKey: string;
  sessionPubKey: string;
  sessionSecretKey: string;
  callsign: string;
  seed: string;
}

export interface CreateIdentityProfileOptions {
  seed?: string;
  suffix?: string;
  deviceLabel?: string;
}

export function generateCallsign(
  identityPubKey: string,
  suffix: string = "",
): string {
  const region = "AD";
  const checksum = identityPubKey.slice(-4, -2);
  return `${region}-${checksum}-${suffix || "GEN"}`;
}

export async function createIdentityProfile(
  optionsOrSuffix?: string | CreateIdentityProfileOptions,
): Promise<IdentityProfile> {
  const options =
    typeof optionsOrSuffix === "string"
      ? { suffix: optionsOrSuffix }
      : (optionsOrSuffix ?? {});
  const seed = options.seed ?? generateSeed();
  const deviceLabel = options.deviceLabel ?? "mobile-device";
  const identityKeys = deriveIdentityKeyPairFromSeed(seed, "identity");
  const deviceKeys = deriveIdentityKeyPairFromSeed(
    seed,
    `device:${deviceLabel}`,
  );
  const sessionKeys = deriveSessionKeyPairFromSeed(
    seed,
    `device:${deviceLabel}`,
  );
  const deviceId = uuidv5(`${seed}:${deviceLabel}`, uuidv5.URL);
  const callsign = generateCallsign(identityKeys.publicKey, options.suffix);

  return {
    identityId: identityKeys.publicKey,
    identityPubKey: identityKeys.publicKey,
    identitySecretKey: identityKeys.secretKey,
    deviceId,
    devicePubKey: deviceKeys.publicKey,
    deviceSecretKey: deviceKeys.secretKey,
    sessionPubKey: sessionKeys.publicKey,
    sessionSecretKey: sessionKeys.secretKey,
    callsign,
    seed,
  };
}
