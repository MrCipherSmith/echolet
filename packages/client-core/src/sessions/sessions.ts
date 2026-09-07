import { sessionAdapter } from "./sessionAdapter";
import type { SessionState } from "@echolet/crypto-core";

export interface SessionsRepository {
  getById(id: string): Promise<SessionState | null>;
  getByDevicePair(
    localDeviceId: string,
    remoteDeviceId: string,
  ): Promise<SessionState | null>;
  insert(session: SessionState): Promise<void>;
  update(session: SessionState): Promise<void>;
}

export async function createOutboundSession(
  sessionsRepo: SessionsRepository,
  localIdentityId: string,
  localDeviceId: string,
  remoteIdentityId: string,
  remoteDeviceId: string,
  remotePreKey: Uint8Array,
  localIdentityKey: Uint8Array,
): Promise<SessionState> {
  const { sessionState } = sessionAdapter.createOutbound(
    localIdentityId,
    localDeviceId,
    remoteIdentityId,
    remoteDeviceId,
    remotePreKey,
    localIdentityKey,
  );

  await sessionsRepo.insert(sessionState);
  return sessionState;
}

export async function createInboundSession(
  sessionsRepo: SessionsRepository,
  localIdentityId: string,
  localDeviceId: string,
  remoteIdentityId: string,
  remoteDeviceId: string,
  localPreKey: Uint8Array,
  remoteIdentityKey: Uint8Array,
): Promise<SessionState> {
  const sessionState = sessionAdapter.createInbound(
    localIdentityId,
    localDeviceId,
    remoteIdentityId,
    remoteDeviceId,
    localPreKey,
    remoteIdentityKey,
  );

  await sessionsRepo.insert(sessionState);
  return sessionState;
}

export async function loadSession(
  sessionsRepo: SessionsRepository,
  localDeviceId: string,
  remoteDeviceId: string,
): Promise<SessionState | null> {
  return sessionsRepo.getByDevicePair(localDeviceId, remoteDeviceId);
}

export async function saveSession(
  sessionsRepo: SessionsRepository,
  sessionState: SessionState,
): Promise<void> {
  await sessionsRepo.update(sessionState);
}
