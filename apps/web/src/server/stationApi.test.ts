import { describe, expect, it } from "vitest";
import { createStatusPayload, validationFailureHttpStatus } from "./stationApi";

describe("station API contracts", () => {
  it("includes the configured label in SSE-compatible status payloads", () => {
    expect(createStatusPayload("Alice", {
      profile: null,
      profileState: "unknown",
      relay: "unknown",
      relayReachability: "unknown",
      relayUrl: "http://127.0.0.1:9",
      pingMs: null,
      statusUpdatedAt: "2026-09-20T00:00:00.000Z",
    })).toMatchObject({ label: "Alice", relay: "unknown", profileState: "unknown" });
  });

  it("maps invalid cards to 400 and station failures to explicit 5xx statuses", () => {
    expect(validationFailureHttpStatus("INVALID_CONTACT_CARD")).toBe(400);
    expect(validationFailureHttpStatus("TRUST_FAILURE")).toBe(400);
    expect(validationFailureHttpStatus("CLI_TIMEOUT")).toBe(504);
    expect(validationFailureHttpStatus("SPAWN_ERROR")).toBe(500);
    expect(validationFailureHttpStatus("PERSISTENCE_FAILURE")).toBe(500);
  });
});
