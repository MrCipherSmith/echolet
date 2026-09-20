export type ConnectionState = "connected" | "disconnected" | "unknown";
export type ProfileState = "verified" | "unverified" | "unknown";
export type ReachabilityState = "reachable" | "unreachable" | "unknown";

export interface StationStatus {
  label: string | null;
  profile: Record<string, unknown> | null;
  profileState: ProfileState;
  relay: ConnectionState;
  relayReachability: ReachabilityState;
  relayUrl: string;
  pingMs: number | null;
  telemetry: unknown[] | null;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function connectionState(value: unknown): ConnectionState {
  return value === "connected" || value === "disconnected" ? value : "unknown";
}

function profileState(value: unknown): ProfileState {
  return value === "verified" || value === "unverified" ? value : "unknown";
}

function reachabilityState(value: unknown): ReachabilityState {
  return value === "reachable" || value === "unreachable" ? value : "unknown";
}

/** Converts external status JSON into conservative UI values without inferring trust or availability. */
export function parseStationStatus(value: unknown): StationStatus | null {
  if (!isRecord(value) || value.ok === false) return null;
  return {
    label: typeof value.label === "string" ? value.label : null,
    profile: isRecord(value.profile) ? value.profile : null,
    profileState: profileState(value.profileState),
    relay: connectionState(value.relay),
    relayReachability: reachabilityState(value.relayReachability),
    relayUrl: typeof value.relayUrl === "string" ? value.relayUrl : "",
    pingMs: typeof value.pingMs === "number" && Number.isFinite(value.pingMs) ? value.pingMs : null,
    telemetry: Array.isArray(value.telemetry) ? value.telemetry : null,
  };
}

/** Browser transport loss takes precedence over an older relay report. */
export function effectiveRelayState(localStation: ConnectionState, relay: ConnectionState): ConnectionState {
  return localStation === "disconnected" ? "disconnected" : relay;
}
