import {
  createOutboundSession as createOutbound,
  createInboundSession as createInbound,
  encryptMessage,
  decryptMessage,
  serializeSession as serialize,
  deserializeSession as deserialize,
} from "@echolet/crypto-core";
import type { SessionState } from "@echolet/crypto-core";

export interface SessionAdapter {
  createOutbound: typeof createOutbound;
  createInbound: typeof createInbound;
  encrypt: typeof encryptMessage;
  decrypt: typeof decryptMessage;
  serialize: typeof serialize;
  deserialize: typeof deserialize;
}

export const sessionAdapter: SessionAdapter = {
  createOutbound,
  createInbound,
  encrypt: encryptMessage,
  decrypt: decryptMessage,
  serialize,
  deserialize,
};

export type { SessionState };
