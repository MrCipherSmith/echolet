# T49 — full prototype re-verification after the T47 / T48 round-2 fix wave

Version: 0.1.0
Worker: `code-verifier` · flow `001` · dispatch `001-T49-verify`
Run: 2026-09-07 (local 00:41–01:06) · project root `/Users/Goodea/goodea/projects/echolet`

## Verdict

**Matrix status: PASS (every required check green), with one non-blocking WARN (the advisory health
adapter) — and one HIGH finding that the matrix does not cover.**

Twenty checks were executed independently on the current working tree. Nineteen PASS, one WARNs
(`keryx health run --strict`, advisory, exit 0, 0 P0 / 0 P1), none FAIL. All ten required
measurements in `docs/requirements/echolet-cli-prototype/metrics-and-validation.md` meet their
thresholds. The workspace suite was green in four complete executions including two under deliberate
CPU oversubscription; the three-iteration real E2E was green in every execution, unfiltered.

**The poison-envelope wedge is NOT eliminated. It is bounded, and the bound is cheap to exceed.**
Against the real relay binary and the real `dist/cli.js`, at *default* configuration, **49
unauthenticated POSTs totalling about 12.8 MB permanently wedge a victim's mailbox**: the poll fails
closed on exit 3 `INBOUND_REJECTED`, the legitimate message behind the flood is never delivered, and
three further polls make no progress at all. That is finding **T49-F-001**, a re-scoped and measured
form of the residual T48 recorded as T48-003. It is a HIGH availability defect, not a gate check, so
it does not flip the matrix verdict — but it must not be read as "the wedge is closed".

```text
Acceptance target: echolet-cli-prototype
Revision: working tree at /Users/Goodea/goodea/projects/echolet (unborn main, no commit hash)
Environment: macOS (Darwin) arm64, 10 cores, Node v26.5.0 (/opt/homebrew/bin/node), pnpm 10.0.0,
             go1.26.1 darwin/arm64, keryx 0.2.80
Status: PASS
Checks: 20 executed — 19 PASS, 1 WARN (advisory health adapter), 0 FAIL
Metrics: all ten required measurements meet their thresholds in every execution
Failures: none among the required checks.
          Outside the matrix: T49-F-001 (HIGH) — the mailbox wedge is bounded at 16 pages, and the
          bound is reachable for 49 unauthenticated POSTs (~12.8 MB) at default configuration;
          T49-F-002 (MINOR) — no test exercises GetEnvelopeBatchFrom with a non-empty cursor;
          T49-I-001 (INFO) — the poll signature does not cover the new `cursor` field.
Artifacts: .metaproject/data/gdctx/raw/2026-09-06T20-4*.log and …T21-0*.log
Decision: accepted as technical prototype on the gate's own terms, with T49-F-001 recorded open
```

## Environment

- Platform: macOS (Darwin) arm64, `hw.ncpu` = 10.
- **Node v26.5.0 at `/opt/homebrew/bin/node`**, the default `node` on PATH, confirmed before the
  first check and used for every command. The T45-I-003 hazard (Node v22.12.0 lacking `node:sqlite`,
  which collapses 13 of 17 CLI suites at collection) did **not** apply.
- pnpm 10.0.0; Go go1.26.1 darwin/arm64; keryx 0.2.80.
- Revision: unborn `main` (`git rev-parse HEAD` → `fatal: ambiguous argument 'HEAD'`). The working
  tree is the revision identifier. No commit was created; `git status --porcelain` reports 23
  untracked entries, unchanged from the T48 snapshot.

## Independent checks

| Label | Command | Status | Bounded evidence |
|---|---|---|---|
| `frozen_install` | `pnpm install --frozen-lockfile` | PASS | Exit 0; all 8 workspace projects lockfile-current ("Already up to date"). |
| `cli_build` | `pnpm --filter @echolet/cli build` | PASS | Exit 0; production ESM bin build completes. |
| `workspace_typecheck` | `pnpm typecheck` | PASS | Exit 0; all 7 TypeScript projects `Done`, no errors. |
| `cli_process` | `pnpm --filter @echolet/cli exec vitest run src/commands/cli.test.ts src/commands/cli.dashOptionValues.test.ts` | PASS | Exit 0; 2 files / **24 tests** (6 + 18). |
| `workspace_tests` | `pnpm test` × 4 (one driven by `keryx test run --strict`) | PASS | **4 green / 0 red.** **139 tests** every time (`apps/cli` 19 files / 94 tests). Two runs under 24- and 48-worker CPU load. |
| `cli_suite_unfiltered` | `pnpm --filter @echolet/cli test` | PASS | Exit 0; 19 files / 94 tests, **no file or path exclusion**; both e2e suites in the same run as every other suite. |
| `e2e_3_iterations` | `pnpm --filter @echolet/cli test:e2e` | PASS | Exit 0; **3/3** clean real-relay two-process runs, unfiltered. |
| `go_untagged` | `go -C apps/relay test ./...` | PASS | Exit 0; handler, router, middleware, repository, validation `ok` (middleware cached). |
| `go_untagged_race` | `go -C apps/relay test -race -count=1 ./...` | PASS | Exit 0, uncached; the same five packages `ok` under the race detector. |
| `relayv2_race` | `go -C apps/relay test -race -count=1 -tags=relayv2 -timeout=180s ./...` | PASS | Exit 0, uncached; verbose re-run records **44 top-level tests, 44 PASS, 0 FAIL, 0 SKIP, 0 DATA RACE**, 5 packages `ok` (T42: 39). |
| `metaproject_test_strict` | `keryx test run --strict` | PASS | Exit 0; normalized report `PASS`, passed 2 / failed 0. Its underlying `pnpm run test` was green (139 tests, e2e 3/3). |
| `health_strict` | `keryx health run --strict` | WARN | Exit 0; score 94, 7 findings (**0 P0, 0 P1**, 7 warnings, all cyclomatic complexity), gate reason `health regression 3 vs baseline`. Advisory; the adapter auto-skips ESLint and TypeScript. |
| `graph_rebuild` | `keryx gdgraph build` | PASS | **84 nodes, 130 edges** (T42: 83 / 126). |
| `graph_cycles` | `keryx gdgraph query cycles` | PASS | No cycles found. |
| `wiki_links` | `keryx wiki check-links` | PASS | 19 pages, 38 internal links, 0 broken. |
| `shape_parity_binary_probe` | scratchpad probe: real relay binary + real `dist/cli.js` | PASS | 8/8 shape-invalid envelopes refused at ingress with 400 `INVALID_SCHEMA`; shape-valid control accepted; both R2-002 routes bounded 4xx. See §1. |
| `wedge_binary_probe` | scratchpad probe, six scenarios against the real relay | **PASS as a measurement, and it measures a defect** | Wedge closed at 60 and at 799 small poison; **reachable and permanent at 800 small or 49 max-size poison.** See §1–§2. |
| `cursor_abuse_probe` | scratchpad probe, 11 tampered continuation tokens | PASS | 9/11 bounded 400 `INVALID_SCHEMA`; 0 of 11 produced a 500; no silent reset to position zero; every server-issued token is a ≤2-digit decimal. See §3. |
| `f005c_probe` | scratchpad probe with `poll_batch_size = 2` | PASS | Expired envelopes at the head consumed neither the batch bound nor the cursor: one page, one envelope, `next_cursor` null, message delivered. See §4. |
| `test_integrity` | `shasum -a 256 -c` over the pre-run baseline | PASS | **57 OK / 0 FAILED** (51 test files + 6 configuration files); test-file set identical before and after (0-line diff). |

### Every complete, unfiltered execution observed

No exclusion of any kind — no `-t`, no file list, no path filter — was applied to any run below.
`pnpm test` is `pnpm -r test`, which already runs seven vitest instances concurrently; `load_workers`
is *additional* deliberate CPU oversubscription on a 10-core machine, applied by spinner processes
for the whole duration of the run.

| # | Command | load_workers | Exit | `apps/cli` | Workspace total | two-process E2E | Wall |
|---:|---|---:|---:|---|---:|---|---:|
| 1 | `pnpm test` | 0 (idle) | **0** | 19 files / 94 tests | **139 passed** | 3/3 | 56 s |
| 2 | `pnpm test` | **24** | **0** | 19 files / 94 tests | **139 passed** | 3/3 | 101 s |
| 3 | `pnpm test` | **48** | **0** | 19 files / 94 tests | **139 passed** | 3/3 | 153 s |
| 4 | `keryx test run --strict` → `pnpm run test` | 0 (idle) | **0** | 19 files / 94 tests | **139 passed** | 3/3 | — |
| 5 | `pnpm --filter @echolet/cli test` | 0 (idle) | **0** | 19 files / 94 tests | (CLI only) | 3/3 | 50 s |
| 6 | `pnpm --filter @echolet/cli test:e2e` | 0 (idle) | **0** | 1 file / 3 tests | (E2E only) | 3/3 | 42 s |

**0 red out of 4 workspace-wide executions; 0 red out of 6 for the E2E suite (18/18 two-process
iterations clean; `publication-claimability` ran 5 times, green each time).** Per-package totals were
identical in every run: protocol 8, client-db 1, crypto-core 4, client-core 2, session-node 24,
mobile 6, CLI 94.

Load was demonstrably effective (56 s idle → 101 s at 24 workers → 153 s at 48 workers, a 2.7×
stretch). Counters per run: `timeout_5000ms_count=0`, `timeout_any_count=0`, **`ontaskupdate_count=0`**,
`fail_marker_count=0`, `ELIFECYCLE=0` — in all four workspace executions. **No T43-N-001 look-alike
(`Timeout calling "onTaskUpdate"`) occurred**, so nothing needed disambiguating from a T42-F-001
recurrence. `testTimeout` remains declared in exactly one place, `apps/cli/vitest.config.ts:18`
(`30_000`).

---

## 1. Obligation 1 — the wedge against the real relay binary, not only in the suite

A scratchpad probe (`wedge-probe.mjs`, outside the repository, removed at the end) built
`apps/relay/cmd/relay` from this tree into a temp directory, started it on loopback at **default
configuration** (only `ECHOLET_HTTP_ADDR`, `ECHOLET_DATA_DIR` and the rate limit were set — see the
honesty note), initialised two real CLI profiles through a recording/mutating loopback proxy, and
drove the real `apps/cli/dist/cli.js`. Only labels, counts, HTTP status codes, typed error codes and
exit codes were printed; a leak guard confirmed the message marker and both store keys are absent
from the relay log.

### Half one — a shape-invalid envelope is refused at ingress

Eight unauthenticated `POST /v1/messages/send` bodies, each differing from a valid envelope in one
field:

| Case | Observed |
|---|---|
| `envelope_id` non-UUID | 400 `INVALID_SCHEMA` |
| `message_id` non-UUID | 400 `INVALID_SCHEMA` |
| `sender_device_id` non-UUID | 400 `INVALID_SCHEMA` |
| `recipient_device_id` non-UUID | 400 `INVALID_SCHEMA` |
| `payload_type` not the literal | 400 `INVALID_SCHEMA` |
| `envelope_id` = max UUID (`ffffffff-…`), which zod 4 refuses | 400 `INVALID_SCHEMA` |
| `envelope_id` version nibble `0` | 400 `INVALID_SCHEMA` |
| `envelope_id` variant nibble `c` | 400 `INVALID_SCHEMA` |
| **control**: a shape-valid envelope | **200** |

The three edge cases (max UUID, version `0`, variant `c`) matter because they are exactly where
T48's transcription of `z.string().uuid()` could have drifted from the client's own parser. It did
not. **R2-001 path A is closed at the route.**

The two R2-002 routes were probed on the same binary: a 64 960-byte `device_id` on
`/v1/device-records/publish` and a 65 000-byte `envelope_ids` element on `/v1/mailbox/ack` both
answer **400 `INVALID_SCHEMA`**, never the previously reported 500.

### Half two — shape-valid, permanently unacceptable envelopes at the head no longer block delivery

Scenario: Alice sends one real message to Bob; then *N* shape-valid but permanently unacceptable
envelopes are POSTed unauthenticated with `envelope_id`s of the form
`00000000-0000-1000-8000-…`, which badger's key order puts ahead of every random v4 UUID the CLI
issues (verified per run: `legitimate_envelope_id_sorts_after_poison=true`).

| N | ciphertext | pages walked | page envelope counts | poll | received | Bob history | acks |
|---:|---|---:|---|---|---:|---:|---:|
| 60 | 512 B | 2 | 50, 11 | exit 0 | 1 | 1 | 1 |
| 799 | 512 B | 16 | 50 × 16 | exit 0 | 1 | 1 | 1 |
| 10 | 262 144 B | 4 | 3, 3, 3, 2 | exit 0 | 1 | 1 | 1 |
| 48 | 262 144 B | 16 | 3 × 15, then 4 | exit 0 | 1 | 1 | 1 |

In every one of these the cursor was sent on page 2 onwards (`cursor_sent_per_page=[n,y,y,…]`), the
walk resumed *past* the poison rather than replaying page one, exactly one ack was issued, and it
carried only the legitimate envelope. The 60-envelope case is the direct counterpart of the
reproduction the two round-2 reviewers wrote up: before T48 the first poll threw before
`ackPending()` and the legitimate envelope was never reached.

**How this was checked, in one sentence:** by observing the victim's own `poll` exit code, its
`received` count, its `history` length and the per-page envelope counts and cursor presence recorded
at a proxy sitting between the real CLI and the real relay — not by reading the test suite.

---

## 2. Obligation 2 — the residual, stated plainly

**A wedge is still reachable, it is permanent while the flood lasts, and at default configuration it
costs an unauthenticated attacker 49 requests and about 12.8 MB.**

The page walk is bounded at `maxPollPagesPerPoll = 16` (`apps/cli/src/runtime/inbound.ts:71`). Fill
16 pages with permanently-rejected envelopes and the poll re-raises before `ackPending()`, exactly as
F-012 requires — which is correct behaviour for a mailbox that contains nothing acceptable, and a
denial of service for a mailbox that does.

### The measured threshold on the real relay at default configuration

Two page-size regimes exist, because the relay applies **both** an envelope-count bound and a
~1 MiB response byte budget (`pollEnvelopeByteBudget`, `mailbox_handler.go:51`), and the byte budget
bites first for large envelopes.

| Regime | Effective page size (measured) | Threshold (measured) | Attacker cost |
|---|---:|---:|---|
| Minimum-size poison, count-bounded | **50** (client `poll_batch_size` default 50, server cap 100) | 799 delivers, **800 wedges** | 800 POSTs, ~0.7 MB |
| **Maximum-size poison, byte-bounded** | **3** (262 144-byte ciphertext, the `ECHOLET_MAX_MESSAGE_BYTES` default) | 48 delivers, **49 wedges** | **49 POSTs, ~12.8 MB** |

The 48-vs-49 boundary is not an off-by-one artefact: with 48 the sixteenth page returned **4**
envelopes — three big poison plus the small legitimate one, which still fitted inside the byte
budget — so it was delivered. With 49 the sixteenth page returned three poison and stopped on the
budget, the walk ended, and the legitimate envelope was never seen.

### The wedge is permanent, not transient

At 49 max-size envelopes:

```
poll #1  exit=3 INBOUND_REJECTED  pages=16  page sizes [3×16]  history=0  acks=0
retry 1  exit=3  pages=16  first_page=3
retry 2  exit=3  pages=16  first_page=3
retry 3  exit=3  pages=16  first_page=3
history_after_retries=0
```

Every walk restarts at the head of the mailbox and the poison is deliberately never acknowledged, so
each retry reproduces the identical failure. Bob cannot receive Alice's message by any client action.

**Attacker cost and preconditions, stated without softening:**

- **49 unauthenticated `POST /v1/messages/send` requests, ~12.8 MB total.** No credential, no
  session, no prekey claim.
- The only secret needed is the victim's `recipient_mailbox_id`, which is a digest of the identity id
  published in the victim's own contact card — i.e. known to anyone the victim has ever exchanged
  contacts with, and to anyone who obtains that card.
- The default rate limit is 120 requests/minute, so 49 requests is **under 30 seconds** of traffic.
  Even the 800-envelope small-poison variant is under 7 minutes.
- The relay's retention cap is 168 h, so one flood wedges the mailbox for up to **7 days**;
  refreshing it costs the same ~12.8 MB per week per victim.
- The wedge also amplifies: every subsequent victim poll now issues **32 HTTP requests** (16
  challenge + 16 poll round trips) instead of 2, against both the client and the relay.

**Verdict on the residual: the class of defect the round-2 reviewers reported is bounded, not
eliminated.** T48's own framing (T48-003) is accurate and is confirmed here with a number. The
16-page bound raises the attacker's cost from *one* envelope to *forty-nine*; it does not remove the
capability, and forty-nine unauthenticated POSTs is not a meaningful barrier. Recorded as
**T49-F-001**, severity HIGH (`major`), confidence high, verified by execution against the real
binary.

**Honesty note on the probe configuration.** Everything that determines the threshold — the client's
`poll_batch_size` (50, written by `cli init`), the relay's `ECHOLET_MAX_MAILBOX_BATCH` (100),
`ECHOLET_MAX_MESSAGE_BYTES` (262 144), the 1 MiB response budget and the 16-page client bound — was
left at its default. The one deviation is `ECHOLET_RATE_LIMIT_PER_MINUTE`, raised so that rate
limiting would not confound the measurement of *how many envelopes* are needed. The default rate
limit is reported above as part of the attacker's cost, and it does not change the threshold.

---

## 3. Obligation 3 — the new cursor cannot be abused

The `cursor` is **not** covered by the poll signature (`CreateMailboxChallengeMessage` signs
`challenge_id`, `recipient_mailbox_id`, `device_id` and the nonce — `mailbox_handler.go:234-243`).
That made the abuse test easy to run honestly: the probe's loopback proxy replaced the client's
echoed cursor in flight with eleven hostile values and recorded what the real relay answered.

| Tampered cursor | Status | Code | Envelopes returned |
|---|---:|---|---:|
| `"abc"` | 400 | `INVALID_SCHEMA` | — |
| `"-1"` | 400 | `INVALID_SCHEMA` | — |
| `"1.0"` | 400 | `INVALID_SCHEMA` | — |
| `"1e3"` | 400 | `INVALID_SCHEMA` | — |
| `" 1"` (leading space) | 400 | `INVALID_SCHEMA` | — |
| `"0x10"` | 400 | `INVALID_SCHEMA` | — |
| Arabic-Indic digits `"١٢٣"` | 400 | `INVALID_SCHEMA` | — |
| 16 digits (over `maxMailboxCursorDigits`) | 400 | `INVALID_SCHEMA` | — |
| 300 characters | 400 | `INVALID_SCHEMA` | — |
| `"999999999999999"` (15 digits, past the end) | **200** | — | **0**, `next_cursor` absent |
| `"0"` (explicit head) | 200 | — | 50, `next_cursor` present |

- **Never a 500.** 0 of 11 produced a 5xx.
- **Never a silent reset to position zero.** An unusable token is refused, not coerced; the only
  response that starts from the head is the one that explicitly *said* zero, which is identical to
  what a cursorless poll returns anyway.
- **Server-controlled and not derived from `envelope_id`.** Every `next_cursor` the relay issued in
  these runs was a decimal position, maximum length **2** characters (value `50`), all matching
  `^[0-9]{1,15}$`, none with UUID shape. Source: `encodeMailboxCursor` is `strconv.Itoa(position)`
  over a count the server computed (`mailbox_repo.go:159-161`); the code comment at
  `mailbox_repo.go:212-215` records that a key-based cursor was rejected precisely because the key's
  second half is the sender-supplied `envelope_id` (the F-009 constraint).
- **Bounded.** 15 decimal digits at the relay (`maxMailboxCursorDigits`), and independently
  `z.string().min(1).max(256)` on a still-`.strict()` request object at the client
  (`relayClient.ts:38`).
- **No cross-mailbox reach.** The mailbox is taken from `challenge.RecipientMailboxID`
  (`mailbox_handler.go:259`), never from the request, so no cursor value can select another
  mailbox.

**One observation, recorded as INFO (T49-I-001), not a gate failure.** Because the cursor is outside
the signed challenge message, an on-path attacker can rewrite it. The blast radius is small: they
cannot read another mailbox, cannot cause a 500, cannot cause an acknowledgement, and cannot make a
message disappear (every subsequent poll restarts at the head). The worst outcome is suppressing the
remaining pages of one poll — which the same attacker could achieve by dropping the request. The
`"999999999999999"` row is the mechanism: a syntactically valid but out-of-range position is
accepted and answered with an empty final page rather than a 4xx. That is a safe answer, and it is
also the one case where a tampered cursor is not rejected.

---

## 4. Obligation 4 — F-005 (c) still holds after the cursor skip was added

Source order in `GetEnvelopeBatchFrom` (`mailbox_repo.go:249-265`): the `ExpiresAtMs <= nowMS` skip
runs **before** the cursor's `remaining--`, and both run before the count bound and the byte budget.
An expired record therefore cannot consume a slot, cannot consume a byte, and cannot shift the resume
position.

Confirmed empirically against the real relay. Temp profiles were given `poll_batch_size = 2` (in the
temp directory only — nothing in the repository was touched), Alice sent one real message, then three
short-lived envelopes were injected ahead of it and allowed to pass their declared expiry:

```
pages_walked=1  page_envelope_counts=[1]  next_cursor_per_page=[null]
poll exit=0  received=1  bob history entries=1
```

One page sufficed. Had expiry been applied after the batch bound of 2, the first page would have
been empty with `next_cursor` present and the walk would have needed two or three pages. It needed
one, carrying exactly the single live envelope, with no cursor issued.

Regression cover: `TestGetEnvelopeBatchFiltersExpiredBeforeApplyingBatchLimit` and
`TestGetEnvelopesFiltersExpiredBeforeApplyingBatchLimit` both PASS in the tagged race suite.

**Coverage gap found while checking this (T49-F-002, MINOR).** A routed search shows
`GetEnvelopeBatchFrom` has exactly three call sites — the two-line `GetEnvelopeBatch` delegation, the
service passthrough, and the handler — and **no test anywhere calls it with a non-empty cursor**.
Both F-005 (c) regressions call the no-cursor form. The cursor-aware selection path that every
production poll now uses therefore has no repository-level test, and in particular nothing pins
"expiry is filtered before the cursor is consumed" against a future edit. The property holds today
by source reading and by the probe above; it is not protected by the suite.

---

## 5. Obligation 5 — unfiltered end-to-end evidence and load

No test file was excluded, no path filter applied, and no `-t` name filter used anywhere in this
verification.

- `pnpm --filter @echolet/cli test:e2e` — exit 0, `test/e2e/two-process.test.ts` **3/3**. This is the
  gate command named in `metrics-and-validation.md`; its `vitest run test/e2e/two-process.test.ts`
  argument is the script's own definition in `apps/cli/package.json`, not an exclusion applied here.
- Beyond that named command, the three-iteration suite ran **inside the complete, unfiltered
  `apps/cli` suite five more times** (four workspace executions plus the CLI-only run), alongside all
  18 sibling suites including `test/e2e/publication-claimability.test.ts`.
- **18 of 18 two-process iterations clean**, across idle and 24-/48-worker loaded conditions.
- Two of the four workspace runs ran under deliberate CPU oversubscription (24 and 48 spinner
  processes against 10 cores, on top of the seven concurrent vitest instances `pnpm -r test` already
  starts). `Timeout calling "onTaskUpdate"` occurred **0 times**, and `Test timed out` at any budget
  occurred **0 times**. T43's `testTimeout: 30_000` remains the only such declaration in the
  workspace.

**Build race.** `apps/cli/vitest.config.ts` registers `./test/globalSetup.ts`, which builds
`dist/cli.js` once per vitest run before any suite starts. The previously observed
`INVALID_ARGUMENTS` build race did not recur: 0 failures of any kind in all six complete executions.

---

## 6. Obligation 6 — test integrity by SHA-256, and the count reconciliation

**Integrity.** 51 test files (`*.test.ts`, `*.test.tsx`, `*.test.mjs`, `*_test.go` under `apps/` and
`packages/`, excluding `node_modules` and `dist`) plus 6 configuration files (`apps/cli/vitest.config.ts`,
`apps/cli/test/globalSetup.ts`, `apps/cli/package.json`, root `package.json`, `pnpm-lock.yaml`,
`packages/protocol/src/types/signalPreKeyBundleV2.ts`) were SHA-256 hashed before the first command
and re-verified after the last: **57 OK / 0 FAILED**, file set identical (0-line diff). mtime was not
used anywhere. Nothing in the repository was modified by this verification.

**The five T47 RED files are byte-identical to the hashes T47 itself recorded**, so T48 implemented
against them without editing them:

| File | SHA-256 vs `001-T47-tests-result.json` |
|---|---|
| `apps/cli/src/runtime/inbound.pollProgress.test.ts` | MATCH |
| `apps/relay/internal/validation/mailbox_envelope_shape_test.go` | MATCH |
| `apps/relay/internal/api/handler/mailbox_envelope_shape_test.go` | MATCH |
| `apps/relay/internal/api/handler/identifier_bounds_test.go` | MATCH |
| `apps/relay/internal/storage/repository/mailbox_retention_cap_test.go` | MATCH |

**No weakening, skipping or deletion.** A routed search for `.skip(`, `.only(`, `.todo(`, `xit(`,
`xdescribe(`, `t.Skip(` and `t.Skipf(` across the test files under `apps/` and `packages/` returns
**0 matches**. The verbose Go run reports **0 SKIP** of any kind.

### Reconciliation: 137 (T42 pass) → 139 (now), +2. Every unit accounted for.

The entire difference is in `apps/cli` (92 → 94). The other six packages are unchanged at 45
(protocol 8, client-db 1, crypto-core 4, client-core 2, session-node 24, mobile 6).

| `apps/cli` test file | T42 | T49 | Δ |
|---|---:|---:|---:|
| `src/runtime/config.test.ts` | 3 | 3 | — |
| `src/transport/relayClient.test.ts` | 3 | 3 | — |
| `src/transport/relayClient.pollCapacity.test.ts` | 4 | 4 | — |
| `src/transport/relayClient.prekeyUnavailable.test.ts` | 3 | 3 | — |
| `src/transport/relayClient.claimable.test.ts` | 3 | 3 | — |
| `src/runtime/profile.test.ts` | 6 | 6 | — |
| `src/runtime/outbound.test.ts` | 6 | 6 | — |
| `src/runtime/outbound.publish.test.ts` | 3 | 3 | — |
| `src/runtime/outbound.concurrentSend.test.ts` | 1 | 1 | — |
| `src/runtime/inbound.test.ts` | 11 | 11 | — |
| `src/runtime/inbound.pollBatchSize.test.ts` | 1 | 1 | — |
| `src/runtime/inbound.batchIsolation.test.ts` | 10 | 10 | — |
| **`src/runtime/inbound.pollProgress.test.ts`** | — | **2** | **+2** (new, T47) |
| `src/commands/cli.test.ts` | 6 | 6 | — |
| `src/commands/cli.processFailures.test.ts` | 8 | 8 | — |
| `src/commands/cli.dashOptionValues.test.ts` | 18 | 18 | — |
| `src/commands/cli.relayErrorCodes.test.ts` | 2 | 2 | — |
| `test/e2e/two-process.test.ts` | 3 | 3 | — |
| `test/e2e/publication-claimability.test.ts` | 1 | 1 | — |
| **`apps/cli` total** | **92** | **94** | **+2** |

**Test-file count 46 → 51 (+5), while the vitest count rose only +2, because four of the five new
files are Go.** They contribute exactly the +5 the tagged race suite grew by (39 → 44 top-level):

| New Go test file | Top-level tests |
|---|---:|
| `apps/relay/internal/validation/mailbox_envelope_shape_test.go` | 1 (`TestValidateMailboxEnvelopeAgreesWithTheClientWireSchema`) |
| `apps/relay/internal/api/handler/mailbox_envelope_shape_test.go` | 1 (`TestPollNeverReturnsAnEnvelopeTheClientSchemaRefuses`) |
| `apps/relay/internal/api/handler/identifier_bounds_test.go` | 2 (device-record and ack oversized-identifier) |
| `apps/relay/internal/storage/repository/mailbox_retention_cap_test.go` | 1 (`TestSetRetentionCapBoundsPhysicalRetention`) |
| **total** | **5** |

Every one of the +2 vitest tests and +5 Go tests is an addition. **No pre-existing file lost a case,
was renamed away, weakened, skipped or deleted.**

---

## Required measurements

| Metric | Threshold | Measured | Evidence source |
|---|---|---|---|
| Clean end-to-end runs | 3/3 pass | **3/3 in all six complete executions (18/18 iterations)**, idle and under 24/48-worker load | `pnpm test` ×3, `keryx test run --strict`, `pnpm --filter @echolet/cli test`, `test:e2e` — all unfiltered. |
| Concurrent claim winners | exactly 1 of at least 20 | **1 of 20**, PASS under `-race -count=1 -tags=relayv2` | `TestSignalPreKeyBundleV2ConcurrentClaimsAllocateExactlyOnce`; `const claimants = 20` (`prekey_bundle_v2_test.go:138`). |
| Lost-response claim retries | same bundle bytes for same claim ID | PASS | `TestSignalPreKeyBundleV2ClaimReplayIsExactAndSelectorBound`, tagged race suite, uncached. |
| Reused OTK publications | 100% rejected across changed IDs, expiry, restart | PASS | `TestSignalPreKeyBundleV2OneTimePreKeyReservationsArePermanent`, `TestSignalPreKeyBundleV2PublishIsImmutableAndIdempotent`. |
| Offline delivery | 1/1 delivered after receiver start | PASS in every E2E iteration (18/18) | `two-process.test.ts` — Bob has no running process during the send; after `poll`, history length 1. |
| Sender restart exact retry | ciphertext bytes identical | PASS | `two-process.test.ts` — two `/v1/messages/send` bodies byte-identical, single `/v2/prekeys/claim`; plus `outbound.publish.test.ts`. |
| Receiver duplicate history entries | 0 | **0** | `two-process.test.ts`; `inbound.test.ts` restart/ack-recovery case; `inbound.batchIsolation.test.ts`; and the binary probes (history 0→1, never more). |
| Known plaintext marker in relay DB/logs | 0 occurrences | **0 occurrences** | `two-process.test.ts` markers asserted absent from proxied traffic, relay log and a recursive byte scan of the relay data directory; every T49 probe repeats an independent leak guard over the relay log and both store keys. Occurrence count only; no content reproduced. |
| Invalid contract cases rejected | 100% fixture corpus | **4/4 shared invalid cases**, both languages | `packages/protocol/src/types/fixtures/relay-v2.json` `invalid_publish_requests` length 4, driving Go `TestSignalPreKeyBundleV2SharedFixtures` and the TS fixture tests. |
| Required Markdown versions and links | 100% | PASS | `keryx wiki check-links`: 19 pages, 38 internal links, 0 broken. |

All ten meet their thresholds, and every required check passes on this one revision, so the gate is
satisfied on its own terms. **The gate does not measure the wedge**, which is why §2 is reported
separately rather than folded into this table.

---

## Findings

### T49-F-001 — the mailbox wedge is bounded, and the bound costs 49 unauthenticated POSTs (HIGH)

See §2. Reproduced against the real relay binary and the real CLI at default configuration; verified
permanent across three retries. Suggested direction (for a later task, not applied here): the walk
bound is the wrong lever on its own — a client-side page limit cannot outrun a mailbox an
unauthenticated party can fill. Candidates are relay-side accounting for envelopes that repeatedly
fail acknowledgement, authentication or proof-of-work on `/v1/messages/send`, or per-sender mailbox
quotas. The choice is an architecture decision, not a verification one.

### T49-F-002 — no test exercises `GetEnvelopeBatchFrom` with a non-empty cursor (MINOR)

See §4. The cursor-aware selection path that serves every production poll has no repository-level
test; both F-005 (c) regressions call the no-cursor delegation. The "expiry is skipped before the
cursor is consumed" property is currently protected only by a source comment.

### T49-I-001 — the poll signature does not cover `cursor` (INFO)

See §3. Bounded blast radius; recorded for the orchestrator, not proposed as a gate failure.

### T42-I-001 carried forward (INFO)

A malformed relay response still surfaces as the generic `PROTOCOL_REJECTED` rather than a distinct
malformed-response code. Unchanged by this round; not re-probed.

---

## Comparison against the T42 pass

| Item | T42 attempt 3 | T49 | Change |
|---|---|---|---|
| `frozen_install`, `cli_build`, `workspace_typecheck` | PASS | PASS | unchanged |
| `cli_process` (+ dash options) | 6 + 18 | 6 + 18 | unchanged |
| `workspace_tests` | PASS ×6, 137 | PASS ×4, **139** | +2 tests; still 0 red, incl. 24/48-worker load |
| `cli_suite_unfiltered` | 18 files / 92 | **19 files / 94** | +1 file (T47 RED) |
| `e2e_3_iterations` | 3/3 in all 8 executions | 3/3 in all 6 executions | unchanged verdict |
| `go_untagged` / `go_untagged_race` | PASS / PASS | PASS / PASS | unchanged |
| `relayv2_race` | 39 tests, 0 skip, 0 race | **44 tests**, 0 skip, 0 race | +5 (T47 RED, now green) |
| `metaproject_test_strict` | PASS | PASS | unchanged |
| `health_strict` | WARN, 94, 7 P2 | WARN, 94, 7 P2, 0 P0/P1 | unchanged; advisory |
| `graph_rebuild` | 83 / 126 | **84 / 130** | one new source-adjacent test file and its edges |
| `graph_cycles` / `wiki_links` | none / 19-38-0 | none / 19-38-0 | unchanged |
| Shape-invalid envelope at ingress | **accepted, HTTP 200** | **refused, 400 `INVALID_SCHEMA`** | T48 path A |
| `next_cursor` | constant `"more"` | **server-computed position, honoured by the relay** | T48 path B |
| Poison at the head of a mailbox | **wedged the mailbox with 1 envelope** | wedges it with **49** (max-size) or **800** (min-size) | bounded, not eliminated |
| `/v1/device-records/publish`, `/v1/mailbox/ack` oversized ids | HTTP 500 | **400 `INVALID_SCHEMA`** | T48 R2-002 |

---

## Limitations

This gate establishes local technical-prototype behaviour on one macOS arm64 machine and nothing
more. It does not establish production security, safe use for sensitive communication, mobile
delivery, public deployment readiness, completion of an independent cryptographic audit, user demand,
or permanent suitability of the pinned libsignal dependency.

Specific honesty notes:

- Four green workspace executions, two of them loaded, are a finite sample on one 10-core machine.
  Load reached 4.8× oversubscription, deliberately below the ~30× at which T43 recorded T43-N-001, so
  this run says nothing about behaviour at that extreme.
- Packages other than `apps/cli` still run on vitest's 5 000 ms default. None was observed near it,
  but they carry no explicit headroom.
- The threshold in §2 was measured on this machine with this relay build. The *numbers* (50 and 3
  envelopes per page, 800 and 49 envelopes to wedge) follow arithmetically from the default
  `poll_batch_size`, `ECHOLET_MAX_MESSAGE_BYTES`, the 1 MiB response budget and the 16-page client
  bound, so they should hold anywhere those defaults hold — but only the two boundaries actually
  probed (799/800 and 48/49) were executed, not every count in between.
- The rate limit was raised in the probes so it would not confound the envelope-count measurement.
  The default 120/minute is reported as part of attacker cost and does not change the threshold.
- The F-005 (c) probe waits for the injected envelopes to pass their declared expiry, at which point
  badger's own TTL has also elapsed. The probe therefore shows "expired records consume neither
  bound", without attributing that to the repository skip versus the store's TTL. The attribution
  rests on the source order (`mailbox_repo.go:249-265`) and on the two Go regressions, which seed
  records directly.
- `keryx test run --strict` reports an aggregate count of 2 for a workspace that runs 139 tests; the
  independent workspace runs are the authoritative count.
- The strict health adapter still cannot execute ESLint (no runnable lint scripts) and does not
  associate the independently passing TypeScript and test commands with its required sources. Its
  score is advisory and its `regression 3 vs baseline` reason reflects its own moving baseline. It
  reports 0 P0 and 0 P1.
- `go -C apps/relay test ./...` reported one package as `(cached)`. The uncached evidence is the two
  `-count=1 -race` runs.
- The structural limitation T44 identified — one published bundle serves exactly one first-contact
  sender — is unchanged and was not re-probed here.
- The revision identifier is the working tree; `main` is unborn and no commit was created, so this
  result cannot be pinned to a hash.

---

## Evidence

Project-relative paths. Probe and helper scripts live in the session scratchpad and are listed for
reproducibility, not as project artifacts; nothing was written into the repository by this run.

- Environment capture: `.metaproject/data/gdctx/raw/2026-09-06T20-41-58-996Z_run.log`
- Test/config hash baseline (57 entries): `.metaproject/data/gdctx/raw/2026-09-06T20-42-09-173Z_run.log`
- Frozen install: `…T20-42-19-506Z_run.log`
- CLI build: `…T20-42-25-349Z_run.log`
- Workspace typecheck: `…T20-42-35-087Z_run.log`
- CLI process contract + dash options (24 tests): `…T20-42-52-529Z_run.log`
- Go untagged: `…T20-43-05-443Z_run.log`
- Go untagged race (uncached): `…T20-43-15-985Z_run.log`
- Relay-v2 tagged race (uncached): `…T20-43-26-492Z_run.log`
- Relay-v2 verbose count (44 / 44 / 0 / 0 / 0): `…T20-43-41-211Z_run.log`, `…T20-43-51-109Z_run.log`
- T47 RED-file hash verification (5 MATCH): `…T20-46-03-461Z_run.log`
- Workspace run 1 (idle, green): `…T20-45-08-609Z_run.log`, summary `…T20-45-26-289Z_run.log`
- Workspace run 2 (24-worker load, green): `…T20-50-27-930Z_run.log`
- Workspace run 3 (48-worker load, green): `…T20-53-11-770Z_run.log`
- `keryx test run --strict` (PASS): `.metaproject/data/testing/artifacts/latest.md`; raw
  `.metaproject/data/testing/logs/latest.raw.log`; summary `…T20-54-20-174Z_run.log`
- CLI suite unfiltered, per-file counts: `…T20-47-11-623Z_run.log`, `…T20-47-24-392Z_run.log`
- Dedicated E2E 3/3: `…T20-48-32-636Z_run.log`
- Strict health (WARN, 94, 0 P0/P1): `.metaproject/data/health/artifacts/latest.md`; severity
  breakdown `…T20-54-41-299Z_run.log`
- Shape-parity binary probe (15 PASS / 0 FAIL): `…T21-01-18-744Z_run.log`
- Page-walk probe, 60 small poison (wedge closed): `…T21-01-31-234Z_run.log`
- Page-walk probe, 800 small poison (**wedge reachable**): `…T21-01-49-406Z_run.log`
- Page-walk probe, 799 small poison (boundary, delivered): `…T21-02-18-866Z_run.log`
- Page-size measurement, 10 max-size poison: `…T21-02-32-159Z_run.log`
- Page-walk probe, 48 max-size poison (boundary, delivered): `…T21-02-46-803Z_run.log`
- Page-walk probe, **49 max-size poison (permanent wedge, 3 retries)**: `…T21-03-12-679Z_run.log`
- Cursor-abuse probe (11 tampered tokens): `…T21-03-31-247Z_run.log`
- F-005 (c) probe (`poll_batch_size = 2`): `…T21-04-27-153Z_run.log`
- Integrity re-check (57 OK / 0 FAILED, 0 skip markers): `…T21-04-51-858Z_run.log`
- Named metric tests PASS confirmation: `…T21-05-12-788Z_run.log`
- Graph rebuild (84 / 130), cycles (none), wiki links (19 / 38 / 0): keryx CLI output; artifacts at
  `.metaproject/data/gdgraph/artifacts/summary.md` and `.metaproject/data/gdwiki/link-check/latest.md`

Routing audit: `graph_used: yes` (rebuild + cycles), `wiki_used: yes` (link check; wiki content pages
`not-relevant` to an execution gate), `ctx_used: yes` (every command, search and large read routed
through `keryx ctx run` / `keryx ctx rg` / `keryx ctx read`), `raw_rg_used: no`.
