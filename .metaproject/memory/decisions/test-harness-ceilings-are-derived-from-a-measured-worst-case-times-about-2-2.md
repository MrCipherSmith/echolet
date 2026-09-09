# Test harness ceilings are derived from a measured worst case times about 2.2

Version: 0.2.0
Type: decision
Status: accepted
Confidence: high

## Summary

Every process-spawning timeout in this repository's test harness is set to about
2.2x a *directly measured* worst-case duration under reproducible CPU contention,
documented in place with the measurement — never tuned upward until the red went
away. Four incidents now follow this convention (T42-F-001, T16, T40, T17), and
the rule that keeps biting is: **a scope must measure its own children, not
inherit another scope's number for the same command name.**

## Details

**The rule.** Instrument the real durations, take the worst case under real
contention, multiply by roughly 2.2, put the constant in
`apps/cli/test/childProcessTimeouts.ts` with the raw numbers and the method beside
it.

**The constants and what each is derived from:**

| constant | value | derived from | ratio |
|---|---|---|---|
| `testTimeout` / `hookTimeout` (vitest.config.ts, T42-F-001) | 30_000 | ~9.9s on a saturated host | ~3x |
| `CLI_CHILD_TIMEOUT_MS` (T16) | 45_000 | 20352ms — worst `relay publish` in `src/commands/` | 2.21x |
| `CLI_TEST_TIMEOUT_MS` (T16) | 90_000 | ~47s worst whole-test in `src/commands/` | ~2x |
| `E2E_TEST_TIMEOUT_MS` (T40) | 300_000 | 124217ms worst whole-test in `test/e2e/` | ~2.4x |
| `E2E_CHILD_TIMEOUT_MS` (T17) | 150_000 | 69465ms — worst single child in `test/e2e/` | 2.16x |
| `E2E_RELAY_READY_TIMEOUT_MS` (T17) | 60_000 | 4459ms worst `relayReady()` | 13x |

**The mistake this convention exists to prevent, and how it recurred.** T40
extended `CLI_CHILD_TIMEOUT_MS` (45000) to the `test/e2e/` per-child watchdogs on
the strength of T16's measurement of `relay publish`. That measurement was taken
in `src/commands/`, against an **in-process mock relay**. T40 did measure e2e
*whole-test* durations — which is why `E2E_TEST_TIMEOUT_MS` is sound and unchanged
— but never measured the e2e *children*. T17 instrumented every `command()` helper
and recorded **932 real child durations** across two loaded runs:

```
p50 1588ms   p90 14066ms   p95 19459ms   p99 38855ms   max 69465ms
```

Eight of the 932 children ran past 45000ms:

- `relay publish` in `prekey-pool-replenishment` — 47889ms and 48025ms. These go
  through the base `command()` default, so they were **real breaches**: children
  SIGKILLed mid-flight while doing genuine work.
- `poll` in `flood-closure` — six samples, 48899-69465ms. These survived only
  because that file keeps a larger private literal on its own `poll()` helper
  (120000ms, reached 58% of the way), while every other child in the same file sat
  behind 45000ms.

That split is the argument for the change, more than the two breaches are: whether
a correct child lived or died depended on which helper routed it, not on what it
did. For scale, 45000ms sat at about the **p99** of correct behaviour in this
directory; the pre-T40 literals (20000/30000ms) sat at about the **p95**.

The e2e `relay publish` is **2.4x** the `src/commands/` figure for the same command
*name*, because it is not the same workload: a real Go relay process over real
loopback HTTP (TLS in `relay-tls`), several suites orchestrating multiple processes
at once. Where T17's and T40's measurements overlap they agree (heavy suites
124826-152610ms against T40's 124217ms), which is what makes the disagreement about
the *child* number credible rather than a measurement artefact.

**So: same command name, different scope, different number.** Keep the constants
separate. Folding `CLI_CHILD_TIMEOUT_MS` and `E2E_CHILD_TIMEOUT_MS` into one would
mean either a 45000ms wall that `test/e2e/` measurably breaches, or a 150000ms wall
for CLI-only suites whose worst child is 20.4s.

**Two structural rules the measurements forced, not preferences:**

1. **A per-test ceiling must stay above the per-child watchdog**, so a hung child
   is reported by the specific, actionable message (`E2E child timeout`,
   `CLI child timed out`) rather than by vitest's generic per-test timeout, which
   names no child. `E2E_TEST_TIMEOUT_MS` (300000) stays 2x `E2E_CHILD_TIMEOUT_MS`.
2. **Raising the watchdog alone is not enough.** In T17's before/after, the
   formerly killed test passed at 59175ms against an *old test ceiling of 60000ms* —
   825ms of margin. Raising only the child watchdog would have moved the false
   failure onto the generic timeout at the next flicker of load.

**Watch for nested helpers.** The applicable ceiling is not always the base
`command()` default: `flood-closure.test.ts` and `rewalk-crash-safety.test.ts` have
`runRaw`/`run`/`poll`/`killPollAfterPages` wrappers with their own `timeoutMs`
defaults that override it. Enumerate all four syntactic forms — `timeoutMs = N`
defaults (base *and* nested), `}, N);` closers, explicit `, N)` call-site
arguments, and scenario-table `timeoutMs: N` entries — and classify each by reading
the helper it belongs to.

**Never lower a ceiling while unifying.** T17 left `rewalk`'s 180000ms
`pollOnce`/`interruptPollAtPage` defaults alone because folding them into the
150000ms constant would have narrowed them, and left `holdPollAfter` (120000ms)
alone because it is a proxy-hold ceiling, not a child watchdog at all.

**Leave adequate ceilings alone, and record the margin that says so.** Measured in
T17: relay teardown worst 519ms against 4000/6000ms (8-11x); one `go build` worst
6623ms against 150000-240000ms hook ceilings (22-36x); `relay-tls`'s 3000ms
`httpsGet`/`servedFingerprint` are HTTPS request ceilings, not child watchdogs, and
were never instrumented — measure before touching them.

## Provenance

- Source: T42-F-001, T16 (`003-T16-tests`), T40, then T17 (`003-T17-tests`)
- Link: `t16-contention-report.md` §3; `t40-suite-regression-report.md`; `t17-e2e-contention-report.md` §3, §4 — all under `.metaproject/flows/003-2026-09-07-echolet-residuals-and-tui/`
- Created: 2026-09-09
- Updated: 2026-09-09

## Related Scopes

- Module: apps/cli
- Entity: test harness timeouts
- Files: apps/cli/test/childProcessTimeouts.ts, apps/cli/vitest.config.ts, apps/cli/test/e2e/
- Skills: testing

## Tags

vitest, timeouts, flaky-tests, cpu-contention, convention

## Changelog

- 0.1.0 - Initial version, consolidating the convention across T42-F-001, T16, T40 and T17.
