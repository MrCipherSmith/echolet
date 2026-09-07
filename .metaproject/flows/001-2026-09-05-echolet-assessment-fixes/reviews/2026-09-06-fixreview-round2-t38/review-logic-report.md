# T38 round 2 — logic review of the CLI delta

Reviewer: `review-logic` · flow `001` · dispatch `001-T38r2-review-logic`
Project root: `/Users/Goodea/goodea/projects/echolet`
Date: 2026-09-06

## Review Scope

- Branch: `main` (unborn; everything untracked — the change set was read from the working tree, not from `git diff`)
- Scope mode: `delta since round 1`, per the dispatch: T39 (`inlineStringOptionValues`), T41 (per-envelope acceptance), T45 (`reportedRelayCodes`), T46 (required `claimable`)
- Spec compliance gate: ran against `docs/requirements/echolet-cli-prototype/specification.md`
- Verification matrix: **not re-run** (T42 owns it). One bounded read-only probe was executed; no repository file was created, modified or deleted.

## Summary

Three of the four delta changes are correct and introduce no new defect: **T39 is sound**, **T45 is sound**, **T46 is sound and tightens rather than loosens the wire contract**. **T41 is internally correct** — the permanent/transient classification is right in both directions, and `acceptOne()` cannot leave partial state — but the finding it was written to close, **HL-N-001, is only partially closed**: an unauthenticated sender can still wedge a victim's mailbox and destroy their queued traffic, by two mechanisms the per-envelope isolation does not reach. One of those mechanisms costs **one** unauthenticated POST, exactly as before the fix.

### Stats

- blocker: 0 | major: 1 | minor: 2 | info: 2

### Round-1 findings in this reviewer's area

| Finding | Disposition | Basis |
|---|---|---|
| **HL-N-001** (major) | **partially-fixed** | The single-poison wedge is genuinely gone (`inbound.ts:98-114`, pinned by `inbound.batchIsolation.test.ts:186-260`), but the class is still reachable — see `[R2-L-001]`. |
| **HL-N-002** (minor) | **fixed** | `inbound.ts:89` returns `more: batch.next_cursor !== null`; the relay sets `next_cursor` iff `batch.HasMore` (`mailbox_handler.go:266-270`), and `HasMore` is set exactly at the two selection bounds (`mailbox_repo.go:171`, `:191`). Reported to stdout verbatim via `cli.ts:327` → `:361`. |
| **SEC-R-001** (minor) | **fixed** | The docstring at `cli.ts:83-111` now states the changed class explicitly (`:92-98`: `send --text --json` sends the literal body `--json`), gives the escape, and keeps the four narrowness bullets, which I re-verified against the code (see §1). No behaviour was changed to fix a docstring. |
| **T44-001** (minor) | **fixed** | `relayClient.ts:17` allowlists `PREKEY_BUNDLE_UNAVAILABLE` so `request()` (`:117-120`) carries it as `remoteCode`; `cli.ts:353` reports it under the relay's own name via `reportedRelayCodes` (`:36`). See §3 for the both-directions check. One residual docstring inaccuracy: `[R2-L-002]`. |

---

## 1. T39 — `inlineStringOptionValues` (`apps/cli/src/commands/cli.ts:112-125`)

**Verdict: correct. No new defect.**

I enumerated the branch space of the rewrite rather than sampling it. The loop's guard is
`arg.startsWith("--") && !arg.includes("=") && stringOptions.has(arg.slice(2)) && value !== undefined && value !== "--"`.

| Input shape | Result | Correct? |
|---|---|---|
| `--to -abc` | rewritten to `--to=-abc` → value reaches the trust layer verbatim | yes — this is the F-013 fix |
| `--json --profile p` | `--json` is boolean, not in `stringOptions`, passed through; `--profile` rewritten | yes — a flag can never swallow an operand |
| `--text=--json` | already contains `=`, passed through unchanged | yes — never re-wrapped |
| `--text` as last argument | `value === undefined`, passed through → `parseArgs` reports the missing value → exit 2 | yes |
| `--text --` | `value === "--"`, passed through → `parseArgs` still sees a missing value → exit 2 | yes |
| `-- <operands>` | `rewritten.push(...args.slice(index)); break` — copied verbatim | yes, and the loop terminates |
| `--text a=b` | `--text=a=b` → `parseArgs` splits on the **first** `=` → `text === "a=b"` | yes |
| `--text ""` | `--text=` → `text === ""` → `required()` rejects at `cli.ts:149` | unchanged from before the fix |
| `--to a --to b` | both rewritten; `parseArgs` emits two option tokens; `seen` at `cli.ts:139` rejects | yes — repetition detection unaffected |
| `---foo` | `slice(2) === "-foo"`, not in `stringOptions`, passed through → `ERR_PARSE_ARGS_UNKNOWN_OPTION` | yes |
| `echolet --profile poll` | `--profile=poll`, positionals empty → command `""` → not in `commandOptions` → exit 2 | unchanged from before the fix |

`args[index] as string` is safe: `index < args.length` is the loop invariant, and `index += 1` inside the rewrite branch is guarded by `value !== undefined`.

The one deliberate behavioural change (a declared string option now consumes the next argument even when it looks like an option) is standard `getopt` semantics, is the point of the fix, and is now documented — that is SEC-R-001's closure.

**Exit-code contract**: unchanged. Every path `inlineStringOptionValues` diverts still lands on `inputFailure()` / exit 2 through `parseCommand`'s `catch` (`cli.ts:131`), and no other exit code is reachable from argument parsing.

## 2. T41 — per-envelope acceptance (`apps/cli/src/runtime/inbound.ts`)

### 2.1 Is the permanent/transient classification correct in both directions? **Yes.**

**Transient side (must never be discarded).** `isNotAnEnvelopeVerdict` (`inbound.ts:53-54`) allow-lists `PersistenceError`, `RelayError`, `ProfileError`, and `accept()` re-throws them **before** anything is recorded as rejected (`:107`, ahead of `:108-110`). I checked that none of the three can be raised *as a verdict about the envelope's own content*:

- `PersistenceError` is constructed in exactly one place, `Profile.transact`'s `.catch` (`profile.ts:81-84`), and only when the raised error is **not** the same object the operation threw (`Object.is` guard at `:82`). Round 1 verified that guard by execution (F-003 spot-check). So it means "the store failed", never "this envelope is bad".
- `RelayError` is unreachable inside `acceptOne()` — there is no relay call between `inbound.ts:116` and `:145`. Its presence in the allow-list is defensive only.
- `ProfileError` comes only from `readMetadata` (`profile.ts:60`) and the contact-import paths; envelope-independent.

The spec requirement (`specification.md:133`, *"Decrypt or database commit failure | Do not ack; leave envelope retriable"*) is satisfied on **both** legs, which is the part worth stating plainly:

- a **commit** failure raises `PersistenceError` → whole poll aborts, transaction rolls back, `ackPending()` at `:88` is never reached, nothing is acked;
- a **decrypt** failure is classified permanent, but a permanently rejected envelope still gets **no** `cli:pending-ack:` key (the write at `:144` is inside the rolled-back transaction), so it is likewise never acked and stays queued at the relay.

Executed evidence already in the tree: `inbound.batchIsolation.test.ts:279-303` injects a real commit failure through `EncryptedSqliteStore.prototype.transaction` and asserts `fake.acks() === []`, a byte-identical store snapshot, and both envelopes still queued. I confirmed the injection predicate actually fires: it tests `tx.keys("inbox:")`, and libsignal's own dedupe key is `inbox:<address>:<messageId>` (`packages/session-node/src/SignalClient.ts:396`), while `keys()` is a `startsWith` filter (`EncryptedSqliteStore.ts:70`). The injected error is thrown *after* the operation resolves, so `Profile.transact`'s `Object.is` guard does not match and it is correctly mapped to `PersistenceError`.

**Default side (unclassified new failure).** The allow-list is of *non*-verdicts, so an unclassified new failure type defaults to **permanent**. The dispatch asks whether that is the conservative side. It is, and the reason is structural rather than stylistic: *a permanent verdict never acks*. Misclassifying a transient failure as permanent costs one spurious `rejected` entry and defers that envelope to the next poll; it cannot lose a message, because the envelope is still queued at the relay. Misclassifying the other way is what would re-wedge the mailbox. The direction of the default is therefore correct, and `t40-implementation-report.md:83-87` states the same reasoning.

### 2.2 Can `acceptOne()` leave partial state? **No.**

`acceptOne()`'s entire body — guards, decrypt, `tx.set(inboxKey)`, `appendHistory`, `tx.set(ackKey)` — runs inside one `profile.withRuntime` → `Profile.transact` → `EncryptedSqliteStore.transaction`. In `perform()` (`EncryptedSqliteStore.ts:60-83`) the transaction operates on an **in-memory `Map` read fresh at `BEGIN IMMEDIATE`**; the map is persisted only by `write(records)` + `COMMIT` at `:74-75`, and any throw goes to `ROLLBACK` at `:78`. There is no code path that persists a subset. A history entry without its pending ack, or a pending ack without its history entry, is therefore not representable.

Across envelopes the isolation is by design: envelope *N* committed and envelope *N+1* rolled back is the intended outcome, and each envelope re-reads its own contact pin, trust key and inbox dedupe entry inside its own transaction, so no stale read survives an interleaving.

Two second-order checks I ran because the transaction boundary moved:

- **Ratchet ordering.** `SignalClient` is created from `within(tx)` (`profile.ts:107`), so decrypt's session mutation is inside the same transaction and rolls back with it. Sequential envelopes from one sender now commit in separate transactions rather than one; libsignal tolerates out-of-order and skipped messages, and a rolled-back decrypt leaves the ratchet where it was.
- **Stale ack replay.** `ackPending()` deletes the local key only *after* the relay call (`inbound.ts:152-153`), so a lost ack response replays the ack. That is safe: the relay answers `acked: len(req.EnvelopeIDs)` unconditionally (`mailbox_handler.go:346`), whether or not the envelopes still exist, so the client's `z.literal(body.envelope_ids.length)` assertion (`relayClient.ts:85`) always matches. No wedge there.

### 2.3 Does re-raising only the first rejection lose information? Yes, but bounded — see `[R2-L-004]`.

### 2.4 Can `rejected` entries carry anything beyond `{ envelopeId, code }`? **No.**

- `code` is `InboundError.code`, and every `InboundError` in the tree is constructed with a string **literal** (`inbound.ts:68, 76, 108, 121, 123, 125, 129, 136, 143`). No sender-supplied string can become a code.
- `envelopeId` is `envelope.envelope_id`, which reaches `accept()` only through `relayClient.pollMailbox`'s `z.array(MailboxEnvelopeSchema.strict())` (`relayClient.ts:80`), and `MailboxEnvelopeSchema` declares `envelope_id: z.string().uuid()` (`packages/protocol/src/types/mailboxEnvelope.ts:6`). Confirmed by probe (§5): a non-UUID `envelope_id` is refused at the transport boundary.

So criterion 3 (no secret leakage) holds for the new poll output. The same check applies to T45: only the relay's `error.code` is carried, never its `message` (`relayClient.ts:118-120`).

## 3. T45 — `reportedRelayCodes` (`apps/cli/src/commands/cli.ts:36`, `:350-354`)

**Verdict: correct in both directions.**

- *Could a genuine protocol violation be reported under a non-protocol name?* No. `PREKEY_BUNDLE_UNAVAILABLE` is emitted by exactly one relay site: `ClaimSignalV2` returning `model.ErrV2Unavailable` when the availability scan finds no usable bundle (`storage/repository/signal_prekey_bundle_v2.go:196`), mapped to HTTP 404 by `v2Error` (`handler/signal_prekey_bundle_v2.go:20-21`). `v2Error:14` enumerates the **complete** v2 error set, and every other member maps to its own distinct code, so no violation can arrive wearing this name.
- *Could a non-protocol condition be reported as a protocol violation?* Only for the codes deliberately left out. `BUNDLE_ID_CONFLICT`, `CLAIM_ID_CONFLICT`, `ENVELOPE_ID_CONFLICT`, `INVALID_REQUEST`, `UNAUTHORIZED` and `NOT_FOUND` genuinely are protocol rejections, so folding them into `PROTOCOL_REJECTED` is accurate. `INVALID_RELAY_RESPONSE` has no `remoteCode` and correctly stays `PROTOCOL_REJECTED`.
- **Exit-code contract**: both ternary branches produce `trustFailure(...)` = exit 3, and the retryable branch is untouched at exit 4 (`cli.ts:351`). Neither widened nor narrowed.

One residual: the docstring is narrower than the condition — `[R2-L-002]`.

## 4. T46 — required `claimable` (`apps/cli/src/transport/relayClient.ts:37`, `:60`)

**Verdict: correct. This *tightens* the strict schema, satisfying criterion 2 rather than straining it.**

- The relay emits the field unconditionally on every publish success: `handler/signal_prekey_bundle_v2.go:96-99` writes `claimable` into the `data` map on the only success path, and the value comes from `SaveSignalV2` which sets it on both the first-store leg (`:89`, `true`) and the idempotent re-store leg (`:54`, `!stored.Claimed`), resetting it at the top of the closure (`:45`) because `updateV2` re-runs on a badger conflict. There is no success path that omits it, so requiring it cannot refuse a legitimate response.
- The response object is still `.strict()`, `claimable` is `z.boolean()` and not `z.coerce.boolean()`, and `publishBundle()` returns `data.claimable` verbatim with no default (`:61`). Go and TypeScript agree.
- **No test was weakened.** The five publish stubs T45 named as blockers now carry `claimable: true`: `cli.test.ts:131`, `cli.dashOptionValues.test.ts:275`, `relayClient.test.ts:34`, `outbound.publish.test.ts:68`, `outbound.test.ts:80`. Those are *stubs*, not assertions, and raising their fidelity to match the real relay is a strengthening. No `.skip` / `.only` / `.todo` exists anywhere in `apps/cli/**/*.test.ts` or `apps/relay/**/*_test.go`.

---

## Findings

### [R2-L-001] The unauthenticated mailbox wedge survives per-envelope isolation, by two paths

- **Severity**: major (blocks accepting HL-N-001 as `fixed`)
- **File**: `apps/cli/src/transport/relayClient.ts:80` and `apps/relay/internal/storage/repository/mailbox_repo.go:169-173`

**Problem.** T41 isolates envelopes that fail *inside* `accept()`. Two ways of reaching the same harm are outside that scope.

**Mechanism A — the transport schema rejects the whole batch, before `accept()` runs.**
`pollMailbox` parses the response with `z.array(MailboxEnvelopeSchema.strict())` (`relayClient.ts:80`). That schema requires `envelope_id`, `message_id`, `sender_device_id` and `recipient_device_id` to be UUIDs and `payload_type` to be the literal `"ciphertext_message"` (`packages/protocol/src/types/mailboxEnvelope.ts:6-13`). The Go relay checks **none** of those: `ValidateMailboxEnvelope` bounds identifier strings at 256 bytes and checks nothing about their format (`validation/validate.go:110-142`), `model.MailboxEnvelope` is a plain struct with no custom unmarshaller (`model/mailbox_envelope.go:10-25`), and `payload_type` is a free `string` field (`:20`). `/v1/messages/send` has no sender authentication (established by the round-1 verifier, §1 Link 2), and the mailbox id is `SHA-256(identity_id + ":mailbox:v1")`, computable by anyone holding the published contact card.

So **one** unauthenticated POST carrying, say, `payload_type: "x"` is stored (200), returned by every subsequent `GetEnvelopeBatch`, and makes the victim's poll fail at `relayClient.ts:89` with `INVALID_RELAY_RESPONSE` — non-retryable, so `classify()` maps it to `PROTOCOL_REJECTED` / exit 3 (`cli.ts:350-354`). `accept()` is never entered; `ackPending()` (`inbound.ts:88`) is never reached; nothing is acked. That is the pre-fix HL-N-001 behaviour restored in full, at the pre-fix cost of one request. The victim's legitimate traffic ages out undelivered at its 24h declared expiry (`outbound.ts:83`, filtered on at `mailbox_repo.go:183`), and the poison persists until its own declared expiry, bounded by the 7-day retention cap.

This shape is not accidental — `inbound.test.ts:163-171` deliberately pins whole-batch failure for a schema-invalid envelope — but that test predates HL-N-001 and pins the transport boundary, not the mailbox-availability contract.

**Mechanism B — rejected envelopes permanently monopolise the batch selection window.**
`GetEnvelopeBatch` scans the mailbox prefix in badger key order (`mailbox:<mailboxID>:<envelope_id>`, `mailbox_repo.go:163, :261-263`) and stops at `limit` (`:170-173`). It never skips an envelope that was returned before. Because a rejected envelope is deliberately never acked, it stays at its position forever. An attacker who sends `poll_batch_size` envelopes whose `envelope_id`s sort ahead of any real UUID fills every batch with poison: `received === 0`, so `poll()` re-raises at `inbound.ts:87` and `ackPending()` is again never reached. The default `poll_batch_size` is 50 (`cli.ts:265`); the wire maximum is 100 (`relayClient.ts:25`). Fifty unauthenticated POSTs, and the outcome is identical to mechanism A.

**Impact.** Legitimate queued messages for a chosen recipient are never delivered and are then lost — the same data-loss outcome HL-N-001 named, on the prototype's own documented `poll` contract, not a production-hardening concern.

**Why the implementers did not close it.** They were genuinely constrained: `inbound.test.ts:177-183` asserts a full-store snapshot and `acks() === []` for a poison-only batch, which rules out the verifier's alternative "quarantine locally and include it in the ack set". They correctly declined to weaken that test.

**Suggested fix (either closes both mechanisms).**
1. Parse the poll response per envelope: keep `z.array(z.unknown())` at the array level and run `MailboxEnvelopeSchema.strict()` inside `accept()`'s loop, so a schema-invalid envelope becomes one more `rejected` entry instead of a whole-batch `INVALID_RELAY_RESPONSE`. This closes A and reduces B to "the batch is full of `rejected` entries but `more` is honest".
2. Close B properly by giving the CLI a way to make progress past an envelope it will never accept — a durable local quarantine set that is excluded from the next batch, or acking permanently rejected envelope ids once the quarantine record is committed. That needs the F-012 snapshot assertion at `inbound.test.ts:177` re-expressed as "no history, no session mutation, no inbox entry" rather than "no store change at all", which is a test-author decision, not an implementer's.
3. Independently worth doing on the relay side: make `ValidateMailboxEnvelope` agree with `MailboxEnvelopeSchema` on `envelope_id` / `message_id` / `sender_device_id` / `recipient_device_id` being UUIDs and `payload_type` being the one literal. That is three lines and stops the divergent-contract class at its source.

**Class scope.** Sites: `apps/cli/src/transport/relayClient.ts:80` (batch-level parse), `apps/cli/src/runtime/inbound.ts:87` (poison-only re-raise), `apps/relay/internal/validation/validate.go:110-142` (the permissive half of the contract), `apps/relay/internal/storage/repository/mailbox_repo.go:169-173` (unbounded re-selection). Enumerated by: the complete set of gates an envelope crosses between `/v1/mailbox/poll` and a committed history entry, walked in order — relay validation on ingest, relay selection, client transport parse, `accept()`, `acceptOne()`. Exactly two of those five are per-envelope after T41.

### [R2-L-002] The `reportedRelayCodes` docstring names one of four conditions the relay reports under that code

- **Severity**: minor
- **File**: `apps/cli/src/commands/cli.ts:31-34`
- **Problem**: the comment says the code means "once it is claimed a further sender gets the relay's `404 PREKEY_BUNDLE_UNAVAILABLE`". `ClaimSignalV2` returns `ErrV2Unavailable` whenever the availability scan finds nothing usable (`storage/repository/signal_prekey_bundle_v2.go:155-196`), which also covers: the recipient has **never published**; every published bundle is outside its validity window (`:172`, `nowMS < CreatedAtMS || nowMS >= ExpiresAtMS`); and the requested `device_id` selector matches no available bundle (`:172`).
- **Why it matters**: none of the four is a trust violation, so the classification is right either way and there is no behavioural defect. The cost is to the next author, who will read "already claimed" and reason about a narrower condition than the code actually denotes. This is the same shape as SEC-R-001, which this flow accepted as a finding.
- **Fix**: replace "once it is claimed" with "when the relay has no unexpired, unclaimed bundle matching the selector — because it was already claimed, because none was ever published, or because they have expired".

### [R2-L-003] The delta's operator-visible contract is undocumented

- **Severity**: minor
- **File**: `docs/requirements/echolet-cli-prototype/specification.md:74`
- **Problem**: the delta adds five operator-visible facts that appear nowhere in the requirements: `poll` now emits `{ received, more, rejected[] }`; `poll` now **exits 0 while some envelopes were rejected** (before the fix, any poison made the command exit 3); `relay publish` now emits `claimable`; `send` can now report `PREKEY_BUNDLE_UNAVAILABLE`. `specification.md:74` documents exit codes only and enumerates no machine-readable error codes, and `schemas/relay-v2.schema.json` carries no response contract.
- **Why it matters**: the exit-code table is intact in the sense criterion 4 asks about — no code changed meaning — but the *success* contract of `poll` did change, and an operator scripting `echolet poll` and checking only `$?` will now silently miss rejected envelopes. `t45-implementation-report.md:159-174` already deferred two of these sentences to a documentation task; the poll-result shape and the exit-0-with-rejections consequence need to join them.
- **Fix**: one paragraph in the CLI-surface section covering the `poll` result shape and the `claimable` / `PREKEY_BUNDLE_UNAVAILABLE` sentences T45 drafted.

### [R2-L-004] Re-raising only the first rejection discards the whole `rejected` array

- **Severity**: info
- **File**: `apps/cli/src/runtime/inbound.ts:87`
- **Problem**: when `received === 0`, `poll()` throws `accepted.firstRejection` and `accepted.rejected` — envelope ids and every other code in the batch — is discarded. The operator sees `{"ok":false,"error":{"code":"CONTACT_NOT_TRUSTED"}}` and cannot tell whether one envelope or fifty were rejected. The path is also asymmetric with `received > 0`, where the same information *is* returned.
- **Why it matters**: it is deliberate — `inbound.test.ts:177-183` requires the throw and requires nothing be mutated — and no correctness property depends on the discarded data, because a rejected envelope stays queued regardless and there is no CLI command that could act on an envelope id. The cost is diagnostic, and it compounds `[R2-L-001]` mechanism B: the wedged operator gets an exit-3 code indistinguishable from the pre-fix one, with no hint that N envelopes were rejected.
- **Fix**: none within the current test contract. If `[R2-L-001]` is addressed, carry the rejections on the thrown error (e.g. an `InboundError` subclass with a `rejected` array) so the throw stays type-compatible with `classify()` at `cli.ts:356`.
- Secondary, and harmless: because the throw precedes `ackPending()` (`:88`), a stale pending-ack key left by an earlier lost ack response is not retried while every batch is poison. It clears on the next poll that accepts anything, and `retryPendingAcks()` has no CLI entry point by design (T38-L-001).

### [R2-L-005] `inbound.batchIsolation.test.ts:330` was edited after the implementation — checked, not a weakening

- **Severity**: info
- **File**: `apps/cli/src/runtime/inbound.batchIsolation.test.ts:326-334`
- **Problem**: `t40-implementation-report.md:177-217` reported this assertion RED and argued it was unsatisfiable; the tree now carries T40's suggested repair (`expect([...new Set(fake.ackedIds())]).toEqual([legitimate.envelope_id])`), so a test was changed after the code it tests. Criterion 1 requires this be checked rather than assumed.
- **Verdict**: **not a weakening.** I re-derived the unsatisfiability independently from the fixture: `mailbox()` records every request at `:131`, *before* consulting `state.intercept` at `:134`; `ackedIds()` flat-maps `envelope_ids` over **all** recorded ack requests (`:149`); and `queuedIds()` can only shrink inside the `/v1/mailbox/ack` branch (`:138-141`). So line 320's `RELAY_TIMEOUT` forces one recorded ack attempt and line 334's `queuedIds() === [poison]` forces a second, successful one — two entries, necessarily. The replacement preserves what the test exists to pin (which envelopes were ever offered for acknowledgement) and **adds** a guard the original lacked, `expect(fake.ackedIds()).not.toContain(poison.envelope_id)` at `:331`. The comment at `:326-329` states why the count is a fixture artefact.
- Also checked in the delta: `apps/cli/vitest.config.ts` gained `testTimeout`/`hookTimeout` 30_000 (T43). That is harness headroom, not an assertion change, and T43 measured that a genuinely hung test still fails at 30s. Test-suite integrity beyond this belongs to `review-testing-practices`.

---

## 5. The one probe I ran

Read-only, outside the repository, no repository file created or changed. It parses the shipped `MailboxEnvelopeSchema` against the shapes the Go relay accepts, to settle `[R2-L-001]` mechanism A by execution rather than by reading two schemas side by side.

```
node /…/scratchpad/probe.ts        (Node v26, /opt/homebrew/bin/node)

ACCEPTED  control (all-UUID, literal payload_type)
REFUSED   payload_type = "x"
REFUSED   envelope_id = "a"
REFUSED   message_id = "a"
REFUSED   sender_device_id = "a"
REFUSED   recipient_device_id = "a"
```

All five refused shapes pass `ValidateMailboxEnvelope` (`validation/validate.go:110-142` checks only `type`, `version`, identifier length ≤ 256, ciphertext presence, the two size comparisons and `expires > created`) and `SendEnvelope`'s one extra check (`mailbox_handler.go:97`, `expires_at_ms > now`). No plaintext, ciphertext, key or request body was printed.

## 6. The five non-negotiable criteria, over the delta

| Criterion | Verdict |
|---|---|
| 1. No test weakened | **Met.** One test edited post-implementation (`[R2-L-005]`), independently re-derived as a corrected fixture artefact that gains an assertion. Five publish stubs gained `claimable: true` — stubs, not assertions, raised to match the real relay. Zero `.skip`/`.only`/`.todo` across `apps/cli/**/*.test.ts` and `apps/relay/**/*_test.go`. |
| 2. No strict schema loosened | **Met, and tightened.** `claimableSchema` went `z.boolean().optional()` → `z.boolean()` on a still-`.strict()` object; Go emits the field unconditionally. `nextCursorSchema` remains the closed `string(1..256) \| null` union. `pollRequestSchema` / the ack body extend a `.strict()` base, so strictness is preserved through `.extend()`. |
| 3. No secret leakage | **Met.** `rejected` carries only a UUID `envelopeId` (enforced by `MailboxEnvelopeSchema`) and a literal code (all nine `InboundError` construction sites are literals). `claimable` is a boolean. The relay's error `message` is never carried inland — `relayClient.ts:119` reads `error.code` only, against a fixed allowlist. |
| 4. Exit-code contract intact | **Met, with a documentation gap.** T45 keeps both non-retryable branches at 3 and the retryable branch at 4; T39's diversions all land on exit 2. T41 does change `poll`'s *success* contract — exit 0 while envelopes were rejected — which is correct behaviour but undocumented: `[R2-L-003]`. |
| 5. Prototype scope respected | **Met.** `[R2-L-001]` is the prototype's own documented `poll` contract failing against an unauthenticated request the round-1 verifier already established is trivially issuable; it is not a demand for production hardening, deployment or audit. No finding here asks for rate limiting, mobile support or external review. |

## 7. Routing audit

- `graph_used`: **no** — `not-relevant`. Every navigation question was a named `file:line` from the dispatch or a targeted symbol search; the graph answers from the last `gdgraph build` and this session added an out-of-tree probe only.
- `wiki_used`: **no** — `not-relevant`. The domain contract for this review is `specification.md` and the round-1 verifier report, both read directly.
- `ctx_used`: **yes** — `keryx ctx rg` for every code search, `keryx ctx read` for the contract schemas and long flow artifacts, `keryx ctx run` for the probe.
- `raw_rg_used`: **no**.
