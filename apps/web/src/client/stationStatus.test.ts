import { describe, expect, it } from "vitest";
import { effectiveRelayState, parseStationStatus } from "./stationStatus";

describe("parseStationStatus", () => {
  it("does not infer connection, trust, or contact presence from incomplete status JSON", () => {
    expect(parseStationStatus({ ok: true, label: "Alice", profile: {}, relay: "online", profileState: "valid" }))
      .toMatchObject({ relay: "unknown", profileState: "unknown", relayReachability: "unknown" });
  });

  it("keeps an omitted SSE label distinct from the default operator label", () => {
    expect(parseStationStatus({ ok: true, relay: "connected" })?.label).toBeNull();
  });

  it("preserves only the explicit server states", () => {
    expect(parseStationStatus({
      ok: true, label: "Alice", profile: { contacts: [] }, relay: "connected", relayReachability: "unreachable",
      profileState: "verified", relayUrl: "https://relay.example", pingMs: 24, telemetry: [],
    })).toMatchObject({ relay: "connected", relayReachability: "unreachable", profileState: "verified", pingMs: 24 });
  });

  it("lets a local station disconnect override a stale connected relay report", () => {
    expect(effectiveRelayState("disconnected", "connected")).toBe("disconnected");
    expect(effectiveRelayState("connected", "connected")).toBe("connected");
  });
});
