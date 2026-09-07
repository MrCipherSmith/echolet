# T16 — implementation report

Task: make the T15 RED set pass by changing product code only.
Findings closed: **T10R3-F-001** (re-walk crash safety), **T10R3-F-002** (ack-route count oracle),
**T10R3-F-003** (loopback hostname rule).

Runtime: Node **v26.5.0** (the default non-login interpreter; `bash -lc` starts v22.12.0, which lacks
`node:sqlite` and makes `packages/session-node` fail to collect in a way that looks like broken code).
Go toolchain run with `GOCACHE=<repo>/.gocache`.

No test file was modified. The five files T15 touched are byte-identical to T15's recorded digests
(§6). One new **product** file was added, `apps/cli/src/transport/loopback.ts`.

---

## 1. T10R3-F-001 — the contact-import re-walk is now crash-safe

### 1.1 What was wrong

`Profile.takeMailboxRewalk()` **deleted** the durable position `cli:mailbox-rewalk` before the walk
began, and `keepMailboxRewalk()` wrote it back only after the page loop returned or from the `catch`
around it. The entire walk was therefore a window in which the position existed in no durable place.
A process that ended inside that window — `inbound.ts` itself names an operator's Ctrl-C as a NORMAL
interruption — dropped the recovery silently and permanently: the relay-held mark is already past the
envelope the import was performed for, every later poll is cursorless and resumes after it, and
nothing tells the operator that the `contact import` they performed was spent for nothing.

### 1.2 What was done — peek-and-advance

`apps/cli/src/runtime/profile.ts`

| before | after |
|---|---|
| `takeMailboxRewalk()` — read **and delete**, returns the position | `pendingMailboxRewalk()` — read **only**, returns the position; writes nothing at all |
| `keepMailboxRewalk(position)` — called once, after the loop | `keepMailboxRewalk(position)` — unchanged code, now called **once per fully judged page** |
| (none) | `finishMailboxRewalk()` — deletes the key; the sole removal site |

`apps/cli/src/runtime/inbound.ts`, `poll()`

- the walk now opens with `let rewalk = await this.profile.pendingMailboxRewalk();` — nothing is
  consumed;
- inside the page loop, immediately after the page has been fully judged and in the same place
  `read_through` is computed:
  - `batch.next_cursor === null` → `await this.profile.finishMailboxRewalk()` and `rewalk = undefined`;
  - otherwise → `await this.profile.keepMailboxRewalk(batch.next_cursor)` and `rewalk = batch.next_cursor`;
- the `try/catch` that used to put the position back, and the post-loop `keepMailboxRewalk`, are
  **removed**. There is nothing to restore, because nothing is ever taken away.

### 1.3 Where it is written, where it is cleared, and why no interruption can fall between them

- **Written** in exactly two places: `contact import` (`commands/cli.ts` →
  `Profile.requestMailboxRewalk()`, the value `"0"` = the head), and the page loop above
  (`Profile.keepMailboxRewalk(next_cursor)`), once per page the walk received and fully judged.
- **Cleared** in exactly one place: `Profile.finishMailboxRewalk()`, called from the page loop and
  only when the relay reported `next_cursor === null` — i.e. the walk was offered and judged every
  envelope the mailbox holds, so there is nothing left to re-walk.
- **Why nothing can fall between them.** There is no "between". The old shape had two operations, a
  removal and a restoration, with the whole walk in the gap. The new shape has **one** operation per
  page: a single store transaction that *replaces* position P(k-1) with position P(k). Before it
  commits, durable storage holds P(k-1); after it commits, P(k). At no instant does it hold nothing.
  Formally, the invariant that holds continuously from `contact import` until the walk reaches the end
  of the mailbox is:

  > the store holds a position **at or behind** the position this walk has actually reached.

  An interruption at any point — inside the HTTP request, inside `accept()`, between two pages, before
  or after a commit — therefore costs the repeated judging of at most one page, never a lost message.
  A judgement interrupted part-way through a page has not advanced the position, so that page is
  re-offered rather than skipped, which is also the R-4 direction: the position never runs ahead of
  ground the recipient was actually served.

  The one exit that removes the position is the end of the mailbox, and an interruption *there* is
  equally safe in the other direction: if the process dies after the last page's envelopes are
  committed but before `finishMailboxRewalk()`, the position survives at the second-to-last page and
  the next poll re-walks one page and then clears it.

### 1.4 The trap, and why this is not it

Delete-before-the-walk was deliberate: finding **T6-F-004** says a re-walk position that survives its
own SUCCESSFUL walk restarts every later poll at the same place and reinstates the whole mailbox
flooding class, with every unit test still green. Passing the crash-safety tests by never clearing the
position would have been a worse defect than the one being repaired.

This fix does not do that. The position is still cleared, on exactly the same condition as before —
the walk reaching the end of the mailbox — and the guards say so on the running tree:

- `rewalk-crash-safety.test.ts` case 4 (the T6-F-004 guard): 0 of the pages served after the completed
  re-walk began again at poison index 0, three ordinary polls cost ≤ 6 pages, history holds exactly 1;
- `flood-closure.test.ts` RED-4b: after a re-walk that ran to the end of the mailbox, the next
  ordinary poll presents **no cursor** at all.

### 1.5 Alternatives rejected

- **Never clear the position.** Reinstates T6-F-004 and the whole flooding class. Rejected on the
  merits and pinned red by the two guards above.
- **Move the re-walk floor onto the relay.** Rejected by the orchestrator and not attempted: the relay
  is the adversary-adjacent component, and `contact import` is an offline trust operation that makes
  no relay request at all. Putting the recovery position there hands the flooding adversary a lever on
  the one path that recovers from flooding.
- **Keep take-and-restore but add a `process.on("SIGINT")` flush.** Rejected: it cannot cover SIGKILL,
  an OOM kill or a power loss, and the crash-safety suite deliberately pins both SIGINT and SIGKILL.
  It also adds a signal handler to a library boundary that has none.
- **Write the position on every page even with no re-walk pending (i.e. a locally held read mark).**
  Rejected: that is exactly the state finding T6-F-005 removed and F-012's store-identity guarantee
  forbids. The relay stays the durable holder of an ordinary walk's mark; the local key exists only
  while a re-walk is in flight.

### 1.6 F-012 store identity — shown, not asserted

`pendingMailboxRewalk()` contains no `tx.set` and no `tx.delete`; when no re-walk is pending the poll's
re-walk path performs no store mutation whatsoever. The repository's own measurement of that property
is `apps/cli/src/runtime/inbound.readMark.test.ts`, which snapshots **every key and value** of the
encrypted store (`snapshot()`, lines 91-96) before a poll that accepts nothing and asserts
`toEqual(before)` afterwards:

```
✓ src/runtime/inbound.readMark.test.ts (2 tests) 5476ms
  ✓ a page walk that judged nothing still records what it judged (T5 C4-3) >
    raises the typed rejection, acknowledges no envelope and mutates nothing, but advances the read position
```

green on this tree. Its `cast()` never calls `requestMailboxRewalk`, so that poll is precisely "an
ordinary poll with no re-walk pending". The end-to-end counterpart, flood-closure **RED-4b**, is green
as well.

---

## 2. T10R3-F-002 — the ack route no longer answers the mailbox envelope count

### 2.1 What was done — the shape/range split, exactly as T14 did on the poll route

`apps/relay/internal/api/handler/mailbox_handler.go`, `AckMailbox`:

- `decodeReadThroughShape` (pure shape check on client input) **stays where it was**, ahead of
  `authorizeMailboxDevice`. That is what the pre-existing malformed-shapes test demands: malformed
  input must answer a bounded `400 INVALID_SCHEMA`, never 500, and never depend on authorisation.
- `readThroughWithinIssued` (the bound that CONSULTS THE MAILBOX via `HighestIssuedPosition`) **moved
  from before `authorizeMailboxDevice`'s successor to after `VerifyMessageSignature`**, immediately
  before `AckEnvelopes`. This is the identical ordering the poll route already uses.

Consequence: a caller who cannot produce a verifying signature never reaches the range check, so every
probe — in range or out of range — gets the one uniform `403 INVALID_SIGNATURE`. The binary search that
recovered the victim's lifetime received-envelope count in ~13 requests has nothing to compare.

Naming a real `device_id` was never a mitigation: `mailbox_id = sha256(identity_id + ":mailbox:v1")`
and both `identity_id` and `device_id` are printed on the same contact card, so the set of callers who
can compute the mailbox id is the set who can read the device id off the card.

The doc comment on `readThroughWithinIssued` was updated to record that both routes now apply it after
the signature verifies, and why the device-binding step was not enough.

### 2.2 Alternatives rejected

- **A special-case uniform error code for signature-less acks carrying a position.** Explicitly ruled
  out by the dispatch, and it is the wrong shape: it leaves an authorisation-dependent branch in place
  and invites the next reader to reintroduce a distinguishable answer. The split removes the branch.
- **Deleting the R-4 range bound.** Would close the oracle and open the far worse hazard: a client
  reporting a position beyond the end of its own mailbox marks envelopes judged that it was never
  offered, permanently. The bound is unchanged; it simply now applies to a caller the relay has
  established. `TestAckReadPositionBoundSurvivesForAnAuthenticatedCaller` and
  `TestAckRefusesAReadThroughAboveAnyPositionTheRelayIssued` both pin this and both are green.
- **Moving the shape check behind authorisation too.** Would break
  `TestAckRefusesAReadThroughTokenThisRelayCouldNotHaveIssued`, which requires the five malformed
  shapes to answer `400 INVALID_SCHEMA` independently of who is asking. Not done.

---

## 3. T10R3-F-003 — one loopback rule, shared

New file `apps/cli/src/transport/loopback.ts` exports the single predicate:

```ts
export const isLoopbackHostname = (hostname: string): boolean =>
  hostname === "localhost" || hostname === "[::1]" || /^127\.(?:\d{1,3}\.){2}\d{1,3}$/.test(hostname);
```

`RelayClient` (`transport/relayClient.ts`) and `parseClientConfig` (`runtime/config.ts`) both import it.
`RelayClient`'s old `/^127\./` prefix test — a test on the first four characters of a *name*, which
admitted `127.evil.example`, `127.0.0.1.evil.example` and `127.example.com` as loopback and would have
carried every relay request to an attacker-chosen host in plaintext — is gone.

The shared rule is the **stricter** of the two originals, and it is byte-for-byte the rule
`parseClientConfig` already enforced, so nothing that worked before stops working: `127.0.0.1`,
`127.9.9.9`, `localhost` and `[::1]` over plain HTTP are accepted by both, which every e2e suite in the
repository depends on. `127.1` is normalised to `127.0.0.1` by the WHATWG URL parser before it reaches
the predicate, so both components accept it, together.

Nothing was relaxed: no schema changed, and the direction of every changed answer is refusal.

### Alternatives rejected

- **Loosen `parseClientConfig` to the prefix rule so the two agree.** Agreement in the unsafe
  direction; that is the defect, not the fix.
- **Have `relayClient.ts` import from `runtime/config.ts`.** Would put the transport behind the
  runtime's configuration module, inverting the existing dependency direction (`runtime/inbound.ts`
  imports `transport/relayClient.ts`). A dependency-free leaf module both sides import keeps the
  direction intact and gives the rule one home.
- **Duplicate the strict regex in both files.** Leaves exactly the failure mode this finding is about:
  two copies that can drift apart again. The agreement test in the RED suite is written as a property
  over URLs precisely to forbid that.

---

## 4. Results — each previously failing test, by name

Baseline handed over: 7 vitest failures + 1 Go failure. All 8 now pass.

| # | Test | Result |
|---|---|---|
| 1 | `relayClient.loopbackHostname.test.ts` › RelayClient loopback rule › refuses plain HTTP to `http://127.evil.example/` | PASS |
| 2 | `relayClient.loopbackHostname.test.ts` › refuses plain HTTP to `http://127.0.0.1.evil.example/` | PASS |
| 3 | `relayClient.loopbackHostname.test.ts` › refuses plain HTTP to `http://127.example.com:8081/` | PASS |
| 4 | `relayClient.loopbackHostname.test.ts` › agrees with parseClientConfig about every relay URL | PASS |
| 5 | `rewalk-crash-safety.test.ts` › a `SIGINT` during the contact-import re-walk does not lose the message | PASS (17.4 s) |
| 6 | `rewalk-crash-safety.test.ts` › a `SIGKILL` during the contact-import re-walk does not lose the message | PASS (10.5 s) |
| 7 | `rewalk-crash-safety.test.ts` › carries the re-walk position strictly forward across interrupt-and-resume, never rewinding to the head | PASS (9.5 s) |
| 8 | `TestAckDoesNotAnswerTheMailboxEnvelopeCountToAnUnverifiedCaller` | PASS (0.04 s) |

The whole file `relayClient.loopbackHostname.test.ts` reports `(10 tests)` passed, so the six control
cases in it (genuine loopback, HTTPS remote, plain-HTTP remote) are green too.

Green guards that had to stay green, and did:

| Guard | Result |
|---|---|
| `rewalk-crash-safety.test.ts` › does not repeat a re-walk that completed (T6-F-004) | PASS (12.3 s) |
| `flood-closure.test.ts` › RED-4b: a poll with no re-walk pending presents no cursor | PASS (2.8 s) |
| `flood-closure.test.ts` › RED-4: an interrupted poll resumes after the pages it already judged, walk stays O(N) | PASS (11.5 s) |
| `flood-closure.test.ts` › RED-6 (control + attack), RED-1, RED-7, all three closure/cost cases | PASS (9/9 in file) |
| `TestAckRefusesAReadThroughAboveAnyPositionTheRelayIssued` | PASS |
| `TestAckSignatureMustBindReadThrough` | PASS |
| `TestAckRefusesAReadThroughTokenThisRelayCouldNotHaveIssued` | PASS |
| `TestAckWithoutReadThroughStillAcknowledgesAndDeletes` | PASS |
| `TestAckDoesNotAnswerTheMailboxEnvelopeCountToAnUnknownDevice` | PASS |
| `TestAckReadPositionBoundSurvivesForAnAuthenticatedCaller` | PASS |
| `inbound.readMark.test.ts` › …mutates nothing… (F-012 store identity) | PASS |

## 5. Full matrix

| Command | Exit | Result |
|---|---|---|
| `pnpm typecheck` | 0 | 7 projects, all Done |
| `pnpm lint` | 0 | no package defines a `lint` script (unchanged from baseline) |
| `pnpm test` | 0 | **50 test files, 293 tests, 293 passed, 0 failed** (protocol 3/12, client-db 1/1, crypto-core 4/20, client-core 2/2, session-node 3/24, mobile 1/6, cli 36/228) |
| `pnpm --filter @echolet/cli test:e2e` | 0 | 1 file, **3/3 passed** (two-process, 36.6 s) |
| `go -C apps/relay test ./...` | 0 | 8 packages ok, 8 with no test files, **0 failures, 0 DATA RACE** |
| `go -C apps/relay test -tags relayv2 ./...` | 0 | 8 ok, **0 failures, 0 DATA RACE** |
| `go -C apps/relay test -race ./...` | 0 | 8 ok, **0 failures, 0 DATA RACE** |
| `go -C apps/relay test -race -tags relayv2 ./...` | 0 | 8 ok, **0 failures, 0 DATA RACE** |
| `go -C apps/relay vet ./...` | 0 | clean |

Baseline was 286/293 vitest and exactly one Go failure in each of the four configurations. The test
*count* is unchanged at 293 — no test was added, removed, skipped, narrowed or weakened; the seven that
were red are green.

## 6. Test-file integrity (SHA-256, re-measured after all edits)

| File | SHA-256 | vs T15 |
|---|---|---|
| `apps/cli/test/e2e/flood-closure.test.ts` | `f610412439f83971d463e12472a2a9de4109f7e216b3ebbcde42bd408a544124` | unchanged |
| `apps/cli/test/e2e/rewalk-crash-safety.test.ts` | `1983630054ddbb5f6d6b37f3e803821fc3b935822f2a27641253a96bc92e1bf2` | unchanged |
| `apps/cli/src/transport/relayClient.loopbackHostname.test.ts` | `8c6a21459360149581ca96e9cb72d43f94de1be2e3a00150243751ebd29e2d1f` | unchanged |
| `apps/relay/internal/api/handler/mailbox_ack_read_position_oracle_test.go` | `87d92255345727c5c09c681284cdf74c18f04303d335900030ee9956eeb23d98` | unchanged |
| `apps/relay/internal/api/handler/mailbox_read_mark_test.go` | `7624bba01e74e4457573d77236f84eec308f0ef40468726685fc9b285aacc8ca` | unchanged |

## 7. Product files changed

- `apps/cli/src/runtime/profile.ts` — `takeMailboxRewalk` → `pendingMailboxRewalk` (peek);
  `finishMailboxRewalk` added; comments rewritten.
- `apps/cli/src/runtime/inbound.ts` — page loop advances/clears the position durably per page;
  `try/catch` restoration and the post-loop write removed.
- `apps/cli/src/transport/loopback.ts` — **new**, the single loopback predicate.
- `apps/cli/src/transport/relayClient.ts` — imports it; the `/^127\./` prefix rule removed.
- `apps/cli/src/runtime/config.ts` — imports it; the inline regex removed.
- `apps/relay/internal/api/handler/mailbox_handler.go` — `readThroughWithinIssued` moved behind
  `VerifyMessageSignature` on the ack route; comments updated.

No test file, no `flow.json`, no frozen acceptance criteria was touched. No Zod schema and no Go
validation was relaxed. No plaintext, ciphertext, store key, profile key, private key material or HTTP
request body appears in any log or artifact produced here.

## 8. Residuals

1. **R-1 (carried from T15-F-003, unresolved by design).** The re-walk crash-safety suite exercises one
   interruption point (held on the third poll page) and one ciphertext regime (4-byte minimum). Other
   interruption points — inside `accept()` between two envelopes of a page, between the last page's
   commits and `finishMailboxRewalk()`, inside `ackPending()` — and the maximum-size-ciphertext regime
   where the relay's byte budget rather than `poll_batch_size` sets the page boundary are argued
   correct in §1.3 but not measured. The verifier should sweep them.
2. **R-2 (prose drift in test files I may not edit).** Comments in
   `apps/cli/test/e2e/rewalk-crash-safety.test.ts` (lines 17, 18, 29, 238) and
   `apps/cli/test/e2e/flood-closure.test.ts` (lines 600-601, 648) still describe the code as it was
   before this task and name `takeMailboxRewalk`, a method that no longer exists. Every assertion they
   guard is unaffected, and they are the record of *why* the tests were written; updating them would be
   a test-file edit, which this task forbids. Recommend a separate housekeeping pass.
3. **R-3 (pre-existing, untouched).** `gofmt -l apps/relay` reports three files:
   `internal/api/handler/mailbox_read_mark_test.go` (a T15 file — not mine to edit),
   `internal/api/handler/signal_prekey_bundle_v2.go` and
   `internal/storage/repository/signal_prekey_bundle_v2.go` (both pre-existing and outside this task's
   scope). `mailbox_handler.go`, which I did change, is gofmt-clean.
4. **R-4 (behavioural, accepted).** A poll that is interrupted while a re-walk is in flight now leaves
   the re-walk position advanced rather than cleared, so the *next* poll presents a cursor where it
   previously presented none. That is the intended change and is what flood-closure RED-4 was
   deliberately re-stated to permit; it is called out here because any future reader of RED-4b must not
   generalise "an ordinary poll is cursorless" to "every poll after a crash is cursorless".
5. **R-5 (scope note).** Concurrent `poll` invocations against the *same* profile directory from two
   processes are not serialised by anything in this change (they were not before either). Two
   simultaneous re-walks would each advance the same key; the invariant in §1.3 still holds for each
   (the key only ever moves to a position some walk genuinely reached), but the slower walk may find
   the position further ahead than it left it. Out of scope for this task; the store's own
   single-writer transaction guarantee is what bounds the damage.
6. **R-6 (not a defect, worth recording).** `finishMailboxRewalk()` issues a `tx.delete` on a key that
   is always present when it is called. If a future caller invokes it speculatively it is a no-op on
   the key but still opens a store transaction, which an ordinary poll must not do (F-012). It is
   deliberately called only from inside the `rewalk !== undefined` branch for that reason.
