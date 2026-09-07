# T5 — Flood-closure design: how to close the mailbox flooding class

Flow: `002-2026-09-07-echolet-close-the-flood-class-operator-c`
Dispatch: `002-T5-design`
Date: 2026-09-07 · Node v26.5.0 (`/opt/homebrew/bin/node`)
Scope: **design only.** No source, test or configuration file was modified. The one probe
run lives outside the repository
(`<scratchpad>/probe-order.mjs`) and prints only labels, booleans and counts.

---

## 0. Summary

**Recommended: candidate 4 — server-ordered mailbox + a durable, recipient-signed read
position + a walk bound that is a function of the mailbox rather than a constant.**

The orchestrator's prior — candidate 1, "make the drain walk cover the mailbox instead of a
fixed 16 pages" — is **necessary but not sufficient, and on its own it is another linear
bound, not a closure.** That is not an opinion: §2 measures the replacement wedge cost
(≈113 self-published identities and 1 801 max-size envelopes buys ten minutes of the
victim's walking, and the victim never finishes because progress is not durable), and it
also degrades the operator-visible failure from exit 3 to exit 4 `RELAY_UNAVAILABLE`.

The reason candidate 1 falls short is a property that no report in this project has
recorded yet and that §1 establishes at `file:line`: **the attacker, not the relay, chooses
where its envelopes sit in the victim's scan order**, and **the victim's progress through
that order is discarded at the end of every poll**. Fix those two and the class closes:
delivery becomes reachable in work proportional to what the attacker actually uploaded,
paid once rather than on every poll.

---

## 1. The two properties that make the class possible

### 1.1 The mailbox is ordered by a sender-chosen string

`apps/relay/internal/storage/repository/mailbox_repo.go:429-431`

```go
func mailboxEnvelopeKey(mailboxID, envelopeID string) []byte {
	return []byte(fmt.Sprintf("mailbox:%s:%s", mailboxID, envelopeID))
}
```

Every selection is a Badger prefix scan in byte order over that key
(`mailbox_repo.go:104`, `:183`, `:319`). The second key component is `envelope_id`, which is
**supplied by the sender** and constrained only by the shape rule T48 added,
`apps/relay/internal/validation/validate.go:134`:

```
^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}
  |00000000-0000-0000-0000-000000000000)$
```

Probe (`accepted_by_relay_shape_rule`, run on Node 26.5.0):

```
nil_uuid            00000000-0000-0000-0000-000000000000   accepted
lowest_v1           00000000-0000-1000-8000-000000000000   accepted
low_v1_next         00000000-0000-1000-8000-000000000001   accepted
low_v4              00000000-0000-4000-8000-000000000000   accepted
typical_random_v4   (crypto.randomUUID())                  accepted

random_v4_ids_sorting_below_attacker_prefix_out_of_200000: 0
attacker_choosable_head_ids: 9.90e+27
```

So an attacker has ~10²⁸ envelope ids that sort strictly ahead of **every** legitimate
`randomUUID()` the CLI mints, and it can place poison ahead of a legitimate envelope that
is *already stored*. This is not hypothetical: the T48 real-relay evidence
(`t48-implementation-report.md` §4) used exactly this — *"envelope_ids that sort ahead of
every random UUID, so badger's key order puts them at the head of bob's mailbox"*.

**Recorded as finding T5-F-001.**

### 1.2 The recipient's progress through that order is thrown away every poll

- The relay's cursor is a **position within one walk** and is never persisted:
  `GetEnvelopeBatchFrom` seeks to the head of the prefix on every call
  (`mailbox_repo.go:325-326`, `remaining := position; for it.Seek(prefix)…`).
- The client starts every walk with no cursor (`apps/cli/src/runtime/inbound.ts:105`,
  `let cursor: string | undefined;`).
- A permanently unacceptable envelope is deliberately never acknowledged (F-012,
  `inbound.ts:127`), so it is never deleted and keeps its place until its declared expiry
  or the 168 h retention cap (`mailbox_repo.go:397-414`). `ValidateMailboxEnvelope` places
  no upper bound on `expires_at_ms` (`validate.go:207-209`), so the attacker always reaches
  the cap.

T48 §4 measured the consequence on the real binary and called it "the load-bearing line":
*"a cursorless poll re-selects the IDENTICAL page from the head of the mailbox."*

Together, 1.1 and 1.2 mean the recipient re-pays the full cost of the flood on **every**
poll and can never accumulate progress. That, not the size of the page bound, is the class.

### 1.3 Nothing bounds total mailbox occupancy

`ECHOLET_MAX_STORAGE_BYTES` is declared at `apps/relay/internal/config/config.go:12` and
**is referenced nowhere else in `apps/relay`** (verified by search: one match, the
declaration). There is no per-mailbox occupancy cap either; the one named in
`docs/PROTOCOL-07_MVP_MESSAGE_FLOW.md:473` does not exist in code. The only bounds on a
mailbox are the per-sender quota of 16 (`mailbox_handler.go:269`), the per-IP rate limit of
120/min (`config.go:25`, `middleware/rate_limit.go`), and the host's disk.

**Recorded as finding T5-F-002.**

---

## 2. Why candidate 1 alone is a bound, not a closure — measured

Suppose the only change is that the client walks to the end of the mailbox instead of
stopping at `maxPollPagesPerPoll = 16` (`inbound.ts:71`).

Arithmetic from the code, computed by the probe:

| Quantity | Value | Source |
|---|---|---|
| encoded max-size envelope | 262 853 B | `t55-final-verification.md` (measured) |
| poll byte budget | `(1<<20) − 4096` = 1 044 480 B | `mailbox_handler.go:65-69` |
| max-size envelopes per page | **3** | derived |
| HTTP requests per page | **2** (challenge + poll) | `inbound.ts:87`, `:94` |
| default per-IP rate limit | 120/min | `config.go:25` |
| **pages the victim can walk per minute** | **60** | derived |
| **max-size envelopes traversable per minute** | **180** (47.3 MB/min) | derived |

Attacker cost to make one uninterrupted drain walk longer than the stated duration, at the
existing per-sender quota of 16:

| Victim walk duration to exceed | poison envelopes | identities | attacker requests | attacker upload |
|---|---:|---:|---:|---:|
| 1 minute | 181 | 12 | 193 | 47.6 MB |
| 10 minutes | 1 801 | 113 | 1 914 | 473.4 MB |
| 1 hour | 10 801 | 676 | 11 477 | 2 839.1 MB |

Three consequences, all of which must be stated before implementation rather than
discovered afterwards:

1. **It is another linear move.** The wedge cost goes from 4 identities / 49 envelopes to
   roughly 113 identities / 1 801 envelopes for a ten-minute wedge — the same shape of
   result the per-sender quota produced, at a different constant. AC2 requires that such a
   result be reported as a bound and not as a fix.
2. **The victim's own rate limit re-closes the wedge.** Once the walk exceeds 60 pages/min
   the victim receives `429 RATE_LIMITED`, which `relayClient.ts:140` classifies as
   retryable and `cli.ts:372` maps to `RELAY_UNAVAILABLE` at **exit 4**. Today the operator
   sees exit 3 with a typed rejection; after candidate 1 alone they would see a generic
   "relay unavailable". The diagnosis gets *worse*.
3. **The amplification is unbounded.** The attacker uploads 473 MB **once**; the victim
   downloads 473 MB **on every poll** for up to 168 h, because §1.2 discards progress.
   A change that guarantees delivery by re-downloading everything forever has moved the
   denial from delivery to bandwidth without bounding it.

Candidate 1 is still part of the answer — a constant 16-page bound cannot be correct — but
it must be paired with durable progress, which is what §3 adds.

---

## 3. Recommendation — candidate 4, in three coupled parts

### C4-1 · Selection order becomes server-assigned and monotone

Add a per-mailbox ordering index written inside `SaveEnvelope`'s existing transaction
(`mailbox_repo.go:57-90`):

```
mailboxseq:<mailbox_id>:<zero-padded server seq>  ->  <envelope_id>
```

`GetEnvelopeBatchFrom` (`mailbox_repo.go:304`) iterates the `mailboxseq:` prefix instead of
the `mailbox:` prefix and fetches each envelope by its existing primary key.

**Deliberately a side index, not a change to `mailboxEnvelopeKey`.** The primary record must
stay at `mailbox:<mailbox_id>:<envelope_id>` because
`apps/relay/internal/storage/repository/mailbox_repo_test.go:294-296` hard-codes that layout
in `mailboxEnvelopeKeyForTest`, and that test file may not be edited. Keeping the primary key
also preserves, unchanged: the idempotent byte-identical replay comparison
(`mailbox_repo.go:66-89`), `ENVELOPE_ID_CONFLICT`, `SenderOccupancy`'s O(1) already-stored
check (`mailbox_repo.go:173`), `DeleteEnvelope` (`:387`), the retention deadline
(`:397-414`), and `GetEnvelopes` (`:95`) — which `TestGetEnvelopesFiltersExpiredBeforeApplying
BatchLimit` (`mailbox_repo_test.go:115-129`) drives through directly-seeded raw keys.
Ordering-index entries carry the same TTL and are skipped lazily when their primary record
is gone, the same shape as the existing expired-record skip (`mailbox_repo.go:333-339`).

**Nothing may be added to `model.MailboxEnvelope`.** The client parses poll responses as
`z.array(MailboxEnvelopeSchema.strict())` (`relayClient.ts:100`), so a new field on the
envelope would be refused by every client. The sequence lives only in the index and in the
cursor.

### C4-2 · The cursor becomes that sequence, and the recipient can persist it

- `decodeMailboxCursor` / `encodeMailboxCursor` (`mailbox_repo.go:238-269`) keep their exact
  wire shape — opaque decimal, ≤15 digits, digit-validated, `400 INVALID_SCHEMA` on anything
  the relay could not have issued — and change meaning from "envelopes already handed out"
  to "resume strictly after this sequence". This is a free side benefit: it removes the
  skip/repeat window the position cursor documents at `mailbox_repo.go:296-303`.
- `/v1/mailbox/ack` (`mailbox_handler.go:504-569`) gains `read_through`: the highest sequence
  the recipient has **judged** — committed *or* permanently refused. It is authorised by the
  device signature `authorizeMailboxDevice` already resolves (`mailbox_handler.go:579-595`)
  and stored as `mailboxmark:<mailbox_id>:<device_id>`.
- A poll **without** a `cursor` resumes at `mark + 1` instead of at the head. A poll **with**
  an explicit cursor behaves exactly as today, so a full re-walk is always available.

### C4-3 · The client's page bound stops being a constant and stops being lossy

- `maxPollPagesPerPoll = 16` (`inbound.ts:71`) becomes a **liveness valve only**: one `poll`
  still returns in bounded time, but hitting the valve now costs one more `poll` invocation
  instead of a lost message, because the mark makes progress durable. `poll` already reports
  `more: true` (`inbound.ts:129`), which is the signal to poll again.
- `poll()` (`inbound.ts:99-131`) advances the mark to the highest sequence on the last page
  it fully judged and sends it with `ackPending()` (`:187-196`) — **including on the
  accept-nothing path** that currently re-raises at `:127` and acks nothing.
  F-012's actual guarantee is preserved: nothing is deleted, no history is written, no
  session advances, the first rejection is still re-raised before `ackPending()`. The only
  thing that moves is the recipient's own read position, under the recipient's own signature.
- `contact import` resets the mark to 0. That is the one recovery path the mark would
  otherwise destroy (§4, R-5), and it is restored by exactly the event that changes the
  verdict for a `CONTACT_NOT_TRUSTED` envelope.

### Why this closes the class

An attacker can delay delivery by at most the time it takes the recipient to walk past the
poison **once**. Each poison envelope costs the attacker one authenticated send (bounded by
the 16/sender quota and the per-IP rate limit) and costs the recipient one download, once.
There is no finite flood that prevents delivery, because recipient progress is monotone and
survives rate-limiting, timeouts and process exit. The amplification ratio drops from
unbounded to 1:1.

---

## 4. What it does **not** close — predicted before implementation, with how to measure

Every mitigation in this project so far moved a number and the residual was found by
measurement afterwards. These are stated first.

**R-1 · Bandwidth, once per envelope.** The recipient still downloads every poison envelope
exactly once. The current 49-envelope flood costs one ~12.85 MB walk (17 pages, 34 requests)
and then nothing. A sustained attacker forces a sustained download equal to their upload.
*Measure:* bytes and HTTP requests the recipient's `poll` consumes per delivered message, on
the first poll and on the second, at 49 / 800 / 8 000 poison envelopes. Assert first-poll
bytes ≈ poison bytes and **second-poll cost O(1)**. If the second poll is not O(1) the mark
is not working and the change is candidate 1 wearing a hat.

**R-2 · First-walk latency at extreme volume.** The one-shot walk is still capped by the
victim's own 120/min limit at 180 max-size envelopes/minute (§2). A 10 801-envelope flood
(676 identities, 2.8 GB) makes the *first* walk take about an hour. Durable progress means
the victim resumes rather than restarts, so an hour of polling delivers where today an hour
delivers nothing — a real class change, but an hour against a 24 h message lifetime is not
comfortable margin. *Measure:* walk a mailbox of N poison across K separate `poll`
invocations, some interrupted mid-walk; assert each poll's starting sequence ≥ the previous
poll's ending sequence and total requests across all polls = O(N), not O(N·K).

**R-3 · Storage.** §1.3: `ECHOLET_MAX_STORAGE_BYTES` is unenforced and there is no
per-mailbox occupancy cap, so the flood still fills the relay's disk without limit. The mark
makes one aspect slightly worse: a recipient who has read past its poison has no reason to
delete it, so it lingers to the 168 h cap. This is a **relay-availability** class, not a
delivery class, and this change does not touch it. It becomes live in wave 3, when two
relays become internet-reachable. *Measure:* relay data-dir growth per attacker request;
assert a cap exists or record its absence.

**R-4 · The mark is new state that can lose messages if it is wrong.** A client that
advances the mark past an envelope it never read skips that envelope permanently.
*Measure:* assert the mark only ever advances to a sequence present in a page the poll
actually received and judged; plus a lost-ack test (relay commits, response dropped) proving
the next poll re-offers rather than skips.

**R-5 · `CONTACT_NOT_TRUSTED` before the card is imported.** Today such an envelope is
re-offered on every poll and is delivered if the card is imported inside its lifetime. With
a mark it is passed once. Mitigated by the `contact import` reset (C4-3); the residual is a
peer trusted through some other path, or a card imported on a different device.
`specification.md:98` states both parties exchange and import cards *before* messaging, so
this is a supported-path regression only at the margin — but it is a real behaviour change
and must be pinned by a test, not waved away.

**R-6 · Identity is still free.** `POST /v1/device-records/publish`
(`apps/relay/internal/api/handler/device_record_handler.go:36-70`) stays unauthenticated.
This change makes minting identities useless for *wedging*, and useless for evading the
per-sender quota's effect on ordering — but not for R-3, and nothing bounds the number of
distinct senders in one mailbox. *Measure:* re-run the T55 probe at 4 / 50 / 500 identities
and assert delivery in all three, recording bytes and requests for each.

**R-7 · A pinned contact still occupies 16 slots** and can delay by 16 envelopes.
Unchanged, by design (T54).

**R-8 · Metadata.** Unchanged. The relay still sees exactly what `SEC-01 §6.2` says it sees.
The mark adds one per-(mailbox, device) integer, which is a function of the recipient's own
polling and reveals nothing about senders.

---

## 5. Cost to legitimate users — concretely

- **Steady-state two-party use: no extra round trip, no extra request, no measurable
  latency.** A normal mailbox holds 0–2 unacked envelopes and is drained in one page. The
  only addition is one integer field in the ack request body and its signature transcript.
- **Breaking transcript change, and it has a deadline.** `createMailboxAckMessage`
  (`packages/crypto-core/src/mailbox/auth.ts:22-27`) and its Go twin
  `CreateMailboxAckMessage` gain `read_through`. A client built before the change cannot ack
  against a relay built after it. The cost is **zero only if this lands before wave 3
  deployment** — which is the order this flow already fixes. Landing it after two relays are
  serving breaks every deployed client. This is the single largest scheduling constraint of
  the recommendation.
- **One-time relay data migration.** Existing `mailbox:` records have no ordering entry.
  Either wipe the relay data dir (acceptable: no production data exists and retention is
  168 h anyway) or backfill sequences in current key order. One documented step in the
  deployment runbook.
- **`contact import` costs one extra full mailbox walk** on the next poll — one page for a
  normal mailbox, and it is what makes R-5 recoverable.
- **Relay work per send:** one extra key write in the same transaction. Per poll: one extra
  key read per selected envelope. Both O(1) per envelope.

---

## 6. Alternatives, and why they were rejected

### Candidate 1 — mailbox-proportional walk alone

Rejected as a **complete** answer, adopted as **part** of the answer (C4-3). §2 measures
that alone it buys a linear price increase (≈113 identities / 1 801 envelopes / 473 MB for a
ten-minute wedge), leaves the amplification unbounded, and degrades the operator-visible
failure from exit 3 to exit 4. The orchestrator's prior that this is the cheapest genuine
closure is **refuted by the walk-cost arithmetic in §2**; what the 16-page bound was
protecting against — unbounded per-poll work on an attacker-fillable mailbox
(`inbound.ts:61-70`) — is a real concern, and the correct replacement is not a bigger
constant but a bound that is a function of the mailbox *plus* durable progress so the bound
is no longer load-bearing for correctness.

### Candidate 2 — proof-of-work on `/v1/device-records/publish`

Rejected. The attacker needs only 10²–10³ identities (4 today; ~113 for a ten-minute wedge
under candidate 1; 676 for an hour). At 1 s/identity single-core — already a painful
first-run cost on a phone — 113 identities cost an attacker ~2 minutes on one core, or
~4 seconds on 32 cores. To make 113 identities cost an attacker an hour you would need
~32 s/identity single-core, i.e. **30+ seconds of onboarding for every legitimate
first-time user**, and the attacker's hardware advantage means the ratio never improves in
the defender's favour. PoW is a constant-factor tax on a resource the attacker needs few of.
It also does nothing about the *bytes*, which §2 shows are the dominant cost, and nothing
once the attacker holds one identity per slot.

The project has already written this down: `SEC-01 §2.4` — *callsign PoW «не считается
достаточной защитой от Sybil-атак без дополнительных лимитов на уровне репитеров и
discovery»*. IP rate-limiting is likewise not a closure: `middleware/rate_limit.go:27-33`
keys the quota on the transport peer host alone (correctly refusing to trust forwarding
headers), so changing address defeats it.

### Candidate 3 — recipient authorisation (relay accepts only allowed senders)

Rejected. It does close the class completely, and it does match the product's mutual-contact
model. It violates **`SEC-01 §2` — "Echolet не использует центральный реестр пользователей"**:
a recipient-uploaded allow-list *is* a central registry, of relationships rather than of
users, held by the relay. Precisely:

- **§6.2** enumerates what the relay sees and confines it to *observed traffic* — the open
  identifiers on envelopes that actually transit. An allow-list makes the relay hold the
  recipient's contact set **including contacts who never send anything**, which is strictly
  more than §6.2 permits and is not derivable from traffic.
- **§3.3** defines contact confirmation as out-of-band (QR / safety number / invite packet).
  An allow-list moves a trust step onto the relay.
- **§5.1** deliberately separates the Contact Layer (`callsign → fingerprint`, UX only) from
  the Routing Layer (`identity key → device records / reachability`, transport only). An
  allow-list merges them at the relay.

A capability-token variant (the recipient hands each contact a signed sending ticket with the
contact card, and the relay verifies it against a published verification key without holding
a list) would avoid §2 and §6.2 — but it is a new protocol primitive, a contact-card format
change, a re-exchange of every existing card, and its own unmeasured revocation problem. It
is out of proportion to this wave and is recorded here as the option to revisit if C4 ever
proves insufficient.

---

## 7. Acceptance criteria

| AC | Verdict | Note |
|---|---|---|
| **AC1** — closure chosen by a written design task naming what it closes, what it does not, and why alternatives were rejected | **satisfied by this document** | §3, §4, §6 |
| **AC2** — the 4-identity / 49-envelope probe no longer prevents delivery; new attacker cost measured and stated; a bound reported as a bound | **satisfiable, and predicted to be a closure** | The number to measure is **not** a new wedge threshold (there should be none) but cost per delivered message: first-poll bytes/requests, steady-state cost, and monotone progress across interrupted polls. R-2 (an hour-long first walk at 2.8 GB) must be reported explicitly; the class must not be reported as closed with no residual |
| **AC3** — legitimate exchange, offline delivery, byte-identical exact retry and deduplication still pass; no pre-existing test weakened, skipped or deleted | **satisfiable, with one named hazard** | The ack transcript change touches ack signing and the E2E ack-recovery case; those must be re-run, not adjusted. `TestKnownResidueDistinctIdentitiesStillWedgeTheDrainWalk` **will fail after this change** — per its own T54 instruction it must be *re-measured and inverted*, never deleted |
| **AC4** — HTTPS on a non-loopback relay, full scenario from another machine | **cannot be satisfied by this task** | Wave 2. `relayClient.ts:66-71` already refuses non-loopback plain HTTP, so this is a precondition, not a nicety |
| **AC5, AC6** — operator console, no key material, unaudited-prototype notice | **cannot be satisfied by this task** | Wave 2 |
| **AC7** — two relay instances + runbook | **cannot be satisfied by this task** | Wave 3; note the migration step in §5 belongs in that runbook |
| **AC8** — documentation states what remains untrue | **partially prejudged here** | R-1…R-8 are the content AC8 must record; **R-3 (unenforced `ECHOLET_MAX_STORAGE_BYTES`) is a new item for it** |

---

## 8. RED-phase test strategy

**The governing rule comes from T47-TP-001**: a fixture that modelled a relay resuming at
the undelivered set would have turned a client-only change green while the real binary
stayed wedged. So:

> **No test in this wave may assert closure through a mocked `RelayClient`.** Client-side
> unit tests may pin walk logic; the closure claim rests only on the real-binary suite.

The harness already exists and must be reused: `apps/cli/test/e2e/two-process.test.ts`
builds `apps/relay/cmd/relay` from the tree, spawns it with `ECHOLET_*` env and waits on
`/health`; `apps/cli/test/globalSetup.ts` builds `apps/cli/dist/cli.js` exactly once per
vitest run.

### Real-relay tests that must be red before any production change

- **RED-1 · order is the relay's.** Store a legitimate envelope; then store poison with
  `envelope_id = 00000000-0000-1000-8000-…`. Assert the first poll page returns the
  legitimate envelope first. Red today (`validate.go:134` accepts the id;
  `mailbox_repo.go:429` orders by it).
- **RED-2 · closure at the recorded cost.** 4 self-published identities + 49 max-size poison
  + one legitimate message; assert `poll` exits 0 and history holds exactly 1. Red today
  (T55 `boundary_49poison`).
- **RED-3 · closure at 10× and 100×.** The same at 50 identities / 800 poison, and at a
  volume that exceeds *any* constant page cap. **This is the test a bigger constant cannot
  pass**, and therefore the one that forces the durable mark rather than a larger number.
- **RED-4 · monotone durable progress.** Interrupt the walk (kill the `poll` process, or let
  the rate limiter answer 429), then poll again. Assert the second poll's first page starts
  at a sequence strictly greater than the first poll's start, and that total requests across
  K polls is O(N) and not O(N·K). No fixture can fake this: it is an assertion about relay
  state across processes.
- **RED-5 · counters, not just booleans.** Every flood test asserts the `poll` exit code
  **and** the bytes and request count it consumed. A change that restores delivery by
  re-downloading everything on every poll passes the boolean and must fail on the counters.
- **RED-6 · late import.** Alice sends before Bob imports her card; Bob polls (refused),
  imports, polls again; assert delivered. Pins R-5 and the `contact import` mark reset.
- **RED-7 · mark authorisation.** A `read_through` signed by another device is refused 403;
  a `read_through` above any sequence the relay ever issued is refused
  `400 INVALID_SCHEMA` (same rule as `decodeMailboxCursor`, `mailbox_repo.go:252-269`); a
  lower `read_through` never rewinds the stored mark except through the explicit reset path.
- **RED-8 · no regression.** The existing three-iteration two-process E2E unchanged (offline
  delivery / restart / byte-identical exact retry / ack recovery), plus
  `go test -race -count=1 ./...` and the `relayv2` race run.

### Go-level tests (relay package)

- `SaveEnvelope` assigns strictly increasing sequences under ≥20 concurrent stores, `-race`.
- A byte-identical replay allocates **no** new sequence and does not move the envelope —
  preserving `mailbox_repo.go:66-89` and T54's quota replay exemption
  (`mailbox_handler.go:311-313`).
- `SenderOccupancy` and `DeleteEnvelope` still address by `(mailbox, envelope_id)` in O(1).
- Expired envelopes are still skipped before the cursor is consumed
  (`mailbox_repo.go:333-339`) and do not shift the mark.
- `GetEnvelopes` (`:95`) keeps scanning the primary prefix, so
  `TestGetEnvelopesFiltersExpiredBeforeApplyingBatchLimit` (`mailbox_repo_test.go:115-129`),
  which seeds raw keys, still passes untouched.

### Regression pinning

Replace `TestKnownResidueDistinctIdentitiesStillWedgeTheDrainWalk` with
`TestDistinctIdentitiesNoLongerWedgeTheDrainWalk`, parameterised on identity count, and
record the measured cost-per-delivered-message in the test so a future regression surfaces
as a number rather than a boolean. **Do not delete the original's intent** — the T54 report's
own instruction was to re-measure and update, never to remove.

---

## 9. Findings raised by this task

- **T5-F-001 (major)** — mailbox selection order is keyed on the sender-supplied
  `envelope_id` (`mailbox_repo.go:429-431`), and `validate.go:134` accepts ~10²⁸ ids that
  sort ahead of every legitimate random UUID. The attacker, not the relay, decides queue
  position, including ahead of envelopes already stored.
- **T5-F-002 (major)** — `ECHOLET_MAX_STORAGE_BYTES` (`config.go:12`) is declared and never
  enforced anywhere in `apps/relay`, and no per-mailbox occupancy cap exists despite
  `PROTOCOL-07:473` naming one. Mailbox size is bounded only by disk.
- **T5-F-003 (info)** — candidate 1 alone is a linear bound (§2), and it degrades the
  operator-visible failure from exit 3 to exit 4 `RELAY_UNAVAILABLE` via the victim's own
  rate limit (`relayClient.ts:140`, `cli.ts:372`).

---

## 10. Routing audit

- `graph_used`: **no** — `not-relevant`. Every navigation target was a named `file:line` from
  the dispatch and the T48/T54/T55 reports, or a targeted symbol search.
- `wiki_used`: **partial** — the authoritative documents for this task are
  `docs/SEC-01_IDENTITY.md`, `docs/requirements/echolet-cli-prototype/specification.md` and
  `docs/PROTOCOL-07_MVP_MESSAGE_FLOW.md`, read directly as the dispatch required.
- `ctx_used`: **yes** — `keryx ctx rg` for every search, `keryx ctx read` for compact reads,
  `keryx ctx run` for every command and for the probe.
- `raw_rg_used`: **no**.

## 11. Integrity

No file inside the repository was modified except this new report and the dispatch result
under `.metaproject/flows/002-…/`. The single probe
(`<scratchpad>/probe-order.mjs`) is outside the repository, reads nothing from it, performs
no network or filesystem access, and printed only labels, booleans and counts — no
plaintext, ciphertext, key material or HTTP body.
