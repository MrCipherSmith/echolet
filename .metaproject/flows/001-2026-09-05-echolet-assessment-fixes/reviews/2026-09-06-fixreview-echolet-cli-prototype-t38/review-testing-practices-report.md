# T38 fix review — testing practices

Reviewer: `review-testing-practices` · run `001` · dispatch `001-T38-review-testing-practices`
Scope: the regression suite added by T33, T34, T35, T36 and T39.
Question answered: **would each test still fail if its fix were reverted?** — not "does it pass today".

---

## 1. The mutation pass

Every row below was **executed**. Every mutation was reverted and the file verified
byte-identical afterwards (SHA-256 table in §5). No predicted results appear here.

### Relay (Go) — `go test ./...` under `apps/relay`

| # | mutation | suite run | result |
|---|---|---|---|
| MG1 | `mailbox_repo.go` `retentionDeadlineSeconds`: delete the `capDeadline` clamp | `./internal/storage/repository -run TestSaveEnvelopeRetention` | **RED** — `declared lifetime longer than the server cap`: `stored retention deadline = 1791301211, want at most … 1789314011` |
| MG2 | `mailbox_repo.go` `GetEnvelopeBatch`: disable the byte-budget branch (`if false && …`) | `./internal/api/handler -run TestMailboxPoll` | **RED** — `poll 1: response body = 2101798 bytes, want at most 1048576` |
| MG3 | `mailbox_repo.go` `GetEnvelopeBatch`: drop the `len(batch.Envelopes) > 0` first-envelope exemption | `./internal/api/handler ./internal/storage/repository` | **GREEN — survives** |
| MG4 | `mailbox_repo.go` `GetEnvelopeBatch`: remove the `envelope.ExpiresAtMs <= nowMS` skip | `./...` | **GREEN — survives** |
| MG5 | `mailbox_repo.go` `SaveEnvelope`: remove `return model.ErrEnvelopeIDConflict` | `./internal/api/handler ./internal/storage/repository` | **RED** — `status = 200, want 409 ENVELOPE_ID_CONFLICT` |
| MG6 | `mailbox_repo.go`: make `SetRetentionCap` a no-op | `./...` | **GREEN — survives** |

### CLI (vitest) — under `apps/cli`

| # | mutation | suite run | result |
|---|---|---|---|
| MC1 | `profile.ts` `publicationBundle`: always sign a fresh bundle (F-001 reverted) | `outbound.publish.test.ts` | **RED 3/3** — `bundle_id` mismatch in all three tests |
| MC2 | `outbound.ts` `sendOwned`: remove the in-transaction `tx.get(keyFor(messageId))` re-read (F-008 reverted) | `outbound.concurrentSend.test.ts` | **RED** — 3 of 4 soft assertions fire (history `[2,3]`, 2 relayed envelope ids, receipt ids differ) |
| MC3 | MC2 **plus** removal of the `// Optimization only` pre-read | `outbound.concurrentSend.test.ts` | **RED via 60 s timeout** — the barrier never arms; no assertion fires |
| MC3b | remove **only** the `// Optimization only` pre-read, F-008 fix kept | `outbound.concurrentSend.test.ts` | **GREEN — survives** (see finding T38-TP-001) |
| MC5 | `profile.ts` `transact`: rethrow the raw error instead of `PersistenceError` | `cli.processFailures.test.ts -t "PERSISTENCE_FAILURE"` | **RED 3/3** — all three exit-5 tests observe exit 3 |
| MC6 | `profile.ts` `transact`: wrap **every** failure as `PersistenceError` (over-correction) | `cli.processFailures.test.ts -t "exit 3"` | **RED** — exit-3 control observes exit 5 |
| MC7 | `inbound.ts`: delete `if (!contactBytes) throw new InboundError("CONTACT_NOT_TRUSTED")` | `inbound.test.ts` | **RED** — `expected 'INBOUND_REJECTED' to be 'CONTACT_NOT_TRUSTED'` |
| MC8 | MC7 **plus** restoring the pre-T36 generic `rejects.toThrow()` on that test | `inbound.test.ts` | **GREEN 11/11 — mutant survives** (F-012 control reproduced) |
| MC9 | `cli.ts` `parseCommand`: bypass `inlineStringOptionValues` (F-013 reverted) | `cli.dashOptionValues.test.ts` | **RED 10/16** |
| MC10 | `cli.ts`: `strict: false` in `parseArgs` | `cli.dashOptionValues.test.ts` | **GREEN 16/16 — survives** |
| MC11 | `cli.ts` `inlineStringOptionValues`: rewrite boolean options too | `cli.dashOptionValues.test.ts` | **RED 2/16** (`--from … --yes`, and the dash-body delivery test) |
| MC14 | `cli.ts` `parseCommand`: remove the duplicate-option and per-command allow-list loop | `cli.dashOptionValues.test.ts` | **RED 2/16** (repeated-option guard, not-accepted-option guard) |
| MC15 | `cli.ts` `inlineStringOptionValues`: remove the `--` verbatim-copy short circuit | `cli.dashOptionValues.test.ts` | **GREEN 16/16 — survives** |
| MC12 | `relayClient.ts`: `nextCursorSchema` back to `z.null()` | `relayClient.pollCapacity.test.ts` | **RED** — `INVALID_RELAY_RESPONSE` on the drain test |
| MC13 | `inbound.ts` `poll`: send a hardcoded `batch_size: 100` instead of `this.profile.pollBatchSize` | `inbound.pollBatchSize.test.ts` | **RED** — `expected { …(5) } to match object { batch_size: 7 }` |

**Cap stated:** 19 mutations run. Not reached: the F-006 request-body bound, F-007 mailbox
device binding, F-010/F-011 rate-limiter internals, and the F-002 stdin path. Those four sets
are argued below from control flow only, and are marked as such.

---

## 2. The two deterministic hooks

### F-003 — second `node:sqlite` connection holding `BEGIN IMMEDIATE`, `busy_timeout=0`

`cli.processFailures.test.ts:142` `lockProfileDatabase()`.

**Verdict: anchored to the semantic event.** The hook does not reach into the store's
internals; it takes a real second connection on the real profile database and holds a real
write lock. What it forces is exactly the condition `PersistenceError` is defined to name —
"the store itself refuses to begin, commit or read a transaction" (`profile.ts:15-23`) — and
it forces it through the same public path the CLI uses. The three call sites it targets
(post-send delivery commit, inbound poll commit, contact-import commit) are reached through
the compiled `dist/cli.js`, so the exit code observed is the process contract, not an
in-test approximation.

Two robustness properties I checked rather than assumed:

- The hook depends on `EncryptedSqliteStore` opening with `PRAGMA busy_timeout = 0`
  (`EncryptedSqliteStore.ts:25`). If that changed, the child would block rather than fail —
  and `runCli`'s 8 s timeout turns that into `timedOut: true`, which every assertion checks.
  The hook degrades to **loud**, not silent.
- The hook is *not* pinned to any particular internal transaction. MC5 and MC6 confirm both
  directions of the classification are killed by the suite.

The one implementation coupling is the literal `client.sqlite` filename in
`lockProfileDatabase`, which is `database_path` from the profile config. A rename there makes
`new DatabaseSync(...)` create an empty sidecar file, the lock succeeds against nothing, and
the exit-5 tests would go red on the assertion `code: 5` — again loud.

### F-008 — test-only instrumentation on `EncryptedSqliteStore.prototype.transaction`

`outbound.concurrentSend.test.ts:84` `holdFirstMissingOutboxRead()`.

**Verdict: anchored to an implementation detail a future refactor would silently weaken.**
Reported as finding T38-TP-001.

The barrier fires on "the first store transaction that calls `tx.get("cli:outbox:<id>")` and
gets `undefined`". Today that is the transaction at `outbound.ts:45`, which the code itself
labels `// Optimization only: the authoritative read is repeated inside the mutation
transaction.` Deleting a read the source calls an optimization is exactly the refactor a
future maintainer is invited to make — and MC3b shows what happens: the suite stays
**green**, but the barrier now re-anchors to the *mutation* transaction at `outbound.ts:71`
and only releases **after that transaction has committed**. In that state the first sender
has already written its outbox record, its history entry and its envelope before the second
sender starts. The two sends are fully serialised; the test asserts idempotent replay of an
already-committed record, which `outbound.test.ts` covers independently, and asserts nothing
about concurrency.

The safety net is not entirely gone: MC3 (both reads removed) fails, but only by hanging for
the full 60 s timeout, because nothing ever reads the key and `barrier.arrived` never
resolves. A red-by-timeout is a failure, so the defect would not ship silently — but the
failure message points at the harness, not at the duplicate envelope.

Two further couplings, both to strings the test owns a copy of:

- the key literal `` `cli:outbox:${messageID}` `` is duplicated from `outbound.ts:18`;
- `holdFirstMissingOutboxRead` re-implements `StoreTransaction` by hand
  (`get`/`set`/`delete`/`keys`), so adding a fifth method to that interface makes the
  wrapper drop it inside the instrumented window.

Both fail loudly rather than silently, so they are noted, not raised.

**On the `review-highload` two-process result.** If cross-process serialisation genuinely
comes from `BEGIN IMMEDIATE` alone, that does not make this test redundant, because this test
is *in-process*: `EncryptedSqliteStore` serialises its own transactions through `this.tail`
(`EncryptedSqliteStore.ts:46`), and the barrier deliberately releases the SQLite lock (it
holds the JS continuation *after* `COMMIT`) so the second instance can take its own
`BEGIN IMMEDIATE` without hitting `SQLITE_BUSY` at `busy_timeout=0`. What the test proves, in
its current anchoring, is that a second store instance committing between the pre-read and
the mutation transaction cannot produce a second envelope. MC2 confirms that is a real,
killed mutant. What it does **not** prove — and what the highload probe does cover — is the
two-process case. The two results are complementary; neither makes the other redundant.

---

## 3. The deliberately-green guard tests

| guard | verdict | evidence |
|---|---|---|
| **F-009 single-maximum-size-envelope guard** (`mailbox_poll_capacity_test.go:166`) | **Does not constrain.** Structurally unable to fail. | MG3: removing the exemption the test names leaves the whole relay suite green. At `MaxMessageBytes = 262144`, one envelope is ~256 KiB against a ~1020 KiB budget, so the starvation branch the test claims to guard is never entered. The property is in fact pinned by `TestMailboxPollHonoursAggregateResponseByteBudget`, which requires ≥1 envelope per poll while the budget *is* binding. |
| **F-003 exit-3 control** (`cli.processFailures.test.ts:263`) | **Constrains.** | MC6: making `Profile.transact` classify every transactional failure as `PersistenceError` turns the control red (`code: 5`, want `3`). The control is the only test that separates the F-003 fix from a blanket exit-5 widening. |
| **Six F-013 invalid-input guards** (`cli.dashOptionValues.test.ts:303-377`) | **Constrain the exit-2 contract; do not pin `strict: true`.** | MC14 kills two of them (duplicate-option and per-command allow-list). MC10 — `strict: false`, the exact over-correction the file's header says it guards against — leaves all 16 tests green, because `parseCommand`'s own allow-list, duplicate check and `profile` presence check independently produce exit 2 for every input the guards probe. MC15 (removing the `--` short-circuit) also survives, though that branch is unreachable-by-design while no command takes positional operands. |
| **F-005 server-cap subtest** (`mailbox_repo_test.go:61`) | **Constrains.** | MG1: deleting the cap clamp turns it red. Note it is green under the *original* pre-fix code too (flat `WithTTL(7*24h)` lands exactly on the cap) — correct for a guard. It does not cover `SetRetentionCap`: MG6 (no-op) survives the whole suite, so the configurability half of the cap is unpinned. |

---

## 4. F-012 mutation evidence

**Independently reproduced, control included.**

- MC7 (delete `inbound.ts:50`'s `CONTACT_NOT_TRUSTED` guard) → `inbound.test.ts` fails with
  `AssertionError: expected 'INBOUND_REJECTED' to be 'CONTACT_NOT_TRUSTED'` — the exact
  message recorded in `001-T36-tests-result.json`.
- MC8 (same mutation, plus the pre-T36 generic `await expect(receiver.poll()).rejects.toThrow()`
  restored on that one test) → **11/11 green**. The mutant survives the original assertion,
  which is the control T36 claimed and which I confirm.

The `rejectsWith` helper (`inbound.test.ts:121`) is a genuine improvement rather than a
narrower string match: it asserts the rejection is an `InboundError` **and not** a
`PersistenceError`, so a guard that disappears cannot be satisfied by the exit-5 storage
channel. Baseline `inbound.test.ts` is 11 tests where the pre-T36 file had 10; nothing was
removed, and the T28 report's "changed device" and "malformed ciphertext" cases are still
present as two separate tests each pinning their own typed code.

---

## 5. No pre-existing test was weakened, skipped or deleted

Verified independently of the orchestrator's mtime checks and T37's hash run:

- **38 test files** across `apps/` and `packages/` (`find … -name '*.test.ts' -o -name
  '*_test.go'`), matching T37's count.
- **Zero** `.skip` / `.only` / `.todo` / `t.Skip(` / `xit(` / `xdescribe(` markers anywhere
  in those files.
- Every test file outside the fix wave carries an **April mtime** and is untouched:
  `validate_test.go`, the four `packages/client-core`, `client-db`, `crypto-core` suites and
  `validateDeviceRecord.test.ts`.
- Three *pre-existing* files were modified in the wave window: `cli.test.ts` and
  `two-process.test.ts` (17:51) and `inbound.test.ts` (17:51). I read all three. The first
  two replaced a `beforeAll` that ran `pnpm run build` with
  `expect(existsSync(entry)).toBe(true)`, moving the build into `test/globalSetup.ts` — an
  assertion *added*, none removed. `inbound.test.ts` gained the `rejectsWith` helper and
  split one combined test into two; both retain `expect(fake.acks()).toEqual([])` and
  `expect(await snapshot(bob)).toEqual(before)`.
- No relaxed schema: `nextCursorSchema` (`relayClient.ts:24`) is
  `z.union([z.string().min(1).max(256), z.null()])` — a closed union on a `.strict()` object,
  no `.optional()`, no passthrough, no `any`. MC12 proves it is load-bearing.

**Caveat, stated honestly:** the repository is on an unborn `main` with no commits, so a test
file *deleted* before this session leaves no trace I can detect. The claim above is that
nothing in the working tree is weakened or skipped, and that every file the T28 report cited
still exists with its assertions intact.

---

## 6. Findings

### [T38-TP-001] The F-008 concurrency barrier is anchored to a read the source calls an optimization

- **Severity**: minor
- **File**: `apps/cli/src/runtime/outbound.concurrentSend.test.ts:84`
- **Problem**: `holdFirstMissingOutboxRead` fires on the first `tx.get("cli:outbox:<id>")` that
  misses. Today that is the pre-read at `outbound.ts:45`, annotated `// Optimization only`.
  Delete that pre-read — a legitimate refactor the comment invites — and the barrier
  re-anchors to the mutation transaction at `outbound.ts:71`, releasing only *after* it
  commits. The two sends are then fully serialised and the test exercises no concurrency at
  all, while staying green.
- **Why it matters**: the wave's headline blocker fix keeps a test that would, after a benign
  refactor, assert idempotent replay rather than concurrent-send exclusion. MC3 shows the
  subsequent regression then surfaces only as a 60 s timeout, not as a duplicate-envelope
  assertion.
- **Evidence**: MC3b (pre-read removed, fix kept) → **green**. MC3 (pre-read *and* fix
  removed) → **red by 60 s timeout, no assertion fires**. MC2 (fix removed only) → red with
  3 of 4 soft assertions.
- **Fix**: arm the barrier on the semantic event instead of on a storage read. The cleanest
  seam already exists: `Options.idFactory`. Block inside the `idFactory("envelope")` callback
  — that call happens once per *new envelope allocation* inside the mutation transaction and
  is by definition the event the finding is about. Alternatively assert positively that the
  window was concurrent (e.g. that `first`'s send had not yet resolved when `second.send`
  returned), so a degenerate serialisation cannot pass.

### [T38-TP-002] Four gates this wave added survive deletion with the suite green

- **Severity**: minor
- **File**: `apps/relay/internal/storage/repository/mailbox_repo.go:183`
- **Problem**: four gates added or relied on by the fixes are unpinned. The most consequential
  is the expiry filter in `GetEnvelopeBatch`: `TestGetEnvelopesFiltersExpiredBeforeApplyingBatchLimit`
  pins the filter in `GetEnvelopes`, but `keryx ctx rg 'GetEnvelopes\(|GetEnvelopeBatch\('`
  over `apps/relay` shows `GetEnvelopes` has **no production caller** — the poll route calls
  `GetEnvelopeBatch` (`mailbox_handler.go:252`). The F-005(c) regression therefore covers a
  method nothing serves polls from.
- **Why it matters**: the code is correct today; the cost is that the next edit to the actual
  poll path is unprotected, and the named F-005(c) regression reads to the next author as
  coverage of a path it does not touch.
- **Evidence**: MG4 → `go test ./...` green with the `ExpiresAtMs <= nowMS` skip removed from
  `GetEnvelopeBatch`. MG3 → green with the first-envelope exemption removed (unreachable at
  `MaxMessageBytes = 262144`, where one envelope is ~256 KiB against a ~1020 KiB budget).
  MG6 → green with `SetRetentionCap` made a no-op. MC10 → `cli.dashOptionValues.test.ts`
  16/16 green with `parseArgs` `strict: false`.
- **Fix**: (1) point `TestGetEnvelopesFiltersExpiredBeforeApplyingBatchLimit` at
  `GetEnvelopeBatch` (or add a sibling), since that is the production reader; (2) drive the
  single-large-envelope guard through a repository-level call with a `byteBudget` smaller
  than one envelope, so the exemption is actually exercised; (3) add one
  `SetRetentionCap(1 * time.Hour)` case; (4) either drop the claim that the F-013 guards pin
  `strict: true` or add a case where non-strict parsing observably differs.
- **class_scope**: `mailbox_repo.go:183` (expiry skip in `GetEnvelopeBatch`),
  `mailbox_repo.go:190` (first-envelope exemption), `mailbox_repo.go:42` (`SetRetentionCap`),
  `cli.ts:107` (`strict: true`), plus `cli.ts:93` (the `--` short circuit, MC15, currently
  unreachable-by-design and listed for completeness). Enumerated by mutating every gate the
  fix wave added or relied on in the four files under review, one at a time — 19 mutations,
  all listed in §1.

### [T38-TP-003] Two assertions cannot fail: one is structurally constant, one grades the test's own mock

- **Severity**: minor
- **File**: `apps/cli/src/runtime/outbound.concurrentSend.test.ts:181`
- **Problem**:
  1. `expect.soft(persisted.outboxKeys).toHaveLength(1)` calls `tx.keys()` with a prefix that
     is the *complete* key `cli:outbox:<messageID>`. The result can only ever be 0 or 1, so
     the assertion cannot detect the duplicate-envelope defect it sits beside.
  2. `relayClient.pollCapacity.test.ts:123`
     `expect(Math.max(...responseBytes)).toBeLessThanOrEqual(responseByteBound)` — every entry
     in `responseBytes` is pushed by the test's own mock `fetch`, from a payload the same mock
     builds under a budget it applies itself. No production code contributes to the value, so
     the assertion grades the fixture. (The rest of that test *is* load-bearing: MC12 kills it
     through the `next_cursor` schema.)
- **Why it matters**: both read as coverage of the byte/duplicate property they name, and
  neither provides it. The real server-side budget is covered in Go by MG2.
- **Evidence**: MC2 — with the F-008 fix reverted, three of the four soft assertions fired and
  `outboxKeys` did not, empirically confirming it is inert. For (2), inspection of the mock at
  `relayClient.pollCapacity.test.ts:75-100` shows `responseBytes` has no production input.
- **Fix**: (1) assert on `tx.keys("cli:outbox:")` (the prefix, not the key), or drop the
  assertion — the history and relayed-envelope-id assertions already carry the property.
  (2) Rephrase as an assertion that the *client* refused nothing, or delete it and rely on the
  Go test for the budget.

### [T38-TP-004] Four fix areas were not reached by the mutation pass

- **Severity**: info
- **File**: `apps/relay/internal/api/handler/request_body_limit_test.go:43`
- **Problem**: F-006 (request-body bound and ciphertext-size validation), F-007 (mailbox device
  binding), F-010/F-011 (rate limiter) and F-002 (stdin confirmation) were reviewed by reading
  only. All four read as well anchored — `request_body_limit_test.go` measures bytes actually
  consumed through a `countingBodyReader` rather than trusting a status code;
  `rate_limit_test.go` uses channel synchronisation and an injected clock with no
  `time.Sleep`; `mailbox_device_authorization_test.go` asserts its own precondition (shared
  device UUID, different identities) and orders the two identities deterministically so the
  denial is reproducible rather than lexicographically lucky. But I did not execute a mutation
  against any of them.
- **Why it matters**: a stated cap is a result; silence would read as a clean sweep.
- **Evidence**: §1 mutation table lists 19 executed mutations; none touches
  `validate.go`, `request_body.go`, `device_record_repo.go`, `rate_limit.go` or
  `readConfirmation`.
- **Fix**: none required for this prototype; a later round can extend the pass if the budget
  allows.

---

## 7. Overall

The suite is, on the whole, a real regression suite: 13 of 19 mutations were killed, including
every one that reverts a shipped fix (MC1, MC2, MC5, MC9, MC12, MC13, MG1, MG2, MG5) and both
over-correction directions that were tested (MC6, MC11, MC14). The F-012 mutation evidence
holds up, control included. No pre-existing test was weakened, skipped or deleted, and no
schema was loosened to make a fix pass.

The four survivors are coverage gaps, not defects — every gate I deleted is correct in the
tree as it stands. The one worth acting on before this wave is called done is T38-TP-001,
because the wave's headline blocker fix is protected by a hook that a plainly-invited refactor
turns into a test of something else.

---

## Routing audit

- `graph_used`: no — `not-relevant`. The dispatch named all 16 files; navigation was not the
  question, and the graph predates this session's mutations anyway.
- `wiki_used`: no — `not-relevant`. The behavioural contract under review is stated in the
  T28 findings, the review context and the tests themselves.
- `ctx_used`: yes — `keryx ctx rg` for every code search, `keryx ctx read` for
  `relayClient.ts` and the two contract schemas, `keryx ctx run` for the test-file inventory
  and the marker scan.
- `raw_rg_used`: no.
