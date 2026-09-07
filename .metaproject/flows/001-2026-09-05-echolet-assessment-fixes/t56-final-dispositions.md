# T56 — Consolidated finding dispositions for flow 001 (input to T38 / T29)

Produced by an independent `review-verifier` that wrote none of this code and none of
these reviews. Sources: the T28 consolidated findings, the round-1 and round-2 fix
reviews and the round-1 independent verifier report, all 44 dispatch results, the
T27/T37/T42/T44/T49/T52 verification and diagnosis reports, `journal.md` and
`tasks.md` — plus targeted reads of the current source at `file:line` for the
consequential closures. No test suite was run and nothing was built by this pass;
re-measurement is the running-mate agent's job.

## How to read this table

**Disposition vocabulary.** `fixed`, `partially-fixed`, `not-fixed`,
`documented-limitation`, `unverifiable` — plus **`accepted`**, used wherever the
flow deliberately decided *not* to fix something. An `accepted` row always carries
the reason. Nothing deliberately accepted is recorded as `fixed`.

**"Blocks acceptance"** means: does this item, as it stands today, prevent T38 from
being closed as clean under the flow's own standing instruction to close every
blocker/major finding? A `yes` is not a claim that the prototype is unusable; it is
a claim that a human decision is still owed.

**Evidence** cites the current tree where a closure was spot-checked at source, and
the artifact where it was not. Assertions taken only from a report's prose are
marked as such.

---

## 1. The original twelve (review `2026-09-06-path-echolet-cli-prototype-t28`)

| id | sev | origin | disposition | evidence | blocks |
|---|---|---|---|---|---|
| F-001 | major | T28 review-logic | **fixed** | Durable publication record `cli:publication` at `apps/cli/src/runtime/profile.ts:26`, schema at `:45`; `apps/cli/src/runtime/outbound.ts:34` resubmits `profile.publicationBundle()` unchanged; fresh allocation moved to `outbound.ts:36 rotateBundle()` → `packages/session-node/src/SignalClient.ts:266 rotateOneTimePreKey()`. Round-1 verifier attacked this closure adversarially; it did not break. | no |
| F-002 | major | T28 review-logic | **fixed** | `apps/cli/src/commands/cli.ts:235 readConfirmation()` settles on the first terminator/EOF/over-length answer, then removes listeners and unrefs stdin (T33-N3 concern acted on). | no |
| F-003 | major | T28 review-logic | **fixed** | Typed `PersistenceError` exported from `apps/cli/src/runtime/profile.ts`, consumed at `apps/cli/src/runtime/inbound.ts:55` and `:79` and `apps/cli/src/commands/cli.ts:8`. Discrimination is by ORIGIN (`Object.is` identity rethrow), not by message, so a domain error cannot be swallowed as `PERSISTENCE_FAILURE`. Recorded `unverifiable` at T28; T33's RED suite made it deterministically reproducible, and the round-1 verifier checked it in both directions. | no |
| F-004 | blocker | T28 review-backend | **fixed** | `apps/relay/internal/model/mailbox_envelope.go:8 ErrEnvelopeIDConflict`; returned after an in-transaction `txn.Get` at `apps/relay/internal/storage/repository/mailbox_repo.go:79`; mapped to HTTP 409 `ENVELOPE_ID_CONFLICT` at `apps/relay/internal/api/handler/mailbox_handler.go:138-145`. The T54 quota deliberately exempts an already-stored `(mailbox, envelope_id)` pair (`mailbox_handler.go:308-310`) so F-004's byte-identical retry is preserved. | no |
| F-005 | major | T28 review-backend | **fixed** | `mailbox_repo.go:28,35,43` carry a configurable `retentionCap`; expired records are skipped before either the count or the byte bound is consumed. Regression `TestGetEnvelopeBatchFiltersExpiredBeforeApplyingBatchLimit` at `mailbox_repo_test.go:165` is anchored to the production caller. Cursor-path coverage residue is tracked separately as T49-F-002. | no |
| F-006 | blocker | T28 review-backend + review-security-code | **fixed** | `apps/relay/internal/api/handler/request_body.go:42-43 decodeJSONRequest` wraps `http.MaxBytesReader` at every v1 decoder (`mailbox_handler.go:92,341,402`, `prekey_bundle_handler.go:28`, `device_record_handler.go:38`, `signal_prekey_bundle_v2.go:31`). `apps/relay/internal/validation/validate.go:193-201` now measures the real `len(envelope.Ciphertext)` and rejects `size_bytes != actual`. The identifier-string half of the suggested fix was NOT part of this closure — see BE-R-001 / R2-002 / T48-004. | no |
| F-007 | blocker | T28 review-security-code | **fixed** | `GetByDeviceID` is gone from production code (the name survives only in a historical comment at `mailbox_device_authorization_test.go:17`). Authorization resolves the immutable `device_mailbox:<mailbox_id>:<device_id>` binding: prefix at `device_record_repo.go:26`, `GetByMailboxAndDevice` at `:85`, first-writer-wins `SaveDeviceMailboxBinding` whose key and value are both pure functions of one identity, so a foreign identity is structurally unable to bind the slot. | no |
| F-008 | blocker | T28 review-highload + review-logic | **fixed** | `apps/cli/src/runtime/outbound.ts:71` re-reads the outbox with `tx.get(keyFor(input.messageId))` as the first action inside the mutation transaction; the outer lookup is retained only as an optimisation. T33 ran the mandatory anti-vacuity check (neutralise only the in-transaction recheck → test red again on the original three assertions). Round-1 verifier traced cross-process serialisation to `BEGIN IMMEDIATE` with `busy_timeout=0`, so the in-process barrier is not load-bearing. Recorded `unverifiable` at T28. | no |
| F-009 | major | T28 review-highload | **fixed** (round 1 recorded it `fixed-with-new-risk`; both risks are tracked below) | `apps/relay/internal/service/mailbox_service.go:26 GetEnvelopeBatch(limit, byteBudget)`; budget constant `pollEnvelopeByteBudget` at `mailbox_handler.go:65`; single-max-size envelope always delivered. New risks split out as HL-N-002 (**fixed**) and HL-N-003 (**open**). | no |
| F-010 | major | T28 review-highload | **fixed** | `apps/relay/internal/middleware/rate_limit.go:66-85`: the quota decision is taken in `allow()` under the lock and the lock is released before `next.ServeHTTP`; `allow()` performs no I/O. | no |
| F-011 | major | T28 review-highload | **fixed** | Same file: `quotaKey` normalises via `net.SplitHostPort` (port never part of the key), client-supplied forwarding headers are deliberately never consulted, `pruneLocked` reclaims elapsed buckets on a bounded interval, and `SetClock`/`TrackedClients` exist as deterministic test seams. | no |
| F-012 | minor | T28 review-testing-practices | **fixed** | Explicit guard at `apps/cli/src/runtime/inbound.ts:163` (`if (!contactBytes) throw new InboundError("CONTACT_NOT_TRUSTED")`). T36 killed the mutant AND ran the control (original test file passes 1/1 under the same mutation). Round-1 testing-practices independently reproduced it: MC7 red with the exact recorded message, MC8 (pre-T36 assertion restored) green. | no |

## 2. The thirteenth, found by verification

| id | sev | origin | disposition | evidence | blocks |
|---|---|---|---|---|---|
| F-013 | blocker | T37 verification attempt 1 (not by any reviewer) | **fixed** | `apps/cli/src/commands/cli.ts:133 inlineStringOptionValues`, applied at `:149`; `parseArgs` keeps `strict:true` and the option set is derived from the `cliOptions` table so it cannot drift. Closed by binary probe, not only by suite: T37 12-row probe + 16/16 pinning tests, re-confirmed by a 15-case probe at T42 (`f013_regression` PASS). The RED suite deliberately contained six PASSING guards so that relaxing strict parsing could not satisfy it. | no |

## 3. Round-1 fix review (`2026-09-06-fixreview-echolet-cli-prototype-t38`)

Round 1 returned APPROVE_WITH_SUGGESTIONS; every finding carried
`blocking_merge: false`. The independent verifier checked 10 findings: **confirmed
10, refuted 0, unverifiable 0** (8 by execution, 2 by site-check).

| id | sev | origin | disposition | evidence | blocks |
|---|---|---|---|---|---|
| HL-N-001 | major (pre-existing, not introduced by the wave) | round-1 review-highload | **fixed** | Per-envelope acceptance in its own transaction at `apps/cli/src/runtime/inbound.ts:136-152`; permanent-verdict vs retriable split at `:52 isNotAnEnvelopeVerdict`; bounded page walk at `:71,113-122`. Round 2 recorded it `partially-fixed` before T47/T48; T42 attempt 2 then declared the class "closed end to end" against the real binary. Its residual availability class lives on as T49-F-001 and is NOT covered by this row. | no |
| HL-N-002 | minor | round-1 review-highload | **fixed** | `inbound.ts:118 more = batch.next_cursor !== null`, surfaced to the operator through `PollResult.more` (documented at `inbound.ts:28-32`). | no |
| HL-N-003 (= T35-I-001, = round-1 security R-005) | minor | round-1 review-highload / T35 implementer | **not-fixed — documented-limitation, OPEN** | `apps/relay/internal/api/handler/mailbox_handler.go:60-65`: `pollEnvelopeByteBudget` is still the compile-time constant `(1<<20) - 4 KiB`, with no enforced relation to `h.maxMessageBytes`. Measured by the round-1 verifier: with `maxMessageBytes` at 2 MiB the relay returned a 2,097,781-byte poll response — twice the client's hard bound — and nothing was acked. Unreachable at the default `ECHOLET_MAX_MESSAGE_BYTES=262144`. (Note: the *send-route* body limit WAS derived, at `mailbox_handler.go:82-87`; only the poll budget was not.) | no |
| BE-R-001 | minor | round-1 review-backend | **fixed for the reported route; class closed only in part** | `validation.MaxIdentifierBytes = 256` at `validate.go:106`, applied to envelope identifiers at `:175`. Verifier measured 70,000-byte `recipient_mailbox_id` and `envelope_id` both yielding HTTP 500 before; round 2 measured 400 `INVALID_SCHEMA` at 257 bytes and 200 at 256 after. The verifier also recorded the finding as **understated** (`envelope_id` had the same defect). Remaining class members: R2-002 (**fixed**), T48-004 (**open**). | no |
| BE-R-002 | minor | round-1 review-backend | **not-fixed, OPEN** | `apps/relay/internal/storage/repository/device_record_repo.go:152-158`: the backfill's per-record `r.db.Update` is still the only `device_mailbox` writer without the bounded conflict retry, and `return err` on the first failure still abandons every remaining record. Verifier measured it "stronger than reported": one undecodable record aborted the scan and 0 of 2 healthy records were bound. Verifier's own recommendation was to record it as a documented prototype limitation. | no |
| SEC-R-001 | minor | round-1 review-security-code | **fixed** (documentation only; no behaviour change) | The docstring in `apps/cli/src/commands/cli.ts` was corrected in round 2 to state the real semantics — a declared string option consumes a following flag-shaped token (standard GNU behaviour, test-pinned). The verifier confirmed the pre-fix `parseArgs` throw and the post-fix acceptance by probe, and corrected one over-precise sub-claim (the resulting exit code is whatever the downstream path yields, not unconditionally 0). | no |
| T38-TP-001 | minor | round-1 review-testing-practices | **fixed** | Barrier re-anchored to the semantic event via `idFactory('envelope')`; round-2 mutations R2-M1 (251 ms) and R2-M2 (296 ms) go red and R2-M3 fires five soft assertions. The verifier had reproduced the original defect: deleting `outbound.ts:44-46` left the test green in 215 ms. | no |
| T38-TP-002 | minor | round-1 review-testing-practices | **partially-fixed** | Three of four surviving gates closed. The fourth (`SetRetentionCap`) became T38r2-TP-001 and is now closed by `apps/relay/internal/storage/repository/mailbox_retention_cap_test.go:23`. **MG3 — the first-envelope byte-budget exemption at `mailbox_repo.go:190` — remains unpinned** (recorded by T41-N-003; no later task closed it). The verifier also found MC10 "worse than reported": with `strict:false` the entire apps/cli suite stayed green. | no |
| T38-TP-003 | minor | round-1 review-testing-practices | **fixed** | The always-true prefix scan was replaced by a scan against an exact expected set; round-2 mutations R2-M4 and R2-M15 kill it. | no |
| T38-TP-004 | info | round-1 review-testing-practices | **accepted — open by design** | Four fix areas (F-002, F-006, F-007, F-010/F-011) were assessed by reading only and never reached by the mutation pass. Round 2 explicitly restated this as still standing at `info`. Reason: mutation budget, not a defect claim. | no |
| T38-L-001 | minor | round-1 review-logic | **accepted — deliberate scope discipline; belongs in the T29 limitations, not in code** | Verified today: `keryx ctx rg "rotateBundle\|retryPending" apps/cli/src/commands/` returns **0 matches**; the capability exists at `apps/cli/src/runtime/outbound.ts:36` and `:121` but has no entry point in the frozen eight-command surface. T44-003 states the reason explicitly: "Do not add a ninth rotate command — that would break the frozen surface this flow is validating." This is the code-level half of the structural limitation in §6. | no |
| T38-L-002 | info | round-1 review-logic | **fixed** (closed together with SEC-R-001's docstring correction) | Same docstring; the behaviour was always intended. | no |
| T38-L-003 | info | round-1 review-logic | **accepted — by design** | Corruption of an already-readable persisted record still classifies as exit 3, not exit 5; F-003's boundary is store-machinery failure, not record content. | no |
| T38-L-004 | info | round-1 review-logic | **not-fixed, OPEN** | `--json` is declared and allowed on every command (`cli.ts:39`) and never read. | no |
| HL N-004 | info | round-1 review-highload | **not-fixed, OPEN** | The limiter's bucket map has no max-entry cap between prune sweeps and the sweep is O(len(clients)) under the shared lock (`rate_limit.go` `pruneLocked`). | no |
| HL N-005 | info | round-1 review-highload | **not-fixed, OPEN** | `HasMore` can be a false positive when every remaining item is expired (`mailbox_repo.go:170`). | no |
| BE R-003 | info | round-1 review-backend | **not-fixed, OPEN** | Verified today at `device_record_repo.go:128-148`: the backfill buffers every decoded record before any write and `return err`s on the first undecodable one, aborting the scan. Same root as BE-R-002. | no |
| BE R-004 | info | round-1 review-backend | **not-fixed, OPEN** | `envelopeBodyLimit()` defaults a non-positive max locally (`mailbox_handler.go:82-87`) but `:98` passes the raw `h.maxMessageBytes` to `ValidateMailboxEnvelope`. | no |
| BE R-005 | info | round-1 review-backend | **not-fixed, OPEN** | `size_bytes` is typed `z.number()` only in `packages/protocol/src/types/mailboxEnvelope.ts:17`; the requirements never mention the field. | no |
| SEC R-002 | info | round-1 review-security-code | **not-fixed, OPEN** | `ProfileError` maps to exit 5 inside `openProfile` at six call sites and exit 3 elsewhere; `classify`'s trailing `persistenceFailure()` makes 5 the residual bucket. | no |
| SEC R-003 | info | round-1 review-security-code | **not-fixed, OPEN** | A zero `maxMessageBytes` makes the route accept ~326 KiB of body and then reject every envelope. Not reachable at defaults. | no |
| SEC R-004 | info | round-1 review-security-code | **not-fixed, OPEN — later became load-bearing** | The `device_mailbox` key space is inflatable by anyone who can generate keypairs, bounded only by `RateLimitPerMinute` (default 120/min). This is the same root cause that T52-F-001 later measured as the reason sender authentication did not close the wedge. | no (as an info row; the harm is carried by T52-F-001) |
| SEC R-005 | info | round-1 review-security-code | duplicate of **HL-N-003** — see that row; **OPEN** | — | no |

## 4. Round-2 fix review (`2026-09-06-fixreview-round2-t38`)

Round 2 was effectively REQUEST_CHANGES: all three reviewers returned
`DONE_WITH_CONCERNS` and two findings carried `blocking_merge: true`. No independent
verifier ran in round 2.

| id | sev | origin | disposition | evidence | blocks |
|---|---|---|---|---|---|
| R2-001 | major (was blocking) | round-2 review-security-code | **fixed** | Shape parity at ingress: `apps/relay/internal/validation/validate.go` now enforces the client's own UUID rule via `clientMailboxUUID` (transcribed from the CLI's zod-4 `z.string().uuid()`), so a shape-invalid envelope is refused at `/v1/messages/send` and can never enter a poll response the client parses as one strict array. T49 measured 8/8 shape-invalid envelopes refused at ingress against the real relay binary. | no |
| R2-L-001 (same defect, path B) | major (was blocking) | round-2 review-logic | **fixed** | Server-issued resume cursor rather than head-of-prefix re-selection: `GetEnvelopeBatchFrom` in `mailbox_repo.go`, consumed at `mailbox_handler.go:455`, walked by the client at `inbound.ts:113-122`. T49 walked past 799 head-of-mailbox poison envelopes and delivered the legitimate one. The bounded-walk residue is T49-F-001, below. | no |
| R2-002 | minor | round-2 review-security-code | **fixed** | Verified today at two sites: `validate.go:30-37` bounds `identity_id` and `device_id` on `/v1/device-records/publish`; `mailbox_handler.go:525-536` bounds each `envelope_ids` element on `/v1/mailbox/ack`, with a comment naming round-2 finding R2-002. Third class member `bundle_id` is still unbounded — see T48-004. | no |
| R2-L-002 | minor | round-2 review-logic | **fixed** | Verified today at `apps/cli/src/commands/cli.ts:31-38`: the docstring now names all four conditions the relay reports as `PREKEY_BUNDLE_UNAVAILABLE`, not only the first. | no |
| R2-L-003 | minor | round-2 review-logic | **not-fixed, OPEN — this is T29's work** | Verified today: `keryx ctx rg "claimable" docs/` returns **0 matches**, and `docs/requirements/echolet-cli-prototype/specification.md` documents none of the poll result shape `{received, more, rejected[]}`, poll exiting 0 with rejections, `claimable`, or `PREKEY_BUNDLE_UNAVAILABLE`. Re-raised four times (T45-I-002 → T48-005 → T53-I-004) and never closed. | no |
| R2-L-004 | info | round-2 review-logic | **accepted — by design** | Verified today at `inbound.ts:127`: `if (received === 0 && firstRejection) throw firstRejection;` discards the `rejected` array and does not reach `ackPending()`. Reason recorded in the source comment at `:123-126`: this preserves the F-012 whole-batch contract, which is correct for a mailbox holding nothing acceptable. The operator's loss of "one envelope or fifty" detail is the accepted cost. | no |
| R2-L-005 | info | round-2 review-logic | **resolved** | Round-2 verdict, verbatim: "not a weakening". The changed fixture assertion was independently re-derived as a corrected artefact that *gains* an assertion. | no |
| R2-I-003 | info | round-2 review-security-code | **not-fixed, OPEN** | Requiring `claimable` means a CLI from this tree against a pre-T45 relay fails with `INVALID_RELAY_RESPONSE` → exit 3 `PROTOCOL_REJECTED`, which reads to an operator as "the relay rejected you". Same class as T42-I-001. | no |
| R2-I-004 | info (process) | round-2 review-security-code | **acted on** | Five files were shown to carry bumped mtimes with byte-identical content, so mtime is not a sound integrity signal in this tree. The orchestrator recorded the method correction in `journal.md` and every subsequent dispatch requires SHA-256. Prior conclusions stand because T37/T42/T49/T52 verified integrity by SHA-256 (57/57 at T49, 61/61 at T52). | no |
| R2-I-005 | info | round-2 review-security-code | **not-fixed, OPEN** | `claimable` is required by the CLI on every publish response and appears in neither `specification.md` nor `schemas/relay-v2.schema.json`. Confirmed today by the 0-match `docs/` search. Merges into R2-L-003 for T29. | no |
| T38r2-TP-001 | minor | round-2 review-testing-practices | **fixed** | `apps/relay/internal/storage/repository/mailbox_retention_cap_test.go:23 TestSetRetentionCapBoundsPhysicalRetention` now pins the configurability half of the F-005 cap; T47 recorded two `SetRetentionCap` mutations killing it. | no |

## 5. Verification and diagnosis findings

| id | sev | origin | disposition | evidence | blocks |
|---|---|---|---|---|---|
| T42-F-001 | high (gate-blocking) | T42 verification attempt 2 | **fixed — by mechanism, not by absence** | `apps/cli/vitest.config.ts` sets `testTimeout`/`hookTimeout` to 30_000 (T43). T42 attempt 3 recorded that the exact condition that turned attempt 2 red *did occur* five times across two runs (5164 / 5184 / 5280 / 5439 / 6743 ms under 24- and 48-worker load) and was absorbed. Residual headroom ≈4.4×. | no |
| T42-I-001 | info | T42 verification attempt 3 | **accepted — open observation, explicitly not a gate failure** | A malformed relay response is correctly refused but surfaces as generic `PROTOCOL_REJECTED` (exit 3) rather than a code naming a malformed relay response; `relayClient.ts`'s own `INVALID_RELAY_RESPONSE` is flattened because `reportedRelayCodes` enumerates relay-chosen codes only. T49 carried it forward unchanged and did not re-probe. Reason: no requirement names a code for this condition. | no |
| T44-001 | minor | T44 diagnosis | **fixed** | `apps/cli/src/transport/relayClient.ts` now carries `PREKEY_BUNDLE_UNAVAILABLE` in the allowlist and the dead v1-era `PREKEYS_EXHAUSTED` was removed. Closed at binary level in T42 attempt 3: a second distinct sender's `send` exits 3 with exactly the relay's own 25-character code, while a genuinely untrusted contact still yields `CONTACT_NOT_TRUSTED` — the control proving T45 did not over-correct. | no |
| T44-002 | minor | T44 diagnosis | **fixed** | Relay computes `claimable` (`apps/relay/internal/api/handler/signal_prekey_bundle_v2.go:83`, emitted at `:98`); the CLI requires it (`relayClient.ts:57 claimableSchema`, consumed in the strict success schema at `:80-81`). Binary probe: a re-publish after a claim returns exit 0 with `claimable=false` and the same bundle id, instead of bare success. T46 then made the field required rather than optional and a mutating proxy confirmed a response with it deleted is refused. | no |
| T44-003 | info | T44 diagnosis | **accepted — documented-limitation, and still undocumented** | The structural one-bundle-per-first-contact-sender limitation; see §6. Verified today at `apps/cli/src/commands/` (no `rotateBundle` entry point). T42 attempt 3: "unchanged by T45/T46; those tasks made the condition *legible*, not absent … It remains undocumented in `specification.md`." | no (but T29 must state it) |
| T49-F-001 | major | T49 verification | **partially-fixed — class OPEN** | Three successive attempts each raised the attacker's price and each declared the class not closed: T48's server cursor + 16-page walk, T51's sender authentication, T54's per-sender quota. The current source states the residue itself at `apps/relay/internal/api/handler/mailbox_handler.go:265-269` and pins it with a deliberately-green regression, `TestKnownResidueDistinctIdentitiesStillWedgeTheDrainWalk`. T52 verdict, verbatim: "**No. The wedge is not closed.**" | **yes** |
| T49-F-002 | minor | T49 verification | **not-fixed, OPEN** | Verified today: `GetEnvelopeBatchFrom` has three references in `apps/relay` and **none in any test file** — the cursor-aware path that serves every production poll still has no repository-level test with a non-empty cursor. The "expiry is skipped before the cursor is consumed" property is protected only by the source comment at `mailbox_repo.go:272-275`. | no |
| T49-I-001 | info | T49 verification | **accepted — bounded, no change required for the prototype gate** | The poll `cursor` is outside the signed challenge transcript, and a syntactically valid out-of-range position is answered with an empty final page rather than a bounded 4xx. Measured: 11 tampered tokens → 9× 400 `INVALID_SCHEMA`, 0× 5xx, 0 silent resets; server cursors ≤2 decimal digits, bounded at 15 digits server-side and 256 chars client-side. | no |
| T52-F-001 | major | T52 final verification | **partially-fixed — class OPEN** | Sender authentication is itself correct and complete (unsigned → 400; wrong-key → 403 `INVALID_SIGNATURE`; tampered → 403; unpublished sender → 403 `UNAUTHORIZED_MAILBOX_ACCESS`; all before storage — verified today at `mailbox_handler.go:113-129` and `:164-190`). The gap is upstream: **device-record publication is itself unauthenticated** — `device_record_handler.go:38` decodes the body and `ValidateDeviceRecord` verifies the record only against its own freshly generated identity key (`validate.go:44-47`), so an attacker mints a usable sender identity with one unauthenticated request. T54's quota raises the price; it does not remove the capability. | **yes** |
| T52-F-002 | info | T52 final verification | **accepted — deferred, fold into whatever decision addresses T52-F-001** | Confirms T51-F-003 by probe: resolving the sender via `DeriveMailboxID(sender_identity_id)` at `mailbox_handler.go:173` lets an unauthenticated caller distinguish a published identity (403 `INVALID_SIGNATURE`) from an unpublished one (403 `UNAUTHORIZED_MAILBOX_ACCESS`). Reason for deferral: collapsing the two codes would cost the operator the distinguishable precondition T50-F-002 restored, without removing the ordering signal. | no |

## 6. Worker-reported findings, notes and questions

| id | sev | origin | disposition | evidence | blocks |
|---|---|---|---|---|---|
| T33-I1 | minor | T33 implementer | **fixed** | Concurrent `dist/cli.js` rebuild race between `cli.test.ts` and `two-process.test.ts`. Closed by T36's single `globalSetup` build per vitest run (`apps/cli/vitest.config.ts`, `apps/cli/test/globalSetup.ts`). T37 confirmed neither the race nor its symptom recurred. Note the recorded attribution correction: the intermittent `INVALID_ARGUMENTS` symptom was actually F-013, not this race. | no |
| T33-I2 | info | T33 implementer | **accepted** — rotation deliberately retains superseded `pre:<n>` records so in-flight PreKey sessions still resolve; add a retention policy only if rotation becomes routine | disposed as acceptable in T38 wave A | no |
| T33-I3 | info | T33 implementer | **accepted** — "leave as is unless the spec requires a separate code" for nested-transaction / store-closed cases mapping to `PersistenceError` | disposed in T38 wave A | no |
| T33-I4 (= T33-N1) | info | T33 implementer / tests-creator | **accepted** — the F-008 barrier stays test-only instrumentation, no production seam added | Round-1 wave A traced cross-process serialisation to `BEGIN IMMEDIATE` + `busy_timeout=0` and confirmed it with a two-process probe, so the in-process barrier is not load-bearing | no |
| T33-N2 | info | T33 tests-creator | **resolved** — `rotateBundle()` adopted as the public name | T33 implementer | no |
| T33-N3 | info | T33 tests-creator | **fixed** — stdin released/unrefed, not merely read | `cli.ts:235` | no |
| T33-N4 | info | T33 tests-creator | **superseded** by T36's shared build | — | no |
| T39-Q1 | info | T39 test author (question) | **accepted — "adequate"** | A fully successful send to a real identity whose base64url begins with `-` cannot be built deterministically, because `identity_id` derives from a generated key. Disposed as acceptable with reason in T38 wave A. | no |
| T34-I-001 | major | T34 implementer | **accepted as-is, with a residual gap** | T38 wave A reversed the orchestrator's own expectation and accepted it: mis-binding is not representable (key and value are both pure functions of one identity, so every writer of a key writes byte-identical bytes), and the ABSENCE of a completion marker is what lets a transient failure self-heal. **Residual:** no verifier ever confirmed the startup re-scan cost, so that half of the concern is unanswered. | no |
| T34-I-002 | minor | T34 implementer | **fixed** | Hand-chosen body limits replaced by a derivation at `mailbox_handler.go:82-87` (`maxMessageBytes + envelopeJSONOverheadBytes`). | no |
| T34-I-003 | minor | T34 implementer | **fixed** (code); documentation call-out folded into T29 | `validate.go:200` rejects `size_bytes != len(ciphertext)` — a stricter contract than before, matching the CLI, still not written down normatively. | no |
| T34-I-004 | info | T34 implementer | **accepted — "nothing to change"** | Only reachable by bypassing the handler. | no |
| T34-N-001…004 | info ×4 | T34 tests-creator | **all acted on or accepted** | N-002's two-argument signature honoured; N-003's boundedness assertion refined into per-route limits; N-004 resolved as recommended (`INVALID_SCHEMA`); N-001's direct-Badger seeding accepted, key layout kept. | no |
| T35-I-001 | minor | T35 implementer | see **HL-N-003** — **OPEN** | — | no |
| T35-Q-001 | question | T35 tests-creator | **answered — accepted** | The pinned poll wire contract (request `batch_size`, `next_cursor` widened to a closed `string\|null` union on a `.strict()` object) was approved by the orchestrator with the explicit condition that the schema be widened without being weakened; T48 later redefined `next_cursor` as a server-issued resume position. | no |
| T40-N-001 | major | task **T41** (implement), artifact `001-T40-implement-result.json` | **fixed** | An assertion at `inbound.batchIsolation.test.ts:325` was unsatisfiable by any implementation. The implementer **reported it rather than modifying the test**; the test author repaired it in a separate follow-up dispatch at `:330`, pinning the set of acked ids. `inbound.ts` verified byte-identical afterwards. | no |
| T41-N-001 | minor | task **T40** (test), artifact `001-T41-tests-result.json` | **fixed / acted on** | The existing F-012 whole-store assertion ruled out one of two possible HL-N-001 remediations; T41 implemented the prescribed per-envelope acceptance with an aggregated `rejected` list. | no |
| T41-N-002 | minor | task T40 | **fixed / acted on** | `PollResult` `{received, more, rejected[{envelopeId, code}]}` became the stdout contract; exit contract unchanged. | no |
| T41-N-003 | info | task T40 | **partially-fixed** | MG6 (`SetRetentionCap`) closed by T47 as T38r2-TP-001. **MG3 — the first-envelope byte-budget exemption at `mailbox_repo.go:190` — is still unpinned.** | no |
| T41-N-004 | info | task T40 | **fixed** — artifact carries `disposition: acted-on`; assertion repaired, mutations reverted, `inbound.ts` byte-identical | — | no |
| T43-N-001 | info | T43 tests-creator | **not-fixed — accepted, and stated as probably unfixable** | Above ~30× CPU oversubscription vitest's worker→main birpc `onTaskUpdate` hits its hardcoded 60 s ceiling (`DEFAULT_TIMEOUT = 6e4` in vitest 3.0.8) and a whole file's results are discarded — no test times out. There is no config lever. Recorded 0 occurrences at T42/T49/T52, where load was deliberately held to 1.6×–4.8×. | no |
| T43-N-002 | info | T43 tests-creator | **accepted — deliberately deferred** | Two incompatible timeout mechanisms coexist: a 30_000 ms config default plus 47 per-test third-argument timeouts across 7 files at 5 magnitudes, with nothing recording which are load-bearing. Reason: "do not do this as part of a gate-unblocking fix". Packages other than `apps/cli` still run on vitest's 5000 ms default. | no |
| T45-I-001 | info | T45 implementer | **fixed by T46** | `claimable` promoted from `z.boolean().optional()` to required `z.boolean()`; the five stubs that forced the compromise were updated by T46's test author first. | no |
| T45-I-002 | info | T45 implementer | **not-fixed, OPEN — documentation debt** | Merges into R2-L-003 / R2-I-005 / T48-005 / T53-I-004 for T29. | no |
| T45-I-003 | info | T45 implementer | **accepted — environment caveat, no permanent pin added** | See §8. Verified today: `apps/cli/package.json` declares `"engines": {"node": ">=22.13"}`; the machine's current `node --version` is v26.5.0. | no |
| T45-N-001…003 | info ×3 | T45 tests-creator | **all acted on** | N-001 anticipated the relay-side `claimable` field, which T45 added; N-002's `/PREKEY/` regex was superseded by the literal relay code; N-003's dead `PREKEYS_EXHAUSTED` entry was removed. | no |
| T46-I-001 | info | T46 implementer | **closed — no change needed** | The dead conditional T46-N-002 anticipated does not exist; `cli.ts` never names `claimable`. Pinning the exact `relay publish` stdout shape would declare a wider contract and was left open. | no |
| T46-N-001…003 | info ×3 | T46 tests-creator | **all acted on / discharged** | N-001's single-edit risk handled by rewriting the justifying comment in the same change; N-002 checked and refuted (→ T46-I-001); N-003's "reasoned not executed" caveat discharged by T46's 18-file / 92-test green run. | no |
| T47-TP-001 | minor | T47 tests-creator | **fixed — acted on the harder way** | The fixture modelled a relay that resumes at the undelivered set, while production re-selected from the head of the prefix; a purely client-side fix would have passed the test and left path B open. T48 implemented a server-issued resume position instead, and observed the predicted head-of-prefix re-selection on the real binary before changing it. | no |
| T47-TP-002 | info | T47 tests-creator | **accepted — "no action; recorded so the choice is visible"** | Path A is pinned only on the relay side. | no |
| T48-001 | info | T48 implementer | **not-fixed, OPEN — cleanup** | Verified today at `mailbox_repo.go:272-275`: the 3-argument `GetEnvelopeBatch` survives as a delegation to `GetEnvelopeBatchFrom(..., "")` because an un-editable test called the old form. | no |
| T48-002 | minor | T48 implementer | **accepted — "none required"** | A *position* cursor is not immune to concurrent mutation: an ack or expiry between pages shifts every later position, so an envelope can be skipped or repeated. A key cursor was ruled out because the key's second half is the sender-supplied `envelope_id` — the F-009 constraint. T49 partly corroborated (an out-of-range position returns an empty page). | no |
| T48-003 | minor | T48 implementer | **escalated — became T49-F-001; OPEN** | `maxPollPagesPerPoll = 16` bounds how much of a flooded mailbox one `poll()` consults. | see T49-F-001 |
| T48-004 | info | T48 implementer | **not-fixed, OPEN** | Verified today: `apps/relay/internal/validation/validate.go` contains **no length bound on `bundle_id`**. It is the third member of the R2-002 unbounded-identifier class and was left alone because no RED test covered it. | no |
| T48-005 | info | T48 implementer | **not-fixed, OPEN — documentation debt** | Adds the poll request `cursor` field and the changed meaning of `next_cursor` to the R2-L-003 list. | no |
| T50-D-001 | design decision (not a finding) | T50 tests-creator | **implemented verbatim** | The versioned `echolet-mailbox-envelope:v1:` transcript over seven named fields, ed25519, base64url, carried as `sender_signature`; optional on the still-`.strict()` client schema, required by the relay. Implemented in both languages by T51; the CLI side is visible at `apps/cli/src/runtime/outbound.ts:80-85`. | no |
| T50-F-001 | minor | T50 tests-creator | **fixed** (mobile now signs) — but see T51-F-002 for the observability half | — | no |
| T50-F-002 | minor | T50 tests-creator | **partially-fixed** | Code half fixed via option (a): `UNAUTHORIZED_MAILBOX_ACCESS` added to `reportedRelayCodes`, confirmed by T52 probe and visible in the docstring at `cli.ts:40-45`. **Documentation half open:** `send` now presupposes `relay publish`, and that precondition is not stated in `specification.md`. | no |
| T50-I-001 | info | T50 tests-creator | **honoured** | The presence/length check lives in `MailboxHandler.SendEnvelope` (`mailbox_handler.go:164-176`), not in `ValidateMailboxEnvelope`, because three `internal/validation` tests call the latter with unsigned envelopes. The same trap was re-flagged for the quota as T53-I-002 and honoured again. | no |
| T50-I-002 | info | T50 tests-creator | **accepted as pinned** | `message_id`, `recipient_identity_id` and `recipient_device_id` are deliberately outside the v1 transcript so one transcript reproduces byte-for-byte in two languages. Carried forward as T51-F-004. | no |
| T51-F-001 | minor | T51 implementer | **accepted as-is** | Adding `UNAUTHORIZED_MAILBOX_ACCESS` to `reportedRelayCodes` also changes reporting for 403s from challenge/poll/ack — wider than asked. Reason: narrowing "buys nothing measurable, so it was not taken". | no |
| T51-F-002 | minor | T51 implementer | **not-fixed, OPEN** | The mobile demo signs, but nothing in `apps/mobile` can observe *whether it signs correctly*: its 6 tests never reach `sendMessage`, and `sender_signature` is optional on the client schema so tsc cannot catch a wrong transcript. Deliberately out of the implementer's mandate; no later task added the test. | no |
| T51-F-003 | info | T51 implementer | **accepted — "leave as is"**; confirmed by probe as T52-F-002 | `mailbox_handler.go:173` | no |
| T51-F-004 | info | T51 implementer | **accepted — deferred** | An on-path attacker can rewrite `message_id` and the two recipient fields without invalidating the sender signature; a `:v2` transcript is deferred to a later round. | no |
| T53-F-001 | major | T53 tests-creator | **not-fixed, OPEN — restated as T54-F-001** | "Do not present the quota as a fix for the class." The deliberately-green residue test `TestKnownResidueDistinctIdentitiesStillWedgeTheDrainWalk` is kept in place as the standing record. | **yes** (same class as T49-F-001 / T52-F-001) |
| T53-I-001 | info | T53 tests-creator | **fixed / acted on** | 429 would have been the wrong status: `relayClient.ts` marks it retryable and `classify()` maps retryable to exit 4 without consulting `remoteCode`. T54 chose 403 `SENDER_QUOTA_EXCEEDED`, non-retryable — verified today at `mailbox_handler.go:311-317` with the reasoning recorded at `:287-293`. | no |
| T53-I-002 | info | T53 tests-creator | **fixed / honoured** | Both placement constraints implemented: the check runs in `SendEnvelope` after `authenticateSender` (`mailbox_handler.go:129-135`), and an envelope already stored under this `(mailbox, envelope_id)` pair is exempt (`:308-310`) so F-004's byte-identical replay does not break at quota. | no |
| T53-I-003 | info | T53 tests-creator | **partially-fixed** | The live-scan requirement was honoured (`SenderOccupancy` counts live envelopes, never a counter — reasoning recorded at `mailbox_handler.go:274-281`). The per-send scan-cost concern persists as T54-F-002. | no |
| T53-I-004 | info | T53 tests-creator | **partially-fixed** | Configurability delivered: `ECHOLET_MAX_UNACKED_ENVELOPES_PER_SENDER` (default 16) at `apps/relay/internal/config/config.go:24`, wired at `apps/relay/internal/api/router/router.go:54`, documented in `docs/API-11_JSON_SCHEMAS.md`. **The `specification.md` failure-behaviour entry for `SENDER_QUOTA_EXCEEDED` is still open** — same debt as R2-L-003. | no |
| T54-F-001 | major | T54 implementer | **not-fixed, OPEN — the terminal open item of the flow** | The shipped quota bounds one *sender*, not mailbox occupancy, and identity creation remains free, so the attacker's price rises from 1 identity to about 3 (byte-bounded regime) or 50 (count-bounded) **and no further**. The source states this itself at `mailbox_handler.go:265-269` and keeps `TestKnownResidueDistinctIdentitiesStillWedgeTheDrainWalk` green as the standing record. | **yes** |
| T54-F-002 | minor | T54 implementer | **accepted — "measure before changing"** | `SenderOccupancy` walks the mailbox key prefix; the count stops at the quota and an already-stored id short-circuits, but the iterator still walks past expired and other-sender records, so per-send cost is O(quota) plus a residual term. The same prefix scan already backs every poll. | no |
| T54-F-003 | info | T54 implementer | **accepted — "leave the default alone"; cross-field config check deferred** | The quota's correct value is coupled to `ECHOLET_MAX_MAILBOX_BATCH` and `ECHOLET_MAX_MESSAGE_BYTES` and nothing enforces the coupling (16 was chosen because the client's 16-page walk covers 48 max-size envelopes at current defaults). Same family as the still-open HL-N-003. | no |

### Ids in the artifacts that are not findings

`MC1`–`MC15` are mutation-case labels in the T28 review's `mutation-evidence.json`
and the round-1 testing-practices reports; `R2-M1`–`R2-M17` are their round-2
counterparts. They are evidence records, not findings, and carry no disposition.
`MC10` is referenced in `tasks.md` as a coverage *gap* fed into T40 — that gap is
covered by the T38-TP-002 row.

---

## 7. Counts

110 rows. Three grouped rows (`T34-N-001…004`, `T45-N-001…003`,
`T46-N-001…003`) each cover several ids under one disposition; three rows
(`SEC R-005`, `T35-I-001`, `T48-003`) are cross-references to a row that carries
the disposition and are counted separately below.

| disposition | count | of which still open |
|---|---|---|
| fixed | 51 | — |
| partially-fixed | 7 | 7 — T38-TP-002, T49-F-001, T52-F-001, T41-N-003, T50-F-002, T53-I-003, T53-I-004 |
| accepted (deliberate, reason recorded) | 26 | 26, by decision rather than by omission |
| not-fixed / open | 21 | 21 |
| documented-limitation (open, stated as such) | 2 | 2 — HL-N-003, T44-003 |
| unverifiable | 0 | — |
| cross-reference to another row | 3 | — |

Blocking acceptance: **4 rows, one defect class** — T49-F-001, T52-F-001,
T53-F-001, T54-F-001. Nothing else in the record is open at blocker or major
severity. No finding in this flow was ever refuted.

---

## 8. What T29's status document and change report must state

### 8.1 Limitations still open, with measured cost where one exists

1. **Mailbox flooding is bounded, not eliminated.** (T49-F-001 → T52-F-001 →
   T53-F-001 → T54-F-001.) State it in those words. Three remediation rounds each
   raised the attacker's price and each declared the class not closed:
   - T48 gave the client a bounded 16-page drain walk over a server-issued cursor.
     T49 then measured the residue against the real relay binary at default
     configuration: **49 maximum-size envelopes (~12.8 MB, under 30 s, inside the
     120 requests/minute limit) or 800 minimum-size envelopes (~0.7 MB, under
     7 minutes)** wedge a victim's mailbox for up to the **168 h** retention cap.
     The only precondition is the victim's `recipient_mailbox_id`, a digest of the
     identity id printed in their own contact card. Three further polls reproduced
     it identically with history 0 and acks 0.
   - T51 added sender authentication. T52 proved the wedge survived at *exactly*
     those thresholds, because device-record publication is itself unauthenticated:
     one self-signed `POST /v1/device-records/publish` (HTTP 200, one-time and
     reusable across every victim) buys an authenticated sender identity.
   - T54 added a per-sender unacked-envelope quota (default 16). The source records
     the effect honestly: the price rises **from 1 identity to about 3 in the
     byte-bounded regime and 50 in the count-bounded one — a linear price increase,
     not a structural fix.**

   **Row for the change report, with the number left for the running-mate agent's
   re-measurement:**

   | property | value |
   |---|---|
   | status | **bounded, not closed** |
   | current attacker cost, byte-bounded regime | ~`__` self-published identities + ~`__` max-size envelopes (~`__` MB) — *re-measured by the T55 running-mate; the T54 source estimate is 3 identities + 49 envelopes ≈ 12.8 MB* |
   | current attacker cost, count-bounded regime | ~`__` self-published identities + ~`__` min-size envelopes — *T54 source estimate: 50 identities + 800 envelopes ≈ 0.7 MB* |
   | duration of the wedge | up to the 168 h retention cap |
   | root enabler, still open | unauthenticated device-record publication (`apps/relay/internal/api/handler/device_record_handler.go:38`, `apps/relay/internal/validation/validate.go:44-47`) |
   | standing regression that records the residue | `TestKnownResidueDistinctIdentitiesStillWedgeTheDrainWalk` |

   Do not write "fixed", "closed", "mitigated" or "hardened" without the bound
   beside it.

2. **One published bundle serves exactly one first-contact sender.** (T44-003,
   T38-L-001.) Structural, still undocumented in `specification.md`, and it is
   T29's job to document it. The wording T44 prescribed:

   > through the CLI, a published bundle serves exactly one first-contact sender;
   > the CLI has no command to allocate a fresh one-time prekey, so a second
   > distinct sender cannot establish a first session with the same recipient.

   Add the two facts T44 established alongside it: **no acceptance criterion is
   broken** — nothing in `specification.md` or `metrics-and-validation.md` requires
   two distinct senders to reach one recipient, so this breaks an unclaimed
   guarantee, not a claimed one (the nearest criterion is AC-10) — and the
   capability exists in the codebase (`OutboundMessenger.rotateBundle()`,
   `apps/cli/src/runtime/outbound.ts:36`) and is deliberately unreachable, because
   adding a ninth command would break the frozen surface this flow is validating.
   `retryPending()` (`outbound.ts:121`) has the same status.

3. **Poll byte budget is uncoupled from `ECHOLET_MAX_MESSAGE_BYTES`.**
   (HL-N-003 / T35-I-001, with the config-coupling family T54-F-003.) Measured: at
   `maxMessageBytes` = 2 MiB the relay returned a **2,097,781-byte** poll response —
   about twice the CLI's 1 MiB hard bound — and nothing was acknowledged. Not
   reachable at the default 262144. Note that the *send-route* body bound WAS
   derived from configuration; only the poll budget remains a compile-time constant
   (`apps/relay/internal/api/handler/mailbox_handler.go:65`).

4. **Documentation debt, raised four times and never closed.** (R2-L-003, R2-I-005,
   T45-I-002, T48-005, T53-I-004, T50-F-002's second half, T34-I-003.) None of the
   following appears in `docs/`: `claimable` (0 matches repository-wide in `docs/`),
   `PREKEY_BUNDLE_UNAVAILABLE`, the poll request `cursor` field, the changed meaning
   of `next_cursor`, the poll result shape `{received, more, rejected[]}`, poll
   exiting 0 while reporting rejections, `SENDER_QUOTA_EXCEEDED` in the
   failure-behaviour table, the `size_bytes == len(ciphertext)` hard rejection, and
   the new precondition that `send` requires a prior `relay publish`. This debt is
   T29's own deliverable, not a limitation to hand onward.

5. **Backfill robustness.** (BE-R-002, BE R-003.) The startup
   `BackfillDeviceMailboxBindings` is the one `device_mailbox` writer without a
   bounded conflict retry, and one undecodable record aborts the whole scan
   (`apps/relay/internal/storage/repository/device_record_repo.go:128-158`). The
   round-1 verifier measured 0 of 2 healthy records bound after one bad record. Its
   startup cost was never confirmed by a verifier (T34-I-001's unanswered half).

6. **Test-coverage residues.** T49-F-002 (`GetEnvelopeBatchFrom` has no test with a
   non-empty cursor — the path serving every production poll); T41-N-003 MG3 (the
   first-envelope byte-budget exemption at `mailbox_repo.go:190` survives deletion);
   T51-F-002 (mobile signing is unobservable by any test); T38-TP-004 (F-002, F-006,
   F-007, F-010/F-011 were never reached by a mutation pass).

7. **Unbounded `bundle_id`.** (T48-004.) The third member of the R2-002 class is
   still unbounded in `apps/relay/internal/validation/validate.go`.

8. **Accepted-by-design behaviours that an operator will notice**, each with its
   reason: a poll that accepts nothing re-raises the first rejection and discards
   the `rejected` list (R2-L-004, preserving the F-012 contract); a malformed relay
   response reads as `PROTOCOL_REJECTED` (T42-I-001, R2-I-003); the poll cursor is
   outside the signed challenge and an out-of-range position returns an empty page
   (T49-I-001); the position cursor can skip or repeat an envelope under concurrent
   ack/expiry (T48-002); a published-vs-unpublished identity oracle in the two 403
   codes (T51-F-003 / T52-F-002); and `message_id` plus the two recipient fields are
   not bound by the v1 sender transcript (T50-I-002 / T51-F-004).

9. **Harness limits.** The vitest birpc `onTaskUpdate` 60 s ceiling has no config
   lever and discards a whole file's results above roughly 30× CPU oversubscription
   (T43-N-001; observed 0 times at the ≤4.8× load the gates actually used).
   Packages other than `apps/cli` still run on vitest's 5000 ms default
   (T43-N-002). The strict health adapter cannot execute ESLint and does not
   associate the independently passing typecheck and test commands with its
   required sources, so its score is advisory; `keryx test run --strict`
   under-counts (it reported 2–3 for workspaces running 82–162 tests, and the
   independent workspace run is the authoritative count).

### 8.2 Scope: what the user approved, and what the wave did not grow into

State plainly that **sender authentication on `/v1/messages/send` (T50/T51) and the
per-sender unacked-envelope quota (T53/T54) were explicit, user-approved scope
extensions, not scope the wave grew into on its own.** The record supports this
directly: the orchestrator did not decide T49-F-001 alone, because two standing
instructions conflicted — close every blocker/major finding, versus do not change
the prototype's scope. Closing it at the root meant adding production security to a
v1 route that had never had it, which the wave's scope explicitly excludes; the
alternative was documenting a cheap denial of service that no acceptance criterion
forbids. The four options were put to the user with the measured attacker cost and
the trade-off stated, and **the user chose the full fix.** The quota round follows
directly from that same decision after T52 showed sender authentication alone did
not close the class.

The other user decision on the record: on 2026-09-06 the user approved the reviewed
requirements package at `docs/requirements/echolet-cli-prototype/` and requested
autonomous implementation through the flow orchestrator with managed subagents.

### 8.3 What remains unimplemented and unproven

Carry the gate's own ceiling verbatim rather than paraphrasing it. Every
verification report states that the gate establishes local technical-prototype
behaviour on one macOS arm64 machine and nothing more. It does **not** establish:

- **production security**, or safe use for sensitive communication;
- **mobile delivery** — `apps/mobile` contributes 6 tests that render only the
  disabled-state gate; no real-device messaging, relaunch, connectivity loss or
  background delivery has been run (flow task **T10**, open);
- **public deployment / production-deployment readiness**;
- **completion of an independent cryptographic audit** (flow task **T11**, open);
- **user demand or a user pilot** — no interviews and no pilot have been run (flow
  task **T12**, open; `PILOT-29` still carries empty evidence fields);
- **permanent suitability of the pinned `@signalapp/libsignal-client@0.102.0`
  dependency**, which is prototype-only.

The allowed claim ceiling after a passing gate, from
`metrics-and-validation.md:78`, is: two local computer CLI clients exchanged
encrypted text through the Echolet relay and recovered from the tested restarts.
Add the one exclusion T52 attached to it: the mailbox is **not** protected against
a self-published sender flooding a victim offline.

Also record that `main` is unborn with no commit and no remote, so no result in
this flow can be pinned to a commit hash and the PR-and-merge completion path is
unavailable. **AC6 remains unmet.**

### 8.4 Environment caveat (must appear in the status document)

The machine's default `node` was **v22.12.0**, below `apps/cli`'s declared
`"engines": {"node": ">=22.13"}`. Under it, **13 of the 17 `apps/cli` suites fail to
collect** with `Error: No such built-in module: node:sqlite`, and the process-level
suites exit 1 with no output — **a failure mode that looks exactly like a broken
implementation and is not one** (21 failures across 13 files). The homebrew node at
`/opt/homebrew/bin/node` is v26.5.0 and runs the suite correctly; every gate from
T42 onward confirmed `node --version` as v26.5.0 before its first check, and the
hazard did not apply to any recorded result. **No permanent pin was added, so the
hazard remains for the next reader.** (`apps/cli` now holds 22 test files; the
"13 of 17" figure is the count at the time of measurement, T45.)

---

## 9. Additions this pass found that the orchestrator's lists did not name

1. **Stale source documentation asserting the opposite of what now ships.**
   `apps/relay/internal/validation/validate.go:92` still states
   "/v1/messages/send has no sender authentication" as the *rationale* for the
   `MaxIdentifierBytes` bound. T51 made that false. The same stale claim appears at
   `apps/relay/internal/validation/mailbox_envelope_shape_test.go:28` and
   `packages/crypto-core/src/mailbox/auth.envelope.test.ts:13`. Info severity, no
   behaviour impact, but it is exactly the kind of comment a future reader will
   trust. Newly observed by this pass; not inherited from any review.
2. **Finding ids present in the artifacts but absent from the orchestrator's
   enumeration**, all dispositioned above: `T33-N1`–`T33-N4`; `T34-I-004`,
   `T34-N-001`–`T34-N-004`; `T35-Q-001`; `T38-L-002`, `T38-L-003`, `T38-L-004`,
   `T38-TP-004`; round-1 reviewer-local `N-004`, `N-005`, backend `R-003`–`R-005`,
   security `R-002`–`R-005`; `R2-I-003`, `R2-I-004`, `R2-I-005`, `R2-L-004`,
   `R2-L-005`; `T45-I-001`, `T45-N-001`–`T45-N-003`; `T46-N-001`–`T46-N-003`;
   `T50-D-001`, `T50-I-001`.
3. **A naming hazard for the change report.** Round-1 reviewers emitted
   reviewer-local ids (`R-001`…`R-005`, `N-001`…`N-005`); two reviewers independently
   emitted `R-001`. The prefixed aliases (`BE-R-`, `SEC-R-`, `HL-N-`) exist only
   because of that collision. Cite `global_id`
   (`<reviewId>#<id>`), never the bare display id.
4. **T49 and T52 are still `todo` in `flow.json`** although their reports exist and
   their successors (T50–T54) are `done`. T38 and T29 are also `todo`, as expected.
   Whoever closes T38 should reconcile the T49/T52 task states rather than leave
   them dangling.
5. **The T40/T41 dispatch-artifact crossing is real and confirmed.** Task **T40** is
   the TEST task documented by `dispatches/001-T41-tests*.json`; task **T41** is the
   IMPLEMENT task documented by `dispatches/001-T40-implement*.json` and
   `t40-implementation-report.md`. Finding-id prefixes follow the artifact name, not
   the task, so `T41-N-001`–`T41-N-004` were raised by task T40 and `T40-N-001` by
   task T41. The change report must not inherit the inversion.

---

## Routing audit

`graph_used`: no — not-relevant; every artifact path was given and the source
spot-checks were exact `file:line` reads, not navigation.
`wiki_used`: no — not-relevant; this is a disposition consolidation, not an
architecture question. (`wiki/index.md` is recorded as empty in this flow's
context.)
`ctx_used`: yes — `keryx ctx run` and `keryx ctx rg` throughout, with raw logs
retained under `.metaproject/data/gdctx/`.
`raw_rg_used`: no — one `grep` id-inventory sweep was run through `keryx ctx run`
over this flow's own markdown and JSON artifacts, not over project code.
