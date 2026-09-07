# T37 full prototype re-verification after the T33-T36 review fixes

Version: 0.2.0

This file holds two attempts. **Attempt 2 (below) is the current result.** Attempt 1 is preserved
verbatim further down because it is the record that found blocker F-013; it is superseded, not
withdrawn.

---

# Attempt 2 — 2026-09-06T15:05Z-15:15Z, after the T39 fix for F-013

## Verdict (attempt 2)

**Status: PASS (gate satisfied; one non-blocking WARN).** Every check in the T27 matrix, plus the
two additional checks this dispatch required, was re-run independently on the current working tree.
All of them pass. The workspace suite was executed **three times** and was green all three times,
and two further complete executions of the CLI suite (unfiltered) and the dedicated E2E script were
also green — five complete, unfiltered executions in total, 15/15 clean end-to-end iterations.

`keryx health run --strict` reports **WARN** (exit 0, score 93, seven P2 complexity findings, no
P0/P1). It reported WARN at T27 as well; it is an advisory adapter result, not a required check of
the acceptance gate in `metrics-and-validation.md`, and it does not block.

The F-013 class is **closed** — see the dedicated section below, which is based on a direct probe of
the built binary, not only on the test suite.

```text
Acceptance target: echolet-cli-prototype
Revision: working tree at /Users/Goodea/goodea/projects/echolet (unborn main, no commit hash)
Environment: macOS arm64, Node v26.5.0, pnpm 10.0.0, go1.26.1 darwin/arm64, @signalapp/libsignal-client 0.102.0
Status: PASS
Checks: 18 checks executed, 17 PASS, 1 WARN (advisory health adapter), 0 FAIL
Metrics: all ten required measurements meet their thresholds
Failures: none
Artifacts: .metaproject/data/gdctx/raw/2026-09-06T15-*.log (per-check paths listed under Evidence)
Decision: accepted as technical prototype
```

## Environment (attempt 2)

- Platform: macOS (Darwin) arm64
- Node: v26.5.0; pnpm 10.0.0; Go go1.26.1 darwin/arm64
- Native Signal package: `@signalapp/libsignal-client` 0.102.0
- Revision: unborn `main`. `git rev-parse HEAD` → `fatal: ambiguous argument 'HEAD': unknown
  revision`. The working tree is the revision identifier. No commit was created.

## Independent checks (attempt 2)

| Label | Command | Status | Bounded evidence |
|---|---|---|---|
| `frozen_install` | `pnpm install --frozen-lockfile` | PASS | Exit 0; all 8 workspace projects lockfile-current ("Already up to date"). |
| `cli_build` | `pnpm --filter @echolet/cli build` | PASS | Exit 0; production ESM bin build completes. |
| `workspace_typecheck` | `pnpm typecheck` | PASS | Exit 0; all 7 TypeScript workspace packages `Done`, no errors. |
| `cli_process` | `pnpm --filter @echolet/cli exec vitest run src/commands/cli.test.ts` | PASS | Exit 0; 1 file / 6 tests. |
| `cli_dash_options` | `pnpm --filter @echolet/cli exec vitest run src/commands/cli.dashOptionValues.test.ts` | PASS | Exit 0; 1 file / **16 tests**, file unmodified (hash-verified). |
| `workspace_tests_run_1` | `pnpm test` | PASS | Exit 0; 114 tests across 7 packages; `apps/cli` 13 files / 69 tests. |
| `workspace_tests_run_2` | `pnpm test` | PASS | Exit 0; 114 tests; `apps/cli` 69 tests. |
| `workspace_tests_run_3` | `pnpm test` | PASS | Exit 0; 114 tests; `apps/cli` 69 tests. |
| `cli_suite_unfiltered` | `pnpm --filter @echolet/cli test` | PASS | Exit 0; 13 files / 69 tests, **no file or path exclusions**, E2E 3/3 in the same run as every other suite. |
| `e2e_3_iterations` | `pnpm --filter @echolet/cli test:e2e` | PASS | Exit 0; 3/3 clean real relay / two-profile process runs, unfiltered. |
| `go_untagged` | `go -C apps/relay test ./...` | PASS | Exit 0; handler, router, middleware, repository, validation all `ok` (partly from the Go build cache). |
| `go_untagged_race` | `go -C apps/relay test -race -count=1 ./...` | PASS | Exit 0, uncached; same five packages `ok` under the race detector. Additional check required by this dispatch. |
| `relayv2_race` | `go -C apps/relay test -race -count=1 -tags=relayv2 -timeout=180s ./...` | PASS | Exit 0, uncached; verbose re-run records **36 top-level tests, 0 failed, 0 skipped**. |
| `metaproject_test_strict` | `keryx test run --strict` | **PASS** | Exit 0; normalized report `PASS`, passed 2 / failed 0. Was exit 1 / FAIL in attempt 1. |
| `health_strict` | `keryx health run --strict` | WARN | Exit 0; score 93, 7 findings (P0 0, P1 0, P2 7, all complexity), gate reason `health regression 4 vs baseline`. Advisory; ESLint and TypeScript are auto-skipped by this adapter. |
| `graph_rebuild` | `keryx gdgraph build` | PASS | 78 nodes, 117 edges (T27: 70 / 104; attempt 1: 77 / 116). |
| `graph_cycles` | `keryx gdgraph query cycles` | PASS | No cycles found. |
| `wiki_links` | `keryx wiki check-links` | PASS | 19 pages, 38 internal links, 0 broken. |

### Repeated workspace runs (the attempt-1 failure was identity-dependent)

Because F-013 only manifested when a randomly generated base64url identity happened to begin with
`-`, a single green run would be weak evidence. Every complete, unfiltered execution observed in
this attempt is listed individually:

| # | Command | Exit | `apps/cli` | Workspace total | E2E iterations |
|---:|---|---:|---|---:|---|
| 1 | `pnpm test` | 0 | 13 files / 69 tests | 114 passed / 0 failed | 3/3 |
| 2 | `pnpm test` | 0 | 13 files / 69 tests | 114 passed / 0 failed | 3/3 |
| 3 | `pnpm test` | 0 | 13 files / 69 tests | 114 passed / 0 failed | 3/3 |
| 4 | `pnpm --filter @echolet/cli test` | 0 | 13 files / 69 tests | (CLI only) | 3/3 |
| 5 | `pnpm --filter @echolet/cli test:e2e` | 0 | 1 file / 3 tests | (E2E only) | 3/3 |

**0 red runs out of 5.** Attempt 1 saw 2 red out of 6. Per-package totals were identical in every
run: protocol 8, client-db 1, crypto-core 4, client-core 2, session-node 24, mobile 6, CLI 69.

## F-013 closure (attempt 2)

The T39 fix is an `inlineStringOptionValues` normalizer in `apps/cli/src/commands/cli.ts:89-102`
that rewrites `--<declared string option> <value>` into `--opt=value` before `parseArgs`.
`parseCommand` still calls `parseArgs({ …, strict: true, tokens: true })` at line 107 and still maps
any parse error to `inputFailure()`. The rewrite is narrowly scoped: only names declared
`type: "string"`, never an argument already containing `=`, never an option with nothing (or only
`--`) after it, and everything from the `--` separator onward is copied verbatim.

Independent probe of the **built binary** (`apps/cli/dist/cli.js`), outside the test suite. Only
exit status, error code and stdout line count are reported; no message bodies or key material.

| Probe | Result | Meaning |
|---|---|---|
| `send --to -DashRecipient…` | exit 3, `CONTACT_NOT_TRUSTED`, 1 stdout line | reaches the **trust layer**, not the parser |
| control: same command with the leading `-` removed | exit 3, `CONTACT_NOT_TRUSTED` | dash-leading and plain values behave identically |
| `send --text -PROBE` | exit 3, `CONTACT_NOT_TRUSTED` | dash-leading body is content, not an option |
| `history --with -DashContact…` | exit 0, `ok` | reaches the **history layer** |
| `init --relay-url -http://…` | exit 2, `INVALID_CONFIGURATION` | reaches the **configuration validator**, not the parser |
| `doctor --unknown-flag` | exit 2, `INVALID_ARGUMENTS` | still fails closed |
| `history --profile P --json --with` (value missing at end of argv) | exit 2, `INVALID_ARGUMENTS` | still fails closed |
| `send --to A --to -Dash… --text …` (repeated option) | exit 2, `INVALID_ARGUMENTS` | still fails closed |
| `send extra --to … --text …` (stray positional) | exit 2, `INVALID_ARGUMENTS` | still fails closed |
| `doctor … -- extra` (operand after `--`) | exit 2, `INVALID_ARGUMENTS` | still fails closed |
| `doctor … --` (bare trailing separator) | exit 0, `ok` | no-op, as specified |
| `bogus` (unknown command) | exit 2, `INVALID_ARGUMENTS` | still fails closed |

Every probe emitted **exactly one** JSON object on stdout, preserving the process contract.

The sixteen tests in `apps/cli/src/commands/cli.dashOptionValues.test.ts` pass **unmodified**
(hash-verified before and after this verification) — 16/16 standalone and 16/16 inside every full
suite run. They pin both halves of the contract: nine tests cover the whole class of string-valued
options (`--profile`, `--relay-url`, `--store-key-env`, `--out`, `--from`, `--to`, `--text`,
`--message-id`, `--with`) with **fixed** dash-leading literals rather than a randomly generated
identity, one covers dash-leading and flag-shaped message bodies end to end through a stub relay,
four are over-correction guards for unknown flag / missing value / repeated option / unaccepted
option and unknown command, and two cover the `--` separator.

**Verdict: the F-013 class is closed.** A dash-leading option value now reaches its intended layer,
and every invalid-input class still fails closed with exit 2.

## Build-race question (attempt 2)

- `apps/cli/vitest.config.ts:6` registers `./test/globalSetup.ts`, which runs `build.mjs` once per
  vitest run before any suite starts.
- A routed workspace search for build invocations under `apps/cli` returns exactly two sites:
  `apps/cli/test/globalSetup.ts:17` and the `build` script in `apps/cli/package.json:9`. **No suite
  rebuilds `dist/cli.js` while another suite executes it.**
- `apps/cli/src/commands/cli.processFailures.test.ts` builds a *separate* private bundle and never
  writes `dist/cli.js`.
- **Does the previously observed `INVALID_ARGUMENTS` build race recur?** No. Neither the race nor
  the symptom recurred in any of the five complete executions recorded here.

## Test integrity (attempt 2)

- 38 test files (`*.test.ts`, `*_test.go`) were hashed before the first command and re-verified
  after the last: `shasum -c` reports **38 OK / 0 FAILED**. No test, source, configuration or
  dependency file was modified during this verification.
- Routed workspace search for `it/test/describe.skip|only|todo`, `xit(`, `xdescribe(` and Go
  `t.Skip(` returns **0 real matches** (the three hits are `os.Exit(` in
  `apps/relay/cmd/relay/main.go`).
- Caveat: the baseline hash set matched `*.test.ts` and `*_test.go`; `apps/mobile`'s single
  `MessagingScreen.test.mjs` was outside that glob. Its test count (6) was identical in all three
  workspace runs, which is the only evidence offered for it.

### Test count reconciliation against T27

**T27 baseline: 82. Now: 114 (+32).** The entire difference is in `apps/cli` (37 → 69); the other
six packages are unchanged at 45 (protocol 8, client-db 1, crypto-core 4, client-core 2,
session-node 24, mobile 6).

| `apps/cli` test file | T27 | Attempt 1 | Attempt 2 | Delta vs T27 |
|---|---:|---:|---:|---|
| `src/runtime/config.test.ts` | 3 | 3 | 3 | — |
| `src/transport/relayClient.test.ts` | 3 | 3 | 3 | — |
| `src/runtime/profile.test.ts` | 6 | 6 | 6 | — |
| `src/runtime/outbound.test.ts` | 6 | 6 | 6 | — |
| `src/runtime/inbound.test.ts` | 10 | 11 | 11 | +1 |
| `src/commands/cli.test.ts` | 6 | 6 | 6 | — |
| `test/e2e/two-process.test.ts` | 3 | 3 | 3 | — |
| `src/commands/cli.processFailures.test.ts` | — | 8 | 8 | new (F-002, F-003) |
| `src/runtime/outbound.publish.test.ts` | — | 3 | 3 | new |
| `src/runtime/outbound.concurrentSend.test.ts` | — | 1 | 1 | new |
| `src/runtime/inbound.pollBatchSize.test.ts` | — | 1 | 1 | new (F-009) |
| `src/transport/relayClient.pollCapacity.test.ts` | — | 2 | 2 | new (F-009) |
| `src/commands/cli.dashOptionValues.test.ts` | — | — | 16 | new (F-013, T39) |
| **Total** | **37** | **53** | **69** | **+32** |

The +32 is 31 tests in six new files plus one added case in `inbound.test.ts`. No pre-existing test
lost a case, was renamed away, weakened, skipped or deleted. The only change since attempt 1 is the
addition of the 16 F-013 tests.

## Required measurements (attempt 2)

| Metric | Threshold | Measured | Evidence source |
|---|---|---|---|
| Clean end-to-end runs | 3/3 pass | **3/3 in all five complete executions (15/15 iterations)** | `pnpm test` x3, `pnpm --filter @echolet/cli test`, `test:e2e` — all unfiltered. |
| Concurrent claim winners | exactly 1 of at least 20 | **1 of 20**, PASS under `-race` | `TestSignalPreKeyBundleV2ConcurrentClaimsAllocateExactlyOnce`, `const claimants = 20` (`apps/relay/internal/storage/repository/prekey_bundle_v2_test.go:138`); losers assert `PREKEY_BUNDLE_UNAVAILABLE`. |
| Lost-response claim retries | same bundle bytes for same claim ID | PASS | `TestSignalPreKeyBundleV2ClaimReplayIsExactAndSelectorBound` (tagged race suite). |
| Reused OTK publications | 100% rejected across changed IDs, expiry, restart | PASS, 5 sub-cases | `TestSignalPreKeyBundleV2OneTimePreKeyReservationsArePermanent` (`new_bundle_same_otk`, `…_key_id`, `…_tuple`, after expiry, after claim and restart) — all `ONE_TIME_PREKEY_REUSED`; plus `TestSignalPreKeyBundleV2PublishIsImmutableAndIdempotent`. |
| Offline delivery | 1/1 delivered after receiver start | PASS in every E2E iteration | `two-process.test.ts:141-149` — Bob has no running process during the send; after `poll`, history length 1. |
| Sender restart exact retry | ciphertext bytes identical | PASS | `two-process.test.ts:143-145` — 2 `/v1/messages/send` bodies, byte-identical, single `/v2/prekeys/claim`; plus `outbound.publish.test.ts`. |
| Receiver duplicate history entries | 0 | **0** | `two-process.test.ts:153-155,158-160,172`; `inbound.test.ts` restart/ack-recovery case; `outbound.concurrentSend.test.ts`. |
| Known plaintext marker in relay DB/logs | 0 occurrences | **0** | `two-process.test.ts:173-174` — markers asserted absent from proxied HTTP traffic, from the relay log, and from a recursive byte scan of the whole relay data directory after the relay is stopped. Occurrence count only; no content reproduced. |
| Invalid contract cases rejected | 100% fixture corpus | **4/4 shared invalid cases**, both languages | `packages/protocol/src/types/fixtures/relay-v2.json` → `invalid_publish_requests` length 4, driving Go `TestSignalPreKeyBundleV2SharedFixtures` and TS `signalPreKeyBundleV2.test.ts` (6) + `validateDeviceRecord.test.ts` (2); plus relay-side signature/ciphertext validation tests. |
| Required Markdown versions and links | 100% | PASS | `keryx wiki check-links`: 19 pages, 38 internal links, 0 broken. |

All ten measurements meet their thresholds on this revision.

## Comparison against the T27 baseline (attempt 2)

| Item | T27 | Attempt 1 | Attempt 2 | Change vs T27 |
|---|---|---|---|---|
| `frozen_install`, `cli_build`, `workspace_typecheck`, `cli_process` | PASS | PASS | PASS | unchanged |
| `workspace_tests` | PASS, 82 tests | FAIL (intermittent), 98 | **PASS x3, 114 tests** | +32 tests, reliability restored |
| `e2e_3_iterations` | PASS 3/3 | 3/3 dedicated, 2/3 once | **3/3 in all 5 executions** | unchanged verdict, broader evidence |
| `go_untagged` | PASS | PASS | PASS | unchanged |
| `go_untagged_race` | not run | PASS | PASS | new check, green |
| `relayv2_race` | PASS | PASS | PASS (36 tests) | unchanged |
| `metaproject_test_strict` | PASS (exit 0) | FAIL (exit 1) | **PASS (exit 0)** | back to baseline |
| `health_strict` | WARN, score 92, 7 P2 | WARN, score 93, 7 P2 | WARN, score 93, 7 P2 | score +1; advisory only |
| `graph_rebuild` | 70 / 104 | 77 / 116 | 78 / 117 | new source and test files |
| `graph_cycles` | none | none | none | unchanged |
| `wiki_links` | 19 / 38 / 0 | identical | identical | unchanged |

No exclusion of any kind was applied to any run in this attempt.

## Limitations (attempt 2)

This gate establishes local technical-prototype behaviour on one macOS arm64 machine and nothing
more. It does not establish production security, safe use for sensitive communication, mobile
delivery, public deployment readiness, completion of an independent cryptographic audit, user
demand, or permanent suitability of the pinned libsignal dependency.

Specific honesty notes:

- Five green executions are evidence that the F-013 defect no longer fires; they are not proof of a
  deterministic suite. The strongest evidence for closure is the fixed-literal test suite and the
  direct binary probe, both of which are deterministic and do not depend on a randomly generated
  identity beginning with `-`.
- The probe and the suite exercise the option surface declared in `cliOptions`. A future option
  added as `type: "string"` inherits the fix automatically; one added by another route would not be
  covered by these tests.
- The strict health adapter still cannot execute ESLint (no runnable lint scripts in the workspace
  packages) and does not associate the independently passing TypeScript and test commands with its
  required sources. Its score is not an independent confirmation of lint or type health, and its
  `regression 4 vs baseline` reason reflects its own moving baseline.
- `keryx test run --strict` reports an aggregate count of 2 for a workspace that actually runs 114
  tests; the independent workspace run is the authoritative count.
- `go -C apps/relay test ./...` reported several packages as `(cached)`. The uncached evidence is
  the two `-count=1 -race` runs.
- The mobile `.test.mjs` file was outside the hashed integrity baseline (see Test integrity).
- The revision identifier is the working tree; `main` is unborn and no commit was created, so this
  result cannot be pinned to a hash.

## Evidence (attempt 2)

- Test-file hash baseline: `.metaproject/data/gdctx/raw/2026-09-06T15-05-24-211Z_run.log`
- Frozen install: `.metaproject/data/gdctx/raw/2026-09-06T15-05-31-691Z_run.log`
- CLI build: `.metaproject/data/gdctx/raw/2026-09-06T15-05-36-096Z_run.log`
- Workspace typecheck: `.metaproject/data/gdctx/raw/2026-09-06T15-05-44-447Z_run.log`
- CLI process tests: `.metaproject/data/gdctx/raw/2026-09-06T15-06-10-323Z_run.log`
- F-013 suite (16 tests, standalone): `.metaproject/data/gdctx/raw/2026-09-06T15-06-26-339Z_run.log`
- Workspace tests run 1: `.metaproject/data/gdctx/raw/2026-09-06T15-07-38-612Z_run.log`
- Workspace tests runs 2 and 3: `.metaproject/data/gdctx/raw/2026-09-06T15-09-47-851Z_run.log`
- CLI suite unfiltered + dedicated E2E: `.metaproject/data/gdctx/raw/2026-09-06T15-11-35-448Z_run.log`
- Go untagged, untagged race, relayv2 race: `.metaproject/data/gdctx/raw/2026-09-06T15-11-54-324Z_run.log`
- Relay-v2 race verbose count (36 tests): `.metaproject/data/gdctx/raw/2026-09-06T15-12-14-310Z_run.log`
- Strict testing (PASS): `.metaproject/data/gdctx/raw/2026-09-06T15-13-08-004Z_run.log`; normalized
  report `.metaproject/data/testing/artifacts/latest.md`
- Strict health (WARN): `.metaproject/data/gdctx/raw/2026-09-06T15-13-17-177Z_run.log`;
  `.metaproject/data/health/artifacts/latest.md`
- Graph rebuild, cycles, wiki links: `.metaproject/data/gdctx/raw/2026-09-06T15-13-22-939Z_run.log`
- F-013 binary probe: `.metaproject/data/gdctx/raw/2026-09-06T15-14-03-767Z_run.log`
- Test-file integrity re-check (38 OK / 0 FAILED): `.metaproject/data/gdctx/raw/2026-09-06T15-15-26-097Z_run.log`

Routing audit (attempt 2): `graph_used: yes`, `wiki_used: yes` (link check; wiki pages
`not-relevant` to a pure execution gate), `ctx_used: yes`, `raw_rg_used: no`.

---

# Attempt 1 — 2026-09-06T14:16Z-14:35Z (superseded; kept for history)

Version: 0.1.0

## Verdict (attempt 1)

**Status: FAIL.** Every build, type, graph, documentation and Go check passes, including the two
race-detector suites that the T33-T35 concurrency and rate-limiter fixes make load-bearing. The
gate nevertheless fails on its own terms: `metrics-and-validation.md` requires that *every* check
pass on the same revision and records partial results as failures rather than averaging them, and
the workspace test command is **intermittently red**. Six complete executions of the CLI test suite
were observed during this verification; two were red, with two different tests failing.

Both red runs share a single, mechanically confirmed root cause, and it is **not** the `dist/cli.js`
build race that T36 addressed. Node's `parseArgs` in `strict` mode refuses an option value that
begins with `-`, and `identity_id` is a base64url encoding of a public key, so roughly one identity
in sixty-four begins with `-`. Whenever such an identity is generated, `echolet send --to <id>` and
`echolet history --with <id>` exit 2 / `INVALID_ARGUMENTS` before any relay contact. This was
demonstrated directly against the built binary, independent of any test.

The T36 harness fix itself holds: `apps/cli/dist/cli.js` is built exactly once per vitest run and no
suite rebuilds it. The `INVALID_ARGUMENTS` symptom recurs anyway, from a different cause.

## Environment

- Platform: macOS (Darwin) arm64
- Node: v26.5.0; CLI build target and package engine floor: Node 22.13
- pnpm: 10.0.0
- Go: go1.26.1 darwin/arm64
- Native Signal package: `@signalapp/libsignal-client` 0.102.0
- Revision: unborn `main`; the working tree is the revision identifier (`git rev-parse HEAD` →
  `fatal: Needed a single revision`). No commit was created.

```text
Acceptance target: echolet-cli-prototype
Revision: working tree at /Users/Goodea/goodea/projects/echolet (unborn main, no commit hash)
Environment: macOS arm64, Node v26.5.0, pnpm 10.0.0, go1.26.1, libsignal-client 0.102.0
Status: FAIL
Decision: rejected — re-run after the argument-parsing defect below is fixed
```

## Independent checks

| Label | Command | Status | Bounded evidence |
|---|---|---|---|
| `frozen_install` | `pnpm install --frozen-lockfile` | PASS | Exit 0; all 8 workspace projects lockfile-current. |
| `cli_build` | `pnpm --filter @echolet/cli build` | PASS | Exit 0; production ESM bin build completes. |
| `workspace_typecheck` | `pnpm typecheck` | PASS | Exit 0; all 7 TypeScript workspace packages complete without errors. |
| `cli_process` | `pnpm --filter @echolet/cli exec vitest run src/commands/cli.test.ts` | PASS | Exit 0; 1 file / 6 tests passed. |
| `workspace_tests` | `pnpm test` | **FAIL (intermittent)** | 4 executions: 3 green (12 files / 53 tests in `apps/cli`, 98 workspace-wide), 1 red — `test/e2e/two-process.test.ts` run 3, `CLI send exit (INVALID_ARGUMENTS): expected 2 to be 4`, 1 failed \| 52 passed. |
| `cli_suite_unfiltered` | `pnpm --filter @echolet/cli test` | PASS (this execution) | Exit 0; 12 files / 53 tests, **no file or path exclusions**, E2E 3/3 in the same run as every other suite. |
| `e2e_3_iterations` | `pnpm --filter @echolet/cli test:e2e` | PASS (this execution) | Exit 0; 3/3 clean real relay / two-profile process runs. |
| `go_untagged` | `go -C apps/relay test ./...` | PASS | Exit 0; handler, router, middleware, repository, validation all `ok`. |
| `go_untagged_race` | `go -C apps/relay test -race -count=1 ./...` | PASS | Exit 0; same five packages `ok` under the race detector. Additional check required by this dispatch. |
| `relayv2_race` | `go -C apps/relay test -race -count=1 -tags=relayv2 -timeout=180s ./...` | PASS | Exit 0, uncached; verbose variant records 36 top-level tests, 0 failed, 0 skipped. |
| `metaproject_test_strict` | `keryx test run --strict` | **FAIL** | Exit 1; normalized report `FAIL`, passed 2 / failed 1. Underlying failure: `src/commands/cli.processFailures.test.ts` > `runtime persistence failure classification (F-003)` > `classifies the post-send delivery commit failure as PERSISTENCE_FAILURE with exit 5`, `AssertionError: expected undefined to be defined` at line 220. |
| `health_strict` | `keryx health run --strict` | WARN | Exit 0; score 93, 7 findings (P0 0, P1 0, P2 7, all complexity), gate reason `health regression 4 vs baseline`. ESLint and TypeScript are auto-skipped and tests are marked missing by this adapter. |
| `graph_rebuild` | `keryx gdgraph build` | PASS | 77 nodes, 116 edges (T27: 70 / 104). |
| `graph_cycles` | `keryx gdgraph query cycles` | PASS | No cycles found. |
| `wiki_links` | `keryx wiki check-links` | PASS | 19 pages, 38 internal links, 0 broken. |

### Flake characterisation (additional, not in the T27 matrix)

| Label | Command | Result |
|---|---|---|
| `pnpm_test_repeat` | `pnpm test` x3 | 2 pass / 1 fail. The failure is E2E iteration 3 with `INVALID_ARGUMENTS`. |
| `processFailures_repeat` | `vitest run src/commands/cli.processFailures.test.ts` x20 (8 + 12) | 18 pass / 2 fail. Both failures are the same test at line 220. |
| `processFailures_f003_only` | same file with `-t "F-003"` x8 | 8 pass / 0 fail. |
| `standalone_repro` | scratchpad reproducer of the F-003 scenario against `dist/cli.js`, 12 serial + 32 under 4-way parallel load | 44 pass / 0 fail. |
| `leading_dash_demo` | `node dist/cli.js send --to -AbCdEf… --text … --message-id <uuid> --profile <tmp> --json` | **exit 2, `errorCode=INVALID_ARGUMENTS`** — deterministic. |
| `parseArgs_demo` | `node -e` with the exact `cliOptions` shape and a `-`-prefixed `--to` value | Throws `ERR_PARSE_ARGS_INVALID_OPTION_VALUE: Option '--to' argument is ambiguous.` |

## Blocking finding

**F-013 — `send --to` / `history --with` reject any identity whose base64url encoding begins with `-`.**

- `apps/cli/src/commands/cli.ts:65` calls `parseArgs({ …, strict: true })`; line 66 maps every parse
  error to `inputFailure()` → `INVALID_ARGUMENTS` / exit 2.
- Node's `parseArgs` in strict mode refuses to consume a following token that begins with `-` as an
  option value (`ERR_PARSE_ARGS_INVALID_OPTION_VALUE`).
- `identityId` is `encodeBase64Url(identityKeys.publicKey)`
  (`packages/client-core/src/identity/createIdentityProfile.ts:58`,
  `packages/crypto-core/src/identity/generateKeyPair.ts:9`). The base64url alphabet includes `-`, so
  approximately 1 identity in 64 begins with `-`.
- Every string-valued CLI option is affected as a class: `--profile`, `--relay-url`,
  `--store-key-env`, `--out`, `--from`, `--to`, `--text`, `--message-id`, `--with`. The two that
  carry tool-generated identity ids are `--to` (send) and `--with` (history); `--text` carries
  arbitrary user text and is affected for any message beginning with `-`.
- This explains both observed red runs. The E2E case fails at
  `apps/cli/test/e2e/two-process.test.ts:141` expecting exit 4 and receiving 2. The F-003 case fails
  at `apps/cli/src/commands/cli.processFailures.test.ts:220` because `send` exits before any HTTP
  request, so the relay stub's `/v1/messages/send` hook never runs and `lock` stays `undefined`; the
  failing iteration completed in 877 ms, far inside the 8 s process timeout, confirming it was not a
  timeout.

This is a defect in the CLI, not in the tests. No test was weakened to hide it.

## Build-race question (explicitly answered)

- `apps/cli/vitest.config.ts` registers `./test/globalSetup.ts`, which runs `build.mjs` once per
  vitest run before any suite starts.
- A workspace-wide search for build invocations under `apps/cli` returns exactly two sites:
  `apps/cli/test/globalSetup.ts:17` and the `build` script in `apps/cli/package.json:9`. **No suite
  rebuilds `dist/cli.js` while another suite executes it.**
- `apps/cli/src/commands/cli.processFailures.test.ts:24` builds a *separate* private bundle
  (`dist/cli.red-<pid>.js`) in `beforeAll` and removes it in `afterAll`; it never writes
  `dist/cli.js`.
- **Does the previously observed `INVALID_ARGUMENTS` build race recur?** The *symptom* recurs — once
  in four `pnpm test` executions. The *build race* does not: the failing E2E iteration executed eight
  earlier CLI spawns successfully against the same binary and returned well-formed JSON
  (`{ ok: false, error: { code: "INVALID_ARGUMENTS" } }`), which a partially written bundle cannot
  produce. The cause is F-013 above.

## Test integrity

- 37 test files were hashed before the first command and re-verified after the last:
  `shasum -c` reports 0 mismatches. No test, source, configuration or dependency file was modified
  during this verification.
- Workspace-wide search for `it/test/describe.skip|only|todo`, `xit(`, `xdescribe(` and Go `t.Skip(`
  returns **0 real matches** (three hits are `os.Exit(` in `apps/relay/cmd/relay/main.go`).
- **Test count against the T27 baseline of 82: now 98 (+16).** The entire difference is in
  `apps/cli` (37 → 53); the other six packages are unchanged at 45 (protocol 8, client-db 1,
  crypto-core 4, client-core 2, session-node 24, mobile 6).

| `apps/cli` test file | T27 | T37 | Delta |
|---|---:|---:|---|
| `src/runtime/config.test.ts` | 3 | 3 | — |
| `src/transport/relayClient.test.ts` | 3 | 3 | — |
| `src/runtime/profile.test.ts` | 6 | 6 | — |
| `src/runtime/outbound.test.ts` | 6 | 6 | — |
| `src/runtime/inbound.test.ts` | 10 | 11 | +1 |
| `src/commands/cli.test.ts` | 6 | 6 | — |
| `test/e2e/two-process.test.ts` | 3 | 3 | — |
| `src/commands/cli.processFailures.test.ts` | — | 8 | new (F-002, F-003) |
| `src/runtime/outbound.publish.test.ts` | — | 3 | new |
| `src/runtime/outbound.concurrentSend.test.ts` | — | 1 | new |
| `src/runtime/inbound.pollBatchSize.test.ts` | — | 1 | new (F-009) |
| `src/transport/relayClient.pollCapacity.test.ts` | — | 2 | new (F-009) |
| **Total** | **37** | **53** | **+16** |

No pre-existing test lost a case, was renamed away, skipped or deleted. The +16 is 15 tests in five
new files plus one added case in `inbound.test.ts`.

## Required measurements

| Metric | Threshold | Measured | Evidence source |
|---|---|---|---|
| Clean end-to-end runs | 3/3 pass | **3/3 in 5 of 6 suite executions; 2/3 in one** | `test:e2e` 3/3; `pnpm --filter @echolet/cli test` 3/3; `pnpm test` 3/3 in three of four runs, 2/3 in one (F-013). |
| Concurrent claim winners | exactly 1 of at least 20 | **1 of 20**, PASS under `-race` | `TestSignalPreKeyBundleV2ConcurrentClaimsAllocateExactlyOnce`, `const claimants = 20`, losers assert `PREKEY_BUNDLE_UNAVAILABLE`. |
| Lost-response claim retries | same bundle bytes for same claim ID | PASS | `TestSignalPreKeyBundleV2ClaimReplayIsExactAndSelectorBound` (race, tagged). |
| Reused OTK publications | 100% rejected across changed IDs, expiry, restart | PASS, 5 sub-cases | `TestSignalPreKeyBundleV2OneTimePreKeyReservationsArePermanent`: `new_bundle_same_otk`, `new_bundle_same_otk_key_id`, `new_bundle_same_otk_tuple`, `after expiry`, `after claim and restart` — all `ONE_TIME_PREKEY_REUSED`. Plus `TestSignalPreKeyBundleV2PublishIsImmutableAndIdempotent`. |
| Offline delivery | 1/1 delivered after receiver start | PASS in every green E2E iteration | `two-process.test.ts`: Bob has no running process during the send; after `poll`, `history` length 1. |
| Sender restart exact retry | ciphertext bytes identical | PASS | `two-process.test.ts:143-144` — 2 `/v1/messages/send` bodies, byte-identical, single `/v2/prekeys/claim`. Plus `outbound.publish.test.ts` "resubmits the byte-identical signed bundle after a lost publish response and a restart". |
| Receiver duplicate history entries | 0 | **0** | `two-process.test.ts:148-155,158-160,172`; `inbound.test.ts` "recovers pending ack after restart without polling, decrypting again or duplicating history"; `outbound.concurrentSend.test.ts` "exactly one envelope and one history entry". |
| Known plaintext marker in relay DB/logs | 0 occurrences | **0** | `two-process.test.ts:173-174` — markers asserted absent from proxied HTTP traffic, from the relay log, and from a recursive byte scan of the whole relay data directory after the relay is stopped. Occurrence count only; no content reproduced here. |
| Invalid contract cases rejected | 100% fixture corpus | **4/4 shared invalid cases**, both languages | `packages/protocol/src/types/fixtures/relay-v2.json` `invalid_publish_requests` = 4 (unknown bundle field, expired bundle, invalid root device signature, changed signed field) driving Go `TestSignalPreKeyBundleV2SharedFixtures` and TS `signalPreKeyBundleV2.test.ts` (6 tests) + `validateDeviceRecord.test.ts` (2 tests). Plus relay-side `TestValidateDeviceRecordRejectsInvalidSignature`, `TestValidatePreKeyBundleRejectsInvalidSignatures`, `TestValidateMailboxEnvelopeChecksActualCiphertextBytes`. |
| Required Markdown versions and links | 100% | PASS | `keryx wiki check-links`: 19 pages, 38 internal links, 0 broken. |

Every measurement above except *clean end-to-end runs* meets its threshold. The gate still fails,
because the gate requires all checks green on one revision.

## Comparison against the T27 baseline

| Item | T27 | T37 | Change |
|---|---|---|---|
| `frozen_install`, `cli_build`, `workspace_typecheck`, `cli_process` | PASS | PASS | unchanged |
| `workspace_tests` | PASS, 82 tests | **FAIL (intermittent)**, 98 tests | regression in reliability; +16 tests |
| `e2e_3_iterations` | PASS 3/3 | PASS 3/3 in the dedicated run; 2/3 in one full-suite run | new intermittent failure surfaced |
| `go_untagged` | PASS | PASS | unchanged |
| `go_untagged_race` | not run | **PASS** | new check, green |
| `relayv2_race` | PASS | PASS | unchanged |
| `metaproject_test_strict` | PASS (exit 0) | **FAIL (exit 1)** | regression |
| `health_strict` | WARN, score 92, 7 P2 | WARN, score 93, 7 P2 | score +1; gate reason is now an explicit `regression 4 vs baseline` |
| `graph_rebuild` | 70 nodes / 104 edges | 77 nodes / 116 edges | new source and test files |
| `graph_cycles` | none | none | unchanged |
| `wiki_links` | 19 pages / 38 links / 0 broken | identical | unchanged |

The two files an earlier worker excluded to manufacture a clean run —
`src/runtime/inbound.pollBatchSize.test.ts` and `src/transport/relayClient.pollCapacity.test.ts` —
now pass in every run recorded here. **No exclusion of any kind was applied to any run in this
report.**

## Limitations

This gate establishes local technical-prototype behaviour on one macOS arm64 machine and nothing
more. It does not establish production security, safe use for sensitive communication, mobile
delivery, public deployment readiness, completion of an independent cryptographic audit, user
demand, or permanent suitability of the pinned libsignal dependency.

Specific honesty notes:

- The failure rate for F-013 is estimated from a small sample (2 red runs out of 6 full CLI suite
  executions; 2 out of 20 runs of the affected file). The mechanism is proven deterministically; the
  *rate* is a probabilistic estimate governed by how often a generated base64url identity starts
  with `-`.
- The strict health adapter still cannot execute ESLint (no runnable lint scripts in the workspace
  packages) and does not associate the independently passing TypeScript and test commands with its
  required sources. Its 7 findings are all P2 complexity warnings; its score is not an independent
  confirmation of lint or type health.
- `keryx test run --strict` reports an aggregate count of 3 for a workspace that actually runs 98
  tests; the independent workspace run is the authoritative count.
- One `pnpm test` execution is not the same as a deterministic suite. A green run of this suite is
  not currently evidence that the next run will be green.

## Evidence

- Frozen install: `.metaproject/data/gdctx/raw/2026-09-06T14-16-17-638Z_run.log`
- CLI build: `.metaproject/data/gdctx/raw/2026-09-06T14-16-22-778Z_run.log`
- Workspace typecheck: `.metaproject/data/gdctx/raw/2026-09-06T14-16-32-096Z_run.log`
- CLI process tests: `.metaproject/data/gdctx/raw/2026-09-06T14-17-10-342Z_run.log`
- Workspace tests (green): `.metaproject/data/gdctx/raw/2026-09-06T14-17-56-959Z_run.log`
- Go untagged: `.metaproject/data/gdctx/raw/2026-09-06T14-18-29-360Z_run.log`
- Go untagged race: `.metaproject/data/gdctx/raw/2026-09-06T14-18-40-342Z_run.log`
- Relay-v2 tagged race: `.metaproject/data/gdctx/raw/2026-09-06T14-18-51-480Z_run.log`
- Relay-v2 tagged race, verbose (36 tests): `.metaproject/data/gdctx/raw/2026-09-06T14-33-13-503Z_run.log`
- CLI suite unfiltered: `.metaproject/data/gdctx/raw/2026-09-06T14-19-39-030Z_run.log`
- Dedicated E2E 3/3: `.metaproject/data/gdctx/raw/2026-09-06T14-20-21-216Z_run.log`
- Strict testing (FAIL): `.metaproject/data/gdctx/raw/2026-09-06T14-21-32-404Z_run.log`;
  normalized report `.metaproject/data/testing/artifacts/latest.md`;
  raw log `.metaproject/data/testing/logs/latest.raw.log`
- `processFailures` x8: `.metaproject/data/gdctx/raw/2026-09-06T14-23-03-529Z_run.log`
- `processFailures` F-003 only x8: `.metaproject/data/gdctx/raw/2026-09-06T14-26-41-395Z_run.log`
- `pnpm test` x3 (1 red): `.metaproject/data/gdctx/raw/2026-09-06T14-29-16-687Z_run.log`
- Leading-dash demonstration: `.metaproject/data/gdctx/raw/2026-09-06T14-34-29-036Z_run.log`
- `parseArgs` demonstration: `.metaproject/data/gdctx/raw/2026-09-06T14-30-39-630Z_run.log`
- Strict health: `.metaproject/data/health/artifacts/latest.md`
- Graph rebuild / cycles: `.metaproject/data/gdctx/raw/2026-09-06T14-32-25-764Z_run.log`,
  `.metaproject/data/gdctx/raw/2026-09-06T14-32-31-967Z_run.log`
- Wiki links: `.metaproject/data/gdctx/raw/2026-09-06T14-32-36-856Z_run.log`
- Test-file integrity re-check: `.metaproject/data/gdctx/raw/2026-09-06T14-34-55-809Z_run.log`

Routing audit: `graph_used: yes`, `wiki_used: yes` (link check; wiki pages not needed for a pure
execution gate), `ctx_used: yes`, `raw_rg_used: no`.
