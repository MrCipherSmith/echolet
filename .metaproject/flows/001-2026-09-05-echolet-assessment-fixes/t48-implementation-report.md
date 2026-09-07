# T48 — GREEN phase for the round-2 residual of HL-N-001, plus R2-002 and R2-L-002

Worker: `task-implementer` · flow `001` · dispatch `001-T48-implement`
Project root: `/Users/Goodea/goodea/projects/echolet`
Date: 2026-09-07 · Node v26.5.0 (`/opt/homebrew/bin/node`) · Go relay built from this tree

## Summary

The RED suite T47 wrote is green, unmodified. Four production changes:

1. **R2-001 path A** — `ValidateMailboxEnvelope` now refuses by *shape*, not only by length, exactly
   the five fields the CLI's wire schema constrains. The relay can no longer store an envelope its
   own client refuses to parse.
2. **R2-001 path B** — the relay gained a real resume position. `next_cursor` is no longer the fixed
   token `"more"`; it is a server-issued position that the poll route accepts back as `cursor` and
   that `GetEnvelopeBatchFrom` honours by continuing past the envelopes it already returned. The CLI
   walks the pages inside one `poll()` while every page so far has yielded nothing.
3. **R2-002** — the identifier-bound class is closed on the two remaining routes.
4. **R2-L-002** — the `reportedRelayCodes` docstring now describes all four conditions.

No test file, `vitest.config.ts` or `test/globalSetup.ts` was edited: 52 test files verified
byte-identical by SHA-256 after the run (§6).

---

## 1. R2-001 path A — shape parity between the Go relay and the TypeScript client

**File:** `apps/relay/internal/validation/validate.go`

The client parses a whole poll response as `z.array(MailboxEnvelopeSchema.strict())`
(`apps/cli/src/transport/relayClient.ts:80`), so *one* stored envelope whose identifiers are merely
short-but-malformed fails the entire batch parse at the transport boundary, before per-envelope
acceptance can isolate anything and before `ackPending()` is reached. `/v1/messages/send` is
unauthenticated, so one POST was enough.

`ValidateMailboxEnvelope` now applies, after the T41 length bound and before the ciphertext checks:

- `envelope_id`, `message_id`, `sender_device_id`, `recipient_device_id` must match
  `clientMailboxUUID`;
- `payload_type` must equal the literal `ciphertext_message`.

Rejections keep the existing `INVALID_SCHEMA` / HTTP 400 shape and name only the field — the
offending value is attacker-supplied and is still never echoed.

### Why that regexp and not `uuidV2`

`clientMailboxUUID` is
`^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000)$`.

It is not a guess. `packages/protocol` resolves **zod 4.0.0**, and its `z.string().uuid()` was
probed field by field before the rule was written:

```
version nibble accepted: 1 2 3 4 5 6 7 8      (0 and 9-f refused)
variant nibble accepted: 8 9 a b A B          (0-7, c-f refused)
nil uuid 00000000-0000-0000-0000-000000000000 accepted
max uuid ffffffff-ffff-ffff-ffff-ffffffffffff REFUSED
hex case: either
```

The relay now refuses exactly this set, so neither side can accept what the other refuses. It is
deliberately a *separate* rule from `validation/signal_prekey_bundle_v2.go`'s `uuidV2`, which is
lowercase-only and does admit the max UUID: that rule governs the v2 prekey routes and was not
touched.

### The three controls the RED suite requires

- A CLI-shaped envelope still validates — only the four UUID fields and `payload_type` are
  shape-constrained.
- `sender_identity_id`, `recipient_identity_id` and `recipient_mailbox_id` stay free strings; they
  carry base64url ed25519 keys and a base64url SHA-256 digest, and `mailboxEnvelopeUUIDIdentifiers`
  deliberately omits them. Requiring UUIDs there would refuse all real traffic.
- The T41 length bound still holds and still runs **first**, so an oversized identifier keeps
  answering with the bound it violated rather than with a shape complaint.

---

## 2. R2-001 path B — a real server-controlled resumption cursor

This is the part T47-TP-001 warned about: the T47 fixture models a relay that resumes at the
undelivered set, so a purely client-side page walk would have turned the test green while leaving
the wedge open against the real relay. It was not taken. Both halves were implemented.

### 2.1 Relay: `next_cursor` became a position

**Files:** `apps/relay/internal/storage/repository/mailbox_repo.go`,
`apps/relay/internal/service/mailbox_service.go`,
`apps/relay/internal/api/handler/mailbox_handler.go`, `apps/relay/internal/model/mailbox_envelope.go`

- `EnvelopeBatch` gained `NextCursor string`, non-empty exactly when `HasMore`.
- `GetEnvelopeBatchFrom(mailboxID, limit, byteBudget, cursor)` is the real selection. It decodes the
  cursor to a position, then skips exactly that many *non-expired* envelopes before selecting. The
  expiry skip runs before the cursor is consumed, so a stale record can neither wedge delivery nor
  shift the resume position — the F-005 (c) property is preserved.
- `GetEnvelopeBatch(mailboxID, limit, byteBudget)` is retained as a two-line delegation meaning
  "from the head of the mailbox". **Reason:** `mailbox_repo_test.go:183` calls the three-argument
  form and is a test file I may not edit, so the cursor could not simply be appended to that
  signature. The delegation is the whole difference; there is one implementation.
- `PollRequest` gained `cursor`. `PollMailbox` passes it through and returns
  `batch.NextCursor` as `next_cursor`. The fixed constant `pollMoreEnvelopesCursor = "more"` is
  gone.
- An unusable cursor is `model.ErrInvalidMailboxCursor` and answers **400 `INVALID_SCHEMA`**, never
  500 and never a silent fallback to position zero (which would turn a client bug into an invisible
  replay of page one).

**The cursor is server-controlled and is not derived from `envelope_id`.** The original F-009
constraint still holds and was the reason a key-based cursor was rejected: the mailbox key's second
half is the sender-supplied `envelope_id`, and a cursor derived from it would put an
attacker-chosen string back on the wire. The token is instead produced from a count the server
computed — decimal, at most 15 digits, validated digit-by-digit on the way back in.

**The honest cost of a position cursor**, stated in the code comment rather than left implicit:
acknowledging or expiring an envelope *between two pages of one walk* shifts later positions by one,
so a single envelope can be skipped or repeated. Neither loses a message. A skipped envelope is
offered again by the next poll, because every walk restarts at the head; a repeated one is
idempotent at the client through the `cli:inbox:` dedupe entry. Inside a single `poll()` no
acknowledgement happens until the walk has ended, so the window is narrow to begin with.

### 2.2 Client: `poll()` walks pages

**File:** `apps/cli/src/runtime/inbound.ts`

`poll()` now loops: read a page (`page()` creates its own challenge, because a challenge is
single-use), accept it, accumulate `received` / `rejected` / `firstRejection`, and continue only
while **that page yielded nothing and the relay reported more pages**. It stops as soon as anything
is accepted — the accepted envelopes must be acknowledged promptly, and the next `poll()` resumes
the remainder from a fresh walk.

The bound is `maxPollPagesPerPoll = 16`. At the wire maximum batch size this consults 1600 envelopes
before giving up, which is far beyond any legitimate backlog the 24 h declared expiry and the relay's
7-day retention cap can produce, and keeps a deliberately flooded mailbox costing a bounded number
of requests rather than an unbounded one.

**F-012 was not weakened.** The re-raise moved from "this batch yielded nothing" to "no page this
walk reached yielded anything", and it is still `throw firstRejection` *before* `ackPending()`, so a
poison-only mailbox still acknowledges nothing and mutates nothing. `inbound.test.ts:177-183` and
`inbound.batchIsolation.test.ts:262-275` pass unchanged, and T47's across-pages counterpart guard
(`inbound.pollProgress.test.ts:228-252`) pins that "re-raise only when no pages remain" did not
become "never re-raise" — proved again against the real relay in §4, poll #2.

### 2.3 Wire contract change (both sides, strict and closed)

| | Go | TypeScript |
|---|---|---|
| request `cursor` | `PollRequest.Cursor string` — empty means head of mailbox | `pollRequestSchema.cursor: z.string().min(1).max(256).optional()` on a `.strict()` base; omitted on the first page |
| response `next_cursor` | `*string`, non-null iff `HasMore`, value = resume position | `nextCursorSchema` unchanged: closed `string(1..256) | null` union |

No schema was loosened: `cursor` is a new **optional request** field on a still-`.strict()` object,
bounded by the same closed shape the response is, so a token the relay could not have issued never
reaches the wire. The client never constructs, parses or interprets the token — it echoes back
verbatim what the relay handed it. `poll_batch_size` forwarding, the 1 MiB response bound, the
`0/2/3/4/5` exit-code contract and the `{ received, more, rejected }` result shape are untouched.

---

## 3. R2-002 — the identifier-bound class is closed

`maxEnvelopeIdentifierBytes` became the exported, shared `validation.MaxIdentifierBytes` (still 256),
because the same reasoning applies to three routes and a per-route copy is how they drift.

- **`/v1/device-records/publish`** — `ValidateDeviceRecord` now bounds `identity_id` and `device_id`.
  Both halves of `device:<identity_id>:<device_id>` are caller-chosen on an unauthenticated route,
  and the 64 KiB body limit does not save it against Badger's 65000-byte key ceiling.
- **`/v1/mailbox/ack`** — `AckMailbox` now bounds each `envelope_ids` **element**. The element
  *count* was already bounded (`mailbox_handler.go`); the element *length* was not, and every element
  becomes the second half of the key `DeleteEnvelope` removes. The bound runs before signature
  verification, so the malformed request never reaches the store.

Both answer 400 `INVALID_SCHEMA` and never echo the offending value. The RED suite's controls hold:
an ordinary UUID `device_id` still publishes and an ordinary UUID `envelope_id` still acks,
including one no longer in the mailbox (the client's retry path). A length bound rather than a UUID
requirement was chosen for these two, because the tests ask for a bounded 4xx and a UUID requirement
on `/v1/mailbox/ack` would be a second, unrelated wire-contract change.

`ValidatePreKeyBundle`'s `bundle_id` — the third site the reviewer enumerated but did not probe —
was **not** changed: it is under a 1 MiB body limit, no RED test covers it, and the flow's rule is
that a fix is pinned by a test. It is named here so the next round can decide deliberately.

---

## 4. Real-relay evidence for path B

The dispatch requires path B proved closed against the real relay binary, not only against the T47
fixture. A scratchpad script built `apps/relay/cmd/relay`, started it with
`ECHOLET_MAX_MAILBOX_BATCH=2` (the selection window is then smaller than the queue without touching
any client configuration), initialised two real CLI profiles against it through a recording proxy,
and drove the real `dist/cli.js`. Nothing was written into the repository; the whole run lives under
a temp directory that is removed at the end. Only paths, status codes, envelope ids, counts, cursor
*presence* and exit codes were printed.

Scenario: alice sends one real message to bob; three shape-valid but permanently-unacceptable
envelopes are POSTed unauthenticated with `envelope_id`s that sort ahead of every random UUID, so
badger's key order puts them at the head of bob's mailbox and they fill the whole 2-envelope window.

```
== path A against the real relay ==
PASS  envelope_id='poison-not-a-uuid'            status=400 code=INVALID_SCHEMA
PASS  payload_type='not_ciphertext_message'      status=400 code=INVALID_SCHEMA

== R2-002 against the real relay ==
PASS  /v1/device-records/publish device_id=64960 bytes -> 400 INVALID_SCHEMA (was 500 INTERNAL_ERROR)
PASS  /v1/mailbox/ack envelope_ids[0]=65000 bytes -> 400 INVALID_SCHEMA (was 500 INTERNAL_ERROR)

-- poll #1: the wedge scenario --
  page 1: cursor sent = none, returned = [poison-1, poison-2], next_cursor = present
  page 2: cursor sent = yes,  returned = [poison-3, 52ada64d-…68ad], next_cursor = null
PASS  poll exits 0
PASS  poll received exactly the legitimate envelope            received=1
PASS  all three poison envelopes reported as rejected          (INBOUND_REJECTED)
PASS  page 2 resumed PAST the poison instead of replaying it
PASS  exactly one ack, carrying only the legitimate envelope
PASS  bob's history holds exactly the one delivered message    entries=1

-- poll #2: the control that answers T47-TP-001 --
  page 1: cursor sent = none, returned = [poison-1, poison-2], next_cursor = present
  page 2: cursor sent = yes,  returned = [poison-3],           next_cursor = null
PASS  a cursorless poll re-selects the IDENTICAL page from the head of the mailbox
PASS  poll still fails closed on exit 3 INBOUND_REJECTED (F-012 across pages)
PASS  nothing was acknowledged by the refusing poll            acks=0
PASS  history is unchanged by the refusing poll

PASS  all 7 delivered envelope_ids are client-parsable uuids
PASS  relay log carries no store key and no synthetic body
RESULT: ALL CHECKS PASSED
```

**Poll #2 page 1 is the load-bearing line.** It is a cursorless poll issued *after* the legitimate
envelope was acknowledged, and the relay returns the byte-identical poison page it returned the
first time. That is head-of-prefix re-selection observed on the real binary, and it is exactly what
T47-TP-001 predicted: a client that merely polled again — the shortcut the dispatch forbade — would
have received the same page forever. Progress in poll #1 page 2 came from the relay honouring the
cursor it issued, which only exists because the relay side was changed too.

---

## 5. R2-L-002 — the `reportedRelayCodes` docstring

**File:** `apps/cli/src/commands/cli.ts`

"once it is claimed a further sender gets the relay's 404 `PREKEY_BUNDLE_UNAVAILABLE`" named one of
four conditions. `ClaimSignalV2` returns `ErrV2Unavailable` whenever its availability scan finds
nothing usable, which also covers: the recipient never published; every published bundle is outside
its validity window; and the requested `device_id` selector matches no available bundle. The
docstring now names all four and says why none of them is a trust violation. No behaviour changed.

---

## 6. Verification

| Gate | Result |
|---|---|
| `apps/cli` vitest | **19 files / 94 tests passed**, including all five T47 files unmodified |
| `pnpm test` (workspace) | **green** — protocol 8, client-db 1, crypto-core 4, client-core 2, session-node 24, mobile 6, cli 94 |
| `pnpm typecheck` | **green** (7 projects) |
| `go -C apps/relay test -race -count=1 ./...` | **green** (handler, router, middleware, repository, validation) |
| `go -C apps/relay test -tags relayv2 -race -count=1 ./...` | **green** |
| Real-relay path B evidence | **all checks passed** (§4) |
| Test-file integrity | `shasum -a 256 -c` over **52** files (every `*_test.go`, every `*.test.ts`, plus `apps/cli/vitest.config.ts` and `apps/cli/test/globalSetup.ts`) — **zero mismatches** |
| `git status --porcelain` | 23 untracked entries, unchanged from the round-2 snapshot |

Integrity was verified by SHA-256, not mtime (R2-I-004).

### Files changed (production only)

| File | Change |
|---|---|
| `apps/relay/internal/validation/validate.go` | UUID + literal shape checks for the envelope; `MaxIdentifierBytes` exported; device-record identifier bound |
| `apps/relay/internal/model/mailbox_envelope.go` | `ErrInvalidMailboxCursor` |
| `apps/relay/internal/storage/repository/mailbox_repo.go` | `EnvelopeBatch.NextCursor`; cursor encode/decode; `GetEnvelopeBatchFrom` |
| `apps/relay/internal/service/mailbox_service.go` | `GetEnvelopeBatchFrom` passthrough |
| `apps/relay/internal/api/handler/mailbox_handler.go` | `PollRequest.Cursor`; position cursor in the response; ack element bound |
| `apps/cli/src/transport/relayClient.ts` | optional `cursor` on the strict poll request |
| `apps/cli/src/runtime/inbound.ts` | `page()`, the bounded page walk, `maxPollPagesPerPoll` |
| `apps/cli/src/commands/cli.ts` | `reportedRelayCodes` docstring |

## 7. Handover

- `docs/requirements/echolet-cli-prototype/specification.md` still does not document the `poll`
  result shape, exit 0 with rejections, `claimable`, `PREKEY_BUNDLE_UNAVAILABLE`, or now the
  `cursor` / `next_cursor` request-response pair (R2-L-003, R2-I-005). Documentation was out of this
  dispatch's scope; the list has grown by one sentence.
- `ValidatePreKeyBundle`'s `bundle_id` is the one enumerated member of the R2-002 class left open
  (§3).
- R2-L-004 (the thrown rejection discards the `rejected` array) is unchanged and now spans pages: a
  wedged operator still sees only the first code. Carrying the array on the thrown error stays a
  test-contract decision.

## 8. Routing audit

- `graph_used`: **no** — `not-relevant`. Every navigation target was a named `file:line` from the
  dispatch or the two review reports, or a targeted symbol search.
- `wiki_used`: **no** — `not-relevant`. The authoritative contracts here are the two review reports,
  the T47 RED suite and the code itself, all read directly.
- `ctx_used`: **yes** — `keryx ctx rg` for every search, `keryx ctx read` for compact file reads,
  `keryx ctx run` for every build, test and probe.
- `raw_rg_used`: **no**.
