# vitest 3.0.8 loses whole test-file reports under load

Version: 0.2.0
Type: constraint
Status: accepted
Confidence: high

Recorded-At: 2026-09-09
## Summary

Under CPU oversubscription, vitest 3.0.8's worker-to-main birpc call
`onTaskUpdate` hits a hardcoded 60 s deadline. Whole test FILES then never
report: the run exits 1 with **zero failing tests**, and no vitest configuration
option can move that ceiling. This has cost the project a day twice — flow 003
(2026-09-08) and flow 004 T31 (2026-09-09). Read this before spending a third
day on it.

## Details

**Signature.** `Error: [vitest-worker]: Timeout calling "onTaskUpdate"` in an
Unhandled Errors block, an `Errors N errors` line, and a `Test Files` tally
whose reported count is short of its collected total — with `Tests ... passed`
and nothing failed:

```
apps/cli test:  Test Files  75 passed (77)
apps/cli test:       Tests  496 passed (517)
apps/cli test:      Errors  5 errors
exit 1
```

Measured three times with identical numbers on 2026-09-09 (10-core Mac also
carrying the operator's VM and browser; load averages 11.22 / 29.17 / 57.96).
The same tree with `--no-file-parallelism`: 77 of 77 files, 517 of 517 tests,
exit 0, 504 s against 296 s. The two files that lost their reports —
`apps/cli/src/runtime/inbound.test.ts` and
`apps/cli/src/runtime/inbound.batchIsolation.test.ts` — pass in isolation:
2 files, 21 tests, exit 0. 496 + 21 = 517.

**It is not a flaky test and not machine noise.** It is a starved worker missing
an RPC deadline. `apps/cli` crossing 77 test files is what turned an occasional
loss into a reliable one; below that size it appeared only under deliberate
load (flow 001 T43 saw it at ~30x oversubscription and nowhere else).

**Do not diagnose it from the error text.** vitest prints
`This error originated in "<file>"`, which names the file whose worker was
blocked. In the 2026-09-09 runs that was not the same set as the files that
lost their reports. The only sound way to name the lost files is
`vitest list --filesOnly` minus the files that printed a report line.

**Do not "fix" it by running the gate serially.** The parallel run is the only
thing in this project that stresses cross-file interference; a serial gate is
greener and weaker. Speed is not the objection — coverage is.

**Do not treat a lost report as a pass.** From outside, a lost report and a
hidden failure are the same observation.

**What the project does instead** (flow 004 / T31, `scripts/gate/js-suite.sh`):
the push gate runs the suite exactly as before, compares the files that reported
against the test files vitest resolves on disk, and re-runs precisely the
unreported files serially, requiring them to be green. A failing test still
blocks untouched, because a failing file *reports* — a real failure is the
presence of a line, a lost report is its absence. `pnpm run gate:selftest`
rows L1-L9 pin every state.

**Related trap, same day.** `keryx test analyze` run from the main checkout
walks `.claude/worktrees/`, so registered agent worktrees are counted as extra
test files (234 files, three copies of the same suite). keryx's testing scan
`IGNORED_DIRS` omits `.claude` where other modules' `IGNORE_DIRS` includes it.
Regenerate `.metaproject/data/testing/context.md` from a throwaway
`git worktree add --detach` of HEAD instead; the correct census on 2026-09-09
is 91 test files, 77 of them in `apps/cli`.

## Provenance

- Source: flow 004 / T31 (push gate completion), diagnosis first recorded in
  flow 003 T40 and flow 001 T43
- Link: .metaproject/flows/003-2026-09-07-echolet-residuals-and-tui/t40-suite-regression-report.md
- Created: 2026-09-09
- Updated: 2026-09-09

## Related Scopes

- Module: testing, push gate
- Entity: apps/cli vitest suite
- Files: scripts/gate/js-suite.sh, scripts/gate/suites.sh, scripts/gate/selftest.sh, apps/cli/vitest.config.ts
- Skills: testing

## Tags

vitest, flaky-infrastructure, push-gate, test-reporting, rpc-timeout

## Changelog

- Lifecycle: draft -> accepted on 2026-09-09: Measured three times on 2026-09-09 with identical numbers; the gate step and its self-test rows are in the tree.
- 0.1.0 - Initial version.
