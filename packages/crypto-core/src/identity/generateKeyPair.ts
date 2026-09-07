import * as nacl from "tweetnacl";
import * as bip39 from "bip39";
import { createHmac } from "crypto";
import { encodeBase64Url } from "../encoding/base64url";

export function generateKeyPair(): { publicKey: string; secretKey: string } {
  const keyPair = nacl.sign.keyPair();
  return {
    publicKey: encodeBase64Url(keyPair.publicKey),
    secretKey: encodeBase64Url(keyPair.secretKey),
  };
}

export function deriveKeyPairFromSeed(
  seed: string,
  namespace: string,
): { publicKey: string; secretKey: string } {
  const derivedSeed = deriveSeedBytes(seed, namespace);
  const keyPair = nacl.sign.keyPair.fromSeed(derivedSeed);

  return {
    publicKey: encodeBase64Url(keyPair.publicKey),
    secretKey: encodeBase64Url(keyPair.secretKey),
  };
}

export function deriveSessionKeyPairFromSeed(
  seed: string,
  namespace: string,
): { publicKey: string; secretKey: string } {
  const derivedSeed = deriveSeedBytes(seed, `session:${namespace}`);
  const keyPair = nacl.box.keyPair.fromSecretKey(derivedSeed);

  return {
    publicKey: encodeBase64Url(keyPair.publicKey),
    secretKey: encodeBase64Url(keyPair.secretKey),
  };
}

function deriveSeedBytes(seed: string, namespace: string): Uint8Array {
  const mnemonicSeed = bip39.mnemonicToSeedSync(seed);
  return createHmac("sha256", mnemonicSeed)
    .update(`echolet:${namespace}:v1`)
    .digest()
    .subarray(0, 32);
}
