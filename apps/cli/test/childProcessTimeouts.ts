/**
 * Shared timeouts for every suite in this package that does real work: the suites under
 * `apps/cli/src/commands/*.test.ts` and `apps/cli/test/e2e/*.test.ts` that spawn the real CLI
 * binary as a child process (real libsignal crypto, real encrypted-SQLite I/O, real HTTP against
 * an in-process mock relay or the real relay binary), and the suites under
 * `apps/cli/src/runtime/` that mint a full prekey pool in-process.
 *
 * T16 (flow 003): these suites failed under CPU contention — never alone — and each false failure
 * cost someone a re-run in isolation to prove it wasn't a regression. Root cause was a per-child
 * `SIGKILL` watchdog hard-coded to 15000ms (8000ms in cli.processFailures.test.ts), copied
 * independently into five files, sized for an idle machine and never revisited when the
 * project-wide `it()`/hook headroom was raised for the same reason (see vitest.config.ts,
 * T42-F-001). It was not a flaky assertion: every failure was the child being SIGKILLed mid-flight
 * ("CLI child timed out", or `timedOut: true` / `code: null` surfacing through each suite's own
 * assertions) while doing genuine, still-progressing work.
 *
 * Measured, not guessed. Reproduced with the full monorepo test suite (`pnpm -r test`) plus
 * synthetic CPU load running concurrently on a 10-core machine — the same kind of contention two
 * more agents working on this repository at once already produce — all five suites under
 * `src/commands/` failed this way in a single run. Re-measured in isolation with the same
 * reproduction (70 CPU-bound busy loops, ~7x core oversubscription, all five suites running
 * concurrently the way vitest's own worker pool schedules them): the heaviest single CLI
 * invocation in these suites, `relay publish` (mints and signs LIMITS.PREKEY_MIN_COUNT prekey
 * bundles in one process), consistently needed ~19.7-20.4s of genuine wall-clock time; every
 * lighter command (`init`, `doctor`, `history`, `contact`, `send`, `poll`) stayed under 5s even
 * under that load. Whole-test totals (several children chained in one `it()`) peaked at ~47s under
 * the same reproduction, all of it real, completed work.
 *
 * `CLI_CHILD_TIMEOUT_MS` carries just over 2x the worst measured single-child duration (~20.4s):
 * enough margin to absorb run-to-run variance in contention without asking a genuinely hung child
 * to wait a minute to be killed.
 *
 * `CLI_TEST_TIMEOUT_MS` carries roughly 2x the worst measured whole-test duration (~47s) under the
 * same reproduction, so a test chaining several children — one of which may be the ~20s
 * `relay publish` call — has room to complete for real instead of being cut off by the enclosing
 * `it()` before the per-child watchdog ever gets a chance to report the specific, actionable
 * failure. It must stay comfortably above `CLI_CHILD_TIMEOUT_MS` so a truly stuck child is still
 * reported as "CLI child timed out" (or the local equivalent) rather than surfacing as vitest's
 * generic per-test timeout.
 *
 * On an idle machine neither number is ever approached — these are ceilings, not delays, and
 * change no test's real duration when nothing else is competing for CPU. Reproduction script and
 * measurements: `.metaproject/flows/003-2026-09-07-echolet-residuals-and-tui/t16-contention-report.md`.
 *
 * T40 (flow 003) extended these to the two places T16 named as out of its scope but flagged as the
 * same defect: `apps/cli/test/e2e/`, whose per-child watchdogs were 20000/30000ms — at or BELOW the
 * 19655-20352ms T16 measured for the very same `relay publish` child — and the `src/runtime/`
 * publish suites, whose per-test ceilings were written when `publish()` minted ONE bundle and were
 * never revisited when T26 made it mint `LIMITS.PREKEY_MIN_COUNT` (20) of them.
 *
 * Re-measured for T40 under T16's identical reproduction (70 CPU-bound busy loops on this 10-core
 * machine, ~7x oversubscription; 1-minute load averages 180-290 with the suite's own load on top).
 * Two independent runs: the first with every ceiling temporarily raised far out of the way, so the
 * number recorded is the real duration rather than the wall it hit; the second against these
 * constants. Quiet baseline in brackets, from a full green `vitest run` on the same tree
 * (52 files, 273 tests, 243.76s):
 *
 *   test/e2e/publication-claimability          120798 / 124217ms  [24283ms]  ceiling was 90000 — OVER
 *   test/e2e/two-process (worst of 3)           96643 / 101442ms  [20223ms]  ceiling was 90000 — OVER
 *   src/runtime/outbound.senderAuthentication   21310 /  21510ms   [5037ms]  ceiling was 30000
 *   src/runtime/outbound.publish                19151 /  19125ms   [4219ms]  ceiling was 30000
 *
 * The contention factor is 4.2-5.0x for these short, crypto-bound tests and 2.4-2.7x for the long
 * relay-bound ones (`flood-closure`'s 8000-poison case, `prekey-pool-replenishment`), which is why
 * those two keep their own individually measured ceilings and are not covered by the constants here.
 *
 * `E2E_TEST_TIMEOUT_MS` is bounded below by 2x the worst measured end-to-end whole-test duration
 * (124217ms, so 248434ms) and is the smallest value at or above that which this directory already
 * uses (`flood-closure`'s 4x49 volume), so no new magnitude enters the tree. It is bounded above by
 * the requirement that a genuinely stuck end-to-end test still fail within five minutes. It is the
 * FLOOR for every per-test ceiling under `test/e2e/`; the tests that already declare more
 * (300000-900000ms) keep the numbers their own recorded measurements justify. It stays 6.7x above
 * `CLI_CHILD_TIMEOUT_MS`, which fires first and reports the specific, actionable "E2E child
 * timeout" rather than vitest's generic per-test timeout.
 *
 * `CLI_TEST_TIMEOUT_MS` also covers the two `src/runtime/` suites that publish a full pool
 * in-process and spawn nothing: 90000ms is 4.2x their worst measured 21510ms, and reusing the
 * package's existing per-test ceiling adds no number for them either. Those two were not over their
 * old 30000ms wall in this reproduction (they reached 64-72% of it); the wall was written when
 * `publish()` minted ONE bundle, T26 made it mint twenty, and a 28% margin is not a ceiling.
 *
 * T40 measurements and the load samples behind them:
 * `.metaproject/flows/003-2026-09-07-echolet-residuals-and-tui/t40-suite-regression-report.md`.
 */
export const CLI_CHILD_TIMEOUT_MS = 45_000;
export const CLI_TEST_TIMEOUT_MS = 90_000;
export const E2E_TEST_TIMEOUT_MS = 300_000;
