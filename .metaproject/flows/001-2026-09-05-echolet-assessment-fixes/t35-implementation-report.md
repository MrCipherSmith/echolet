# T35 implementation report — poll capacity, rate limiting, derived body limit

Flow: `001-2026-09-05-echolet-assessment-fixes`
Dispatch: `001-T35-implement` (GREEN phase for the RED tests from `001-T35-tests`)
Items: F-009, F-010, F-011 (major) and T34-I-003 (minor, handed over from T34).

No test file was edited, skipped or deleted. No ciphertext, plaintext, key
material or request body is logged anywhere in these changes.

---

## F-009 — poll response byte budget and pagination contract

### The defect

`MailboxHandler.PollMailbox` fetched `cfg.MaxMailboxBatch` (default 100)
envelopes and always answered `next_cursor: null`. With
`ECHOLET_MAX_MESSAGE_BYTES = 262144` a full batch is roughly 25 MiB, while the
CLI refuses any response above 1 MiB (`apps/cli/src/transport/relayClient.ts`,
the streaming read bound). A mailbox holding more than three maximum-size
envelopes therefore produced a response the client rejected on every poll, and
because nothing was ever acked the mailbox could never drain. The CLI's own
`poll_batch_size` was validated by `config.ts` and then never sent, so the
client had no way to ask for a smaller batch either.

### Wire contract (orchestrator decision on T35-Q-001: `accept`)

Request `POST /v1/mailbox/poll` gains an optional `batch_size`
(integer `1..ECHOLET_MAX_MAILBOX_BATCH`): the client's requested upper bound on
the number of envelopes in one response. It is a preference, never an authority
— the server cap and the byte budget are still applied on top of it.

Response `data.next_cursor` widens from always-`null` to `string | null`.
Non-null means the response was cut short by one of the bounds and undelivered
envelopes remain; `null` means the mailbox is drained. The token is opaque and
server-controlled.

Both docs were updated to match: `docs/API-11_JSON_SCHEMAS.md` §10 and
`docs/PROTOCOL-07_MVP_MESSAGE_FLOW.md` §9.7.

The schema was widened without being weakened. On the TypeScript side
`next_cursor` is a **closed union** `z.union([z.string().min(1).max(256),
z.null()])` — not `.optional()`, not `.nullish()`, not `z.any()`, and the
surrounding response object keeps `.strict()`, so an unknown field in a poll
response is still rejected (the pre-existing `unknown-poll` assertion in
`inbound.test.ts` still passes). The request schema is likewise a `.strict()`
extension with `batch_size: z.number().int().min(1).max(100)`, matching the Go
bound and the `poll_batch_size` bound in `client-config.schema.json`.

### Server-side enforcement

`MailboxRepository.GetEnvelopeBatch(mailboxID, limit, byteBudget)` replaces the
unbounded fetch for the poll path (`GetEnvelopes` is untouched and still used by
the T34 lifecycle tests). It applies **both** bounds *during* Badger iteration,
so an over-limit batch is never materialized in memory:

- expired records are skipped before either bound is consumed (T34 semantics
  preserved);
- the stored Badger value **is** the envelope's own JSON encoding, so
  `len(val) + 1` (the array separator) is exactly what that envelope
  contributes to the response body — no re-marshalling, no estimate;
- selection stops on `len(batch) == limit` or on the byte budget, and in either
  case returns `HasMore = true`, which the handler turns into a non-null
  `next_cursor`.

**The budget is deliberately allowed to be exceeded by the first envelope
only.** `len(batch.Envelopes) > 0` guards the byte check, so a single envelope
at the configured maximum message size is always delivered; otherwise the
largest legal message would wedge the mailbox permanently. This is the property
`TestMailboxPollAlwaysReturnsAtLeastOneMaximumSizeEnvelope` guards.

Budget value: `pollEnvelopeByteBudget = 1 MiB − 4 KiB`. 1 MiB is the client's
hard response bound; the 4 KiB reservation covers the `{"ok":true,"data":
{"envelopes":[…],"next_cursor":"…"}}` wrapper (~60 bytes in practice), so a
batch this relay selects is never one the client has to refuse.

`pollBatchSize(requested)` resolves the count bound: the requested value when
the client asked for one and it is below the server cap, otherwise the cap. A
negative `batch_size` is rejected with `400 INVALID_SCHEMA`; absent or `0` means
"server default".

`next_cursor` carries a fixed, server-controlled token (`"more"`). It is
deliberately **not** derived from any stored envelope field: `envelope_id` is
sender-supplied and unvalidated for length, so echoing it would let a sender
inflate the cursor and re-break the client's response bound.

### Client-side wiring

- `Profile` exposes `get pollBatchSize()` reading `config.poll_batch_size`.
- `InboundMessenger.poll()` forwards it as `batch_size` on the poll request.
- `RelayClient.pollMailbox` now requires `batch_size` in its input type, so a
  caller cannot silently fall back to the relay's own maximum.

The CLI still performs one bounded poll per invocation; repeated `poll` runs
drain the mailbox, which is what the non-null `next_cursor` signals.

---

## F-010 — rate limiter no longer holds its lock across the handler

`rate_limit.go:31` used `defer rl.mu.Unlock()` inside `Middleware`, so the
single global limiter mutex was held for the entire duration of
`next.ServeHTTP`. One slow request serialized every route and every client,
including `/health`.

Quota accounting is now a separate `allow(key) bool` method that takes the lock,
prunes, accounts, decides, and releases — it performs no I/O, so the lock is
held for a bounded amount of work. `Middleware` calls it, and only afterwards
either invokes the downstream handler or writes the `429 RATE_LIMITED` body
(with `Content-Type: application/json`, which the previous rejection path
omitted). Counting semantics are unchanged: the first request in a window sets
`count = 1`, and a request is refused once `count > limit`.

---

## F-011 — quota keying and bucket pruning

**Keying.** `rate_limit.go:29` keyed on the full `r.RemoteAddr`, TCP source port
included. The one-command-per-process CLI opens a fresh connection per request,
so every request minted a fresh quota bucket and the limiter effectively did
nothing while leaking memory. `quotaKey` now strips the port with
`net.SplitHostPort` and canonicalizes IP literals through `net.ParseIP`, so
different spellings of one address (notably IPv6) share a bucket. An address
with no port is used as given rather than being guessed at.

**Forwarding headers.** `X-Forwarded-For` and `X-Real-IP` are never read. This
is now stated explicitly on the `RateLimiter` type: honouring client-supplied
forwarding headers would let any client mint unlimited fresh buckets by varying
a header it controls, so reverse-proxy support must be an explicit opt-in
configured with the set of trusted proxies and is never inferred from a header's
presence. No such opt-in is implemented, which is the declared behaviour rather
than an omission.

**Pruning.** Buckets whose window has elapsed are deleted by `pruneLocked`,
called at the start of `allow` and rate-limited to one sweep per
`idleBucketPruneInterval` (1 minute) of limiter time, so the sweep is amortized
rather than O(clients) per request.

**Test seam.** `*RateLimiter` now declares `SetClock(func() time.Time)` and
`TrackedClients() int`, both mutex-guarded (they are exercised under `-race`).
`SetClock(nil)` is ignored so the limiter can never end up without a clock.

---

## T34-I-003 — derived `/v1/messages/send` body limit

`request_body.go:18` pinned the send-route body bound to a hand-chosen 1 MiB
constant. Raising `ECHOLET_MAX_MESSAGE_BYTES` above roughly 1 MiB therefore made
the route reject legitimate maximum-size envelopes with 413 while validation
would have accepted them.

`MailboxHandler.envelopeBodyLimit()` now derives the bound as
`cfg.MaxMessageBytes + 64 KiB` (`envelopeJSONOverheadBytes`, room for the
surrounding JSON object and the envelope's other fixed fields, which are a few
hundred bytes in practice). A handler constructed with a non-positive
`maxMessageBytes` falls back to `defaultMaxMessageBytes` (262144, mirroring
`config.MaxMessageBytes`) rather than collapsing to the overhead alone.

T34's structure is preserved exactly: `SendEnvelope` still calls
`decodeJSONRequest`, which still wraps `r.Body` in `http.MaxBytesReader` before
`encoding/json` sees it, and an over-limit body still returns a bounded
`413 PAYLOAD_TOO_LARGE` without being streamed into the decoder
(`TestV1JSONHandlersBoundRequestBodyBeforeDecoding` still passes at all six v1
sites). `envelopeRequestBodyLimit` survives as the prekey-bundle publication
bound only; its stale comment about `MaxMessageBytes` was removed.

---

## Verification

| Suite | Result |
|---|---|
| `go -C apps/relay test -race -count=1 ./...` | pass, all packages |
| `go -C apps/relay test -race -count=1 -tags relayv2 ./...` | pass, all packages |
| `go -C apps/relay vet ./...` | clean |
| `npx vitest run src/transport src/runtime` (apps/cli) | 9 files, 36 tests, pass |
| `pnpm typecheck` (workspace) | pass, 7 projects |

The four new test files pass unmodified. `apps/cli/src/runtime/inbound.test.ts`
(owned by T36) was not touched and its 11 tests still pass.

**Deferred to the orchestrator:** `pnpm test` and
`apps/cli/test/e2e/two-process.test.ts` were NOT run — T36 is concurrently
fixing a build race in that harness. `apps/cli/src/commands/*.test.ts` was left
to the same acceptance run because those tests drive the built CLI through that
harness.

`apps/cli` declares no `lint` script, so no ESLint pass was available for the
TypeScript changes; `gofmt -l` is clean for every file touched here
(`internal/api/handler/signal_prekey_bundle_v2.go` is unformatted but predates
this task and was not modified).

## Residual concern

Configuring `ECHOLET_MAX_MESSAGE_BYTES` above roughly 1 MiB now produces
envelopes the relay accepts and stores but the current CLI cannot read: the
"always deliver at least one envelope" rule correctly refuses to starve the
mailbox, so such an envelope is returned in a response above the client's 1 MiB
bound. The two limits are related by configuration and nothing enforces the
relationship. Recorded as finding `T35-I-001`.
