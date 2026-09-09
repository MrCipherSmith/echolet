# Vitest worker RPC timeout is a fixed 60s and not configurable

Version: 0.2.0
Type: constraint
Status: accepted
Confidence: high

## Summary

`Error: [vitest-worker]: Timeout calling "onTaskUpdate"` is birpc's hard-coded
60s ceiling on the worker-to-main round trip. No vitest option changes it, so no
timeout this repository owns can prevent it — and when it fires, the affected
file's results never arrive and the run still prints a green-looking summary.

## Details

Verified by walking vitest 3.0.8's own bundle call site by call site:

- `vitest/dist/chunks/rpc.TVf73xOu.js:61` raises the message from
  `onTimeoutError`, inside `createRuntimeRpc`.
- Its only caller is `vitest/dist/worker.js:98`, via
  `worker.getRpcOptions(ctx)`.
- For the forks pool this package uses, that is
  `vitest/dist/workers/forks.js:20` → `createForksRpcOptions(v8)`.
- `vitest/dist/chunks/utils.Cn0zI1t3.js:29` — `createForksRpcOptions` returns
  only `serialize` / `deserialize` / `post` / `on`. **No `timeout` is passed.**
- So birpc's default applies: `vitest/dist/chunks/index.68735LiX.js:1`,
  `const DEFAULT_TIMEOUT = 6e4;`, used at line 19 as `timeout = DEFAULT_TIMEOUT`.

`testTimeout`, `hookTimeout` and every hand-rolled per-child watchdog are
irrelevant to it. It fires when the machine is saturated enough that the main
process cannot answer within a minute.

**The dangerous part is the reporting, not the timeout.** When a worker is torn
down this way, its file reports nothing and vitest counts it under the
parenthesised total rather than as a failure. A real observed run:

```
 Test Files  50 passed (52)
      Tests  252 passed (273)
     Errors  6 errors
```

Zero tests assert-failed (`grep -c '^ ×'` = 0). The two silent files were
`apps/cli/src/runtime/inbound.test.ts` (11 tests) and
`apps/cli/src/runtime/inbound.batchIsolation.test.ts` (8 tests); 21 tests went
unreported. A reader skimming that summary sees "passed" twice.

**How to diagnose it** (do not assume which file is at fault): vitest prints
`This error originated in "<file>" test file.` for each unhandled error. Then
cross-check by extracting per-file `✓ <file> >` counts from a `--reporter=verbose`
log and comparing against `npx vitest list`, which isolates the files that
reported nothing.

**What can actually be done about it**, in order of value:

1. Make the under-report loud — fail the run when reported test count is below
   collected test count, so a starved worker cannot be mistaken for a pass.
2. Lower peak saturation (see [[how-the-apps-cli-e2e-contention-fix-may-and-may-not-be-done]]).

Note that (2) alone is not sufficient: measured on a 10-core machine, load1
reached 600-790 when other agents ran this same suite concurrently, against
about 200 from the e2e suite alone. The dominant contributor is external to the
repository, which is why (1) matters more than (2).

## Provenance

- Source: T17 investigation (`003-T17-tests`)
- Link: `.metaproject/flows/003-2026-09-07-echolet-residuals-and-tui/t17-e2e-contention-report.md` §1; finding `003-T17-tests#F-001`
- Created: 2026-09-09
- Updated: 2026-09-09

## Related Scopes

- Module: apps/cli
- Entity: vitest test harness
- Files: apps/cli/vitest.config.ts, apps/cli/src/runtime/inbound.test.ts, apps/cli/src/runtime/inbound.batchIsolation.test.ts
- Skills: testing

## Tags

vitest, flaky-tests, cpu-contention, reporting, tooling-limitation

## Changelog

- 0.1.0 - Initial version, from T17's attribution of the reported apps/cli failures.
