import { canonicalJson } from "./canonicalJson";
import * as nacl from "tweetnacl";
import { encodeBase64Url, decodeBase64Url } from "../encoding/base64url";

function normalizeKeyBytes(key: Uint8Array | string): Uint8Array {
  return typeof key === "string" ? decodeBase64Url(key) : key;
}

export function signCanonicalJson(obj: unknown, secretKey: Uint8Array): string {
  const json = canonicalJson(obj);
  return signUtf8Message(json, secretKey);
}

export function verifyCanonicalJson(
  obj: unknown,
  signatureBase64Url: string,
  publicKey: Uint8Array,
): boolean {
  const json = canonicalJson(obj);
  return verifyUtf8Message(json, signatureBase64Url, publicKey);
}

export function signUtf8Message(
  message: string,
  secretKey: Uint8Array | string,
): string {
  const messageBytes = new TextEncoder().encode(message);
  const signature = nacl.sign.detached(
    messageBytes,
    normalizeKeyBytes(secretKey),
  );
  return encodeBase64Url(signature);
}

export function verifyUtf8Message(
  message: string,
  signatureBase64Url: string,
  publicKey: Uint8Array | string,
): boolean {
  const messageBytes = new TextEncoder().encode(message);
  const signature = decodeBase64Url(signatureBase64Url);
  return nacl.sign.detached.verify(
    messageBytes,
    signature,
    normalizeKeyBytes(publicKey),
  );
}
