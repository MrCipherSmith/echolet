# T38 fix review — review-highload

Flow `001`, dispatch `001-T38-review-highload`.
Assigned set: **F-008, F-009, F-010, F-011** plus an explicit judgement on
implementer concern **T35-I-001**.

## Review scope

- Branch: `main` (unborn — no commits, every file untracked). An empty `git diff`
  is not an empty change set; the **working tree** was reviewed against the T28
  finding evidence and the T33/T35 implementation reports.
- Read-only. No source, test or configuration file was modified.
- Test suites were not re-run wholesale (T37 did that). Two bounded probes were
  run: one targeted Go `-run` filter, and one two-process SQLite locking probe in
  the scratchpad (no repository file touched).
- Load profile: local single-user CLI prototype against a loopback relay.

## Verdict

**DONE_WITH_CONCERNS.** All four assigned findings are fixed at the root cause.
Nothing found blocks acceptance of the fix wave. Four new items are reported: one
`major` that is **pre-existing, not introduced by these fixes**, two `minor`, one
`info`.

| Item | Disposition | Blocks the wave? |
|---|---|---|
| F-008 | `fixed` | no |
| F-009 | `fixed-with-new-risk` | no |
| F-010 | `fixed` | no |
| F-011 | `fixed` | no |
| T35-I-001 | judged **acceptable for the prototype**, recorded as `minor` | no |

---

## F-008 — concurrent same-id send duplicates history and envelope — `fixed`

**What the fix is.** `apps/cli/src/runtime/outbound.ts:45` now carries the comment
"Optimization only", and the authoritative re-read moved *inside* the mutation
transaction at `outbound.ts:71`:

```
const committed = tx.get(keyFor(input.messageId));
if (committed) return { record: decode<Outbox>(committed), existed: true };
```

`existed: true` short-circuits to `settle()` at `:91`, so no second
`client.encrypt`, no second `MailboxEnvelopeSchema.parse` (no second
`envelope_id`) and no second `appendHistory` can run.

**The orchestrator's question: does it serialise two independent processes, or
only two objects in one process?** Two independent processes. The mechanism is
not the in-process `tail` queue at `EncryptedSqliteStore.ts:46` — that only
orders transactions within one store object. It is:

- `EncryptedSqliteStore.ts:25` — `PRAGMA busy_timeout = 0`;
- `EncryptedSqliteStore.ts:61` — every transaction opens with `BEGIN IMMEDIATE`,
  which takes SQLite's RESERVED lock on the database *file* (a `fcntl` lock,
  cross-process, in the default rollback-journal mode);
- `EncryptedSqliteStore.ts:64` — `this.read()` runs *after* that lock is held, so
  the snapshot the recheck reads is the latest committed state, not a cached one.

**Bounded probe (scratchpad only, two real OS processes, same DB file):**

```
HOLDER_IN_TXN                                  # process A inside BEGIN IMMEDIATE
CONTENDER_BLOCKED: database is locked          # process B's BEGIN IMMEDIATE fails at once
HOLDER_COMMITTED
READER_SEES_COMMITTED_ROW: {"v":"A"}           # process C, inside BEGIN IMMEDIATE, sees A's commit
```

So two processes can never both be inside the mutation transaction, and the
process that runs second reads the first one's committed `cli:outbox:<id>`
record. The duplicate-envelope interleaving F-008 described is unreachable.

**Losing-process behaviour (info, not a defect).** When two processes genuinely
overlap, the loser's `BEGIN IMMEDIATE` raises `database is locked`; `Profile.transact`
(`apps/cli/src/runtime/profile.ts:76-85`) converts any non-operation rejection to
`PersistenceError`, which `cli.ts:325` maps to exit 5. That is the pre-existing,
deliberately-tested contract (`apps/cli/src/commands/cli.processFailures.test.ts:138-145`
builds the exit-5 path from exactly this lock), and a retry then takes the
idempotent `settle()` path. Correctness-preserving, no duplicate.

**Test integrity.** `outbound.concurrentSend.test.ts` (mtime 17:22:06) predates
`outbound.ts` (17:41:42) and was not edited afterwards. `expect.soft` still fails
the test; it only lets one run report all four duplicates. The barrier
(`holdFirstMissingOutboxRead`, `:84-112`) is test-only instrumentation on
`EncryptedSqliteStore.prototype.transaction` (concern `T33-I4`) — acceptable,
because the property it exercises does not depend on the barrier: the probe above
establishes the cross-process guarantee independently.

---

## F-009 — poll batch can exceed the client byte bound and never drain — `fixed-with-new-risk`

### The three points the orchestrator asked to confirm

**1. Budget computed from actual stored bytes, not an estimate — confirmed.**
`apps/relay/internal/storage/repository/mailbox_repo.go:189`:

```
encodedBytes := int64(len(val)) + envelopeSeparatorBytes
```

`val` is the Badger value, which `SaveEnvelope` wrote as `json.Marshal(envelope)`
at `mailbox_repo.go:57` of the same `model.MailboxEnvelope` type. The poll path
re-marshals the same struct through `json.NewEncoder` at `mailbox_handler.go:274`,
so the byte count is exact, not approximated. Both bounds are applied *during*
Badger iteration (`mailbox_repo.go:169-205`), so an over-budget batch is never
materialised. The handler passes `pollEnvelopeByteBudget = 1 MiB − 4 KiB`
(`mailbox_handler.go:52,56`) against the client's hard `size > 1024*1024`
rejection at `relayClient.ts:96`. `TestMailboxPollHonoursAggregateResponseByteBudget`
(`mailbox_poll_capacity_test.go:85-91`) asserts the **actual recorder body length**,
not a computed estimate.

**2. A single maximum-size envelope is always delivered — confirmed.**
`mailbox_repo.go:190` guards the byte check with `len(batch.Envelopes) > 0`, so
the first selected envelope is exempt from the budget. At the default
`ECHOLET_MAX_MESSAGE_BYTES = 262144` this exemption can never re-create the
wedge, because a single stored envelope is itself bounded: `SendEnvelope` wraps
the body in `http.MaxBytesReader` at `request_body.go:43` with
`envelopeBodyLimit() = MaxMessageBytes + 64 KiB = 327680`
(`mailbox_handler.go:67-73`), which is below the client's 1 MiB read bound even
for an envelope padded in its unvalidated non-ciphertext fields. Pinned by
`TestMailboxPollAlwaysReturnsAtLeastOneMaximumSizeEnvelope`.

**3. Cursor is server-controlled and not derived from `envelope_id` — confirmed.**
`mailbox_handler.go:62` defines `pollMoreEnvelopesCursor = "more"`, a package
constant; `:266-270` is the only writer and it copies that constant. No stored
envelope field reaches `next_cursor`. The client additionally bounds it at
`relayClient.ts:24` (`z.string().min(1).max(256)`), so even a hostile relay
cannot inflate the response through this field.

### Schema widening (non-negotiable criterion 2) — held

`relayClient.ts:24` — `z.union([z.string().min(1).max(256), z.null()])`: a closed
union, no `.optional()`, no `.nullish()`, no `z.any()`. The enclosing response
object at `:66-67` is still `.strict()`, so the pre-existing `unknown-poll`
assertion (`inbound.test.ts:163`) still rejects an unknown field. The request
schema `pollRequestSchema` (`:17-20`) extends the `.strict()` `authorizationSchema`,
and zod's `.extend()` preserves the unknown-keys policy. Go and TypeScript agree:
`batch_size` `1..100` on the wire (`relayClient.ts:19`) vs
`pollBatchSize` clamping to `h.maxMailboxBatch` (`mailbox_handler.go:286-295`),
negative rejected with `400 INVALID_SCHEMA` at `:207-210`; `poll_batch_size`
is `1..100` in both `apps/cli/src/runtime/config.ts:14` and
`docs/requirements/echolet-cli-prototype/schemas/client-config.schema.json:23`,
so the client can never omit or under-specify `batch_size` and let a
`ECHOLET_MAX_MAILBOX_BATCH > 100` server exceed the client's
`z.array(...).max(100)`.

### Why `fixed-with-new-risk`

The reported defect is gone and verified. Two new, non-blocking risks the fix
brought with it are reported below as **N-002** (the sole client discards the new
`next_cursor` signal entirely) and **N-003** (the byte budget is a compile-time
constant with no enforced relationship to `ECHOLET_MAX_MESSAGE_BYTES` — this is
concern `T35-I-001`).

---

## F-010 — rate limiter held its global mutex across the handler — `fixed`

**No I/O and no handler call under the lock — confirmed.** The quota decision is
now the whole of `allow()` (`apps/relay/internal/middleware/rate_limit.go:86-101`):
`Lock` at `:87`, `defer Unlock` at `:88`, and the function body is
`rl.now()`, `pruneLocked`, one map read, one map write, one integer compare.
`Middleware` (`:66-81`) calls `allow` as a plain boolean expression at `:72`;
`next.ServeHTTP` at `:73` and the `429` write at `:77-79` both execute after the
lock has been released with the function. There is no other `mu.Lock` on a
request path (`SetClock`/`TrackedClients` at `:50` and `:60` are the test seam).
`router.go:24-26` confirms this is still the single global limiter installed
before all routes, and neither `Recover` nor `RequestID` takes a shared lock.

**Prune cannot become unbounded work — bounded, with a caveat.**
`pruneLocked` (`:104-115`) returns immediately unless
`now.Sub(rl.lastPruneAt) >= idleBucketPruneInterval` (1 minute of limiter time),
so the O(len(clients)) sweep is amortised to roughly one pass per minute rather
than per request. Its size is bounded by the number of distinct hosts observed in
the preceding interval, not by lifetime traffic. See **N-004** for the residual
`info`-level note (there is no max-entry cap between sweeps, and the sweep itself
is a single O(N) pass under the lock).

Probe: `go test -race -run 'TestRateLimiter…' ./internal/middleware/...` → `ok`.

---

## F-011 — quota keyed by TCP source port, buckets never pruned — `fixed`

**Key is the normalized host — confirmed.** `quotaKey` (`rate_limit.go:121-134`)
strips the port with `net.SplitHostPort` and canonicalises IP literals through
`net.ParseIP(host).String()`, so IPv6 spellings collapse to one bucket; a
port-less address is used verbatim rather than guessed at.
`rate_limit.go:72` is the single call site.

**Untrusted forwarding headers cannot mint a bucket — confirmed by absence.**
The quota identity is derived from `r.RemoteAddr` only. `X-Forwarded-For` /
`X-Real-IP` appear nowhere in `rate_limit.go` outside the doc comment at `:20-26`
that states the policy explicitly, and no other middleware rewrites `RemoteAddr`
(`request_id.go` sets a response header only; `router.go` installs nothing else
ahead of the limiter). Pinned by `TestRateLimiterIgnoresForwardedHeadersByDefault`.
Declaring proxy support as an unimplemented explicit opt-in rather than inferring
it from a header is the right call and is documented on the type.

**Pruning cannot drop an active bucket — confirmed.** `pruneLocked:111` deletes
only when `now.After(record.resetAt)`; an in-window bucket has `resetAt` in the
future and survives. Counting semantics are unchanged and correct: `:94-97` sets
`count = 1` on a fresh or expired bucket, `:99-100` refuses once `count > limit`.

**Cannot grow without bound — bounded.** Every expired bucket is reclaimed by the
sweep; the map's size is bounded by distinct hosts in the last prune interval
plus the active window. It does not grow with lifetime traffic. Residual note in
**N-004**.

---

## T35-I-001 — judgement

**Claim.** `ECHOLET_MAX_MESSAGE_BYTES` (`config.go:13`) and the poll byte budget
(`mailbox_handler.go:52`, a compile-time constant) are independent, with nothing
enforcing a relationship. Above roughly 1 MiB the relay accepts, stores and
delivers envelopes the CLI cannot read.

**Verified, and slightly worse than stated.** The claim is real and the mechanism
is exactly as described: the "always deliver the first envelope" exemption at
`mailbox_repo.go:190` correctly refuses to starve a large envelope, so an
oversized one is returned in a response above the client's 1 MiB bound
(`relayClient.ts:96`), which throws the non-retryable `INVALID_RELAY_RESPONSE`
→ exit 3, nothing is acked, and F-009's wedge returns in a new form for that
mailbox. The tree already demonstrates the storage half:
`TestSendEnvelopeBodyLimitIsDerivedFromMaxMessageBytes` stores a 2 MiB-ciphertext
envelope with `200 OK` at `mailbox_poll_capacity_test.go:208-214`.

What the implementer did not note is that the coupling **regressed** rather than
merely remaining unenforced: before the T34-I-003 fix, the hand-pinned 1 MiB
`envelopeRequestBodyLimit` accidentally capped the stored envelope below the poll
budget. Deriving the body limit from `cfg.MaxMessageBytes` (correctly, per
T34-I-003) removed that accident and put nothing in its place.

**Judgement: acceptable for this prototype. Recorded as `minor`, not blocking.**
Reasons: unreachable at the shipped default (262144); reachable only by an
operator deliberately raising an env var on a relay they run themselves on
loopback; no data is corrupted or lost within the retention window; and the
derived body limit is the correct design — the missing piece is a one-line
guard, not a redesign. Recorded as **N-003** with the suggested guard.

---

## New findings

Ranked by severity. **None of these blocks acceptance of the fix wave.**

### [N-001] `major` — one unacceptable envelope aborts the whole poll batch and wedges the mailbox

*Pre-existing; NOT introduced by the T33/T35 fixes. Reported because it is a live
mailbox-wedge in the same class F-009 addresses, and it sits in a file this wave
changed.*

- **File**: `apps/cli/src/runtime/inbound.ts:47`
- **Pattern**: Async/Queues E2 — poison pill with no dead-letter path
- **Mechanism**: `accept()` processes the whole batch inside a *single*
  `profile.withRuntime` transaction (`:47-78`). Any envelope in the batch that
  fails a check throws out of the loop: `INVALID_ENVELOPE` (`:53`),
  `CONTACT_NOT_TRUSTED` (`:55`), `CONTACT_PIN_MISMATCH` (`:57`, `:61`), a zod/
  UTF-8 throw from `base64.parse`/`wrapperSchema.parse` (`:62-63`),
  `MESSAGE_ID_CONFLICT` (`:68`), `INVALID_ENVELOPE` (`:75`). The throw rolls the
  transaction back and propagates out of `poll()`, so `ackPending()` at `:42` is
  never reached and **nothing in the batch is acked**.
- **Failure mode**: `/v1/messages/send` performs no sender authentication
  (`mailbox_handler.go:75-114` validates shape and expiry only), so anyone who
  knows a recipient's `identity_id` — which is what a contact card publishes —
  can post one envelope from an unpinned sender. From then on every
  `echolet poll` exits 3 and no legitimate message is ever delivered to that
  mailbox again. The blocking envelope persists until the 7-day retention cap
  (`mailbox_repo.go:19`), at which point every message queued behind it that also
  aged out is permanently lost. Trigger is one request, not a load level.
- **Fix**: skip-and-continue instead of abort — record the offending
  `envelope_id` in a local quarantine key and add it to the ack set so the
  mailbox drains, or process each envelope in its own transaction and aggregate
  the rejections into the `poll` result. The existing `CONTACT_NOT_TRUSTED`
  guarantee is preserved either way: the point is not to decrypt it, it is not to
  let it block the queue.
- **class_scope**: sites `inbound.ts:47` (the single enclosing transaction),
  `:53`, `:55`, `:57`, `:61`, `:62`, `:63`, `:68`, `:75`. Enumerated with
  `keryx ctx rg "throw new InboundError|\.parse\(" apps/cli/src/runtime/inbound.ts`
  — every throw site inside the batch loop; all nine share the one transaction,
  and `accept()` is the only consumer of a poll batch.

### [N-002] `minor` — the CLI discards the `next_cursor` remaining-work signal

*Introduced by the F-009 fix.*

- **File**: `apps/cli/src/runtime/inbound.ts:41`
- **Mechanism**: `poll()` awaits `accept(batch.envelopes)` and returns
  `{ received: batch.envelopes.length }` at `:43`. `batch.next_cursor` — the
  field the relay, the docs and both schemas were widened for — is never read,
  never looped on and never surfaced. `cli.ts:299-305` prints only that object.
- **Failure mode**: an operator polling a mailbox holding eight maximum-size
  envelopes sees `{"received":3}` with nothing to distinguish "drained" from
  "five still queued". The mailbox is no longer wedged (successive `poll`
  invocations do drain it, which is why F-009 is fixed and not partially fixed),
  but the drain loop exists **only in the test** —
  `relayClient.pollCapacity.test.ts:106-119` drives it, the runtime does not.
- **Fix**: either surface it (`{ received, more: batch.next_cursor !== null }`)
  or have `poll()` loop while `next_cursor !== null` under a bounded iteration
  cap. Surfacing it is the smaller change and keeps one poll per invocation.

### [N-003] `minor` — no enforced relationship between `ECHOLET_MAX_MESSAGE_BYTES` and the poll byte budget

*This is concern `T35-I-001`; see the judgement section above for the reasoning.*

- **File**: `apps/relay/internal/api/handler/mailbox_handler.go:52`
- **Mechanism**: `pollEnvelopeByteBudget` is a compile-time constant derived from
  the client's 1 MiB bound; `cfg.MaxMessageBytes` is free-form env input with no
  validation anywhere (`config.go:21-27` calls `env.Parse` and returns).
  `envelopeBodyLimit()` now follows `MaxMessageBytes` upward, so a configured
  value near or above 1 MiB produces stored envelopes that the first-envelope
  exemption must deliver in an over-bound response.
- **Failure mode**: at `ECHOLET_MAX_MESSAGE_BYTES ≳ 1 MiB`, every poll of a
  mailbox holding one such envelope fails with `INVALID_RELAY_RESPONSE` (exit 3)
  and never acks — F-009's wedge, reachable by configuration. Unreachable at the
  default 262144.
- **Fix**: one guard at startup. Reject (or clamp with a logged warning) a
  `MaxMessageBytes` above `pollEnvelopeByteBudget - envelopeJSONOverheadBytes` in
  `config.Load` or in `NewMailboxHandler`, so the two limits cannot silently
  diverge. A named constant shared by the two sites documents the relationship
  that currently lives only in a comment.

### [N-004] `info` — rate-limiter bucket map has no max-entry cap between sweeps

- **File**: `apps/relay/internal/middleware/rate_limit.go:105`
- **Mechanism**: `pruneLocked` self-throttles to one sweep per minute of limiter
  time, so between sweeps the map accepts one entry per distinct remote host with
  no upper bound, and the sweep itself is a single O(len(clients)) pass taken
  while every other request waits on `rl.mu`.
- **Why `info` and not `major`**: growth is bounded by *distinct hosts per
  minute*, not by lifetime traffic, and source addresses cannot be spoofed over
  a completed TCP handshake. On the documented deployment — a loopback relay for
  a local CLI prototype — the reachable host count is one. Reporting the
  mechanism, not demanding a fix: raising it to a bounded LRU would be production
  hardening, which is out of scope here.
- **Related, also `info`**: now that the quota is genuinely per host (F-011), a
  CLI draining a large mailbox spends three requests per poll (challenge, poll,
  ack) against `ECHOLET_RATE_LIMIT_PER_MINUTE=120`, i.e. ~40 polls/minute from
  one host. Ample at `poll_batch_size=50`, and a `429` is classified retryable →
  exit 4, so the contract degrades correctly. Worth knowing, not worth changing.

### [N-005] `info` — `HasMore` can be a false positive when the tail of the mailbox is expired

- **File**: `apps/relay/internal/storage/repository/mailbox_repo.go:170-173`
- **Mechanism**: `len(batch.Envelopes) >= limit` sets `HasMore = true` before the
  next item is examined, so if every remaining item is expired the response
  claims more work when there is none.
- **Consequence**: one extra poll that returns zero envelopes and
  `next_cursor: null`. Benign — it cannot wedge and cannot loop, because the
  false positive clears on the very next poll. Recorded so the next reviewer does
  not re-derive it.

---

## Non-negotiable criteria

| # | Criterion | Result |
|---|---|---|
| 1 | No test weakened | **Met.** For every file in my set the test file's mtime precedes its implementation file's and the test was not touched afterwards: `rate_limit_test.go` 17:53:16 vs `rate_limit.go` 18:05:41; `mailbox_poll_capacity_test.go` 17:54:46 vs `mailbox_handler.go` 18:06:50 / `mailbox_repo.go` 18:06:04 / `request_body.go` 18:06:40; `relayClient.pollCapacity.test.ts` 17:55:56 vs `relayClient.ts` 18:08:05; `inbound.pollBatchSize.test.ts` 17:56:12 vs `inbound.ts` 18:08:14; `outbound.concurrentSend.test.ts` 17:22:06 vs `outbound.ts` 17:41:42. Repo-wide `keryx ctx rg "\.skip\(\|\.only\(\|\.todo\(\|t\.Skip\("` returns zero hits. The four `expect.soft` calls (`outbound.concurrentSend.test.ts:180-183`) still fail the test. Assertions are on measured properties (actual response body length, derived limits), not on literals. |
| 2 | No strict schema loosened | **Met.** `next_cursor` is a closed union on a `.strict()` object with no `.optional()`, no passthrough, no `any` (`relayClient.ts:24,66-67`); the poll request extends a `.strict()` object, and `.extend()` preserves that policy. `inbound.test.ts:163`'s `unknown-poll` rejection still holds. Go and TS bounds agree on `batch_size` and on the ≤100 array size. Noted for the record: the Go decoder has never used `DisallowUnknownFields` (`request_body.go:45`) — pre-existing at all six v1 sites, unchanged by this wave, not a loosening. |
| 3 | No secret leakage | **Met** for the code I reviewed. `rate_limit.go` writes one fixed `429` JSON body and logs nothing. `mailbox_handler.go` and `mailbox_repo.go` contain no logging; every error string is a fixed literal, and the one `err.Error()` pass-through (`mailbox_handler.go:90`) can only carry the fixed messages from `validation/validate.go:73-97`, none of which interpolate ciphertext, `size_bytes` or any envelope field. `relayClient.ts` errors carry a code, a retryable flag and an HTTP status — never the body; the over-limit path cancels the reader and throws `INVALID_RELAY_RESPONSE` without decoding (`:96`). The `EncryptedSqliteStore` zeroes plaintext and key buffers on every path (`:110`, `:122`, `:38`, `:55`). Both new test files state and honour the no-payload rule; padding is inert `"A"` repetition. |
| 4 | Exit-code contract intact | **Met.** `classify` (`cli.ts:323-331`) is unchanged in shape: `PersistenceError` → 5, `ConfigurationError` → 2, `RelayError` → 4 when retryable and 3 otherwise, `Outbound`/`Inbound`/`ProfileError` → 3 (with `INVALID_MESSAGE` → 2). Nothing in the T35 changes mints a new error type: a `429` stays retryable → 4, an over-bound response stays the pre-existing non-retryable `INVALID_RELAY_RESPONSE` → 3, and the SQLITE_BUSY path stays `PersistenceError` → 5. No widening, no narrowing. |
| 5 | Prototype scope respected | **Met.** No finding here demands production hardening, mobile support, deployment or external audit. N-004 is explicitly filed as `info` for that reason, and N-003's remedy is a single startup guard rather than a redesign. |

## Routing audit

- `graph_used`: no — `not-relevant`. The file set was named exhaustively by the
  dispatch and the T28 finding `class_scope` entries; every navigation step was a
  direct read of a named path.
- `wiki_used`: no — `not-relevant`. This is a fix review against concrete finding
  evidence and implementation reports, not an architecture or domain question.
- `ctx_used`: yes — `keryx ctx rg` for all searches, `keryx ctx run` for the Go
  test probe, `keryx ctx read` for the contract schemas.
- `raw_rg_used`: no.
