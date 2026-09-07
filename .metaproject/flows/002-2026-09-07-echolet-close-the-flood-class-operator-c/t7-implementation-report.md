# T7 — Implementation: closing the mailbox flooding class

Flow: `002-2026-09-07-echolet-close-the-flood-class-operator-c`
Dispatch: `002-T7-implement`
Date: 2026-09-07 · Node v26.5.0 (`/opt/homebrew/bin/node`) · Go 1.26.1 · darwin/arm64
Design: `t5-flood-closure-design.md` (candidate C4), as corrected by the five defects
`002-T6-tests-result.json` recorded (T6-F-001 … T6-F-005).

---

## 0. What changed, in one paragraph

Selection order in a mailbox is now assigned by the relay in store order, not by the
sender-supplied `envelope_id`; the poll cursor now means "resume strictly after this
relay-assigned position" instead of "skip this many"; the recipient's position is durable,
held by the relay per `(mailbox, device)`, bound by the recipient's own signature, and
reported **per page** on the already-signed poll request; and the client's 16-page walk is
now only a liveness valve, because hitting it costs one more `poll` invocation instead of a
lost message. `contact import` records a re-walk request **locally** and the next walk
consumes it exactly once.

**Measured, on the real relay binary and the real `dist/cli.js`, at the exact volume T55
recorded as a permanent wedge (4 self-published identities + 49 maximum-size poison,
12 880 434 B uploaded, 53 attacker requests):**

| | before (T55) | after (measured here) |
|---|---|---|
| poll exit codes | `[3,3,3,3]` | `[3,0]` |
| delivered | **no**, up to the 168 h retention cap | **yes**, on the 2nd `poll` invocation |
| poll pages for the 1st delivery | unbounded (16 re-walked every poll, forever) | **18** |
| HTTP requests for the 1st delivery | unbounded | **37** |
| bytes downloaded for the 1st delivery | 12.85 MB **per poll, forever** | **13 676 370 B, once** (amplification **1.06:1**) |
| 2nd delivered message | never | **1 poll, 1 page, 3 requests, 267 181 B** (amplification **0.021:1**) |

---

## 1. The ordering index (C4-1)

`apps/relay/internal/storage/repository/mailbox_repo.go`

```
mailboxseq:<mailbox_id>:<20-digit zero-padded position>  ->  <envelope_id>
mailboxseqnext:<mailbox_id>                              ->  next position to allocate
```

- The position is allocated inside `SaveEnvelope`'s existing transaction and written with
  the same physical retention deadline as the record it points at.
- `GetEnvelopeBatchFrom` iterates the `mailboxseq:` prefix and fetches each envelope by its
  existing primary key. Zero-padded decimal makes Badger's byte order numeric order.
- **It is a side index, and the primary record did not move.** `mailbox:<mailbox_id>:<envelope_id>`
  is hard-coded by `mailbox_repo_test.go`'s `mailboxEnvelopeKeyForTest`, and keeping it
  preserves untouched: the byte-identical replay comparison, `ENVELOPE_ID_CONFLICT`,
  `SenderOccupancy`'s O(1) already-stored check, `DeleteEnvelope`, the retention deadline,
  and `GetEnvelopes` (which still scans the primary prefix).
- **A byte-identical replay allocates no position and does not move the envelope**, so
  F-004's exact retry cannot silently reorder a conversation.
- An index entry whose primary record is gone — acknowledged, or expired out from under it —
  is skipped lazily and consumes no bound, the same shape as the existing expired-record skip.
- Allocation is serialized by a **striped** per-mailbox mutex (256 stripes, keyed by FNV-1a
  of the mailbox id). A lock *per mailbox* would be unbounded state grown by unauthenticated
  traffic, which is the shape of defect this whole wave is about. Badger's optimistic
  conflict detection on the counter key plus the existing 64-attempt replay loop remains the
  backstop. `go test -race` passes, including 20 concurrent stores into one mailbox.
- **Nothing was added to `model.MailboxEnvelope`.** The client parses poll responses under
  `MailboxEnvelopeSchema.strict()`; the position lives only in the index and in the cursor.

### Cursor semantics

`next_cursor` keeps its exact wire shape — opaque decimal, ≤ 15 digits, digit-validated,
`400 INVALID_SCHEMA` on anything the relay could not have issued — and changes meaning from
"envelopes already handed out" to **"resume strictly after this position"**. That closes the
skip/repeat window `mailbox_repo.go` previously documented against itself: an envelope that
left the mailbox between two pages used to shift every later position by one. That was
survivable only while every walk restarted at the head, which is exactly what this change
removes — with a durable mark a skipped envelope would be skipped for good.

---

## 2. The read position and its authentication (C4-2)

`mailboxmark:<mailbox_id>:<device_id> -> <decimal position>`, moved **forward only**.

**It rides on the poll, not on the ack** (correction T6-F-001). The design named
`/v1/mailbox/ack`; measurement showed that route costs a pre-existing F-012 regression —
`inbound.pollProgress.test.ts:248` asserts `fake.acks()).toEqual([])`, the *request* list, so
a mark-only ack on the accept-nothing path turns it red — and cannot make progress survive an
interrupted walk without an extra request per page. The poll request is equally signed and
challenge-bound, so the position costs no extra request and the ack goes back to being purely
about acknowledgement.

The relay still **accepts** `read_through` on `/v1/mailbox/ack` (the Go RED-7 tests pin it
there), so an acknowledgement and a position can be one signed statement; the CLI simply does
not use that shape.

### Authentication

The value is inside the signed transcript, because it decides what the recipient is offered
next and an advanced mark permanently skips everything behind it (design §4, R-4).

```
poll v1  echolet-mailbox-challenge:v1:{challenge_id}:{recipient_mailbox_id}:{device_id}:{nonce}
poll v2  echolet-mailbox-challenge:v2:{challenge_id}:{recipient_mailbox_id}:{device_id}:{nonce}:{read_through}
ack  v1  echolet-mailbox-ack:v1:{recipient_mailbox_id}:{device_id}:{sorted_ids}
ack  v2  echolet-mailbox-ack:v2:{recipient_mailbox_id}:{device_id}:{sorted_ids}:{read_through}
```

- **v2 is signed if and only if the request carries `read_through`.** Absent and present are
  therefore *different signed statements*, and the position cannot be added to, removed from
  or altered in a request the recipient signed. A v1 signer and a v1 verifier are unchanged,
  which is what keeps every pre-existing test and call site green (T6-Q-002, `v2-alongside`).
- Both strings are pinned **literally** in `packages/crypto-core/src/mailbox/auth.ts` and in
  `apps/relay/internal/cryptoutil/signatures.go`, and the relay rebuilds them byte for byte.
  The two halves are exercised against each other by the real-binary suite — every page after
  the first in `flood-closure.test.ts` carries `read_through`, so a divergence answers
  `403 INVALID_SIGNATURE` and the suite fails loudly rather than drifting.

### Bounds, applied before authorisation

`resolveReadThrough` (shared by both routes) refuses, with `400 INVALID_SCHEMA` and **before**
`authorizeMailboxDevice`, exactly as the `envelope_ids` bounds already do:

- a token that is not the shape this relay issues (non-numeric, signed, over-long, empty);
- a position **above every position this mailbox ever allocated** — a recipient that reports
  a position beyond the end of its own mailbox marks envelopes judged that it was never
  offered.

Malformed client input therefore never answers 500 and never depends on who is asking.
Monotonicity is enforced in the store: a lower value is ignored, never a rewind. Recovery
from a mark that is too far ahead is an explicit `cursor`, which always re-walks from
wherever the recipient asks.

**Nothing is persisted client-side** (correction T6-F-005). The position is held in memory for
the duration of one walk and put on the wire; the relay is the durable holder, which is what
makes it survive a `SIGKILL`. That keeps F-012's store-identity guarantee literally true:
`inbound.pollProgress.test.ts:251` still finds the encrypted store byte-identical after a
poison-only poll.

---

## 3. Per-page presentation (C4-3)

`apps/cli/src/runtime/inbound.ts`

The position of page *k* is reported on the request for page *k+1*. An end-of-walk mark was
measured to fail RED-4 (correction T6-F-003): a poll `SIGKILL`ed mid-walk has judged pages and
reported none of them, so the next process starts where the last one started — and under the
shipped 120/min per-IP limit the recipient's *own* rate limiter interrupts a long walk
routinely, so that is the normal case, not the exotic one.

Per-page costs no extra request and bounds the repeated work after any interruption — a `429`,
a timeout, an operator's Ctrl-C, a supervisor restart — to a **single page**. The one page of
lag it admits is inherent: the relay issues `next_cursor` only when more remain, so the last
page of a walk has no token to report; that page is re-read by the following poll.

`maxPollPagesPerPoll = 16` is unchanged in value and demoted in meaning: hitting it now costs
one more `poll` invocation instead of a lost message. `poll` already reports `more: true` as
the signal to poll again. It still has to exist — the mailbox is attacker-fillable, so one
`poll` must return in bounded time.

**F-012 is unchanged on the accept-nothing path.** Nothing is deleted, no history is written,
no session advances, the first rejection is still re-raised before `ackPending()`, and no ack
request is made. The only thing that moves is the recipient's own read position, on requests
it was already making, under its own signature.

---

## 4. Reset semantics for `contact import`

`contact import` is the exact event that changes the verdict for a `CONTACT_NOT_TRUSTED`
envelope the walk has already passed (design §4, R-5). It therefore requests a re-walk — and
that is the **most dangerous path in this change** (correction T6-F-004), so it is worth
stating exactly what it does and does not do:

1. **It makes no relay request.** `contact import` is an offline trust operation and stays
   one; importing a card must not start failing when the relay is unreachable, and
   `cli.test.ts:148` pins the exact ordered request-path list of a CLI run.
2. **It records the request locally**, as `cli:mailbox-rewalk` in the encrypted store —
   written by a command that is not a poll, which is the one carve-out from §2's
   "persist nothing client-side".
3. **It is consumed exactly once**, at the *start* of the next walk, before the first page —
   not on that walk's success. A flag that outlived the walk it started would make every
   subsequent poll restart at the head of the mailbox, which **silently reinstates the entire
   flooding class while every unit test still passes**.
4. **It does not rewind the relay's mark.** The re-walk is an explicit `cursor: "0"` on the
   first page — a poll *with* a cursor behaves exactly as it always did. The relay's mark
   moves forward only, in every code path, without exception. Read positions presented during
   a re-walk that are below the stored mark are ignored.
5. When no request is pending, the consume step **writes nothing at all**, so an ordinary poll
   still leaves the store byte-identical.

Cost to a legitimate user: one extra full mailbox walk on the next poll after an import —
one page for a normal mailbox.

---

## 5. Migration / backfill — required before this ships onto data that already exists

**Existing relay data has no ordering index.** Every envelope stored before this change lives
only under `mailbox:<mailbox_id>:<envelope_id>` and would be invisible to an index-only
selection, which makes an existing mailbox *undeliverable* rather than merely unordered. That
is finding T6-F-002, and it is also the deployment step design §5 anticipated.

The backfill is **in the code**, not in a runbook step an operator can forget:

- `ensureMailboxOrderingLocked` gives every primary record in a mailbox a position, **in
  current key order** — the order this relay served them in before the index existed, so a
  migration does not reshuffle anyone's mailbox.
- It is triggered by the **absence of `mailboxseqnext:<mailbox_id>`**: a mailbox that holds
  records but has never allocated a position predates the index.
- It runs on the **read path and before every store**, so a record written by any other path
  is still selectable. (This is also what keeps
  `TestGetEnvelopeBatchFiltersExpiredBeforeApplyingBatchLimit` green: it seeds raw primary
  keys and then drives `GetEnvelopeBatch`, and that file may not be edited.)
- It is **chunked** (512 entries per transaction) because a Badger transaction is bounded and
  a real mailbox is not, **idempotent** (the same records in the same key order receive the
  same positions), and the counter is written **last**, so an interrupted backfill is retried
  on the next call rather than half-applied.
- It costs one prefix scan per mailbox, once, on first touch after the upgrade.

**Two things the operator still has to know, and they belong in the wave-3 runbook:**

1. **The ack/poll transcript change is breaking.** A client built before this change cannot
   ack or poll-with-a-position against a relay built after it. The cost is zero only while no
   relay is yet serving — which is the ordering this flow fixes. Landing it after two relays
   are serving breaks every deployed client. This is the single largest scheduling constraint
   of the change.
2. **Wiping the relay data directory is an acceptable alternative** to the backfill on a
   prototype deployment: no production data exists and retention is 168 h anyway. The backfill
   exists so that *not* wiping is also safe.

---

## 6. What this does **not** close

The design predicted these before implementation. Each is re-stated with what was actually
measured, and the ones that changed are marked.

**R-1 · Bandwidth, once per envelope. Confirmed, and now bounded.** The recipient still
downloads every poison envelope exactly once. Measured at 4 identities × 49 maximum-size
poison: the attacker uploads 12 880 434 B once, the recipient downloads 13 676 370 B once —
**amplification 1.06:1**, against *unbounded* before. The second delivered message into the
same still-poisoned mailbox costs 1 poll, 1 page, 3 requests, 267 181 B — **0.021:1**. A
sustained attacker forces a sustained download equal to their upload, and nothing more.

**R-2 · First-walk latency at extreme volume. Confirmed, and it is the real residual.** The
one-shot walk is still capped by the victim's own rate limit. The 4/49 flood costs 37 requests
— about **19 s** at the shipped default of 120/min, paid once. The design's 10 801-envelope /
2.8 GB case still makes the *first* walk take on the order of an hour; durable progress means
the victim resumes rather than restarts, so an hour of polling now delivers where an hour used
to deliver nothing, but an hour against a 24 h message lifetime is not comfortable margin.
**This is a bound, and it is reported as a bound.**

**R-3 · Storage. Unchanged, and marginally worse.** `ECHOLET_MAX_STORAGE_BYTES`
(`config.go:12`) is still declared and enforced nowhere, and there is still no per-mailbox
occupancy cap despite `PROTOCOL-07:473` naming one (finding T5-F-002). The flood still fills
the relay's disk without limit. The mark makes one aspect slightly worse, exactly as predicted:
a recipient who has read past its poison has no reason to delete it, so it lingers to the 168 h
cap. This is a **relay-availability** class, not a delivery class; it becomes live in wave 3.
This change adds a small amount of new state of its own — one index entry per envelope (TTL
tied to the envelope), one counter per mailbox, one integer per `(mailbox, device)` (30-day
TTL) — all bounded by traffic that is already accepted.

**R-4 · The mark is new state that can lose messages if it is wrong. Mitigated, not
eliminated.** The mark only ever advances to a position the relay itself issued for a page the
poll actually received; the relay additionally refuses any position above what it has ever
allocated, and never moves the mark backwards. What remains: a client bug that reported a page
it did not judge would skip that page's envelopes for the rest of their lifetime. The recovery
path exists (an explicit `cursor`) but the CLI only takes it on `contact import`.

**R-5 · `CONTACT_NOT_TRUSTED` before the card is imported. Mitigated by §4; residual
unchanged.** A card imported on a *different device*, or a peer trusted through some other
path, still does not trigger the re-walk. `specification.md:98` states both parties exchange
cards before messaging, so this is a supported-path regression only at the margin — and it is
pinned by `flood-closure.test.ts` RED-6 rather than argued.

**R-6 · Identity is still free.** `POST /v1/device-records/publish` is still unauthenticated.
Minting identities is now useless for *wedging* — measured at 4, 50 and 500 identities, all
deliver — but not for R-3, and nothing bounds the number of distinct senders in one mailbox.

**R-7 · A pinned contact still occupies 16 slots** and can delay by 16 envelopes. Unchanged,
by design (T54).

**R-8 · Metadata. Unchanged.** The relay sees what `SEC-01 §6.2` says it sees, plus one
per-`(mailbox, device)` integer that is a function of the recipient's own polling and reveals
nothing about senders.

**New: T6-F-006 · `SenderOccupancy` is O(N²) to fill a mailbox.** It scans the whole mailbox
prefix on every send and only stops early once it has counted `countLimit` envelopes *from
that sender*, so a fresh identity walks every record. Not a delivery defect and not touched
here; it belongs with R-3, and it is the dominant cost of the 8000-envelope test.

**New: the poll `cursor` is still outside the signed transcript.** Only `read_through` — the
value that can move durable state — is bound. An out-of-range cursor is answered with an empty
final page, as before.

---

## 7. Files changed

| File | Change |
|---|---|
| `apps/relay/internal/storage/repository/mailbox_repo.go` | ordering side index, striped allocation lock, chunked idempotent backfill, cursor as resume-after-position, index-driven selection, `HighestIssuedPosition` / `ReadMark` / `AdvanceReadMark`, `DecodeMailboxCursor` exported |
| `apps/relay/internal/service/mailbox_service.go` | pass-throughs for the three new repository operations |
| `apps/relay/internal/api/handler/mailbox_handler.go` | `read_through` on poll and ack, `resolveReadThrough` bounds applied before authorisation, v2 transcripts when the field is present, mark recorded before selection, cursorless poll resumes at the mark |
| `apps/relay/internal/cryptoutil/signatures.go` | `CreateMailboxAckMessageV2`, `CreateMailboxChallengeMessageV2`, shared id normalisation |
| `packages/crypto-core/src/mailbox/auth.ts` | optional `readThrough` on both transcripts, v2 strings pinned literally |
| `apps/cli/src/transport/relayClient.ts` | `read_through` in the strict poll request schema |
| `apps/cli/src/runtime/profile.ts` | poll authorisation signs the position; `requestMailboxRewalk` / `takeMailboxRewalk` |
| `apps/cli/src/runtime/inbound.ts` | per-page position on the poll, re-walk consumed once, valve re-documented |
| `apps/cli/src/commands/cli.ts` | `contact import` records the re-walk request, offline |
| `docs/API-11_JSON_SCHEMAS.md`, `docs/PROTOCOL-07_MVP_MESSAGE_FLOW.md` | v2 transcripts, `read_through`, new cursor meaning, relay-assigned order |

**No test file was written, edited, skipped or deleted.** 60 tracked test files, exactly one
differing from `HEAD`: `mailbox_sender_quota_test.go`, left byte for byte as T6 left it
(`sha256 0fd4e86b…`). `apps/cli/src/tui/` was not touched — it belongs to the parallel T9
dispatch, as do the `apps/cli/build.mjs` and `apps/cli/package.json` changes in the tree.

## 8. Verification

| Suite | Result |
|---|---|
| `go -C apps/relay test ./...` | all packages ok |
| `go -C apps/relay test -race -count=1 ./...` | all packages ok |
| `go -C apps/relay test -race -count=1 -tags=relayv2 ./...` | all packages ok |
| `go vet ./...` | clean |
| `pnpm typecheck` | green, 7 projects |
| `@echolet/crypto-core` vitest | 20/20 |
| `@echolet/cli` vitest `src/runtime src/transport src/commands` | 99/99 |
| `@echolet/cli` vitest `test/e2e` | **10/10** — two-process 3/3, publication-claimability, RED-1, RED-4 (across a `SIGKILL`), RED-6, and the three volume cases at 4/49, 50/800 and 500/8000 |

`apps/cli/src/tui/` is the parallel T9 worker's tree; its tests are not part of this task's
verification and may be red.

## 9. Routing audit

- `graph_used`: **no** — `not-relevant`. Every navigation target was a named `file:line` from
  the dispatch, the T5 design or the T6 result.
- `wiki_used`: **partial** — the authoritative documents here are the T5 design and the T6
  RED tests, read in full; `docs/API-11` and `docs/PROTOCOL-07` were read and updated.
- `ctx_used`: **yes** — `keryx ctx rg` for every search, `keryx ctx read` for compact reads,
  `keryx ctx run` for every command.
- `raw_rg_used`: **no**.

## 10. Integrity

The one measurement probe (`<scratchpad>/measure-attacker-cost.mjs`) lives outside the
repository, builds the relay from this tree and drives the real `dist/cli.js`, and printed only
labels, counts, byte totals and exit codes. No plaintext body, ciphertext, store key, private
key material, signing seed or HTTP request body was logged or printed by any change or probe in
this dispatch. No `git commit` was made.
