# T34 implementation report — relay findings F-004, F-005, F-006, F-007

Flow: `001-2026-09-05-echolet-assessment-fixes`
Dispatch: `001-T34-implement` (GREEN phase for the RED tests from `001-T34-tests`)
Scope: `apps/relay` production code only. No file under `apps/cli` or `packages/**` was touched, and no test file was modified, skipped or deleted.

## F-004 (blocker) — envelope_id is immutable per mailbox

`MailboxRepository.SaveEnvelope` previously wrote unconditionally, so a second
envelope submitted under an already-used `(recipient mailbox, envelope_id)` pair
silently replaced the accepted record.

`apps/relay/internal/storage/repository/mailbox_repo.go` now reads the existing
record inside the same optimistic transaction and branches on it:

- key absent -> write the record with a bounded retention deadline;
- stored bytes identical to the marshalled envelope -> return `nil` without
  writing, so the replay is idempotent and the original retention deadline is
  preserved;
- stored bytes different -> return `model.ErrEnvelopeIDConflict` and leave the
  stored envelope untouched.

The transaction is replayed through a new `update` helper while Badger reports
`badger.ErrConflict` (bounded at 64 attempts, mirroring the existing `updateV2`
helper in `signal_prekey_bundle_v2.go`). `DeleteEnvelope` uses the same helper.

`model.ErrEnvelopeIDConflict` was added in
`apps/relay/internal/model/mailbox_envelope.go`. Its error string is the wire
code, matching the existing `model.ErrV2*` convention. `MailboxHandler.SendEnvelope`
maps it to **HTTP 409 / `ENVELOPE_ID_CONFLICT`**, the code
`apps/cli/src/transport/relayClient.ts` already expects. The handler keeps the
existing `INTERNAL_ERROR` mapping for every other storage failure.

## F-005 (major) — retention follows the declared lifetime, retrieval filters expiry

Submission (`apps/relay/internal/api/handler/mailbox_handler.go`): after schema
validation, `SendEnvelope` rejects an envelope whose `expires_at_ms` is already in
the past with **HTTP 400 / `INVALID_SCHEMA`** and never stores it. `INVALID_SCHEMA`
was chosen over a new `ENVELOPE_EXPIRED` code deliberately (implementer note 4):
`packages/protocol` is owned by a parallel worker this run and carries no expiry
code. The handler reads the clock through an injected `nowMS func() int64` field
so the check stays testable; the public five-argument `NewMailboxHandler`
signature is unchanged.

Retention (`mailbox_repo.go`): the flat `WithTTL(7 * 24 * time.Hour)` is replaced
by an explicit absolute deadline written to `badger.Entry.ExpiresAt`:

```
deadline = min(envelope.ExpiresAtMs / 1000, now + retentionCap)
deadline = max(deadline, now)      // never 0, which Badger reads as "keep forever"
```

`retentionCap` defaults to `DefaultMailboxRetentionCap` (168h, mirroring
`config.MailboxTTLHours`) and is applied from config by `NewRouter` through
`MailboxRepository.SetRetentionCap`. A non-positive value is ignored so an
unconfigured `Config` cannot silently collapse retention to zero (the router's own
`signalV2RouterConfig()` test fixture leaves `MailboxTTLHours` unset).

An identical retry does not extend expiry because the F-004 replay branch returns
before any write.

Retrieval (`GetEnvelopes`): expired records are skipped **without consuming the
batch budget** — the loop only increments `count` for envelopes whose
`ExpiresAtMs` is still in the future — so a stale record can no longer wedge the
receiver's poll. `limit <= 0` now short-circuits instead of reaching Badger with a
non-positive `PrefetchSize`.

## F-006 (blocker) — bounded v1 bodies and a real ciphertext-length check

New file `apps/relay/internal/api/handler/request_body.go` holds the v1 decoder
contract: `decodeJSONRequest` wraps `r.Body` in `http.MaxBytesReader` before
handing it to `encoding/json`, answers `http.MaxBytesError` with **HTTP 413 /
`PAYLOAD_TOO_LARGE`** and any other decode error with the previous **HTTP 400 /
`INVALID_JSON`**.

All six enumerated v1 decoder sites use it:

| Site | Limit |
|---|---|
| `mailbox_handler.go` `SendEnvelope` | 1 MiB (`envelopeRequestBodyLimit`) |
| `mailbox_handler.go` `CreateChallenge` | 64 KiB (`compactRequestBodyLimit`) |
| `mailbox_handler.go` `PollMailbox` | 64 KiB |
| `mailbox_handler.go` `AckMailbox` | 64 KiB |
| `device_record_handler.go` `PublishDeviceRecord` | 64 KiB |
| `prekey_bundle_handler.go` `PublishPreKeyBundle` | 1 MiB |

The send route's 1 MiB limit stays well above `config.MaxMessageBytes` (262144)
so a legitimate maximum-size envelope still passes; the v2 sibling's 64 KiB is
correctly too small for that route (implementer note 3). The v2 surface
(`signal_prekey_bundle_v2.go:31`) was already bounded and is unchanged.

Other variable-length request fields are bounded in the same contract:
`AckMailbox` rejects `envelope_ids` longer than the configured mailbox batch
(falling back to 1000 when unconfigured), and `PublishPreKeyBundle` rejects
`one_time_prekeys` longer than 1000.

`validation.ValidateMailboxEnvelope` (`validate.go`) now derives the authority
from the actual decoded ciphertext instead of trusting `size_bytes`:

1. `len(Ciphertext) > maxBytes` -> `PAYLOAD_TOO_LARGE`;
2. `SizeBytes > maxBytes` -> `PAYLOAD_TOO_LARGE` (kept, so an inflated declaration
   is still refused);
3. `SizeBytes != len(Ciphertext)` -> `INVALID_SCHEMA`.

The two-argument signature `ValidateMailboxEnvelope(envelope, maxBytes)` is
unchanged and the expiry check lives in the handler, per implementer note 2.
`size_bytes == Buffer.byteLength(ciphertext)` is the CLI contract, so consistent
envelopes keep validating.

## F-007 (blocker) — identity-scoped mailbox device authorization

`DeviceRecordRepository.GetByDeviceID` scanned `device_record:*` globally and
stopped at the first device-UUID match, so a UUID published under an unrelated
identity denied service to the legitimate mailbox owner. It has been **removed**
along with `DeviceRecordService.GetByDeviceID`.

A second, immutable key space is introduced:

```
device_record:<identity_id>:<device_id>   -> the signed device record   (unchanged)
device_mailbox:<mailbox_id>:<device_id>   -> the owning identity_id     (NEW)
```

`<mailbox_id>` is `cryptoutil.DeriveMailboxID(identity_id)`, so the binding is a
pure function of the record and two different identities can never collide on the
same binding key. `SaveDeviceMailboxBinding` writes it inside the caller's
transaction and is first-writer-wins: an existing binding is never rebound.

Both publication paths populate it:

- **v1** — `DeviceRecordRepository.Save` writes the record and the binding in one
  transaction, with the same bounded conflict retry;
- **v2** — `saveSignalV2Authorization` (`signal_prekey_bundle_v2.go`) writes the
  binding inside the bundle publication transaction, on both the fresh-write and
  the identical-replay branch. A failed or conflicting v2 publish aborts the
  transaction, so no binding leaks (`TestFailedSignalV2PublishDoesNotAuthorizeMailboxChallenge`,
  `TestConflictingSignalV2PublishCannotReplaceMailboxAuthorization` still pass).

`GetByMailboxAndDevice(mailboxID, deviceID)` resolves the binding, then loads the
record by its exact `(identity, device)` key, and returns `badger.ErrKeyNotFound`
when no device is bound to that mailbox. `MailboxHandler.authorizeMailboxDevice`
now calls it instead of scanning; the previous string-compared
`errors.New("mailbox ownership mismatch")` is replaced by the package-level
sentinel `errMailboxOwnershipMismatch`, kept only as defence in depth against the
two key spaces diverging. Both failure modes still answer **HTTP 403 /
`UNAUTHORIZED_MAILBOX_ACCESS`**, so an attacker cannot distinguish "no binding"
from "wrong owner".

## Storage and compatibility implications

- **Mailbox key layout is UNCHANGED** — still `mailbox:<recipient_mailbox_id>:<envelope_id>`.
  The tests-creator's seeding helpers (`seedStoredEnvelope`,
  `mailboxEnvelopeKeyForTest`) therefore needed **no** edit, and implementer
  note 1's permitted test change was not used. No test file was modified.
- **New key space `device_mailbox:<mailbox_id>:<device_id>`.** Existing device
  records written before this change have no binding and would otherwise fail
  authorization. `DeviceRecordRepository.BackfillDeviceMailboxBindings` derives
  the missing bindings from the stored records and is invoked once from
  `NewRouter` via `DeviceRecordService.BackfillMailboxBindings`. It is idempotent
  (the binding is a pure function of the record) and safe to run at every start.
  A backfill failure is logged and does not prevent the router from starting.
- **Envelope retention semantics changed.** Records are now written with an
  absolute `ExpiresAt` derived from the envelope's declared lifetime instead of a
  flat seven days. Envelopes already in Badger keep the deadline they were written
  with; `GetEnvelopes` additionally filters them logically by `expires_at_ms`, so
  already-expired legacy records stop being delivered immediately, without a
  migration. An envelope stored with a declared expiry already in the past (only
  reachable by bypassing the handler) is written as immediately expired rather
  than without a deadline.
- **No protocol or CLI change is required.** `ENVELOPE_ID_CONFLICT` is already in
  `apps/cli/src/transport/relayClient.ts`; the expired-envelope rejection reuses
  the existing `INVALID_SCHEMA`; `PAYLOAD_TOO_LARGE` at HTTP 413 is a new status
  for an existing code.

## Verification

- `go -C apps/relay build ./...` — exit 0
- `go -C apps/relay vet ./...` — exit 0
- `go -C apps/relay test -race -count=1 ./...` — exit 0, all packages ok
- `go -C apps/relay test -race -count=1 -tags relayv2 ./...` — exit 0, all packages ok
- All six new tests (11 subtests) verified PASS by name; F-007 verified at
  `-count=10`.

Bounded evidence: `.metaproject/data/gdctx/artifacts/2026-09-06T13-27-47-408Z_run.md`
(untagged) and `.metaproject/data/gdctx/artifacts/2026-09-06T13-27-57-168Z_run.md`
(`-tags relayv2`).
