import * as nacl from "tweetnacl";

export interface SessionKeys {
  identityKey: Uint8Array;
  signedPreKey: Uint8Array;
  oneTimePreKeys: Map<string, Uint8Array>;
}

export interface SessionState {
  sessionId: string;
  localIdentityId: string;
  localDeviceId: string;
  remoteIdentityId: string;
  remoteDeviceId: string;
  sendingChainKey: string;
  receivingChainKey?: string;
  rootKey: string;
  counter: number;
}

export function generateKeyPair(): {
  publicKey: Uint8Array;
  privateKey: Uint8Array;
} {
  const keyPair = nacl.box.keyPair();
  return {
    publicKey: keyPair.publicKey,
    privateKey: keyPair.secretKey,
  };
}

export function serializeSessionState(state: SessionState): string {
  return JSON.stringify(state);
}

export function deserializeSessionState(serialized: string): SessionState {
  return JSON.parse(serialized) as SessionState;
}
