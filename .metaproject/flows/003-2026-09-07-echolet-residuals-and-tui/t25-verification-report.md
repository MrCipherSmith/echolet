# T25 — Independent verification of flow 003

Flow 003, task T25. **Independent verifier.** I wrote none of the code under test and took no
report's prose as evidence for its own claim: every property below was re-established by reading
the source, by running the matrix myself, or by mutating a copy of the tree outside the repository
and watching what the suite did.

**Tree under test.** HEAD `c5fde09`. **Machine:** macOS 26.5.1, arm64, 10 cores; `node` **v26.5.0**
(`/opt/homebrew/bin/node`, the default non-login interpreter — measured, not assumed), `pnpm`
10.0.0, `go1.26.1 darwin/arm64`, ripgrep at `/opt/homebrew/bin/rg`.

**Overall status: DONE_WITH_CONCERNS — the wave must not close as it stands.**
The whole matrix is green with zero data races and no test was weakened. But four of the ten
acceptance criteria are not met (AC1, AC2, AC3, AC4), one is met only in part (AC10), and two
properties the wave presents as load-bearing are pinned by no test at all — one of them the exact
"trust confirmation for identifiers never on screen" hazard the dispatch named.

---

## 0. Repository integrity

A SHA-256 manifest of all **973** tracked files was taken before any work
(`sha256:7bfdb48d198f1d87a6578b24bd36d7f00af8a3e48411aaf68626529e34e61bb4` over the manifest) and
again at the end (`sha256:6835cae436f72e5fea5acdcde55fd8b384d38ae5013bdda5b5e1bca27f6a0d06`).
**971 of 973 files are byte-identical.** The two that differ are
`.metaproject/flows/003-…/flow.json` and `…/journal.md`, both written by the flow tracker (my own
task start, and the concurrent T18 task landing `t18-claim-authentication-design.md`). No file
under `apps/`, `packages/`, `docs/`, `deploy/` or any `*.test.ts` / `*_test.go` changed.

Every mutation in §4 was applied to a `git archive HEAD` export under
`/private/tmp/…/scratchpad/mut`, never to the repository. No mtime was used anywhere.

`geekom` and `depr` were not modified. `depr` was read once over HTTPS, read-only:
`GET https://depr.tail5a88fb.ts.net:8443/health` → **200**, `ssl_verify_result=0`,
`remote_ip=100.100.188.64`; certificate `CN=depr.tail5a88fb.ts.net`, issuer Let's Encrypt `YE2`,
`notBefore=Sep 7 18:35:38 2026 GMT`, `notAfter=Dec 6 18:35:37 2026 GMT`. No store key, private key,
plaintext, ciphertext or HTTP request body appears anywhere in this report.

---

## 1. The matrix, re-run in full

Every figure below was produced by me on `c5fde09`. The JS legs ran as one sequential background
job while I did nothing but read files, so they are **not** loaded-machine figures. The Go legs ran
sequentially and alone.

| Leg | Command | Exit | Result | Wall |
|---|---|---|---|---|
| Typecheck | `pnpm -r typecheck` | **0** | 7 workspace projects clean | — |
| JS suite | `pnpm -r test` | **0** | **61 files, 320 tests, 320 passed / 0 failed / 0 skipped** | 175.53 s |
| e2e script | `pnpm --filter @echolet/cli test:e2e` | **0** | **1 file, 3 tests, 3 passed** | 18.13 s |
| Go | `go test -count=1 ./...` | **0** | 11 packages `ok`, 6 with no test files | 22.25 s |
| Go race | `go test -count=1 -race ./...` | **0** | same, **0 data races** | 22.39 s |
| Go race + relayv2 | `go test -count=1 -race -tags relayv2 ./...` | **0** | same, **0 data races** | 21.96 s |
| Go test count | `go test -count=1 -v ./...` | **0** | `=== RUN` 171 · `--- PASS` 171 · `--- FAIL` 0 · `--- SKIP` 0 | — |

JS breakdown: `apps/cli` 47 files / 255 tests, `packages/protocol` 3/12, `crypto-core` 4/20,
`session-node` 3/24, `client-core` 2/2, `client-db` 1/1, `apps/mobile` 1/6.

`WARNING: DATA RACE` occurrences across the three Go logs: **0, 0, 0.** `^FAIL` lines: **0, 0, 0.**

**On the first pass every Go leg reported `(cached)`** — including `-race` and `-race -tags relayv2`,
because T11 had populated the cache. Anyone quoting a Go result for this tree without `-count=1` is
quoting a replay, not a run. Every figure above is from `-count=1`.

**CPU-contention hazard.** The process-spawning tests under `apps/cli/src/commands/` all passed in
the single unfiltered run (`cli.test.ts`, `cli.relayErrorCodes.test.ts`, `cli.senderQuota.test.ts`,
`cli.processFailures.test.ts`), so no isolated re-run was needed and **no figure in this report comes
from a loaded machine**.

---

## 2. Verdict on each acceptance criterion

| AC | Verdict |
|---|---|
| AC1 | **NOT MET** |
| AC2 | **NOT MET** |
| AC3 | **NOT MET** (served only in its second half) |
| AC4 | **NOT MET** (second half met, first half not) |
| AC5 | **MET** |
| AC6 | **MET** |
| AC7 | **MET** |
| AC8 | **MET**, with one measured edge (V-009) |
| AC9 | **MET** on the properties; one of them protected by no test (V-001) |
| AC10 | **PARTIAL** |

### AC1 — every inventory item dispositioned by evidence — **NOT MET**

The T1 inventory does carry a per-item table (62 items; FIX NOW 21 · FIX WITH CARE 15 · RECORD
PERMANENTLY 14 · STALE 12) with a verdict and named evidence for each row, and I spot-checked its
STALE bucket (RI-04, RI-11, RI-16, RI-18, RI-43, RI-44, RI-50, RI-51, RI-53, RI-58, RI-71) and found
its verdicts hold. But AC1 asks for a *disposition*, and there is no post-wave table saying, for
each of the 62, whether it was fixed, re-verified open with the reason it is not being fixed, or
deleted. Eight flow tasks remain `todo` (T15, T16, T17, T22, T23, T24, and T18 in progress), several
of them FIX NOW items — and `flow.json` still records **T20 as `todo`** although its work landed in
`e949aae` and its report is on disk. The flow is `in-progress`, which is the honest state; AC1 is
simply not yet reached. (V-008)

Two FIX NOW residuals I re-verified as still open, with no wave-level record of the reason:
`apps/relay/relay` is still an 18,094,306-byte untracked binary in the tree (now matched by
`.gitignore:94`), and `gofmt -l apps/relay` still lists
`internal/api/handler/mailbox_read_mark_test.go`, `internal/api/handler/signal_prekey_bundle_v2.go`
and `internal/storage/repository/signal_prekey_bundle_v2.go`. (V-012)

### AC2 — no document states something the tree contradicts — **NOT MET**

The three specific clauses AC2 names are clean: no document says the relay fails to stop cleanly, no
document states the ack-route count oracle as open (`keryx ctx rg -i oracle docs/` → 0 matches), no
document says AC4 is blocked, and no document quotes an e2e figure under a label that misdescribes
what ran.

But T7 reconciled the documents at `4346e2b`, and **six behaviour-changing commits landed after it**
without a second pass. Four unqualified assertions now contradict the tree (V-003):

1. `docs/STATUS_CURRENT.md`, "Открытые ограничения" §3 — «Бюджет байт на poll не связан с
   `ECHOLET_MAX_MESSAGE_BYTES`. При `maxMessageBytes` = 2 MiB relay вернул ответ на 2 097 781
   байт…». Contradicted by `5235a6d`: `pollEnvelopeByteBudget` is now cut from
   `clientPollResponseBound = 4 * protocol.MaxMessageBytes`, and a 2 MiB configuration is refused by
   `config.Validate()` at startup.
2. `docs/STATUS_CURRENT.md` §4 — «одна нерасшифрованная запись прерывает весь скан: измерено 0 из 2
   здоровых записей связано» and «единственный писатель `device_mailbox` без ограниченного повтора
   при конфликте». Both contradicted by `18afa36` (skip-and-count, plus
   `saveDeviceMailboxBindingWithRetry`).
3. `docs/STATUS_CURRENT.md` §10 and `docs/requirements/echolet-cli-prototype/README.md:37` — «таймер
   запускается в `Start()` без канала остановки и не входит в последовательность завершения» /
   "The service's ticker is also started with no stop channel and is not part of the shutdown
   sequence". Contradicted by `18afa36`. (The neighbouring "no test files in `internal/service`"
   clause *is* pinned to `4346e2b` and so remains honest; the ticker clause is not.)
4. `STATUS_CURRENT.md`, the requirements `README.md` and `deployment-runbook.md` §4/§14 all state
   that `depr`'s certificate-renewal timer **is not installed**. T14 installed it (root `systemd`
   timer, enabled and active). I did not re-verify the host — that needs shell access I was told not
   to use — so I report this as a documentary inconsistency, not as a host claim.

`STATUS_CURRENT.md` also still presents itself as the status of `4346e2b`, ten commits behind HEAD,
and records none of flow 003's fixes. Its `pnpm test` → 162 figure is explicitly attributed to
`c302485` and is therefore a dated measurement rather than a contradiction; the four items above are
not qualified that way.

### AC3 — `test:e2e` runs every e2e file, or the scripts are renamed — **NOT MET**

Measured: `apps/cli/package.json` still declares `"test:e2e": "vitest run test/e2e/two-process.test.ts"`.
It was neither repointed nor renamed. Running it: exit 0, **1 file, 3 tests**. The package holds
**six** files under `test/e2e/` carrying **29** tests, all of which I saw run and pass under the
plain `test` script: `two-process` 3, `flood-closure` 9, `init-relay-url` 9, `rewalk-crash-safety` 4,
`relay-tls` 3, `publication-claimability` 1. There is no root `test:e2e` script.

The **second** half of AC3 is met, and I checked it rather than assuming it: every place the figure
is quoted now names the script, the file and the count — `docs/STATUS_CURRENT.md` (matrix row, T55
bullet, flow-002 matrix sentence, and a dedicated section «Что именно измеряет `test:e2e`»),
`docs/requirements/echolet-cli-prototype/README.md:10`, `metrics-and-validation.md:17,25,28` and
`specification.md:21`. No document quotes a bare **3/3** as an end-to-end total. T7 says so itself
(§6.1) and is right. But AC3's first clause is a requirement, not an option to decline: the script
is still misnamed. (V-004)

### AC4 — configuration that binds nothing is made to bind or removed — **NOT MET**

*Second half — met.* The relay's background timer is stoppable and covered: `CleanupService` gained
`stop`/`stopped` channels under a mutex, `Stop()` is wired into
`cmd/relay/main.go:stopBackgroundWorkAndCloseStorage` on all four store-closing paths, and I killed
two mutations against it (§4, G5 and G4). `TestCleanupServiceStopEndsItsTickerGoroutine` and
`TestRelayStopsTheCleanupServiceBeforeClosingStorage` were both red on `7af8492` and are green now.

*First half — not met.* AC4 says the cleanup interval "must not be presented to an operator in
compose files and env examples while the service it names does nothing". `runCleanup()` is still two
`slog.Debug` calls (`internal/service/cleanup_service.go:106-111`), and
`ECHOLET_CLEANUP_INTERVAL_SECONDS` is still presented in **all six** operator-facing places:
`deploy/relay/docker-compose.yml:64`, `deploy/relay/docker-compose.insecure-loopback.yml:85`,
`deploy/relay/run-relay.sh:194`, `deploy/relay/env/depr.env.example:61`,
`env/geekom.env.example:64`, `env/insecure-loopback.env.example:102`. It was documented as binding
nothing, which is honest but is not what AC4 asks for. (V-002)

### AC5 — one bad record does not deny service; one config value cannot silently break a mailbox — **MET**

Both halves demonstrated by tests that fail before the fix, and I re-established both directions
myself. Red-before, replayed at `7af8492`: `TestBackfillSkipsUndecodableRecordAndBindsTheHealthyOnes`,
`TestBackfillReportsTheNumberOfSkippedRecords` and
`TestPreBindingIdentityStillAuthorizesWhenAnotherDeviceRecordIsUndecodable` all FAIL. Mutation on
HEAD (restore `return err` on `json.Unmarshal` failure): the same three go red.

For the configuration half, mutation G2 (delete the `> protocol.MaxMessageBytes` refusal in
`config.Validate`) turns `TestValidateRefusesAMaxMessageBytesTheRelayCannotDeliver` (both subtests)
and `TestLoadRefusesAMaxMessageBytesAboveTheProtocolMaximum` red. Residual, carried and not closed:
`ECHOLET_MAX_MESSAGE_BYTES=0` set explicitly still validates and makes the relay refuse every
envelope — but with a typed `PAYLOAD_TOO_LARGE`, so it is loud, not silent, and AC5's word is
"silently". T22 remains `todo`.

### AC6 — one command at a time, and the reported exit class is the real one — **MET**

Red-before, replayed at `cc854ec`: all four `tui-shell.singleFlight` tests and all three
`main.processDriven` tests FAIL. On HEAD both gates are load-bearing: removing the `mapKey` gate
turns the input-model test red; removing the reducer's `if (state.busy) return` turns the effect
test red (§4, M-D/M-E). The process-level half is genuinely process-level —
`main.processDriven.test.ts` bundles `src/tui/main.ts` with esbuild and drives real children — so
"demonstrated against a real driven process" holds. The exit-class claim is structural rather than
mapped: `applyOutcome`/`note` already reported `outcome.code` and `outcome.exitCode` verbatim, and
what changed is that no second child now meets the store as a concurrent writer.

### AC7 — nothing hidden in silence, and the right rows kept — **MET**

Red-before at `cc854ec`: three `shell-chrome.overflow` and three `shell-chrome.recency` tests FAIL.
On HEAD, mutation M-F (make `fitPane` take a silent prefix, the pre-fix behaviour) turns **all six**
red; mutation M-G (keep the head instead of the tail) turns the three recency tests red. The marker
counts list rows, and I checked the arithmetic cannot drop the marker itself: the assembled array is
`headRoom + shown + 1 + tailRoom ≤ cap` by construction, so the final `.slice(0, cap)` never trims
it. The carried residual — a pane whose *fixed* lines alone overflow still loses some without a
count — is pre-existing and correctly recorded by T6.

### AC8 — every advertised key visible at the minimum viewport, a key list, no over-wide line — **MET**

Red-before at `cc854ec`: all three `shell-chrome.legend` tests and `tui-shell.smallViewport` FAIL.
On HEAD, removing the `?` binding turns "binds a help key" red; restoring the `Math.max(MIN_VIEWPORT…)`
clamp in `viewport()` turns `tui-shell.smallViewport` red. I probed `renderFrame` directly at
1×1, 2×2, 10×3, 20×6, 40×10, 71×15, 72×16, 72×17, 73×16, 80×20, 200×60 and 500×200, with and
without a modal: **at every one it returned exactly `rows` lines of exactly `cols` code points and
contained no ESC byte.** One measured edge: the unaudited-prototype notice is present in full from
about 20×6 upward but not at 10×3, 2×2 or 1×1, because `tooSmallFrame` wraps it and the frame is
then sliced to `rows`. No test covers a viewport smaller than 40×10. (V-009)

### AC9 — flow 002's properties re-verified unchanged — **MET on the properties**

- `renderFrame` pure, total, deterministic, escape-free, exactly rows × cols: verified by my own
  probe across twelve viewports including 1×1 (above), and by `shell-chrome.test.ts` 12/12.
- No key material in any frame or child argv: `tui.keyMaterial.test.ts` 9/9 green.
- The notice on every frame: green, with the small-viewport edge above.
- **The trust modal cannot confirm what was never painted: the property holds.** `reduce`'s
  `trust-confirm` arm refuses on `modal.renderedAt === null` (`tui-shell.ts:166`), and `paint()`
  records `renderedAt` only when the painted viewport is not below `MIN_VIEWPORT`
  (`tui-shell.ts:343`). I confirmed by probe that below 72×16 the degraded frame carries **none** of
  the four identifiers, and that at 72×16 and every larger viewport tested **all four are painted in
  full** (`MODAL_PANEL_MIN_WIDTH` 56 → inner 52 columns, and `modalBodyRows(height ≥ 14) ≥ 10`, which
  is exactly the ten body lines the four identifiers need — so there is no viewport at which the
  panel is drawn with an identifier clipped or dropped).
- The full matrix is green with zero data races: §1.

**But the shell-side half of that gate is protected by nothing.** See V-001: deleting
`&& !isBelowMinViewport(painted)` from `paint()` leaves all 15 TUI files / 108 tests green. No test
in the repository ever opens a trust modal through `runTuiShell`.

### AC10 — nothing weakened, and every fix lands after a red test, provable from git — **PARTIAL**

*Nothing weakened, skipped, narrowed or deleted.* I checked this directly rather than by report.
`git diff --numstat 4346e2b..c5fde09` over `*_test.go` and `*.test.ts` shows 30 files touched; every
deletion is accounted for. In `5b51309` the only removed lines are comments and a `try/finally`
refactor — I read all of them — and the request-path assertions were **strengthened**
(`["/v2/prekeys/claim","/v1/messages/send"]` → `["/v2/prekeys/publish","/v2/prekeys/claim","/v1/messages/send"]`),
with the "names an exhausted prekey" assertion moved rather than dropped. No `.skip`, no `.only`, no
assertion removed anywhere. The one authorised re-authoring is genuinely **not weaker** — see §3.

*Ordering.* Three of the four pairs are clean and provable, and I proved them by replaying the
parent trees rather than reading the claim:

| Pair | Red-before, measured by me |
|---|---|
| `7af8492` → `18afa36` (relay) | at `7af8492`: 6 named tests FAIL across `service`, `repository`, `handler`, `server` |
| `cc854ec` → `d26bd58` (TUI) | at `cc854ec`: **7 files, 18 tests FAIL** of 108 — exactly T6's list |
| `5b51309` → `e949aae` (claim/publication) | at `5b51309`: 7 tests FAIL — `outbound.claimResidual` ×3, `outbound.publicationPrecondition` ×4 — plus `profile.test.ts` failing to collect, since it referenced `hasPublication()` before it existed |
| `d6d5f8f` → `5235a6d` (size, client half) | at `d6d5f8f`: `sizeSymmetry` and `responseBoundDerivation` FAIL |

None of those three fix commits touches a test file at all — that is real discipline.

**Where it is not provable, plainly:** commit `5235a6d` ("fix: one protocol constant governs message
size on both sides of the wire") contains product code **and** two test-file changes:
`mailbox_poll_byte_budget_derivation_test.go` (+219 / −115, the authorised re-authoring) and a
brand-new `internal/config/max_message_bytes_config_test.go` (+153). Neither ever existed in a red
state in git history. Neither *could* be made red on the parent tree either, because both import
`echolet/apps/relay/internal/protocol`, a package the same commit introduces — so for these two the
red-first ordering is not merely unproven, it is unprovable from history as committed. The new
config test is not covered by the re-authoring authorisation. (V-005)

---

## 3. The two leads the dispatch named

### 3.1 The size closure's re-authored test — nothing was lost, and it pins a relationship

The retired name is `TestMaximumSizeEnvelopeIsDeliverableAtRaisedMaxMessageBytes` (added `7af8492`,
re-authored `5235a6d`). I diffed the two versions myself.

*Nothing was lost.* The old test drove one round trip at a raised 2 MiB and allowed **either**
coherent answer: (a) the poll response stays within the client's bound, or (b) the send is refused
with a bounded typed 4xx and nothing is stored. Under the closure taken, a 2 MiB configuration
cannot start at all, so answer (b) at that size describes a configuration that no longer exists. The
replacement asserts the same property — an envelope the relay accepts must be one it hands back
inside what the recipient will read — over **every** configuration that can now exist
(`protocol.MaxMessageBytes`, ÷2, ÷16), and with **no refusal branch**: a permitted deployment must
accept. That is strictly stronger for the reachable configuration space. The old test's refusal-path
assertions (typed 4xx, nothing half-stored) are not orphaned: `internal/validation`'s
`mailbox_envelope_size_test.go` still pins `PAYLOAD_TOO_LARGE`.

*It pins a relationship, not today's numbers — verified by my own mutation, not by the report.*
Every size in the new file is expressed relative to `protocol.MaxMessageBytes`, each configured
maximum is first put through the real `config.Validate()`, and the round trip runs through the real
`SendEnvelope` and `PollMailbox` handlers over real Badger.

- **G1** — raise `clientPollResponseBound` from `4 *` to `8 * protocol.MaxMessageBytes`:
  `TestPollResponseBoundsAreDerivedFromTheProtocolMaximum` FAILS with the exact diagnosis
  ("clientPollResponseBound = 2097152, above the 1048576 a conforming client accepts").
- **G3** — change `protocol.MaxMessageBytes` from 262144 to 524288: three tests go red across two
  packages (`TestPollResponseBoundsAreDerivedFromTheProtocolMaximum`,
  `TestMailboxPollHonoursAggregateResponseByteBudget`, `TestLoadDefaultsToTheProtocolMaximum`).
  The file re-scales rather than silently un-pinning, as it claims.
- **G2** — delete the startup refusal: three config assertions go red.

The mirror constant `maxPollResponseBytes` was **not** edited — the false green T10 predicted did
not happen — and `TestPollResponseBoundsAreDerivedFromTheProtocolMaximum` is what now keeps it a
derivation in effect.

**The one thing that is not pinned, and it matters (V-006).** The mirror is enforced in only one
direction. `clientPollResponseBoundFor` in the Go test is a *hand-written restatement* of the
TypeScript rule, and nothing ties the Go constant to `LIMITS.MAX_MESSAGE_BYTES`. Measured: lowering
`packages/protocol/src/constants/limits.ts` to `MAX_MESSAGE_BYTES: 131072` leaves **21 files / 83
tests green** in `apps/cli` — while the relay still accepts 262144-byte ciphertexts and may still
produce poll responses up to 1 MiB, which such a client would now refuse in full at 524288. That is
RI-09's original failure mode — accepted, stored, never acknowledged — reintroduced by a one-line
edit to the very constant the closure is built on, with nothing red anywhere. (Raising it to 524288
is likewise green; that direction is merely wasteful rather than dangerous. The `limits.go` comment
says "the two must be changed together"; nothing enforces it.)

### 3.2 The console's clamp and the modal's painted-at record

*The clamp.* `viewport()` no longer clamps up; `renderFrame` handles the whole range. Both halves are
pinned: restoring the clamp turns `tui-shell.smallViewport` red, and the same test asserts a 96×28
terminal is still painted at 96×28 so "always paint the minimum" cannot pass for a fix. Verified.

*The painted-at record — the property holds, the guard does not.* As set out under AC9, a trust
confirmation genuinely cannot be answered for identifiers that were never on screen, at every
viewport including very small ones: below 72×16 the degraded frame carries no identifiers and
`paint()` refuses to stamp `renderedAt`; at 72×16 and above all four identifiers are painted in
full. I confirmed this by probing `renderFrame` directly rather than by reading the code's comments.

But **the shell-side condition is dead weight as far as the suite is concerned**. Mutation M-A′:
delete `&& !isBelowMinViewport(painted)` from `tui-shell.ts:343` — **15 files, 108 tests, all
green.** The reason is structural: `keryx ctx rg` over `apps/cli/src` finds `onTrustIdentifiers`
referenced only in `tui-shell.ts` and `main.ts`, in **no test**; and no state handed to
`runTuiShell` in any test carries a modal. So the `renderedAt` stamp, and the whole
`answer-trust-prompt` effect path, are exercised at no viewport by anything. Only the *reducer's*
half is covered (`tui-shell.test.ts:124`). T6 §1 D-4 calls this change "the security half of D-4 and
a strengthening"; it shipped with no test, and a future edit that reinstated the defect would be
silent. (V-001)

---

## 4. Every mutation I ran (all outside the tree; all reverted; digests re-verified)

Applied to a `git archive HEAD` export. Controls first: `src/tui` 15 files / 108 tests green,
`src/transport` 8 / 28 green, `go test -count=1 ./internal/api/handler/ ./internal/config/` ok.

| # | Mutation | Result |
|---|---|---|
| M-A′ | `paint()`: drop `&& !isBelowMinViewport(painted)` | **SURVIVES** — 108/108 green (V-001) |
| M-A | `viewport()`: restore the `MIN_VIEWPORT` clamp | killed — `tui-shell.smallViewport` |
| M-B | `sendEnvelope`: delete the local size bound | killed — `relayClient.sizeSymmetry` |
| M-C | response bound back to the literal `1024 * 1024` | killed — `relayClient.responseBoundDerivation` |
| M-D | `reduce`: delete `if (state.busy) return` | killed — `singleFlight` (effect test) |
| M-E | `mapKey`: delete the busy gate | killed — `singleFlight` (input-model test) |
| M-F | `fitPane`: silent prefix (pre-fix behaviour) | killed — 6 tests (`overflow` ×3, `recency` ×3) |
| M-G | `fitPane`: keep the head instead of the tail | killed — `recency` ×3 |
| M-H | `sendOwned`: delete the publication guard | killed — 5 tests (`publicationPrecondition` ×4, `claimResidual` ×1) |
| M-I | delete the `?` help binding | killed — `legend` ("binds a help key") |
| M-J | `LIMITS.MAX_MESSAGE_BYTES` → 524288 | **SURVIVES** — 8/28 green (V-006) |
| M-J2 | `LIMITS.MAX_MESSAGE_BYTES` → 131072 | **SURVIVES** — 21 files / 83 tests green (V-006) |
| G1 | `clientPollResponseBound` → `8 *` | killed — `TestPollResponseBoundsAreDerivedFromTheProtocolMaximum` |
| G2 | delete `config.Validate`'s protocol-max refusal | killed — 3 config assertions |
| G3 | `protocol.MaxMessageBytes` → 524288 | killed — 3 tests, 2 packages |
| G4 | backfill: `return err` on an undecodable record | killed — 3 tests, 2 packages |
| G5 | shutdown no longer calls `r.Stop()` | killed — `TestRelayStopsTheCleanupServiceBeforeClosingStorage` |
| G6 | neutralise `ValidatePreKeyBundle`'s identifier bound | killed — `bundle_id` and `device_id` subtests; **`identity_id` still passes** (V-011) |
| G7 | `CleanupService.Stop`: signal without joining | **SURVIVES** — `internal/service` and `internal/server` green under `-race` (V-007) |

---

## 5. Findings

| id | severity | one-line reproduction |
|---|---|---|
| **V-001** | major | Delete `&& !isBelowMinViewport(painted)` from `apps/cli/src/tui/tui-shell.ts:343`, run `npx vitest run src/tui` in `apps/cli` — 15 files / 108 tests still green. |
| **V-002** | major | `keryx ctx rg ECHOLET_CLEANUP_INTERVAL_SECONDS .` — six operator-facing files still set it while `internal/service/cleanup_service.go:106-111` does nothing. |
| **V-003** | major | Read `docs/STATUS_CURRENT.md` limitations 3, 4 and 10, and `docs/requirements/echolet-cli-prototype/README.md:37`, against `5235a6d` and `18afa36`. |
| **V-004** | major | `pnpm --filter @echolet/cli test:e2e` → 1 file / 3 tests, while `git ls-files apps/cli/test/e2e` lists 6 files holding 29 tests. |
| **V-005** | major | `git show --numstat --format= 5235a6d -- "*_test.go"` — two test files changed in the same commit as the product fix; both import a package that commit creates. |
| **V-006** | major | Set `MAX_MESSAGE_BYTES: 131072` in `packages/protocol/src/constants/limits.ts`, run `npx vitest run src/transport src/runtime` — 21 files / 83 tests green, Go mirror untouched. |
| **V-007** | minor | Replace `<-stopped` with `_ = stopped` in `CleanupService.Stop`, run `go test -count=1 -race ./internal/service/ ./internal/server/` — both `ok`. |
| **V-008** | minor | `flow.json` has 8 tasks still `todo` (T20 among them, though `e949aae` landed it) and no post-wave disposition table for the 62 inventory items. |
| **V-009** | minor | `renderFrame(state, {cols:10, rows:3})` — `UNAUDITED_NOTICE` is present only as its first 30 code points; smallest tested viewport is 40×10. |
| **V-010** | info | `clientPollResponseBoundFor` in `mailbox_poll_byte_budget_derivation_test.go` hard-codes factor 4 / 64 KiB; the TS tests constrain the real factor only to roughly (3, 5). |
| **V-011** | info | Neutralise the identifier bound in `ValidatePreKeyBundle` — the `identity_id` subtest still passes, because an over-long value fails signature verification instead. |
| **V-012** | info | `ls -la apps/relay/relay` (18,094,306 bytes, untracked, ignored at `.gitignore:94`); `gofmt -l apps/relay` still lists three files. |
| **V-013** | info | T23 diagnosed the push gate correctly and fixed it inside untracked `.git/hooks`; T23 and T24 are still `todo`, so the fix does not survive `keryx init`/`update` and no Go change can select a test. |

**On the push gate (T23), which I checked rather than accepted.** Its central claim is right and
important: the gate was reporting a *selection* failure as a *test* failure with `runner: n/a`,
`command: n/a` and no test executed, and on a clean tree `--changed` selected nothing and passed
vacuously. The fix (project scope) is strictly stronger than either behaviour it replaces. It lives
in `.git/hooks`, which is untracked and outside my write scope, so I verified it only by reading the
diagnosis against the recorded keryx artifacts, not by pushing.

---

## 6. What I did not verify, and why

- **Host state on `geekom` and `depr`.** I made one read-only HTTPS request to `depr` (§0). I did
  not SSH to either host, so T14's `systemd` timer and `geekom`'s `CertDomains` are unverified here.
  The documentary inconsistency in V-003(4) stands regardless of which way the host resolves.
- **The push-gate fix as installed**, for the reason above.
- **Mobile signature observability** and the other RECORD PERMANENTLY items: out of this flow's AC set.

---

## 7. Routing audit

- `graph_used`: **no** — *not relevant*. Every target was named by an acceptance criterion, a report
  `file:line`, or a commit; the work was reading and running those exact files, not discovering them.
- `wiki_used`: **no** — *not relevant*. This is a verification pass against frozen criteria and the
  tree; the authoritative sources are the criteria, the commits and the code, all read directly.
- `ctx_used`: **yes** — `keryx ctx rg` for every project-code search, `keryx ctx run` for git and
  command output, `keryx ctx read` for large files. Raw logs under `.metaproject/data/gdctx/`.
- `raw_rg_used`: **yes**, with reasons recorded inline via `# keryx:raw` at each use, and **never as
  a search over project code**: exact `go test` failure lines, exact vitest summary lines, exact
  per-commit `--numstat` output, `shasum` manifests, and `grep` over my own logs under
  `/private/tmp/.../scratchpad`. Every such invocation needed verbatim output that a compacted
  summary elides, because the counts and failure names *are* the evidence in this report.
