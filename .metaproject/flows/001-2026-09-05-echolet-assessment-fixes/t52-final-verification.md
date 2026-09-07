# T52 — Final independent verification (split T52a: T49-F-001 binary probe + full matrix)

Flow: `001-2026-09-05-echolet-assessment-fixes`
Dispatch: `001-T52a-verify`
Worker: `code-verifier` (independent; wrote none of this code)
Date: 2026-09-07

Revision: working tree at `/Users/Goodea/goodea/projects/echolet` (unborn `main`,
`git rev-parse HEAD` → `fatal: ambiguous argument 'HEAD'`; the working tree is the revision
identifier). `git status --porcelain` reports 23 untracked entries, unchanged from the T48/T49
snapshot; no tracked file was modified by this verification.

Environment: macOS (Darwin) arm64, 10 cores. **Node v26.5.0 at `/opt/homebrew/bin/node`** (default
`node` on PATH; the T45-I-003 hazard — Node v22.12.0 lacking `node:sqlite` — did not apply). pnpm
10.0.0; Go go1.26.1 darwin/arm64; keryx 0.2.80.

Integrity verified by **SHA-256** (mtime is unsound in this tree), reported in Part 2.

---

## PART 1 — T49-F-001: does sender authentication actually close the wedge?

### Verdict, stated plainly

**No. The wedge is not closed. It survives T51 at exactly the thresholds T49 measured.**
Sender authentication does everything T51 claims for the four *unauthenticated* cases, but
**device-record publication is itself unauthenticated**: an attacker generates a fresh ed25519
identity, self-signs a `DeviceRecord`, publishes it (one `POST /v1/device-records/publish`, **HTTP
200**), and then signs perfectly-valid poison envelopes with that device key. T51 raised the price
of the flood from *"know the victim's mailbox id"* to *"create an identity, publish it (one
request), know the victim's mailbox id"* — which is very nearly free — and the wedge persists at a
similar cost. The orchestrator's most-likely hypothesis is **confirmed by execution against the real
relay binary**.

Severity: **major (HIGH availability defect)**. This is a finding, not a gate check — recorded as
**T52-F-001**. It does not flip the Part 2 matrix verdict (all required gate checks pass), exactly as
T49-F-001 did not.

### Method

A self-contained probe outside the repository
(`<scratchpad>/probe/t52-probe.test.ts`, esbuild-bundled to CJS and run directly under Node 26 —
vitest's transform layer was avoided after it repeatedly stalled) did the following against the
**real relay binary built from this tree** (`go -C apps/relay build ./cmd/relay`) at **default
configuration**:

- Only `ECHOLET_HTTP_ADDR`, `ECHOLET_DATA_DIR` and `ECHOLET_RATE_LIMIT_PER_MINUTE` were set. The
  rate limit was raised (to 100000/min) so it would not confound the *count-of-envelopes*
  measurement — the **same single deviation T49 declared**. Every threshold-determining value
  (`ECHOLET_MAX_MESSAGE_BYTES` 262144, `ECHOLET_MAX_MAILBOX_BATCH` 100, the ~1 MiB poll byte budget,
  the client `poll_batch_size` 50, the 16-page client bound) was left at default. The default
  120/min rate limit is reported below as part of the attacker cost.
- Two legitimate parties (Alice, Bob) were driven through the **real `apps/cli/dist/cli.js`**
  (`init` → `contact export/import` → `relay publish` → `send`/`poll`/`history`), so publication,
  the mailbox id, and the legitimate two-party flow are all the production paths.
- The attacker was modelled the way the hypothesis describes: a fresh identity keypair generated
  in-probe with the real `@echolet/crypto-core` primitives, a `DeviceRecord` built exactly as the
  relay's own `testSenderDeviceRecord` builds it and signed with the real `signCanonicalJson`, and
  poison-envelope signatures produced with the real `signMailboxEnvelopeMessage` over the pinned
  `echolet-mailbox-envelope:v1:…` transcript.
- Only labels, counts, HTTP status codes, typed error codes and CLI exit codes were printed or
  persisted. A leak guard scanned the relay log for the message markers and both store keys and
  found none (`leak_guard: clean`). No plaintext, ciphertext, store key or key material was written.

### Obligation 1 — is an unauthenticated envelope refused *before storage*? Each case, separately

All four unauthenticated categories are refused with a bounded 4xx and, per the handler ordering
(`authenticateSender` runs before `StoreEnvelope`), nothing is written. Confirmed against the real
binary:

| Case | Observed |
|---|---|
| **unsigned** — `sender_signature` absent | `400 INVALID_SCHEMA` |
| **wrong-key** — signed by a key that is not the published `device_pubkey` | `403 INVALID_SIGNATURE` |
| **tampered** — valid signature, then ciphertext mutated so the digest no longer matches | `403 INVALID_SIGNATURE` |
| **unpublished sender** — self-consistent signature, sender identity never published | `403 UNAUTHORIZED_MAILBOX_ACCESS` |
| control — authenticated, published attacker | **`200`** |

Storage evidence: immediately afterwards Bob's real `poll` delivered the one legitimate message and
his history length was exactly 1 — the four refused sends left nothing acceptable behind that could
have been consulted. **T51's refusal behaviour is real and correct.**

### Obligation 2 — can an attacker who publishes *their own* identity then place envelopes? Cost?

**Yes.** `POST /v1/device-records/publish` with a fresh, self-signed root record returns **HTTP
200** with no credential of any kind (`attacker_selfpublish: {status:200}`, observed three times).
The immediately-following authenticated envelope was accepted (`authenticated_control:
{status:200}`) and occupied the victim's mailbox. The relay's own `authenticateSender` resolves the
sender through `DeriveMailboxID(sender_identity_id)` against exactly the record the attacker just
published, so a self-generated identity is indistinguishable from any other.

**Attacker cost, without softening:**

- **One** `POST /v1/device-records/publish` — a fresh ed25519 identity, a few hundred bytes,
  self-signed. **One-time and reusable across every victim.**
- Then the flood, per victim: **49** authenticated `POST /v1/messages/send` (~**12.8 MB**) in the
  byte-bounded regime, or **800** minimum-size envelopes (~0.7 MB) in the count-bounded regime.
- Precondition unchanged from T49 apart from that one publish: the victim's `recipient_mailbox_id`,
  a SHA-256 digest of the identity id printed in the victim's own contact card.
- Under the **default 120/min** rate limit, 1 + 49 = 50 requests is **under 30 seconds**; the
  800-envelope variant is under 7 minutes.
- The relay's retention cap is **168 h**, so one flood wedges the mailbox for up to **7 days**;
  refreshing it costs the same per week per victim.

### Obligation 3 — does the original wedge still occur, and at what threshold? (T49's method)

**Yes, at the identical thresholds, and permanently.** Measured on the real binary at default
configuration, using T49's method — a legitimate message queued behind head-of-mailbox poison whose
`envelope_id`s (`00000000-0000-1000-8000-…`) sort ahead of every CLI-issued v4 UUID, then the
victim's own real `poll` observed:

| Regime | Page size (measured) | Threshold | Attacker cost |
|---|---:|---|---|
| Minimum-size poison, count-bounded | 50 (client `poll_batch_size`) | **799 delivers, 800 wedges** | 1 publish + 800 POSTs, ~0.7 MB |
| **Maximum-size poison, byte-bounded** | 3 (262 144-byte ciphertext) | **48 delivers, 49 wedges** | 1 publish + **49 POSTs, ~12.8 MB** |

Observed records (verbatim from the probe's persisted results):

```
max_regime_48  { flooded: 48,        poll_exit: 0, history: 1 }                 # legit still delivered
max_regime_49  { flooded_plus: 1,    poll_exit: 3, history: 1,                  # 49 poison → wedged
                 retry1: 3, retry2: 3, history_final: 1 }                       # permanent across retries
small_regime_799 { flooded: 799,     poll_exit: 0, history: 1 }                 # legit still delivered
small_regime_800 { flooded_plus: 1,  poll_exit: 3, history: 1 }                 # 800 poison → wedged
```

At 49 (and at 800) the victim's `poll` exits **3 (`INBOUND_REJECTED`)**, the legitimate message is
never received, the poison is deliberately never acknowledged (F-012), and three further polls
reproduce the identical failure — the mailbox is wedged for the retention window. These are the
**same 49 / 800 thresholds T49 recorded**; sender authentication changed the price by one
near-free publish, not the capability.

Note the poison here is *authenticated* — it carries a valid `sender_signature` over the attacker's
own published device key — so it is admitted by the relay (`200`) and then permanently rejected by
the recipient's `acceptOne` (`recipient_*` mismatch / `CONTACT_NOT_TRUSTED`,
`apps/cli/src/runtime/inbound.ts:158-165`), which is exactly the permanently-unacceptable poison the
16-page walk cannot drain.

### Obligation 4 — does the legitimate two-party flow still work end to end?

**Yes.** `legit_flow: { bob_poll_exit: 0, bob_history_len: 1 }` — Alice sent through the real CLI,
Bob polled and received exactly the one message, with an accepted attacker control envelope also
sitting unacked in the mailbox (proving one poison does not wedge). The three-iteration real E2E in
Part 2 corroborates the full offline / restart / exact-retry / ack-recovery cycle.

### Why T51's own suite did not catch this

T51's acceptance criterion *"an attacker with no published root-signed device record can place no
envelope at all"* is met and its test `TestUnauthenticatedFloodCannotReachAMailbox` passes — but it
only exercises the **unauthenticated** attacker. No test exercises an attacker who **self-publishes**
a device record first, which the shipped relay accepts for free. That is the gap this probe closes.

### The precise boundary (the previous verifier's unfinished thought, resolved)

The wedge is reachable **if and only if** the attacker first performs one unauthenticated
`POST /v1/device-records/publish` (HTTP 200, self-signed, fresh identity). Given that one request,
every subsequent poison envelope is signed and accepted, and the 49 / 800 thresholds hold unchanged.
Without that publish, the flood is refused at ingress (`403 UNAUTHORIZED_MAILBOX_ACCESS`). Sender
authentication therefore relocated the wedge behind a lock whose key the attacker mints themselves.

### T52-F-001 (major) — the flood survives sender authentication via self-service publication

`/v1/device-records/publish` (and the device record embedded in `/v2/prekeys/publish`) authenticates
a record only against its **own** freshly generated identity key — by design, since both halves of
the storage key are caller-chosen (`validation/validate.go:23-29`). An attacker publishes their own
root-signed `DeviceRecord` for the cost of one request and thereafter signs poison the relay admits.
The T49-F-001 mailbox wedge is therefore **bounded but not eliminated**: at default configuration it
costs one self-publish plus 49 max-size (~12.8 MB) or 800 min-size envelopes per victim, permanent
for up to 168 h. Closing it needs a control the relay does not have — e.g. binding send-rate or
mailbox occupancy to something the attacker cannot self-mint, or making a recipient able to drain
permanently-unacceptable envelopes without the 16-page cap. **No source, test or configuration file
was modified; this is the finding.**

---

## PART 2 — the full matrix

All checks run on Node v26.5.0 / Go 1.26.1 / pnpm 10.0.0 / keryx 0.2.80, working tree as above.

### Independent checks

| Label | Command | Status | Bounded evidence |
|---|---|---|---|
| `frozen_install` | `pnpm install --frozen-lockfile` | PASS | Exit 0; all 8 workspace projects lockfile-current ("Already up to date"). |
| `cli_build` | `pnpm --filter @echolet/cli build` | PASS | Exit 0; production ESM bin build completes (`apps/cli/dist/cli.js`). |
| `workspace_typecheck` | `pnpm typecheck` | PASS | Exit 0; every TypeScript project `Done`, no errors. |
| `cli_process` | `pnpm --filter @echolet/cli exec vitest run src/commands/cli.test.ts src/commands/cli.dashOptionValues.test.ts` | PASS | Exit 0; **2 files / 24 tests**. |
| `workspace_tests` | `pnpm test` × 3 (one under 24-worker CPU load) | PASS | **3 green / 0 red. 158 tests every time.** See the run table. |
| `cli_suite_unfiltered` | `pnpm --filter @echolet/cli test` | PASS | Exit 0; **20 files / 97 tests**, no path or file exclusion; both E2E suites in the same run. |
| `e2e_3_iterations` | `pnpm --filter @echolet/cli test:e2e` | PASS | Exit 0; **3/3** clean real-relay two-process runs (offline, restart, exact retry, ack recovery), unfiltered. |
| `go_untagged` | `go -C apps/relay test ./...` | PASS | Exit 0; handler, router, middleware, repository, validation `ok` (cached). |
| `go_untagged_race` | `go -C apps/relay test -race -count=1 ./...` | PASS | Exit 0, uncached; same 5 packages `ok`, 0 data races. |
| `relayv2_race` | `go -C apps/relay test -race -count=1 -tags=relayv2 -timeout=300s ./...` | PASS | Exit 0, uncached; 5 packages `ok`, 0 data races. |
| `metaproject_test_strict` | `keryx test run --strict` | PASS | Exit 0; normalized report **PASS**, passed 3 / failed 0; its underlying `pnpm run test` was green (158, this is the 4th full workspace execution). |
| `health_strict` | `keryx health run --strict` | PASS | Exit 0; **project score 95 (stable), gate PASS** ("no gate conditions triggered"), 7 findings — **0 P0, 0 P1**, all 7 P2 cyclomatic complexity (advisory; the adapter auto-skips ESLint/TypeScript). |
| `graph_rebuild` | `keryx gdgraph build` | PASS | **87 nodes, 136 edges** (T49: 84 / 130; +3 nodes, +6 edges for the T50/T51 files). |
| `graph_cycles` | `keryx gdgraph query cycles` | PASS | No cycles found. |
| `wiki_links` | `keryx wiki check-links` | PASS | 19 pages, 38 internal links, 0 broken. |
| `t49f001_binary_probe` | scratchpad probe: real relay binary + real `dist/cli.js` | **PASS as a measurement, and it measures a defect** | 4/4 unauthenticated categories refused at ingress with the correct 4xx; self-published attacker accepted (200); wedge reachable and permanent at 49 max-size / 800 min-size authenticated poison. See Part 1. |
| `test_integrity` | `shasum -a 256 -c` over the pre-run baseline | PASS | **61 / 61 OK, 0 modified** (55 test files + 6 config files), verified by SHA-256 not mtime. `vitest.config.ts` = `da0c9db0…`, `globalSetup.ts` = `a27ae897…`, byte-identical to the T51 report. A repo-wide scan for `.skip( / .only( / .todo( / xit( / xdescribe( / t.Skip( / t.Skipf(` returns **0** real matches (the 3 raw hits are `os.Exit(1)`). No test, config or flow file was modified by this verification. |

### Every workspace execution (all complete, all unfiltered)

No exclusion of any kind — no `-t`, no file list, no path filter — was applied. `pnpm test` is
`pnpm -r test` (seven vitest instances); `load_workers` is *additional* deliberate CPU
oversubscription on a 10-core host.

| # | Command | load_workers | Exit | `apps/cli` | Workspace total | two-process E2E | anomalies |
|---:|---|---:|---:|---|---:|---|---|
| 1 | `pnpm test` (concurrent with the Go `-race` suites) | incidental | 0 | 20 files / 97 | **158 passed** | 3/3 | — |
| 2 | `pnpm test` | **24** | 0 | 20 files / 97 | **158 passed** | 3/3 (in-suite) | `Timeout calling "onTaskUpdate"`=0, timeout=0, ELIFECYCLE=0 |
| 3 | `pnpm test` | 0 (idle) | 0 | 20 files / 97 | **158 passed** | 3/3 (in-suite) | anomaly_count=0 |

Per-package totals identical in every run: **protocol 12, client-db 1, crypto-core 16, client-core
2, session-node 24, mobile 6, cli 97 = 158** (33 files). **No T43-N-001 look-alike
(`Timeout calling "onTaskUpdate"`) occurred**, under load or idle, so nothing needed disambiguating
from a T42-F-001 timeout recurrence.

### Test-count reconciliation against the orchestrator's 158

**Observed 158, exactly the orchestrator's figure.** Difference from T49's 139:

| Package | T49 | T52 | Δ | Cause |
|---|---:|---:|---:|---|
| protocol | 8 | 12 | +4 | T50 `mailboxEnvelope.test.ts` sender-signature schema cases |
| crypto-core | 4 | 16 | +12 | T50 `auth.envelope.test.ts` transcript / sign / verify cases |
| client-db | 1 | 1 | 0 | — |
| client-core | 2 | 2 | 0 | — |
| session-node | 24 | 24 | 0 | — |
| mobile | 6 | 6 | 0 | — |
| cli | 94 | 97 | +3 | T50 `outbound.senderAuthentication.test.ts` |
| **total** | **139** | **158** | **+19** | the T50 sender-authentication test wave |

Every one of the 19 added tests is accounted for; no test was removed, skipped or renamed.

---

## Verdict

```text
Acceptance target: echolet-cli-prototype
Revision:          working tree at /Users/Goodea/goodea/projects/echolet (unborn main, no commit hash)
Environment:       macOS (Darwin) arm64, 10 cores, Node v26.5.0 (/opt/homebrew/bin/node),
                   pnpm 10.0.0, go1.26.1 darwin/arm64, keryx 0.2.80
Status:            PASS
Checks:            18 executed — 18 PASS, 0 WARN, 0 FAIL (health gate PASS this run, score 95 stable)
Metrics:           workspace tests 158/158 across 4 full executions (one under 24-worker CPU load);
                   Go 5 packages ok untagged + race + relayv2 race, 0 data races; E2E 3/3 ×2 suites;
                   typecheck all projects; graph 87/136 no cycles; wiki 19 pages 0 broken;
                   integrity 61/61 OK by SHA-256; no `onTaskUpdate`/timeout/ELIFECYCLE anomaly.
Failures:          none among the required checks.
                   Outside the matrix: T52-F-001 (major/HIGH) — the T49-F-001 mailbox wedge survives
                   sender authentication. Device-record publication is unauthenticated (self-publish
                   returns 200), so an attacker mints their own identity for one request and then
                   floods with authenticated poison; the wedge is reachable and permanent at the same
                   49 max-size (~12.8 MB) / 800 min-size thresholds T49 measured, for up to 168 h.
Artifacts:         .metaproject/flows/001-.../t52-final-verification.md (this file);
                   scratchpad probe results (outside the repo, removed after use).
Decision:          matrix PASS; accepted as a technical prototype on the gate's own terms, with
                   T52-F-001 recorded OPEN — the flood capability is bounded but not eliminated.
```

### Bottom line on the two halves

- **The matrix is green.** Every required gate check passes on this tree, the workspace test count
  is exactly the 158 the orchestrator observed and fully reconciled, and integrity is proven by
  SHA-256. No test was weakened; no source, test, config or flow file was modified by this
  verification.
- **The important half is that the wedge is not closed.** T51's sender authentication is real and
  correct for unauthenticated senders, but it did not remove the T49-F-001 flooding capability — it
  relocated it behind a lock the attacker mints for themselves in one unauthenticated request.
  Reported as **T52-F-001 (major)**, verified by execution against the real relay binary at default
  configuration.

Claims established by the passing gate (unchanged from the metrics-and-validation contract): two
local CLI clients exchanged encrypted text through the relay and recovered from the tested restarts.
**Not** established: production security, safe use for sensitive communication, mobile delivery,
public-deployment readiness, independent-audit completion, user demand — and, per T52-F-001, the
mailbox is **not** protected against a self-published sender flooding a victim offline.

