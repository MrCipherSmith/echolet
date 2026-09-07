# T54 — per-sender unacked-envelope quota (GREEN phase for T53 / finding T52-F-001)

## What was asked, and what it is worth

T51 closed the *unauthenticated* attacker on `/v1/messages/send`. T52 then proved by
execution that the flooding class was not closed: `POST /v1/device-records/publish` is
itself unauthenticated, so an attacker mints an ed25519 identity, self-publishes one
device record for the cost of one HTTP request, and floods a victim with *perfectly
valid* signatures. The measured thresholds were unchanged by sender authentication —
48 maximum-size envelopes deliver, 49 wedge, and the wedge holds up to the 168 h
retention cap.

The user chose a per-sender quota as the next step, and was told plainly that this
raises the attacker's cost roughly **linearly** rather than closing the class. This
implementation is built on exactly that footing. Read the last section before quoting
this work as a fix.

## The quota

**16 unacked envelopes per `(recipient_mailbox_id, sender_identity_id)` pair.**

- **Legitimate use never reaches it.** A two-party conversation acknowledges on every
  poll, so the standing unacked count from any one sender is normally 0–2. One `send`
  is one envelope, so 16 means sixteen consecutive messages to a peer who has not
  polled even once — an order of magnitude of headroom over any realistic offline
  backlog.
- **One identity can no longer fill the drain walk.** In the worst (byte-bounded)
  regime T52 measured, the ~1 MiB poll response budget admits 3 maximum-size envelopes
  per page and the client walks 16 pages (`apps/cli/src/runtime/inbound.ts`), so the
  walk covers 48 envelopes. 16 < 48, so one identity occupies at most a third of it
  and 32 slots stay free for the message queued behind the poison.
- **Headroom against the wire.** 16 is far below `ECHOLET_MAX_MAILBOX_BATCH` (100), so
  a single poll page can still carry more than one sender's entire allowance.
- **Rejected alternatives.** 32 would leave `ceil(48/32) = 2` identities — barely an
  improvement. 8 would buy 6 identities but starts squeezing a genuine offline backlog.

The value is configurable as `ECHOLET_MAX_UNACKED_ENVELOPES_PER_SENDER`
(`apps/relay/internal/config/config.go`), **default 16**, applied in
`apps/relay/internal/api/router/router.go` through
`MailboxHandler.SetSenderUnackedQuota`. A non-positive configured value keeps the
default, following the rule `MailboxRepository.SetRetentionCap` already uses, so an
unconfigured `Config` cannot silently reduce a legitimate sender's allowance to zero.
`NewMailboxHandler`'s signature is unchanged, so every existing handler test keeps
constructing a handler at the default the T53 suite pins.

## Where it is enforced

`MailboxHandler.SendEnvelope` (`apps/relay/internal/api/handler/mailbox_handler.go`),
in this order:

```
decode → envelope required → ValidateMailboxEnvelope → expiry → authenticateSender
       → enforceSenderQuota → StoreEnvelope
```

- **After `authenticateSender`**, so an unauthenticated caller can never consume a real
  sender's allowance by claiming their identity id.
- **Before `StoreEnvelope`**, so a refused envelope never occupies a byte of the
  victim's mailbox. The T53 suite's only evidence for "before storage" is that the
  mailbox holds exactly 16 envelopes afterwards and the refused `envelope_id` is absent.
- **Not** in `validation.ValidateMailboxEnvelope`: three `internal/validation` tests
  call that function directly with unsigned envelopes, and it has no access to the
  mailbox contents. This is the same trap T50-I-001 recorded for sender authentication.

## The replay exemption

`enforceSenderQuota` returns *before* the count check when the
`(recipient_mailbox_id, envelope_id)` pair is already stored.

The invariant is exact: storing under a pair that already exists is either an
idempotent replay (`SaveEnvelope` compares the stored bytes and no-ops, leaving the
retention deadline untouched) or an `ENVELOPE_ID_CONFLICT` (refused, 409). Neither can
increase occupancy, so neither may be charged. Without this, F-004's byte-identical
retry — the operation a sender performs precisely when a response was lost at the
boundary — would fail with a condition the sender cannot clear, at exactly the moment
the retry is necessary. `TestIdempotentReplayDoesNotConsumeSenderQuota` is the
assertion; `TestAuthenticatedSendKeepsEnvelopeIDReplaySemantics` (T50) is the guard
that the 409 path is still not swallowed, and both pass.

## How the count is taken

`MailboxRepository.SenderOccupancy`
(`apps/relay/internal/storage/repository/mailbox_repo.go`), surfaced through
`MailboxService.SenderOccupancy`, scans the mailbox prefix and counts envelopes whose
`sender_identity_id` matches and whose `expires_at_ms` has not passed — **the same
predicate `GetEnvelopes` and `GetEnvelopeBatchFrom` already apply**.

It is deliberately **not** a counter incremented on send and decremented on ack. An
envelope also leaves a mailbox by simply passing its expiry, with nobody acknowledging
anything — which is the normal outcome when the recipient is offline, the case offline
delivery exists for. A send/ack counter never learns about that and would silence a
legitimate sender permanently. `TestExpiredEnvelopesDoNotConsumeSenderQuota` fails
against any such implementation.

The scan is bounded twice over, because its cost would otherwise be chosen by the
caller of the send route (T53-I-003):

- an already-stored `envelope_id` returns immediately, without scanning at all;
- counting stops as soon as the quota is reached — the only question asked is whether
  the bound has been *reached*, never how far past it the mailbox is.

So the work per send is O(quota) plus the expired and other-sender records the iterator
walks past. That residual term is not zero on a large mailbox and is noted rather than
claimed away; bounding it further would mean a per-(mailbox, sender) counter reconciled
against the same expiry predicate, which is a larger change than this task.

## The new error code

**`403 SENDER_QUOTA_EXCEEDED`, non-retryable, reported at exit 3.**

It follows the `UNAUTHORIZED_MAILBOX_ACCESS` (403) and `PREKEY_BUNDLE_UNAVAILABLE`
(404) precedent exactly: a non-retryable 4xx carrying a code both client allowlists
name — `remoteCodes` in `apps/cli/src/transport/relayClient.ts` and
`reportedRelayCodes` in `apps/cli/src/commands/cli.ts`. The documented 0/2/3/4/5
exit-code contract is untouched.

**It is deliberately not 429.** `relayClient.ts:133` classifies 429 (and every 5xx) as
retryable, and `cli.ts` `classify()` maps every retryable `RelayError` to
`RELAY_UNAVAILABLE` / exit 4 **without ever reading `remoteCode`**. A 429 would
therefore discard the diagnosis at the transport boundary, report a temporary
per-recipient condition to the operator as a generic relay outage, and put a legitimate
sender into a retry loop against a condition only the recipient (by acknowledging) or
time (by expiry) can clear. Both halves are asserted: `assertQuotaRejection` fails the
Go route on a 429, and the two TypeScript suites pin that a 429 `RATE_LIMITED` still
classifies retryable and still exits 4.

The relay's message names the precondition and echoes no caller-supplied value; the CLI
never renders a relay-controlled message into failure output.

## Documentation

- `docs/API-11_JSON_SCHEMAS.md` — the `/v1/messages/send` section now states the quota,
  its default, the env var, the non-429 requirement, the ack/expiry release, the replay
  exemption and the per-mailbox scoping; `SENDER_QUOTA_EXCEEDED` added to the standard
  error-code list.
- `docs/requirements/echolet-cli-prototype/specification.md` — new row in the
  failure-behavior table.
- `docs/PROTOCOL-07_MVP_MESSAGE_FLOW.md` — new send-route check alongside the existing
  mailbox quota line.

Each of the three states the residue as well as the rule.

## Verification

| Check | Result |
|---|---|
| `apps/cli` vitest | **22 files / 101 tests passed**, including both E2E suites and 3/3 real two-process runs |
| Workspace vitest | **162 passed** — cli 101, session-node 24, crypto-core 16, protocol 12, mobile 6, client-core 2, client-db 1 |
| `pnpm typecheck` | Done on all 7 projects |
| `go test ./...` (untagged) | all packages ok |
| `go test -race -count=1 -tags=relayv2 -timeout=300s ./...` | all packages ok, **0 data races** |
| `gofmt -l ./internal` | lists only the two files already unformatted before this task (`api/handler/signal_prekey_bundle_v2.go`, `storage/repository/signal_prekey_bundle_v2.go`); no file this task touched |
| `go vet ./...` | clean |

RED→GREEN, confirmed by execution: before the change the 6 new Go tests failed
(`status = 200 (code "")`, and *"the legitimate message was NOT reached within the
recipient's 16-page drain walk after one identity placed 36 of 36 attempted
envelopes"*) and 2 TypeScript cases failed; after it all pass. **No test file was
edited.** The three T53 test files and `apps/cli/vitest.config.ts` /
`apps/cli/test/globalSetup.ts` verify byte-identical by SHA-256 against the hashes the
T53 result recorded. Nothing is skipped, `.only`-ed or deleted anywhere in the repo.

`TestKnownResidueDistinctIdentitiesStillWedgeTheDrainWalk` is **still present and still
green**, exactly as designed.

## What this does NOT close — read this part

Stated plainly, because the user was told plainly.

`POST /v1/device-records/publish` remains unauthenticated (finding T52-F-001), so
identities remain free. A per-sender quota bounds one **sender**; **nothing bounds
total mailbox occupancy**. The attacker's cost moves from

- 1 identity + 49 maximum-size POSTs → **3 identities + 48 maximum-size POSTs** in the
  byte-bounded regime, and
- 1 identity + 800 POSTs → **50 identities + 800 POSTs** in the count-bounded regime.

That is a linear price increase on an attacker whose per-identity price is one HTTP
request. Once achieved, the wedge still holds for up to the 168 h retention cap.
`TestKnownResidueDistinctIdentitiesStillWedgeTheDrainWalk` publishes 3 identities, has
each fill its own 16-envelope allowance, and observes the recipient's real 16-page poll
walk still fail to reach the legitimate message behind them. It passed before this
change and passes after it — the quota changes nothing about that case, on purpose, and
the test exists so nobody has to rediscover it.

Closing the class needs a control the relay does not have today: binding send rate or
mailbox occupancy to something the attacker cannot self-mint (an authenticated or
rate-limited publication path, or a recipient-issued sending capability), or letting a
recipient drain permanently-unacceptable envelopes without the client's 16-page cap. If
the residue test ever starts failing, the class has been closed further than the quota
alone closes it — re-measure the new threshold and update the test, never delete it.

One further coupling worth recording (T53-I-004): the default of 16 was chosen against
the 48-envelope drain-walk capacity that `ECHOLET_MAX_MAILBOX_BATCH` and
`ECHOLET_MAX_MESSAGE_BYTES` produce at their defaults. An operator who raises either
widens the walk the quota was sized against, and nothing forces the quota to move with
it. The config comment says so at the declaration site.

## Files changed

| File | Change |
|---|---|
| `apps/relay/internal/storage/repository/mailbox_repo.go` | `SenderMailboxOccupancy` + `SenderOccupancy` — bounded live-envelope count and already-stored check |
| `apps/relay/internal/service/mailbox_service.go` | `SenderOccupancy` pass-through |
| `apps/relay/internal/api/handler/mailbox_handler.go` | `senderUnackedQuota` field, `defaultSenderUnackedQuota = 16`, `SetSenderUnackedQuota`, `enforceSenderQuota`, call site between `authenticateSender` and `StoreEnvelope` |
| `apps/relay/internal/config/config.go` | `MaxUnackedEnvelopesPerSender` (`ECHOLET_MAX_UNACKED_ENVELOPES_PER_SENDER`, default 16) |
| `apps/relay/internal/api/router/router.go` | applies the configured quota to the handler |
| `apps/cli/src/transport/relayClient.ts` | `SENDER_QUOTA_EXCEEDED` added to `remoteCodes` |
| `apps/cli/src/commands/cli.ts` | `SENDER_QUOTA_EXCEEDED` added to `reportedRelayCodes` |
| `docs/API-11_JSON_SCHEMAS.md`, `docs/requirements/echolet-cli-prototype/specification.md`, `docs/PROTOCOL-07_MVP_MESSAGE_FLOW.md` | the bound, the code, and the residue |
