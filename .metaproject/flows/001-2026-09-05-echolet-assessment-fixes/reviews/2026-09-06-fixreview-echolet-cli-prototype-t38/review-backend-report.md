# Backend Fix Review Report — T38 (F-004, F-005, F-006 + T34-I-001/002/003)

## Verdict: APPROVE_WITH_SUGGESTIONS

STATUS: DONE

## Summary

All three assigned relay findings are genuinely fixed, not papered over. F-004's
read-modify-write is a single Badger transaction with conflict detection actually
enabled, and the 64-attempt replay can neither mask nor spin. F-005's retention is
`min(declared, now+cap)` floored at `now`, expiry is filtered before either poll
bound is consumed, and an identical retry returns before any write. F-006 bounds
every enumerated v1 decoder site, derives the send-route bound from
`MaxMessageBytes`, and makes the decoded ciphertext length — not the client's
`size_bytes` — the authority. The three T34 implementer concerns are dispositioned
with real judgements, including a control-flow argument that the start-up backfill
cannot mis-bind anything. Five residual observations are raised (1 minor, 4 info);
none blocks acceptance of the fix wave.

## Review Scope

- Branch: `main` (unborn — no commits; the working tree IS the change set)
- Scope mode: `working-tree` (an empty `git diff` here means nothing)
- Files read: 16 relay source/test files + the CLI transport contract + vendored
  `badger/v4@v4.9.1` `txn.go` / `options.go` for the transaction semantics
- Bounded probe: the five tests anchoring F-004/F-005/F-006 re-run by name, exit 0

## Stats

- blocker: 0
- major: 0
- minor: 1 (R-001, R-002)
- info: 3 (R-003, R-004, R-005)

Assigned-set dispositions: `fixed` x 6, `partially-fixed` x 0, `not-fixed` x 0,
`fixed-with-new-risk` x 0.

---

## Dispositions

### F-004 (blocker) — envelope_id immutable per mailbox → **fixed**

**Same transaction — verified, not assumed.**
`mailbox_repo.go:65-88` performs `txn.Get(key)` and `txn.SetEntry(entry)` inside
one `r.db.Update(fn)` closure. That alone is not sufficient — Badger's optimistic
transactions only make it atomic if the *read* joins the conflict set. It does:

- `badger/v4@v4.9.1/txn.go:446-464` — on an update txn, `Get` calls
  `txn.addReadKey(key)` **before** the lookup, so a key that turns out missing is
  still tracked (this is exactly the first-write race in the finding).
- `txn.go:489-498` — `addReadKey` appends unconditionally for `txn.update`.
- `options.go:175` — `DefaultOptions` sets `DetectConflicts: true`, and
  `storage.go:15` opens with `badger.DefaultOptions(dataDir)`, so it is on.

So two concurrent first-writes of different envelopes under the same key cannot
both commit: the loser gets `badger.ErrConflict`, replays, re-reads the now-stored
different bytes, and returns `ErrEnvelopeIDConflict`.

**The retry cannot mask a genuine conflict.** `model.ErrEnvelopeIDConflict`
(`model/mailbox_envelope.go:8`) is a distinct sentinel from `badger.ErrConflict`,
so `mailbox_repo.go:254` (`!errors.Is(err, badger.ErrConflict)`) returns it on the
first attempt without consuming a retry. **It cannot spin:** `attempt < 64`
(`:252`, const at `:23`), one synchronous transaction per attempt, no inner loop.

**Wire mapping:** `mailbox_handler.go:102-114` → HTTP 409 / `ENVELOPE_ID_CONFLICT`,
already in `relayClient.ts:11`'s accepted `remoteCodes`; every other storage error
keeps 500 / `INTERNAL_ERROR`. Idempotent replay returns `nil` at `:73-77` before
any write, so the accepted record and its deadline survive.

**Test:** `mailbox_envelope_lifecycle_test.go:33-87` asserts 200 / 200 / 409, the
exact error code, and that the stored ciphertext and `size_bytes` are unchanged.
Probe: passes.

Residual (info): after 64 exhausted attempts the caller receives
`badger.ErrConflict` → HTTP 500, and the loop has no backoff. Bounded and
non-corrupting; see R-004's sibling note below — not raised as a separate finding
because 64 same-key collisions on a local prototype relay names no reachable
trigger.

### F-005 (major) — expiry-aware retention and selection → **fixed**

- **`min(declared, now+cap)` floored at `now`, never zero:**
  `mailbox_repo.go:229-246`. `deadline = ExpiresAtMs/1000`; capped at
  `now.Add(retentionCap).Unix()` (`:233`); floored at `now.Unix()` (`:236`). The
  cap comes from config through `router.go:32`, and `SetRetentionCap` ignores a
  non-positive value (`:42-47`) so an unconfigured `Config` cannot collapse
  retention. Because the floor is `now.Unix()`, the value written to
  `badger.Entry.ExpiresAt` is never 0 — which Badger reads as "keep forever" — so
  it is neither zero nor unbounded.
- **Expired excluded before the batch limit:** `GetEnvelopeBatch`
  `mailbox_repo.go:183-185` returns from the value callback *before* `usedBytes`,
  `batch.Envelopes` or the `>= limit` check at `:170` are touched, so an expired
  record consumes neither the count bound nor the byte bound. `GetEnvelopes`
  `:117-121` increments `count` only for live envelopes.
- **Identical retry cannot extend expiry:** `:73-77` returns `nil` on
  `bytes.Equal` before `SetEntry`, so the original `ExpiresAt` is never rewritten.
  `expiresAt` is computed at `:63` but deliberately unused on that branch.
- **Submission side:** `mailbox_handler.go:97-100` rejects an already-past
  `expires_at_ms` with 400 / `INVALID_SCHEMA` and never reaches the store.

**Tests:** `mailbox_repo_test.go:33-113` (three retention subtests: below-cap,
above-cap, identical-retry) and `:115-153` (an expired record sorting first inside
the prefix must not consume `limit=1`). Probe: passes.

Note: `cleanup_service.go:41-46` remains a no-op, and that is now correct — the
per-entry `ExpiresAt` plus the read-side filter enforce the lifetime, so no
sweeper is required.

### F-006 (blocker) — bounded v1 bodies and real ciphertext length → **fixed**

- **Every v1 decoder site bounded.** `decodeJSONRequest`
  (`request_body.go:42-56`) wraps `r.Body` in `http.MaxBytesReader` before
  `encoding/json` and answers `http.MaxBytesError` with 413 / `PAYLOAD_TOO_LARGE`
  and any other decode error with 400 / `INVALID_JSON`. All six sites use it:
  `mailbox_handler.go:77, 142, 199, 306`, `device_record_handler.go:38`,
  `prekey_bundle_handler.go:28`.
  Enumeration: `keryx ctx rg "json.NewDecoder|decodeJSONRequest|MaxBytesReader|io.ReadAll" apps/relay`
  → 17 matches / 7 files. The only remaining raw `json.NewDecoder(r.Body)` is the
  already-bounded v2 sibling (`signal_prekey_bundle_v2.go:31-32`);
  `validation/signal_prekey_bundle_v2.go:158` decodes from an already-bounded
  in-memory buffer, not from the socket. No unbounded site remains.
- **The send-route limit stays above `MaxMessageBytes`.**
  `mailbox_handler.go:67-73`: `envelopeBodyLimit() = maxMessageBytes + 64 KiB`,
  with a `defaultMaxMessageBytes` (262144) substitution when unset. By
  construction it is strictly greater than `MaxMessageBytes` and it *tracks* the
  config, so the drift T34-I-002 warned about is now structurally impossible.
- **`ValidateMailboxEnvelope` checks the real ciphertext length.**
  `validate.go:85-94`: `len(Ciphertext) > maxBytes` → 413;
  `SizeBytes > maxBytes` → 413; `SizeBytes != len(Ciphertext)` → `INVALID_SCHEMA`.
  The decoded string, not the declaration, is the authority.
- **Variable-length arrays bounded:** `mailbox_handler.go:315-318` (ack
  `envelope_ids` vs the configured batch, falling back to 1000) and
  `prekey_bundle_handler.go:37-40` (`one_time_prekeys` vs 1000).

**Test:** `request_body_limit_test.go:43-93` drives an 8 MiB probe body at all six
sites and asserts a 4xx plus at most 4 MiB consumed. Probe: passes.

Residual: see **R-001** — the envelope's variable-length *string* fields are still
unvalidated, which F-006's `suggested_fix` also asked for. It does not resurrect
the finding's stated failure (the byte limit is enforced, the body is bounded, no
memory exhaustion), so the disposition stays `fixed` and R-001 is raised
separately as `minor`.

### T34-I-001 (major) — start-up backfill, no completion marker → **fixed** (accept as-is)

**Judgement: acceptable for this prototype, and it cannot corrupt or mis-bind
anything — including under concurrency, which is itself unreachable here.**

1. **No in-process concurrency with live publication.** `main.go:31` calls
   `router.NewRouter`, which runs the backfill at `router.go:39`, and only then
   `main.go:34` calls `http.ListenAndServe`. No HTTP handler can execute while
   the scan runs. This is a call-ordering guarantee, not a timing assumption.
2. **No cross-process concurrency.** `storage.go:15-18` opens Badger with
   `DefaultOptions` and no `BypassLockGuard`, so the directory lock prevents a
   second relay from opening the same `DataDir`.
3. **Mis-binding is not representable even if (1) and (2) were removed.** The
   binding key is `device_mailbox:<DeriveMailboxID(record.IdentityID)>:<device_id>`
   and the value written is that *same* `record.IdentityID`
   (`device_record_repo.go:175-184`). Key and value are both pure functions of one
   identity, so every writer of a given key writes byte-identical bytes — the
   first-writer-wins guard at `:176-179` is value-preserving, not a race with a
   winner. Two identities cannot share a binding key short of a SHA-256 collision
   (`cryptoutil/signatures.go:14-17`). Key and record content also cannot diverge:
   `Save` (`:50-53`) derives both the record key and the binding from
   `record.IdentityID`, and `ValidateDeviceRecord` (`validate.go:27-30`) verifies
   the record's signature against that same `IdentityID`.
4. **Cost of no marker.** One prefix scan of `device_record:*` per start on a
   local prototype relay. The *absence* of a marker is what makes a transient
   backfill failure self-heal on the next start (`router.go:39-41` logs and
   continues) — for this scope that is the better trade, and adding a marker would
   convert a self-healing failure into a permanent one.

Two sub-issues are raised as **R-002** (minor) and **R-003** (info). Neither
blocks acceptance.

### T34-I-002 (minor) — hand-chosen body limits → **fixed**

`envelopeBodyLimit()` (`mailbox_handler.go:67-73`) now derives the send bound from
config, exactly as the concern asked. **The `MaxMessageBytes + 64 KiB` derivation
is sound:**

- The bound must exceed the largest legal body: `{"envelope":{...}}` with a
  ciphertext of at most `MaxMessageBytes` characters plus twelve other fields.
  Those fields are two UUIDs (36), two device UUIDs (36), three base64url
  identity/mailbox ids (43), plus fixed keys and numbers — a few hundred bytes at
  CLI-generated sizes.
- Ciphertext is base64url (`outbound.ts:83`), which contains no JSON-escapable
  character, so the encoded field length equals the string length with no
  expansion factor.
- 64 KiB is therefore ~100x the real overhead, while `262144 + 65536 = 327680`
  stays a factor of three below the 1 MiB response ceiling the client enforces
  (`relayClient.ts:96`). Generous without being a memory-exhaustion vector.

`compactRequestBodyLimit` (64 KiB) and `envelopeRequestBodyLimit` (1 MiB, prekey
publication) remain constants, but neither route carries `MaxMessageBytes`-scaled
data and both have their arrays separately bounded, so no coupling is missing.

One asymmetry is raised as **R-004** (info).

### T34-I-003 (minor) — stricter `size_bytes` semantics → **fixed**

The Go and TypeScript sides agree on the same quantity. `outbound.ts:83` writes
`size_bytes: Buffer.byteLength(ciphertext)`; `inbound.ts:51` rejects an envelope
whose `size_bytes !== Buffer.byteLength(ciphertext)`; `validate.go:85` compares
against `len(envelope.Ciphertext)`, which in Go is the byte length of the decoded
string — the same number for the same bytes on both sides, ASCII or not. So no
CLI-generated envelope can be rejected by the new equality check, and the relay is
now strictly *more* consistent with the receiver than before.

The gap the concern names is real but documentary: `packages/protocol`
(`src/types/mailboxEnvelope.ts:17`) types the field as `z.number()` only, and
`keryx ctx rg size_bytes docs/requirements` returns zero hits — the equality is a
convention held identically by three implementations rather than a written rule.
Raised as **R-005** (info); prototype scope makes it a documentation item, not a
change request.

---

## Findings

### [R-001] Envelope string fields are still unbounded, so an oversized key returns 500 instead of 400

- **Severity**: minor — does **not** block acceptance
- **File**: `apps/relay/internal/validation/validate.go:72`
- **Problem**: `ValidateMailboxEnvelope` bounds the ciphertext but places no
  length bound on `EnvelopeID`, `RecipientMailboxID`, `SenderIdentityID`,
  `MessageID` or the device ids. F-006's `suggested_fix` asked for other
  variable-length request fields to be bounded in the same decoder contract; the
  arrays were done (`mailbox_handler.go:315`, `prekey_bundle_handler.go:37`), the
  envelope's strings were not.
- **Why it matters**: the store key is
  `mailbox:<recipient_mailbox_id>:<envelope_id>` (`mailbox_repo.go:262`). Badger
  rejects a key over 65000 bytes (`badger/v4@v4.9.1/txn.go:352, 363-367`), so a
  send whose `recipient_mailbox_id` exceeds that — comfortably inside the 327680
  body bound — fails inside `SaveEnvelope` and surfaces as HTTP 500 /
  `INTERNAL_ERROR` (`mailbox_handler.go:112`) on purely attacker-controlled input,
  where a 4xx is the correct answer. No content leaks (the message is a fixed
  string) and the body cap prevents amplification, which is why this is `minor`
  and not a reopening of F-006.
- **Fix**: bound the identifier fields in `ValidateMailboxEnvelope` — e.g. reject
  any of them longer than 256 bytes with `INVALID_SCHEMA`, alongside the existing
  emptiness checks.

### [R-002] The backfill is the one `device_mailbox` writer without the bounded conflict retry

- **Severity**: minor — does **not** block acceptance
- **File**: `apps/relay/internal/storage/repository/device_record_repo.go:156`
- **Problem**: `Save` retries `badger.ErrConflict` up to 64 times (`:48-58`), and
  `MailboxRepository.update` does the same (`mailbox_repo.go:250-259`), but the
  backfill's per-record `r.db.Update` at `:156-161` has no retry and returns on the
  first error, abandoning every record after it.
- **Why it matters**: unreachable today, because the backfill runs before
  `ListenAndServe` (`main.go:31, 34`) and Badger's directory lock excludes a second
  writer — which is precisely why this is `minor` rather than `major`. It is
  reported as a class divergence: the invariant "every writer of the
  `device_mailbox` key space retries a conflict" now has one exception, and the
  next change that moves the backfill off the pre-serve path would make it real.
- **Fix**: route the backfill's write through the same bounded-retry helper the
  other two writers use, or continue past a per-record failure instead of
  returning.

### [R-003] The backfill materialises every device record before writing

- **Severity**: info
- **File**: `apps/relay/internal/storage/repository/device_record_repo.go:126`
- **Problem**: the scan appends every decoded record to `pending` (`:142`) and only
  then writes, so peak memory grows with the total device-record count; and a
  single record that fails `json.Unmarshal` (`:136`) aborts the whole scan, so no
  legacy binding is written that start (`router.go:39-41` logs and continues).
- **Why it matters**: acceptable at prototype scale and self-healing on restart.
  Recorded so the trade is explicit rather than accidental.
- **Fix**: none required for the prototype. If it ever matters, write each binding
  inside the iteration and skip an undecodable record rather than aborting.

### [R-004] `envelopeBodyLimit()` and `ValidateMailboxEnvelope` disagree about an unset `MaxMessageBytes`

- **Severity**: info
- **File**: `apps/relay/internal/api/handler/mailbox_handler.go:86`
- **Problem**: `envelopeBodyLimit()` substitutes `defaultMaxMessageBytes` when
  `h.maxMessageBytes <= 0` (`:68-71`), but `:86` passes the raw `h.maxMessageBytes`
  into `ValidateMailboxEnvelope`. With `ECHOLET_MAX_MESSAGE_BYTES=0` the route
  accepts a 327680-byte body and then rejects every envelope with
  `PAYLOAD_TOO_LARGE`.
- **Why it matters**: fail-closed, and arguably the right reading of "maximum 0".
  Flagged only because the two code paths assign different meanings to the same
  unset value.
- **Fix**: resolve the effective maximum once and pass it to both.

### [R-005] `size_bytes` equality is a convention, not a written contract

- **Severity**: info
- **File**: `packages/protocol/src/types/mailboxEnvelope.ts:17`
- **Problem**: the relay now enforces `size_bytes == len(ciphertext)`
  (`validate.go:92`) and the CLI receiver enforces the same (`inbound.ts:51`), but
  the protocol schema types the field as `z.number()` and `docs/requirements`
  never mentions `size_bytes` (`keryx ctx rg size_bytes docs/requirements` → 0
  hits).
- **Why it matters**: three implementations agree by coincidence of authorship.
  A fourth sender has nothing normative to read.
- **Fix**: state the semantics in the specification, or tighten the protocol
  schema with a refinement. Documentation item; no code change required for this
  flow.

---

## Non-negotiable criteria

| # | Criterion | Result | Evidence |
|---|---|---|---|
| 1 | No test weakened | **met** | For every file in this set the test mtime precedes the implementation mtime: tests `17:15:17` / `17:16:02` / `17:16:59`, implementation `17:25:50`–`18:06:50`. Assertions are strict (exact 409 + exact error code + stored-content equality; ±1s retention tolerance; oversized-probe read cap). The one permissive assertion — `INVALID_SCHEMA` **or** `ENVELOPE_EXPIRED` at `mailbox_envelope_lifecycle_test.go:108` — is in the RED test written *before* the implementation, so it is a pre-authorised choice of wire code, not a loosened assertion. |
| 2 | No strict schema loosened | **met** | `relayClient.ts:24` `nextCursorSchema = z.union([z.string().min(1).max(256), z.null()])`, used at `:66-67` on a `.strict()` object inside the `.strict()` success envelope (`:10`). No `.optional()`, no `.passthrough()`, no `any`; unknown fields still rejected. Go emits `*string` (`mailbox_handler.go:266-270`) carrying the fixed server-controlled token `"more"` (`:62`) or `nil` → JSON `null`, so the 256-char bound can never be exceeded and no sender-derived value reaches it. Contracts agree. |
| 3 | No secret leakage | **met** (for this set) | Every log site in the relay enumerated: `keryx ctx rg "slog\.(Info\|Error\|Warn\|Debug)" apps/relay` → 10 matches / 5 files, none carrying a body, ciphertext, key or envelope. `decodeJSONRequest` writes fixed strings and never the decoder error (`request_body.go:48-52`); `SendEnvelope` writes fixed strings for storage errors (`mailbox_handler.go:104-113`); `router.go:40` logs a backfill error value only. F-001 and F-009 are outside this set. |
| 4 | Exit-code contract intact | **met** | The only new HTTP status the relay emits is 413. `relayClient.ts:106` marks it non-retryable (only 429 and 5xx are retryable), and `cli.ts:327` maps a non-retryable `RelayError` to `PROTOCOL_REJECTED` / exit 3 — the same bucket 400 already occupied. 409 / `ENVELOPE_ID_CONFLICT` was already an accepted `remoteCode` (`relayClient.ts:11`). Neither widened nor narrowed. |
| 5 | Prototype scope respected | **met** | No finding here demands production hardening, mobile support, deployment or external audit. R-001/R-002 are input validation and an internal class divergence; R-003/R-004/R-005 are recorded trades and a documentation gap. |

## Positive notes

- The F-004 fix is correct for the *right* reason: it relies on Badger's read-set
  conflict detection rather than on a check-then-write that merely looks atomic,
  and the retry helper distinguishes the storage-level conflict from the
  domain-level one so neither can be mistaken for the other.
- `GetEnvelopeBatch` skipping expired records inside the value callback, before
  either bound is touched, is the structurally correct placement — the alternative
  (filter after selection) would have re-introduced the wedge F-005 describes.
- `envelopeBodyLimit()` deriving from config closes T34-I-002 by construction
  rather than by picking a larger constant.

## Routing audit

- `graph_used`: no — not-relevant. The change set was enumerated by the dispatch's
  `files_to_read` plus `keryx ctx rg` class sweeps; no blast-radius question arose
  that the graph would answer better, and the working tree is uncommitted so a
  graph answer would predate it.
- `wiki_used`: no — not-relevant. This is a fix-verification pass against named
  findings and named files, not an architecture or domain question.
- `ctx_used`: yes — `keryx ctx rg` for every code search (decoder sites, log sites,
  `next_cursor`, `size_bytes`, `DeriveMailboxID`, badger internals),
  `keryx ctx read` for compact file reads, `keryx ctx run` for the mtime check and
  the bounded test probe.
- `raw_rg_used`: no.
