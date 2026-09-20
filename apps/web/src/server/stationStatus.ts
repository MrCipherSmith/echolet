import type { CliOutcome } from "./cliBridge";

export type ConnectionState = "connected" | "disconnected" | "unknown";
export type ReachabilityState = "reachable" | "unreachable" | "unknown";
export type ProfileState = "verified" | "unverified" | "unknown";

export interface StationStatusSnapshot {
  profile: Record<string, unknown> | null;
  profileState: ProfileState;
  relay: ConnectionState;
  relayReachability: ReachabilityState;
  relayUrl: string;
  pingMs: number | null;
  statusUpdatedAt: string;
}

interface StationStatusOptions {
  doctor: () => Promise<CliOutcome>;
  relayUrl: string;
  fetch?: typeof fetch;
  now?: () => number;
  healthTimeoutMs?: number;
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export class StationStatus {
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private profile: Record<string, unknown> | null = null;
  private profileState: ProfileState = "unknown";
  private relay: ConnectionState = "unknown";
  private relayReachability: ReachabilityState = "unknown";
  private pingMs: number | null = null;
  private statusUpdatedAt: string;
  private profileRefreshGeneration = 0;
  private relayRefreshGeneration = 0;

  constructor(private readonly options: StationStatusOptions) {
    this.fetchImpl = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
    this.statusUpdatedAt = new Date(this.now()).toISOString();
  }

  async refreshProfile(): Promise<void> {
    const generation = ++this.profileRefreshGeneration;
    const outcome = await this.options.doctor();
    const profile = outcome.ok ? recordValue(outcome.data) : null;
    if (generation !== this.profileRefreshGeneration) return;

    this.profile = profile;
    this.profileState = profile
      ? "verified"
      : outcome.code === "SPAWN_ERROR" || outcome.code === "CLI_TIMEOUT"
        ? "unknown"
        : "unverified";
    this.touch();
  }

  async refreshRelayReachability(): Promise<void> {
    const generation = ++this.relayRefreshGeneration;
    const startedAt = this.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.options.healthTimeoutMs ?? 3_000);
    let relayReachability: ReachabilityState = "unreachable";
    let pingMs: number | null = null;
    try {
      const response = await this.fetchImpl(`${this.options.relayUrl}/health`, { signal: controller.signal });
      if (response.ok) {
        relayReachability = "reachable";
        pingMs = Math.max(0, this.now() - startedAt);
      }
    } catch {
      // Keep the unreachable defaults for network failures and timeouts.
    } finally {
      clearTimeout(timeout);
    }

    if (generation !== this.relayRefreshGeneration) return;
    this.relayReachability = relayReachability;
    this.pingMs = pingMs;
    this.touch();
  }

  recordPoll(outcome: CliOutcome): void {
    if (outcome.ok) this.relay = "connected";
    else if (outcome.code === "RELAY_UNAVAILABLE" || outcome.code === "CLI_TIMEOUT" || outcome.code === "SPAWN_ERROR") {
      this.relay = "disconnected";
    } else {
      this.relay = "unknown";
    }
    this.touch();
  }

  snapshot(): StationStatusSnapshot {
    return {
      profile: this.profile,
      profileState: this.profileState,
      relay: this.relay,
      relayReachability: this.relayReachability,
      relayUrl: this.options.relayUrl,
      pingMs: this.pingMs,
      statusUpdatedAt: this.statusUpdatedAt,
    };
  }

  private touch(): void {
    this.statusUpdatedAt = new Date(this.now()).toISOString();
  }
}
