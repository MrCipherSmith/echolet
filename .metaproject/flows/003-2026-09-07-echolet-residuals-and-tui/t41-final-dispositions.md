# T41 — Post-wave disposition of every residual inventory item

Flow 003, task T41. macOS arm64.

**The tree moved twice under this pass, and I record it rather than absorb it.** Every row
below was established on `4fdb658` — one commit past the `ac51393` round 3 verified — when
seven tracked files were modified and three untracked. Between the last row and this sentence
a concurrent session committed **`b3b37a8`** (*docs: correct the five places a third
verification caught contradicting the tree*), which is now HEAD. It touches five files:
`runbook.md`, `README.md`, `apps/cli/test/e2e/prekey-pool-replenishment.test.ts`, `PAUSED.md`
and `t25-verification-report-r2.md`. **None of them is load-bearing for any verdict here**, and
`b3b37a8` touches `docs/STATUS_CURRENT.md` not at all, so §5's finding survives it — re-checked
after the commit landed. What `b3b37a8` does change is §5's and §7's status report: the three
round-3 AC2 answers that were uncommitted while I worked are now committed. **Every row is
therefore true of `4fdb658` and, except where §5 and §7 say otherwise, of `b3b37a8`.**

**What this pass did.** It re-established each of the inventory's items against *this* tree
by reading the file at the line, by running a command, or by proving the file byte-identical
to `4346e2b` — the tree T1 verified against — with `git diff --name-only 4346e2b..HEAD -- <path>`.
Where a row's closure rests only on a document, the document was checked against the tree or
the row is left OPEN. No report's prose was accepted as evidence for its own claim. No source
file and no test was changed.

**What this pass did not do.** It ran no test suite: not `pnpm -r test`, not `go test ./...`,
not `test:e2e`. Round 3's twenty mutation outcomes are *carried from it, not reproduced here*,
and every row that leans on one says so. It connected to no host. It recorded no key, no
plaintext and no request body.

---

## 0. Two corrections to the inventory's own arithmetic, before the table

**The inventory holds 72 items, not 62.** `t1-residual-inventory.md:38` states "62 items"
and gives bucket counts summing to 62 (`FIX NOW 21 · FIX WITH CARE 15 · RECORD PERMANENTLY 14 ·
STALE 12`); its closing note at `:115-119` says "ten numbers unused". Counted mechanically,
the document contains **95 table rows carrying 72 distinct ids, `RI-01` through `RI-72` with
none missing** (23 ids recur in the §2.3, §2.4 and §3 sub-tables). The real bucket
distribution is `FIX NOW 26 · FIX WITH CARE 15 · RECORD PERMANENTLY 18 · STALE 13`. The
dispatch for this task, and round 3's finding R3-001, both inherited the "62" from T1's
summary line. **This table dispositions all 72.**

**The wave never tracked the inventory by id.** `keryx ctx rg 'RI-0[1-9]|RI-[1-7][0-9]'` over
`tasks.md` returns **zero matches**. That is the mechanical reason AC1 failed twice: the wave
fixed real things, but nothing connected a fix to the item it closed, so a reached item and an
unreached one look identical from outside. Ten items below are closed by work the wave did
without ever naming them.

---

## 1. Verdict vocabulary

| verdict | means |
|---|---|
| **FIXED** | the wave changed the tree; the row names a commit *and* something checkable — a file:line, a test name, a mutation, or a command and what it printed |
| **FIXED-IN-PART** | part of the item is closed; the row names the residue, which is open |
| **STALE** | the item was already not true of this tree; where a document still asserted it, the row evidences the deletion |
| **OPEN (recorded)** | re-verified open here, and the reason it is not being fixed is already recorded in the tree or in a shipped document; the row names where |
| **OPEN (unrecorded)** | re-verified open here, and **nothing in the wave records a reason**. This row is the record |
| **OPEN (unverifiable here)** | cannot be settled either way from this machine; the row names what is missing |

**Counts: FIXED 10 · FIXED-IN-PART 5 · STALE 12 · OPEN (by design, recorded) 13 ·
OPEN (recorded) 12 · OPEN (unrecorded) 18 · OPEN (unverifiable here) 2. Total 72.**

**Forty-five of the seventy-two carry an OPEN verdict outright, and five more are FIXED-IN-PART
with an open residue — fifty items with work still attached to them.** That is the honest number.
Verified mechanically: the table below holds 72 rows, 72 distinct ids, no gap in RI-01…RI-72 and
no id twice.

---

## 2. The table

`Δ4346e2b` in an evidence cell means: `git diff --name-only 4346e2b..HEAD -- <path>` is empty,
so the file is byte-identical to the tree T1 read it on, and T1's file:line citation still
resolves to the same text. That is the strongest evidence available for an item nobody touched.

| id | claim, in one line | verdict | evidence |
|---|---|---|---|
| RI-01 | `ECHOLET_MAX_STORAGE_BYTES` declared, enforced nowhere; no per-mailbox occupancy cap | **OPEN (recorded)** | `keryx ctx rg MaxStorageBytes apps/relay` → **one** match, `internal/config/config.go:39`, a declaration with no reader. Six operator-facing sites still present it as a bound (both compose files, `run-relay.sh`, three env examples). Recorded open at `README.md:34`, `STATUS_CURRENT.md:113`, `runbook.md:271`, `deployment-runbook.md:1111`. Not fixed: needs a new refusal code on the send route (FIX WITH CARE) |
| RI-02 | Identity creation is free: `POST /v1/device-records/publish` is unauthenticated | **OPEN (recorded)** | `Δ4346e2b` on `internal/api/handler/device_record_handler.go`. `validate.go:120-124` now states it as a live premise: "costs an attacker only one unauthenticated `/v1/device-records/publish` (finding T52-F-001)". Recorded at `STATUS_CURRENT.md:107,168` |
| RI-03 | First walk of a very large flood (~2.8 GB) takes ~1 h, bounded by the victim's own limit | **OPEN (by design, recorded)** | `STATUS_CURRENT.md:107` states it as a bound and says so in terms: «Это граница, и она заявляется как граница». No code change proposed or made |
| RI-04 | Attacker chooses its position in the victim's drain walk via a nil-prefix `envelope_id` | **STALE** | `Δ4346e2b` on `internal/storage/repository/mailbox_repo.go`; the `mailboxseq:` server-assigned ordering index T1 verified is unchanged. No shipped document asserts the old claim |
| RI-05 | `SenderOccupancy` walks the whole mailbox prefix on every send: O(N²) decodes | **OPEN (unrecorded)** | `Δ4346e2b` on `mailbox_repo.go`. No wave commit touches it, and no shipped document or flow report records a reason for carrying it. **This row is the record: carried as FIX WITH CARE — a counter reintroduces the drift the live scan was chosen to avoid, so it needs a design step the wave did not schedule** |
| RI-06 | An acked envelope's ordering-index entry is not deleted with its primary record | **OPEN (unrecorded)** | `Δ4346e2b` on `mailbox_repo.go`. Carried: closing it needs a new `mailboxpos:` key space that doubles the per-envelope key count — a storage-schema decision, not a bug fix |
| RI-07 | The last page of every walk carries no `next_cursor` to echo as `read_through` | **OPEN (by design, recorded)** | `Δ4346e2b` on both `mailbox_repo.go` and `apps/cli/src/runtime/inbound.ts`. `mailbox_handler.go:110-113` restates the contract ("non-null ⇒ more remain"). The alternative reopens hazard R-4 |
| RI-08 | A pinned contact still occupies 16 quota slots | **OPEN (by design, recorded)** | `const defaultSenderUnackedQuota = 16` at `mailbox_handler.go:309`, with its rationale at `:283-308`. Unchanged by design (T54) |
| RI-09 | Poll byte budget is a compile-time constant unrelated to `ECHOLET_MAX_MESSAGE_BYTES` | **FIXED** | `d6d5f8f` (RED) → `5235a6d`. `mailbox_handler.go:94` is now `const clientPollResponseBound int64 = 4 * protocol.MaxMessageBytes`, and `:104` derives the budget from it; `config.Validate()` refuses to start above the protocol maximum. Round 3's mutations MU-2 (`LIMITS.MAX_MESSAGE_BYTES → 131072`) and MU-2b (`protocol.MaxMessageBytes → 131072`) each kill the mirror test in the *other* language; G2 kills `TestValidateRefusesAMaxMessageBytesTheRelayCannotDeliver`. **Mutations carried from round 3, not re-run here.** Recorded at `STATUS_CURRENT.md:109` |
| RI-10 | `SendEnvelope` passes the raw `h.maxMessageBytes` to `ValidateMailboxEnvelope` | **FIXED** | `0355b30` (RED) → `23a17aa`. `NewMailboxHandler` resolves a non-positive maximum once, at `mailbox_handler.go:58-60`, so `envelopeBodyLimit()` (`:126-128`) and the validation call at `:141` read one always-positive field. The comment at `:36-50` names the defect. Tests: `unconfigured_max_message_bytes_test.go`, `mailbox_poll_byte_budget_derivation_test.go`. Round 3 replayed `0355b30` in a detached worktree and watched four named tests fail — red-first is proven for this pair |
| RI-11 | The contact-import re-walk is not crash-safe / consumed once / truncated at 16 pages | **STALE** | `Δ4346e2b` on `inbound.ts`. The PEEK/`keepMailboxRewalk`/`finishMailboxRewalk` shape T1 verified is unchanged, and `rewalk-crash-safety.test.ts` still pins it |
| RI-12 | The crash-safety suite samples one interruption point and one ciphertext regime | **OPEN (recorded)** | `keryx ctx rg interruptPollAtPage` over `apps/cli/test/e2e/rewalk-crash-safety.test.ts`: the only call site is `:522`, `w.interruptPollAtPage(3, signal)` — still a single page. Recorded by reference at `STATUS_CURRENT.md:114` (T16 §8 R-1…R-6). Accepted coverage bound; the 32-configuration sweep still exists only in a report, not in the repository |
| RI-13 | A poll interrupted mid-re-walk leaves the position advanced, so the next poll shows a cursor | **OPEN (by design, recorded)** | `Δ4346e2b` on `inbound.ts`; the reason still stands in the source at `inbound.ts:143-155`, pinned by flood-closure RED-4b |
| RI-14 | Two concurrent `poll()` invocations against one profile directory are not serialised | **OPEN (by design, recorded)** | `Δ4346e2b` on `inbound.ts`. Recorded at `STATUS_CURRENT.md:114` («отсутствие сериализации одновременных `poll` по одному каталогу профиля»). Not a supported use of this prototype; no message is lost |
| RI-15 | `finishMailboxRewalk()` would open a store transaction if a speculative caller ignored the branch | **OPEN (by design, recorded)** | `Δ4346e2b` on `inbound.ts`; still reachable only through the `rewalk !== undefined` branch. Not a defect — a note for a future caller |
| RI-16 | RED-6's `behind` is 6, isolating the re-walk only in the maximum-size regime | **STALE** | `flood-closure.test.ts:806` carries the comment "Why `behind` is 60 and not 6 (finding T10R3-F-004)"; `:823` and `:827` both pass `behind: 60`. Already corrected before the wave |
| RI-17 | `contact import` against a flooded mailbox costs one extra full walk (~2:1 amplification) | **OPEN (by design, recorded)** | `Δ4346e2b` on `inbound.ts`. Reducing it needs the client to learn the relay-held mark — a protocol addition. An attacker cannot request a re-walk |
| RI-18 | The mailbox lifetime-envelope-count bound is answerable to a contact-card holder on `/v1/mailbox/ack` | **STALE** | Re-read on this tree, not inherited: `readThroughWithinIssued` runs at `mailbox_handler.go:774`, **after** `VerifyMessageSignature` at `:748-756`; the poll route does the same at `:591` after `:578`. The rationale at `:758-773` names finding T10R3-F-002. `keryx ctx rg -i oracle docs/` → 0 matches, so no shipped document asserts it |
| RI-19 | `bundle_id` (and `identity_id`, `device_id`) carry no length bound in `ValidatePreKeyBundle` | **FIXED** | `7af8492` (RED, added `prekey_bundle_identifier_bounds_test.go`) → `18afa36`. `validate.go:83-91` now runs the `MaxIdentifierBytes` loop over all three identifiers *before* signature verification, with the reason at `:64-82`. The shared constant is `validate.go:138`, `MaxIdentifierBytes = 256` |
| RI-20 | The 3-argument `GetEnvelopeBatch` survives only as a delegation, with no production caller | **OPEN (unrecorded)** | `Δ4346e2b` on both `mailbox_repo.go` and `internal/service/mailbox_service.go`. Carried: harmless today; the two tests that call the old form are the blocker, not the risk |
| RI-21 | `HasMore` can be a false positive when every remaining item is expired | **OPEN (unrecorded)** | `Δ4346e2b` on `mailbox_repo.go`. Carried: one wasted round trip, no correctness loss |
| RI-22 | The rate limiter's bucket map has no max-entry cap; `pruneLocked` is O(n) under the shared lock | **OPEN (unrecorded)** | `Δ4346e2b` on `internal/middleware/rate_limit.go`. Carried. **Its cost is not flat**: on a tailnet the source-address population is small, which is the only reason this is currently cheap |
| RI-23 | `BackfillDeviceMailboxBindings` aborts the whole scan on one undecodable record, and has no conflict retry | **FIXED** | `7af8492` (RED) → `18afa36`. `device_record_repo.go:148-155` now counts and skips (`skipped++`, `return nil`); `:175-179` writes each binding through `saveDeviceMailboxBindingWithRetry`; `:181-188` logs a count and no key. Round 3's mutation **G4** (restore `return err` at `:148`) fails three named tests across two packages — *carried from round 3*. Recorded at `STATUS_CURRENT.md:110`, which also keeps the open half: the scan's startup cost was never measured |
| RI-24 | `size_bytes` is typed `z.number()` only, so a fractional or negative value passes the client schema | **OPEN (unrecorded)** | `Δ4346e2b` on `packages/protocol/src/types/mailboxEnvelope.ts`; `:17` is still `size_bytes: z.number()`. Carried: a client-side tightening must land in strict agreement with the relay's `size_bytes == len(ciphertext)` check, so it is FIX WITH CARE |
| RI-25 | Sender resolution via `DeriveMailboxID` distinguishes a published identity from an unpublished one | **OPEN (unrecorded)** | `cryptoutil.DeriveMailboxID(envelope.SenderIdentityID)` at `mailbox_handler.go:235`. Carried: collapsing the two 403 codes costs the operator the distinguishable precondition T50-F-002 restored |
| RI-26 | The `:v1` sender transcript does not bind `message_id`, `recipient_identity_id` or `recipient_device_id` | **OPEN (unrecorded)** | Read in both languages: `apps/relay/internal/cryptoutil/signatures.go:136` and `packages/crypto-core/src/mailbox/auth.ts:192` are both `echolet-mailbox-envelope:v1:<recipient_mailbox_id>:<envelope_id>:<sender_identity_id>:<sender_device_id>:<ciphertext_digest>:<created>:<expires>` — the three named fields are absent from both. Carried: a `:v2` transcript is a breaking wire change |
| RI-27 | The poll resume `cursor` is outside the signed challenge transcript | **OPEN (unrecorded)** | `mailbox_handler.go:562-576` builds the transcript from challenge id, mailbox id, device id, nonce and — in V2 — `read_through`. The resume `cursor` is read separately at `:620` and never enters it. Carried; should ride with RI-26 rather than be paid twice |
| RI-28 | A position cursor is not immune to concurrent mutation: an envelope can be skipped or repeated | **OPEN (by design, recorded)** | `Δ4346e2b` on `mailbox_repo.go`. The key-cursor alternative was rejected on the merits (the F-009 constraint) |
| RI-29 | No in-flight handler tracking: a handler may still be unwinding while `st.Close()` runs | **OPEN (unrecorded)** | **Narrowed, not closed.** `main.go:119-156` now drains through `srv.Shutdown(ctx)` before forcing `srv.Close()`, and `:177-180` stops the router's background work before Badger — so the sharpest edge (the cleanup ticker, RI-30) is gone. But `keryx ctx rg 'sync.WaitGroup' apps/relay` finds it in **five test files only** (`rate_limit_test.go`, `mailbox_ordering_test.go`, `prekey_bundle_v2_test.go`, `challenge_repo_test.go`, `tlsx/reloader_test.go`) and in no production file. "No handler outlives the store" is still an argument, not a guarantee |
| RI-30 | `CleanupService.Start()` spawns a ticker goroutine that is not cancellable and not part of shutdown | **FIXED** | `7af8492` (RED) → `18afa36`. `cleanup_service.go:62-90` publishes `stop`/`stopped` under a mutex; `Stop()` at `:103-116` closes `stop` and **waits on `<-stopped`**; `main.go:177-180` calls it on every path that closes the store. Round 3's mutation **G7** (`<-stopped` → `_ = stopped`) fails `TestCleanupServiceStopWaitsForItsGoroutineInsteadOfOnlySignallingIt` under `-race`; T27 recorded 20 kills in 20 runs. `internal/service` now holds two test files where it held zero |
| RI-31 | Neither shutdown escalation path — drain deadline, second signal — is covered by a test | **FIXED** | `7af8492` added `internal/server/process_shutdown_escalation_test.go`, which declares `TestRelayExitsZeroWhenTheDrainDeadlineIsExceeded`, `TestRelayExitsZeroOnASecondSignalDuringShutdown` and `TestRelayStopsTheCleanupServiceBeforeClosingStorage` — the two escalation paths T1 named, plus the ticker ordering. Verified by `keryx ctx rg '^func Test' apps/relay/internal/server/` |
| RI-32 | `drainTimeout` is a compile-time constant (5 s) | **OPEN (unrecorded)** | `const drainTimeout = 5 * time.Second` at `main.go:32`; `internal/config/config.go` has no shutdown field. `main.go` **was** edited in this wave (+35), so this was reachable and was not taken. An operator running `docker stop --time 60` still cannot lengthen the drain |
| RI-33 | A failing `st.Close()` produces exit 1 even on an operator-requested stop | **OPEN (by design, recorded)** | `main.go:182-191`, with the rationale in the source: "an unflushed memtable is the durability problem this whole path exists to prevent". Pinned by `TestRelayClosesStorageCleanlyOnSIGTERM` |
| RI-34 | There is no root `test:e2e` script | **OPEN (recorded)** | Root `package.json` read in full: scripts are `prepare`, `typecheck`, `lint`, `test`, `test:go`, `hooks:install`, `hooks:verify`, `gate:docs`, `gate:range`, `gate:selftest`, `mobile:start`, `relay:dev`. No `test:e2e`. Explicitly recorded at `README.md:8` — "There is still **no root `test:e2e` script**; `pnpm test:e2e` at the repository root fails" — and at `STATUS_CURRENT.md:65` |
| RI-35 | `gofmt -l apps/relay` reports three files | **FIXED** | `4fdb658` (*style(relay): format the three files gofmt has been listing*), which is HEAD and lands **after** the tree round 3 measured. Re-run here: `gofmt -l apps/relay` → **no output, exit 0**. See §5: `STATUS_CURRENT.md:114` has not caught up |
| RI-36 | One published bundle serves exactly one first-contact sender; three runtime methods have no CLI entry | **FIXED-IN-PART** | `d49ec6c` (RED) → `1ed5b2a`. `outbound.ts:81-113` re-submits every stored member, mints one replacement per dead slot and returns `pool: {target, claimable, minted}` — a pool of `LIMITS.PREKEY_MIN_COUNT = 20`. The recipient now *does* have a command that fixes exhaustion: `relay publish`. Pinned by `outbound.publicationPool.test.ts`, `profile.publicationPool.test.ts` and e2e `prekey-pool-replenishment.test.ts`. **Residue OPEN:** `rotateBundle()`, `retryPending()` and `listContacts()` still have no CLI entry point (`cli.ts:88-96` still lists exactly eight commands), now a recorded decision at `cli-bridge.test.ts:10,40`; and the recovery asymmetry is a price, not a closure — one attacking source destroys 120 members/min against at most 60 restored (`STATUS_CURRENT.md:108`) |
| RI-37 | `--json` is declared on every command and never read | **OPEN (unrecorded)** | `cli.ts:62` declares it, `:89-96` allows it on all eight commands, and `git diff 4346e2b..HEAD -- apps/cli/src/commands/cli.ts` is **comment-only** — the sole hunk rewrites a doc comment about `PREKEY_BUNDLE_UNAVAILABLE`. Nothing reads `values.json`; output is unconditionally JSON at `:391-393` |
| RI-38 | `send` passes the message body as `--text <plaintext>`, so plaintext reaches the process table | **OPEN (unrecorded)** | `cli.ts:93` still declares `text` for `send`; the cli.ts diff across the wave is comment-only (above). Carried: fixing it changes `send`'s interface or adds a ninth entry point — the frozen-surface decision |
| RI-39 | A fresh TUI session cannot name contacts the profile already trusts | **FIXED-IN-PART** | `cc854ec` (RED) → `d26bd58`. The pane no longer shows a silently short list: `profiles-pane.ts` computes `rosterDiscrepancy` and states it, pinned by `profiles-pane.rosterClaim.test.ts`. The decision and both rejected alternatives are recorded in the source at `profiles-pane.ts:12-19`. **Residue OPEN:** the underlying gap is unchanged — there is still no way to show history for a contact this session did not import |
| RI-40 | `INVALID_RELAY_RESPONSE` never reaches the operator; everything unknown flattens to `PROTOCOL_REJECTED` | **OPEN (unrecorded)** | `cli.ts:58` — `reportedRelayCodes` is still `{PREKEY_BUNDLE_UNAVAILABLE, UNAUTHORIZED_MAILBOX_ACCESS, SENDER_QUOTA_EXCEEDED}` — and `:384` still flattens anything else. The cli.ts diff is comment-only |
| RI-41 | A poll that accepts nothing re-raises the first rejection and discards the `rejected` array | **OPEN (by design, recorded)** | `Δ4346e2b` on `inbound.ts`; the reason is in the source at `:123-126`. Preserves the F-012 whole-batch contract |
| RI-42 | `persistenceFailure()` is the residual bucket, so anything unrecognised is reported as a disk problem | **OPEN (unrecorded)** | `cli.ts:388` still returns `persistenceFailure()` for every unmatched error, after the typed branches at `:378-387`. The cli.ts diff is comment-only. **This is the same misdiagnosis shape T10-F-003 was fixed for** |
| RI-43 | `init --relay-url .../path` succeeds and every later relay command fails with exit 5 | **STALE** | `Δ4346e2b` on `apps/cli/src/runtime/config.ts`; the `isRelayOrigin` refusal T1 verified is unchanged, and `test/e2e/init-relay-url.test.ts` still exists |
| RI-44 | `parseClientConfig` and `RelayClient` disagree on what counts as loopback | **STALE** | `Δ4346e2b` on `apps/cli/src/transport/loopback.ts` — the single shared predicate is unchanged. The stale assertion is also gone from the documents: `STATUS_CURRENT.md:114`'s flow-002 residual list now names only T10R3V-F-001…F-004 and no longer carries the loopback-disagreement half of T10R3-F-003 |
| RI-45 | `http://[::ffff:127.0.0.1]/` is refused because the parser normalises it past the regex | **OPEN (recorded)** | `Δ4346e2b` on `loopback.ts`, and `keryx ctx rg 'ffff' apps/cli/src/transport/loopback.ts` → **0 matches**: neither the predicate nor the comment mentions the mapped form, so **both halves are still open**, including the free comment-only half. Recorded at `STATUS_CURRENT.md:114`. Refusal is in the safe direction |
| RI-46 | "an ordinary poll leaves the encrypted store byte-identical" is not literally true | **OPEN (recorded)** | Both sites survive: `inbound.ts:161` ("an ordinary poll still leaves the store byte-identical") — `Δ4346e2b` — and `profile.ts:197` ("byte-identical (F-012)"), in a file the wave edited (+145) without touching this. Recorded at `STATUS_CURRENT.md:114` |
| RI-47 | Comments in two test files name `Profile.takeMailboxRewalk()`, a method that no longer exists | **OPEN (recorded)** | Five sites survive, exactly as T1 found them: `rewalk-crash-safety.test.ts:18,30,239,408` and `flood-closure.test.ts:601`. `:18` still describes the **delete-before-the-walk** shape as current, which is the defect the code was changed to remove. Both files were edited in this wave (timeout constants, `2c96bce`) without correcting the prose. Recorded at `STATUS_CURRENT.md:114` |
| RI-48 | `apps/relay/relay` is an untracked binary corresponding to no commit | **OPEN (recorded)** | `ls -la apps/relay/relay` → 18 094 306 bytes, **mtime 2026-09-07 21:02**. The earliest wave commit touching relay source is `5235a6d` at 2026-09-08 03:24, and four later ones follow, so the binary predates the current relay source by construction and matches no commit at or near HEAD. Still ignored at `.gitignore:94`, so it is invisible to `git status` — the hazard is quieter, not smaller. Recorded at `STATUS_CURRENT.md:114`; re-measured independently by round 3 |
| RI-49 | RED tests landed in the fix's own commit, and no per-test-file digest was recorded | **OPEN (unrecorded)** | **Mostly adopted, once violated, and the violation is undispositioned.** Six of the wave's fixes are clean RED→GREEN pairs (`7af8492`→`18afa36`, `cc854ec`→`d26bd58`, `5b51309`→`e949aae`, `d49ec6c`→`1ed5b2a`, `0355b30`→`23a17aa`, `d6d5f8f`→`5235a6d`), and per-test-file SHA-256 digests *are* now recorded — seven in `003-T5-tests-result.json`, four in `003-T27-tests-result.json`. The violation: `5235a6d` carries product code **and** `mailbox_poll_byte_budget_derivation_test.go` **and** a new `internal/config/max_message_bytes_config_test.go`, both importing `internal/protocol`, a package that same commit creates — so red-first is *unprovable from history* for those two, not merely unproven (round 3, R3-006 / V-005, third round unchanged). What was done instead: round 3 killed both with mutations G2 and G-ZERO. **That substitution is recorded here and nowhere else, and it is why AC10 is PARTIAL** |
| RI-50 | Source comments still assert "/v1/messages/send has no sender authentication" | **STALE** | `validate.go:120` now reads "Since T51 /v1/messages/send authenticates the sender against an already-published, root-signed DeviceRecord…", and the three test-file sites read "When these tests were written … T51 added it". *T1's grammar nit rides on unfixed*: `validate.go:120-124` is still "Since X …, **but** that binding …, **so** these …", a sentence with no main clause, in a file the wave edited (+34) |
| RI-51 | Documentation debt: `claimable`, `PREKEY_BUNDLE_UNAVAILABLE`, cursor semantics etc. appear nowhere in `docs/` | **STALE** | Checked against the tree rather than against `STATUS_CURRENT.md`'s claim: `keryx ctx rg 'PREKEY_BUNDLE_UNAVAILABLE\|SENDER_QUOTA_EXCEEDED\|next_cursor\|sender_signature\|read_through' docs` returns matches across `specification.md`, `README.md`, `runbook.md`, `deployment-runbook.md:78`, `API-11`, `PROTOCOL-07` and `STATUS_CURRENT.md:137,143` |
| RI-52 | A shipped runbook still says `docker stop` reports `Exited (2)` | **FIXED** | `da24daa` (*docs: reconcile every document with the tree*). Re-checked here, not inherited: `keryx ctx rg 'Exited \(2\)' docs` → **0 matches**, and `deployment-runbook.md:740` now reads "`docker stop` reports `Exited (0)`. The relay handles SIGTERM and SIGINT, closes…" |
| RI-53 | T49 and T52 are still `todo` in flow 001's `flow.json` | **STALE** | `flow.json` parsed with `python3`, not grepped: `T29=done T38=done T49=done T52=done`, and `T10/T11/T12=todo` — correctly, since those are mobile delivery, the cryptographic audit and the pilot (RI-56) |
| RI-54 | `build-image.sh`'s dirty check fires on generated files that never enter the build context | **OPEN (unrecorded)** | `Δ4346e2b` on `deploy/relay/build-image.sh`; `:50` still runs `git status --porcelain` over `$REPO_ROOT` with no `-- "$CONTEXT"` scoping, tagging `-dirty` at `:51`. Every image built while any agent-generated file exists is still mis-tagged, and the working tree is in exactly that state right now |
| RI-55 | The compose file's adoption of a volume it did not create is untested | **OPEN (unverifiable here)** | `docker-compose.insecure-loopback.yml:126-131` still declares `data: name: "${ECHOLET_DATA_VOLUME:-echolet-relay-data}"` with **no `external:`**, unchanged in substance. **Missing to settle it:** a Docker daemon, a volume created outside compose by `docker volume create`, and one throwaway `compose up`. This task may not use the two hosts that hold the real volumes, and the local exercise was never done |
| RI-56 | Not established: production security, mobile delivery, public deployment, an independent audit, user demand | **OPEN (by design, recorded)** | Flow 001 `flow.json` still carries `T10=todo T11=todo T12=todo` (parsed above). Recorded at `STATUS_CURRENT.md:151`. Out of scope for a computer CLI prototype; nothing in this tree can change it |
| RI-57 | Nothing in `apps/mobile` observes whether the mobile demo signs *correctly* | **OPEN (recorded)** | `Δ4346e2b` on the whole of `apps/mobile`. `keryx ctx rg 'sender_signature\|signMailboxEnvelopeMessage' apps/mobile` → **two matches, both in `src/screens/MessagingScreen.tsx` (:24, :267)**; no test in the package references either. Recorded at `STATUS_CURRENT.md:111` |
| RI-58 | The first-envelope byte-budget exemption is unpinned by any test (MG3) | **STALE, and the document was cleaned** | `Δ4346e2b` on `mailbox_repo.go` and `mailbox_repo_test.go`, so T1's out-of-tree mutation kill still applies. The AC1 half that was outstanding is now done: `STATUS_CURRENT.md:111` no longer asserts the claim and says so in place — «Два прежних пункта этого списка сняты как неверные на текущем дереве … мутация «убрать освобождение бюджета байт для первого конверта» убивается тестом `mailbox_repo_test.go:217`» |
| RI-59 | `GetEnvelopeBatchFrom` has no repository test with a non-empty cursor | **STALE, and the document was cleaned** | `Δ4346e2b` on `mailbox_ordering_test.go`. Same deletion at `STATUS_CURRENT.md:111`, which names `mailbox_ordering_test.go:306`. **Residue OPEN:** the narrower property T49-F-002 worried about — expiry skipped before the cursor is consumed — is still guarded only by a source comment, and nothing in the wave added the assertion |
| RI-60 | No permanent Node pin: `apps/cli` needs ≥22.13, and on ≤22.12 the suites fail like a broken implementation | **OPEN (recorded), and the item is partly wrong** | **T1's clause "the repository root has no `engines` field" is false, and was false at `4346e2b`**: `git diff 4346e2b..HEAD -- package.json` shows `"node": ">=22"` as *context*, not as an addition — the root declared it all along. The rest holds and the hazard is untouched: `ls .nvmrc .node-version .npmrc` → all three **No such file or directory**, so there is no `engine-strict` and pnpm still warns rather than refuses; and the root's `>=22` does **not** encode the `>=22.13` that `apps/cli/package.json:6` actually requires, so it would admit the v22.12.0 that produces the failure. Recorded at `STATUS_CURRENT.md:123` and `README.md:49` |
| RI-61 | `STATUS_CURRENT.md` and the requirements `README.md` never record the clean-shutdown fix | **FIXED** | `da24daa`. `STATUS_CURRENT.md:75` — «**Relay корректно останавливается по SIGTERM и SIGINT** (коммит `a2f07bb`…)» — and `README.md:18` — "**The relay stops cleanly on SIGTERM and SIGINT** (commit `a2f07bb`…)". Both read on this tree |
| RI-62 | `apps/cli`'s `test:e2e` script runs one of six e2e files | **FIXED** | `2d15634`. `apps/cli/package.json:12` is now `"test:e2e": "vitest run test/e2e"`, read here in full. Round 3 resolved the script's own selector with `npx vitest list test/e2e` (collection only, exit 0) to **7 files / 30 tests**, and confirmed the corrected figure at `metrics-and-validation.md:21,27`, `STATUS_CURRENT.md:53`, `README.md:10` and `specification.md:21`. *The `vitest list` count is carried from round 3; I did not re-run it* |
| RI-63 | `CleanupService` has three unused fields, no tests, and a documented knob that binds nothing | **FIXED-IN-PART** | Two of three halves closed. Knob: `2d15634`/T33 removed `CleanupIntervalSec` from `Config` entirely; `cleanup_service.go:11-21` records why, and the period is now `service.DefaultCleanupIntervalSeconds`. Tests: `internal/service` holds `cleanup_service_stop_test.go` and `cleanup_service_stop_join_test.go` where it held none. **Residue OPEN:** `keryx ctx rg 's\.mailboxRepo\|s\.challengeRepo\|s\.mailboxTTL' apps/relay/internal/service` → **0 matches**; all three are still stored at `cleanup_service.go:51-56` and read nowhere, and `runCleanup()` at `:118-123` is still two `slog.Debug` calls. Recorded at `STATUS_CURRENT.md:116` — «Открыто: пустое тело `runCleanup()`» |
| RI-64 | No workspace package declares a `lint` script, so the root `"lint": "pnpm -r lint"` runs nothing | **OPEN (recorded)** | `keryx ctx rg '"lint"' apps packages package.json` → **exactly one match, `package.json:11`**, the root script itself. Note `eslint@9.22.0` *is* a root devDependency, which makes the vacuum easier to miss, not smaller. Recorded, with the consequence spelled out, at `STATUS_CURRENT.md:115` |
| RI-65 | Four fix areas (F-002, F-006, F-007, F-010/F-011) were never reached by a mutation pass | **OPEN (recorded)** | The wave ran mutations — twenty of them in round 3 alone — and **none** falls in those four areas: round 3's table covers the TUI shell, the size mirror, config validation, the backfill, the cleanup join and the v2 pool. Recorded at `STATUS_CURRENT.md:111` |
| RI-66 | Above ~30× CPU oversubscription vitest discards a whole file's results, with no config lever | **OPEN (unverifiable here)** | **Missing to settle it:** deliberate ~30× oversubscription of this machine, which would invalidate anything measured beside it, and this task is forbidden a full suite run in any case. Recorded at `STATUS_CURRENT.md:112` and, at length, in `README.md:8` — where the wave additionally established that vitest's worker RPC deadline can turn a run with **zero** failed tests into exit 1 |
| RI-67 | Two timeout mechanisms coexist, with nothing recording which values are load-bearing | **FIXED-IN-PART** | `2c96bce` added `apps/cli/test/childProcessTimeouts.ts`, which is exactly the catalogue RI-67 asked for: `:29`, `:37` and `:67-73` name each ceiling, its measured basis (~20.4 s worst single child) and why it must sit above the one below it. Round 3 read the commit in full and found no assertion relaxed. **Residue OPEN:** `find apps packages -name vitest.config.ts` → **`apps/cli/vitest.config.ts` only**, so every other package still runs on vitest's 5 000 ms default — the half that produced T42-F-001 |
| RI-68 | Node loads only the FIRST certificate from a multi-PEM trust file | **OPEN (by design, recorded)** | Upstream Node behaviour, recorded where the next reader hits it: `relay-tls.test.ts:91-93` — "FIRST certificate from a multi-PEM trust file (measured …) so the renewal below trusts each pair explicitly". No lever available here |
| RI-69 | The TLS e2e suite silently degrades to a loopback run when the host has no non-loopback IPv4 | **OPEN (unrecorded)** | `relay-tls.test.ts:78` declares `nonLoopbackAddress()`, `:84-85` falls back with `nonLoopback ?? …`, and `:237` guards the stronger assertions behind `if (nonLoopback)`. The file was edited in this wave (timeout constants) without touching this. A CI host with no non-loopback interface still runs a weaker suite and says nothing |
| RI-70 | AC4's "different machine" half is unestablished and AC7 is blocked; three documents say so | **FIXED-IN-PART** | The documentation half is done and internally consistent: `STATUS_CURRENT.md:77` («**AC4 установлен после flow 002 — на `depr`, а не на loopback**»), `README.md:40` ("**AC4 is now established; AC7 is not**"), and `deployment-runbook.md:51,779-791`, which states which path does *not* establish AC4 and must never be cited for it. **The underlying host fact is OPEN (unverifiable here)** and I decline to endorse it: it rests on flow 002's `t11-tls-report.md` and a concurrent session's `flow.json` write, and this task may not connect to `geekom` or `depr`. Missing: a run against `https://depr.tail5a88fb.ts.net:8443` by someone with host access |
| RI-71 | A `pkill -f relay-data` during T9 stopped a relay another session had running | **STALE** | A past process incident, not a property of the tree. Every e2e suite starts its own relay through `test/globalSetup.ts`; nothing expects a relay on 18099. The operating rule lives in the flow journal |
| RI-72 | Tailnet only; no public DNS, no inbound port, no mTLS — the tailnet is the access control | **OPEN (by design, recorded)** | `deployment-runbook.md:1036` and `STATUS_CURRENT.md:151`. A correctly stated design position; mTLS is out of scope |

---

## 3. What the wave fixed, what predates it, what was stale

**Fixed by this wave (10)** — `RI-09`, `RI-10`, `RI-19`, `RI-23`, `RI-30`, `RI-31`, `RI-35`,
`RI-52`, `RI-61`, `RI-62`. Each names a commit in the range `4346e2b..4fdb658` and something
checkable beyond the commit. Five of the ten are RED→GREEN pairs whose red half is a separate,
earlier commit.

**Fixed in part by this wave (5)** — `RI-36`, `RI-39`, `RI-63`, `RI-67`, `RI-70`. Each row
names its residue; the residues are open and are listed in §6.

**Already closed before this wave, and confirmed still closed (12 STALE)** — `RI-04`, `RI-11`,
`RI-16`, `RI-18`, `RI-43`, `RI-44`, `RI-50`, `RI-51`, `RI-53`, `RI-58`, `RI-59`, `RI-71`. Nine
of the twelve are closed by a file being byte-identical to the tree T1 verified; `RI-18` and
`RI-51` were re-read at source on this tree rather than inherited; `RI-52`'s document deletion
(the one shipped document that contradicted the code) is in §2 as FIXED because the wave did it.

**AC1's "deleted from every document that still asserts it" is satisfied for the three stale
items that had a live document site**: `RI-52` (`deployment-runbook.md`, deleted by `da24daa`),
and `RI-58` + `RI-59` (`STATUS_CURRENT.md:111`, whose two former clauses are now removed with
the removal stated in place). `RI-44`'s stale parenthetical is likewise gone from
`STATUS_CURRENT.md:114`. The remaining eight stale items had no shipped-document site.

---

## 4. Inventory items that are themselves wrong about the tree

Three, and one of them is the inventory's own arithmetic.

1. **The count.** `t1-residual-inventory.md:38` says "62 items" and `:115-119` says ten ids are
   unused. The document contains 95 `| RI-` rows carrying **72 distinct ids, RI-01…RI-72, none
   missing**; the bucket counts printed at `:38` (21/15/14/12) understate every bucket but one.
   The dispatch for this task and round 3's R3-001 both repeat the 62. **Actual: 72.**
2. **RI-60's root-`engines` clause.** T1 asserts "the repository root has **no** `engines` field".
   `git diff 4346e2b..HEAD -- package.json` shows `"node": ">=22"` inside `engines` as a *context*
   line, so it was present on the very tree T1 verified. The item's substance survives — the
   declared floor is `>=22`, not the `>=22.13` that matters, and `.nvmrc`, `.node-version` and
   `.npmrc` are all absent — but the clause as written is false.
3. **RI-29's citation.** T1 describes `main.go:118-148` as "`Close()` then `closeStorage(st, 0)`".
   On this tree `main.go:119-156` drains through `srv.Shutdown(ctx)` first and only forces
   `srv.Close()` on a deadline or a second signal, and `:177-180` stops background work before
   Badger. The finding's *conclusion* still holds — there is no in-flight handler tracking
   anywhere in production code — but the shape it cites is not the current shape.

---

## 5. One contradiction this pass found that round 3 could not have

**`docs/STATUS_CURRENT.md:114` now asserts something the tree contradicts.** Under
«Открытые ограничения» it lists, as a live flow-002 residual, «три файла, не прошедшие
`gofmt`, из которых два — до этого flow». `gofmt -l apps/relay` on this tree prints **nothing**
and exits 0, because `4fdb658` — HEAD, and the commit *after* the tree round 3 measured —
formatted exactly those three files. The fix landed without the document following it, which is
the same shape as `RI-52` and the same shape as `RI-61`, in the same file, one commit later.

Round 3 ruled AC2 NOT MET on three sites (`R3-002`, `R3-003`, `R3-004`). All three are now
answered **and committed**, in `b3b37a8`, which landed during this pass: `runbook.md:98,255`,
`prekey-pool-replenishment.test.ts:39`, `README.md:7`. I read all three on the tree before that
commit and they read the same after it.

**This gofmt site is a fourth, and `b3b37a8` does not touch it.** `git show --stat b3b37a8`
lists five files and `docs/STATUS_CURRENT.md` is not among them; `keryx ctx rg gofmt docs` still
returns exactly one match, `STATUS_CURRENT.md:114`. **AC2 cannot be closed until it is deleted** —
and it must be deleted alone: the five sibling residuals in the same sentence (RI-14, RI-45,
RI-46, RI-47, RI-48) are each independently re-verified open above and must stay.

---

## 6. What remains open after this wave

Ordered by what it would cost someone to hit it, not by how easy it is to fix.

1. **RI-02 — identity creation is free.** One unauthenticated HTTP 200 mints a sender usable
   against every victim. Every price this project has raised is a linear price, not a barrier.
2. **RI-01 — no storage cap of any kind.** A flood fills the relay host's disk until Badger or
   the filesystem fails, taking the relay down for every user, with `df -h` as the only monitor.
   Six operator-facing files present the dead variable as though it bound something.
3. **RI-05 — O(N²) occupancy scan.** Relay CPU grows quadratically under exactly the attack
   this project is about.
4. **RI-26 — the `:v1` sender transcript binds neither `message_id` nor the recipient fields.**
   Harmless while the relay is tailnet-only and TLS-terminated; a live rewrite primitive the
   moment it is reachable elsewhere. RI-27 (unsigned resume cursor) rides with it.
5. **RI-55 — compose volume adoption never exercised.** An operator following the compose path
   against an existing relay's data volume may get a silently fresh volume: the relay comes up
   healthy and every stored envelope is invisible. Cheap to settle locally with a throwaway
   volume; expensive to discover on a host holding data.
6. **RI-48 — the untracked 18 MB relay binary.** Anyone running `apps/relay/relay` measures code
   of unknown provenance while believing they exercise the tree under test, and `.gitignore:94`
   has removed the one signal that would prompt its deletion.
7. **RI-29 — no in-flight handler tracking.** Narrowed by the new drain and by RI-30's fix, but
   "no handler outlives the store" is still an argument.
8. **RI-42 and RI-40 — the CLI misdiagnoses.** Any unanticipated failure is reported as
   `PERSISTENCE_FAILURE`, pointing the operator at a disk that is fine; a malformed relay
   response or an older relay reads as "the relay rejected you". Both send a human down the
   wrong path, and both are the shape T10-F-003 was fixed for.
9. **RI-38 — message plaintext on `argv`.** Readable from `ps` by any local user, next to the
   words "end-to-end encrypted".
10. **AC2's fourth site — `STATUS_CURRENT.md:114`'s gofmt clause** (§5), plus the three round-3
    sites whose answers are still uncommitted.
11. **RI-25 — the published-identity oracle**, and **RI-22 — unbounded rate-limiter map**: both
    currently cheap only because the tailnet keeps the population small.
12. **RI-64 — nothing lints this codebase.** A quality leg that silently passes is worse than an
    absent one, and it is the mechanical cause of the health adapter's ESLint gap.
13. **RI-57 — the mobile transcript is observed by nothing.** A wrong transcript is caught only
    by a real relay refusing it, and mobile messaging is off by default.
14. **RI-60 — the Node floor still admits v22.12.0**, on which most CLI suites fail in a way
    indistinguishable from a broken implementation. Documented in prose; unenforced mechanically.
15. **RI-54 — `build-image.sh` tags `-dirty` on agent files.** The one signal meaning
    "unreproducible image" is trained to be ignored — including right now, on this tree.
16. **RI-49 — `5235a6d`'s red-first ordering is unprovable from history**, and the substitution
    (round 3's mutations G2 and G-ZERO) is recorded here and nowhere else. This is why AC10 is
    PARTIAL and will stay PARTIAL.
17. **RI-69** (TLS e2e degrades silently), **RI-32** (5 s drain not configurable), **RI-24**
    (`size_bytes` schema weaker than the contract it declares), **RI-45** (IPv4-mapped loopback,
    including the free comment-only half).
18. **RI-06, RI-20, RI-21** — storage-layer carry-overs: an ordering index that expires rather
    than being deleted, two entry points to one selection path, one wasted round trip.
19. **RI-46 and RI-47 — seven stale comment sites** that describe removed shapes as current.
    Prose only, and the trap RI-47 sets is that it describes the defect as the design.
20. **RI-12, RI-65 — accepted coverage bounds**: one interruption point in the crash-safety
    sweep; four fix areas still never mutated.
21. **RI-63's residue** (three fields read by nothing, an empty `runCleanup`), **RI-67's residue**
    (every package but `apps/cli` on vitest's 5 000 ms default), **RI-36's residue** (three
    runtime capabilities with no CLI entry, and the pool's 2:1 recovery asymmetry),
    **RI-39's residue** (no history for a contact this session did not import), **RI-59's
    residue** (expiry-before-cursor guarded by a comment), **RI-34** (no root `test:e2e`).
22. **RI-70's host half and RI-66** — not settleable from this machine at all.
23. **RI-03, RI-07, RI-08, RI-13, RI-14, RI-15, RI-17, RI-28, RI-33, RI-41, RI-56, RI-68,
    RI-72** — thirteen deliberate positions, environment facts and out-of-scope items. Open in
    the sense that they are true; not open in the sense of being work.

---

## 7. Where I differ from the round-3 verification

I treated `003-T25-verify-r3-result.json` as strong evidence and re-derived rather than
inherited wherever a command was cheap. Four differences, none of which overturns its verdicts:

1. **RI-35 (gofmt) is closed at HEAD, and round 3 was right at `ac51393`.** Round 3 lists the
   three files under R3-001 as re-measured and open. `4fdb658` — the very next commit, and HEAD
   here — formats them, and `gofmt -l apps/relay` now prints nothing. This is a tree that moved
   under a verifier, not an error by one. **But it created a new AC2 contradiction (§5) that
   round 3 could not have seen.**
2. **The item count is 72, not 62.** R3-001 says "T1's 62 `RI-` items", inheriting T1's own
   summary line. Counted mechanically the inventory carries 72 distinct ids. R3-001's *verdict*
   is unaffected and correct; the number in it is not.
3. **Round 3's three AC2 sites are answered, and were committed while this pass ran.**
   `b3b37a8` lands `runbook.md`, `README.md` and `prekey-pool-replenishment.test.ts`. Round 3
   was right about all three on the tree it measured; they are closed on HEAD. **AC2 is still
   NOT MET**, on the fourth site in §5, which no commit has touched.
4. **I record RI-70's documentation closure without endorsing the fact behind it.** Round 3 did
   not examine AC4; T1 explicitly declined to. The documents are now internally consistent and
   say AC4 is established — but that rests on a host measurement no one in this flow could
   verify, and a document is a claim.

**Round 3's finding R3-005 I neither confirm nor dispute**: I did not re-run round 2's MU-4. It
is carried as round 3's evidence, labelled as such. Likewise all twenty mutation outcomes cited
above: they are round 3's, not mine — I ran no test suite.

---

## 8. Routing audit

- `graph_used`: **no** — *not relevant*. Every target was named by an inventory row, a report
  `file:line` or a commit; there was no "where does this live" question to answer.
- `wiki_used`: **no** — *not relevant*. This is a disposition pass against a frozen criterion;
  the authoritative sources are the criteria, the commits and the code, read directly.
- `ctx_used`: **yes** — `keryx ctx run` for every git, `ls`, `find`, `gofmt` and `python3`
  invocation, `keryx ctx rg` for every search over project code, `keryx ctx read` for
  `apps/cli/package.json`. Raw logs under `.metaproject/data/gdctx/`.
- `raw_rg_used`: **no**. Every text and symbol search over project code went through
  `keryx ctx rg`. Two structured extractions (`flow.json` parsed with `python3`, the inventory's
  row count computed with `python3`) ran through `keryx ctx run` because gdctx compaction would
  have destroyed exactly the counts being taken.

**Test suites run: none.** No `pnpm -r test`, no `go test ./...`, no `test:e2e`, not even a
single-file run — no row here needed one. Commands run: `git log`, `git status`, `git diff`
(`--stat`, `--name-only`, and one file diff), `ls`, `find`, `gofmt -l apps/relay`, and two
`python3` one-liners. **Files changed by this task: this document and its sibling result JSON.**
