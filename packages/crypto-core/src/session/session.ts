import {
  SessionState,
  serializeSessionState,
  deserializeSessionState,
} from "./sessionKeys";
import { decodeBase64Url, encodeBase64Url } from "../encoding/base64url";
import { createHmac } from "crypto";
import * as nacl from "tweetnacl";

interface EncryptedPayload {
  v: 1;
  counter: number;
  ciphertext: string;
}

function hkdf(
  input: Uint8Array,
  salt: Uint8Array,
  info: Uint8Array,
  length: number,
): Uint8Array {
  const prk = createHmac("sha256", salt).update(input).digest();
  let okm = Uint8Array.from([]);
  let t = Uint8Array.from([]);
  let i = 0;
  while (okm.length < length) {
    i++;
    t = createHmac("sha256", prk)
      .update(Uint8Array.from([...t, ...info, i]))
      .digest();
    okm = Uint8Array.from([...okm, ...t]);
  }
  return okm.slice(0, length);
}

function assertKeyLength(key: Uint8Array, label: string): void {
  if (key.length !== 32) {
    throw new Error(`${label} must be 32 bytes for X25519 session bootstrap`);
  }
}

function deriveRootKey(sharedSecret: Uint8Array): Uint8Array {
  return hkdf(
    sharedSecret,
    new Uint8Array(32),
    new TextEncoder().encode("Echolet_Root"),
    32,
  );
}

function deriveDirectionalChainKey(
  rootKey: Uint8Array,
  direction: "initiator->recipient" | "recipient->initiator",
): Uint8Array {
  return hkdf(
    rootKey,
    new Uint8Array(32),
    new TextEncoder().encode(`Echolet_Chain:${direction}`),
    32,
  );
}

function deriveMessageKeyMaterial(
  chainKey: Uint8Array,
  counter: number,
): { messageKey: Uint8Array; nonce: Uint8Array } {
  const material = hkdf(
    chainKey,
    new Uint8Array(32),
    new TextEncoder().encode(`Echolet_Message:${counter}`),
    56,
  );

  return {
    messageKey: material.subarray(0, 32),
    nonce: material.subarray(32, 56),
  };
}

function rotateChainKey(chainKey: Uint8Array): Uint8Array {
  return hkdf(
    chainKey,
    new Uint8Array(32),
    new TextEncoder().encode("Echolet_Chain:next"),
    32,
  );
}

export function createOutboundSession(
  localIdentityId: string,
  localDeviceId: string,
  remoteIdentityId: string,
  remoteDeviceId: string,
  remotePreKey: Uint8Array,
  localIdentityKey: Uint8Array,
): { sessionState: SessionState; ciphertext: string } {
  assertKeyLength(remotePreKey, "remotePreKey");
  assertKeyLength(localIdentityKey, "localIdentityKey");

  const sharedSecret = nacl.scalarMult(localIdentityKey, remotePreKey);
  const rootKeyMaterial = deriveRootKey(sharedSecret);

  const sessionState: SessionState = {
    sessionId: `${localDeviceId}:${remoteDeviceId}:${Date.now()}`,
    localIdentityId,
    localDeviceId,
    remoteIdentityId,
    remoteDeviceId,
    sendingChainKey: encodeBase64Url(
      deriveDirectionalChainKey(rootKeyMaterial, "initiator->recipient"),
    ),
    receivingChainKey: encodeBase64Url(
      deriveDirectionalChainKey(rootKeyMaterial, "recipient->initiator"),
    ),
    rootKey: encodeBase64Url(rootKeyMaterial),
    counter: 0,
  };

  return { sessionState, ciphertext: "" };
}

export function createInboundSession(
  localIdentityId: string,
  localDeviceId: string,
  remoteIdentityId: string,
  remoteDeviceId: string,
  localPreKey: Uint8Array,
  remoteIdentityKey: Uint8Array,
): SessionState {
  assertKeyLength(localPreKey, "localPreKey");
  assertKeyLength(remoteIdentityKey, "remoteIdentityKey");

  const sharedSecret = nacl.scalarMult(localPreKey, remoteIdentityKey);
  const rootKeyMaterial = deriveRootKey(sharedSecret);

  return {
    sessionId: `${remoteDeviceId}:${localDeviceId}:${Date.now()}`,
    localIdentityId,
    localDeviceId,
    remoteIdentityId,
    remoteDeviceId,
    sendingChainKey: encodeBase64Url(
      deriveDirectionalChainKey(rootKeyMaterial, "recipient->initiator"),
    ),
    receivingChainKey: encodeBase64Url(
      deriveDirectionalChainKey(rootKeyMaterial, "initiator->recipient"),
    ),
    rootKey: encodeBase64Url(rootKeyMaterial),
    counter: 0,
  };
}

export function encryptMessage(
  sessionState: SessionState,
  plaintext: string,
): { ciphertext: string; updatedSession: SessionState } {
  const currentChainKey = decodeBase64Url(sessionState.sendingChainKey);
  const { messageKey, nonce } = deriveMessageKeyMaterial(
    currentChainKey,
    sessionState.counter,
  );
  const ciphertextBytes = nacl.secretbox(
    new TextEncoder().encode(plaintext),
    nonce,
    messageKey,
  );
  const payload: EncryptedPayload = {
    v: 1,
    counter: sessionState.counter,
    ciphertext: encodeBase64Url(ciphertextBytes),
  };
  const updatedSession: SessionState = {
    ...sessionState,
    sendingChainKey: encodeBase64Url(rotateChainKey(currentChainKey)),
    counter: sessionState.counter + 1,
  };

  return { ciphertext: JSON.stringify(payload), updatedSession };
}

export function decryptMessage(
  sessionState: SessionState,
  ciphertext: string,
): { plaintext: string; updatedSession: SessionState } {
  const payload = JSON.parse(ciphertext) as EncryptedPayload;
  if (payload.v !== 1) {
    throw new Error("unsupported ciphertext version");
  }

  const currentChainKey = decodeBase64Url(
    sessionState.receivingChainKey ?? sessionState.sendingChainKey,
  );
  if (payload.counter !== sessionState.counter) {
    throw new Error(
      `unexpected message counter: expected ${sessionState.counter}, got ${payload.counter}`,
    );
  }

  const { messageKey, nonce } = deriveMessageKeyMaterial(
    currentChainKey,
    payload.counter,
  );
  const plaintextBytes = nacl.secretbox.open(
    decodeBase64Url(payload.ciphertext),
    nonce,
    messageKey,
  );

  if (!plaintextBytes) {
    throw new Error("failed to decrypt message");
  }

  return {
    plaintext: new TextDecoder().decode(plaintextBytes),
    updatedSession: {
      ...sessionState,
      receivingChainKey: encodeBase64Url(rotateChainKey(currentChainKey)),
      counter: sessionState.counter + 1,
    },
  };
}

export function serializeSession(sessionState: SessionState): string {
  return serializeSessionState(sessionState);
}

export function deserializeSession(serialized: string): SessionState {
  return deserializeSessionState(serialized);
}
