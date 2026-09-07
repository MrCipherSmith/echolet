# T9 — Implementation report: RI-30, RI-23, RI-19 (and RI-31 held green)

Flow: `003-2026-09-07-echolet-residuals-and-tui`
Task: T9 (task-implementer) — make T8's RED tests pass by changing product code only.
Date: 2026-09-08 (UTC 2026-09-07T20:5xZ)

---

## 0. Outcome in one table

| Test | Residual | Before (T8) | After |
|---|---|---|---|
| `TestCleanupServiceStopEndsItsTickerGoroutine` | RI-30 | RED | **PASS** |
| `TestRelayStopsTheCleanupServiceBeforeClosingStorage` | RI-30 | RED | **PASS** |
| `TestBackfillSkipsUndecodableRecordAndBindsTheHealthyOnes` | RI-23 | RED | **PASS** |
| `TestBackfillReportsTheNumberOfSkippedRecords` | RI-23 | RED | **PASS** |
| `TestPreBindingIdentityStillAuthorizesWhenAnotherDeviceRecordIsUndecodable` | RI-23 | RED | **PASS** |
| `TestPublishPreKeyBundleRejectsOversizedIdentifiersWithClientError/bundle_id` | RI-19 | RED (500) | **PASS** |
| `TestPublishPreKeyBundleRejectsOversizedIdentifiersWithClientError/device_id` | RI-19 | RED (200, stored) | **PASS** |
| `TestPublishPreKeyBundleRejectsOversizedIdentifiersWithClientError/identity_id` | RI-19 | green (incidental) | **PASS** (now by the bound) |
| `TestPublishPreKeyBundleStillAcceptsV2ShapedIdentifiers` | RI-19 control | green | **PASS** |
| `TestRelayExitsZeroWhenTheDrainDeadlineIsExceeded` | RI-31 | green | **PASS** |
| `TestRelayExitsZeroOnASecondSignalDuringShutdown` | RI-31 | green | **PASS** |
| `TestMaximumSizeEnvelopeIsDeliverableAtRaisedMaxMessageBytes` | **RI-09** | RED | **still RED — out of scope, by instruction** |

Five product files changed, all under `apps/relay`, none of them a test file. `apps/cli`,
`packages/` and `docs/` untouched.

---

## 1. RI-30 — the cleanup timer could not be stopped

### What was wrong

`CleanupService.Start()` created a `time.Ticker` inside the call, launched
`for range ticker.C { s.runCleanup() }` in a goroutine, kept no stop channel and never
called `ticker.Stop()`. `router.NewRouter` constructed the service, started it and returned
a bare `*chi.Mux`, so no caller held a handle. Nothing — including `cmd/relay`'s shutdown
sequence, whose entire step 3 exists so that no writer outlives the store — could end that
goroutine.

It is harmless today only because `runCleanup()` has an empty body (RI-63). That is the
hazard, not the excuse: an unstoppable timer plus an empty body plus (until T8) no test in
`internal/service` at all is exactly how "a transaction against a closing store" comes back
without anyone noticing.

### What changed

**`apps/relay/internal/service/cleanup_service.go`**

- `CleanupService` gained a `sync.Mutex` and two channels, `stop` and `stopped`. They exist
  only between a `Start` and the `Stop` that answers it, and they are published under the
  lock because `Start` and `Stop` genuinely run on different goroutines: the router builds
  and starts the service, `cmd/relay`'s signal handler stops it.
- `Start` is now a no-op on a service that is already running, so a second call cannot
  strand a goroutine that `Stop` can no longer reach. Its goroutine `select`s on the ticker
  and on `stop`, and defers both `ticker.Stop()` and `close(stopped)` — deferred so a panic
  in `runCleanup` releases the shutdown sequence instead of parking it forever on a
  goroutine that is never coming back.
- `Stop()` closes `stop` and then **waits** on `stopped`. It is idempotent and safe on a
  service that was never started.

**Why `Stop` joins rather than merely signalling.** The caller stops this service so that
nothing is still writing when Badger closes. A `Stop` that only signalled would return
while `runCleanup` was mid-transaction, which is the same defect one line further down —
it would satisfy the test's polling assertion and still leave the hazard. The join is the
property; the log line is only how a process-level test can see it.

**`apps/relay/internal/api/router/router.go`**

- Added `type Router struct { *chi.Mux; cleanup *service.CleanupService }` with
  `func (r *Router) Stop()`. `NewRouter` now returns `*Router`.
- The mux is **embedded**, not wrapped, so `*Router` is still an `http.Handler` everywhere
  one is expected: `server.New(cfg, handler http.Handler)` takes it unchanged, and the four
  existing `NewRouter(...)` call sites in `signal_prekey_bundle_v2_test.go` and
  `signal_prekey_bundle_v2_mailbox_test.go` keep compiling and passing untouched, because
  they use the result as an `http.Handler` and call the promoted `ServeHTTP`.

**`apps/relay/cmd/relay/main.go`**

- New `stopBackgroundWorkAndCloseStorage(r *router.Router, st *storage.Storage, code int)`,
  which calls `r.Stop()` and then `closeStorage(st, code)`. All four paths that closed the
  store after the router exists now go through it: the `server.New` failure, both branches
  of the serve-error `select`, and the ordinary end of `run()`.
- Step 3 of the shutdown comment now names the ticker and says why it belongs to the same
  step as the drain.

**Where the cleanup service is stopped, exactly.** Between the drain and the Badger close.
The observed stop log of the real binary is now:

```
Cleanup service started      (startup)
Shutdown signal received; draining in-flight requests
In-flight requests drained
Cleanup service stopped      <-- here
Storage closed
```

`TestRelayStopsTheCleanupServiceBeforeClosingStorage` asserts exactly that ordering on the
real process, and it passes.

### Alternatives rejected

- **`NewRouter` returning `(*chi.Mux, *service.CleanupService)`.** This is the shape the
  T8 achievability patch used out of tree, and it is the obvious one — but it breaks the
  four existing single-assignment call sites in the router package's own tests, and this
  task may not change a test file. Rejected on that ground alone; the embedded-mux handle
  gets the same lifecycle with no caller edits.
- **`defer r.Stop()` in `run()`.** Wrong order. `run` returns `closeStorage(...)`, so the
  deferred stop would execute *after* Badger had already closed — the precise inversion the
  residual is about, and the test would have caught it.
- **A context-cancellable `Start(ctx)`.** The RED test explicitly allows this. Rejected
  because `main.go`'s stop is a plain sequence of calls with no context threaded through it,
  so a context would have had to be manufactured at the top of `run()` purely to be
  cancelled twenty lines later, and `Stop` would still have had to exist for the sequence
  to call. Two mechanisms where one does.
- **Stopping the ticker without joining** (`close(stop)` and return). Cheaper, and it would
  have gone green. Rejected: see above — the join is the property being bought.

---

## 2. RI-23 — one malformed record denied service to unrelated identities

### What was wrong

`BackfillDeviceMailboxBindings` collected every device record in a single `View` loop and
returned the **first** `json.Unmarshal` error it met, discarding every record already
collected and never reaching the ones after it. `router.go:39` logs that failure and starts
the relay anyway. So one undecodable record — a truncated write, a value from an older
schema, one corrupted page — left **every** pre-binding identity unbound, on a relay that
answers `/health`, looks entirely healthy, and refuses its legitimate owners at their first
authorization step with `UNAUTHORIZED_MAILBOX_ACCESS`. The blast radius of one bad record
was every unrelated identity in the store.

The per-record `Update` also had no conflict retry, unlike `Save`, and `return err` on it
abandoned the rest of the scan too.

### What changed

**`apps/relay/internal/storage/repository/device_record_repo.go`**

- A record whose bytes will not decode is **skipped and counted** (`skipped++`, `return nil`)
  instead of aborting the scan. The healthy records before and after it are collected and
  bound as normal.
- The distinction between a bad *record* and a bad *store* is kept: an error still returned
  from `it.Item().Value(...)` came from Badger (an unreadable value log), not from the
  record, and it is still returned. Only `json.Unmarshal` failure is absorbed.
- New `saveDeviceMailboxBindingWithRetry`, which wraps the per-record write in the same
  bounded `deviceRecordConflictRetries` loop `Save` already uses. The backfill runs at start
  while the relay can already serve, so a device publishing itself at that moment can make
  this transaction conflict; without the retry that conflict was returned and abandoned
  everything after it. This is the second half of the RI-23 row and is not pinned by any
  test — it is included because it is the same defect on the same scan.
- When `skipped > 0` the repository logs
  `slog.Warn("skipped undecodable device records during mailbox binding backfill", "skipped", n, "bound", m)`.

**Why the count is logged rather than returned.** The relay starts regardless of what the
backfill returns, so a silent skip would only trade one invisible failure for another: the
store would be quietly missing bindings with nothing anywhere saying so. `slog` is where the
relay already reports its startup facts. The log carries **counts only** — no key, no
identity, no stored value — because a device-record key contains the identity it belongs to
and this is a startup line, not an audit record.

### Alternatives rejected

- **Returning `(skipped int, err error)`** from the repository and letting `router.go` log
  it. Marginally purer, and it puts the operator-facing message next to the other startup
  logging. Rejected because it changes `DeviceRecordService.BackfillMailboxBindings`'s
  signature and both its call sites for no behavioural gain, and because the T8 test
  captures `slog` around the **repository** call directly — the count has to be reported
  from where the skip happens.
- **Deleting the undecodable record.** Tempting and wrong. The backfill's job is to derive
  an index, not to destroy stored data it cannot read; a record the *current* model cannot
  decode may be perfectly readable by an older or a newer one, and a startup path that
  silently deletes on a decode failure is a far worse hazard than the one being fixed.
- **Failing the relay's start on any skip.** Rejected: it converts a one-record problem
  into a total outage, which is the RI-23 defect wearing a different hat.

---

## 3. RI-19 — unbounded prekey-bundle identifiers

### What was wrong, as measured (not as the row said)

T8's finding T8-F-002 corrected the inventory row in both directions, and the measurement
holds on this tree:

- `bundle_id` at 65 000 bytes → **HTTP 500 `INTERNAL_ERROR`**. It is the second half of the
  Badger key `prekey_bundle:<identity_id>:<bundle_id>`, so it hit Badger's key ceiling and
  the store, not validation, answered malformed client input.
- `device_id` at 65 000 bytes → **HTTP 200, accepted and stored**. It reaches no key at all,
  so nothing refused it and 65 kB of attacker-chosen identifier went into stored state. The
  row did not describe this case.
- `identity_id` at 65 000 bytes → already a bounded 4xx, but only **incidentally**: it
  doubles as the ed25519 verification key, so an over-long value fails signature
  verification before it can become a key. That is a coincidence of this route's shape, not
  a bound, and it evaporates the moment `identity_id` stops being the key.

`/v1/prekeys/publish` is unauthenticated in the sense that matters: the bundle only has to
verify against its own freshly generated identity key, so all three identifiers are
attacker-chosen.

### What changed

**`apps/relay/internal/validation/validate.go`**

- `ValidatePreKeyBundle` gained the same `MaxIdentifierBytes` loop `ValidateDeviceRecord`
  has at `:30-37`, over all three of `identity_id`, `device_id` and `bundle_id`, returning
  `400 INVALID_SCHEMA` with the field name and never the value.
- It runs **before** signature verification, so an over-long value answers with the bound it
  violated rather than with a signature complaint. This changes `identity_id`'s refusal from
  `INVALID_SIGNATURE` to `INVALID_SCHEMA` — the case was already refused, and no test pinned
  the old code; the new one is the accurate answer.
- `MaxIdentifierBytes`' own doc comment now lists `ValidatePreKeyBundle`'s three identifiers
  among the validators sharing the constant.

Nothing is stored on the refused path: validation runs before
`h.service.PublishPreKeyBundle`, and the test asserts zero stored bundles under the claimed
identity for all three fields.

**The bound is a bound, not a closed route.** 256 bytes is far above every legitimate value
— 43-character base64url identity keys and 36-character UUIDs — and
`TestPublishPreKeyBundleStillAcceptsV2ShapedIdentifiers`, which publishes with exactly the
shapes the v2 path accepts, stays green with the bundle stored.

### Alternatives rejected

- **Bounding only `bundle_id`**, which is what the inventory row's own wording describes.
  Rejected on T8-F-002: that leaves `device_id` accepting and storing 65 kB unbounded, and
  the `device_id` subtest is RED precisely to prevent a fix scoped by the row's description.
- **Adopting the v2 UUID/base64 *shape* rules** (`uuidV2`, 32-byte raw base64url) on the v1
  route. Rejected: the RED test deliberately pins no shape, and a shape rule on a live v1
  route is a compatibility decision about real published bundles, not a bounds fix. Recorded
  as a residual below.
- **Removing `/v1/prekeys/publish` as dead**, the row's second option. Rejected: it is
  mounted at `router.go:68` and the control test requires it to keep accepting legitimate
  publications, so removal would be a scope change, not this fix.

---

## 4. RI-31 — the escalation paths

No product change. Both `TestRelayExitsZeroWhenTheDrainDeadlineIsExceeded` and
`TestRelayExitsZeroOnASecondSignalDuringShutdown` were green before this task and are green
after it, including with the new `r.Stop()` now sitting in the sequence they exercise. The
job was to not break them, and the drain-deadline and second-signal branches of `main.go`'s
`select` are byte-for-byte unchanged; only the shared tail after that `select` gained the
cleanup stop.

---

## 5. RI-09 — deliberately left RED

`TestMaximumSizeEnvelopeIsDeliverableAtRaisedMaxMessageBytes` is **still RED** and was not
touched, by instruction: the poll byte budget is a two-sided relay+CLI change and has been
split into its own task. T8-F-001 establishes why no relay-only fix exists — capping
acceptance collides with `TestSendEnvelopeBodyLimitIsDerivedFromMaxMessageBytes`, and
raising the poll budget cannot reach the fixed `size > 1024 * 1024` at
`apps/cli/src/transport/relayClient.ts:144`. No relay-only workaround was attempted, and
`TestSendEnvelopeBodyLimitIsDerivedFromMaxMessageBytes` was verified still passing.

---

## 6. Verification

Go matrix, `apps/relay`, `-count=1`:

| Configuration | Result | Data races |
|---|---|---|
| `go test ./...` | only `TestMaximumSizeEnvelopeIsDeliverableAtRaisedMaxMessageBytes` fails; every other package `ok` | n/a |
| `go test -race ./...` | identical: same single failure | **0** |
| `go test -race -tags relayv2 ./...` | identical: same single failure | **0** |

- `go vet ./...` → exit 0. `go vet -tags relayv2 ./...` → exit 0. `go build ./...` → exit 0.
- `gofmt -l apps/relay` lists exactly the three pre-existing RI-35 files
  (`internal/api/handler/mailbox_read_mark_test.go`,
  `internal/api/handler/signal_prekey_bundle_v2.go`,
  `internal/storage/repository/signal_prekey_bundle_v2.go`). None of the five files changed
  here is on that list, and none of those three was reformatted.
- `pnpm typecheck` → exit 0 (Go-only change; the JS suite's 15 TUI failures belong to the
  concurrent 003-T5/T6 work and were not touched).

Test-file identity, by SHA-256, all **unchanged** from T8's result JSON:

| File | sha256 |
|---|---|
| `internal/service/cleanup_service_stop_test.go` | `c2105ce47c51ec42cbd89659e4e004533bfd82f7c5996d9f20ae93391161f511` |
| `internal/server/process_shutdown_escalation_test.go` | `02a6b385d8b757f4eda3c58cfdae386e8b74f806b186928429142a0dfde7fdcf` |
| `internal/storage/repository/device_record_backfill_test.go` | `3bd2c52609c89b8b9b3524d3b4f6a050f4b40d38c660eb564117bf162db5f52f` |
| `internal/api/handler/mailbox_backfill_authorization_test.go` | `d59fffc334b69249560b88a2608e8cc1bc372cae10c4c36494aa9965470e2f96` |
| `internal/api/handler/mailbox_poll_byte_budget_derivation_test.go` | `d3ad8fa2e661ba4b360bcc58208327b444265f208931d2cd10c38b3d2f9f5819` |
| `internal/api/handler/prekey_bundle_identifier_bounds_test.go` | `a125d20b1ce3158c7af6d003374ef8e44206f361aaca1fd4c153e8838e863a05` |
| `internal/server/process_shutdown_test.go` (pre-existing) | `c38372f5ff4a983d6ad39799dfda28e36e5d9e8625131094222bc5eb08329155` |

`git status --porcelain` over `apps` shows five modified files, all non-test, all under
`apps/relay`:

```
 M apps/relay/cmd/relay/main.go
 M apps/relay/internal/api/router/router.go
 M apps/relay/internal/service/cleanup_service.go
 M apps/relay/internal/storage/repository/device_record_repo.go
 M apps/relay/internal/validation/validate.go
```

(`apps/cli/src/tui/history-pane.ts` and `apps/cli/src/tui/pane-fit.ts` also appear; they
belong to the concurrent TUI task and were not touched here.)

**Safety.** No store key, private key, plaintext or HTTP request body is printed or recorded
by any line added. The one new startup log carries two integers. The one new stop log
carries no fields at all. No host was contacted; `geekom` and `depr` were not touched and
everything ran locally.

---

## 7. Residuals

| # | Residual | Where | Why it is left |
|---|---|---|---|
| T9-R-1 | **RI-09 is still open and its test is still RED.** | `internal/api/handler/mailbox_poll_byte_budget_derivation_test.go` | Explicitly out of this task's scope; split into its own two-sided task per T8-F-001 / T8-Q-001. |
| T9-R-2 | **RI-63 is untouched.** `CleanupService` still carries `mailboxRepo`, `challengeRepo` and `mailboxTTL` unused, and `runCleanup()` is still two `slog.Debug` calls. | `internal/service/cleanup_service.go` | Not in scope. RI-30 was its stated prerequisite and is now closed, so RI-63 can proceed: whoever gives `runCleanup` real Badger work now has a `Stop` that joins before the store closes. |
| T9-R-3 | **The four `NewRouter` call sites in the router package's own tests never call `Stop`.** Each leaks one goroutine parked on a 3600s ticker for the life of the test binary. | `internal/api/router/signal_prekey_bundle_v2_test.go`, `signal_prekey_bundle_v2_mailbox_test.go` | Harmless (parked, never fires, dies with the process) and unfixable here: this task may not change a test file. A one-line `defer r.Stop()` in each closes it. |
| T9-R-4 | **`ValidatePreKeyBundle` bounds identifier *length* but not *shape*.** The v2 path requires UUIDs for `bundle_id`/`device_id` and a 32-byte base64url key for `identity_id`; v1 still accepts any ≤256-byte string. | `internal/validation/validate.go` | Deliberate. The RED test pins no shape, and a shape rule on a live v1 route is a compatibility decision about already-published bundles, not a bounds fix. |
| T9-R-5 | **An over-long `identity_id` on `/v1/prekeys/publish` now answers `INVALID_SCHEMA` where it previously answered `INVALID_SIGNATURE`.** | `internal/validation/validate.go` | Intended: the length bound now runs first, so the answer names the rule actually violated. Nothing pinned the old code, and the T8 test requires only a typed non-`INTERNAL_ERROR` client code. Recorded because it is a visible wire-level change on a case that was already refused. |
| T9-R-6 | **Skipped device records are counted but never identified or repaired.** An operator learns that *n* records are undecodable, not which ones. | `internal/storage/repository/device_record_repo.go` | Deliberate: a device-record key contains the identity it belongs to, and this is a startup log line, not an audit record. Identifying them needs a diagnostic path with its own redaction rules, which is a separate item. |
| T9-R-7 | **`saveDeviceMailboxBindingWithRetry` is not covered by a test.** The retry half of the RI-23 row is pinned by nothing; it is exercised only incidentally on the non-conflicting path. | `internal/storage/repository/device_record_repo.go` | Provoking a Badger `ErrConflict` deterministically needs a concurrent writer fixture, and this task may not add a test file. |
| T9-R-8 | **RI-35 gofmt residual unchanged.** Three files remain unformatted. | `internal/api/handler/mailbox_read_mark_test.go`, `internal/api/handler/signal_prekey_bundle_v2.go`, `internal/storage/repository/signal_prekey_bundle_v2.go` | Out of scope by instruction; not reformatted. No file changed here was added to that list. |

---

## 8. Routing audit

- `graph_used`: **no** — not-relevant. Every source was named by `file:line` in T8's result
  JSON and the T1 inventory; the one navigation question (who calls `NewRouter`) was a
  single exact-symbol search.
- `wiki_used`: **no** — not-relevant. The design reasoning for all three items lives in the
  T1 inventory row, the T8 findings and the long comments in the sources themselves, all
  read directly.
- `ctx_used`: **yes** — `keryx ctx run` for every build, vet, gofmt, test and git command;
  `keryx ctx rg` for every search; `keryx ctx read` for the large sources.
- `raw_rg_used`: **no**.
