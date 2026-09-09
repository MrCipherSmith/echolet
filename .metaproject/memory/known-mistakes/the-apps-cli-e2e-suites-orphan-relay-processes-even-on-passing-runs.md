# The apps/cli e2e suites orphan relay processes even on passing runs

Version: 0.2.0
Type: known-mistake
Status: accepted
Confidence: high

## Summary

The `apps/cli/test/e2e/` suites leave real relay processes running after the test
run ends, holding loopback ports indefinitely. This is not only a consequence of
killed workers: a fully passing run (7/7 files, 30/30 tests, exit 0) still left
two relays reparented to `pid 1`.

## Details

Observed at four points in one session, on a 10-core machine:

| when | relays still alive |
|---|---|
| before any run in the session (debris from earlier runs, 55-60 min old) | 4 |
| after a whole-package `vitest run` | 6 |
| after a fully passing `vitest run test/e2e` | 2, both with `ppid 1` |

The last row is the important one. A worker killed by the RPC timeout
([[vitest-worker-rpc-timeout-is-a-fixed-60s-and-not-configurable]]) never reaches
`afterAll`, which explains *some* leaks — but a run where every test passed
leaked as well. So **at least one relay in `flood-closure.test.ts` and
`prekey-pool-replenishment.test.ts` is reachable by a path that never runs
through `stop()`.** Their `$TMPDIR` data directories were left behind intact too.

Because it happens on a *passing* run, it is invisible in CI output and
accumulates silently across runs on a developer machine — and every leaked relay
then contributes background load to the next run, feeding the contention problem
in [[how-the-apps-cli-e2e-contention-fix-may-and-may-not-be-done]].

**How to find the leaks** (attribute before killing anything — other agents may
have live runs on the same machine):

```bash
ps -Ao pid,ppid,etime,command | awk '/e2e-.*\/relay/ && $2==1'
```

Each survivor is attributable to a suite by its `mkdtemp` prefix
(`echolet-flood-closure-e2e-*`, `echolet-prekey-pool-e2e-*`,
`echolet-rewalk-crash-e2e-*`, `echolet-claimability-e2e-*`) and to a run by
comparing its elapsed time against that run's start time. A relay whose `ppid` is
a live `vitest` process belongs to somebody's running suite — leave it alone.

**Suggested fix.** Audit the relay lifecycle helpers in the two named suites for a
spawn path that bypasses `stop()`, and make teardown unconditional: track every
relay the suite spawns in a list and kill all of them from `afterEach`/`afterAll`,
rather than relying on the happy path. Note `relay-tls.test.ts` also has a
`startRelay()` helper, separate from its `stop()`, that spawns relays outside the
single-relay pattern the other suites use.

This is a suite-teardown change, not a ceiling change, which is why T17 left it
out of its timeout-scoped diff.

## Provenance

- Source: T17 investigation (`003-T17-tests`)
- Link: `.metaproject/flows/003-2026-09-07-echolet-residuals-and-tui/t17-e2e-contention-report.md` §1, §6; finding `003-T17-tests#F-003`
- Created: 2026-09-09
- Updated: 2026-09-09

## Related Scopes

- Module: apps/cli
- Entity: e2e relay lifecycle
- Files: apps/cli/test/e2e/flood-closure.test.ts, apps/cli/test/e2e/prekey-pool-replenishment.test.ts, apps/cli/test/e2e/relay-tls.test.ts
- Skills: testing

## Tags

e2e, process-leak, teardown, relay, resource-leak

## Changelog

- 0.1.0 - Initial version, from T17's direct process-ancestry observation.
