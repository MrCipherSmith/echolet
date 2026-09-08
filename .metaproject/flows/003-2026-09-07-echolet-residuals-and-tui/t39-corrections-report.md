# T39 — Corrections to claims measurement has contradicted, and the unfinished prose migration

Flow 003, task T39. **Documentation only.** No source, test, or script file was changed; `package.json`
was not touched. Tree at start and end: HEAD `23a17aa`. Every correction below was verified against
the tree or against `t25-verification-report-r2.md` before being made; nothing was corrected on an
unverified premise.

---

## 1. R2-005 — the full-drain request cost was understated

**Claim:** a full-drain `relay publish` costs 20 requests, "17 % of the shipped 120/min budget."
**Measured (T25 round 2, §3.2):** **40 requests, 33 %**. The instrumented breakdown by pool state:
**20** requests for a first publish on an empty profile, **20** for a steady-state publish on a full
live pool, **21** with one dead slot, **40** for a full drain — cost is `N + k`, `k` the number of
dead slots re-minted (the design had counted only the mint-and-publish round, not the resubmit-all
round that precedes it).

Corrected in `.metaproject/flows/003-2026-09-07-echolet-residuals-and-tui/t26-replenishment-design.md`
at two sites: §2.2 ("Cost of N = 20") and §3 ("What N would have to be to matter"), both now stating
40 requests / 33 % with the full four-state breakdown and a pointer to the finding.

**Left uncorrected, for a test task** (editing a test file is out of scope here):
`apps/cli/test/e2e/prekey-pool-replenishment.test.ts:121-123` — a comment still says "at N = 20 one
`relay publish` is 20 requests."

## 2. R2-006 — the adversary was made to look weaker than it is

**Claim:** "Two source addresses drain a pool faster than its owner can refill it."
**Measured:** **one** source already suffices, at two to one. A raw claim destroys one pool member in
one request; restoring one costs two (a resubmit plus a fresh mint-and-publish). At the shipped 120
requests/minute per-host limit, one attacking source destroys **120 members a minute** against a
recovery ceiling of at most **60 members a minute** (and as little as ~5.7/minute if the attacker
drains one member at a time, since one dead slot still costs 21 requests to top up). The wording was
corrected, not softened: the sentence now states the sharper, worse-for-the-defender number.

Corrected at:
- `t26-replenishment-design.md` §8 ("The defender pays 30× per unit").
- `PAUSED.md` — the resume-state summary that quoted the same wrong claim, with a note recording the
  correction and date.

**Left uncorrected, for a test task:** `apps/cli/test/e2e/prekey-pool-replenishment.test.ts:34-35` —
a comment still says "Two source addresses drain a pool faster than its owner can refill it."

## 3. R2-002 — the eleven-site enumeration, finished

`t26-replenishment-design.md:525-540` (now shifted by earlier edits; content unchanged) enumerated
eleven sites asserting "a published bundle serves exactly one first-contact sender," false since the
pool shipped in `1ed5b2a`. Two were already corrected (`apps/cli/src/commands/cli.ts` near line 35,
and `apps/cli/src/runtime/outbound.ts` at two locations — both re-verified here as accurate,
pool-aware prose; no change needed). Nine were not. Re-derived on the current tree and corrected:

| # | Site (re-derived location) | Old claim | New claim |
|---|---|---|---|
| 1 | `docs/requirements/echolet-cli-prototype/specification.md:118` | "a published bundle serves exactly one first-contact sender... no command to allocate a fresh one-time prekey... republish reports `claimable: false`" | Pool of 20 (`LIMITS.PREKEY_MIN_COUNT`), `relay publish` tops up and restores availability; open residual (asymmetric attack/recovery cost, ~194-day id exhaustion) stated separately |
| 2 | `docs/requirements/echolet-cli-prototype/README.md:33` | "a second distinct sender receives `PREKEY_BUNDLE_UNAVAILABLE`; rotation exists... no CLI entry point" | Serves up to twenty senders; `relay publish` replenishes; open residual stated |
| 3 | `docs/requirements/echolet-cli-prototype/runbook.md:246-248` | same shape | same correction, runbook style |
| 4 | `docs/requirements/echolet-cli-prototype/deployment-runbook.md:1120-1121` | "Unchanged from the local prototype; see §11" | Updated pointer sentence to match the corrected runbook §11 |
| 5 | `docs/STATUS_CURRENT.md:98` (open limitation 2) | unstruck, unqualified | Struck through and marked "Закрыто (`1ed5b2a`, flow 003 T26)" with the pool description, plus the open residual (asymmetry, ~194-day exhaustion) in the same style as limitations 3/4 |
| 6 | `docs/PROTOCOL-07_MVP_MESSAGE_FLOW.md:919` | "он уже востребован (один опубликованный bundle обслуживает ровно одного первого отправителя)" | Rewritten to describe the pool and its replenishment |
| 7-9 | `apps/cli/src/runtime/outbound.publicationPrecondition.test.ts:24-25, :85, :216` | stale rationale prose in a test file | **Not edited — listed for a test task** (see §5) |

An unenumerated twelfth site surfaced while re-deriving locations: `docs/requirements/echolet-cli-prototype/prd.md:58`
— "prekey pool replenishment is a later capability" — added to `prd.md` in the same wave that shipped
the pool, so it was stale on arrival. Corrected to record the pool as shipped, with the same residual
noted.

A full repository re-scan for the trigger phrase (English and the Russian equivalent) after all edits
finds it only in: the four remaining test files (see §5), one unrelated false-positive
(`apps/relay/internal/config/config.go:16`, "serves exactly one scheme at a time" — a TLS/plaintext
comment, nothing to do with prekeys), and `apps/cli/src/runtime/outbound.ts:137`, which already reads
correctly ("Each published bundle serves exactly one first-contact sender, **and since T26** the
recipient's pool of them is finite...") — historical framing, not a stale claim.

## 4. R2-003 — the e2e figures, re-measured rather than computed

**Claim (`metrics-and-validation.md`, `docs/STATUS_CURRENT.md`, and two more sites found during
verification — `docs/requirements/echolet-cli-prototype/README.md:10` and `specification.md:21`, all
carrying the same figure):** `apps/cli/test/e2e/` is 6 files / 29 tests, a clean run is
6 files / 29 tests / all green / real wall-clock 4m52.6s.

**Re-measured, not computed.** `ls apps/cli/test/e2e` on `23a17aa` shows **7 files**
(`prekey-pool-replenishment.test.ts` was added by `1ed5b2a`/T26 after the "6/29" figure was written).
I ran `pnpm --filter @echolet/cli test:e2e` myself on this tree: **Test Files 3 failed | 4 passed (7)**,
**Tests 4 failed | 26 passed (30)** — confirming **30 tests** structurally regardless of pass/fail —
real wall-clock **774.46s**, exit 1. This run happened while two other flow-003 agents were actively
editing `apps/cli` concurrently (confirmed via `git status`), and its four failures were all
`E2E child timeout` or a 90s per-test timeout — the same load-sensitive failure mode
`t25-verification-report-r2.md` (finding R2-004) already documented (that report's own two runs: exit
143 with 11 failures under contention, and exit 0 / 30 passed / real 885.14s on an idle host).

**The figures now recorded:** structural count **7 files, 30 tests** (verified by both `ls` and my own
run's own totals, independent of pass/fail). Wall-clock for a **clean, idle** run: **885.14s**, the
authoritative idle figure from T25 round 2 — I did not obtain a second idle run myself, since the host
was contended for the entire measurement window; my own run instead reproduces and independently
corroborates the load-sensitive failure mode at 774.46s / exit 1. All figures are stated together with
which condition (idle-and-green vs. contended-and-red) they describe, per the instruction not to quote
a number without its condition.

Corrected in: `docs/requirements/echolet-cli-prototype/metrics-and-validation.md`,
`docs/STATUS_CURRENT.md`, `docs/requirements/echolet-cli-prototype/README.md`,
`docs/requirements/echolet-cli-prototype/specification.md`. The historical 3m30.0s/29-test/one-flake
figure is kept, explicitly marked as a pre-T26 historical measurement (six files), not deleted.

One adjacent, directly-verifiable correction made in passing: `metrics-and-validation.md` said "the
same **five** files are also reached by `pnpm test`" while there were six (now seven) e2e files.
`apps/cli/vitest.config.ts` declares no `include` override, so `vitest run` (the plain `test` script)
picks up every `*.test.ts` file in the workspace by default, including all seven e2e files — checked,
not assumed. Changed to "these same seven files."

## 5. Deferred to a test task (not edited here; documentation-only scope)

| File | Lines | What is stale |
|---|---|---|
| `apps/cli/src/runtime/outbound.publicationPrecondition.test.ts` | 24-25 | "Through the CLI a published bundle serves exactly one first-contact sender and there is no command to replenish it (specification.md)" |
| `apps/cli/src/runtime/outbound.publicationPrecondition.test.ts` | 85 | doc comment: "A recipient whose single published bundle serves exactly one first-contact sender." |
| `apps/cli/src/runtime/outbound.publicationPrecondition.test.ts` | 216 | "a third party the one first-contact bundle they have no CLI command to replace" |
| `apps/cli/test/e2e/prekey-pool-replenishment.test.ts` | 34-35 | "Two source addresses drain a pool faster than its owner can refill it" (R2-006's wrong figure) |
| `apps/cli/test/e2e/prekey-pool-replenishment.test.ts` | 121-123 | "at N = 20 one `relay publish` is 20 requests" (R2-005's wrong figure) |
| `apps/cli/test/e2e/publication-claimability.test.ts` | 14-18 | top-of-file rationale comment still asserts "A published bundle serves exactly one first-contact sender" in present tense with no mention that T26 made it a pool; **found during this task, not part of the original eleven-site enumeration** |

`apps/cli/src/runtime/profile.publicationPool.test.ts:13-14` and
`apps/cli/test/e2e/prekey-pool-replenishment.test.ts:168` were checked and are **not** stale: both use
explicit historical framing ("Today a recipient publishes ONE bundle... T26 measured the answer...",
and a failure-message string referring to "the denial this task is about") rather than a present-tense
claim about current behavior.

## 6. Recorded as an open limitation, not fixed here (R2-010)

The one-time-prekey identifier space (`maxOneTimePreKeyId = 0xffffff`, 16 777 215 ids) combined with
this design's deliberate absence of pool garbage collection means a **sustained single-source attack
at the pool's own recovery rate (~60 ids/minute) exhausts the space in roughly 194 days**, after which
`rotateOneTimePreKey()` — and therefore `relay publish` — fails permanently with "One-time prekey
identifiers are exhausted." `t26-replenishment-design.md` §2.2 quotes "~16 000 centuries" for a
different quantity (a benign weekly-refresh burn rate, not the sustained-attack rate) and was **not**
touched, per instruction — only the real, worse bound is recorded, as a new open item, in:
- `docs/STATUS_CURRENT.md` open limitation 2 (the primary, authoritative location).
- `docs/requirements/echolet-cli-prototype/specification.md`, `README.md`, `runbook.md`,
  `deployment-runbook.md`, and `prd.md` (each in the same edit that corrected the R2-002 site in that
  file, since the two facts belong together for a reader).

## 7. What the verification itself got right and wrong, as found here

- All five numeric claims (R2-002 through R2-006, R2-010) checked out exactly as
  `t25-verification-report-r2.md` stated; I found no arithmetic error in that report.
- The report's own reproduction commands were followed literally where practical (the `keryx ctx rg`
  pattern for R2-002, re-running `pnpm --filter @echolet/cli test:e2e` for R2-003/R2-004) and produced
  the same *kind* of result (structural counts matched exactly; the load-sensitive failure mode
  reproduced, though with 4 failures rather than R2-004's 11 — a different instance of the same
  documented flakiness, not a discrepancy in the finding).
- One thing worth flagging rather than silently correcting: R2-002's summary table describes the
  outbound.publicationPrecondition.test.ts row as a single stale site, but the file actually carries
  the false claim at three distinct locations (as the report's own line-number citation, "`:24, :85,
  :216`," already shows) — consistent, not an error, just noting the count came out at eleven sites
  total (2 edited + 6 doc files + 3 locations in one test file) rather than 2 + 9 file-rows.
- I found one additional stale site the enumeration did not name
  (`publication-claimability.test.ts:14-18`, §5) and one additional doc site carrying the same wrong
  e2e figure the enumeration did not name (`README.md:10` and `specification.md:21`, §4). Neither
  contradicts the report; both are things that had not been looked for yet.

## 8. Verification method

- Every prose claim was checked against the current tree with `keryx ctx rg` before being called
  stale, current, or already-corrected.
- The e2e file/test counts were checked twice independently: `ls apps/cli/test/e2e` (7 files) and a
  full `pnpm --filter @echolet/cli test:e2e` run's own vitest summary line (`Test Files ... (7)`,
  `Tests ... (30)`), which agree.
- `keryx wiki check-links` was run after all edits: 19 pages, 38 internal links, **0 broken**.
- No store key, private key, plaintext, or HTTP request body appears anywhere in this report or in any
  edited file. `geekom` and `depr` were not touched or contacted.
