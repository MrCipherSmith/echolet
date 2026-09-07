# T55 — Final independent verification (per-sender quota re-measurement + full matrix)

Flow: `001-2026-09-05-echolet-assessment-fixes`
Dispatch: `001-T55-verify`
Worker: `code-verifier` (independent; wrote none of this code)
Date: 2026-09-07

Revision: working tree at `/Users/Goodea/goodea/projects/echolet` (unborn `main`;
`git rev-parse HEAD` → `fatal: ambiguous argument 'HEAD'`, so the working tree is the revision
identifier). No tracked file was modified by this verification; all probes live outside the
repository and the repo test/config set is byte-identical by SHA-256 (Part 2).

Environment: macOS (Darwin) arm64, 10 cores. **Node v26.5.0 at `/opt/homebrew/bin/node`** (default
`node`; the T45-I-003 hazard — Node v22.12.0 lacking `node:sqlite` — did not apply). pnpm 10.0.0;
Go go1.26.1 darwin/arm64; keryx 0.2.80.

Integrity verified by **SHA-256** (mtime is unsound in this tree), reported in Part 2. Only labels,
counts, HTTP status codes, typed error codes and CLI exit codes were printed by any probe; a scan
confirmed no plaintext, ciphertext, key material or request body was emitted.

---

## PART 1 — did the per-sender quota (T54) change the wedge, and by how much?

### Verdict, stated plainly

**The quota is real, correct, and does exactly what was promised — it raises the attacker's
*identity* cost linearly and closes nothing.** Measured by execution against the **real relay
binary built from this tree** and the **real `apps/cli/dist/cli.js`**:

- A single sender is now hard-bounded at **16** live unacked envelopes per recipient mailbox. The
  17th is refused **`403 SENDER_QUOTA_EXCEEDED`** *before storage*, and a legitimate message queued
  behind those 16 is still delivered.
- Ack frees a slot; expiry frees a slot; an idempotent byte-identical replay at the bound still
  returns 200 and costs no slot.
- **The multi-identity flood still wedges the mailbox**, because `POST /v1/device-records/publish`
  is still unauthenticated (finding T52-F-001, unchanged) and a fresh identity costs one HTTP
  request. In the byte-bounded regime the wedge boundary is **48 max-size poison deliver, 49
  wedge** — the *same* 48/49 threshold T52 measured for one identity. The quota changed only how
  many self-published identities that 49 must be spread across: **from 1 to 4.**

### One correction to the T54 report, proven by execution

The T54 implementation report and the handler comment state the byte-bounded residue as
**"3 identities + 48 maximum-size POSTs"** (`ceil(48/16) = 3`). **That is off by one against the
real binary: 48 max-size poison do NOT wedge — the legitimate message is delivered.** The true
cost is **4 identities + 49 maximum-size POSTs**. Directly measured, twice, on the real CLI drain
walk:

```
boundary_48poison  { poison: 48, identities: 3, poll1_exit: 0, delivered: true,  wedged: false }
boundary_49poison  { poison: 49, identities: 4, poll1_exit: 3, delivered: false, wedged: true  }
```

Why 48 delivers and 49 wedges (mechanism, confirmed by a direct raw poll):

- A max-size envelope encodes to **262 853 bytes**; the relay's per-poll byte budget is
  `(1 << 20) − 4096 = 1 044 480` bytes, so a poll page carries **exactly 3** max-size envelopes
  (`page1 { status: 200, envelopes: 3, has_more: true }`, measured directly). The client walks
  **16 pages** (`maxPollPagesPerPoll = 16`), i.e. 48 max-size slots.
- The *legitimate* message is small. On the 16th page, after the last 3 max-size poison
  (positions 45–47), the small legit message at position 48 **still fits the remaining byte
  budget and rides along on that same page** — so at exactly 48 poison it is delivered. Only at 49
  poison is the legit pushed to a 17th page the walk never reaches → wedge. This is precisely the
  "48 deliver, 49 wedge" T52 recorded.
- The 16/sender quota means 3 identities can place at most **3 × 16 = 48** poison — landing exactly
  on the "still delivers" boundary. Reaching 49 requires a **4th** identity. The implementation's
  `ceil(48/16)=3` conflated "max poison that still delivers" (48) with "min poison that wedges"
  (49); the correct figure is `ceil(49/16) = 4`. **The quota is therefore marginally *more*
  effective than the report claims, not less.**

The green residue test `TestKnownResidueDistinctIdentitiesStillWedgeTheDrainWalk` (3 identities)
remains correct as a *class* statement — the flood is not closed — but its identity count is a
simulation artifact: it drives a page size of 2 with small envelopes
(`quotaWalkPageSize = 2`, capacity 32), where 3 × 16 = 48 > 32 wedges. That simulation does not
reproduce the real byte-bounded 1 MiB regime, in which 4 identities are required.

### The five obligations, each answered by execution

**Method.** The real relay binary (`go -C apps/relay build`) at default configuration
(`ECHOLET_MAX_MESSAGE_BYTES` 262144, `ECHOLET_MAX_MAILBOX_BATCH` 100,
`ECHOLET_MAX_UNACKED_ENVELOPES_PER_SENDER` 16, retention 168 h). Only `ECHOLET_HTTP_ADDR`,
`ECHOLET_DATA_DIR` and `ECHOLET_RATE_LIMIT_PER_MINUTE` (raised to 1 000 000/min so the rate limiter
does not confound the *count-of-envelopes* measurement — the same single deviation T49/T52 declared;
the default 120/min cost is reported below). Legitimate parties Alice/Bob are driven through the
**real `dist/cli.js`** (`init → contact export/import → relay publish → send/poll/history`). An
attacker is a fresh ed25519 identity minted in-probe with the real `@echolet/crypto-core`
primitives, its `DeviceRecord` self-signed with the real `signCanonicalJson` and self-published
(HTTP 200, no credential); poison is signed with the real `signMailboxEnvelopeMessage` over the
pinned `echolet-mailbox-envelope:v1:…` transcript.

**1 — single-identity flood bounded at 16, 17th refused before storage, legit still delivered.**
Confirmed two ways:

```
scenarioA_attacker_publish_status  200           # self-publish is free (T52-F-001, unchanged)
scenarioA_first16                  { all200: true, count: 16 }
scenarioA_17th                     { status: 403, code: "SENDER_QUOTA_EXCEEDED" }
scenarioA_legit_behind_16          { poll_exit: 0, history_len: 1 }   # legit delivered behind 16
scenarioB_alice_first16_exit0      true          # a real published sender, same bound
scenarioB_alice_17th_before_poll   { exit: 3, code: "SENDER_QUOTA_EXCEEDED" }
```

"Before storage" is shown by the mailbox holding exactly 16 from that sender and the legit message
still being delivered; the refused envelope leaves nothing behind. The 403 is non-retryable and the
CLI reports it at exit 3 (`SENDER_QUOTA_EXCEEDED` is carried inland by both client allowlists).

**2 — ack frees a slot; expiry frees a slot.**

```
scenarioB_bob_poll_after_16        { poll_exit: 0 }               # Bob polls → acks the 16
scenarioB_alice_send_after_ack     { exit: 0, ok: true }          # Alice can send again
scenarioC_17th_while_full          { status: 403, code: "SENDER_QUOTA_EXCEEDED" }
scenarioC_send_after_expiry        { status: 200, code: "" }      # 16 poison expired (2 s TTL) → slot freed
```

The count is a live scan, not a send/ack counter, so an envelope that leaves by expiry (the normal
offline outcome) frees its slot too — exactly the property the implementation argues and the
`TestExpiredEnvelopesDoNotConsumeSenderQuota` guard pins.

**3 — idempotent replay at the bound still succeeds and costs no slot.**

```
scenarioD_replay_at_quota          { status: 200, code: "" }      # byte-identical 16th re-sent → 200
scenarioD_fresh_17th_still_blocked { status: 403, code: "SENDER_QUOTA_EXCEEDED" }
```

F-004's exact retry is preserved at exactly the moment a lost boundary response makes it necessary.

**4 — the multi-identity wedge: new threshold and new cost.**

Byte-bounded regime (max-size poison), real CLI drain walk:

```
threshold_N3  { poison_stored: 48, poll1_exit: 0, delivered: true,  wedged: false }   # 3 identities: NOT wedged
threshold_N4  { poison_stored: 64, poll1_exit: 3, delivered: false, wedged: true  }   # 4 identities: wedged
threshold_N5  { poison_stored: 80, poll1_exit: 3, delivered: false, wedged: true  }
boundary_48poison { identities: 3, delivered: true }   # exact boundary: 48 delivers
boundary_49poison { identities: 4, wedged: true }      #                 49 wedges
wedge_persistence_3_polls { poll1: 0, poll2: 3, poll3: 3, history_len: 1 }  # holds across re-polls
```

| | Previous (T52, no quota) | Now (T54 quota, this tree) |
|---|---|---|
| Byte-bounded wedge | **1** identity + **49** max-size POSTs (~12.85 MB) | **4** identities + **49** max-size POSTs (~12.85 MB) |
| Count-bounded wedge | **1** identity + **800** min-size POSTs (~0.7 MB) | **50** identities + **800** POSTs (~0.7 MB) |
| Poison boundary | 48 deliver / 49 wedge | 48 deliver / 49 wedge (**unchanged**) |
| Identity price | 1 unauthenticated publish | 1 unauthenticated publish *each* |
| Duration held | up to 168 h | up to 168 h |
| Under default 120/min | seconds | 4 + 49 = 53 requests, still under a minute |

The count-bounded figure (50 identities + 800 POSTs) matches the T54 report exactly, because 800 is
divisible by 16. The byte-bounded figure is **4 identities + 49 POSTs**, not the report's 3 + 48.
The **data volume and POST count are essentially unchanged** (49 max-size POSTs wedge either way);
what the quota raised is the **identity count**, from 1 to 4 (byte-bounded) / 50 (count-bounded).
Because a self-published identity still costs one unauthenticated HTTP request, this is a linear
price increase on a near-free resource — precisely what the user was told, and it closes nothing.

**5 — the legitimate two-party flow still works end to end.**

```
legit_roundtrip { bob_poll_exit: 0, bob_history_len: 1, alice_poll_exit: 0, alice_history_len: 2 }
```

Alice → Bob delivered, Bob → Alice reply delivered; corroborated by the unfiltered three-iteration
real E2E in Part 2 (offline / restart / exact-retry / ack-recovery).

### T55-F-001 (informational, not a gate failure) — residue cost is 4 identities, not 3

The class T52-F-001 identified is unchanged: `POST /v1/device-records/publish` is unauthenticated,
identities are free, the quota bounds one sender and nothing bounds total mailbox occupancy, so the
flood still wedges a victim for up to 168 h. The only correction is quantitative and in the
defender's favour: the byte-bounded residue is **4 self-published identities + 49 max-size POSTs**,
where the T54 report and the `defaultSenderUnackedQuota` comment say 3 + 48. No source, test or
configuration file was modified; this is a measurement, recorded so the number in the report can be
reconciled with the binary.

---

## PART 2 — the full matrix

All checks on Node v26.5.0 / Go 1.26.1 / pnpm 10.0.0 / keryx 0.2.80, working tree as above.

### Independent checks

| Label | Command | Status | Bounded evidence |
|---|---|---|---|
| `frozen_install` | `pnpm install --frozen-lockfile` | PASS | Exit 0; all 8 workspace projects lockfile-current ("Already up to date"). |
| `cli_build` | `pnpm --filter @echolet/cli build` | PASS | Exit 0; production ESM bin build (`apps/cli/dist/cli.js`). |
| `workspace_typecheck` | `pnpm typecheck` | PASS | Exit 0; every TypeScript project `Done`, no errors. |
| `cli_process` | `pnpm --filter @echolet/cli exec vitest run src/commands/cli.test.ts src/commands/cli.dashOptionValues.test.ts` | PASS | Exit 0; **2 files / 24 tests**. |
| `workspace_tests` | `pnpm test` × 3 (one under 24-worker CPU load) | PASS | **3 green / 0 red. 162 tests every time.** See the run table. |
| `cli_suite_unfiltered` | `pnpm --filter @echolet/cli test` | PASS | Exit 0; **22 files / 101 tests**, no path or file exclusion; both E2E suites in the same run. |
| `e2e_3_iterations` | `pnpm --filter @echolet/cli test:e2e` | PASS | Exit 0; **3/3** real-relay two-process runs (offline / restart / exact retry / ack recovery), unfiltered. |
| `go_untagged` | `go -C apps/relay test ./...` | PASS | Exit 0; handler, router, middleware, repository, validation `ok`. |
| `go_untagged_race` | `go -C apps/relay test -race -count=1 ./...` | PASS | Exit 0, uncached; same 5 packages `ok`, 0 data races. |
| `relayv2_race` | `go -C apps/relay test -race -count=1 -tags=relayv2 -timeout=300s ./...` | PASS | Exit 0, uncached; 5 packages `ok`, 0 data races. |
| `metaproject_test_strict` | `keryx test run --strict` | PASS | Exit 0; normalized report **PASS**, passed 3 / failed 0 (its `pnpm run test` was green — a 4th full workspace execution at 162). |
| `health_strict` | `keryx health run --strict` | PASS | Exit 0; **project score 95 (stable), gate PASS** ("no gate conditions triggered"), 7 findings, none gate-triggering (advisory cyclomatic complexity). |
| `graph_rebuild` | `keryx gdgraph build` | PASS | **89 nodes, 139 edges** (T52: 87 / 136; +2 nodes, +3 edges for the T54 quota code). |
| `graph_cycles` | `keryx gdgraph query cycles` | PASS | No cycles found. |
| `wiki_links` | `keryx wiki check-links` | PASS | 19 pages, 38 internal links, **0 broken**. |
| `quota_wedge_probe` | scratchpad probes: real relay binary + real `dist/cli.js` | **PASS as a measurement** | Quota bounds one sender at 16 (17th `403 SENDER_QUOTA_EXCEEDED` before storage); ack and expiry each free a slot; idempotent replay at the bound stays 200; byte-bounded wedge boundary **48 delivers / 49 wedges**, requiring **4** self-published identities. See Part 1. |
| `test_integrity` | `shasum -a 256 -c` over the pre-run baseline | PASS | **59 / 59 OK, 0 modified** (34 TS test + 23 Go test + 2 vitest config/globalSetup), by SHA-256 not mtime; file set byte-for-byte identical before and after. A scan for `.skip( / .only( / .todo( / xit( / xdescribe( / t.Skip( / t.Skipf(` returns **0**. No test, config or flow file was modified by this verification. |

### Required measurements (`docs/requirements/echolet-cli-prototype/metrics-and-validation.md`)

Every required measurement is satisfied by the passing suites above, on this one revision:

| Metric | Threshold | Result |
|---|---|---|
| Clean end-to-end runs | 3/3 | **3/3** (`e2e_3_iterations`) |
| Concurrent claim winners | exactly 1 of ≥20 | PASS (Go handler race suite, green under `-race`) |
| Lost-response claim retries | same bundle bytes | PASS (Go integration, green) |
| Reused OTK publications | 100% rejected | PASS (Go repository, green) |
| Offline delivery | 1/1 after receiver start | PASS (two-process E2E, 3/3) |
| Sender restart exact retry | ciphertext bytes identical | PASS (E2E asserts the two send bodies identical) |
| Receiver duplicate history entries | 0 | PASS (inbox/history tests + E2E) |
| Plaintext marker in relay DB/logs | 0 | PASS (E2E marker scan; probes also leak-clean) |
| Invalid contract cases rejected | 100% fixture corpus | PASS (protocol / crypto-core / Go validation fixtures) |
| Required Markdown versions and links | 100% | PASS (`wiki_links` 0 broken) |

### Every workspace execution (all complete, all unfiltered)

No `-t`, file list or path filter of any kind. `pnpm test` is `pnpm -r test` (seven vitest
instances); `load_workers` is *additional* deliberate CPU oversubscription on a 10-core host.

| # | Command | load_workers | Exit | `apps/cli` | Workspace total | anomalies |
|---:|---|---:|---:|---|---:|---|
| 1 | `pnpm test` | 0 (idle) | 0 | 22 files / 101 | **162 passed** | none |
| 2 | `pnpm test` (under load) | **24** | 0 | 22 files / 101 | **162 passed** | `onTaskUpdate`=0, `ELIFECYCLE`=0, timeout=0 |
| 3 | `pnpm test` | 0 (idle) | 0 | 22 files / 101 | **162 passed** | none |
| 4 | via `keryx test run --strict` | — | 0 | — | **162 passed** | none |

Per-package totals identical in every run: **protocol 12, client-db 1, crypto-core 16, client-core
2, session-node 24, mobile 6, cli 101 = 162** (33 files). **No `Timeout calling "onTaskUpdate"`
(T43-N-001) occurred**, under load or idle, so nothing needed disambiguating from a T42-F-001
timeout recurrence.

### Test-count reconciliation against the orchestrator's 162

**Observed 162, exactly the orchestrator's figure** (cli 101, session-node 24, crypto-core 16,
protocol 12, mobile 6, client-core 2, client-db 1). Difference from T52's 158:

| Package | T52 | T55 | Δ | Cause |
|---|---:|---:|---:|---|
| protocol | 12 | 12 | 0 | — |
| crypto-core | 16 | 16 | 0 | — |
| client-db | 1 | 1 | 0 | — |
| client-core | 2 | 2 | 0 | — |
| session-node | 24 | 24 | 0 | — |
| mobile | 6 | 6 | 0 | — |
| cli | 97 | 101 | +4 | T53 client-side quota tests: `src/transport/relayClient.senderQuota.test.ts` and `src/commands/cli.senderQuota.test.ts` (2 new files) |
| **total** | **158** | **162** | **+4** | the T53/T54 per-sender-quota wave |

The Go side gained `mailbox_sender_quota_test.go` (counted in the Go suites, not the vitest total)
and the shipped source gained the quota itself; no vitest test was removed, skipped or renamed. All
59 tracked test/config files verify byte-identical by SHA-256.

---

## Verdict

```text
Acceptance target: echolet-cli-prototype
Revision:          working tree at /Users/Goodea/goodea/projects/echolet (unborn main, no commit hash)
Environment:       macOS (Darwin) arm64, 10 cores, Node v26.5.0 (/opt/homebrew/bin/node),
                   pnpm 10.0.0, go1.26.1 darwin/arm64, keryx 0.2.80
Status:            PASS
Checks:            17 executed — 17 PASS, 0 WARN, 0 FAIL (health gate PASS, score 95 stable)
Metrics:           workspace tests 162/162 across 4 full executions (one under 24-worker CPU load);
                   Go 5 packages ok untagged + race + relayv2 race, 0 data races; E2E 3/3;
                   typecheck all projects; graph 89/139 no cycles; wiki 19 pages 0 broken;
                   integrity 59/59 OK by SHA-256; no onTaskUpdate/timeout/ELIFECYCLE anomaly.
Failures:          none among the required checks.
                   Outside the matrix: the T52-F-001 flooding class remains OPEN (device-record
                   publication is still unauthenticated). The T54 per-sender quota bounds one
                   sender at 16, refuses the 17th 403 SENDER_QUOTA_EXCEEDED before storage, and
                   frees on ack and expiry — all confirmed. It raises the byte-bounded wedge cost
                   from 1 identity to 4 self-published identities (not the 3 the T54 report states;
                   48 poison deliver, 49 wedge, and 3x16=48 lands on the deliver side), and to 50
                   identities count-bounded. Same 49 max-size POSTs / ~12.85 MB / up to 168 h.
Artifacts:         .metaproject/flows/001-.../t55-final-verification.md (this file);
                   scratchpad probes (outside the repo, removed after use).
Decision:          matrix PASS; accepted as a technical prototype on the gate's own terms, with
                   T52-F-001 still OPEN — the flood is bounded further, not eliminated, and its
                   residual cost is 4 identities (byte-bounded), one more than the report claims.
```

### Bottom line on the two halves

- **The matrix is green.** Every required gate check passes on this tree, the workspace test count
  is exactly the 162 the orchestrator observed and fully reconciled, integrity is proven by
  SHA-256, and nothing is skipped. No source, test, config or flow file was modified by this
  verification.
- **The important half: the quota does what was promised and no more.** It is a real, correct
  per-sender bound (16, refused before storage, released by ack and expiry, replay-exempt, and it
  does not touch the legitimate two-party flow). It raises the attacker's *identity* cost linearly
  — to **4** self-published identities byte-bounded, **50** count-bounded — while the per-identity
  price stays one unauthenticated `POST /v1/device-records/publish` and the data volume, POST count
  and 168 h duration are unchanged. The flooding class (T52-F-001) is **not** closed. The one
  numeric correction to T54, proven by execution: the byte-bounded residue is **4 identities + 49
  max-size POSTs**, not the 3 + 48 the report and the `defaultSenderUnackedQuota` comment record.

Claims established by the passing gate (unchanged from the metrics-and-validation contract): two
local CLI clients exchanged encrypted text through the relay and recovered from the tested restarts.
**Not** established: production security, safe use for sensitive communication, mobile delivery,
public-deployment readiness, independent-audit completion, user demand — and, per T52-F-001, the
mailbox is **not** protected against a self-published sender flooding a victim offline; the quota
raises the cost of that flood without removing it.
