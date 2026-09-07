import { sessionAdapter } from "../sessions/sessionAdapter";
import type { SessionState } from "@echolet/crypto-core";
import type { ChatMessage } from "@echolet/protocol";

export async function encryptOutgoingMessage(
  sessionState: SessionState,
  message: ChatMessage,
): Promise<{ ciphertext: string; updatedSession: SessionState }> {
  const plaintext = JSON.stringify(message);
  return sessionAdapter.encrypt(sessionState, plaintext);
}

export async function decryptIncomingEnvelope(
  sessionState: SessionState,
  ciphertext: string,
): Promise<{ plaintext: ChatMessage; updatedSession: SessionState }> {
  const { plaintext, updatedSession } = sessionAdapter.decrypt(
    sessionState,
    ciphertext,
  );
  return { plaintext: JSON.parse(plaintext), updatedSession };
}
