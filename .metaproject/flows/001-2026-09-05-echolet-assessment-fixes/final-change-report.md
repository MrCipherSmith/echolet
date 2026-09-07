# Flow 001 — final change report

Flow: `001-2026-09-05-echolet-assessment-fixes`
Task: T29 (`job-documenter`), dispatch `001-T29-docs`
Date: 2026-09-07

Revision: working tree at `/Users/Goodea/goodea/projects/echolet`. `main` is **unborn**: no
commit, no remote. No result in this flow can be pinned to a commit hash, the PR-and-merge
completion path is unavailable, and **AC6 remains unmet**.

Every number below comes from a recorded artifact and is cited. Nothing here was measured by
this task; this task changed documentation and four source comments only.

---

## 1. What the wave changed

The wave began as remediation of an assessment and became four rounds of review, fix and
independent verification. Grouped by area, with the durable artifact rather than a restatement:

| Area | What landed | Where it is recorded |
|---|---|---|
| CLI prototype | Eight-command surface (`init`, `contact export/import`, `relay publish`, `send`, `poll`, `history`, `doctor`), profiles with an encrypted durable store, typed exit codes 0/2/3/4/5 | [`t24`](t24-implementation-report.md), [`t25`](t25-implementation-report.md), [`cli-profile-implementation-report.md`](cli-profile-implementation-report.md) |
| Relay v2 network path | `POST /v2/prekeys/publish` and `POST /v2/prekeys/claim`, atomic claim, one-time-prekey reservation, `claimable` on the publish response | [`t44-multisender-diagnosis.md`](t44-multisender-diagnosis.md), [`t45`](t45-implementation-report.md) |
| Two-process end-to-end | Real relay, two OS processes, offline delivery, sender restart with byte-identical retry, receiver restart, ack recovery | [`t26-e2e-report.md`](t26-e2e-report.md) |
| Original twelve findings + a thirteenth found by verification | All 13 closed | [`t28-review-report.md`](t28-review-report.md), dispositions §1–§2 of [`t56`](t56-final-dispositions.md) |
| Round-1 and round-2 fix-review findings | Shape parity at ingress, server-issued resume cursor, bounded identifiers, per-envelope acceptance, bounded page walk | [`t37`](t37-verification-report.md), [`t42`](t42-verification-report.md), [`t48`](t48-implementation-report.md), [`t49`](t49-verification-report.md) |
| Sender authentication (approved scope extension) | Versioned `echolet-mailbox-envelope:v1:` transcript carried as `sender_signature`, verified against the sender's published root-signed `DeviceRecord` before storage | [`t51`](t51-implementation-report.md), [`t52-final-verification.md`](t52-final-verification.md) |
| Per-sender unacked quota (approved scope extension) | `ECHOLET_MAX_UNACKED_ENVELOPES_PER_SENDER`, default 16 live envelopes per sender per mailbox; 17th refused `403 SENDER_QUOTA_EXCEEDED` before storage | [`t54`](t54-implementation-report.md), Part 1 of [`t55`](t55-final-verification.md) |
| Documentation debt (T29, this task) | `claimable`, poll request `cursor`, `next_cursor` resume semantics, `poll` result shape, `sender_signature` and its transcript, per-sender quota, and the three reported relay codes with their exit mapping | `docs/API-11_JSON_SCHEMAS.md`, `docs/PROTOCOL-07_MVP_MESSAGE_FLOW.md`, `docs/requirements/echolet-cli-prototype/specification.md` |
| Status correction (T29, this task) | `docs/STATUS_CURRENT.md` and `docs/requirements/echolet-cli-prototype/README.md` brought to the verified state | those files |
| Stale comment correction (T29, this task) | "`/v1/messages/send` has no sender authentication", still standing as the *rationale* of a security bound after T51 made it false, corrected at five sites — comment text only | see §5 |

### Naming hazard, carried forward deliberately

Round-1 reviewers emitted reviewer-local ids and two independently emitted `R-001`; the prefixed
aliases (`BE-R-`, `SEC-R-`, `HL-N-`) exist only because of that collision. Cite `global_id`
(`<reviewId>#<id>`), never the bare display id. Likewise the T40/T41 dispatch-artifact crossing is
real: task T40 is the TEST task documented by `dispatches/001-T41-tests*.json` and task T41 is the
IMPLEMENT task documented by `dispatches/001-T40-implement*.json`. Both are explained in
[`t56-final-dispositions.md` §9](t56-final-dispositions.md).

---

## 2. Evidence

All from [`t55-final-verification.md`](t55-final-verification.md), run by an independent
`code-verifier` that wrote none of this code. Environment: macOS (Darwin) arm64, 10 cores,
**Node v26.5.0** (`/opt/homebrew/bin/node`), pnpm 10.0.0, go1.26.1 darwin/arm64, keryx 0.2.80.
Integrity verified by SHA-256, because mtime was demonstrated to be unsound in this tree
(finding R2-I-004).

| Check | Result |
|---|---|
| `pnpm test` | **162 tests, green in four full unfiltered executions**, one under 24-worker CPU oversubscription. Per package: cli 101, session-node 24, crypto-core 16, protocol 12, mobile 6, client-core 2, client-db 1 — 33 files |
| `pnpm --filter @echolet/cli test` | 22 files / 101 tests, no path or file exclusion |
| `pnpm --filter @echolet/cli test:e2e` | **3/3** real two-process runs against the real relay |
| `pnpm typecheck` | PASS, every project |
| `go -C apps/relay test ./...` | PASS; also `-race -count=1` and `-race -count=1 -tags=relayv2`: 5 packages `ok`, 0 data races |
| `keryx health run --strict` | gate PASS, project score 95 |
| `keryx gdgraph build` / `query cycles` | 89 nodes, 139 edges; no cycles |
| `keryx wiki check-links` | 19 pages, 38 internal links, 0 broken |
| Test/config integrity | **59/59 OK** by SHA-256; zero `skip`/`only`/`todo` markers |

Required measurements from `metrics-and-validation.md` — clean end-to-end runs 3/3, exactly one
concurrent claim winner, lost-response claim retry returning the same bundle bytes, 100% rejection
of reused one-time-prekey publications, offline delivery, byte-identical sender restart retry,
zero duplicate history entries, zero plaintext markers in relay storage or logs, 100% of the
invalid-contract fixture corpus rejected — are all satisfied by those passing suites on this one
revision.

### Re-verification after this task's edits

`pnpm test` → 162 passed; `pnpm typecheck` → PASS; `go -C apps/relay test ./...` → PASS. The
comment edits changed no behaviour and no assertion. Recorded in the T29 dispatch result.

---

## 3. Disposition summary

From [`t56-final-dispositions.md`](t56-final-dispositions.md), 110 rows, consolidated by an
independent `review-verifier` that wrote neither the code nor the reviews.

| Disposition | Rows | Of which still open |
|---|---:|---|
| fixed | 51 | — |
| partially-fixed | 7 | 7 |
| accepted (deliberate, reason recorded) | 26 | 26 — by decision, not omission |
| not-fixed / open | 21 | 21 |
| documented limitation (open, stated as such) | 2 | 2 |
| cross-reference to another row | 3 | — |

Blocking acceptance: **4 rows, one defect class** — T49-F-001, T52-F-001, T53-F-001, T54-F-001
(mailbox flooding). Nothing else is open at blocker or major severity. **No finding in this flow
was ever refuted.** Nothing deliberately accepted is recorded as fixed.

---

## 4. Limitations

### 4.1. Mailbox flooding is bounded, not eliminated

Measured on the real relay binary at default configuration and the real `dist/cli.js` drain walk
([`t55`](t55-final-verification.md), Part 1):

| Property | Value |
|---|---|
| Status | **bounded, not closed** |
| Byte-bounded regime | **4** self-published identities + **49** maximum-size envelopes ≈ **12.85 MB**, in under 30 s, inside the default 120 requests/minute rate limit |
| Count-bounded regime | **50** self-published identities + **800** minimum-size envelopes ≈ 0.7 MB |
| Poison boundary | 48 maximum-size envelopes still deliver the legitimate message; **49 wedge** |
| Duration of the wedge | up to the **168 h** retention cap |
| Root enabler, still open | `POST /v1/device-records/publish` is itself unauthenticated (`apps/relay/internal/api/handler/device_record_handler.go`, `apps/relay/internal/validation/validate.go`), so an identity costs one free request |
| Standing regression recording the residue | `TestKnownResidueDistinctIdentitiesStillWedgeTheDrainWalk` (deliberately green) |

Three remediation rounds each raised the attacker's price and each declared the class not closed:
T48's server-issued cursor and bounded 16-page walk, T51's sender authentication, T54's per-sender
quota. The quota is real, correct and does exactly what was promised: it bounds one *sender*, not
total mailbox occupancy. It raised the identity price from 1 to 4 (byte-bounded) or 50
(count-bounded) — a linear price increase on a near-free resource. The data volume, the POST count
and the 168 h duration are unchanged.

One numeric correction is recorded here so the tree is self-consistent: the T54 implementation
report and the `defaultSenderUnackedQuota` comment state the byte-bounded residue as 3 identities
and 48 envelopes, from `ceil(48/16)`. T55 proved by execution that 48 poison still deliver and 49
wedge, so `ceil(49/16) = 4` identities are required. The quota is marginally *more* effective than
the report claimed, not less. `docs/API-11_JSON_SCHEMAS.md` and
`docs/PROTOCOL-07_MVP_MESSAGE_FLOW.md` now carry 4.

**The user was shown these measured numbers and chose to record this as a documented limitation
rather than extend scope further.**

Do not write "fixed", "closed", "mitigated" or "hardened" about this class without the bound
beside it.

### 4.2. Sender authentication and the per-sender quota were approved scope extensions

State this plainly, because it is the difference between a decision and scope creep. The
orchestrator did **not** decide T49-F-001 alone: two standing instructions conflicted — close every
blocker/major finding, versus do not change the prototype's scope. Closing the flooding class at
its root meant adding production-shaped security to a v1 route that had never had it, which the
wave's scope explicitly excludes; the alternative was documenting a cheap denial of service that no
acceptance criterion forbids. The four options were put to the user with the measured attacker cost
and the trade-off stated, and **the user chose the full fix: sender authentication on
`/v1/messages/send`.** The quota round follows directly from that same decision, after T52 showed
sender authentication alone did not close the class. Neither is something the wave grew into on its
own. (`journal.md`, entries of 2026-09-07.)

The other user decision on the record: on 2026-09-06 the user approved the reviewed requirements
package at `docs/requirements/echolet-cli-prototype/` and requested autonomous implementation
through the flow orchestrator with managed subagents.

### 4.3. One published bundle serves exactly one first-contact sender

Structural, and now documented in `specification.md`. `rotateBundle()`
(`apps/cli/src/runtime/outbound.ts`) and `retryPending()` exist in the codebase but have **no CLI
entry point** — a deliberate frozen-surface decision, because a ninth command would change the
surface this flow is validating. So after a first sender claims a recipient's bundle, a second
distinct sender receives `PREKEY_BUNDLE_UNAVAILABLE`, and a re-run of `relay publish` reports
`claimable: false` rather than restoring availability.

No acceptance criterion is broken: nothing in `specification.md` or `metrics-and-validation.md`
requires two distinct senders to reach one recipient, so this breaks an unclaimed guarantee, not a
claimed one (the nearest criterion is AC-10).

### 4.4. Environment caveat

`apps/cli` declares `"engines": {"node": ">=22.13"}`. **Node 22.12 lacks `node:sqlite`**, and under
it 13 of the 17 CLI suites at the time of measurement failed to collect, with the process-level
suites exiting 1 with no output — **a failure mode that looks exactly like a broken implementation
and is not one** (21 failures across 13 files; `apps/cli` now holds 22 test files). No permanent
pin was added, so the hazard remains for the next reader. Every gate from T42 onward confirmed
`node --version` as v26.5.0 first, so the hazard applied to no recorded result.

### 4.5. Every other still-open item, with measured cost where one exists

| Item | State | Measured cost / note |
|---|---|---|
| Poll byte budget uncoupled from `ECHOLET_MAX_MESSAGE_BYTES` (HL-N-003 / T35-I-001) | open, documented limitation | At `maxMessageBytes` = 2 MiB the relay returned a **2,097,781-byte** poll response — about twice the CLI's 1 MiB hard bound — and nothing was acked. Unreachable at the default 262144. The *send-route* body bound was derived from configuration; only the poll budget is a compile-time constant |
| Backfill robustness (BE-R-002, BE R-003) | open | `BackfillDeviceMailboxBindings` is the only `device_mailbox` writer without a bounded conflict retry, and one undecodable record aborts the scan: measured **0 of 2** healthy records bound after one bad record. Its startup cost was never confirmed by a verifier (T34-I-001's unanswered half) |
| Cursor-path test residue (T49-F-002) | open | `GetEnvelopeBatchFrom` — the path serving every production poll — has **no test with a non-empty cursor**; the "expiry is skipped before the cursor is consumed" property is protected only by a source comment |
| Byte-budget exemption unpinned (T41-N-003, MG3) | open | The first-envelope byte-budget exemption survives deletion; no test kills that mutant |
| Mobile signing unobservable (T51-F-002) | open | The mobile demo signs, but its 6 tests never reach `sendMessage` and `sender_signature` is optional on the client schema, so a wrong transcript would not be caught by tests or by tsc. **Correct by construction, unobservable by any test** |
| Mutation coverage gaps (T38-TP-004) | accepted, open by design | Four fix areas (F-002, F-006, F-007, F-010/F-011) were assessed by reading and never reached by a mutation pass. Reason: mutation budget, not a defect claim |
| Unbounded `bundle_id` (T48-004) | open | Third member of the bounded-identifier class; no length bound in `apps/relay/internal/validation/validate.go`, left alone because no RED test covered it |
| `--json` declared and never read (T38-L-004) | open | Allowed on every command, no effect |
| Rate-limiter bucket map (HL N-004) | open | No max-entry cap between prune sweeps; the sweep is O(len(clients)) under the shared lock |
| `HasMore` false positive (HL N-005) | open | Can be true when every remaining item is expired |
| `envelopeBodyLimit()` vs raw `maxMessageBytes` (BE R-004), `size_bytes` typing (BE R-005), `ProfileError` exit bucketing (SEC R-002), zero-`maxMessageBytes` behaviour (SEC R-003) | open, info | None reachable at default configuration; each cited at `file:line` in [`t56`](t56-final-dispositions.md) §3 |
| `GetEnvelopeBatch` 3-argument delegation (T48-001) | open, cleanup | Survives only because an un-editable test calls the old form |
| Accepted-by-design behaviours an operator will notice | accepted | A poll that accepts nothing re-raises the first rejection and discards the `rejected` list (R2-L-004, preserving the F-012 whole-batch contract); a malformed relay response reads as `PROTOCOL_REJECTED` (T42-I-001, R2-I-003); the poll cursor is outside the signed challenge and an out-of-range position returns an empty page (T49-I-001); the position cursor can skip or repeat one envelope under concurrent ack/expiry (T48-002); the two 403 codes form a published-vs-unpublished identity oracle (T51-F-003 / T52-F-002); `message_id` and the two recipient fields are not bound by the v1 sender transcript (T50-I-002 / T51-F-004) |
| Harness limits | accepted | Above roughly 30× CPU oversubscription vitest's birpc `onTaskUpdate` hits a hardcoded 60 s ceiling and discards a whole file's results, with no config lever (T43-N-001; observed **0 times** at the ≤4.8× load the gates used). Packages other than `apps/cli` still run on vitest's 5000 ms default (T43-N-002). The strict health adapter cannot execute ESLint and does not associate the independently passing typecheck and test commands with its required sources, so its score is advisory; `keryx test run --strict` under-counts, and the independent workspace run is the authoritative count |

### 4.6. What remains unimplemented and unproven

The gate establishes local technical-prototype behaviour on one macOS arm64 machine and nothing
more. It does **not** establish:

- **production security**, or safe use for sensitive communication;
- **mobile delivery** — `apps/mobile` contributes 6 tests that render only the disabled-state gate;
  no real-device messaging, relaunch, connectivity loss or background delivery has been run (flow
  task **T10**, open);
- **public deployment / production-deployment readiness**;
- **completion of an independent cryptographic audit** (flow task **T11**, open);
- **user demand or a user pilot** — no interviews and no pilot have been run (flow task **T12**,
  open; `PILOT-29` still carries empty evidence fields);
- **permanent suitability of the pinned `@signalapp/libsignal-client@0.102.0`**, which is
  prototype-only.

The allowed claim ceiling after a passing gate, from
`docs/requirements/echolet-cli-prototype/metrics-and-validation.md`, is: two local computer CLI
clients exchanged encrypted text through the Echolet relay and recovered from the tested restarts.
With the exclusion T52 attached: the mailbox is **not** protected against a self-published sender
flooding a victim offline.

---

## 5. What this task (T29) changed

**Documentation.**

- `docs/STATUS_CURRENT.md` — rewritten to the verified state: git exists on an unborn `main` with
  no commits and no remote (AC6 unmet); the computer CLI technical prototype, the relay v2 network
  path and the two-process end-to-end scenario are implemented and locally verified; the T55
  measurements and the T56 disposition counts; the open limitations; the environment caveat; the
  three user decisions; and an explicit list of what remains unimplemented and unproven.
- `docs/requirements/echolet-cli-prototype/README.md` — "spec ready" replaced by the verified
  state, with what that status does not mean, the two approved scope extensions named, and the
  entry point repointed from the implementation plan to the shipped contract.
- `docs/requirements/echolet-cli-prototype/specification.md` — implementation state table; frozen
  eight-command surface; the three reported relay codes and their exit-3 mapping; the `poll` result
  shape `{received, more, rejected[{envelopeId, code}]}` with poll exiting 0 while reporting
  rejections and the one deliberate exception; the bounded 16-page cursor walk; `claimable` on the
  publish response; the four conditions behind `PREKEY_BUNDLE_UNAVAILABLE`; the one-bundle
  first-contact limitation; and five new failure-behaviour rows.
- `docs/API-11_JSON_SCHEMAS.md` — poll request `cursor`; `next_cursor` corrected to a resume
  position with its two consequences; `size_bytes` measured, not trusted; a new section 12 for the
  v2 prekey routes carrying `claimable`; `PREKEY_BUNDLE_UNAVAILABLE` added to the error-code list;
  a table of the three codes the CLI reports under their own name with exit codes; and the
  byte-bounded residue corrected from 3 identities to 4.
- `docs/PROTOCOL-07_MVP_MESSAGE_FLOW.md` — the same poll `cursor` and `next_cursor` semantics; the
  `size_bytes == len(ciphertext)` rejection; the residue corrected to 4; and the error-code section
  extended with `UNAUTHORIZED_MAILBOX_ACCESS`, `PREKEY_BUNDLE_UNAVAILABLE` and
  `SENDER_QUOTA_EXCEEDED` plus the exit-code table.

This closes the documentation debt raised four times across the wave (R2-L-003, R2-I-005,
T45-I-002, T48-005, T53-I-004, the second half of T50-F-002, T34-I-003). Before this task,
`claimable` had **zero** matches under `docs/` while the CLI required it on every publish response.

**One stale comment, corrected at five sites, comment text only.** "`/v1/messages/send` has no
sender authentication" stood as the *rationale* for a security bound; T51 made that sentence false,
and a future reader would have trusted it. Corrected wording keeps the reason the bound is still
needed — a sender identity costs one unauthenticated `/v1/device-records/publish` (T52-F-001) — so
the justification is now true rather than merely reworded:

- `apps/relay/internal/validation/validate.go` (the `MaxIdentifierBytes` rationale);
- `apps/relay/internal/validation/mailbox_envelope_shape_test.go`;
- `apps/relay/internal/api/handler/mailbox_envelope_shape_test.go`;
- `apps/relay/internal/api/handler/mailbox_envelope_identifier_test.go`;
- `packages/crypto-core/src/mailbox/auth.envelope.test.ts`.

The last two Go sites were not on the dispatch's list of three but carry the identical false
sentence; leaving them would have defeated the point of the correction. No assertion, no test name,
no behaviour and no configuration was touched.

**Not changed by this task:** `apps/cli/vitest.config.ts`, `apps/cli/test/globalSetup.ts`,
`flow.json`, `acceptance-criteria.md`, any test assertion, and any production behaviour. No commit,
branch, PR or remote was created.

---

## 6. Loose ends for whoever closes the flow

- **T49 and T52 are still `todo` in `flow.json`** although their reports exist and their successors
  T50–T54 are `done`. Reconcile those task states rather than leaving them dangling
  ([`t56` §9](t56-final-dispositions.md)).
- The one-bundle-per-first-contact limitation and the flooding residue are now documented; if
  either is ever fixed, the standing regression `TestKnownResidueDistinctIdentitiesStillWedgeTheDrainWalk`
  and the limitation text in `specification.md`, `STATUS_CURRENT.md` and this report must move
  together.

---

## Routing audit

`graph_used`: no — not-relevant; every artifact and source path was given, and the source reads
were exact `file:line` checks rather than navigation.
`wiki_used`: no — not-relevant; this task edits `docs/` and flow artifacts, not wiki pages
(`keryx wiki check-links` was run to confirm the added internal links resolve).
`ctx_used`: yes — `keryx ctx rg` for every project search and `keryx ctx run` for command output.
`raw_rg_used`: no.
