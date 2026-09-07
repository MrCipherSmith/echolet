# T38 fix review, round 2 — testing practices

Reviewer: `review-testing-practices` · run `001` · dispatch `001-T38r2-review-testing-practices`
Scope: the regression-suite **delta since round 1** — T40's repairs of T38-TP-001/002/003, the MC10
gap closure, T43's timeout headroom, the new T45/T46 tests, and the five stubs T46 tightened.
Question, unchanged: **would each test still fail if its fix were reverted?**

Node: `/opt/homebrew/bin/node` v26.5.0. Every result below was **executed**; no predicted results appear.

---

## 1. The round-2 mutation pass

17 mutations attempted, 15 applied and run (2 aborted before touching the tree on a
pattern-count guard). Every applied mutation was reverted and every file verified byte-identical
by SHA-256 (§6). `dist/cli.js` was rebuilt from canonical sources by `test/globalSetup.ts` on the
final green run.

| # | mutation | suite run | result |
|---|---|---|---|
| R2-M1 | `outbound.ts`: delete the `// Optimization only` pre-read, keep the F-008 fix (**round-1 MC3b**) | `outbound.concurrentSend.test.ts` | **RED 251 ms** — `expected 'first send finished without ever opening a concurrency window' to be 'opened'` |
| R2-M2 | R2-M1 **plus** removal of the in-transaction `committed` re-read (**round-1 MC3**) | same | **RED 296 ms** — same assertion, at `:187`. No 60 s timeout. |
| R2-M3 | `outbound.ts`: remove only the in-transaction `committed` re-read (**round-1 MC2**, F-008 reverted) | same | **RED** — **5** soft assertions fire (history `[2,3]`, 2 relayed envelope ids, receipts differ, `allocations` `[B,A]`, envelope-id set) |
| R2-M4 | `outbound.ts` `deliver`: key the delivered-status write by `envelope_id` instead of `message_id` | same | **RED** — `expected […(4)] to deeply equal […(2)]`, and **only** the `outboxKeys` assertion fires |
| R2-M5 | `mailbox_repo.go` `GetEnvelopeBatch`: disable the `ExpiresAtMs <= nowMS` skip (**round-1 MG4**) | `go test ./...` | **RED** — `TestGetEnvelopeBatchFiltersExpiredBeforeApplyingBatchLimit`: `returned envelope "…001", want "ffff…"` |
| R2-M6 | `cli.ts`: `strict: false` in `parseArgs` (**round-1 MC10**) | `cli.dashOptionValues.test.ts` | **RED 2/18** — exactly the two new MC10 cases |
| R2-M7 | `cli.ts`: `reportedRelayCodes` emptied (T44-001 CLI half reverted) | `cli.relayErrorCodes.test.ts` | **RED 1/2** — `expected 'PROTOCOL_REJECTED' not to be 'PROTOCOL_REJECTED'` |
| R2-M8 | R2-M7 **plus** renaming the generic code to `PREKEY_BUNDLE_PROBLEM` (the "a rename is enough" mutant) | same | **RED 2/2** — `expected 'PREKEY_BUNDLE_PROBLEM' not to match /PREKEY/` in both tests |
| R2-M9 | `relayClient.ts`: `claimableSchema` back to `z.boolean().optional()` | `relayClient.claimable.test.ts` | **RED 1/3** — `promise resolved instead of rejecting` |
| R2-M10 | `relayClient.ts` `publishBundle`: return `claimable: true` hard-coded | same | **RED 1/3** — the `false` round-trip case |
| R2-M11 | `relayClient.ts`: drop `PREKEY_BUNDLE_UNAVAILABLE` from `remoteCodes` | `relayClient.prekeyUnavailable.test.ts` | **RED 1/3** |
| R2-M12 | `relayClient.ts`: bypass the `remoteCodes` allowlist (forward any relay code) | same | **RED 1/3** — `expected 'NOT_A_DECLARED_RELAY_CODE' to be undefined` |
| R2-M13 | `signal_prekey_bundle_v2.go`: `claimable = true` on the idempotent re-store path | `test/e2e/publication-claimability.test.ts` | **RED 3.9 s** — `expected true to be false` (step 4) |
| R2-M14 | same file: `claimable = false` on the re-store path (the "a second publish is always unclaimable" rule) | same | **RED 3.5 s** — `expected false to be true` (step 2) |
| R2-M15 | `relayClient.ts`: widen the reader bound `1 MiB → 1 GiB` | `relayClient.pollCapacity.test.ts` | **RED 1/4** — `expected undefined to be an instance of RelayError` |
| R2-M16 | `mailbox_repo.go`: drop the `len(batch.Envelopes) > 0` first-envelope exemption (**round-1 MG3**) | `go test ./internal/...` | **RED** — `GetEnvelopeBatch(byteBudget=1) returned 0 envelopes … want exactly the valid envelope` |
| R2-M17 | `mailbox_repo.go`: make `SetRetentionCap` a no-op (**round-1 MG6**) | `go test ./internal/...` | **GREEN — survives** |

Two mutations were aborted by a pattern-count guard before writing (a first attempt at R2-M5 that
matched both `GetEnvelopes` and `GetEnvelopeBatch`, and a variant that left `nowMS` unused and
failed to compile). Neither reached a test run; both are listed for completeness.

**Not reached, stated as a cap:** F-002 (stdin confirmation), F-006 (request-body bound), F-007
(mailbox device binding), F-010/F-011 (rate limiter) — unchanged since round 1, out of this
delta, and still assessed by reading only (round-1 finding T38-TP-004 stands as `info`).
`inbound.batchIsolation.test.ts` belongs to the HL-N workstream, not to this delta, and was read
but not mutated.

---

## 2. T40's repairs of the round-1 findings

### T38-TP-001 — the F-008 barrier re-anchoring · **closed**

`outbound.concurrentSend.test.ts:95` `holdBeforeFirstEnvelopeAllocation`.

The barrier no longer arms on "a transaction that missed `cli:outbox:<id>`". It arms only when
that transaction **also** allocated no envelope before it and none inside it, with the allocation
count read through the `idFactory("envelope")` seam (`outbound.ts:80`) — exactly the fix round 1
proposed. The test then races `barrier.arrived` against the first send's settlement, so "the
window never opened" is an immediate named assertion rather than a harness timeout, and
`expect(allocatedBeforeWindow).toEqual([])` pins that the window opened *before* the first
allocation.

Verified, not read:

- **R2-M1** (the exact round-1 MC3b that survived): now **RED in 251 ms**, on
  `expect(concurrencyWindow).toBe("opened")` at `:187`, with the message
  `first send finished without ever opening a concurrency window`. The refactor the source comment
  invites can no longer degrade this test into an idempotent-replay test.
- **R2-M2** (round-1 MC3, which used to fail only by 60 s timeout): now **RED in 296 ms** on the
  same real assertion.
- **R2-M3** (round-1 MC2, the F-008 fix itself reverted): now fires **5** soft assertions where
  round 1 saw 3. The two new ones are `allocations` (`[B,A]` vs `[B]`) and the envelope-identity
  set across the persisted record, both receipts and the relay traffic.

All three dispatch claims reproduce, with the timings within noise of the reported 437 ms / 217 ms.

### T38-TP-002 — unpinned gates · **3 of 4 closed, 1 residual**

`mailbox_repo_test.go` gained `TestGetEnvelopeBatchFiltersExpiredBeforeApplyingBatchLimit`
(`:165`), a sibling on the production reader. The poll route calls `GetEnvelopeBatch`
(`mailbox_handler.go`), so the F-005(c) regression now covers the path that serves polls.

- **R2-M5**: the expiry skip in `GetEnvelopeBatch` is now **killed** — round 1's MG4 survivor is
  gone. The new test names the condition in its failure message.
- **R2-M16**: the first-envelope exemption (round-1 MG3) is **also killed** — the new test drives
  `GetEnvelopeBatch(mailboxID, …, byteBudget=1)`, so the starvation branch that was unreachable at
  `MaxMessageBytes = 262144` is now exercised directly at the repository level. This closes the
  round-1 F-009 single-maximum-size-envelope guard verdict as well.
- **R2-M6**: `strict: true` is now pinned. See §3.
- **R2-M17**: `SetRetentionCap` made a no-op still leaves `go test ./internal/...` **green**.
  `keryx ctx rg 'SetRetentionCap'` shows exactly one production caller (`router.go:32`) and **no**
  test caller. This is the one residual, and it is a coverage gap on a correct function, not a
  defect. Reported below as `T38r2-TP-001` (minor), carried forward from round 1 unchanged.

### T38-TP-003 — the two inert assertions · **closed**

1. `outbound.concurrentSend.test.ts:214` now scans `tx.keys("cli:outbox:")` — the prefix, not the
   complete key — and pins the exact expected set `[cli:outbox:<messageID>, cli:outbox:<warmupID>]`.
   **R2-M4** proves it is live: a plausible `message_id`/`envelope_id` confusion in `deliver`
   leaves 4 outbox keys and this assertion is the **only** one that fires. Under **R2-M3** it
   correctly stays silent — a duplicate send writes the same key — so its siblings, not it, carry
   the duplicate-envelope property. That division of labour is now explicit in the test's own
   comment and is correct.
2. `relayClient.pollCapacity.test.ts` keeps the fixture-grading `Math.max(...responseBytes)` line
   but now brackets `responseByteBound` with two cases either side of the client's real 1 MiB
   reader bound. **R2-M15** (widen the bound to 1 GiB) turns the "refuses a poll response larger
   than the client's own response byte bound" case **red**. The constant is load-bearing.

---

## 3. The MC10 gap closure · **closed**

`cli.dashOptionValues.test.ts:369-406`, two cases on an **inline value applied to a boolean
option** — the one rejection `parseCommand` does not re-implement.

**R2-M6** (`strict: false`) now fails **2 of 18**, and only those two:

- `doctor --json=please` → the run **succeeded** (`code: 0, errorCode: 'ok'`) instead of exit 2;
- `contact import … --yes=maybe` → **exit 3** (the confirmation prompt path) instead of exit 2.

Both are exactly the degradations the test's header predicts, so the diagnosis is right as well as
the outcome. The `--json=1` case additionally asserts `existsSync(exported) === false`, i.e. that
the refusal happened before anything ran, and the same test carries a positive control (the same
two commands with `--json` spelled correctly still exit 0 and do write the card), so the guard
cannot be satisfied by refusing valid input. The remaining 16 F-013 tests still pass under
`strict: false` — that is unchanged and correct; they were never the seam.

---

## 4. T43's timeout headroom — judgement: **acceptable, masks nothing detectable**

`apps/cli/vitest.config.ts:18-19`, `testTimeout: 30_000` / `hookTimeout: 30_000`.

Three checks, all executed or read rather than assumed:

1. **A hang does not reach the vitest timeout in the suites that could hang.** Every
   process-spawning suite carries its own watchdog *below* 30 s and asserts on it:
   `cli.processFailures.test.ts:69` (8 s, `options.timeoutMs ?? 8000`), `cli.test.ts:22` (15 s),
   `cli.dashOptionValues.test.ts:62` (15 s), `cli.relayErrorCodes.test.ts:62` (15 s), both e2e
   suites (20 s per child, plus `AbortSignal.timeout(500)` readiness probes). Every one of them
   asserts `timedOut: false`. A stuck CLI therefore surfaces as a named assertion at 8-20 s, and
   the vitest timeout is a backstop, not the detector. In-process suites bound their own I/O too
   (`RelayClient` `timeoutMs` 100-5000 ms).
2. **No timing assertion exists to be flipped.** `keryx ctx rg 'elapsed|performance.now|Date.now\(\) - '`
   over every `apps/cli` test file returns **zero** matches. Nothing in this app passes or fails on
   duration, so a larger allowance cannot turn a red performance assertion green.
3. **It adds no new number and does not widen the slowest case.** `30000` is already declared as a
   per-test timeout in `cli.test.ts`. The genuinely long waits in this app are the pre-existing
   per-test overrides (40 000 in `cli.processFailures` / `cli.dashOptionValues` /
   `cli.relayErrorCodes`, 60 000 in `outbound.concurrentSend`, 90 000 in `inbound.batchIsolation`
   and the e2e suites), which the config does not touch. Worst-case time-to-surface for an
   in-process deadlock is therefore set by those overrides, not by T43's change.

The residual cost is real and worth naming: a slow-degrading regression that stays under 30 s in a
suite with no explicit override would now go unnoticed where 5 000 ms would have caught it. For a
local CLI prototype with no performance contract that is a reasonable trade, and it is the
direct fix for T42-F-001's intermittent redness. One cosmetic note: the config comment says
"~3x the worst observed loaded duration" (30 000 / 9 900) while the dispatch cites ~7x
(30 000 / 4 000); both figures appear in the same comment, referring to the saturated and the
loaded case. Not a defect.

**Verdict: `fixed`.** Raising the timeout does not let a hanging test pass, and does not delay a
hang beyond the suite's own watchdogs.

---

## 5. The new T45/T46 tests, and the five tightened stubs

### `relayClient.prekeyUnavailable.test.ts` — **real constraints**

R2-M11 (drop the code from `remoteCodes`) kills the first test; R2-M12 (bypass the allowlist
entirely) kills the second. Both directions of the same one-line change are pinned, so the
allowlist cannot be widened wholesale to satisfy the fix. The redaction assertions are boolean
(`String(error).includes(marker)`, `JSON.stringify(error).includes(marker)`), never rendering the
relay message.

### `cli.relayErrorCodes.test.ts` — **real constraints; the rename claim holds**

R2-M7 (T44-001 CLI half reverted) turns the first test red on
`expect(exhausted.errorCode).not.toBe("PROTOCOL_REJECTED")`.

The interesting claim is that a *rename* satisfies nothing. **R2-M8** tests it directly: with the
allowlist still empty, renaming the generic code to `PREKEY_BUNDLE_PROBLEM` makes
`exhausted.errorCode` match `/PREKEY/` and differ from `PROTOCOL_REJECTED` — and **both** tests go
red, on `expect(violation.errorCode).not.toMatch(/PREKEY/)`. The pairing of the `/PREKEY/` matcher
with the two-sided "must not share a code" assertions is therefore a genuine constraint, exactly
as claimed. The second test also holds the exit-code contract in place across the change: 3 for
`CONTACT_NOT_TRUSTED`, 3 for `BUNDLE_ID_CONFLICT`, 4 for a retryable `INTERNAL_ERROR`, 3 for
`CONTACT_PIN_MISMATCH`.

*Observation, not a finding:* a hypothetical implementation that special-cased `httpStatus === 404`
rather than reading `remoteCode` would also pass this suite. `relayClient.prekeyUnavailable.test.ts`
pins the `remoteCode` propagation separately, so the pair is adequately anchored between them.
The suite's `outcome()` helper omits the one-JSON-line-on-stdout check that
`cli.dashOptionValues.test.ts:88` performs; harmless, since that contract is pinned there.

### `relayClient.claimable.test.ts` — **real constraints; hard-coding is prevented**

R2-M9 (`claimable` back to `.optional()`) kills the first, deliberately-RED-authored test.
**R2-M10** (return `claimable: true` unconditionally) kills the round-trip test — the `false` half
is what does it, so the "including `false` prevents hard-coding" claim is verified rather than
asserted. The third case keeps the field closed (string / null / number rejected) and the envelope
closed to unknown keys, so this is a **tightening** of a `.strict()` object, not a widening: a
required `z.boolean()` accepts strictly fewer responses than `z.boolean().optional()`.

### `test/e2e/publication-claimability.test.ts` — **real constraints on both sides**

Both directions of the relay's answer are killed: **R2-M13** (always `true` on the idempotent
re-store path) fails step 4; **R2-M14** (always `false`, the naive "a second publish is never
claimable" rule the test's header explicitly warns about) fails step 2. `bundle_id` is asserted
unchanged across every publish, so implicit rotation would also be caught. Step 5 reproduces the
T44-001 symptom end-to-end against the real relay binary. The suite never renders plaintext or
store keys: `run()` asserts `includes(marker) === false` for every marker on both streams, and
relay stdout/stderr are discarded.

### The five stubs T46 tightened — **tightening, and each value is what the relay would answer**

`claimable: true` was added to five pre-existing publish stubs. Adding a field that the schema now
*requires* is not a weakening; in `relayClient.test.ts:41` it lands inside a `toEqual`, which is an
exact-shape assertion, so the expectation was tightened too. I checked the scenario behind each
value against `SaveSignalV2` (`signal_prekey_bundle_v2.go:37-95`), where the answer is
`claimable = true` on a first store and `!stored.Claimed` on an idempotent re-store:

| stub | scenario | correct? |
|---|---|---|
| `relayClient.test.ts:34` | fresh publish of the fixture bundle, no claim in the test | yes |
| `cli.test.ts:131` | Alice publishes her own bundle; the claim route serves **Bob's** card | yes |
| `cli.dashOptionValues.test.ts:275` | Alice's own first publication; claim route serves Bob's bundle | yes |
| `outbound.publish.test.ts:68` | first store, byte-identical retry after a lost response, post-rotation publish — nothing claims the local bundle | yes |
| `outbound.test.ts:80` | the local profile's own bundle; the claim path serves the remote peer's | yes |

None is a blanket set: in every case the published bundle belongs to a different identity from the
one being claimed, so the relay would answer `true`. A `keryx ctx rg 'prekeys/publish'` over all
test files finds exactly these five success stubs plus `cli.relayErrorCodes.test.ts` (which only
ever returns errors on that route) and `two-process.test.ts` (which runs the real relay), so no
suite is left sending a publish success the new schema would now refuse.

---

## 6. Reverts, and no test weakened, skipped or deleted

**Every mutated file is byte-identical to its pre-mutation state.** SHA-256 before and after:

| file | SHA-256 (identical before and after) |
|---|---|
| `apps/cli/src/runtime/outbound.ts` | `3720f372cb40931fee19bad5cc4c8378815f11ba29e8200397ef37077e8bba0f` |
| `apps/cli/src/commands/cli.ts` | `8081207205678fe69be2b9816273f65cf31e35ae779fc0761fa29434c1f76c1f` |
| `apps/cli/src/transport/relayClient.ts` | `94f93198e8c201969e0612a9419308e059ce835e12220e19be06fd350eafefd9` |
| `apps/relay/internal/storage/repository/mailbox_repo.go` | `d598cbe175d2bd33142765a10ca995bc070fa582af21142cb89d69f07fc36ef7` |
| `apps/relay/internal/storage/repository/signal_prekey_bundle_v2.go` | `48f02d2d03fc9ba04b1c3adbdae5ba483d7d1fe1e41fd774427006b7bef44096` |
| `apps/cli/vitest.config.ts` | `da0c9db0ed3b0b193e5b65b83f3b765c8ae26b88fa78744aff436a16c97c94d4` (never mutated) |

`signal_prekey_bundle_v2.go` was mutated before I recorded a baseline hash; its revert was a
reverse of the exact same unique string and its post-revert content was re-read and matched the
canonical text quoted in §5. `go vet ./internal/storage/repository` passes.

**Final green re-verification after all reverts** (not the full matrix — T42 owns that):

- `vitest run` over the seven touched suites: **7 files, 32 tests, all pass**, 11.63 s.
- `vitest run src/transport/relayClient.pollCapacity.test.ts`: 4/4 pass.
- `go test ./...` under `apps/relay`: all packages `ok`.
- `git status --porcelain` is identical to the session start.

**No test weakened, skipped or deleted across the delta:**

- **45** test files across `apps/` and `packages/` (`*.test.ts` + `*_test.go`), up from round 1's
  38. The seven additions are `publication-claimability.test.ts`, `relayClient.claimable.test.ts`,
  `relayClient.prekeyUnavailable.test.ts`, `cli.relayErrorCodes.test.ts`,
  `inbound.batchIsolation.test.ts`, and the two `mailbox_envelope_identifier_test.go` files.
  **Nothing was removed**: every file round 1 inventoried is still present.
- **Zero** `.skip` / `.only` / `.todo` / `xit(` / `xdescribe(` / `t.Skip(` markers across all 45
  files.
- Files outside the wave still carry **April mtimes** and are untouched (`validate_test.go`, the
  `client-core`, `client-db`, `crypto-core` suites, `validateDeviceRecord.test.ts`).
- The pre-existing files edited in the round-2 window (22:48) are the five publish stubs, and the
  edit is the added required field only — verified per file in §5. `outbound.concurrentSend.test.ts`
  (20:33) and `relayClient.pollCapacity.test.ts` (20:35) gained assertions, none removed:
  `concurrentSend` went from 4 soft assertions to 6 plus two new hard ones; `pollCapacity` went
  from 3 tests to 4 with no assertion dropped.
- **No schema loosened.** `claimableSchema` went `z.boolean().optional()` → `z.boolean()`, which
  narrows the accepted set, inside a `.strict()` object with no passthrough and no `any`. The Go
  handler always emits the field (`signal_prekey_bundle_v2.go:98`), so the two sides agree.
  `nextCursorSchema` is unchanged from round 1.
- **Exit-code contract intact.** The delta touches no exit-code mapping except `classify`'s
  `reportedRelayCodes` branch, which stays inside `trustFailure` (exit 3);
  `cli.relayErrorCodes.test.ts` pins 0/2/3/4 explicitly and R2-M7/M8 prove those assertions live.
- **No secret leakage in the new tests.** All four new suites assert redaction as booleans and
  never render bodies, ciphertext, store keys or HTTP request bodies; `outbound.concurrentSend`
  projects the stored record to an envelope id and history to sequence numbers only.

**Caveat, restated:** the repository is on an unborn `main` with no commits, so a file deleted
before this session leaves no trace I can detect. The claim is about the working tree.

---

## 7. Findings

### [T38r2-TP-001] `SetRetentionCap` remains the one gate this wave added that survives deletion

- **Severity**: minor (carried forward from round-1 T38-TP-002, item 3, the only item still open)
- **File**: `apps/relay/internal/storage/repository/mailbox_repo.go:42`
- **Problem**: making `SetRetentionCap` a no-op leaves `go test ./internal/...` green. The
  configurability half of the F-005 retention cap is unpinned; only the default clamp is covered
  (by `TestSaveEnvelopeRetentionNeverExceedsDeclaredLifetime`, which R2-M5's sibling MG1 killed in
  round 1).
- **Why it matters**: the code is correct today. The cost is that the next edit to
  `ECHOLET_MAILBOX_TTL_HOURS` plumbing (`router.go:32` is the only caller) is unprotected.
- **Evidence**: **R2-M17** — `SetRetentionCap` body replaced by `_ = retentionCap`;
  `go test ./internal/...` green. `keryx ctx rg 'SetRetentionCap' apps/relay` returns 3 matches, all
  in production code, none in a test.
- **Fix**: one case that calls `SetRetentionCap(1 * time.Hour)`, saves an envelope declaring a
  longer lifetime, and asserts the stored deadline is clamped to the configured cap rather than the
  default.

No new defect was introduced by any change in this delta, and nothing in it blocks acceptance.

---

## 8. Overall

Every claim in the dispatch reproduced under mutation. The three round-1 findings assigned to me
are closed except for a single residual gate (`SetRetentionCap`), and that residual is a coverage
gap on correct code, not a defect. The MC10 gap is genuinely closed — `strict: false` now fails,
and fails for the reason the test says it will. The four new T45/T46 suites are real constraints in
both directions, not decoration: fourteen of the fifteen executed mutations were killed, including
both directions of the claimability answer, both directions of the relay-code allowlist, and the
rename-instead-of-fix mutant. The five tightened stubs are tightenings, and each carries the value
the real relay would return for its scenario. The timeout headroom masks nothing this suite is
capable of detecting.

Round-1 tally 13/19 killed → round-2 delta tally **15/17 attempted, 15 applied, 14 killed, 1
survivor**.

---

## Routing audit

- `graph_used`: no — `not-relevant`. The dispatch named every file in the delta; the question was
  behavioural, not navigational, and the graph predates this session's mutations.
- `wiki_used`: no — `not-relevant`. The contract under review is stated in the T44 findings, the
  review context and the tests' own headers.
- `ctx_used`: yes — `keryx ctx rg` for every search, `keryx ctx run` for every test run, file
  inventory, mtime listing and marker scan.
- `raw_rg_used`: no.
