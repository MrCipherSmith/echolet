# T38 round-2 fix review — security-code

Reviewer: `review-security-code`, dispatch `001-T38r2-review-security-code`, flow `001`.
Project root `/Users/Goodea/goodea/projects/echolet`. Repository on unborn `main`; every
file untracked, so the delta was established by mtime plus content hashes, not by `git diff`.

**Nothing in the repository was modified.** `git status --porcelain` is 23 untracked entries,
identical to the snapshot recorded at `t44-multisender-diagnosis.md:236`. All probes ran from
the scratchpad against a relay binary built into the scratchpad with its own temporary
`ECHOLET_DATA_DIR`. No plaintext body, ciphertext, store key, private key material or HTTP
request body appears below; probes report status codes, error codes, byte lengths and booleans.

## Scope — the delta actually reviewed

Round 1 concluded at 20:18. Files changed after it (mtime, cross-checked against the round-1
verifier's recorded hashes):

| File | Change |
|---|---|
| `apps/relay/internal/validation/validate.go` | T41 — `maxEnvelopeIdentifierBytes` |
| `apps/cli/src/runtime/inbound.ts`, `inbound.batchIsolation.test.ts` | T40 — per-envelope isolation |
| `apps/relay/internal/storage/repository/signal_prekey_bundle_v2.go` | T45 — `SaveSignalV2` returns `claimable` |
| `apps/relay/internal/service/signal_prekey_bundle_v2.go` | T45 — `…V2Claimable` + delegating method |
| `apps/relay/internal/api/handler/signal_prekey_bundle_v2.go` | T45 — `claimable` in the publish response |
| `apps/cli/src/transport/relayClient.ts` | T45/T46 — `remoteCodes`, `claimableSchema` |
| `apps/cli/src/commands/cli.ts` | T46 — `reportedRelayCodes` |
| `apps/cli/vitest.config.ts` | T42 — 5 s → 30 s default test timeout |
| new/updated test files (22:24–22:49) | T43/T45/T46 RED-first tests |

`apps/cli/src/runtime/outbound.ts` and `apps/relay/internal/storage/repository/mailbox_repo.go`
carry post-round-1 mtimes but hash **byte-identical** to the round-1 verifier's recorded baselines
(`3720f372…7e8bba0f` and `d598cbe1…7fc36ef7`, verifier report section 7). They are unchanged —
see I-004 for why that matters.

## Verdict

**`DONE_WITH_CONCERNS`.** The four relay/CLI changes in my delta are individually correct and
I found no defect introduced by any of them. But the delta leaves one **major** hole open:
T41 bounded the envelope identifiers by *length* only, while the CLI's wire schema constrains five
of them by *shape*, and the gap between the two is an unauthenticated remote wedge of the victim's
`poll` — the same harm HL-N-001 described, through a door T40's per-envelope isolation cannot
reach. Evidence in R2-001.

---

## 1. Assigned judgements

### 1.1 Is the 256-byte identifier bound correct and complete?

**Correct and complete for the envelope route; the *class* is not closed.**

*Correct.* `validate.go:110-121` runs the bound over all eight identifier-shaped string fields of
`model.MailboxEnvelope` before any store call, and before the ciphertext/size checks. Verified by
bounded probe against a scratchpad relay (`/v1/messages/send`, all values below any body limit):

```
baseline (uuids, 43-char ids)      -> HTTP 200 ok
recipient_mailbox_id 70000 bytes   -> HTTP 400 INVALID_SCHEMA
envelope_id          70000 bytes   -> HTTP 400 INVALID_SCHEMA
message_id             257 bytes   -> HTTP 400 INVALID_SCHEMA
payload_type           257 bytes   -> HTTP 400 INVALID_SCHEMA
sender_identity_id     257 bytes   -> HTTP 400 INVALID_SCHEMA
sender_device_id       257 bytes   -> HTTP 400 INVALID_SCHEMA
recipient_identity_id  257 bytes   -> HTTP 400 INVALID_SCHEMA
recipient_device_id    257 bytes   -> HTTP 400 INVALID_SCHEMA
all eight at 256 bytes             -> HTTP 200 ok
```

That closes BE-R-001 including the `envelope_id` half the round-1 verifier recorded as an
understatement (verifier report section 5). The rejection message names only the field
(`validate.go:119`); the offending value is never echoed.

*Can a bounded field still 5xx by another route?* No. The only Badger key built from these
fields is `mailbox:<recipient_mailbox_id>:<envelope_id>` (`mailbox_repo.go:261-263`), ≤ ~530 bytes
under the bound, far under Badger's 65000-byte key ceiling (`badger/v4@v4.9.1/txn.go:352,363`).
Read paths (`challenge`, `poll`) use `txn.Get`, which has no key-size check
(`txn.go:429-434`), so an oversized identifier there is a miss → 403, not a 500.

*The class is not closed.* Two other write paths put an unbounded, caller-supplied string
straight into a Badger key. Reported as R2-002.

### 1.2 Is `!stored.Claimed` an exact answer to "is this bundle claimable"?

**Yes, at commit time — I could not find a state where it is wrong.** Four candidate states were
attacked:

| State | Verdict |
|---|---|
| already claimed | Exact. `ClaimSignalV2` sets `bundle.Claimed = true` (`signal_prekey_bundle_v2.go:175`) and deletes the availability index (`:183`) in **one** transaction, so the flag and the index can never disagree. |
| **expired** | Cannot reach the answer. `ClaimSignalV2:172` also skips on `nowMS >= bundle.ExpiresAtMS`, so `Claimed` alone would not describe it — but `PublishSignalPreKeyBundleV2Claimable` calls `ValidateSignalPreKeyBundleV2(raw, nowMS)` on **every** publish, first-store and re-store alike (`service/signal_prekey_bundle_v2.go:18`), and `validation/signal_prekey_bundle_v2.go:216` rejects `now >= expires` with `BUNDLE_EXPIRED` (400) before `SaveSignalV2` is ever entered. An expired bundle therefore never receives a `claimable` value at all. The repository comment at `:36` is accurate. Pinned by `handler/signal_prekey_bundle_v2_test.go:86`. |
| not yet valid (`nowMS < CreatedAtMS`) | Unreachable for the same reason: `validation:216` rejects `created > now`. |
| **concurrently claimed** | Exact. `SaveSignalV2` reads `v2:bundle:<id>` inside its `db.Update` closure (`:47`), which joins Badger's conflict set; a claim committing in between raises `ErrConflict`, `updateV2:14-20` re-runs the closure, and `:45` resets `claimable = false` first so the answer belongs to the attempt that commits. The comment at `:43-45` states exactly this and the code matches. |
| superseded by a second bundle | Not a state of *this* bundle. A different `bundle_id` with a fresh OTK takes the first-store path and reports its own `claimable: true`; the older bundle's answer is unchanged and still correct. |
| availability index lost some other way | No other writer. `CleanupService.runCleanup` is a no-op (`cleanup_service.go:41-46`), and no `v2:*` key is written with a Badger TTL. |

The one honest limitation is inherent and not overclaimed: `claimable` is a point-in-time answer
at commit, not a durable guarantee. The docstrings at `repository:29-36`, `service:13-16`,
`handler:80-82` and `relayClient.ts:31-36` all phrase it that way.

### 1.3 Does surfacing the relay's own error code leak anything?

**No, and it gives an unauthenticated third party nothing new.**

- The wire is unchanged. `404 PREKEY_BUNDLE_UNAVAILABLE` was already the relay's answer before
  T45 (`model/signal_prekey_bundle_v2.go:12`, `handler/signal_prekey_bundle_v2.go:14-28`, and
  observed at the wire by the T44 probe, `t44-multisender-diagnosis.md:104`). An unauthenticated
  prober with `curl` could always distinguish "available" from "exhausted". The change is entirely
  about what the *local operator's own CLI* prints; no attacker gains an oracle they lacked.
- The relay's error **message** never travels. `relayClient.ts:118-120` parses the error envelope
  and keeps only `error.code`, and only if it is in the fixed `remoteCodes` set; `message` is
  discarded. Pinned by `relayClient.prekeyUnavailable.test.ts:38-39`, which asserts a marker
  string in the relay's message reaches neither `String(error)` nor `JSON.stringify(error)`.
- Nothing attacker-controlled can reach stdout. `cli.ts:353` emits `remote` only when
  `reportedRelayCodes.has(remote)`, a hard-coded one-element set (`cli.ts:36`); the emitted string
  is therefore always the literal `"PREKEY_BUNDLE_UNAVAILABLE"`. Everything else stays
  `PROTOCOL_REJECTED`. `writeResult` (`cli.ts:360-362`) emits `{code}` only — no message, no
  status, no relay body.
- The new `claimable` field is likewise not an oracle for a third party. It is returned only on
  `/v2/prekeys/publish`, which requires a bundle that self-verifies against the publishing
  identity. A party who replayed a victim's exact bundle bytes could probe non-destructively —
  but obtaining those bytes requires having already claimed the bundle, and claiming is itself the
  documented public answer (`specification.md:92`). No confidentiality boundary is crossed.

Removing `PREKEYS_EXHAUSTED` is safe: zero occurrences anywhere in `apps/relay`
(`keryx ctx rg "PREKEYS_EXHAUSTED"` → 1 match, the comment at `relayClient.ts:16`).

### 1.4 Does the delegating Go method leave two entry points that can diverge?

**No.** `PublishSignalPreKeyBundleV2` (`service/signal_prekey_bundle_v2.go:8-11`) is a pure
one-line delegation — `_, err := s.PublishSignalPreKeyBundleV2Claimable(raw, nowMS); return err` —
with no duplicated validation, no duplicated store call and no second policy decision. There is
exactly one implementation. Divergence would require someone to reimplement the body, which the
comment at `:5-7` warns against.

Production reachability: `router.go:68` wires the handler, and the handler
(`handler/signal_prekey_bundle_v2.go:83`) calls the `…Claimable` variant. The error-only method is
now reachable only from the `relayv2`-tagged test that declares it
(`repository/prekey_bundle_v2_test.go:1,24-27,53`). It is deliberately-retained test-contract
surface, not a live second entry point.

### 1.5 Leakage and exit-code audit over the whole delta

| Channel | Result |
|---|---|
| A rejected argument value | Never emitted. `parseCommand:130-132` catches the `parseArgs` exception and discards it, throwing a bare `inputFailure()`; `main:372` writes `{code}` only. Node's `ERR_PARSE_ARGS_*` message, which does contain the value, never escapes. |
| An identifier that exceeded the bound | Never emitted. `validate.go:119` returns `identifier.Name + " exceeds the maximum identifier length"`. The value is not in the message and the comment at `:88-90` records the rule. |
| A relay error body | Never emitted. `relayClient.ts:119-120` (code only, allowlisted) → `cli.ts:353` (allowlisted literal or `PROTOCOL_REJECTED`) → `cli.ts:361` (`{code}` only). |
| Relay-side logs | The 500 paths log nothing at all; the probe relay's whole log across ~15 requests including three 500s was three INFO startup lines and no request detail. |
| `claimable` on stdout | The publisher's own boolean about its own bundle. No secret. |
| Exit codes 0/2/3/4/5 | Intact. `ExitCode` is still the literal union `2|3|4|5` (`cli.ts:11`); `classify` (`:346-358`) is unchanged in structure except that the non-retryable relay branch now chooses **which name** to report at the same exit 3. Retryable → 4 (`:351`), `PersistenceError` → 5, `ConfigurationError` → 2, unknown → 5: all untouched. Pinned live by `cli.relayErrorCodes.test.ts:162,163,190,194,200,206` (exit 3 and 4 across five distinct conditions), `cli.dashOptionValues.test.ts:181,194,255,311` (exit 2) and `cli.processFailures.test.ts:221,237,259` (exit 5). |
| Test weakening | None found in the delta. No `.skip(`/`.only(`/`.todo(`/`t.Skip(` anywhere under `apps` or `packages`. The new tests strengthen: `cli.relayErrorCodes.test.ts:165-170` asserts the exhausted and violation codes are *different*, so renaming the generic code is not a fix, and `redacted()` (`:94-98`) asserts the store key and message body never appear in stdout+stderr. |
| Schema loosening | None. `claimable` is a required `z.boolean()` on a `.strict()` object (`relayClient.ts:37,60`) — no `.optional()`, no passthrough, no `any`. `nextCursorSchema` (`:30`) is still the closed `string(1..256) \| null` union. Go and TypeScript agree: the handler always emits `claimable` as a Go `bool` (`handler:98`). `relay-v2.schema.json` defines `publishRequest`, `claimRequest` and `claimResponse` only — there is no publish-response definition to contradict. |
| `vitest.config.ts` 5 s → 30 s | Checked and clean. No assertion loosened, no file excluded, no test skipped; per-test timeouts of 40–90 s still win. It removes a harness flake, not a product guarantee. |

---

## 2. Closure of the round-1 open findings in my area

| Finding | Status | Evidence |
|---|---|---|
| **BE-R-001** (unbounded identifiers → 500) | **fixed** for the reported route; **class not closed** (see R2-002) | The nine-row probe table in §1.1. 400 `INVALID_SCHEMA` on all eight fields at 257 bytes, 200 at 256, including the `envelope_id` half the verifier flagged as an understatement. |
| **SEC-R-001** (docstring asserted what the code does not do) | **fixed** | `cli.ts:91-98` now states the change explicitly and correctly: "a declared string option now takes the next argument as its value even when that argument itself looks like an option… `send --text --json` used to be refused with ERR_PARSE_ARGS_INVALID_OPTION_VALUE (INVALID_ARGUMENTS, exit 2); it now sends the literal body `--json`, and `--json` is not set." That matches the verifier's executed observation (verifier report §2, row SEC-R-001) exactly. Each of the four remaining bullets at `:102-107` was checked against the code and holds: `stringOptions.has(arg.slice(2))`, `!arg.includes("=")`, `value !== undefined && value !== optionSeparator`, and the `--` copy at `:116`. No behaviour change. |
| **T44-001** (relay's code discarded twice) | **fixed** | Both discard sites repaired: `relayClient.ts:17` adds `PREKEY_BUNDLE_UNAVAILABLE` to `remoteCodes`, and `cli.ts:352-353` consults `error.remoteCode` against `reportedRelayCodes` instead of flattening. Behaviourally pinned end to end by `cli.relayErrorCodes.test.ts:157-170`, which spawns the real CLI against a synthetic relay and asserts exit 3 with a code matching `/PREKEY/` and *not* equal to the code a signature rejection produces. The allowlist discipline survives (`relayClient.prekeyUnavailable.test.ts:42-49`). |
| **T44-002** (`relay publish` returns ok while restoring nothing) | **fixed** | The relay now answers the question the client cannot (`repository:37-96`), the handler always emits it (`handler:96-99`), the client requires it (`relayClient.ts:37,60-61`), and it reaches the operator's stdout unchanged: `outbound.ts:34` returns `relay.publishBundle(...)` verbatim, `cli.ts:309` returns that from `execute`, `cli.ts:368` writes it. A re-publish after a claim now prints `"claimable":false`. Correctness of the value itself is §1.2. |

---

## 3. Findings

### [R2-001] Unauthenticated schema-poison envelope wedges the victim's `poll` — the residual of HL-N-001 that T40's isolation does not cover

- **Severity**: `major`
- **File**: `apps/relay/internal/validation/validate.go:110-142` (relay accepts) and
  `apps/cli/src/transport/relayClient.ts:79-82` (client refuses the whole batch)
- **Blocks acceptance**: yes — it reopens the harm HL-N-001 was fixed to remove.
- **Attack vector.** Anyone who holds a victim's published contact card can compute
  `recipient_mailbox_id = SHA-256(identity_id + ":mailbox:v1")` (`cryptoutil/signatures.go:14-17`).
  `/v1/messages/send` has no sender authentication (`router.go:76`). The attacker POSTs one
  envelope whose identifiers pass `ValidateMailboxEnvelope` — non-empty and ≤ 256 bytes — but
  violate the shape the CLI's wire schema requires: `envelope_id` / `message_id` /
  `sender_device_id` not a UUID, or `payload_type` not the literal `"ciphertext_message"`.
  The declared expiry is attacker-chosen, so the envelope survives to the 7-day Badger retention
  cap and is re-armed with one more POST.
- **Problem.** T41 bounded these fields by *length*; `MailboxEnvelopeSchema`
  (`packages/protocol/src/types/mailboxEnvelope.ts:6,7,9,11,13`) constrains five of them by
  *shape*. The relay is therefore willing to store and return envelopes its own client refuses to
  parse. `relayClient.pollMailbox` validates the poll response as
  `z.array(MailboxEnvelopeSchema.strict()).max(100)` — one array, all or nothing — so a single
  poisoned envelope fails the entire response at `relayClient.ts:89`
  (`RelayError("INVALID_RELAY_RESPONSE", false)`). That throw leaves `pollMailbox` at
  `inbound.ts:81`, **before** `accept()` at `:84`. T40's per-envelope isolation
  (`inbound.ts:98-114`) never executes, and `ackPending()` at `:88` is never reached.
- **Why it matters.** Nothing is acknowledged, so every legitimate envelope queued behind the
  poison stays undelivered and is lost when its own declared 24 h expiry passes
  (`outbound.ts:83`, `mailbox_repo.go:183`) — verbatim the HL-N-001 harm the independent verifier
  confirmed in round 1 and T40 was written to remove. The CLI reports it as exit 3
  `PROTOCOL_REJECTED`, and no CLI command can recover: `retryPendingAcks()` (`inbound.ts:157`) has
  no entry point, the same gap as T38-L-001.
- **Evidence (bounded probe, scratchpad relay, nothing written to the repository).**
  1. Victim publishes a device record → `200`.
  2. Unauthenticated `POST /v1/messages/send` with `envelope_id: "poison-not-a-uuid"`,
     `message_id: "also-not-a-uuid"`, `sender_device_id: "not-a-uuid"`,
     `payload_type: "not_ciphertext_message"` → **`HTTP 200`, accepted and stored.**
  3. Victim's correctly signed `POST /v1/mailbox/poll` → `200`, batch of 1.
  4. That batch parsed with the expression copied verbatim from `relayClient.ts:80` →
     `poll response parses: false`, failing at
     `data.envelopes.0.envelope_id`, `.message_id`, `.sender_device_id`, `.payload_type`.
- **Class scope**: relay-vs-client shape mismatches on the mailbox envelope.
  - `sites`: `apps/relay/internal/validation/validate.go:117-121`
  - `enumeration_method`: field-by-field comparison of `MailboxEnvelopeSchema`
    (`packages/protocol/src/types/mailboxEnvelope.ts:3-18`) against `ValidateMailboxEnvelope`
    (`validate.go:110-142`). Five of fourteen fields are constrained on the client and not on the
    relay: `envelope_id`, `message_id`, `sender_device_id`, `recipient_device_id` (all
    `z.string().uuid()`) and `payload_type` (`z.literal`). `type` and `version` are checked on both
    sides; `ciphertext`, the timestamps and `size_bytes` are only loosely typed on the client and
    their real checks live inside `acceptOne` (`inbound.ts:118-131`), where a failure **is**
    isolated as `INVALID_ENVELOPE` — which is exactly why the transport-boundary five are the
    dangerous ones. Extra keys cannot be relayed: Go's decoder drops unknown JSON fields.
- **Fix.** Two independent options; either alone closes it, and doing both is defence in depth.
  1. Relay-side (smallest, matches the v2 validator's own precedent at
     `validation/signal_prekey_bundle_v2.go:150,167,181`): require UUID shape for the four
     identifier fields and the literal `"ciphertext_message"` for `payload_type` in
     `ValidateMailboxEnvelope`, rejecting with `INVALID_SCHEMA` → 400. Costs nothing legitimate —
     `outbound.ts:80-83` always emits exactly these shapes.
  2. Client-side (restores T40's intent at the boundary): parse envelopes individually in
     `pollMailbox` and route an unparsable one into `PollResult.rejected` instead of failing the
     whole response.
- **No test covers this today.** `INVALID_RELAY_RESPONSE` appears in four test files
  (`relayClient.test.ts:70`, `pollCapacity.test.ts:159`, `claimable.test.ts:40,61`), none of which
  exercises a relay-accepted envelope wedging a poll.

### [R2-002] The BE-R-001 class is not closed: two more write paths put an unbounded caller-supplied string into a Badger key and answer 500

- **Severity**: `minor` (same shape and same rating as BE-R-001 itself)
- **File**: `apps/relay/internal/validation/validate.go:8-32` (`ValidateDeviceRecord`) and
  `apps/relay/internal/api/handler/mailbox_handler.go:297-318` (`AckRequest.EnvelopeIDs`)
- **Blocks acceptance**: no.
- **Attack vector.** (a) Unauthenticated: an attacker generates their own ed25519 identity and
  self-signs a device record whose `device_id` is ~65 kB. `ValidateDeviceRecord` checks only
  non-emptiness (`validate.go:18-20`), so the record reaches
  `deviceRecordKey(identityID, deviceID)` (`device_record_repo.go:50,188`), whose key exceeds
  Badger's 65000-byte ceiling. (b) Self-authenticated: a caller signs an ack for their own mailbox
  with one ~65 kB entry in `envelope_ids`; the count is bounded (`mailbox_handler.go:315`) but the
  element length is not, and `DeleteEnvelope` calls `txn.Delete` unconditionally
  (`mailbox_repo.go:219-223`).
- **Evidence (probe).**
  ```
  /v1/device-records/publish  device_id 36 bytes    (uuid)   -> HTTP 200 ok
  /v1/device-records/publish  device_id 64960 bytes, body 65307 bytes -> HTTP 500 INTERNAL_ERROR
  /v1/device-records/publish  device_id 64900 bytes, body 65247 bytes -> HTTP 200 ok
  /v1/mailbox/ack             envelope_id 36 bytes  (uuid)   -> HTTP 200 ok
  /v1/mailbox/ack             envelope_id 65000 bytes        -> HTTP 500 INTERNAL_ERROR
  ```
  The 64 KiB `compactRequestBodyLimit` (`request_body.go:13`) does **not** save the device-record
  route: the rest of the record costs ~340 bytes, leaving ~65 kB for `device_id` against a 65000-byte
  key ceiling.
- **Class scope**:
  - `sites`: `apps/relay/internal/validation/validate.go:18` (`device_id`, unauthenticated),
    `apps/relay/internal/api/handler/mailbox_handler.go:300` (`envelope_ids[]`, self-authenticated),
    `apps/relay/internal/validation/validate.go:34-70` (`bundle_id` on `/v1/prekeys/publish`,
    never inspected, key built at `prekey_bundle_repo.go:28` under a 1 MiB body limit — same shape,
    not probed).
  - `enumeration_method`: enumerated every `txn.Set`/`txn.Delete` in
    `apps/relay/internal/storage/repository/` and traced each key component back to its request
    field, then checked each field's validator. All `/v2/*` paths are safe by construction —
    `validation/signal_prekey_bundle_v2.go:167` requires `bundle_id` to be a UUID, `:181` requires
    `device_id` UUID and `identity_id` 32-byte base64, and `:152` (`ValidateSignalSelector`) does
    the same for the claim selector. Read paths cannot 500: `txn.Get` has no key-size check
    (`badger/v4@v4.9.1/txn.go:429-434`), so an oversized read key is a miss → 403.
- **Impact.** A wrong status code on purely caller-supplied input — an internal error reported for
  malformed client input. No leakage (the 500 body is the fixed string `"failed to save device
  record"`, and nothing is logged), no crash, no partial write. Exactly the impact round 1 assigned
  to BE-R-001.
- **Fix.** Apply the same bound: reject `device_id` (and, for symmetry, `identity_id`) over
  `maxEnvelopeIdentifierBytes` in `ValidateDeviceRecord`; bound each `envelope_ids` element in
  `AckMailbox`; bound `bundle_id` in `ValidatePreKeyBundle`. `device_id` is a UUID everywhere the
  CLI produces one, so a UUID check would be tighter still and would also close R2-001's `device_id`
  half.

### [R2-I-003] A relay one version behind now turns a successful `relay publish` into exit 3 `PROTOCOL_REJECTED`

- **Severity**: `info`
- **File**: `apps/cli/src/transport/relayClient.ts:37,60`
- Making `claimable` a **required** `z.boolean()` is the right call and I am not asking for it to be
  relaxed — the docstring at `:33-36` argues correctly that an absent key would silently degrade a
  no-op republish back into plain success. The consequence worth writing down: a CLI from this tree
  talking to a relay from before T45 now fails `relay publish` with
  `INVALID_RELAY_RESPONSE` → `classify` (`cli.ts:350-353`, `remoteCode` undefined) → exit 3
  `PROTOCOL_REJECTED`, which reads as "the relay rejected you" rather than "the relay is too old".
  In this prototype both binaries are built from one tree by the same runbook
  (`metrics-and-validation.md:36-47`), so this is unreachable in the validated scenario. Recording it
  because the failure mode is confusing rather than because it needs a fix.

### [R2-I-004] mtime is not a sound integrity signal in this working tree

- **Severity**: `info`
- Five source files had their mtimes bumped during this review session (23:36–23:40, one per
  minute) with **no content change**: `outbound.ts` still hashes
  `3720f372cb40931fee19bad5cc4c8378815f11ba29e8200397ef37077e8bba0f` and `mailbox_repo.go`
  `d598cbe175d2bd33142765a10ca995bc070fa582af21142cb89d69f07fc36ef7`, both byte-identical to the
  round-1 verifier's recorded baselines. `cli.ts` and `relayClient.ts` were touched the same way
  after their genuine T46 edits.
- This matters only because the orchestrator's stated method for non-negotiable criterion 1 is
  "verified by mtime in every wave that tests were written before the implementation". That ordering
  is not reliable in this tree. The hash-verification T37 and T42 performed is the sound method and
  should remain the one relied on. Content integrity itself is fine — I found no unexplained change.

### [R2-I-005] `claimable` is not in the documented relay contract

- **Severity**: `info`
- `specification.md`'s Publish section describes the request and the storage semantics but not the
  response body, and `schemas/relay-v2.schema.json` defines only `publishRequest`, `claimRequest`
  and `claimResponse`. So `claimable` contradicts nothing — but a field the CLI now *requires* on
  every publish response is an undocumented part of the wire contract. One sentence in the Publish
  section, and the T44 structural limitation itself (one published bundle serves exactly one
  first-contact sender), belong in the retained-limitations list for AC-10
  (`t44-multisender-diagnosis.md:194-224` already drafted both).

---

## 4. Clean areas checked with no finding

Injection (no SQL, no shell, no `eval`/`Function`, no template rendering anywhere in the delta);
XSS and React patterns (not applicable — CLI and Go relay); path traversal (no new filesystem path
is built from network input; `contact export` writes only the operator's own `--out` with
`{flag:"wx", mode:0o600}`, `cli.ts:280`); open redirect (`relayClient.ts:100` sets
`redirect: "error"`); insecure cryptography (no new crypto in the delta; identifiers and mailbox ids
remain full untruncated SHA-256, `cryptoutil/signatures.go:14-17`); hardcoded secrets (none
introduced; the store key is still read from the env var named by `store_key_env`); CSRF (no
browser context, no cookies); IDOR on the new field (`claimable` describes only the caller's own
publication).

---

## 5. Routing audit

- `graph_used`: no — `not-relevant`. Every navigation question here was a known file path from the
  dispatch or a targeted symbol search; the graph would additionally have answered from a build
  predating the T45/T46 edits.
- `wiki_used`: no — `not-relevant`. This is a judgement pass against named `file:line` claims and
  executed behaviour, not an architecture question. The authoritative contract for it is
  `docs/requirements/echolet-cli-prototype/specification.md`, which was read directly.
- `ctx_used`: yes — `keryx ctx rg` for every code search, `keryx ctx run` for every command and
  long-output read.
- `raw_rg_used`: no.
