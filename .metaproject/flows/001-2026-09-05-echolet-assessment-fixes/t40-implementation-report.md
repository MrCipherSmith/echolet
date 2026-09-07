# T40 implementation report — GREEN phase for the confirmed T38 findings

Run 001 · dispatch `001-T40-implement` · task-implementer
Scope: `apps/cli` runtime/commands and `apps/relay` validation. No test file was created, edited,
skipped or deleted.

---

## 1. HL-N-001 — per-envelope acceptance (`apps/cli/src/runtime/inbound.ts`)

### What was wrong

`InboundMessenger.accept` opened **one** `profile.withRuntime` transaction for the whole poll
batch and threw out of the `for` loop on the first unacceptable envelope. Two consequences
followed from the single `throw`:

1. the transaction rolled back, discarding envelopes that had already been accepted earlier in the
   same loop;
2. `poll()` never reached `ackPending()`, so **no ack request was ever issued** — not for the
   poison, and not for the legitimate envelopes queued behind it.

Because `/v1/messages/send` has no sender authentication, anybody holding a published contact card
can compute the mailbox id and drop one permanently-unacceptable envelope into it. The mailbox
then wedges permanently: every subsequent poll re-reads the same poison first, throws, and acks
nothing, so legitimate traffic ages out undelivered at the CLI's own 24h declared expiry.

### The design

**Per-envelope acceptance.** `accept()` is now a loop over envelopes; each envelope is admitted by
`acceptOne(envelope)`, which opens its **own** `profile.withRuntime` transaction containing exactly
the guards, the decrypt, the inbox dedupe write, the history append and the pending-ack write for
that one envelope. The body of the guard chain is unchanged — it was moved, not rewritten — so
every F-012 / F-003 rejection keeps its existing typed code and its existing ordering.

The transaction boundary is what makes isolation correct rather than merely convenient: a rejected
envelope rolls back only its own transaction, so it cannot leave a half-written inbox key or a
history row behind, and it cannot undo an envelope that already committed.

Only what was actually accepted becomes acknowledgeable: `acceptOne` writes
`cli:pending-ack:<envelope_id>` **inside** the envelope's own committed transaction, and
`ackPending()` acks exactly the pending keys. A rejected envelope never gets a pending key, is
never acked, and therefore stays queued at the relay.

**When nothing survives, the old contract is restored verbatim.** `poll()` re-raises the *first*
rejection when `received === 0 && rejected.length > 0`, before `ackPending()` is reached. This is
the constraint T41-N-001 identified: `inbound.test.ts:177` asserts full-store snapshot equality and
`acks() == []` for a batch containing only a poison envelope, which rules out any
"quarantine locally and ack it anyway" design. A poison-only batch therefore still throws
`CONTACT_NOT_TRUSTED`, still acknowledges nothing and still mutates nothing.

An empty batch is not a rejection: `received === 0` with no rejections returns normally.

### Permanent vs transient — the classification, and why it is drawn there

```ts
const isNotAnEnvelopeVerdict = (error: unknown): boolean =>
  error instanceof PersistenceError || error instanceof RelayError || error instanceof ProfileError;
```

- **Not a verdict about the envelope → abort the whole poll, rethrow, ack nothing.**
  `PersistenceError` (the local store refused to begin, read or commit — `profile.ts` raises it and
  only it for store-level failure), `RelayError` (the relay is unreachable, timed out, or answered
  unparseably) and `ProfileError` (the local profile metadata could not be read). None of these
  says anything about the envelope that happened to be in flight; all three can clear on retry.
  The specification is explicit — *"Decrypt or database commit failure | Do not ack; leave envelope
  retriable"* (`specification.md:133`) — so these propagate out of `accept()` immediately, the open
  transaction rolls back, `ackPending()` is never reached, and every envelope in the batch stays
  queued and unacknowledged. Isolating permanent rejections must never turn one of these into a
  discarded message, and it does not: the abort path is checked *before* anything is recorded as
  rejected.

- **Everything else is a permanent verdict about that one envelope → isolate it.**
  Untrusted or unpinned sender (`CONTACT_NOT_TRUSTED`, `CONTACT_PIN_MISMATCH`), misaddressed or
  out-of-lifetime envelope (`INVALID_ENVELOPE`), a message-ID reused with different ciphertext
  (`MESSAGE_ID_CONFLICT`), malformed base64url/wrapper/UTF-8, and a decrypt that does not
  authenticate (all surfacing as `INBOUND_REJECTED`, exactly as before). Retrying any of these can
  never succeed, because nothing about a retry changes the bytes or the pin.

Note what "isolated" does **not** mean: a permanently rejected envelope is still *not acked*, so
the relay keeps it queued and the specification's "leave envelope retriable" holds for it too. The
only thing that changed is that it no longer stops its neighbours from being delivered.

The classification is deliberately written as an allow-list of *non*-verdicts rather than a
deny-list of rejections. A new failure mode that nobody classified therefore defaults to
"permanent, isolated, not acked, still queued" — the conservative direction, because the envelope
survives at the relay either way, whereas defaulting the other way would let one unexpected
exception re-wedge the mailbox.

### Result shape (also HL-N-002)

```ts
{ received: number, more: boolean, rejected: Array<{ envelopeId: string; code: string }> }
```

`rejected` is in batch order. Per T41-N-002, `commands/cli.ts:304` returns the poll result verbatim
to stdout, so each entry carries **only** the relay-assigned `envelope_id` (a UUID, bounded by
`MailboxEnvelopeSchema` in the transport layer) and the typed rejection code. No ciphertext, no
plaintext, no store key, no other sender-supplied string reaches the entry — the type
`RejectedEnvelope` documents that constraint at the definition site.

## 2. HL-N-002 — the `next_cursor` remaining-work signal

F-009 added `next_cursor` to the poll response and `relayClient.ts:24` parses it as a closed
`string|null` union; the relay sets it to a fixed server-controlled token when it cut the response
short at its own batch or byte bound (`mailbox_handler.go:262-270`). `poll()` discarded it, so the
only read of the signal anywhere in the tree was a transport test.

`poll()` now returns `more: batch.next_cursor !== null`. The CLI `poll` command returns the poll
result verbatim, so `{"ok":true,"data":{"received":N,"more":true,"rejected":[]}}` reaches the
operator on stdout and a caller can loop until `more` is false. The cursor token itself is not
surfaced: its only defined meaning is "poll again", and the relay resumes from the undelivered set
on its own, so echoing it would imply a contract the relay does not have.

## 3. BE-R-001 — bounded envelope identifiers (`apps/relay/internal/validation/validate.go`)

`ValidateMailboxEnvelope` bounded the ciphertext but inspected no identifier length.
`recipient_mailbox_id` and `envelope_id` are the two halves of the Badger key
`mailbox:<recipient_mailbox_id>:<envelope_id>` built in
`storage/repository/mailbox_repo.go:261-263`; Badger refuses a key beyond its own maximum, so a
70000-byte identifier was refused by the **store** and surfaced as HTTP **500** on a route
(`/v1/messages/send`) that has no sender authentication at all. Purely attacker-supplied input
became an internal error.

Added `maxEnvelopeIdentifierBytes = 256` and a check over every identifier-shaped string field on
the envelope — `envelope_id`, `message_id`, `sender_identity_id`, `sender_device_id`,
`recipient_identity_id`, `recipient_device_id`, `recipient_mailbox_id`, `payload_type` — returning
`&ValidationError{Code: "INVALID_SCHEMA"}`, which `mailbox_handler.go:86-93` already maps to HTTP
400 with the client error code. Nothing is persisted, because validation runs before
`StoreEnvelope`.

Why all eight rather than only the two the finding named: they are the same class of
attacker-supplied string on the same unauthenticated route, and the two that reach the Badger key
today are only the two that happen to be interpolated into it now. The bound is stated once and
the field list is enumerated in one place (`mailboxEnvelopeIdentifiers`).

Why 256: it is far above every legitimate value — identity ids and mailbox ids are 43-character
base64url digests, envelope/message/device ids are 36-character UUIDs — and far below Badger's key
maximum, so the refusal is validation's rather than the store's with a wide margin. The bound is an
upper bound only; no new emptiness or format requirement was introduced, so every existing relay
test keeps passing unchanged (both handler and repository suites use short synthetic ids such as
`mailbox-ber001-control`).

The rejection message names the offending **field** and never echoes its value.

## 4. SEC-R-001 — the `inlineStringOptionValues` docstring (`apps/cli/src/commands/cli.ts`)

Documentation only; the behaviour was not touched. The docstring claimed the rewrite was narrow
"so that everything `parseArgs` and `parseCommand` reject today keeps reaching them unchanged",
which is false for one class: a declared string option now consumes the next argument even when it
looks like an option, so `send --text --json` moved from
`ERR_PARSE_ARGS_INVALID_OPTION_VALUE` / `INVALID_ARGUMENTS` / exit 2 to sending the literal body
`--json` with `--json` unset.

That behaviour is standard GNU/`getopt` semantics, is the whole point of the F-013 fix (`-`-leading
identity ids and message bodies must be addressable at all), and is pinned by
`cli.dashOptionValues.test.ts`. So the documentation was corrected, not the code: the docstring now
states the changed class explicitly, gives the escape (`--text=--json`, or put the flag first), and
keeps the four narrowness bullets — which remain accurate — under a preamble that no longer
over-claims.

---

## Verification

| Check | Result |
|---|---|
| `pnpm test` (root, 7 workspace packages) | 82 of 83 `apps/cli` tests pass; all other packages fully green (protocol 8, client-db 1, crypto-core 4, client-core 2, session-node 24, mobile 6). One assertion fails — see the finding below. |
| `apps/cli` RED suite from T41 | `inbound.batchIsolation.test.ts` 9 of 10 pass (RED baseline was 1 of 10); `inbound.test.ts` 11 of 11; `cli.dashOptionValues.test.ts` 18 of 18; e2e two-process 3 of 3. |
| `pnpm typecheck` | pass (all 7 packages) |
| `go -C apps/relay test -race -count=1 ./...` | pass — including both new BE-R-001 files |
| `go -C apps/relay test -tags relayv2 -race -count=1 ./...` | pass |
| `go vet ./...` | clean |
| `gofmt -l apps/relay/internal` | only `api/handler/signal_prekey_bundle_v2.go`, pre-existing and untouched by this task |

Bounded output for every run was recorded through `keryx ctx run`.

## Open finding — T40-N-001: `inbound.batchIsolation.test.ts:325` is unsatisfiable

The one failing assertion is, as far as I can determine, contradictory with the two assertions
around it, and I did not modify the test.

```
inbound.batchIsolation.test.ts:306-328
  "keeps the pending acknowledgement of an accepted envelope when the ack request fails,
   and never acks the poison"

  320  await expect(receiver.poll()).rejects.toMatchObject({ code: "RELAY_TIMEOUT" });
  324  await receiver.retryPendingAcks();
  325  expect(fake.ackedIds()).toEqual([legitimate.envelope_id]);   // FAILS: 2 entries, both legitimate
  327  expect(fake.queuedIds()).toEqual([poison.envelope_id]);
```

The proof that no implementation satisfies all three:

1. `fake.state.intercept` throws only for `path === "/v1/mailbox/ack"`, and `poll()` reaches the
   relay only via challenge, poll and ack. So line 320's `RELAY_TIMEOUT` **requires** that `poll()`
   issued an ack request.
2. `mailbox()` records `requests.push({ path, body })` at the top of the fetcher, *before*
   consulting `state.intercept` (line 129-133). The failed ack attempt is therefore recorded like
   any other request, and `ackedIds()` flat-maps `envelope_ids` over **all** recorded ack requests
   (line 149) — successful or not.
3. Line 327 requires the relay's queue to no longer hold `legitimate`, and the fake removes
   envelopes only inside its `/v1/mailbox/ack` branch, which is reached only after `intercept`
   returns. So `retryPendingAcks()` on line 324 **must** issue a second, successful ack request.
4. `legitimate` is the only pending ack at both moments, so both requests carry
   `envelope_ids: [legitimate.envelope_id]` and `ackedIds()` is necessarily two elements long.

The behaviour the test describes in prose is implemented and demonstrably correct: the poison is
never acked (`line 326` would pass), the accepted envelope's acknowledgement stays pending across
the relay failure rather than being dropped, and the retry drains it. Only the *count* of recorded
ack attempts is over-pinned.

Two one-line repairs, either of which keeps every guarantee the test is there to protect — for the
test author or the verifier to choose, not for me:

- `expect([...new Set(fake.ackedIds())]).toEqual([legitimate.envelope_id]);`
- `expect(fake.acks().at(-1)!.body.envelope_ids).toEqual([legitimate.envelope_id]);`

The equivalent scenario in `inbound.test.ts:247-262` avoids the problem by building a *fresh*
`mailbox()` for the retry, so its `requests` contains only the successful ack.
