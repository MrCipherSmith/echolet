# How the apps/cli e2e contention fix may and may not be done

Version: 0.2.0
Type: constraint
Status: accepted
Confidence: high

## Summary

Two measured, self-inflicted contention sources remain in `apps/cli/test/e2e/`:
six concurrent `go build` of the identical relay binary, and seven-way file
parallelism. Both have an obvious fix and both obvious fixes break something
specific, so neither may be applied without addressing the hazard named here.

## Details

**Source (a): six suites each build the same relay binary.** Every suite except
`init-relay-url.test.ts` runs its own `go build` from its own `beforeAll`, into
its own `mkdtemp` directory. Measured durations, all firing simultaneously at run
start — which is exactly when the worker RPC channel is most congested — were
4259, 5398, 5471, 5519, 6496 and 6623ms.

> Hazard: the natural fix is the precedent already in this package —
> `apps/cli/test/globalSetup.ts` builds `dist/cli.js` exactly once, and its own
> comment records the "partially rewritten bundle" race that motivated it. But
> moving the relay build there **unconditionally makes the Go toolchain a hard
> dependency of every `vitest run`**, including `vitest run src/commands`, which
> needs no relay at all. It therefore needs a conditional or per-project
> `globalSetup`, not a straight move.

**Source (b): all seven e2e files run in parallel.** Sampled peak on a 10-core
machine: 7 relay processes + 8 CLI children + 6 Go toolchain processes
concurrently, driving load1 to 194-204 from the e2e suite alone.

> Hazard: the right lever is a project-scoped `fileParallelism: false` for
> `test/e2e/**`. On **vitest 3.0.8** that means a `vitest.workspace.ts`
> (`test.projects` is 3.2+). A naive two-project split runs `globalSetup` **per
> project**, which would rebuild `dist/cli.js` concurrently and reintroduce
> precisely the race `globalSetup.ts` exists to prevent.

**Do not expect this to fix the worker-RPC starvation.** See
[[vitest-worker-rpc-timeout-is-a-fixed-60s-and-not-configurable]]: load1 was
measured at 600-790 with three concurrent foreign `vitest` runs, against ~200
from this suite alone, so the dominant contributor is outside the repository's
control.

**A cost figure that is deliberately missing.** T17 attempted a
parallel-versus-`--fileParallelism=false` comparison to price (b) and abandoned
it unmeasured: the parallel arm took 2206s and ambient load1 rose from 163 to 578
during it because other agents started their own runs, so the arms were not
comparable. **If you need the serialisation cost, measure it on a quiet machine**
— do not quote a number from T17, because T17 does not have an honest one.

## Provenance

- Source: T17 investigation (`003-T17-tests`)
- Link: `.metaproject/flows/003-2026-09-07-echolet-residuals-and-tui/t17-e2e-contention-report.md` §6; finding `003-T17-tests#F-002`
- Created: 2026-09-09
- Updated: 2026-09-09

## Related Scopes

- Module: apps/cli
- Entity: e2e test harness
- Files: apps/cli/test/globalSetup.ts, apps/cli/vitest.config.ts, apps/cli/test/e2e/
- Skills: testing

## Tags

vitest, cpu-contention, e2e, go-toolchain, test-infrastructure

## Changelog

- 0.1.0 - Initial version, from T17's measurement of the e2e suite's own contention.
