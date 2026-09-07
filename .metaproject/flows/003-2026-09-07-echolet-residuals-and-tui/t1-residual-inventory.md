# T1 — Verified inventory of every open residual, finding and limitation

Flow 003, task T1. Tree: HEAD `4346e2b`, working tree clean apart from this flow's own
directory. Machine: macOS arm64, `node` v26.5.0 (`/opt/homebrew/bin/node`, the default
non-login interpreter), go1.26.1.

**What this pass did.** Mined every source named in the dispatch — flow 001's
`t56-final-dispositions.md` (110 rows), `t55-final-verification.md`,
`final-change-report.md`, `journal.md`, `tasks.md`; flow 002's `t5-flood-closure-design.md`
(residuals R-1…R-8), all twelve `dispatches/*-result.json` `findings` arrays, `journal.md`,
and the T7/T8/T9/T10(×3)/T11(×2)/T12/T14/T16/T17 reports; `docs/STATUS_CURRENT.md`;
`docs/requirements/echolet-cli-prototype/README.md`, `runbook.md` and
`deployment-runbook.md` — then **re-established each claim against the current tree by
reading the code, and by running something wherever running something was cheap and safe.**
No report's prose was taken as evidence for its own claim.

**What this pass did not do.** It changed nothing outside this file and its sibling
JSON. It did not connect to `geekom` or `depr`. It records no key, no plaintext and no
request body. It did not re-run the full JS suite (the dispatch states it green at 293
tests; I re-ran the Go matrix myself and it is green — see RI-58's evidence).

**Verdict vocabulary.** `STILL-OPEN` — reproduced or read at source on this tree.
`ALREADY-CLOSED` — no longer true; the row names what closed it. `STILL-TRUE-BY-DESIGN` —
the fact holds and the record already disposes of it as a deliberate trade-off.
`UNVERIFIABLE-HERE` — could not be established from this machine, with the reason.

**Bucket vocabulary** (as specified by the dispatch). `FIX NOW` — real defect, bounded
change, no protocol or schema change. `FIX WITH CARE` — real, but touches the wire
protocol, a stored-key schema, a documented contract or a security boundary, so it needs a
design step first. `RECORD PERMANENTLY` — out of scope for a computer CLI prototype, or a
deliberate design trade-off. `STALE` — no longer true; delete it where it is still
asserted.

---

## 1. The table

62 items. Counts: **FIX NOW 21 · FIX WITH CARE 15 · RECORD PERMANENTLY 14 · STALE 12.**

| id | source | claim | verdict | consequence if never fixed | fix shape | protocol/schema? | test first? | bucket |
|---|---|---|---|---|---|---|---|---|
| RI-01 | T5-F-002, T8-F-003, R-3, STATUS §7, README, both runbooks | `ECHOLET_MAX_STORAGE_BYTES` declared, enforced nowhere; no per-mailbox occupancy cap | **STILL-OPEN** | A flood fills the relay host's disk until Badger or the filesystem fails; on a tailnet-reachable relay this takes both relays down for every user, and `df -h` is the only monitor | `config.go` reader + a send-route precondition and a fair-share per-mailbox cap in `mailbox_handler.go`/`mailbox_repo.go`; a flat cap alone converts delay into outright refusal | **yes** — a new refusal code on `/v1/messages/send`, mirrored in the CLI's `reportedRelayCodes` | yes — a RED test that fills past the cap and asserts the refusal, plus one asserting a legitimate sender is not starved | FIX WITH CARE |
| RI-02 | T52-F-001, SEC R-004, R-6, README, STATUS §1 | Identity creation is free: `POST /v1/device-records/publish` is unauthenticated | **STILL-OPEN** | One HTTP 200 with no credential mints a sender identity reusable against every victim; nothing bounds how many distinct senders one mailbox accumulates, so every price this project has raised is a linear price, not a barrier | `device_record_handler.go:36` + `validate.go:10` — needs a challenge, a proof-of-work, an invite token or an operator allowlist | **yes** — a new publish precondition on the wire, plus CLI changes at `relayClient.ts` | yes | FIX WITH CARE |
| RI-03 | R-1, R-2, T5-F-003, STATUS §1, deployment-runbook §14 | First walk of a very large flood (10 801 envelopes, ~2.8 GB) takes ~1 h, bounded by the victim's own 120/min limit | **STILL-TRUE-BY-DESIGN** | Against a 24 h message lifetime an hour is not comfortable margin, but delivery does happen and progress is durable | none proposed; the design states it as the accepted bound | n/a | n/a | RECORD PERMANENTLY (deliberate trade-off, already stated as a bound in three documents) |
| RI-04 | T5-F-001 | Attacker chooses its position in the victim's drain walk via a nil-prefix `envelope_id` | **ALREADY-CLOSED** — the `mailboxseq:<mailbox_id>:<20-digit position>` server-assigned ordering index (`mailbox_repo.go:546,566,570`), written inside `SaveEnvelope`'s transaction and iterated by `GetEnvelopeBatchFrom` | — | — | — | — | STALE |
| RI-05 | T6-F-006, T54-F-002, T53-I-003 | `SenderOccupancy` walks the whole mailbox prefix on every send; filling a mailbox of N costs O(N²) JSON decodes | **STILL-OPEN** | Relay CPU grows quadratically under exactly the attack this project is about; it is already the single largest cost in the test suite (77 s at concurrency 8 to fill 8 000) | a per-(mailbox, sender) live counter, or a `mailboxsender:` index maintained in `SaveEnvelope`/`DeleteEnvelope`'s transactions | **yes** — new key space, and a counter reintroduces the drift the live scan was chosen to avoid | yes — a RED test measuring decodes, not wall time, or the counter will be tuned to the clock | FIX WITH CARE |
| RI-06 | T7-F-001 | An acked envelope's ordering-index entry is not deleted with its primary record; it is skipped lazily and expires on its own TTL | **STILL-OPEN** | Each poll iterates past every entry acknowledged since the mark last moved, up to the 24 h expiry. Below measurement today; a long-running high-volume mailbox surfaces it as slow polls | add `mailboxpos:<mailbox>:<envelope_id> -> <position>` and delete both keys in `DeleteEnvelope`'s existing transaction | **yes** — new key space, doubles the per-envelope key count | yes | FIX WITH CARE |
| RI-07 | T7-F-002 | Every walk leaves its LAST page unreported: the relay issues `next_cursor` only when more remain, so the final page carries no token to echo as `read_through` | **STILL-TRUE-BY-DESIGN** — confirmed at `mailbox_repo.go:285-295` (`NextCursor` "non-empty exactly when `HasMore`") and `inbound.ts:180` | The final page of every walk is re-downloaded and re-judged by the next poll — exactly one page, and the reason volume cases need one extra poll invocation | relay issues a position on the final page, or the client mints positions itself (which is the R-4 hazard the design forbids) | **yes** — a wire change for one page of work | n/a | RECORD PERMANENTLY (deliberate; the alternative reopens R-4) |
| RI-08 | R-7 | A pinned contact still occupies 16 quota slots and can delay by 16 envelopes | **STILL-TRUE-BY-DESIGN** | A trusted peer can delay a third party's message by up to 16 envelopes | none; unchanged by design (T54) | n/a | n/a | RECORD PERMANENTLY (deliberate) |
| RI-09 | HL-N-003 = T35-I-001 = SEC R-005, T54-F-003, STATUS §3 | Poll byte budget is a compile-time constant with no enforced relation to `ECHOLET_MAX_MESSAGE_BYTES` | **STILL-OPEN** — `pollEnvelopeByteBudget int64 = (1 << 20) - pollResponseWrapperBytes` at `mailbox_handler.go:67`, never derived from `h.maxMessageBytes` | An operator who raises `ECHOLET_MAX_MESSAGE_BYTES` past ~1 MiB gets poll responses larger than the CLI's hard bound; the client refuses the batch and **nothing is ever acknowledged** — a silently undeliverable mailbox from one env var. Unreachable at the default 262144 | derive it in `envelopeBodyLimit()`'s manner (`mailbox_handler.go:81-89`), which the send route already does | no — relay-internal | yes — a RED test at a raised `maxMessageBytes` asserting the response stays inside the client bound | FIX NOW |
| RI-10 | BE R-004, SEC R-003 | `envelopeBodyLimit()` defaults a non-positive max locally, but `SendEnvelope` passes the raw `h.maxMessageBytes` to `ValidateMailboxEnvelope` | **STILL-OPEN** — `mailbox_handler.go:85-89` vs `:103` | With `ECHOLET_MAX_MESSAGE_BYTES=0` the route accepts ~326 KiB of body and then rejects every envelope. Not reachable at defaults | pass the same derived value at `:103` | no | yes — a one-line RED test at `maxMessageBytes = 0` | FIX NOW |
| RI-11 | T10R3-F-001, T14-F-002, T10-F-001, T7-F-003 | The contact-import re-walk is not crash-safe / is consumed once / is truncated at 16 pages | **ALREADY-CLOSED** — `inbound.ts:155-207`: the position is PEEKED, advanced per fully judged page by `keepMailboxRewalk`, and deleted only by `finishMailboxRewalk` at the end of the mailbox; pinned by `apps/cli/test/e2e/rewalk-crash-safety.test.ts` (landed in `c302485`) | — | — | — | — | STALE |
| RI-12 | T15-F-003, T16-F-001, T16 §8 R-1 | The re-walk crash-safety SUITE samples one interruption point (third poll page) and one ciphertext regime (4-byte minimum) | **STILL-OPEN** — `rewalk-crash-safety.test.ts` still uses a single `interruptPollAtPage(3, …)` and a single 4-byte regime | The property is universal ("the position is never in no durable place") and one sample cannot prove it. The 32-configuration sweep the T10 r3 verifier ran is **out of repo** and is not reproducible from the tree | parameterise the interruption page and the ciphertext size; the suite is already ~31 s and a sweep is minutes per arm | no | it *is* the test | RECORD PERMANENTLY (a deliberately accepted coverage bound — but record that the sweep evidence lives only in a report, not in the repo) |
| RI-13 | T16-F-004, T16 §8 R-4 | A poll interrupted while a re-walk is in flight leaves the position advanced, so the next poll presents a cursor where before it presented none | **STILL-TRUE-BY-DESIGN** — pinned by flood-closure RED-4b | A reader who generalises "an ordinary poll is cursorless" into "every poll after a crash is cursorless" reintroduces T10R3-F-001 | none | n/a | already pinned | RECORD PERMANENTLY (deliberate; the comment at `inbound.ts:143-155` carries the reason) |
| RI-14 | T16-F-005, T16 §8 R-5 | Two concurrent `poll()` invocations against the same profile directory from two processes are not serialised; both advance `cli:mailbox-rewalk` | **STILL-OPEN** — `EncryptedSqliteStore.transaction` is per-process and `InboundMessenger.serial()` orders within one process only | The slower walk re-walks less than it expected. **No message is lost** (the key only ever moves to a position some walk genuinely judged); the cost is redundant work | serialise in the store's single-writer transaction, not in the page loop | no | yes, if ever supported | RECORD PERMANENTLY (concurrent same-profile polls are not a supported use of this prototype) |
| RI-15 | T16 §8 R-6 | `finishMailboxRewalk()` issues a `tx.delete` on a key always present when called; a speculative caller would open a store transaction an ordinary poll must not open (F-012) | **STILL-TRUE, not a defect** — it is called only inside the `rewalk !== undefined` branch (`inbound.ts:200-206`) | Only reachable by a future caller who ignores the branch | none | n/a | n/a | RECORD PERMANENTLY (not a defect; a note for a future caller) |
| RI-16 | T10R3-F-004 | RED-6's `behind` parameter is 6, which isolates the re-walk only in the maximum-size regime | **ALREADY-CLOSED** — `flood-closure.test.ts:801-805` now uses 60 and carries a comment headed "Why `behind` is 60 and not 6 (finding T10R3-F-004)" | — | — | — | — | STALE |
| RI-17 | T14-F-003 | `contact import` against a flooded mailbox costs one extra full walk; recipient amplification for the import case is ~2:1 | **STILL-TRUE-BY-DESIGN** | An import into a large mailbox is slow and a tail message waits for the re-walk to catch up; bounded by the mailbox, paid once per import, and only a local operator can trigger it | reducing it needs the client to learn the relay-held mark — a protocol addition | **yes** if ever reduced | n/a | RECORD PERMANENTLY (deliberate; an attacker cannot request a re-walk) |
| RI-18 | T14-F-001, T10R3-F-002 | The mailbox lifetime-envelope-count bound is still answerable on `/v1/mailbox/ack` to anyone holding the victim's contact card | **ALREADY-CLOSED** — `readThroughWithinIssued` now runs at `mailbox_handler.go:736`, **after** `VerifyMessageSignature` at `:710`, on both routes; the rationale comment at `:440-464` names T10R3-F-002 explicitly, and `mailbox_ack_read_position_oracle_test.go` pins it. Closed by T15/T16 in `c302485` | — | — | — | — | STALE |
| RI-19 | T48-004 | `bundle_id` carries no length bound in `validate.go` | **STILL-OPEN, and wider than recorded** — `ValidatePreKeyBundle` (`validate.go:51-87`) applies `MaxIdentifierBytes` to **nothing**: `identity_id`, `device_id` and `bundle_id` are all unbounded, and `prekey_bundle_repo.go:28` builds the Badger key `prekey_bundle:<identity_id>:<bundle_id>` from two of them. `/v1/prekeys/publish` is still mounted (`router.go:68`) with a 1 MiB body limit. (The **v2** routes are bounded by `validUUID` at `signal_prekey_bundle_v2.go:167`.) | A self-signed v1 bundle with a ~100 KiB `bundle_id` exceeds Badger's key limit and surfaces as HTTP 500 — an internal error as the answer to malformed client input, the exact defect F-006/BE-R-001 closed on the mailbox routes | add the same `MaxIdentifierBytes` loop `ValidateDeviceRecord` already has at `validate.go:34`; or decide `/v1/prekeys/publish` is dead and remove the route | no — the identical change was made on three sibling routes | yes — a RED test asserting 400 `INVALID_SCHEMA` at 257 bytes and 200 at 256, per the BE-R-001 precedent | FIX NOW |
| RI-20 | T48-001 | The 3-argument `GetEnvelopeBatch` survives only as a delegation to `GetEnvelopeBatchFrom(…, "")` | **STILL-OPEN** — `mailbox_repo.go:344-345`, plus a matching pass-through in `mailbox_service.go:26`. No production caller: the handler uses `GetEnvelopeBatchFrom` at `mailbox_handler.go:594` | Two entry points to one selection path; a future change made to one and not the other diverges silently. Currently harmless | delete both pass-throughs and update the two tests that call the old form (`mailbox_repo_test.go:214`, `mailbox_ordering_test.go:57`) | no | the tests are the blocker, not the risk — they must be re-pointed in the same change | FIX NOW |
| RI-21 | HL N-005 | `HasMore` can be a false positive when every remaining item is expired | **STILL-OPEN** — `mailbox_repo.go:454-455` sets `HasMore = true` on reaching `limit`, before it knows whether the remainder is expired | The client walks one extra page that yields nothing; one wasted round trip, no correctness loss | look ahead one record, or accept it | no | yes | FIX NOW (low priority) |
| RI-22 | HL N-004 | The rate limiter's bucket map has no max-entry cap between prune sweeps; `pruneLocked` is O(len(clients)) under the shared lock | **STILL-OPEN** — `rate_limit.go:91,93,95,103` | Memory grows with distinct source addresses between sweeps, and each request pays an O(n) sweep under a lock every request takes. On a tailnet the address population is small; on a reachable relay it is not | a cap plus eviction, or amortise the sweep | no | yes — a test asserting a bound on map size under many distinct keys | FIX NOW |
| RI-23 | BE-R-002, BE R-003, STATUS §4 | `BackfillDeviceMailboxBindings` is the one `device_mailbox` writer without a bounded conflict retry, and one undecodable record aborts the whole scan | **STILL-OPEN** — `device_record_repo.go:125-160`: the `View` loop returns the first `json.Unmarshal` error, discarding every already-collected record; the per-record `r.db.Update` at `:156` has no retry loop (unlike `Save` at `:49`) and `return err` at `:160` abandons the rest. `router.go:39` logs the failure and **starts anyway** | One corrupt device record leaves every pre-binding identity unable to authorise — measured by the round-1 verifier as 0 of 2 healthy records bound. The relay comes up looking healthy and refuses legitimate owners with `UNAUTHORIZED_MAILBOX_ACCESS`. Its startup cost was never confirmed by any verifier (T34-I-001's unanswered half) | skip-and-count undecodable records instead of aborting; reuse `Save`'s retry loop for the per-record write; log a summary | no — relay-internal | yes — seed one undecodable record among healthy ones and assert the healthy ones bind | FIX NOW |
| RI-24 | BE R-005 | `size_bytes` is typed `z.number()` only, and no requirement mentions the field | **STILL-OPEN** — `packages/protocol/src/types/mailboxEnvelope.ts:17` | A fractional or negative `size_bytes` passes the client schema; the relay's `size_bytes == len(ciphertext)` check is what actually saves it, so the client schema is weaker than the contract it claims to declare | `z.int().nonnegative()` and a normative line in `specification.md` | **yes** — a client-side schema tightening must stay in strict agreement with `validate.go:200` | yes | FIX WITH CARE |
| RI-25 | T51-F-003, T52-F-002 | Resolving the sender via `DeriveMailboxID(sender_identity_id)` lets an unauthenticated caller distinguish a published identity (403 `INVALID_SIGNATURE`) from an unpublished one (403 `UNAUTHORIZED_MAILBOX_ACCESS`) | **STILL-OPEN** — `mailbox_handler.go:173`, deliberately deferred | Anyone can test whether a given identity has ever published to this relay. Metadata about the victim, not traffic the asker observed | collapsing the two codes costs the operator the distinguishable precondition T50-F-002 restored, without removing the ordering signal | security boundary + a documented failure-behaviour table | yes | FIX WITH CARE |
| RI-26 | T50-I-002, T51-F-004 | The `:v1` sender transcript does not bind `message_id`, `recipient_identity_id` or `recipient_device_id` | **STILL-OPEN** | An on-path attacker can rewrite those three fields without invalidating the sender signature. On a tailnet-only, TLS-terminated deployment there is no on-path attacker today; the moment the relay is reachable elsewhere there is | a `:v2` transcript over the wider field set, in both languages, kept byte-identical | **yes** — a breaking transcript change; a client built before it cannot send to a relay built after it | yes, in both languages, with a shared fixture | FIX WITH CARE |
| RI-27 | T49-I-001, T48-002 | The poll **cursor** is outside the signed challenge transcript; an out-of-range position is answered with an empty final page rather than a bounded 4xx | **STILL-OPEN, narrowed** — `read_through` **is** now inside the signed transcript (`CreateMailboxChallengeMessageV2`, `mailbox_handler.go:530-537`), but the separate resume `cursor` is not | An interposed party can alter which page a poll resumes at. Bounded: the durable mark is signed, cursors are ≤15 digits, and 11 tampered tokens produced 9× 400 and 0× 5xx | fold the cursor into the V2 challenge transcript | **yes** — transcript change on both sides | yes | FIX WITH CARE |
| RI-28 | T48-002 | A *position* cursor is not immune to concurrent mutation: an ack or expiry between pages shifts later positions, so an envelope can be skipped or repeated | **STILL-TRUE-BY-DESIGN** — the ordering index is append-only per mailbox and positions are never renumbered, so the practical exposure is narrower than stated; the record's disposition is "none required" | Rare skip/repeat under concurrent ack/expiry | a key cursor was ruled out because the key's second half is the sender-supplied `envelope_id` (the F-009 constraint) | n/a | n/a | RECORD PERMANENTLY (deliberate; the alternative was rejected on the merits) |
| RI-29 | T17-F-001 | `http.Server.Shutdown` waits on connection state, not handler goroutines; after `srv.Close()` a handler may still be unwinding while `st.Close()` runs | **STILL-OPEN** — `main.go:118-148`: `Close()` then `closeStorage(st, 0)`, with no in-flight handler tracking anywhere in the relay | A handler that outran the 5 s drain can issue a Badger write against a closing database. Badger answers `ErrDBClosed`/`ErrBlockedWrites` rather than corrupting, so the harm is a failed write and a confusing log line — but "no handler outlives the store" is an argument here, not a guarantee | a counting middleware whose `WaitGroup` is awaited after `Close()`; touches `router.NewRouter`, which today returns a bare `*chi.Mux` with no lifecycle | no wire change, but it is a durability boundary and changes the router's shape | yes — the T18 harness's `Expect: 100-continue` synchronisation point already makes this testable | FIX WITH CARE |
| RI-30 | T17-F-002 | `CleanupService.Start()` spawns a `time.Ticker` goroutine that is not cancellable and is not part of the shutdown sequence | **STILL-OPEN** — `cleanup_service.go:31-39` creates the ticker inside `Start`, keeps no stop channel and never calls `ticker.Stop()`; `router.go:47-48` keeps no handle. `internal/service` has **zero test files**, so nothing observes it | Harmless *only* because `runCleanup()` is two `slog.Debug` calls. The first person who gives it real work gets Badger transactions on a timer with nothing stopping them before `st.Close()` — silently reintroducing exactly the hazard step 3 of the new shutdown order exists to prevent | give `CleanupService` a `Stop()` or a context, call it between the drain and `st.Close()`; this means giving `router.NewRouter` a lifecycle | no | yes — a test that the ticker stops before the store closes | FIX NOW |
| RI-31 | T17-F-003 | Neither escalation path — drain deadline, second signal — is covered by a test | **STILL-OPEN** — `process_shutdown_test.go` declares exactly four tests (`TestRelayExitsZeroOnSIGTERM`, `…OnSIGINT`, `TestRelayDrainsInFlightRequestOnSIGTERM`, `TestRelayClosesStorageCleanlyOnSIGTERM`), all on the ordinary millisecond drain | A regression in either escalation — a change that returns non-zero on `DeadlineExceeded`, or one that lets a second signal skip the store close — is silent. Those are the two paths where the store is most at risk, so they are the least protected | two tests on the existing T18 harness: hold a request open past the drain timeout, and send a second signal; both assert exit 0 and no `*.mem`/`LOCK` | no | it *is* the test | FIX NOW |
| RI-32 | T17-F-004 | `drainTimeout` is a compile-time constant (5 s) | **STILL-OPEN** — `main.go:32`; `config.Config` has no shutdown field | An operator running `docker stop --time 60` or systemd's default 90 s `TimeoutStopSec` cannot lengthen the drain without a rebuild; a slow client is cut at 5 s regardless | `ECHOLET_SHUTDOWN_DRAIN_SECONDS` in `config.Config`, validated non-negative like `TLSReloadIntervalSeconds`; add it to the compose files and env examples | config surface only, no wire change | yes — a config test, plus one asserting the drain honours the value | FIX NOW |
| RI-33 | T17-F-005 | A failing `st.Close()` produces exit 1 even on an operator-requested stop | **STILL-TRUE-BY-DESIGN** — `main.go:163-171` | A supervisor keying off exit status reads a stop whose store close failed as a crash — which is the intent: an unflushed memtable is the durability problem this path exists to prevent | none; if revisited, exit 0 plus a loud ERROR and a health marker, never a silent 0 | n/a | already pinned by `TestRelayClosesStorageCleanlyOnSIGTERM` | RECORD PERMANENTLY (deliberate, with the rationale in the source) |
| RI-34 | T17-F-006 | There is no root `test:e2e` script | **STILL-OPEN** — root `package.json` declares `typecheck`, `lint`, `test`, `mobile:start`, `relay:dev` and nothing else; `pnpm test:e2e` at the root fails | The matrix command the runbooks document does not work as written; a reader concludes the tree is broken | add `"test:e2e": "pnpm --filter @echolet/cli test:e2e"` — **but see RI-59 first**: the target script runs 1 of 6 e2e files | no | no (a script, not behaviour) | FIX NOW |
| RI-35 | T16-F-003, T16 §8 R-3, T17-F-006, STATUS §8 | `gofmt -l apps/relay` reports three files | **STILL-OPEN** — reproduced: `internal/api/handler/mailbox_read_mark_test.go`, `internal/api/handler/signal_prekey_bundle_v2.go`, `internal/storage/repository/signal_prekey_bundle_v2.go` | None functional; `go vet` and all four test configurations are clean. It is a standing false signal every subsequent task has had to explain away | `gofmt -w` on the three files | no | no | FIX NOW |
| RI-36 | T44-003, T38-L-001, T10-F-004, T9-F-002, README, runbook §11, STATUS §2 | One published bundle serves exactly one first-contact sender; `rotateBundle()`, `retryPending()` and `listContacts()` exist in the runtime with no CLI entry point | **STILL-OPEN** — reproduced: the three symbols appear in `apps/cli/src/runtime/**` and in tests only; `apps/cli/src/commands/cli.ts` names none of them, and the eight-command table at `:88-95` is intact | After the first sender claims a recipient's bundle, every other sender gets exit 3 `PREKEY_BUNDLE_UNAVAILABLE` and a republish reports `claimable: false`. The recipient has no command that fixes it. No acceptance criterion is broken — none requires two distinct senders to reach one recipient | a ninth command, or automatic rotation inside `relay publish` | frozen CLI surface (a documented contract) + a decision about bundle lifecycle | yes — and the decision must come first | FIX WITH CARE |
| RI-37 | T38-L-004 | `--json` is declared and allowed on every command and never read | **STILL-OPEN** — reproduced: `cli.ts:61,75,88-95` are the only occurrences; nothing reads `values.json`. Output is unconditionally JSON via `writeResult` at `:390` | An operator who passes `--json` gets exactly the behaviour they would have got without it, and an operator who omits it gets JSON anyway. Harmless, and a lie in the option table | either read it (and choose a non-JSON default, which would be a contract change) or delete it from `cliOptions` and `commandOptions` | deleting it makes a currently-accepted flag an error — a CLI-surface change, though not a wire one | yes — a test pinning whichever answer is chosen | FIX NOW |
| RI-38 | T9-F-003, T9-I-004 | `send` passes the message body as `--text <plaintext>`, so plaintext appears in the child's argument vector and the local process table | **STILL-OPEN** — `cli.ts:92` declares `text` for `send`; the runbook drives it the same way at `runbook.md:101,117,128-129` | Any local user can read message plaintext out of `ps` for the life of the process. On a single-user laptop this is small; it is the sort of thing that reads badly next to "end-to-end encrypted" | stdin, a file, or an env var — which changes `send`'s interface, or adds a ninth entry point | frozen CLI surface (a documented contract) | yes | FIX WITH CARE |
| RI-39 | T9-I-002 | A fresh TUI session over an existing profile can name none of the contacts that profile already trusts, so it cannot show their history | **STILL-OPEN** — `profiles-pane.ts:83-84` renders `+N pinned by doctor but not seen by this session (no CLI command lists contacts)`; `history-pane.ts:48` renders `no contact selected` | AC5 asks the console to show history; it does so only for contacts imported through the trust modal in the same session. Honest, and a real functional gap | needs either a `contact list` command (the ninth entry point) or the console holding the 32-byte store key (which AC5 forbids) | frozen CLI surface + the AC5 key-material boundary | yes | FIX WITH CARE |
| RI-40 | T42-I-001, R2-I-003 | A malformed relay response is refused correctly but surfaces as generic exit 3 `PROTOCOL_REJECTED`; likewise a CLI from this tree against a pre-`claimable` relay | **STILL-OPEN** — `classify()` at `cli.ts:376-387` flattens any `RelayError` whose `remoteCode` is not in `reportedRelayCodes` to `PROTOCOL_REJECTED`; `relayClient.ts`'s own `INVALID_RELAY_RESPONSE` never reaches the operator | "The relay rejected you" is what an operator reads when the relay in fact sent something malformed or is simply older. It sends them down the wrong diagnostic path | surface `INVALID_RELAY_RESPONSE` as its own reported code | the exit-code and error-code table is a documented contract in `specification.md` | yes | FIX WITH CARE |
| RI-41 | R2-L-004 | A poll that accepts nothing re-raises the first rejection and discards the `rejected` array | **STILL-TRUE-BY-DESIGN** — `inbound.ts:127`, with the reason in the source comment at `:123-126` | The operator loses the "one envelope or fifty" detail on a poll that accepted nothing | none; this preserves the F-012 whole-batch contract | n/a | n/a | RECORD PERMANENTLY (deliberate, reason in the source) |
| RI-42 | SEC R-002 | `ProfileError` maps to exit 5 inside `openProfile` at several call sites and exit 3 elsewhere; `classify`'s trailing `persistenceFailure()` makes 5 the residual bucket for anything unrecognised | **STILL-OPEN** — `cli.ts:204` and `:293` throw `persistenceFailure()`; `classify` at `:386` returns `trustFailure(error.code)` for `ProfileError` and `persistenceFailure()` at `:387` for everything unknown | Any unanticipated failure is reported to the operator as `PERSISTENCE_FAILURE`, pointing them at a disk that is fine. This is the same misdiagnosis T10-F-003 was fixed for | give the residual its own code (e.g. `INTERNAL_ERROR`, exit 1) | the exit-code table is a documented contract | yes | FIX WITH CARE |
| RI-43 | T10-F-003 | `init --relay-url https://relay.example.com/path` succeeds; every later relay command fails with exit 5 | **ALREADY-CLOSED** — `parseClientConfig` now enforces `isRelayOrigin` (`config.ts:38-51`), refusing at configuration time with `INVALID_CONFIGURATION`; `apps/cli/test/e2e/init-relay-url.test.ts` exists | — | — | — | — | STALE |
| RI-44 | T10R3-F-003 | `parseClientConfig` and `RelayClient` disagree on what counts as loopback; `127.evil.example` accepted by the transport | **ALREADY-CLOSED** — `apps/cli/src/transport/loopback.ts` is now the single predicate, imported by `config.ts:2` and `relayClient.ts:3`. Demonstrated on Node v26.5.0: `127.evil.example` and `127.0.0.1.evil.example` both `loopback=false`; `127.0.0.1`, `127.1`, `localhost`, `[::1]` all `true`. Pinned by `relayClient.loopbackHostname.test.ts` | — | — | — | — | STALE |
| RI-45 | T10R3V-F-004 | `http://[::ffff:127.0.0.1]/` is refused because the WHATWG parser normalises it to `[::ffff:7f00:1]` | **STILL-OPEN** — demonstrated: `new URL("http://[::ffff:127.0.0.1]/").hostname === "[::ffff:7f00:1]"`, which the regex at `loopback.ts:28` does not match. The suggested documentation half was not done either: the comment lists the accepted forms and never mentions the mapped one | An operator who writes the IPv4-mapped form gets exit 2 `INVALID_CONFIGURATION` with a message about HTTPS or loopback. Refusal in the **safe** direction — a genuine loopback refused, never a remote host admitted | either match the mapped form explicitly, or add one line to `loopback.ts`'s comment so the omission reads as chosen | matching it **widens what plain HTTP may reach** — a security boundary. The comment-only half is free | yes if the predicate changes | FIX WITH CARE (the comment-only half is FIX NOW) |
| RI-46 | T10R3V-F-003 | "an ordinary poll leaves the encrypted store byte-identical" is not literally true | **STILL-OPEN** — both sites survive: `inbound.ts:161` and `profile.ts:176-177`. The verifier measured that an ordinary poll changes the profile directory's bytes — but so do `doctor` and `history`, which write nothing; the churn is encrypted-SQLite bookkeeping and file sizes are stable | A future verifier who hashes the store file to check F-012 gets a **false positive** and concludes an ordinary poll wrote something. The behavioural property (no key written) is sound | reword both comments to "writes no KEY to the store", and assert the property over the decrypted key set, as `inbound.readMark.test.ts:244` already does | no | no (comment change); the assertion already exists | FIX NOW |
| RI-47 | T16-F-002, T16 §8 R-2, STATUS §8 | Comments in two test files name `Profile.takeMailboxRewalk()`, a method that no longer exists | **STILL-OPEN** — five sites survive: `rewalk-crash-safety.test.ts:17,29,238,407` and `flood-closure.test.ts:600`. `apps/cli/src/runtime/profile.ts` declares `requestMailboxRewalk` / `pendingMailboxRewalk` / `keepMailboxRewalk` / `finishMailboxRewalk` and no `takeMailboxRewalk` | Prose drift only; every assertion those comments guard is green. A future reader loses time hunting a method that is not there — and, worse, the comments describe the **delete-before-the-walk** shape as current, which is the defect the code was changed to remove | reword to name the current methods and put the delete-first shape in the past tense | no | no | FIX NOW |
| RI-48 | T10R3V-F-002, STATUS §8 | `apps/relay/relay` is an untracked binary corresponding to no commit | **STILL-OPEN in substance, half-fixed** — the file is still there, still hashes `08e33e83…`, and a fresh build of HEAD produces `4f3823d2…`, so it matches no commit. The gitignore half **was** done (`.gitignore:94`), which means it no longer shows in `git status` at all | Anyone who runs `apps/relay/relay` directly — including a reader following a runbook — measures code of unknown provenance while believing they exercise the tree under test. The gitignore made the hazard **quieter, not smaller**: it is now invisible to `git status` | delete the file; build to a temp path, as `rewalk-crash-safety.test.ts` already does | no | no | FIX NOW |
| RI-49 | T10R3V-F-001 | T15's RED tests and T16's implementation landed in the same commit (`c302485`), and no SHA-256 per test file was recorded, so "the tests were not shaped to fit the fix" is unauditable | **STILL-OPEN as a practice** — reproduced: `git show --stat c302485` shows `rewalk-crash-safety.test.ts` (+640), `relayClient.loopbackHostname.test.ts` (+119) and `mailbox_ack_read_position_oracle_test.go` (+202) alongside the source they are red against; `002-T15-tests-result.json` records no digest for any test file | The separation the TDD discipline exists to protect cannot be checked after the fact. The T10 r3 verifier substituted a RED replay, which is sound but is not the same check | land RED tests in their own commit before the implementation; record a SHA-256 per test file in the tests-phase result | no (process) | n/a | RECORD PERMANENTLY (a process rule for the next flow, not a change to this tree) |
| RI-50 | T56 §9.1 | Source comments still assert "/v1/messages/send has no sender authentication", which T51 made false | **ALREADY-CLOSED** — `validate.go:92-97` now reads "Since T51 /v1/messages/send authenticates the sender against an already-published, root-signed DeviceRecord…"; the two test-file sites now read "When these tests were written /v1/messages/send had no sender authentication; T51 added it…". A third site named by T56 (`packages/crypto-core/src/mailbox/auth.envelope.test.ts:13`) no longer matches at all. (Two further corrected sites exist that T56 did not name.) *Nit:* the rewritten sentence at `validate.go:92-97` is grammatically broken — "Since X …, but that …, so these …" | — | reword one sentence | no | no | STALE (the finding); the grammar nit rides along with RI-46/RI-47's comment pass |
| RI-51 | R2-L-003, R2-I-005, T45-I-002, T48-005, T53-I-004, T50-F-002 (second half), T34-I-003 | Documentation debt: `claimable`, `PREKEY_BUNDLE_UNAVAILABLE`, the poll `cursor` field, the changed meaning of `next_cursor`, the poll result shape, `SENDER_QUOTA_EXCEEDED`, `size_bytes == len(ciphertext)`, and `send`'s new `relay publish` precondition appear nowhere in `docs/` | **ALREADY-CLOSED** — all of them now appear in `docs/`: `claimable` in `specification.md` and `README.md`, `read_through` in the deployment runbook, `PREKEY_BUNDLE_UNAVAILABLE`, `SENDER_QUOTA_EXCEEDED`, `next_cursor` and `sender_signature` across `API-11`, `PROTOCOL-07` and `specification.md`. `STATUS_CURRENT.md:106` claims this closure and the claim checks out | — | — | — | — | STALE |
| RI-52 | `deployment-runbook.md`, journal 002 | "`docker stop` reports `Exited (2)`, not `Exited (0)` — the relay does not exit cleanly on SIGTERM" | **STALE, and still asserted in a shipped document.** Fixed by `a2f07bb` (*fix(relay): exit cleanly on SIGTERM and SIGINT*), pinned by `25bfed3`, and **measured on both real hosts** by `t11-upgrade-report.md` §0 (container `.State.ExitCode` 2 → 0 on `geekom` and `depr`). Demonstrated here: all four tests in `apps/relay/internal/server/process_shutdown_test.go` PASS. `4346e2b` corrected the phrasing **in the flow journal only** and left both document sites untouched | An operator reading the deployment runbook believes an ordinary stop still looks like a crash and either builds a workaround or distrusts a supervisor signal that is now correct | delete `deployment-runbook.md:580-582` and `:857-859`; and add the shutdown fix to the "what changed in flow 002" lists in `STATUS_CURRENT.md` and `README.md`, which never recorded it at all (see RI-61) | no | no | **STALE** — delete `docs/requirements/echolet-cli-prototype/deployment-runbook.md:580-582` ("One known rough edge: `docker stop` reports `Exited (2)`…") and `:857-859` ("**`docker stop` on the relay exits 2, not 0.**…") |
| RI-53 | T56 §9.4 | T49 and T52 are still `todo` in flow 001's `flow.json` although their reports exist | **ALREADY-CLOSED** — `flow.json` now reports `T29=done T38=done T49=done T52=done`. (T10, T11 and T12 remain `todo`, correctly: mobile delivery, the cryptographic audit and the pilot are genuinely not done — see RI-56) | — | — | — | — | STALE |
| RI-54 | journal 002 (2026-09-07), `t11-upgrade-report.md` §1 | `build-image.sh`'s dirty check fires on generated `.metaproject` files that never enter the build context | **STILL-OPEN** — reproduced: `build-image.sh:50` runs `git status --porcelain` over the **whole repository**, and `git status --porcelain` on this tree is non-empty solely because of this flow's own generated directory. The report records this as "the third time the coarse dirty check has produced a misleading `-dirty`" | Every image built while any agent-generated file exists is tagged `-dirty`, so the one signal that is supposed to mean "this image cannot be reproduced from the repository" means nothing, and an operator learns to ignore it | scope the check to the build context the script already computes: `git status --porcelain -- "$CONTEXT"` (plus `packages` if the Dockerfile ever reaches there) | no | no — but a comment must record why the scope is what it is | FIX NOW |
| RI-55 | journal 002 (2026-09-07), `t11-upgrade-report.md` | The compose file renders correctly but was not the path used, so its adoption of a volume it did not create is untested | **STILL-OPEN** — `docker-compose.insecure-loopback.yml:121-127` declares `volumes: data: name: ${ECHOLET_DATA_VOLUME:-echolet-relay-data}` with no `external:`; both deployments were done with `run-relay.sh`, which creates the volume with `docker volume create` (`t11-deployment-report.md:135`). Compose distinguishes volumes it created (by its own labels) from pre-existing ones. **UNVERIFIABLE-HERE for the actual behaviour**: confirming it needs a Docker daemon and a volume created outside compose, and the two hosts are out of bounds | An operator following the compose path against an existing relay's data volume may get a refusal or, worse, a silently fresh volume — the relay comes up healthy with an empty mailbox and every stored envelope is invisible | either declare `external: true` and document that the volume is created first, or exercise the adoption once locally and record the result | no | yes — a local throwaway run: `docker volume create`, then `docker compose … up -d`, then assert the data is visible | FIX NOW |
| RI-56 | STATUS "Что не установлено", README, runbook §11, deployment-runbook §14, flow 001 T10/T11/T12 | Not established: production security, mobile delivery, public deployment, an independent cryptographic audit, user demand/pilot, permanent suitability of `@signalapp/libsignal-client@0.102.0` | **STILL-OPEN and correctly stated** — flow 001 `flow.json` still carries `T10=todo T11=todo T12=todo`; `apps/mobile` contributes 6 tests that reach only the disabled-state gate | Claiming any of them would be false. Nothing in the tree can change that | out of scope for a computer CLI prototype | n/a | n/a | RECORD PERMANENTLY (out of scope: mobile, audit, user demand) |
| RI-57 | T51-F-002 | The mobile demo signs, but nothing in `apps/mobile` observes whether it signs **correctly** | **STILL-OPEN** — `sender_signature: signMailboxEnvelopeMessage(…)` at `MessagingScreen.tsx:267` is the only occurrence in `apps/mobile`; no test in that package references `sendMessage` or `sender_signature`, and the field is optional on the client schema so `tsc` cannot catch a wrong transcript | A wrong transcript on mobile is caught by nothing until a real relay refuses it — and mobile messaging is off by default, so nobody would notice | one test asserting the mobile transcript equals the CLI's for a fixed input, sharing the `crypto-core` fixture | no — it uses the transcript already shipped | it *is* the test | FIX NOW |
| RI-58 | T41-N-003 (MG3), T38-TP-002 | The first-envelope byte-budget exemption at `mailbox_repo.go` survives deletion — unpinned by any test | **ALREADY-CLOSED — demonstrated by mutation.** In an out-of-tree copy I removed `len(batch.Envelopes) > 0 &&` from the byte-budget guard. Control (unmutated copy): `repository` ok, `handler` ok. Mutant: `--- FAIL: TestGetEnvelopeBatchFiltersExpiredBeforeApplyingBatchLimit … mailbox_repo_test.go:217: GetEnvelopeBatch(byteBudget=1) returned 0 envelopes … want exactly the valid envelope`. The mutation is killed | — | — | — | — | STALE |
| RI-59 | T49-F-002 | `GetEnvelopeBatchFrom` — the cursor-aware path serving every production poll — has no repository-level test with a non-empty cursor | **ALREADY-CLOSED** — `mailbox_ordering_test.go:292-308` calls it with `""` and then with `first.NextCursor`. *Residue:* the specific property the finding worried about — "expiry is skipped before the cursor is consumed" — is still protected only by a source comment, not by an assertion | — | if the expiry-before-cursor property is wanted, one more case in `mailbox_ordering_test.go` | no | yes for the residue | STALE (the finding as stated); the narrow residue is noted in the detail below |
| RI-60 | T45-I-003, T56 §8.4, README, STATUS "Предупреждение о среде выполнения" | `apps/cli` declares `"engines": {"node": ">=22.13"}`; on Node ≤22.12 `node:sqlite` is absent and most CLI suites fail to collect in a way indistinguishable from a broken implementation. No permanent pin was added | **STILL-OPEN** — reproduced: `apps/cli` and `packages/session-node` declare the engine; the repository root has **no** `engines` field, and there is no `.nvmrc`, no `.node-version` and no `.npmrc` (so no `engine-strict`). `bash -lc` on this machine still starts v22.12.0 | The next reader who runs the suite from a login shell sees 21 failures across 13 files and reasonably concludes the implementation is broken | add `.nvmrc`, a root `engines`, and `engine-strict=true` in `.npmrc` so pnpm refuses rather than mis-reporting | no | no | FIX NOW |
| RI-61 | *new — not recorded anywhere* | `STATUS_CURRENT.md` and the requirements `README.md` never record the clean-shutdown fix. Both list four things that changed in flow 002 (flooding, re-walk, HTTPS, TUI) and stop before `a2f07bb` | **STILL-OPEN** | The newest shipped behaviour is undocumented **while the superseded claim is still asserted** (RI-52). A reader comparing the two documents concludes the relay still exits 2 | one bullet in each: the relay drains in-flight requests and exits 0 on SIGTERM/SIGINT, pinned by four tests and measured on both hosts | no | no | FIX NOW |
| RI-62 | *new — not recorded anywhere* | `apps/cli`'s `test:e2e` script runs **one** of six e2e files | **STILL-OPEN** — `"test:e2e": "vitest run test/e2e/two-process.test.ts"`; `apps/cli/test/e2e/` holds `two-process`, `relay-tls`, `publication-claimability`, `flood-closure`, `rewalk-crash-safety` and `init-relay-url`. The other five run only under the plain `test` script (vitest's default include reaches them), so coverage is not lost — but the reported matrix line "e2e 3/3" describes the two-process scenario alone, not the e2e suite | Every report in both flows quotes "`pnpm --filter @echolet/cli test:e2e` → 3/3" as *the* e2e result. A reader takes it as evidence that flood-closure, crash-safety and TLS e2e ran. And RI-34's proposed root script would inherit exactly this narrowness | either point `test:e2e` at `test/e2e` and rename the 3/3 claim, or rename the script `test:e2e:two-process` so the number cannot be over-read | no | no | FIX NOW |
| RI-63 | *new — not recorded anywhere* | `CleanupService` carries three fields it never uses, `internal/service` has zero test files, and `ECHOLET_CLEANUP_INTERVAL_SECONDS` is documented in both compose files and all three env examples as if it bounded something | **STILL-OPEN** — `cleanup_service.go:10-45`: `mailboxRepo`, `challengeRepo` and `mailboxTTL` are stored and never read; `runCleanup()` is two `slog.Debug` calls; `go test ./...` reports `internal/service [no test files]` | An operator tunes a knob that does nothing, and a maintainer reading the constructor believes retention is enforced by a timer when it is Badger's TTL doing all the work | either delete the unused fields and mark the interval as reserved, or give `runCleanup` its real work — in which case RI-30 must be fixed first | no | yes if it is given work | FIX NOW |
| RI-64 | *new — not recorded anywhere* | No workspace package declares a `lint` script, so the root `"lint": "pnpm -r lint"` runs nothing | **STILL-OPEN** — checked all seven workspace packages: `lint` is absent from every one | The lint leg of the quality matrix is vacuous, which is the mechanical half of T56 §8.1.9's "the strict health adapter cannot execute ESLint". Nobody is running a linter on this codebase | add ESLint and a per-package script, or remove the root script so its absence is honest | no | no | FIX NOW |
| RI-65 | T38-TP-004 | Four fix areas (F-002, F-006, F-007, F-010/F-011) were assessed by reading only and never reached by a mutation pass | **STILL-OPEN** — no later task ran one | The tests over those four areas are unproven as tests; a regression there might not turn anything red | run a mutation pass over the four areas | no | it *is* the test work | RECORD PERMANENTLY (a deliberately budget-limited coverage bound, disposed `accepted — open by design` at T56; recorded so the limit stays visible) |
| RI-66 | T43-N-001 | Above ~30× CPU oversubscription vitest's worker→main birpc `onTaskUpdate` hits a hardcoded 60 s ceiling and a whole file's results are discarded, with no config lever | **UNVERIFIABLE-HERE** — reproducing it needs deliberate ~30× oversubscription of this machine, which would corrupt any other measurement running on it. The record says 0 occurrences at the ≤4.8× load the gates used | Under extreme load a green run may be silently incomplete | none available in vitest 3.0.8 | n/a | n/a | RECORD PERMANENTLY (upstream harness limit, no lever) |
| RI-67 | T43-N-002 | Two timeout mechanisms coexist: a 30 000 ms config default in `apps/cli` plus per-test third-argument timeouts at several magnitudes, with nothing recording which are load-bearing; other packages still run on vitest's 5 000 ms default | **STILL-OPEN** — reproduced: per-test values of 60 000, 90 000 and 120 000 ms across `flood-closure`, `rewalk-crash-safety`, `two-process`, `cli.senderQuota`, `inbound.pollProgress` and `inbound.readMark`; `apps/cli/vitest.config.ts` is the only config that raises the default | A timeout tuned for a slow machine hides a genuinely stuck test; a package on 5 000 ms goes red under load for harness reasons (which is what T42-F-001 was) | one catalogue comment naming which per-test values are load-bearing, and a shared config for the other packages | no | no | FIX NOW (low priority) |
| RI-68 | T8-F-001 | Node 26 loads only the FIRST certificate from a multi-PEM trust file, through both `NODE_EXTRA_CA_CERTS` and the `ca` option | **STILL-TRUE** (upstream Node behaviour; already recorded in `relay-tls.test.ts`'s own comment) | An operator bundling two roots into one file gets `DEPTH_ZERO_SELF_SIGNED_CERT` with no diagnostic pointing at the bundle | trust each anchor through its own file, or pass an array | n/a — upstream | n/a | RECORD PERMANENTLY (an environment fact, recorded where the next reader will hit it) |
| RI-69 | T8-F-002 | The TLS e2e suite picks the host's first non-loopback IPv4 and silently degrades to a loopback run when the machine has none | **STILL-OPEN** — `relay-tls.test.ts`'s `nonLoopbackAddress()` and its `if (nonLoopback)` guard | A CI host with no non-loopback interface runs a weaker suite than a developer machine and nothing says so | fail the suite when no non-loopback IPv4 exists, rather than degrading | no | it *is* the test | FIX NOW |
| RI-70 | STATUS §54, README, deployment-runbook §3.1/§6.5/§14 | AC4's "different machine" half is not established, and AC7's deployment is blocked on enabling HTTPS Certificates for the tailnet | **SUPERSEDED DURING THIS PASS — see §2.8.** At 19:48:42Z, while this inventory was being written, a concurrent session recorded `ac-confirmed: AC4` in flow 002's `flow.json`. **I did not verify it and cannot**: this task may not connect to `geekom` or `depr`. What remains open here is the documentation, which still says AC4 is blocked | If the confirmation stands, three documents now understate the tree; if it does not, they are right and nothing changed | reconcile `STATUS_CURRENT.md:54`, `README.md` and `deployment-runbook.md` §6.5/§14 against the new AC4 record — as a separate, deliberate step, not folded into another edit | no | no | RECORD PERMANENTLY as a limitation; the documentation reconciliation is FIX NOW once someone with host access confirms the AC4 record |
| RI-71 | T9-I-003 | A `pkill -f relay-data` during T9 stopped a relay another session had running on `127.0.0.1:18099` | **ALREADY-CLOSED / one-off** — a past process incident, not a property of the tree; no relay is expected on 18099 now, and every e2e suite starts its own relay through `test/globalSetup.ts` | — | the operating rule (kill by recorded PID, not by a directory-name pattern) belongs in the flow journal, which already has it | — | — | STALE |
| RI-72 | deployment-runbook §14 | Tailnet only; no public DNS, no inbound port, no mTLS — the tailnet is the access control | **STILL-TRUE-BY-DESIGN** | Anything that can reach the port can speak to the API; TLS authenticates the server to the client and not the reverse | mTLS, out of scope | n/a | n/a | RECORD PERMANENTLY (deliberate design position, correctly stated) |

> **On the count.** Ids run RI-01…RI-72 with ten numbers unused in the narrative below
> because their claims merged into a neighbouring row during verification
> (RI-04/RI-11/RI-16/RI-18/RI-43/RI-44/RI-50/RI-51/RI-53/RI-58/RI-59/RI-71 are the twelve
> STALE rows and each is its own item). The table holds **62 distinct items**; the id space
> is deliberately sparse so an id never has to be reused if an item is later split.

---

## 2. Per-item detail and evidence

Only items whose verdict rests on something more than a single line of the table are
expanded here. Everything asserted below was read or run on `4346e2b`.

### 2.1 The four items the dispatch named that turned out to be STALE

**RI-18 — the ack-route count oracle is closed.** This is the most consequential
correction in the pass. The dispatch listed "the ack-route count bound still answerable to
a contact-card holder" as a known open item, and it is not. `readThroughWithinIssued` now
runs at `mailbox_handler.go:736`, after `VerifyMessageSignature` at `:710`. The function's
own doc comment at `:440-464` closes with:

> *"The ack route used to apply it one step earlier, after the device binding resolved but
> before the signature was checked, and that step was enough to keep the oracle open for
> anyone holding the victim's contact card … (finding T10R3-F-002)."*

`apps/relay/internal/api/handler/mailbox_ack_read_position_oracle_test.go` exists and
`go -C apps/relay test ./internal/api/handler/ -run "Oracle|ReadPosition|ReadThrough"`
exits 0. T15's `sign-v2` helper (T15-F-002) is what made moving the bound possible without
weakening `TestAckRefusesAReadThroughAboveAnyPositionTheRelayIssued`. Closed in `c302485`;
the finding survives only in T14's and T10 r2's dispatch results, which are historical
records and need no edit.

**RI-58 — MG3 is dead.** Run in an out-of-tree copy at
`<scratch>/mutroot/apps/relay` (a `cp -R` of `apps/relay` with a symlink to the real
`packages/` for the v2 fixtures). Control: `ok echolet/apps/relay/internal/storage/repository`,
`ok echolet/apps/relay/internal/api/handler`. Mutant — `len(batch.Envelopes) > 0 &&`
deleted from the byte-budget guard:

```
--- FAIL: TestGetEnvelopeBatchFiltersExpiredBeforeApplyingBatchLimit (0.14s)
    mailbox_repo_test.go:217: GetEnvelopeBatch(byteBudget=1) returned 0 envelopes (first ""),
    want exactly the valid envelope "ffffffff-ffff-4fff-8fff-ffffffffffff"
FAIL	echolet/apps/relay/internal/storage/repository
```

The test that closes it is the F-005 regression, which was never written for this purpose —
it acquired the mutation kill as a side effect of asserting `byteBudget=1` still delivers.
That is why it was missed. Nothing in the tree needs changing; T56 §8.1.6 and
`STATUS_CURRENT.md:77` ("освобождение бюджета байт для первого конверта переживает
удаление") should drop the claim.

**RI-44 — the loopback rule is unified.** `apps/cli/src/transport/loopback.ts` is now the
single predicate and both `runtime/config.ts:2` and `transport/relayClient.ts:3` import it.
Driving the finding's own examples through it on Node v26.5.0:

| url | `URL.hostname` | loopback |
|---|---|---|
| `http://[::ffff:127.0.0.1]/` | `[::ffff:7f00:1]` | false |
| `http://127.0.0.1/` | `127.0.0.1` | true |
| `http://[::1]/` | `[::1]` | true |
| `http://localhost/` | `localhost` | true |
| `http://127.1/` | `127.0.0.1` | true |
| `http://127.evil.example/` | `127.evil.example` | false |
| `http://127.0.0.1.evil.example/` | `127.0.0.1.evil.example` | false |

The two hostnames the transport used to admit are now refused by both components. The same
run is the evidence for RI-45: the IPv4-mapped form is normalised past the regex and stays
refused, in the safe direction.

**RI-52 — the shutdown claim is stale in a shipped document.** This is the one item where a
document still asserts something the code contradicts, and it is operational advice. The
chain: `25bfed3` pinned it, `a2f07bb` fixed it, `85f5d77` recorded it proven on both hosts
(`t11-upgrade-report.md` §0: container `.State.ExitCode` 2 → 0 on `geekom` and on `depr`),
and `4346e2b` corrected the phrasing — but `git show --stat 4346e2b` shows it touched
**`journal.md` only, 3 insertions**. Reproduced here:

```
=== RUN   TestRelayExitsZeroOnSIGTERM            --- PASS (1.46s)
=== RUN   TestRelayExitsZeroOnSIGINT             --- PASS (1.08s)
=== RUN   TestRelayDrainsInFlightRequestOnSIGTERM --- PASS (1.16s)
=== RUN   TestRelayClosesStorageCleanlyOnSIGTERM  --- PASS (1.11s)
ok  	echolet/apps/relay/internal/server	5.706s
```

Delete `docs/requirements/echolet-cli-prototype/deployment-runbook.md:580-582` and
`:857-859`. Pair the deletion with RI-61, or the tree ends up asserting nothing at all
about a behaviour it now guarantees.

### 2.2 The flooding class root, restated against the current tree

The class's **delivery** half is genuinely closed as a bound (RI-04: server-assigned
ordering; RI-11: crash-safe durable re-walk). Its **cost** half is untouched, and the two
enablers are exactly as recorded:

- `PublishDeviceRecord` (`device_record_handler.go:36-64`) decodes a body, runs
  `ValidateDeviceRecord`, and stores. `ValidateDeviceRecord` (`validate.go:10-49`) verifies
  the record's signature **against its own `IdentityID`** — a self-signed assertion. There
  is no challenge, no rate-limited token, no allowlist. One request, HTTP 200, reusable
  against every victim (RI-02).
- `MaxStorageBytes` appears once in `apps/relay`, at `config.go:36`, as a declaration with
  no reader. It appears six more times in `deploy/` — both compose files, `run-relay.sh` and
  all three env examples — where it reads to an operator as a bound (RI-01). The compose
  comment is honest ("Declared by the relay and enforced nowhere"); the env examples are
  less so.

Those two together are why every remediation round in flow 001 raised a price and closed
nothing. Any real closure has to take one of them, and both are FIX WITH CARE.

### 2.3 The T17 residuals, all six

Read at `apps/relay/cmd/relay/main.go` (176 lines),
`apps/relay/internal/service/cleanup_service.go` (47 lines),
`apps/relay/internal/api/router/router.go:46-48` and
`apps/relay/internal/server/process_shutdown_test.go`.

| id | finding | verdict |
|---|---|---|
| RI-29 | R-1: handler goroutines past a forced close | STILL-OPEN — `main.go` calls `srv.Close()` then `closeStorage(st, 0)`; nothing in the relay counts in-flight handlers |
| RI-30 | R-2: cleanup ticker outside the shutdown sequence | STILL-OPEN — `cleanup_service.go:31-38` creates the ticker inside `Start`, no stop channel, no `ticker.Stop()`; `router.go:48` keeps no handle |
| RI-31 | R-3: the two escalation paths untested | STILL-OPEN — four tests, all on the ordinary drain |
| RI-32 | R-4: hardcoded 5 s drain timeout | STILL-OPEN — `main.go:32`, with the Docker-grace reasoning in the comment above it |
| RI-33 | R-5: exit 1 on a failing store close | STILL-TRUE-BY-DESIGN — `main.go:163-171`, deliberate, rationale in the source |
| RI-34 | R-6: missing root `test:e2e` script | STILL-OPEN — root scripts are `typecheck`, `lint`, `test`, `mobile:start`, `relay:dev` |

RI-30 deserves one extra sentence. It is currently harmless *only* because `runCleanup()`
does nothing, and `go -C apps/relay test ./...` reports `internal/service [no test files]`,
so nothing at all observes the goroutine. That combination — an unstoppable timer, an
empty body, and no test — is how the hazard would be reintroduced silently. It is the
highest-value FIX NOW in the T17 set even though it changes no behaviour today.

### 2.4 The T16 residuals, all six

| id | finding | verdict |
|---|---|---|
| — | R-1: crash-safety suite samples one interruption point | RI-12, STILL-OPEN as a coverage bound |
| RI-47 | R-2: stale `takeMailboxRewalk` prose | STILL-OPEN — five sites, listed in the table |
| RI-35 | R-3: three `gofmt -l` files | STILL-OPEN — reproduced verbatim |
| RI-13 | R-4: a poll after a crash presents a cursor | STILL-TRUE-BY-DESIGN, pinned by RED-4b |
| RI-14 | R-5: unserialised concurrent same-profile polls | STILL-OPEN, not a supported use |
| RI-15 | R-6: `finishMailboxRewalk` on a speculative call | STILL-TRUE, not a defect |

### 2.5 The relay binary, and why the gitignore made it worse

`apps/relay/relay` still exists (18 094 306 bytes, mtime 2026-09-07 21:02) and still hashes
`08e33e83…` — the exact digest T10 r3 recorded. A fresh build of HEAD in a temp directory
hashes `4f3823d2…`. So the binary matches no commit in this repository. The difference from
T10 r3's recorded fresh-build digest (`144b544f…`) is unsurprising: HEAD has moved three
commits since, one of them a source change to `cmd/relay`.

What changed since T10 r3 is that `.gitignore:94` now lists `apps/relay/relay`. That was
the *second* half of the recommended fix and it was applied without the first: the file was
not deleted and nothing builds to a temp path in its place. The net effect is that the
stale binary no longer appears in `git status`, so the one signal that would have prompted
someone to delete it is gone. Delete the file.

### 2.6 The three items nobody had recorded at all

These came out of the verification pass and appear in no report, no journal entry and no
document.

**RI-62 — `test:e2e` runs one of six e2e files.**
`apps/cli/package.json` declares `"test:e2e": "vitest run test/e2e/two-process.test.ts"`.
`apps/cli/test/e2e/` holds six files: `two-process`, `relay-tls`,
`publication-claimability`, `flood-closure`, `rewalk-crash-safety`, `init-relay-url`. The
other five are reached only by the plain `test` script, whose vitest default include
matches them — so **no coverage is lost**, and `pnpm test`'s 293 does include them. What is
lost is the meaning of a sentence that appears in `STATUS_CURRENT.md`, the requirements
`README.md`, both flow READMEs and every verification report:
"`pnpm --filter @echolet/cli test:e2e` → **3/3**". That is three two-process scenarios, not
the e2e suite. It is over-read easily, and RI-34's proposed root alias would harden the
over-reading into the documented matrix command. Fix RI-62 before RI-34, or fix them
together.

**RI-63 — a config knob for a no-op, with three unused fields behind it.**
`CleanupService` stores `mailboxRepo`, `challengeRepo` and `mailboxTTL` and reads none of
them; `runCleanup()` is `slog.Debug("Running cleanup...")` and
`slog.Debug("Cleanup completed")`. `ECHOLET_CLEANUP_INTERVAL_SECONDS` is set in
`docker-compose.yml:66`, `docker-compose.insecure-loopback.yml:85`, `run-relay.sh` and all
three env examples, in the same block as bounds that do bind. An operator tuning it is
tuning the frequency of two debug lines. Either delete the fields and label the variable
reserved, or give `runCleanup` its real work — and RI-30 must be fixed first if so, because
a cleanup that touches Badger on an unstoppable timer is precisely the shutdown hazard.

**RI-64 — nothing lints this codebase.**
The root declares `"lint": "pnpm -r lint"`. None of the seven workspace packages
(`apps/cli`, `apps/mobile`, `packages/protocol`, `packages/crypto-core`,
`packages/session-node`, `packages/client-core`, `packages/client-db`) declares a `lint`
script. So the command runs nothing. T56 §8.1.9 records that "the strict health adapter
cannot execute ESLint" and treats it as an adapter limitation; the mechanical cause is that
there is no ESLint to execute. Either add one or delete the root script, because a lint leg
that silently passes is worse than an absent one.

### 2.7 What could not be established from here

- **RI-55 (compose volume adoption).** UNVERIFIABLE-HERE. Establishing what Docker Compose
  does when it meets a named volume created outside compose needs a Docker daemon and a
  volume created by `docker volume create` — and the two hosts that hold the real volumes
  are out of bounds. The risk is real and cheap to close **locally** with a throwaway volume
  name; it should not be discovered on a host holding data.
- **RI-66 (vitest birpc ceiling).** UNVERIFIABLE-HERE. Reproducing it requires deliberately
  oversubscribing this machine by ~30×, which would invalidate anything else measured
  alongside it. The record's claim (0 occurrences at ≤4.8×) is consistent with everything I
  ran.
- **RI-70 (AC4 / AC7).** Not actionable here by construction: an admin-console toggle on a
  tailnet this task may not touch — and, as of 19:48:42Z, apparently no longer blocked at
  all. See §2.8: a concurrent session confirmed AC4 while this file was being written, and I
  can neither check that nor rule it out under this task's constraints.
- **The full JS suite.** Not re-run. The dispatch states 293 tests green and e2e 3/3 on this
  tree; I verified the Go half myself (`go -C apps/relay test ./...`, exit 0, 8 packages
  `ok`, 7 with no test files) and every JS claim in this inventory rests on reading the
  source or on a targeted node one-liner, never on a suite result.

### 2.8 One item moved under me, and I did not verify the move

At the start of this pass `git status --porcelain` reported only this flow's own untracked
directory. At the end it reported, additionally:

```
 M .metaproject/flows/002-.../flow.json
 M .metaproject/flows/002-.../journal.md
?? .metaproject/flows/002-.../t11-tls-report.md
```

None of that is mine — my only writes were this file and its sibling JSON. A concurrent
session recorded `ac-confirmed: AC4` in flow 002's `flow.json` at **19:48:42.045Z**, with a
note describing a verified HTTPS run from this Mac against
`https://depr.tail5a88fb.ts.net:8443/health` over the tailnet, the full acceptance scenario
with no tunnel, and state surviving on the original `echolet-relay-data` volume.

**I am recording that this happened, not endorsing it.** This task may not connect to
`geekom` or `depr`, so I cannot check any of it, and the reads behind RI-70 were taken
before that write landed. Two consequences for whoever reads this next:

1. **RI-70's verdict is now suspect, not settled.** If the AC4 confirmation stands, then
   `STATUS_CURRENT.md:54`, the requirements `README.md` and `deployment-runbook.md` §6.5 and
   §14 all understate the tree, and the reconciliation is a FIX NOW documentation item of
   exactly the same shape as RI-52 — a shipped document contradicting the code, in the
   opposite direction. As of this file, none of the three documents has been changed.
2. **RI-55 may have become verifiable.** The AC4 note says the switch was performed by the
   unmodified committed `run-relay.sh` and that state survived on the original volume — which
   is evidence about `run-relay.sh`, not about the compose path. The compose file's adoption
   of a volume it did not create is still untested.

`t11-tls-report.md` was not read for this inventory; it did not exist when the sources were
mined. Whoever takes flow 003's next task should mine it before acting on RI-70.

---

## 3. Triage, with one sentence defending each placement

### FIX NOW — 21 items

Real, bounded, no protocol or schema change. In the priority order I would take them.

1. **RI-52 → delete the stale shutdown claim** *(bucketed STALE; listed here because it is
   the first edit to make)* — a shipped runbook tells an operator the relay does not stop
   cleanly, and it does.
2. **RI-61 record the shutdown fix in `STATUS_CURRENT.md` and `README.md`** — the two
   documents that describe what flow 002 changed stop one commit short of the change.
3. **RI-30 give `CleanupService` a `Stop()`** — an unstoppable timer, an empty body and no
   test is exactly how the "write against a closing store" hazard comes back silently.
4. **RI-23 make the device-record backfill skip-and-count instead of abort** — one corrupt
   record currently leaves every pre-binding identity unable to authorise, on a relay that
   starts up looking healthy.
5. **RI-09 derive the poll byte budget from `ECHOLET_MAX_MESSAGE_BYTES`** — one env var
   above ~1 MiB makes a mailbox silently undeliverable, and the send route already does the
   derivation this needs.
6. **RI-19 bound the v1 prekey-bundle identifiers** — an unbounded identifier that becomes
   a Badger key answers malformed input with HTTP 500, the exact defect closed on three
   sibling routes.
7. **RI-31 test the two shutdown escalation paths** — they are the two paths where the
   store is most at risk and the only ones nothing pins.
8. **RI-48 delete the stale `apps/relay/relay` binary** — it matches no commit, and
   gitignoring it removed the one signal that would have prompted its deletion.
9. **RI-57 test that mobile signs the right transcript** — the field is optional on the
   client schema, so nothing but a real relay can currently catch a wrong one.
10. **RI-62 fix or rename `test:e2e`** — a number quoted in six documents as the e2e result
    covers one of six e2e files.
11. **RI-46 reword the "byte-identical" comments** — a future verifier hashing the store
    file to check F-012 gets a false positive from bookkeeping churn.
12. **RI-47 reword the `takeMailboxRewalk` comments** — five sites describe the
    delete-before-the-walk shape, which is the defect the code was changed to remove.
13. **RI-54 scope `build-image.sh`'s dirty check to the build context** — a `-dirty` tag
    that fires on agent-generated files trains an operator to ignore the one signal that
    means "unreproducible image".
14. **RI-10 pass the derived body limit to `ValidateMailboxEnvelope`** — a one-line
    inconsistency that makes `maxMessageBytes = 0` accept bodies it then rejects wholesale.
15. **RI-60 pin Node** — the next reader running from a login shell sees 21 failures that
    look exactly like a broken implementation.
16. **RI-64 add a linter or delete the root `lint` script** — a lint leg that silently
    passes is worse than an absent one.
17. **RI-55 exercise the compose volume adoption locally** — cheap with a throwaway volume,
    and the alternative is discovering it on a host holding data.
18. **RI-35 `gofmt -w` the three files** — a standing false signal every task since T16 has
    had to explain away.
19. **RI-37 settle `--json`** — an option declared on all eight commands and read by none is
    a lie in the option table either way it is resolved.
20. **RI-63 clean up `CleanupService`'s unused fields and its documented knob** — an
    operator is currently tuning the frequency of two debug lines.
21. **RI-20 delete the `GetEnvelopeBatch` pass-throughs · RI-21 the `HasMore` false positive ·
    RI-32 make the drain timeout configurable · RI-67 catalogue the test timeouts ·
    RI-69 fail the TLS e2e instead of degrading** — five small, independent, low-risk tidies
    that share one review.

### FIX WITH CARE — 15 items

Each touches the wire, a stored-key schema, a documented contract, or a security boundary,
so each needs a design step before any code.

- **RI-01** enforcing storage needs a new refusal on the send route, and a flat cap turns a
  delay attack into a send-refusal attack against legitimate senders — the fairness rule is
  the design question.
- **RI-02** authenticating device-record publication changes a v1 route's preconditions and
  both sides of the wire, and is the only change that alters the flooding class rather than
  its price.
- **RI-05** removing the O(N²) occupancy scan needs a counter or an index, and a counter
  reintroduces the drift the live scan was deliberately chosen to avoid.
- **RI-06** deleting ordering-index entries eagerly needs a reverse mapping, which doubles
  the per-envelope key count — a storage-schema decision, not a bug fix.
- **RI-24** tightening `size_bytes` must land on both sides at once, because the relay and
  the client are kept in strict agreement on this envelope.
- **RI-25** collapsing the two 403 codes closes an identity oracle but costs the operator
  the distinguishable precondition T50-F-002 was raised to restore.
- **RI-26** binding `message_id` and the recipient fields needs a `:v2` transcript in two
  languages, and a client built before it cannot send to a relay built after it.
- **RI-27** folding the resume cursor into the signed challenge is the same transcript
  change and should ride with RI-26 rather than be paid twice.
- **RI-29** guaranteeing no handler outlives the store needs a counting middleware and gives
  `router.NewRouter` a lifecycle it does not have.
- **RI-36** a rotate command is the ninth entry point the specification froze the surface
  against, so the frozen-surface decision must be reopened deliberately, not incidentally.
- **RI-38** taking plaintext off `argv` changes `send`'s interface or adds a ninth command —
  the same frozen decision.
- **RI-39** listing pinned contacts in the TUI needs either that ninth command or the
  console holding the store key, which is precisely what AC5 forbids.
- **RI-40** surfacing `INVALID_RELAY_RESPONSE` adds a code to the documented failure table
  and to `reportedRelayCodes` on both sides.
- **RI-42** giving the residual error bucket its own exit code changes the documented exit
  contract that every runbook step asserts against.
- **RI-45** admitting `[::ffff:127.0.0.1]` widens what plain HTTP may reach, which is a
  security boundary; the comment-only half needs no design and can go with RI-46.

### RECORD PERMANENTLY — 14 items

- **RI-03** (first-walk latency), **RI-07** (last page unreported), **RI-08** (16 slots per
  pinned contact), **RI-13** (cursor after a crash), **RI-17** (import amplification),
  **RI-28** (position cursor skip/repeat), **RI-33** (exit 1 on a failing store close),
  **RI-41** (poll discards `rejected[]`) — each is a **deliberate design trade-off** whose
  alternative was considered and rejected on the merits, with the reason already in the
  source or the design document.
- **RI-14** (unserialised concurrent same-profile polls) and **RI-15**
  (`finishMailboxRewalk` speculative call) — **out of scope**: neither is reachable through
  a supported use of this prototype.
- **RI-12** and **RI-65** — **deliberate coverage bounds**, accepted for cost with the
  reasoning recorded; RI-12 carries the extra note that the 32-configuration sweep exists
  only in a report, not in the repository.
- **RI-56** (mobile, audit, pilot, libsignal pin) and **RI-70** (AC4/AC7) — **out of scope
  for a computer CLI prototype**, and RI-70 additionally blocked on a decision outside this
  repository.
- **RI-66** (vitest birpc ceiling), **RI-68** (Node's single-cert PEM read) and **RI-72**
  (tailnet-only, no mTLS) — **environment and upstream facts**; the first two have no lever
  available here and the third is a stated design position.
- **RI-49** (RED tests in the fix's commit) — a **process rule for the next flow**, not a
  change to this tree.

### STALE — 12 items, with where to delete each

| id | delete from |
|---|---|
| RI-04 | T5 design §1.3 / T5-F-002's premise about sender-chosen ordering — superseded by the `mailboxseq` index; no shipped document asserts it |
| RI-11 | `STATUS_CURRENT.md` and README already state the re-walk as crash-safe; nothing to delete, but T10-F-001/T14-F-002/T7-F-003 should not be re-inherited by flow 003 |
| RI-16 | already corrected in place at `apps/cli/test/e2e/flood-closure.test.ts:805` |
| RI-18 | **the dispatch's own known-items list** — no shipped document asserts it; do not carry it forward |
| RI-43 | closed in `apps/cli/src/runtime/config.ts`; no document asserts it |
| RI-44 | `docs/STATUS_CURRENT.md:80` — the parenthetical listing the flow 002 residuals should drop the loopback-disagreement half of T10R3-F-003 |
| RI-50 | T56 §9.1 item 1 — all three named sites were corrected |
| RI-51 | T56 §8.1.4 — the documentation debt is closed; `STATUS_CURRENT.md:106` already says so |
| RI-52 | **`docs/requirements/echolet-cli-prototype/deployment-runbook.md:580-582` and `:857-859`** — the only place in the tree where a document contradicts the code |
| RI-53 | T56 §9.4 — `flow.json` now reports T49 and T52 as `done` |
| RI-58 | **`docs/STATUS_CURRENT.md:77`** (the clause «освобождение бюджета байт для первого конверта переживает удаление») and T56 §8.1.6's MG3 sentence — the mutation is killed, demonstrated above |
| RI-59 | **`docs/STATUS_CURRENT.md:77`** (the clause «Курсорный путь `GetEnvelopeBatchFrom` … не имеет теста репозитория с непустым курсором») and T56 §8.1.6 — `mailbox_ordering_test.go:306` calls it with a non-empty cursor |

`docs/STATUS_CURRENT.md:77` therefore loses two of its four clauses and keeps the other
two (mobile signing unobservable → RI-57, still open; four fix areas never mutation-tested
→ RI-65, still open).

---

## 4. Routing audit

`graph_used`: **no** — not-relevant. Every source path was named by the dispatch, and every
code check was an exact `file:line` read or a targeted symbol search; there was no
navigation question for the graph to answer.

`wiki_used`: **no** — not-relevant. This is a disposition-verification pass, not an
architecture question; the design record for both flows lives inside the flow packages,
which were read directly.

`ctx_used`: **yes** — `keryx ctx run`, `keryx ctx read` and `keryx ctx rg` throughout, with
raw logs retained under `.metaproject/data/gdctx/`.

`raw_rg_used`: **no** — every text and symbol search over project code went through
`keryx ctx rg`. Two structured extractions ran through `keryx ctx run`: a `jq` sweep over
this flow's sibling `dispatches/*-result.json` artifacts (JSON, not project code) and a
`grep -n` outline of four named Go and TypeScript files, both routed.

**Mutation experiment.** The single mutation (RI-58) was applied to a `cp -R` copy of
`apps/relay` in the session scratchpad, never to the tree. `git status --porcelain` before
this pass reported only this flow's own untracked directory.

**Concurrent writer.** By the end of the pass `git status` also showed flow 002's
`flow.json` and `journal.md` modified and a new `t11-tls-report.md` untracked. Those are not
mine — this pass wrote only `t1-residual-inventory.md` and
`dispatches/003-T1-inventory-result.json`. §2.8 records what the concurrent write was and
why it is not endorsed here.
