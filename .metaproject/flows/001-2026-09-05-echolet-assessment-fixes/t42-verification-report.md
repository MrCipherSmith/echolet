# T42 full prototype re-verification after the T40/T41 remediation round

Version: 0.1.0
Run: 2026-09-06T17:14Z – 17:44Z (local 21:14–21:44)

## Verdict

**Status: FAIL (gate not satisfied), with one non-blocking WARN.**

Twenty checks were executed independently on the current working tree. Nineteen pass, one WARNs
(the advisory health adapter), and **one required check is intermittently red**: `pnpm test` — one
of the four automated checks named in `metrics-and-validation.md` — failed 2 of 7 complete
executions. `metrics-and-validation.md` requires that *every* check pass on the same revision and
records partial results as failures rather than averaging them, so the gate fails on its own terms.

The failure is **not** a functional regression in the product and **not** a regression in the T40 or
T41 work. Every red run fails in exactly one file, `apps/cli/src/runtime/inbound.test.ts`, and every
individual failure is `Test timed out in 5000ms`. That file is the only remaining heavy `apps/cli`
suite that still runs on vitest's default 5 000 ms per-test budget; every other heavy CLI suite
declares 30 000–90 000 ms explicitly. Under the parallel load of `pnpm -r test` its tests, which
take at most 1.4 s standalone, were observed taking 8.0 s and 9.9 s. See **Finding T42-F-001**.

The **HL-N-001 class is closed end to end** — confirmed by a direct probe of the real relay binary
and the real CLI binary, outside the test suite (see the dedicated section). The **F-013 class
remains closed** — confirmed by a fifteen-case probe of the built binary. The **BE-R-001 identifier
bound** holds against a live relay: a 70 000-byte identifier now yields a bounded HTTP 400, never
500.

```text
Acceptance target: echolet-cli-prototype
Revision: working tree at /Users/Goodea/goodea/projects/echolet (unborn main, no commit hash)
Environment: macOS (Darwin) arm64, Node v26.5.0, pnpm 10.0.0, go1.26.1 darwin/arm64,
             @signalapp/libsignal-client 0.102.0, keryx 0.2.80
Status: FAIL
Checks: 20 executed — 18 PASS, 1 WARN (advisory health adapter), 1 FAIL (`pnpm test`, intermittent)
Metrics: all ten required measurements meet their thresholds in every green execution
Failures: T42-F-001 — `pnpm test` intermittently red (2/7); 5 000 ms default test timeout in
          apps/cli/src/runtime/inbound.test.ts exhausted under parallel workspace load
Artifacts: .metaproject/data/gdctx/raw/2026-09-06T17-*.log (per-check paths under Evidence)
Decision: rejected on this pass — one required check is not reliably green on this revision
```

## Environment

- Platform: macOS (Darwin) arm64
- Node v26.5.0; pnpm 10.0.0; Go go1.26.1 darwin/arm64; keryx 0.2.80
- Native Signal package: `@signalapp/libsignal-client` 0.102.0
- Revision: unborn `main`. `git rev-parse HEAD` → `fatal: ambiguous argument 'HEAD': unknown
  revision`. The working tree is the revision identifier. No commit was created.

## Independent checks

| Label | Command | Status | Bounded evidence |
|---|---|---|---|
| `frozen_install` | `pnpm install --frozen-lockfile` | PASS | Exit 0; all 8 workspace projects lockfile-current ("Already up to date"). |
| `cli_build` | `pnpm --filter @echolet/cli build` | PASS | Exit 0; production ESM bin build completes. |
| `workspace_typecheck` | `pnpm typecheck` | PASS | Exit 0; all 7 TypeScript workspace packages `Done`, no errors. |
| `cli_process` | `pnpm --filter @echolet/cli exec vitest run src/commands/cli.test.ts` | PASS | Exit 0; 1 file / 6 tests. |
| `cli_dash_options` | `pnpm --filter @echolet/cli exec vitest run src/commands/cli.dashOptionValues.test.ts` | PASS | Exit 0; 1 file / **18 tests** (T37: 16), file unmodified (hash-verified). |
| `workspace_tests` | `pnpm test` × 7 (one of them driven by `keryx test run --strict`) | **FAIL (intermittent)** | **5 green / 2 red.** Green: 128 workspace tests, `apps/cli` 14 files / 83 tests. Red run A: `apps/cli` 5 failed \| 78 passed (83). Red run C: 2 failed \| 81 passed (83). All 7 individual failures are in `src/runtime/inbound.test.ts`, all `Test timed out in 5000ms`. |
| `cli_suite_unfiltered` | `pnpm --filter @echolet/cli test` | PASS | Exit 0; 14 files / 83 tests, **no file or path exclusions**; E2E 3/3 in the same run as every other suite. |
| `e2e_3_iterations` | `pnpm --filter @echolet/cli test:e2e` | PASS | Exit 0; 3/3 clean real-relay / two-profile process runs, unfiltered. |
| `go_untagged` | `go -C apps/relay test ./...` | PASS | Exit 0; handler, router, middleware, repository, validation all `ok` (middleware and repository from the Go build cache). |
| `go_untagged_race` | `go -C apps/relay test -race -count=1 ./...` | PASS | Exit 0, uncached; the same five packages `ok` under the race detector. |
| `relayv2_race` | `go -C apps/relay test -race -count=1 -tags=relayv2 -timeout=180s ./...` | PASS | Exit 0, uncached; verbose re-run records **39 top-level tests** (T37: 36), 0 failed, **0 skipped**, 5 packages `ok`. |
| `metaproject_test_strict` | `keryx test run --strict` | PASS | Exit 0; normalized report `PASS`, passed 2 / failed 0. Its underlying `pnpm run test` execution was green (`apps/cli` 14 files / 83 tests). |
| `health_strict` | `keryx health run --strict` | WARN | Exit 0; score 94, 7 findings (P0 0, P1 0, **P2 7**, all complexity), gate reason `health regression 3 vs baseline`. Advisory; ESLint and TypeScript are auto-skipped by this adapter. |
| `graph_rebuild` | `keryx gdgraph build` | PASS | 79 nodes, 121 edges (T37: 78 / 117). |
| `graph_cycles` | `keryx gdgraph query cycles` | PASS | No cycles found. |
| `wiki_links` | `keryx wiki check-links` | PASS | 19 pages, 38 internal links, 0 broken. |
| `hln001_binary_probe` | scratchpad probe: real relay binary + real `dist/cli.js` | PASS | See **HL-N-001 closure**. Poison isolated, legitimate delivered, poison never acked, transient failure never acked. |
| `f013_binary_probe` | scratchpad probe: 15 invocations of `dist/cli.js` | PASS | 15/15 as specified; exactly one JSON object on stdout each. |
| `ber001_identifier_probe` | scratchpad probe: 70 000-byte identifiers against a live relay | PASS | 4/4 oversized-identifier variants → **HTTP 400**, client error code, never 500. |
| `test_integrity` | `shasum -a 256 -c` over the pre-run baseline | PASS | **42 OK / 0 FAILED**; test-file set identical before and after (0-line diff). |

### Every complete, unfiltered execution observed

No exclusion of any kind — no `-t`, no file list, no path filter — was applied to any run below.

| # | Command | Exit | `apps/cli` | Workspace total | E2E | Cumulative test time |
|---:|---|---:|---|---:|---|---:|
| 1 | `pnpm test` | **1** | 5 failed \| 78 passed (83) | red | 3/3 | 468.08 s |
| 2 | `pnpm test` | 0 | 14 files / 83 tests | 128 passed | 3/3 | 290.60 s |
| 3 | `pnpm test` | **1** | 2 failed \| 81 passed (83) | red | 3/3 | 402.45 s |
| 4 | `pnpm --filter @echolet/cli test` | 0 | 14 files / 83 tests | (CLI only) | 3/3 | — |
| 5 | `pnpm --filter @echolet/cli test:e2e` | 0 | 1 file / 3 tests | (E2E only) | 3/3 | 47.89 s |
| 6 | `keryx test run --strict` → `pnpm run test` | 0 | 14 files / 83 tests | 128 passed | 3/3 | 169.71 s |
| 7 | `pnpm test` | 0 | 14 files / 83 tests | 128 passed | 3/3 | 126.50 s |
| 8 | `pnpm test` | 0 | 14 files / 83 tests | 128 passed | 3/3 | 117.63 s |
| 9 | `pnpm test` | 0 | 14 files / 83 tests | 128 passed | 3/3 | 124.80 s |

**2 red out of 7 workspace-wide executions; 0 red out of 9 for the E2E suite (27/27 iterations).**
Per-package totals were identical in every green run: protocol 8, client-db 1, crypto-core 4,
client-core 2, session-node 24, mobile 6, CLI 83.

## Finding T42-F-001 — `pnpm test` is intermittently red (HIGH; blocks the gate)

**What fails.** Two of seven `pnpm test` executions exited 1. Every one of the seven individual
test failures is in `apps/cli/src/runtime/inbound.test.ts` and every one reads
`Test timed out in 5000ms`. Different tests failed in each red run (5 in one, 2 in the other), which
is the signature of a budget being exhausted rather than of a deterministic defect.

**Mechanism, established mechanically.**

1. `apps/cli/vitest.config.ts` sets no `testTimeout`; a routed workspace search finds no
   `testTimeout` anywhere under `apps/` or `packages/`. The vitest default of 5 000 ms therefore
   applies to any test that does not declare its own.
2. `apps/cli/src/runtime/inbound.test.ts` declares **no** per-test timeout. Every other heavy
   `apps/cli` suite does: `cli.test.ts` 30 000 ms, `cli.processFailures.test.ts` 40 000–60 000 ms,
   `outbound.publish.test.ts` 30 000 ms, `outbound.concurrentSend.test.ts` 60 000 ms,
   `inbound.batchIsolation.test.ts` 90 000 ms, `test/e2e/two-process.test.ts` 90 000 ms.
3. Standalone, `vitest run src/runtime/inbound.test.ts` is 11/11 green with a maximum per-test
   duration of **1 404 ms** — roughly 3.5× headroom inside the 5 s budget.
4. `pnpm test` is `pnpm -r test`, which runs seven vitest instances concurrently. In the red runs
   the same tests took **7 999 ms** and **9 899 ms**.
5. Redness correlates cleanly with machine load: the two red runs are the two slowest
   (468 s and 402 s of cumulative test time), and every green run is between 118 s and 291 s.

**Why this is not a product defect and not a T40/T41 regression.** The behaviour under test is
unchanged and passes whenever it is given time; the file is byte-identical to its pre-run hash. What
changed since T37 is the *load*: the `apps/cli` suite grew from 13 files / 69 tests to
14 files / 83 tests, and the ten new tests in `inbound.batchIsolation.test.ts` are heavy real-crypto
tests that the file itself budgets at 90 000 ms each. `inbound.test.ts` was left as the one heavy
suite without headroom.

**This is nonetheless reported as a gate FAIL,** because the acceptance rule is explicit that every
required check must pass on one revision and that partial results are failures. The fix is a
one-line test-configuration change; it is deliberately **not** applied here, because this dispatch is
verification only.

## HL-N-001 closure — how it was checked

Three independent lines of evidence. The suite being green is the weakest of the three and is listed
last.

### 1. Direct probe of the real relay binary and the real CLI binary, outside the test suite

A scratchpad probe (`hln001-probe2.mjs`) built the Go relay from source, started it, initialised two
real CLI profiles against it through a recording proxy, and injected a permanently unacceptable
envelope straight into Bob's mailbox over HTTP — the same technique `two-process.test.ts:167` uses,
so it needs no prekey claim. Only counts, exit codes and typed error codes were printed.

| Step | Observed | Meaning |
|---|---|---|
| Alice sends one legitimate message; a malformed-ciphertext envelope is injected behind it | `poison_injected_http_status=200` | Bob's mailbox now holds a batch of two, one of them permanently unacceptable. |
| `bob poll` | `exit=0 received=1 more=false rejected=["INBOUND_REJECTED"]`, history from Alice = **1** | The legitimate envelope is **delivered and acknowledged** despite sharing the batch. Before T40 the whole batch shared one transaction, threw on the poison, and delivered nothing. |
| `bob poll` again (only the poison remains) | `exit=3 code=INBOUND_REJECTED` | The poison is **still queued at the relay**. That exit is only reachable if the relay still holds the envelope, so it was never acknowledged and was not discarded. F-012's whole-batch contract is preserved when nothing is acceptable. |
| Alice sends a **second** message, then `bob poll` | `exit=0 received=1 rejected=["INBOUND_REJECTED"]`, history = **2** | **The precise HL-N-001 failure is closed**: a legitimate message arriving *behind* a still-queued poison is delivered rather than ageing out. |
| `bob poll` again | `exit=3 code=INBOUND_REJECTED` | The poison is still queued after all of it. |
| Alice sends a third message; the relay is then made unreachable and `bob poll` runs | `exit=4 code=RELAY_UNAVAILABLE`, history still **2** | **Transient-failure control.** A relay failure fails loudly, acknowledges nothing, commits nothing, and leaves the envelope queued and retriable. A "fix" that discarded transient failures would show `received=1` and a history of 3 here. |

### 2. Source-level confirmation that isolation is per-envelope and atomic

- `apps/cli/src/runtime/inbound.ts:115-146` — `acceptOne()` wraps each envelope in
  `profile.withRuntime(...)`, i.e. **one transaction per envelope**.
- The pending acknowledgement is written **inside that same transaction**
  (`inbound.ts:144`, `tx.set(ackKey(envelope.envelope_id), …)`), alongside the inbox key and the
  history append. Delivery and its ack marker commit or roll back together.
- The transaction is a real SQLite transaction:
  `packages/session-node/src/EncryptedSqliteStore.ts:27-32` executes `BEGIN IMMEDIATE`, `COMMIT`,
  and `ROLLBACK` on error. A rejected envelope therefore leaves no inbox key, no history row and
  **no pending-ack key** — it cannot be acknowledged even accidentally.
- `inbound.ts:53-54` — `isNotAnEnvelopeVerdict` classifies `PersistenceError`, `RelayError` and
  `ProfileError` as *not* verdicts about the envelope; `accept()` (line 107) **rethrows** those,
  aborting the whole poll before `ackPending()` is ever reached. Everything else is a permanent
  verdict about one envelope and is isolated.
- `inbound.ts:87` — when nothing was accepted, the first rejection is re-raised **before**
  `ackPending()` at line 88, preserving F-012.
- `inbound.ts:89` — `more: batch.next_cursor !== null` surfaces the remaining-work signal (HL-N-002).

The distinction that matters for the specification: a permanently unacceptable envelope is
**isolated, not discarded**. It is never acked, so the relay keeps it queued and it remains
retriable — exactly what the spec requires of a decrypt or commit failure. The difference is only
that it no longer stops the rest of the batch.

### 3. The regression suite, read rather than trusted

`apps/cli/src/runtime/inbound.batchIsolation.test.ts` (10 tests, all green in every execution) was
read to confirm it asserts the right thing and would fail on a regression in either direction:

- Poison-first and poison-last both assert `received === 1`, `ackedIds() === [legitimate]`,
  `ackedIds()` **not** containing the poison, the poison still in `queuedIds()`, and no history
  entry for the untrusted sender.
- The transient tests inject a **real** store-commit failure through
  `EncryptedSqliteStore.prototype.transaction` and assert the poll rejects, `acks()` is empty, and a
  byte-level `snapshot(bob)` is **unchanged** — then that a retry delivers both. A fix that isolated
  transient failures instead of aborting would make these fail.
- A second transient test drops the `/v1/mailbox/ack` response and asserts the pending ack survives
  and that the only envelope ever offered for acknowledgement is the legitimate one.
- The F-012 test asserts that an all-poison batch still raises, acks nothing, and leaves the store
  byte-identical.

**Verdict: the HL-N-001 class is closed end to end.** A permanently unacceptable envelope no longer
blocks delivery, and a transient failure still leaves its envelope queued, unacked and retriable.

## F-013 closure (re-confirmed)

The 18 tests in `apps/cli/src/commands/cli.dashOptionValues.test.ts` pass **unmodified**
(hash-verified before and after) — 18/18 standalone and 18/18 inside every full suite run. T41 added
two of them ("strict parsing is load-bearing, not incidental (MC10)"), which close the gap where
`strict: false` would have left the CLI suite green.

Independent probe of the built binary (`apps/cli/dist/cli.js`), outside the suite. Exit status,
typed error code and the number of JSON objects on stdout only.

| Probe | Result | Meaning |
|---|---|---|
| `send --to -AbCdEf…` | exit 3, `CONTACT_NOT_TRUSTED` | reaches the **trust layer**, not the parser |
| control: the same id without the leading `-` | exit 3, `CONTACT_NOT_TRUSTED` | dash-leading and plain values behave identically |
| `send --text -PROBE` | exit 3, `CONTACT_NOT_TRUSTED` | a dash-leading body is content, not an option |
| `history --with -AbCdEf…` | exit 0, `ok` | reaches the **history layer** |
| `init --relay-url -http://…` | exit 2, `INVALID_CONFIGURATION` | reaches the **configuration validator**, not the parser |
| `doctor` (baseline) | exit 0, `ok` | control |
| `doctor --unknown-flag` | exit 2, `INVALID_ARGUMENTS` | fails closed |
| `history --profile P --json --with` (value missing at end of argv) | exit 2, `INVALID_ARGUMENTS` | fails closed |
| `send --to A --to -Dash… …` (repeated option) | exit 2, `INVALID_ARGUMENTS` | fails closed |
| `send extra --to … --text …` (stray positional) | exit 2, `INVALID_ARGUMENTS` | fails closed |
| `send --store-key-env …` (option the command does not accept) | exit 2, `INVALID_ARGUMENTS` | fails closed |
| `doctor … -- extra` (operand after `--`) | exit 2, `INVALID_ARGUMENTS` | fails closed |
| `doctor … --` (bare trailing separator) | exit 0, `ok` | no-op, as specified |
| `bogus` (unknown command) | exit 2, `INVALID_ARGUMENTS` | fails closed |
| `doctor --json=1` (inline value on a boolean) | exit 2, `INVALID_ARGUMENTS` | strict parsing is load-bearing |

Every probe emitted **exactly one** JSON object on stdout. **The F-013 class remains closed.**

## BE-R-001 identifier bound (T40) — independently probed

Against a freshly built, running relay, four 70 000-byte attacker-supplied identifiers
(`recipient_mailbox_id`, `envelope_id`, `sender_identity_id`, `message_id`) on the unauthenticated
`/v1/messages/send` route each returned **HTTP 400** with a client error code — never a 5xx. The
previously reported HTTP 500 does not recur. `TestSendEnvelopeRejectsOversizedIdentifiersWithClientError`
(handler) and `TestValidateMailboxEnvelopeBoundsIdentifierLengths` (validation) pass in both Go
suites, including under `-race -count=1`.

Honesty note: the control envelope in this scratchpad probe used synthetic identity ids and was
itself rejected with `INVALID_SCHEMA`, so the probe demonstrates only "70 000 bytes never yields a
5xx", not "a valid short-id envelope is accepted". The valid-control half is covered by the Go
handler test, which passes.

## Build-race question

- `apps/cli/vitest.config.ts:6` registers `./test/globalSetup.ts`, which runs `build.mjs` once per
  vitest run before any suite starts.
- A routed workspace search for build invocations under `apps/cli` returns exactly two sites:
  `apps/cli/test/globalSetup.ts` and the `build` script in `apps/cli/package.json`. **No suite
  rebuilds `dist/cli.js` while another suite executes it.**
- `apps/cli/src/commands/cli.processFailures.test.ts` builds a *separate* private bundle and never
  writes `dist/cli.js`.
- **Does the previously observed `INVALID_ARGUMENTS` build race recur?** **No.** No
  `INVALID_ARGUMENTS` failure occurred in any of the nine complete executions recorded here. All
  seven failures observed were 5 000 ms timeouts in `inbound.test.ts`.

## Test integrity

- 42 test files (`*.test.ts`, `*_test.go`, `*.test.mjs`, `*.test.tsx`) were hashed with SHA-256
  before the first command and re-verified after the last: **42 OK / 0 FAILED**, and the file set is
  identical (0-line diff). No test, source, configuration or dependency file was modified during
  this verification. This baseline includes `apps/mobile/src/screens/MessagingScreen.test.mjs`,
  which was outside the T37 baseline glob — that caveat is now closed.
- Routed workspace search for `.skip(`, `.only(`, `.todo(`, `xit(`, `xdescribe(`, `t.Skip(` and
  `t.Skipf(` across `apps/` and `packages/` returns **0 real matches** (the three hits are
  `os.Exit(` in `apps/relay/cmd/relay/main.go`). The same search confirms **no `testTimeout` is
  configured anywhere**, which is the root of T42-F-001.
- The verbose Go run reports **0 skipped** top-level tests and 0 skips of any kind.
- No test file lost a case, was renamed away, weakened, skipped or deleted relative to the counts
  recorded at T37.

### Test count reconciliation against T37

**T37 baseline: 114. Now: 128 (+14).** The entire difference is in `apps/cli` (69 → 83); the other
six packages are unchanged at 45 (protocol 8, client-db 1, crypto-core 4, client-core 2,
session-node 24, mobile 6).

| `apps/cli` test file | T27 | T37 | T42 | Delta vs T37 | Attribution |
|---|---:|---:|---:|---:|---|
| `src/runtime/config.test.ts` | 3 | 3 | 3 | — | |
| `src/transport/relayClient.test.ts` | 3 | 3 | 3 | — | |
| `src/transport/relayClient.pollCapacity.test.ts` | — | 2 | 4 | **+2** | T41 repair of regression tests that passed for the wrong reason |
| `src/runtime/profile.test.ts` | 6 | 6 | 6 | — | |
| `src/runtime/outbound.test.ts` | 6 | 6 | 6 | — | |
| `src/runtime/outbound.publish.test.ts` | — | 3 | 3 | — | |
| `src/runtime/outbound.concurrentSend.test.ts` | — | 1 | 1 | — | |
| `src/runtime/inbound.test.ts` | 10 | 11 | 11 | — | |
| `src/runtime/inbound.pollBatchSize.test.ts` | — | 1 | 1 | — | |
| `src/runtime/inbound.batchIsolation.test.ts` | — | — | **10** | **+10** | new — T40 HL-N-001 isolation, transient-retriability and HL-N-002 `next_cursor` |
| `src/commands/cli.test.ts` | 6 | 6 | 6 | — | |
| `src/commands/cli.processFailures.test.ts` | — | 8 | 8 | — | |
| `src/commands/cli.dashOptionValues.test.ts` | — | 16 | **18** | **+2** | T41 — strict parsing is load-bearing (closes the `strict:false` gap) |
| `test/e2e/two-process.test.ts` | 3 | 3 | 3 | — | |
| **`apps/cli` total** | **37** | **69** | **83** | **+14** | |

Go side: the `relayv2`-tagged race suite grew from **36** top-level tests at T37 to **39**, matching
the T40 identifier-bound work (`mailbox_envelope_identifier_test.go` in both `handler` and
`validation`, plus their sub-cases). Test-file count rose 39 → 42: the three added files are
`apps/cli/src/runtime/inbound.batchIsolation.test.ts`,
`apps/relay/internal/api/handler/mailbox_envelope_identifier_test.go` and
`apps/relay/internal/validation/mailbox_envelope_identifier_test.go`.

**Every one of the +14 is an addition. No pre-existing test was weakened, skipped or deleted.**

## Required measurements

| Metric | Threshold | Measured | Evidence source |
|---|---|---|---|
| Clean end-to-end runs | 3/3 pass | **3/3 in all nine complete executions (27/27 iterations)**, including both red workspace runs | `pnpm test` ×6, `keryx test run --strict`, `pnpm --filter @echolet/cli test`, `test:e2e` — all unfiltered. |
| Concurrent claim winners | exactly 1 of at least 20 | **1 of 20**, PASS under `-race` | `TestSignalPreKeyBundleV2ConcurrentClaimsAllocateExactlyOnce`, `const claimants = 20` (`apps/relay/internal/storage/repository/prekey_bundle_v2_test.go:138`); losers assert `PREKEY_BUNDLE_UNAVAILABLE`. |
| Lost-response claim retries | same bundle bytes for same claim ID | PASS | `TestSignalPreKeyBundleV2ClaimReplayIsExactAndSelectorBound` (tagged race suite). |
| Reused OTK publications | 100% rejected across changed IDs, expiry, restart | PASS | `TestSignalPreKeyBundleV2OneTimePreKeyReservationsArePermanent` and `TestSignalPreKeyBundleV2PublishIsImmutableAndIdempotent`, green under `-race -count=1 -tags=relayv2`. |
| Offline delivery | 1/1 delivered after receiver start | PASS in every E2E iteration | `two-process.test.ts:141-149` — Bob has no running process during the send; after `poll`, history length 1. |
| Sender restart exact retry | ciphertext bytes identical | PASS | `two-process.test.ts:143-145` — two `/v1/messages/send` bodies, byte-identical, single `/v2/prekeys/claim`; plus `outbound.publish.test.ts`. |
| Receiver duplicate history entries | 0 | **0** | `two-process.test.ts:153-160,172`; `inbound.test.ts` restart/ack-recovery case; `outbound.concurrentSend.test.ts`; and the HL-N-001 binary probe (history 1 → 2 across four polls, never more). |
| Known plaintext marker in relay DB/logs | 0 occurrences | **0 occurrences** | `two-process.test.ts:92,173-174` — 4 markers asserted absent from proxied HTTP traffic, from the relay log, and from a recursive byte scan of the whole relay data directory after the relay is stopped. Occurrence count only; no content reproduced. |
| Invalid contract cases rejected | 100% fixture corpus | **4/4 shared invalid cases**, both languages | `packages/protocol/src/types/fixtures/relay-v2.json` → `invalid_publish_requests` length 4 (and 6 valid variants), driving Go `TestSignalPreKeyBundleV2SharedFixtures` and TS `signalPreKeyBundleV2.test.ts` (6) + `validateDeviceRecord.test.ts` (2). |
| Required Markdown versions and links | 100% | PASS | `keryx wiki check-links`: 19 pages, 38 internal links, 0 broken. |

All ten measurements meet their thresholds in every green execution. They do not rescue the gate:
the gate additionally requires that every check pass on one revision, and `workspace_tests` does
not.

## Comparison against T37

| Item | T27 | T37 (attempt 2) | T42 | Change vs T37 |
|---|---|---|---|---|
| `frozen_install`, `cli_build`, `workspace_typecheck`, `cli_process` | PASS | PASS | PASS | unchanged |
| `cli_dash_options` | — | PASS, 16 tests | PASS, **18** tests | +2 (T41) |
| `workspace_tests` | PASS, 82 | PASS ×3, 114 | **FAIL (intermittent), 128** | reliability regression (T42-F-001); +14 tests |
| `e2e_3_iterations` | PASS 3/3 | 3/3 in all 5 executions | **3/3 in all 9 executions** | unchanged verdict, broader evidence |
| `go_untagged` / `go_untagged_race` | PASS / not run | PASS / PASS | PASS / PASS | unchanged |
| `relayv2_race` | PASS | PASS, 36 tests | PASS, **39** tests | +3 (T40 identifier bounds) |
| `metaproject_test_strict` | PASS | PASS | PASS | unchanged (its own execution was green) |
| `health_strict` | WARN, 92, 7 P2 | WARN, 93, 7 P2 | WARN, **94**, 7 P2 | score +1; advisory only |
| `graph_rebuild` | 70 / 104 | 78 / 117 | **79 / 121** | new source and test files |
| `graph_cycles` | none | none | none | unchanged |
| `wiki_links` | 19 / 38 / 0 | identical | identical | unchanged |
| HL-N-001 | n/a | n/a | **closed**, binary-probed | new |

## Limitations

This gate establishes local technical-prototype behaviour on one macOS arm64 machine and nothing
more. It does not establish production security, safe use for sensitive communication, mobile
delivery, public deployment readiness, completion of an independent cryptographic audit, user
demand, or permanent suitability of the pinned libsignal dependency.

Specific honesty notes:

- The observed `pnpm test` failure rate (2 of 7) is a small sample on one loaded machine. The
  *mechanism* is established mechanically (default 5 000 ms budget, no declared timeout in the one
  file that fails, 1.4 s standalone versus 8–10 s under load, redness correlating with cumulative
  test time); the *rate* is load-dependent and will differ on other hardware or a quieter machine.
  A quieter machine hiding the failure would not close it.
- Nine green executions of the E2E suite are evidence that the tested paths work; they are not proof
  of a deterministic suite.
- The strict health adapter still cannot execute ESLint (no runnable lint scripts in the workspace
  packages) and does not associate the independently passing TypeScript and test commands with its
  required sources. Its score is not an independent confirmation of lint or type health, and its
  `regression 3 vs baseline` reason reflects its own moving baseline.
- `keryx test run --strict` reports an aggregate count of 2 for a workspace that runs 128 tests; the
  independent workspace run is the authoritative count. It reported PASS because the single
  `pnpm run test` execution it drove happened to be green — it is not evidence against T42-F-001.
- `go -C apps/relay test ./...` reported two packages as `(cached)`. The uncached evidence is the two
  `-count=1 -race` runs.
- Out-of-scope observation, not part of the matrix and not fully diagnosed: while building the first
  version of the HL-N-001 probe, a **second distinct sender could not claim a recipient's prekey
  bundle** — after one sender claimed Bob's bundle, a different sender's `send` failed with
  `PROTOCOL_REJECTED` (a non-retryable relay 4xx), and a `relay publish` by Bob did not restore
  claimability, consistent with publication being immutable and idempotent. The probe was
  restructured to inject the poison over HTTP instead, so this did not affect the HL-N-001 result.
  Whether this is intended prototype scope or a defect was not investigated and is left to the
  orchestrator.
- The revision identifier is the working tree; `main` is unborn and no commit was created, so this
  result cannot be pinned to a hash.

## Evidence

All paths are relative to the project root. Probe scripts live in the session scratchpad and are
listed for reproducibility, not as project artifacts.

- Test-file hash baseline (42 files): `.metaproject/data/gdctx/raw/2026-09-06T17-14-29-371Z_run.log`
- Frozen install: `.metaproject/data/gdctx/raw/2026-09-06T17-14-43-175Z_run.log`
- CLI build: `.metaproject/data/gdctx/raw/2026-09-06T17-14-49-058Z_run.log`
- Workspace typecheck: `.metaproject/data/gdctx/raw/2026-09-06T17-15-06-496Z_run.log`
- CLI process tests: `.metaproject/data/gdctx/raw/2026-09-06T17-15-27-984Z_run.log`
- F-013 suite (18 tests, standalone): `.metaproject/data/gdctx/raw/2026-09-06T17-15-57-667Z_run.log`
- Workspace test run 1 (**red**, 5 failed): `.metaproject/data/gdctx/raw/2026-09-06T17-18-34-488Z_run.log`
- Workspace test run 2 (green): `.metaproject/data/gdctx/raw/2026-09-06T17-20-42-039Z_run.log`
- Workspace test run 3 (**red**, 2 failed): `.metaproject/data/gdctx/raw/2026-09-06T17-23-07-374Z_run.log`
- `inbound.test.ts` standalone (11/11, max 1 404 ms): `.metaproject/data/gdctx/raw/2026-09-06T17-24-*_run.log`
- CLI suite unfiltered: `.metaproject/data/gdctx/raw/2026-09-06T17-25-21-156Z_run.log`
- Dedicated E2E 3/3: `.metaproject/data/gdctx/raw/2026-09-06T17-26-2*_run.log`
- Go untagged: `.metaproject/data/gdctx/raw/2026-09-06T17-26-38-528Z_run.log`
- Go untagged race (uncached): `.metaproject/data/gdctx/raw/2026-09-06T17-26-50-612Z_run.log`
- Relay-v2 tagged race (uncached): `.metaproject/data/gdctx/raw/2026-09-06T17-27-05-704Z_run.log`
- Relay-v2 race verbose count (39 tests, 0 skipped): `.metaproject/data/gdctx/raw/2026-09-06T17-27-25-568Z_run.log`
- Strict testing (PASS): `.metaproject/data/testing/artifacts/latest.md`; raw
  `.metaproject/data/testing/logs/latest.raw.log`
- Strict health (WARN, score 94): `.metaproject/data/health/artifacts/latest.md`
- Workspace test runs 5–7 (green): `.metaproject/data/gdctx/raw/2026-09-06T17-32-37-752Z_run.log`,
  `…T17-33-37-638Z_run.log`, `…T17-34-37-522Z_run.log`
- Run-outcome summary table: `.metaproject/data/gdctx/raw/2026-09-06T17-34-56-718Z_run.log`
- F-013 binary probe (15 cases): `.metaproject/data/gdctx/raw/2026-09-06T17-37-39-600Z_run.log`
- HL-N-001 binary probe: `.metaproject/data/gdctx/raw/2026-09-06T17-42-32-793Z_run.log`
- BE-R-001 identifier probe: `.metaproject/data/gdctx/raw/2026-09-06T17-43-18-308Z_run.log`
- Test-file integrity re-check (42 OK / 0 FAILED): `.metaproject/data/gdctx/raw/2026-09-06T17-43-38-671Z_run.log`
- Graph rebuild (79 / 121), cycles (none), wiki links (19 / 38 / 0): keryx CLI output, artifacts at
  `.metaproject/data/gdgraph/artifacts/summary.md` and `.metaproject/data/gdwiki/link-check/latest.md`

Routing audit: `graph_used: yes` (rebuild + cycles), `wiki_used: yes` (link check; wiki content
pages `not-relevant` to a pure execution gate), `ctx_used: yes` (every command and search routed
through `keryx ctx run` / `keryx ctx rg`), `raw_rg_used: no`.

---

# T42 attempt 3 — full re-verification after T43 / T44 / T45 / T46

Version: 0.2.0
Run: 2026-09-06T19:02Z – 19:22Z (local 23:02–23:22)
Attempt: 3 of 3. The attempt-2 section above is preserved unchanged as history.

## Verdict

**Status: PASS (gate satisfied), with one non-blocking WARN (the advisory health adapter).**

Twenty checks were re-executed independently on the current working tree. Nineteen PASS and one
WARNs (`keryx health run --strict`, advisory, exit 0, no P0/P1). **`pnpm test` — the check that
failed attempt 2 — was green in 6 of 6 complete workspace executions, including three under
deliberate CPU oversubscription.** Every one of the ten required measurements in
`metrics-and-validation.md` meets its threshold.

**T42-F-001 is shown closed by mechanism, not merely absent.** Under 24-worker and 48-worker CPU
load, individual tests in `apps/cli/src/runtime/inbound.test.ts` were measured at **5 184 ms,
5 439 ms and 6 743 ms** — i.e. the exact condition that turned attempt 2 red (a test exceeding
vitest's 5 000 ms default) *did occur*, five times across two runs, and the runs stayed green
because T43's `testTimeout: 30_000` now absorbs it. That is direct evidence of closure rather than a
quiet machine hiding the defect.

**No T43-N-001 look-alike was seen.** `Timeout calling "onTaskUpdate"` occurred 0 times in all six
workspace executions; so did `Test timed out` at any budget.

```text
Acceptance target: echolet-cli-prototype
Revision: working tree at /Users/Goodea/goodea/projects/echolet (unborn main, no commit hash)
Environment: macOS (Darwin) arm64, 10 cores, Node v26.5.0 (/opt/homebrew/bin/node), pnpm 10.0.0,
             go1.26.1 darwin/arm64, @signalapp/libsignal-client 0.102.0, keryx CLI
Status: PASS
Checks: 20 executed — 19 PASS, 1 WARN (advisory health adapter), 0 FAIL
Metrics: all ten required measurements meet their thresholds in every execution
Failures: none
Artifacts: .metaproject/data/gdctx/raw/2026-09-06T19-*.log (per-check paths under Evidence)
Decision: accepted as technical prototype
```

## Environment

- Platform: macOS (Darwin) arm64, `hw.ncpu` = 10.
- **Node v26.5.0** at `/opt/homebrew/bin/node`, which is the default `node` on PATH in this session
  and was used for every command. The T45-I-003 hazard (Node v22.12.0 lacking `node:sqlite`, which
  collapses 13 of 17 CLI suites at collection and mimics a broken implementation) did **not** apply:
  `node --version` was confirmed as v26.5.0 before the first check.
- pnpm 10.0.0; Go go1.26.1 darwin/arm64.
- Revision: unborn `main`; the working tree is the revision identifier. No commit was created.

## Independent checks

| Label | Command | Status | Bounded evidence |
|---|---|---|---|
| `frozen_install` | `pnpm install --frozen-lockfile` | PASS | Exit 0; all 8 workspace projects lockfile-current ("Already up to date"). |
| `cli_build` | `pnpm --filter @echolet/cli build` | PASS | Exit 0; production ESM bin build completes. |
| `workspace_typecheck` | `pnpm typecheck` | PASS | Exit 0; all 7 TypeScript workspace projects `Done`, no errors. |
| `cli_process` | `pnpm --filter @echolet/cli exec vitest run src/commands/cli.test.ts` | PASS | Exit 0; 1 file / 6 tests. |
| `cli_dash_options` | `pnpm --filter @echolet/cli exec vitest run src/commands/cli.dashOptionValues.test.ts` | PASS | Exit 0; 1 file / 18 tests, file unmodified (hash-verified). |
| `workspace_tests` | `pnpm test` × 6 (one driven by `keryx test run --strict`) | **PASS** | **6 green / 0 red.** 137 workspace tests every time (`apps/cli` 18 files / 92 tests). Three runs under 16-, 24- and 48-worker CPU load. See the per-run table. |
| `cli_suite_unfiltered` | `pnpm --filter @echolet/cli test` | PASS | Exit 0; 18 files / 92 tests, **no file or path exclusions**; both e2e suites in the same run as every other suite. |
| `e2e_3_iterations` | `pnpm --filter @echolet/cli test:e2e` | PASS | Exit 0; 3/3 clean real-relay two-process runs, unfiltered. |
| `go_untagged` | `go -C apps/relay test ./...` | PASS | Exit 0; handler, router, middleware, repository, validation all `ok` (3 from the Go build cache). |
| `go_untagged_race` | `go -C apps/relay test -race -count=1 ./...` | PASS | Exit 0, uncached; the same five packages `ok` under the race detector. |
| `relayv2_race` | `go -C apps/relay test -race -count=1 -tags=relayv2 -timeout=180s ./...` | PASS | Exit 0, uncached; verbose re-run records **39 top-level tests, 39 PASS, 0 FAIL, 0 SKIP, 0 DATA RACE**, 5 packages `ok`. |
| `metaproject_test_strict` | `keryx test run --strict` | PASS | Exit 0; normalized report `PASS`, passed 2 / failed 0. Its underlying `pnpm run test` execution was green (137 tests, e2e 3/3). |
| `health_strict` | `keryx health run --strict` | WARN | Exit 0; score 94, 7 findings (**P0 0, P1 0, P2 7**, all cyclomatic complexity), gate reason `health regression 3 vs baseline`. Advisory; the adapter auto-skips ESLint and TypeScript. |
| `graph_rebuild` | `keryx gdgraph build` | PASS | 83 nodes, 126 edges (attempt 2: 79 / 121). |
| `graph_cycles` | `keryx gdgraph query cycles` | PASS | No cycles found. |
| `wiki_links` | `keryx wiki check-links` | PASS | 19 pages, 38 internal links, 0 broken. |
| `t4546_binary_probe` | scratchpad probe: real relay binary + real `dist/cli.js` + a mutating loopback proxy | PASS | See **T45/T46 binary-level evidence**. |
| `f013_regression` | 18 dash-option tests, unmodified | PASS | 18/18 standalone and 18/18 inside every full-suite execution; file hash unchanged. |
| `load_repro` | `inbound.test.ts` per-test durations under 24- and 48-worker load | PASS | 5 184 / 5 439 / 5 164 / 5 280 / 6 743 ms observed — over the old 5 000 ms default, absorbed by the new 30 000 ms budget. |
| `test_integrity` | `shasum -a 256 -c` over the pre-run baseline | PASS | **46 test files OK / 0 FAILED**; 5 key config files OK / 0 FAILED; file set identical before and after. |

### Every complete, unfiltered execution observed

No exclusion of any kind — no `-t`, no file list, no path filter — was applied to any run below.
`pnpm test` is `pnpm -r test`, which already runs seven vitest instances concurrently; the
`load_workers` column is *additional* deliberate CPU oversubscription on a 10-core machine, applied
by spinner processes for the whole duration of the run.

| # | Command | load_workers | Exit | `apps/cli` | Workspace total | two-process E2E | Wall |
|---:|---|---:|---:|---|---:|---|---:|
| 1 | `pnpm test` | 0 (idle) | **0** | 18 files / 92 tests | **137 passed** | 3/3 | ~75 s |
| 2 | `pnpm test` | 0 (idle) | **0** | 18 files / 92 tests | **137 passed** | 3/3 | 58 s |
| 3 | `pnpm test` | **24** | **0** | 18 files / 92 tests | **137 passed** | 3/3 | 94 s |
| 4 | `pnpm test` | **48** | **0** | 18 files / 92 tests | **137 passed** | 3/3 | 151 s |
| 5 | `keryx test run --strict` → `pnpm run test` | 0 (idle) | **0** | 18 files / 92 tests | **137 passed** | 3/3 | — |
| 6 | `pnpm test` | **16** | **0** | 18 files / 92 tests | **137 passed** | 3/3 | 80 s |
| 7 | `pnpm --filter @echolet/cli test` | 0 (idle) | **0** | 18 files / 92 tests | (CLI only) | 3/3 | 45 s |
| 8 | `pnpm --filter @echolet/cli test:e2e` | 0 (idle) | **0** | 1 file / 3 tests | (E2E only) | 3/3 | 40 s |

**0 red out of 6 workspace-wide executions. 0 red out of 8 for the E2E suite (24/24 two-process
iterations clean; `publication-claimability` ran 7 times, green each time).** Per-package totals were
identical in every run: protocol 8, client-db 1, crypto-core 4, client-core 2, session-node 24,
mobile 6, CLI 92.

## T42-F-001 — shown closed, not merely absent (obligation 1)

The attempt-2 defect was load-dependent, so idle green runs prove little on their own. Three of the
six workspace executions therefore ran under deliberate CPU oversubscription (16, 24 and 48 spinner
processes against 10 cores, on top of the seven concurrent vitest instances `pnpm -r test` already
starts). The load was demonstrably effective: wall time rose from 58 s idle to 94 s at 24 workers and
151 s at 48 workers.

**The decisive measurement.** `apps/cli/src/runtime/inbound.test.ts` — the single file that produced
all seven failures in attempt 2 — was measured per test:

| Run | load_workers | file total | max per-test | tests over the old 5 000 ms default | tests over the new 30 000 ms budget | result |
|---|---:|---:|---:|---:|---:|---|
| R5 | 16 | 31 057 ms | 3 899 ms | 0 | 0 | green |
| R3 | 24 | 35 160 ms | **5 439 ms** | **2** (5 184, 5 439) | 0 | green |
| R4 | 48 | 46 333 ms | **6 743 ms** | **3** (5 164, 5 280, 6 743) | 0 | green |

At 24 and 48 workers the *exact* condition that turned attempt 2 red — an `inbound.test.ts` test
exceeding 5 000 ms — occurred five times across two runs, and the suite stayed green. Before T43
each of those five would have been a `Test timed out in 5000ms` failure. This is closure by
mechanism: the failure mode was reproduced under load and absorbed, not avoided.

Headroom is real but not unlimited: the worst observed loaded duration is 6 743 ms against a
30 000 ms budget, roughly 4.4×. The configured value is not so large that a genuinely stuck test
would hang the suite.

Confirmed mechanically, by routed search: `testTimeout` / `hookTimeout` appear in exactly one place
in the workspace, `apps/cli/vitest.config.ts:18-19`, both `30_000`. Per-test timeouts passed as
`it()`'s third argument still win, so the 30 000–150 000 ms values declared in
`cli.processFailures`, `inbound.batchIsolation`, `outbound.concurrentSend` and the e2e suites are
untouched — consistent with T43's stated design.

**Honesty note.** Six green executions on one 10-core macOS machine are strong but finite evidence.
What is *not* load-dependent is the mechanism: a per-test budget more than four times larger than the
worst duration ever measured on this hardware. Other packages still run on vitest's 5 000 ms
default; their suites are fast (protocol 8, client-db 1, crypto-core 4, client-core 2, session-node
24, mobile 6) and none was observed anywhere near that budget, but they carry no explicit headroom.

## T43-N-001 look-alike — not observed (obligation 2)

`Timeout calling "onTaskUpdate"` — the distinct vitest-internal condition with a hardcoded 60 s
ceiling and no config lever, recorded by T43 above roughly 30× oversubscription — occurred **0
times** in all six workspace executions, including the 48-worker run. Load was deliberately kept at
1.6×–4.8× oversubscription, below the level at which T43 observed it, precisely so that a look-alike
could not be confused with a T42-F-001 recurrence. Nothing needed to be disambiguated.

Counted per run: `timeout_5000ms_count=0`, `timeout_30000ms_count=0`, `timeout_any_count=0`,
`ontaskupdate_count=0`, `fail_lines=0` — in every one of R2–R5, and 0 failures of any kind in R1 and
the keryx-driven run.

## T45 / T46 binary-level evidence (obligation 4)

A scratchpad probe built the Go relay from source, started it on loopback, and drove the real
`apps/cli/dist/cli.js` for five independent profiles. A second loopback listener sat in front of the
relay as a **mutating proxy** so that one profile's publish response could have `claimable` removed
while everything else passed through untouched. Only exit codes, typed error codes and booleans were
printed; no plaintext, ciphertext, store key, identity material or HTTP body was rendered, and a
leak guard confirmed the message marker and all five store keys are absent from the probe output.

| Step | Observed | Meaning |
|---|---|---|
| Bob `relay publish` (first) | `exit=0 claimable=true`, exactly one JSON object on stdout | A freshly stored bundle is reported claimable. |
| Bob `relay publish` again, still unclaimed | `exit=0 claimable=true`, `same_bundle_id=true` | A repeat publish of an unclaimed bundle keeps reporting the truth. The "second publish is always unclaimable" shortcut is **not** what was implemented, and no implicit bundle rotation occurs. |
| Alice (first-contact sender) `send` | `exit=0 ok=true` | The bundle is consumed by the first sender. |
| Bob `relay publish` after the claim | `exit=0` **`claimable=false`**, `same_bundle_id=true` | **T44-002 closed at the binary level.** The operator's only recovery attempt now reports honestly that it restored nothing, instead of plain success. |
| Carol (second distinct sender, Bob's contact imported and trusted) `send` | `exit=3`, code is **exactly `PREKEY_BUNDLE_UNAVAILABLE`** (25 chars, `equals_relay_own_code=true`), `is_CONTACT_NOT_TRUSTED=false`, one JSON object | **T45 closed at the binary level.** An exhausted prekey is reported under the relay's own code, not flattened to `PROTOCOL_REJECTED`. |
| Dave (Bob's contact never imported) `send` | `exit=3`, **`CONTACT_NOT_TRUSTED`**, `names_prekey_condition=false` | **Control: a genuine trust violation still reports as one.** T45 did not over-correct. |
| The two codes compared | `codes_distinguishable=true` | An operator can tell a recoverable exhausted-prekey condition from a trust failure by machine-readable code, which was the whole point of T44/T45. |
| Erin via the proxy in pass-through mode | `exit=0 ok=true claimable=true` | Control: the proxy itself changes nothing. |
| Erin via the proxy with `claimable` deleted from the publish response | `exit=3 ok=false`, refused | **T46 strictness confirmed against the binary.** A publish success envelope that omits `claimable` is rejected; the CLI does not fall back to reporting plain success. |

Source-level corroboration, read rather than trusted: `apps/cli/src/transport/relayClient.ts:37`
declares `const claimableSchema = z.boolean()` — a required boolean, not `z.boolean().optional()` —
and line 60 uses it inside a `.strict()` object, so both a missing key and an unknown key are
refused. `remoteCodes` (line 19) carries `PREKEY_BUNDLE_UNAVAILABLE` in the allowlist of
relay-chosen codes the client will surface, and the dead v1-era `PREKEYS_EXHAUSTED` is gone. On the
relay side `apps/relay/internal/storage/repository/signal_prekey_bundle_v2.go:41-54` computes
`claimable` from the availability index (`true` on first store, `!stored.Claimed` on the idempotent
re-store path) and `apps/relay/internal/api/handler/signal_prekey_bundle_v2.go:98` always emits it.

**One INFO-level observation, not a gate failure (T42-I-001).** When the publish response omits
`claimable`, the CLI correctly refuses it — but the surfaced machine-readable code is the generic
`PROTOCOL_REJECTED` (exit 3), not a distinct malformed-response code. The transport's own
`INVALID_RELAY_RESPONSE` is flattened by `classify()`, because `reportedRelayCodes` lists
relay-chosen codes only. This is the same *shape* of problem T44/T45 fixed for the prekey case, one
layer further out: an operator sees "the relay rejected this" for what is really "the relay's answer
was malformed". It is not in scope for this gate, it does not weaken the refusal, and no requirement
names a code for this condition. Recorded for the orchestrator.

## Unfiltered end-to-end evidence (obligation 3)

No test file was excluded, no path filter applied, and no `-t` name filter used, anywhere in this
verification.

- `pnpm --filter @echolet/cli test:e2e` — exit 0, `test/e2e/two-process.test.ts` 3/3
  (13 551 / 11 969 / 11 291 ms). This is the gate command named in `metrics-and-validation.md`; its
  `vitest run test/e2e/two-process.test.ts` argument is the script's own definition in
  `apps/cli/package.json:12`, not an exclusion applied by this verification.
- Beyond that named command, the three-iteration suite ran **inside the complete, unfiltered
  `apps/cli` suite seven more times** (six workspace executions plus the CLI-only run), alongside all
  17 sibling suites including `test/e2e/publication-claimability.test.ts`.
- **24 of 24 two-process iterations clean**, across idle and 16/24/48-worker loaded conditions.

**Build race.** `apps/cli/vitest.config.ts:6` registers `./test/globalSetup.ts`, which builds
`dist/cli.js` once per vitest run before any suite starts. A routed workspace search for `build.mjs`
returns exactly two sites: `apps/cli/test/globalSetup.ts:17` and the `build` script in
`apps/cli/package.json:9`. **No suite rebuilds a binary another suite is executing.** The previously
observed `INVALID_ARGUMENTS` build race did **not** recur: 0 failures of any kind in all eight
complete executions.

## Test integrity and reconciliation (obligation 5)

**Integrity.** All 46 test files (`*.test.ts`, `*.test.tsx`, `*.test.mjs`, `*_test.go` under `apps/`
and `packages/`, excluding `node_modules` and `dist`) were SHA-256 hashed before the first command
and re-verified after the last: **46 OK / 0 FAILED**, file set identical. Five key configuration
files (`apps/cli/vitest.config.ts`, `apps/cli/package.json`, root `package.json`, `pnpm-lock.yaml`,
`packages/protocol/src/types/signalPreKeyBundleV2.ts`) likewise **5 OK / 0 FAILED**. Nothing was
modified during this verification.

**No weakening, skipping or deletion.** A routed workspace search for `.skip(`, `.only(`, `.todo(`,
`xit(`, `xdescribe(` and `t.Skip` across `apps/` and `packages/` returns **0 real matches** (the
three hits are `os.Exit(` in `apps/relay/cmd/relay/main.go`). The verbose Go run reports **0 SKIP**
of any kind. No test file lost a case relative to attempt 2.

**Reconciliation: 128 (attempt 2) → 137 (now), +9. Every unit accounted for, and every one of the
+9 is an addition.**

The entire difference is in `apps/cli` (83 → 92). The other six packages are unchanged at 45
(protocol 8, client-db 1, crypto-core 4, client-core 2, session-node 24, mobile 6).

| `apps/cli` test file | attempt 2 | now | Δ | Attribution |
|---|---:|---:|---:|---|
| `src/runtime/config.test.ts` | 3 | 3 | — | |
| `src/transport/relayClient.test.ts` | 3 | 3 | — | stub tightened by T46 (`claimable: true`); count unchanged |
| `src/transport/relayClient.pollCapacity.test.ts` | 4 | 4 | — | |
| `src/transport/relayClient.prekeyUnavailable.test.ts` | — | **3** | **+3** | new — T45: the 404 claim rejection carries `PREKEY_BUNDLE_UNAVAILABLE` |
| `src/transport/relayClient.claimable.test.ts` | — | **3** | **+3** | new — T46: a publish success envelope omitting `claimable` is refused |
| `src/runtime/profile.test.ts` | 6 | 6 | — | |
| `src/runtime/outbound.test.ts` | 6 | 6 | — | stub tightened by T46; count unchanged |
| `src/runtime/outbound.publish.test.ts` | 3 | 3 | — | stub tightened by T46; count unchanged |
| `src/runtime/outbound.concurrentSend.test.ts` | 1 | 1 | — | |
| `src/runtime/inbound.test.ts` | 11 | 11 | — | the attempt-2 failing file; unchanged, now green under load |
| `src/runtime/inbound.pollBatchSize.test.ts` | 1 | 1 | — | |
| `src/runtime/inbound.batchIsolation.test.ts` | 10 | 10 | — | |
| `src/commands/cli.test.ts` | 6 | 6 | — | stub tightened by T46; count unchanged |
| `src/commands/cli.processFailures.test.ts` | 8 | 8 | — | |
| `src/commands/cli.dashOptionValues.test.ts` | 18 | 18 | — | stub tightened by T46; count unchanged |
| `src/commands/cli.relayErrorCodes.test.ts` | — | **2** | **+2** | new — T45: exhausted send reports the prekey code, `400 INVALID_SIGNATURE` publish stays `PROTOCOL_REJECTED` |
| `test/e2e/two-process.test.ts` | 3 | 3 | — | |
| `test/e2e/publication-claimability.test.ts` | — | **1** | **+1** | new — T44/T45 e2e against the real relay binary |
| **`apps/cli` total** | **83** | **92** | **+9** | |

Test-file count 42 → 46; the four added files are exactly the four rows above. **No file was
removed and no existing file lost a test.**

**On the five stubs T46 tightened.** `claimable` now appears in exactly five test stubs —
`relayClient.test.ts:34`, `cli.test.ts:131`, `cli.dashOptionValues.test.ts:275`,
`outbound.publish.test.ts:68` and `outbound.test.ts:80` — each emitting `claimable: true`, which is
what the real relay emits. That change makes the stubs *conform* to the contract they exercise; it
is strictly stronger than omitting the field, and none of the five files changed its test count
(3, 6, 18, 3, 6 — identical to attempt 2). This is a tightening, not a weakening.

**Go side.** The `relayv2`-tagged race suite records **39 top-level tests, 39 PASS, 0 FAIL, 0 SKIP,
0 DATA RACE** — identical to attempt 2, as expected: T45 changed relay source (`repository`,
`service`, `handler`) but the existing handler test unmarshals a subset struct, so the additive
`claimable` field required no Go assertion change and no new Go test file. All Go test files are
byte-identical to the pre-run baseline.

## Required measurements

| Metric | Threshold | Measured | Evidence source |
|---|---|---|---|
| Clean end-to-end runs | 3/3 pass | **3/3 in all eight complete executions (24/24 iterations)**, idle and under 16/24/48-worker load | `pnpm test` ×5, `keryx test run --strict`, `pnpm --filter @echolet/cli test`, `test:e2e` — all unfiltered. |
| Concurrent claim winners | exactly 1 of at least 20 | **1 of 20**, PASS under `-race -count=1` | `TestSignalPreKeyBundleV2ConcurrentClaimsAllocateExactlyOnce`, `const claimants = 20` (`apps/relay/internal/storage/repository/prekey_bundle_v2_test.go:138`); losers assert `PREKEY_BUNDLE_UNAVAILABLE`. |
| Lost-response claim retries | same bundle bytes for same claim ID | PASS | `TestSignalPreKeyBundleV2ClaimReplayIsExactAndSelectorBound`, tagged race suite, uncached. |
| Reused OTK publications | 100% rejected across changed IDs, expiry, restart | PASS | `TestSignalPreKeyBundleV2OneTimePreKeyReservationsArePermanent`, `TestSignalPreKeyBundleV2PublishIsImmutableAndIdempotent`, green under `-race -count=1 -tags=relayv2`. Corroborated at the binary level: the third publish reports `claimable=false` with an unchanged `bundle_id`. |
| Offline delivery | 1/1 delivered after receiver start | PASS in every E2E iteration (24/24) | `two-process.test.ts` — Bob has no running process during the send; after `poll`, history length 1. |
| Sender restart exact retry | ciphertext bytes identical | PASS | `two-process.test.ts` — two `/v1/messages/send` bodies byte-identical, single `/v2/prekeys/claim`; plus `outbound.publish.test.ts`. |
| Receiver duplicate history entries | 0 | **0** | `two-process.test.ts`; `inbound.test.ts` restart/ack-recovery case; `outbound.concurrentSend.test.ts`; `inbound.batchIsolation.test.ts`. |
| Known plaintext marker in relay DB/logs | 0 occurrences | **0 occurrences** | `two-process.test.ts` — markers asserted absent from proxied HTTP traffic, from the relay log, and from a recursive byte scan of the relay data directory after the relay is stopped; `publication-claimability.test.ts` repeats the marker guard per CLI invocation. The T45/T46 binary probe adds an independent leak guard: `markers_absent_from_probe_output=true`. Occurrence count only; no content reproduced. |
| Invalid contract cases rejected | 100% fixture corpus | **4/4 shared invalid cases**, both languages | `packages/protocol/src/types/fixtures/relay-v2.json:94` `invalid_publish_requests`, driving Go `TestSignalPreKeyBundleV2SharedFixtures` (`prekey_bundle_v2_test.go:44`) and TS `signalPreKeyBundleV2.test.ts:73` (6) + `validateDeviceRecord.test.ts` (2). |
| Required Markdown versions and links | 100% | PASS | `keryx wiki check-links`: 19 pages, 38 internal links, 0 broken. |

All ten measurements meet their thresholds in every execution, and every required check passes on
this one revision, so the gate is satisfied on its own terms.

## Comparison against attempt 2

| Item | T42 attempt 2 | T42 attempt 3 | Change |
|---|---|---|---|
| `frozen_install`, `cli_build`, `workspace_typecheck`, `cli_process` | PASS | PASS | unchanged |
| `cli_dash_options` | PASS, 18 tests | PASS, 18 tests | unchanged |
| `workspace_tests` | **FAIL (2 red of 7)**, 128 | **PASS (0 red of 6)**, **137** | **defect closed**; +9 tests |
| `inbound.test.ts` over 5 000 ms under load | caused 7 failures | **occurred 5 times, absorbed** | T43 `testTimeout: 30_000` |
| `e2e_3_iterations` | 3/3 in all 9 executions | 3/3 in all 8 executions | unchanged verdict |
| `go_untagged` / `go_untagged_race` | PASS / PASS | PASS / PASS | unchanged |
| `relayv2_race` | PASS, 39 tests | PASS, 39 tests, 0 skipped, 0 data races | unchanged |
| `metaproject_test_strict` | PASS | PASS | unchanged |
| `health_strict` | WARN, 94, 7 P2 | WARN, 94, 7 P2 (0 P0/P1) | unchanged; advisory only |
| `graph_rebuild` | 79 / 121 | **83 / 126** | four new test files and their edges |
| `graph_cycles` | none | none | unchanged |
| `wiki_links` | 19 / 38 / 0 | 19 / 38 / 0 | unchanged |
| Exhausted prekey vs trust rejection | flattened to `PROTOCOL_REJECTED` (out-of-scope observation) | **distinguishable at the binary level** | T45 |
| No-op republish | reported plain success | **reports `claimable: false`** | T45 |
| Publish response missing `claimable` | field optional | **refused** | T46 |

## Limitations

This gate establishes local technical-prototype behaviour on one macOS arm64 machine and nothing
more. It does not establish production security, safe use for sensitive communication, mobile
delivery, public deployment readiness, completion of an independent cryptographic audit, user
demand, or permanent suitability of the pinned libsignal dependency.

Specific honesty notes:

- Six green workspace executions, three of them loaded, are strong evidence but a finite sample on
  one 10-core machine. What is established beyond the sample is the *mechanism*: the exact
  over-5 000 ms condition was reproduced five times under load and absorbed by a budget more than
  four times larger than the worst duration measured.
- Load here reached 4.8× oversubscription. It was deliberately kept below the ~30× level at which
  T43 recorded T43-N-001, so this run says nothing about behaviour at that extreme, and the
  hardcoded 60 s `onTaskUpdate` ceiling remains without a config lever.
- Packages other than `apps/cli` still run on vitest's 5 000 ms default. None was observed near it,
  but they carry no explicit headroom.
- The strict health adapter still cannot execute ESLint (no runnable lint scripts in the workspace
  packages) and does not associate the independently passing TypeScript and test commands with its
  required sources. Its score is advisory and its `regression 3 vs baseline` reason reflects its own
  moving baseline. It reports 0 P0 and 0 P1.
- `keryx test run --strict` reports an aggregate count of 2 for a workspace that runs 137 tests; the
  independent workspace runs are the authoritative count.
- `go -C apps/relay test ./...` reported three packages as `(cached)`. The uncached evidence is the
  two `-count=1 -race` runs.
- T42-I-001 (a malformed relay response surfacing as `PROTOCOL_REJECTED` rather than a distinct
  code) is recorded above as an observation, not a gate failure.
- The structural limitation T44 identified — one published bundle serves exactly one first-contact
  sender — is unchanged by T45/T46; those tasks made the condition *legible*, not absent. The binary
  probe reproduces it directly (Carol's send fails). It remains undocumented in
  `specification.md`, which T45 records as belonging to the flow's documentation task.
- The revision identifier is the working tree; `main` is unborn and no commit was created, so this
  result cannot be pinned to a hash.

## Evidence (attempt 3)

All project-relative paths. Probe and helper scripts live in the session scratchpad and are listed
for reproducibility, not as project artifacts.

- Test-file hash baseline (46 files): `.metaproject/data/gdctx/raw/2026-09-06T19-03-05-907Z_run.log`
- Frozen install: `.metaproject/data/gdctx/raw/2026-09-06T19-03-13-454Z_run.log`
- CLI build: `.metaproject/data/gdctx/raw/2026-09-06T19-03-20-597Z_run.log`
- Workspace typecheck: `.metaproject/data/gdctx/raw/2026-09-06T19-03-31-413Z_run.log`
- CLI process tests (6): `.metaproject/data/gdctx/raw/2026-09-06T19-03-57-660Z_run.log`
- Dash-option tests (18): `.metaproject/data/gdctx/raw/2026-09-06T19-04-15-100Z_run.log`
- Workspace run 1 (idle, green): `.metaproject/data/gdctx/raw/2026-09-06T19-05-27-699Z_run.log`
- Workspace run 2 (idle, green): `.metaproject/data/gdctx/raw/2026-09-06T19-07-04-787Z_run.log`
- Workspace run 3 (**24-worker load**, green): `.metaproject/data/gdctx/raw/2026-09-06T19-08-49-136Z_run.log`
- `inbound.test.ts` durations at 24 workers: `.metaproject/data/gdctx/raw/2026-09-06T19-09-07-758Z_run.log`
- Workspace run 4 (**48-worker load**, green): `.metaproject/data/gdctx/raw/2026-09-06T19-11-50-115Z_run.log`
- `inbound.test.ts` durations at 48 workers: `.metaproject/data/gdctx/raw/2026-09-06T19-11-57-220Z_run.log`
- Dedicated E2E 3/3: `.metaproject/data/gdctx/raw/2026-09-06T19-12-53-208Z_run.log`
- CLI suite unfiltered (18 files / 92 tests): `.metaproject/data/gdctx/raw/2026-09-06T19-13-47-097Z_run.log`
- Go untagged: `.metaproject/data/gdctx/raw/2026-09-06T19-13-56-913Z_run.log`
- Go untagged race (uncached): `.metaproject/data/gdctx/raw/2026-09-06T19-14-07-497Z_run.log`
- Relay-v2 tagged race (uncached): `.metaproject/data/gdctx/raw/2026-09-06T19-14-21-665Z_run.log`
- Relay-v2 race verbose count (39 / 39 / 0 / 0): `.metaproject/data/gdctx/raw/2026-09-06T19-14-45-118Z_run.log`
- Strict testing (PASS): `.metaproject/data/testing/artifacts/latest.md`; raw `.metaproject/data/testing/logs/latest.raw.log`
- Strict health (WARN, 94, 0 P0/P1): `.metaproject/data/health/artifacts/latest.md`
- T45/T46 binary probe: `.metaproject/data/gdctx/raw/2026-09-06T19-18-25-784Z_run.log`
- Per-file test counts: `.metaproject/data/gdctx/raw/2026-09-06T19-18-43-819Z_run.log`
- Test/config integrity re-check (46 OK / 0 FAILED, 5 OK / 0 FAILED): `.metaproject/data/gdctx/raw/2026-09-06T19-18-58-688Z_run.log`
- Skip/only/todo search (0 real matches) and `testTimeout` search (1 file): `.metaproject/data/gdctx/raw/2026-09-06T19-19-05-624Z_rg.log`, `…T19-19-05-728Z_rg.log`
- Workspace run 6 (**16-worker load**, green): `.metaproject/data/gdctx/raw/2026-09-06T19-20-56-169Z_run.log`
- `inbound.test.ts` durations at 16 workers: `.metaproject/data/gdctx/raw/2026-09-06T19-21-08-293Z_run.log`
- Graph rebuild (83 / 126), cycles (none), wiki links (19 / 38 / 0): keryx CLI output; artifacts at
  `.metaproject/data/gdgraph/artifacts/summary.md` and `.metaproject/data/gdwiki/link-check/latest.md`

Routing audit: `graph_used: yes` (rebuild + cycles), `wiki_used: yes` (link check; wiki content
pages `not-relevant` to a pure execution gate), `ctx_used: yes` (every command, search and large
read routed through `keryx ctx run` / `keryx ctx rg` / `keryx ctx read`), `raw_rg_used: no`.
