import type { StationStatusSnapshot } from "./stationStatus";

export interface StationStatusPayload extends StationStatusSnapshot {
  label: string;
}

export function createStatusPayload(
  label: string,
  snapshot: StationStatusSnapshot,
): StationStatusPayload {
  return { label, ...snapshot };
}

export function validationFailureHttpStatus(code: string): number {
  if (code === "INVALID_CONTACT_CARD" || code === "TRUST_FAILURE") return 400;
  if (code === "CLI_TIMEOUT") return 504;
  return 500;
}
