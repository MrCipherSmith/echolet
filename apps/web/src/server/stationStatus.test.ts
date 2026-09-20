import { describe, expect, it, vi } from "vitest";
import { StationStatus } from "./stationStatus";

describe("StationStatus", () => {
  it("clears stale doctor data when the active profile can no longer be verified", async () => {
    const doctor = vi.fn()
      .mockResolvedValueOnce({ ok: true, code: "ok", exitCode: 0, data: { identity_id: "identity" } })
      .mockResolvedValueOnce({ ok: false, code: "PERSISTENCE_FAILURE", exitCode: 5, data: null });
    const status = new StationStatus({ doctor, relayUrl: "http://127.0.0.1:1" });

    await status.refreshProfile();
    expect(status.snapshot()).toMatchObject({
      profileState: "verified",
      profile: { identity_id: "identity" },
    });

    await status.refreshProfile();
    expect(status.snapshot()).toMatchObject({ profileState: "unverified", profile: null });
  });

  it("does not confuse relay reachability with an authenticated CLI poll", async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true });
    const status = new StationStatus({
      doctor: vi.fn(),
      relayUrl: "http://127.0.0.1:1",
      fetch,
      now: (() => {
        let time = 100;
        return () => ++time;
      })(),
    });

    await status.refreshRelayReachability();
    expect(status.snapshot()).toMatchObject({
      relay: "unknown",
      relayReachability: "reachable",
      pingMs: 1,
    });

    status.recordPoll({ ok: true, code: "ok", exitCode: 0, data: { received: 0 } });
    expect(status.snapshot().relay).toBe("connected");
    status.recordPoll({ ok: false, code: "RELAY_UNAVAILABLE", exitCode: 4, data: null });
    expect(status.snapshot().relay).toBe("disconnected");
    status.recordPoll({ ok: false, code: "PERSISTENCE_FAILURE", exitCode: 5, data: null });
    expect(status.snapshot().relay).toBe("unknown");
  });

  it("clears the prior ping on a non-OK health response", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: false });
    const status = new StationStatus({ doctor: vi.fn(), relayUrl: "http://127.0.0.1:1", fetch });

    await status.refreshRelayReachability();
    expect(status.snapshot().pingMs).not.toBeNull();
    await status.refreshRelayReachability();
    expect(status.snapshot()).toMatchObject({
      relayReachability: "unreachable",
      pingMs: null,
    });
  });

  it("does not let an older profile refresh overwrite a newer result", async () => {
    let resolveOlder: (value: unknown) => void = () => undefined;
    let resolveNewer: (value: unknown) => void = () => undefined;
    const older = new Promise((resolve) => { resolveOlder = resolve; });
    const newer = new Promise((resolve) => { resolveNewer = resolve; });
    const doctor = vi.fn()
      .mockReturnValueOnce(older)
      .mockReturnValueOnce(newer);
    const status = new StationStatus({ doctor, relayUrl: "http://127.0.0.1:1" });

    const olderRefresh = status.refreshProfile();
    const newerRefresh = status.refreshProfile();
    resolveNewer({ ok: true, code: "ok", exitCode: 0, data: { identity_id: "current" } });
    await newerRefresh;
    resolveOlder({ ok: false, code: "CLI_TIMEOUT", exitCode: 1, data: null });
    await olderRefresh;

    expect(status.snapshot()).toMatchObject({
      profileState: "verified",
      profile: { identity_id: "current" },
    });
  });

  it("does not let an older reachability probe overwrite a newer result", async () => {
    let resolveOlder: (value: unknown) => void = () => undefined;
    let resolveNewer: (value: unknown) => void = () => undefined;
    const older = new Promise((resolve) => { resolveOlder = resolve; });
    const newer = new Promise((resolve) => { resolveNewer = resolve; });
    const fetch = vi.fn()
      .mockReturnValueOnce(older)
      .mockReturnValueOnce(newer);
    const status = new StationStatus({ doctor: vi.fn(), relayUrl: "http://127.0.0.1:1", fetch });

    const olderRefresh = status.refreshRelayReachability();
    const newerRefresh = status.refreshRelayReachability();
    resolveNewer({ ok: true });
    await newerRefresh;
    resolveOlder({ ok: false });
    await olderRefresh;

    expect(status.snapshot()).toMatchObject({
      relayReachability: "reachable",
      pingMs: expect.any(Number),
    });
  });
});
