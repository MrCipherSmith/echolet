# T27 full prototype verification

Version: 0.1.0

## Verdict

The Echolet CLI technical prototype passes every functional, build, type, race, graph, and documentation-link check in the T27 dispatch. Strict Code Health exits successfully with a `WARN` gate: seven P2 complexity findings reduce the score from the baseline 97 to 92, while its automatic sources skip ESLint and TypeScript and report tests as missing. Direct workspace TypeScript and strict test commands pass independently. No implementation, test, flow-state, or frozen acceptance file was changed during verification.

## Environment

- Platform: macOS arm64
- Node: 26.5.0; CLI build target and package engine floor: Node 22.13
- pnpm: 10.0.0
- Go: 1.26.1
- Native Signal package: 0.102.0
- Revision: unborn `main` working tree; no commit hash exists

## Independent checks

| Label | Command | Status | Bounded evidence |
|---|---|---|---|
| `frozen_install` | `pnpm install --frozen-lockfile` | PASS | All eight workspace projects are lockfile-current. |
| `cli_build` | `pnpm --filter @echolet/cli build` | PASS | Production ESM bin build completes. |
| `workspace_typecheck` | `pnpm typecheck` | PASS | All seven TypeScript workspace packages complete without errors. |
| `cli_process` | focused process-level Vitest command | PASS | Six of six independent process-contract tests pass. |
| `workspace_tests` | `pnpm test` | PASS | 82 tests pass across protocol, client DB, crypto, client core, session node, mobile, and CLI. CLI contributes 37, including three E2E iterations. |
| `e2e_3_iterations` | `pnpm --filter @echolet/cli test:e2e` | PASS | Three of three clean real relay/two-profile process runs pass. |
| `go_untagged` | `go -C apps/relay test ./...` | PASS | All untagged relay packages pass. |
| `relayv2_race` | uncached `go -C apps/relay test -race -count=1 -tags=relayv2 -timeout=90s ./...` | PASS | Handler, router, repository, and validation packages pass under the race detector. |
| `metaproject_test_strict` | `keryx test run --strict` | PASS | Exit 0 and normalized project PASS. The adapter reports aggregate count 2; the independent workspace run records the actual 82 tests. |
| `health_strict` | `keryx health run --strict` | WARN | Exit 0; score 92, seven P2 complexity findings, no P0/P1. ESLint and TypeScript are auto-skipped and tests are marked missing by this adapter. |
| `graph_rebuild` | `keryx gdgraph build` | PASS | Graph contains 70 nodes and 104 edges. |
| `graph_cycles` | `keryx gdgraph query cycles` | PASS | No cycles found. |
| `wiki_links` | `keryx wiki check-links` | PASS | 19 pages and 38 internal links checked; zero broken links. |

## Required measurements

- Clean real end-to-end runs: 3/3 pass independently and another 3/3 inside the workspace suite.
- Concurrent relay allocation and idempotency: relay-v2 tagged race suite passes uncached.
- Shared invalid contract corpus: TypeScript workspace and Go validation suites pass.
- Restart, offline delivery, exact retry, acknowledgement recovery, deduplication, history, and bounded leakage assertions: all three real E2E iterations pass.
- Known sensitive fixture values are excluded from this report; evidence is limited to counts, labels, exit status, and artifact paths.

## Limitations

The strict health adapter cannot execute ESLint because workspace packages do not expose runnable lint scripts, and it fails to associate the independently passing TypeScript and test commands with its required sources. Its seven reported findings are P2 complexity warnings. This gate establishes the reviewed local technical prototype behavior; it does not establish production security, public deployment readiness, mobile delivery, user demand, or an independent cryptographic audit.

## Evidence

- Frozen install: `.metaproject/data/gdctx/raw/2026-09-06T12-06-43-755Z_run.log`
- CLI build: `.metaproject/data/gdctx/raw/2026-09-06T12-06-44-323Z_run.log`
- Workspace typecheck: `.metaproject/data/gdctx/raw/2026-09-06T12-07-05-184Z_run.log`
- CLI process tests: `.metaproject/data/gdctx/raw/2026-09-06T12-07-11-564Z_run.log`
- Workspace tests: `.metaproject/data/gdctx/raw/2026-09-06T12-08-36-207Z_run.log`
- Independent E2E: `.metaproject/data/gdctx/raw/2026-09-06T12-09-32-894Z_run.log`
- Go untagged: `.metaproject/data/gdctx/raw/2026-09-06T12-07-02-155Z_run.log`
- Relay-v2 race: `.metaproject/data/gdctx/raw/2026-09-06T12-10-02-960Z_run.log`
- Strict testing: `.metaproject/data/gdctx/raw/2026-09-06T12-11-06-911Z_run.log`
- Strict health: `.metaproject/data/gdctx/raw/2026-09-06T12-11-35-120Z_run.log`
- Graph rebuild/cycles: `.metaproject/data/gdctx/raw/2026-09-06T12-07-37-951Z_run.log`, `.metaproject/data/gdctx/raw/2026-09-06T12-07-38-303Z_run.log`
- Wiki links: `.metaproject/data/gdctx/raw/2026-09-06T12-06-54-254Z_run.log`

Routing audit: `graph_used: yes`, `wiki_used: yes`, `ctx_used: yes`, `raw_rg_used: no`.
