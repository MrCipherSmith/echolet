# T22/T33 — the zero maximum, and the dead cleanup field

Flow 003, tasks T22 and T33 taken as one, because they share
`apps/relay/internal/config/config.go`.

Tree at start: HEAD `1ed5b2a`, `apps/relay` clean. Machine: macOS arm64, Go 1.26.1,
`node` v26.5.0 (the default non-login interpreter). Reads first:
`t11-implementation-report.md` (residual R-3), `dispatches/003-T21-tests-result.json`
(finding T21-F-001), `t28-reconciliation-report.md` §2.3 and §3.

Two other agents were working concurrently; `apps/cli/**` carries their
modifications and nothing here touched it.

---

## 0. Method: tests first, and how to check that

Every product edit below was preceded by a test that failed for the right reason.
The run that proves it is
`.metaproject/data/gdctx/raw/2026-09-08T17-08-55-348Z_run.log`, taken before a
single line of product code had changed:

| Test (written first) | Failure observed, before any product edit |
|---|---|
| `TestAnUnconfiguredMaxMessageBytesCarriesAnEnvelopeOfTheProtocolMaximum` | `SendEnvelope(ciphertext = the protocol maximum, 262144) ... status = 400, want 200 (error code "PAYLOAD_TOO_LARGE")` |
| `TestLoadRefusesAnExplicitlyZeroMaxMessageBytes` | `Load() returned nil for an explicit ECHOLET_MAX_MESSAGE_BYTES=0 (MaxMessageBytes = 0)` |
| `TestTheConfigurationSurfaceOffersNoCleanupInterval` | `Config.CleanupIntervalSec still declares ECHOLET_CLEANUP_INTERVAL_SECONDS` |
| `TestNewRouterStartsACleanupTickerWithoutAConfiguredInterval` | `panic: non-positive interval for NewTicker` at `cleanup_service.go:60`, from `router.go:69` |

The last one is a finding in its own right and was not predicted by either source
report — see §3.2.

Two further tests were written in the same pass and were green before and after.
They are guards on the *direction* of the fix, not drivers, and they are labelled
as such in the code:

- `TestAnUnconfiguredMaxMessageBytesIsTheProtocolMaximumAndNotUnbounded` — green
  before only vacuously (at zero the relay refused everything, including the
  oversized envelope). It is what stops "resolve the zero" from being implemented
  as "ignore the field when it is zero".
- `TestLoadIgnoresACleanupIntervalAnOperatorSetsAnyway` — a deployment guard: a
  removed knob must be inert on a host that still exports it, never a startup
  failure.

One test was written after a measurement rather than before: §3.3.

§1 lists the product edits; §2 lists the test edits. Nothing appears in both.

---

## 1. T22 — the zero: consistency, plus a refusal where the operator is

### 1.1 The decision, and why

**Chosen: make the fallback consistent, so a zero genuinely means "use the
default" everywhere — AND refuse an explicitly-set zero at startup.** The two are
not alternatives; they answer two different questions that the previous code
could not tell apart.

Refusing `<= 0` in `Validate()` was rejected on the merits, not merely because of
the test churn:

1. **A zero-value `Config` is a supported way to build this relay.** `internal/server`
   constructs one directly, and `Validate()` is called from `server.New()`, so
   outlawing the struct's zero value means every partial `Config` anywhere must
   remember one unrelated field. Measured: six tests, §1.4.
2. **"Unconfigured" has a correct answer.** The protocol maximum is the number
   both sides already derive every other bound from. Answering "unconfigured"
   with it is not a guess.
3. **It would not have closed the operator-facing hole cleanly.** A refusal in
   `Validate()` cannot distinguish an unset variable from an explicit `0`; it
   would have refused the struct default in order to reach the operator, which is
   the wrong end.

But consistency alone is not enough, and the dispatch is right about that. An
operator who writes `ECHOLET_MAX_MESSAGE_BYTES=0` **set** the variable and meant
something by it — most plausibly "no limit", the convention plenty of other
software uses. Silently substituting 256 KB would be a second reinterpretation of
a plainly stated intent. So the two halves are split along the line where the
information actually exists:

- **`Validate()` (a Config value)** — zero is permitted, unchanged, and now
  *works*.
- **`Load()` (the environment)** — `os.LookupEnv` can tell "unset" from "set to
  0", so the explicit zero is refused there, the way the half-configured TLS pair
  and the above-the-ceiling maximum already are.

### 1.2 What an operator setting zero now sees

`ECHOLET_MAX_MESSAGE_BYTES=0` no longer starts. `config.Load()` returns, and
`cmd/relay` exits on:

> `ECHOLET_MAX_MESSAGE_BYTES is set to 0, which disables the relay: the send route
> validates every ciphertext against this bound, so the relay would come up
> healthy, answer /health, and refuse every legitimate envelope as
> PAYLOAD_TOO_LARGE with nothing anywhere saying why. It is not a way to switch the
> limit off - there is no such setting, because the maximum is a protocol constant
> both sides derive their bounds from. Configure a positive value up to the
> protocol maximum of 262144, or unset the variable to get exactly that maximum.
> Refusing to start rather than serving a relay that accepts nothing.`

It names the variable, what the value would have done, that "off" is not a thing
this setting has, the ceiling, and the two ways out. The refusal is pinned twice:
that it happens, and that it carries both the variable name and the protocol
maximum.

**Deliberately still starting**, so that removing a footgun cannot become one:

- the variable **unset** — the `envDefault` gives exactly 262144;
- the variable **set to an empty string** (`ECHOLET_MAX_MESSAGE_BYTES=`, a real
  shape in `.env` files) — measured, not assumed: the decoder falls back to the
  `envDefault`, so `os.LookupEnv` reporting it as "set" does not matter. §3.3;
- any **positive** value up to the ceiling.

### 1.3 The consistency half (`NewMailboxHandler`)

The fallback moved from one of the two consumers to the one place that feeds both:

```go
if maxMsgBytes <= 0 {
    maxMsgBytes = defaultMaxMessageBytes
}
```

so `h.maxMessageBytes` is always positive, and `envelopeBodyLimit()` lost its own
copy of the branch — it now reads the field directly. The two sites T21-F-001
named as disagreeing (`mailbox_handler.go:97-103` and the
`validation.ValidateMailboxEnvelope` call) are now handed the same number by
construction, and the struct field carries a comment saying it is always positive
so a third reader cannot reintroduce the split.

`defaultMaxMessageBytes` is `protocol.MaxMessageBytes` (`request_body.go:31`), so
this introduces no new literal and no fourth statement of the number.

### 1.4 The six fixtures — and why nothing needed correcting

The dispatch asked for the six fixtures and a justification for correcting them.
**They did not need correcting: the chosen approach leaves them untouched.**
`apps/relay/internal/server/server_test.go` is byte-identical to HEAD,
`sha256:99f83d7ac5a5eb75337ebec44a88be56079ca5c7d9e7bce1edcaf203c8035b87`.

They are named here anyway, because the count was quoted from an earlier attempt
and this task measured it rather than repeating it. The refusal `c.MaxMessageBytes
<= 0` was applied to `Validate()` out of tree and `internal/server` was run
(`.metaproject/data/gdctx/raw/2026-09-08T17-21-33-544Z_run.log`). Exactly six
failed, all with `ECHOLET_MAX_MESSAGE_BYTES must not be negative, got 0` reaching
them through `server.New()`:

1. `TestNewAppliesTimeoutsToThePlainHTTPServer`
2. `TestNewRefusesAMissingCertificateFileRatherThanFallingBackToPlainHTTP`
3. `TestNewSetsAModernMinimumTLSVersion`
4. `TestServerServesHTTPSAndNotPlainHTTP`
5. `TestServerRefusesATLS11Client`
6. `TestPlainServerStillServesLoopbackHTTP`

(The other two `New()` callers in that file,
`TestNewRefusesACertificateWithoutAKey` and `TestNewRefusesAKeyWithoutACertificate`,
stay green under the mutation because they only require *an* error — which is
precisely why "six red" understates the damage: two more would have been passing
for the wrong reason.)

The mutation was reverted and `config.go` re-hashed to its pre-mutation value
`sha256:1d2655d4c207476fb12d5540d7cb8e1dba1436e2050bafe5309fd6b37a7b8da0`; the
package is green again.

**Two fixtures were corrected, both for T33** — see §2.2 for why that is not a
weakening.

---

## 2. T33 — the dead field

### 2.1 What was removed, and what was not

- **Removed:** `Config.CleanupIntervalSec` and its
  `env:"ECHOLET_CLEANUP_INTERVAL_SECONDS" envDefault:"60"` tag; and the call site
  that read it, `router.go:68`.
- **Kept, untouched:** `CleanupService`, its `Start()`, its `Stop()`, its
  `stop`/`stopped` channels, `Router.Stop()`, and
  `cmd/relay/main.go`'s `stopBackgroundWorkAndCloseStorage`. Confirmed by hash:
  `cleanup_service_stop_test.go`
  (`sha256:c2105ce47c51ec42cbd89659e4e004533bfd82f7c5996d9f20ae93391161f511`) and
  `cleanup_service_stop_join_test.go`
  (`sha256:5431caf1932d7b93def17fe3b100e0109e283964c61c3bfa5401eb0f17d725ee`) are
  byte-identical to HEAD, and both pass in all three tag/race combinations.
  `cmd/relay/main.go` was not opened for writing.

`NewCleanupService`'s **signature was deliberately not changed**, so both stop
tests keep compiling and keep choosing their own fast tick intervals. The router
now passes `service.DefaultCleanupIntervalSeconds` — a new constant in the service
package, value 60, the same number the `envDefault` carried, documented as
belonging to the service that owns the ticker rather than to a deployment. The
relay's startup line is still `Cleanup service started interval_sec=60`; what
changed is where the 60 comes from.

### 2.2 The two corrected fixtures, and why it is not a weakening

`signal_prekey_bundle_v2_test.go` and `signal_prekey_bundle_v2_mailbox_test.go`
each carried `CleanupIntervalSec: 3600` in a `config.Config` literal. With the
field gone they do not compile, so this was forced, not chosen.

It is not a weakening for two reasons, and the second is the interesting one:

1. **Neither test asserted anything about the value.** They assert Signal v2 route
   behaviour; the field was inert scenery in a struct literal. Removing a key from
   a literal removes no assertion.
2. **The line was a workaround for a hazard this task removed.** `NewRouter`
   passed that field straight into `time.NewTicker`, which panics on a
   non-positive duration — so `config.Config{}` took the router down at
   construction, and the `3600` existed only to step around it. That is now
   measured, not inferred (§0, and §3.2), and the hazard is pinned closed by a
   NEW test that constructs a router from a config with no cleanup period at all
   and then stops it twice. The fixtures got *smaller* while the coverage of the
   thing they were working around got *larger*.

---

## 3. Findings

### 3.1 T22-F-001 (info) — `Load()`'s check is the only environment-shaped rule in `internal/config`

`refuseAnExplicitlyDisabledMaxMessageBytes` reads `os.LookupEnv` directly, which
makes it the one rule in the package that is about the environment rather than
about a `Config` value, and the one that `Validate()` cannot express. That is
deliberate and documented at the function, but it means a future caller who builds
a `Config` by hand and calls `Validate()` — as `internal/server` does — does not
get this check. That is correct (a hand-built zero means "unconfigured"), and it
is exactly the distinction the task turns on, but it is a genuine asymmetry in the
package's shape and is recorded rather than hidden.

### 3.2 T22-F-002 (minor, closed here) — a zero-value `Config` panicked `NewRouter`

Not in either source report. `NewRouter(config.Config{...}, st)` with no
`CleanupIntervalSec` panicked with `non-positive interval for NewTicker`
(`cleanup_service.go:60`, from `router.go:69`) — the same family of defect as R-3
(a zero-value struct field consumed as if it were configured), in a second place.
Unreachable through `Load()`, whose `envDefault` was 60, so it only ever bit
tests; but it is the reason two test fixtures carried a magic `3600`. Closed by
this task as a side effect of removing the field, and pinned by
`TestNewRouterStartsACleanupTickerWithoutAConfiguredInterval`.

### 3.3 T22-F-003 (info) — one test was written after its measurement, on purpose

`TestLoadTreatsAnEmptyMaxMessageBytesAsUnset` was written *after* a throwaway
probe, not before, and the ordering is deliberate: the new refusal's safety on a
live host depends on how `caarlos0/env` decodes `VAR=` with an `envDefault`
present, which is a property of a third-party library and not of this repository.
Asserting it first would have been guessing. The probe measured 262144 with no
error; the probe file was then deleted (`internal/config/zz_empty_probe_test.go`,
removed — `git status` shows no such path) and the behaviour pinned as a real test
with the reason in its doc comment. Recorded here so the tests-first claim in §0
is not overstated.

### 3.4 R-3's disposition

Residual R-3 (T11 §5) and finding T21-F-001 are **closed**. R-5 (documentation
drift on `MAX_MESSAGE_BYTES` prose) is untouched and still open. R-2 and R-4 are
untouched.

---

## 4. Deployed relays

**No deployed relay's startup behaviour changes.** Neither `geekom` nor `depr` was
contacted, inspected or restarted; nothing here reaches them until someone
restarts them, and this states what would happen then.

- **`ECHOLET_MAX_MESSAGE_BYTES`.** The only new refusal is an explicitly-set
  non-positive value. Both hosts are recorded as setting it to exactly the
  protocol maximum (262144), which is permitted and unchanged. Unset, empty, and
  every positive value up to 262144 start exactly as before — the empty case
  measured (§1.2), not assumed, precisely because these hosts are live.
- **`ECHOLET_CLEANUP_INTERVAL_SECONDS`.** Neither host is recorded as setting it,
  and it would not matter if one did: `env.Parse` ignores a variable no field
  claims, so a stale line in a `.env` is inert and cannot stop a restart. Pinned
  by `TestLoadIgnoresACleanupIntervalAnOperatorSetsAnyway`, which exists for this
  reason and no other.
- **Nothing on the wire changed.** No route, schema, status code, byte budget or
  numeric bound moved. At every configuration either host can be in, the relay
  accepts and returns exactly what it did at `1ed5b2a`.

The one behaviour a restart would surface differently is the deliberate one: a
host that *did* export `ECHOLET_MAX_MESSAGE_BYTES=0` would now fail to start with
the named error in §1.2, instead of coming up and refusing every envelope. That is
the trade this task exists to make, and it is loud rather than silent.

---

## 5. Test matrix

Go, all with `-count=1` (no cached replay):

| Run | Result |
|---|---|
| `go test -count=1 ./...` | **all packages ok**, 0 failures |
| `go test -count=1 -race ./...` | **all ok, 0 data races** (`DATA RACE` occurrences in the raw log: 0) |
| `go test -count=1 -race -tags relayv2 ./...` | **all ok, 0 data races** (`DATA RACE` occurrences in the raw log: 0) |
| `go vet ./...` and `go vet -tags relayv2 ./...` | clean |
| `gofmt -l` over every file this task touched | clean |
| `pnpm typecheck` | exit 0 |

`gofmt -l apps/relay` still lists three files —
`internal/api/handler/mailbox_read_mark_test.go`,
`internal/api/handler/signal_prekey_bundle_v2.go`,
`internal/storage/repository/signal_prekey_bundle_v2.go`. All three are unmodified
at HEAD and were already unformatted before this task; none was touched here.

`pnpm test` was not run: this task changed no TypeScript, and `apps/cli/**` is
being edited by a concurrent agent, so a result from that suite would not be
attributable. `pnpm typecheck` (which does read the whole workspace) is green.

---

## 6. Files

### Product (`§1`, `§2`)

| Path | SHA-256 | Change |
|---|---|---|
| `apps/relay/internal/config/config.go` | `1d2655d4c207476fb12d5540d7cb8e1dba1436e2050bafe5309fd6b37a7b8da0` | `CleanupIntervalSec` removed; `refuseAnExplicitlyDisabledMaxMessageBytes` added and called from `Load()`; variable name hoisted to one constant |
| `apps/relay/internal/api/handler/mailbox_handler.go` | `86ed8daf6cda190a05c79803ff6f42bbd13532774f78f3edb8f2944e8a4e4e8d` | `NewMailboxHandler` resolves a non-positive maximum once; `envelopeBodyLimit()`'s duplicate fallback removed |
| `apps/relay/internal/api/router/router.go` | `a10f6ab27a344d76bb1c4d3d307b714001976fbdd539118cb2771d928bbf167f` | passes `service.DefaultCleanupIntervalSeconds` instead of `cfg.CleanupIntervalSec` |
| `apps/relay/internal/service/cleanup_service.go` | `eabeb17d8f1771d23111e345ff1ae16cf0c6384b2402c5fbc3a552e91103dc22` | **added** `DefaultCleanupIntervalSeconds = 60`. Nothing else: the struct, `Start`, `Stop` and `runCleanup` are unchanged |

### Tests (`§0`)

| Path | SHA-256 | Change |
|---|---|---|
| `apps/relay/internal/api/handler/unconfigured_max_message_bytes_test.go` | `9978899f896853fa6b36c8f01ae1b811d223120a976cf9f187b732965dd55ec4` | **new**: the R-3 round trip at an unconfigured maximum, both directions |
| `apps/relay/internal/config/cleanup_interval_removed_test.go` | `2f0977be542070e01ca08cb6cba2aa1a9103568074be3b5cc92d3190da49e1d4` | **new**: the configuration surface offers no cleanup interval; a stale variable is inert |
| `apps/relay/internal/api/router/cleanup_ticker_test.go` | `c347c377704cf6e46bd7f6be139786a883ddc96a443255590620229354610015` | **new**: `NewRouter` starts a working ticker with no configured interval, and `Stop()` is idempotent |
| `apps/relay/internal/config/max_message_bytes_config_test.go` | `e34056200cf30597f9f562abbc791059e136805f9543ab5a2ab2c95d7114ac3d` | **added** three tests (explicit zero refused, a lower value still accepted, an empty value treated as unset); one existing case's comment corrected. No case removed or loosened |
| `apps/relay/internal/api/handler/mailbox_poll_byte_budget_derivation_test.go` | `40c082ae22a64284936a7051f9a5218ea75afe43411af15521e7cda93a72ea49` | **comment only** — the "WHY ZERO IS NOT IN THAT TABLE" block said the zero was an open residual. It now says why zero has its own file, and keeps T21's measurement as history. No assertion, case or helper changed |
| `apps/relay/internal/api/router/signal_prekey_bundle_v2_test.go` | `fd3c2ac2488bb35adc259dc24892c4dbf8189b003c75028d0861aaef0942f22b` | `CleanupIntervalSec: 3600` removed from a config literal (§2.2) |
| `apps/relay/internal/api/router/signal_prekey_bundle_v2_mailbox_test.go` | `b1c94a81749cf713818550fd07432e38f097f5b08e5f833b7f018052c25c51b8` | same (§2.2) |

### Deliberately unchanged, verified by hash

| Path | SHA-256 |
|---|---|
| `apps/relay/internal/server/server_test.go` (the six fixtures) | `99f83d7ac5a5eb75337ebec44a88be56079ca5c7d9e7bce1edcaf203c8035b87` |
| `apps/relay/internal/api/handler/mailbox_poll_capacity_test.go` (the `maxPollResponseBytes` mirror, and the frozen `TestSendEnvelopeBodyLimitIsDerivedFromMaxMessageBytes`) | `988c7c8dffbbba21b3d92149d3beefc078d73b488d2988000520367c5e67f285` |
| `apps/relay/internal/service/cleanup_service_stop_test.go` | `c2105ce47c51ec42cbd89659e4e004533bfd82f7c5996d9f20ae93391161f511` |
| `apps/relay/internal/service/cleanup_service_stop_join_test.go` | `5431caf1932d7b93def17fe3b100e0109e283964c61c3bfa5401eb0f17d725ee` |

No test anywhere is skipped, `t.Skip`-ed, narrowed or deleted. Identity is reported
by SHA-256 only; no mtime is used or quoted anywhere in this report.

### Documentation

Four documents asserted, in prose, the two facts this change falsifies — that the
`CleanupIntervalSec` field is still declared and would still be read, and (for
`ECHOLET_MAX_MESSAGE_BYTES`) nothing about an explicit zero. Corrected surgically,
sentence for sentence, in the language each document is written in:

- `docs/OPS-23_LOCAL_ENV_VARS.md` — a new bullet on the explicit zero (including
  that unset and empty still mean the protocol maximum), and the cleanup section's
  closing paragraph rewritten from "the field remains" to "the field is gone, the
  service and its `Stop()` stay".
- `docs/STATUS_CURRENT.md` limitation 10, `docs/requirements/echolet-cli-prototype/README.md`,
  `docs/requirements/echolet-cli-prototype/deployment-runbook.md` — the same
  correction, each keeping its own open item (the empty `runCleanup()` body) intact
  rather than claiming it away.

---

## 7. Safety

No store key, private key, plaintext, ciphertext or HTTP request body was printed,
logged, or written into any artifact. The new tests' failure messages carry byte
counts, status codes, error codes and envelope identifiers only; ciphertext is
inert padding from the pre-existing `envelopeWithCiphertextSize` helper and is
never echoed, and poll responses are measured by `Body.Len()` rather than read
out. The relays on `geekom` and `depr` were not contacted, inspected or restarted.

---

## 8. Routing audit

- `graph_used`: **no** — *not relevant*. Every file was named by the dispatch or by
  a `file:line` in the two source reports; the work was reading and changing those
  exact files. The one discovery question ("what else reads this field") was a
  symbol search, answered by `keryx ctx rg`.
- `wiki_used`: **no** — *not relevant*. The authority for R-3, T21-F-001 and the
  T28 removals is the flow package and the code, both read directly.
- `ctx_used`: **yes** — `keryx ctx rg` for every search over project code and
  documentation; `keryx ctx run` for every command (go build/vet/test, gofmt,
  pnpm typecheck, git, shasum, cp/rm); `keryx ctx read` for whole-file reads.
  Raw logs under `.metaproject/data/gdctx/raw/`.
- `raw_rg_used`: **no**. No bare `rg`/`grep` ran over project code. Two `sed -n`
  reads of exact line ranges in three documents were escaped with `# keryx:raw`
  and a stated reason (the prose had to be reproduced verbatim to author
  sentence-for-sentence edits, which a compacted view cannot give).
