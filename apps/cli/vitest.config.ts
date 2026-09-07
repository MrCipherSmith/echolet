import { defineConfig } from "vitest/config";

// The CLI binary is built once per run, before any suite spawns it. See test/globalSetup.ts.
export default defineConfig({
  test: {
    globalSetup: ["./test/globalSetup.ts"],
    // Harness headroom, not a product allowance. These suites do real libsignal
    // crypto and real encrypted-SQLite I/O; a single test costs ~0.5-1.4s on an
    // idle machine but has been measured at ~4s under deliberate CPU load and
    // ~9.9s on a saturated CI-like host. Vitest's 5000ms default therefore turned
    // a correct suite red intermittently (T42-F-001). 30000ms is ~3x the worst
    // observed loaded duration and matches the lowest per-test timeout the
    // sibling suites already declare, so it adds no new number to this app.
    // Per-test timeouts passed as the third argument to it() still win, so the
    // 40000-90000ms values in cli.processFailures / inbound.batchIsolation /
    // outbound.concurrentSend / test/e2e are unchanged. It is deliberately short
    // enough that a genuinely stuck test still fails within half a minute.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
