# T25 (round 2) — Independent verification of flow 003

Flow 003, task T25, **second pass**. I wrote none of the code under test and accepted no report's
prose as evidence for its own claim. Every property below was re-established by reading the source,
by running the matrix myself, or by mutating the tree and watching what the suite did.

**Tree under test.** Commit **`1ed5b2a`**, the pushed head of `main`.

**Isolation.** Everything was measured in a dedicated detached worktree at
**`/tmp/echolet-verify-r2`** (`git worktree add /tmp/echolet-verify-r2 1ed5b2a --detach`), created
because two other agents were changing the main working tree concurrently. The worktree was removed
after the run. Nothing in the main working tree was modified; the two deliverables named by the
dispatch are the only files I wrote inside the repository.

**Machine.** macOS 26.5.0 (Darwin 25.5.0), arm64, 10 cores; `node` **v26.5.0** — the default
non-login interpreter, measured, not assumed; `pnpm` 10.0.0; `go1.26.1 darwin/arm64`; ripgrep at
`/opt/homebrew/bin/rg`. Every Go leg ran with `-count=1`, and none reported `(cached)`.

**Overall status: DONE_WITH_CONCERNS. The wave still must not close.**
The whole matrix is green with zero data races; every one of the three new mutation-killed tests
kills its mutation when I run it; the reservation property survives a direct concurrency attack; and
no test was weakened, skipped, narrowed or deleted. But **AC1, AC2 and AC3 are still not met**, AC10
is still partial, the push gate has a state in which it passes a commit it should stop, and the
`test:e2e` script the wave repointed failed on its first clean run in this worktree.

---

## 0. Repository integrity

A SHA-256 manifest of all **1010** tracked files was taken in the worktree before any work and again
at the end. The manifest digest is
`sha256:883e53234c95c1bfe7ef869d06c7c28269724d49976934c258b7ab45dfab76ec` **both times** — every
tracked file byte-identical, `git status --porcelain` empty. Every mutation in §4 was applied inside
that worktree, reverted immediately, and the file's own digest re-checked; all seven matched. No
mtime was used anywhere.

`geekom` and `depr` were not modified. `depr` was read once over HTTPS, read-only:
`GET https://depr.tail5a88fb.ts.net:8443/health` → **200**, `ssl_verify_result=0`,
`remote_ip=100.100.188.64`. No store key, private key, plaintext or HTTP request body appears
anywhere in this report.

**One side effect I caused and am declaring.** `pnpm install` in the worktree runs the root `prepare`
script, which is `scripts/hooks/install.sh`. That script resolves its target as
`git rev-parse --git-common-dir`, which from *any* worktree is the **main** repository's `.git`, and
it writes `git config core.hooksPath` into the shared config. It therefore rewrote
`/Users/Goodea/goodea/projects/echolet/.git/hooks/pre-push` (the tripwire block) while I was
installing dependencies in a throwaway worktree. It reported `core.hooksPath = .githooks` without a
"(was: …)" clause, so the config value was already correct and I did not change it, and it reported
`push gate verified`. No tracked file changed. Recorded as R2-012 because a `pnpm install` in a
worktree silently reaching into the parent repository's hooks is worth knowing about.

---

## 1. The matrix, re-run in full

| Leg | Command | Exit | Result | Wall |
|---|---|---|---|---|
| Typecheck | `pnpm -r typecheck` | **0** | 7 workspace projects clean | 8 s |
| JS suite | `pnpm -r test` | **0** | **66 files, 338 tests, 338 passed / 0 failed / 0 skipped** | 305 s |
| e2e script (run 1) | `pnpm --filter @echolet/cli test:e2e` | **143** | **11 of 30 tests failed** across 3 files, all `E2E child timeout` | 403 s |
| e2e script (run 2, idle host) | `pnpm --filter @echolet/cli test:e2e` | **0** | **7 files, 30 tests, 30 passed** | **885 s** |
| Go | `go test -count=1 ./...` | **0** | 11 packages `ok`, 7 with no test files | 65 s |
| Go race | `go test -count=1 -race ./...` | **0** | same, **0 data races** | 28 s |
| Go race + relayv2 | `go test -count=1 -race -tags relayv2 ./...` | **0** | same, **0 data races** | 29 s |
| Go verbose | `go test -count=1 -v ./...` | **0** | `=== RUN` **175** · `--- PASS` **175** · `--- FAIL` **0** · `--- SKIP` **0** | 28 s |

JS breakdown: `apps/cli` **52 files / 273 tests**, `packages/protocol` 3/12, `crypto-core` 4/20,
`session-node` 3/24, `client-core` 2/2, `client-db` 1/1, `apps/mobile` 1/6.
TUI subset: **16 files / 113 tests** (was 15/108 — `tui-shell.trustViewport.test.ts` adds 5).

`WARNING: DATA RACE` occurrences across the three Go logs: **0, 0, 0.** `^FAIL`: **0, 0, 0.**
No Go leg printed `(cached)`; every figure is from `-count=1`.
No `.skip`, `.only`, `it.todo`, `xit` or `t.Skip` exists anywhere under `apps/` or `packages/`.

**Which figures came from a loaded machine, stated plainly.** The JS suite and every Go leg ran
alone; I did nothing but read files while they ran. The **first** e2e run did not: it started
immediately after the 305 s JS suite, and for part of it I was running a poll loop that burned one
core — my own mistake, recorded rather than hidden. Its first failures (`two-process` runs 2 and 3)
were already recorded in the log **before** that loop started, so the contention was not solely
mine. The second e2e run is the clean figure: machine otherwise idle, exit 0, 885 s.

---

## 2. Verdict on each acceptance criterion

| AC | Verdict | Change since round 1 |
|---|---|---|
| AC1 | **NOT MET** | unchanged |
| AC2 | **NOT MET** | round-1 items closed; a **new and larger** set opened by the pool |
| AC3 | **PARTIAL** | first clause now MET; second clause broken again |
| AC4 | **MET** | was NOT MET |
| AC5 | **MET** | unchanged |
| AC6 | **MET** | unchanged |
| AC7 | **MET** | unchanged |
| AC8 | **MET** (V-009 edge carried) | unchanged |
| AC9 | **MET**, and now genuinely pinned | V-001 closed |
| AC10 | **PARTIAL** | V-005 unchanged; nothing weakened, re-verified |

### AC1 — every inventory item dispositioned by evidence — **NOT MET**

There is still **no post-wave disposition table** over T1's 62 items. `keryx ctx rg -i disposition`
across the flow directory and `docs/` returns only T1's own pre-wave verdicts, `flow.json`'s
per-task `dispositionReason` fields, and round 1's finding V-008 restating the gap.

`flow.json` is worse than at round 1: **16 of 37 tasks are `todo`** — exactly
`T1, T2, T3, T4, T15, T16, T20, T22, T24, T25, T26, T27, T32, T33, T34, T35` — including tasks whose
**artifacts and code are on disk and committed**: T24 (`scripts/gate/go-tests.sh`), T26 (`t26-replenishment-design.md`), T27 (four test
files), T32 (`scripts/gate/docs-freshness.sh`), T34 (`t34-second-user-report.md`), and T20 (landed
in `e949aae` at round 1 and still `todo`). The flow's own bookkeeping cannot distinguish "not
reached" from "done and not recorded", which is precisely the failure mode AC1 exists to prevent.
(R2-007)

Two FIX NOW residuals re-verified as still open with no wave-level record: `gofmt -l apps/relay`
still lists `internal/api/handler/mailbox_read_mark_test.go`,
`internal/api/handler/signal_prekey_bundle_v2.go` and
`internal/storage/repository/signal_prekey_bundle_v2.go`; and `apps/relay/relay` is still an
18,094,306-byte untracked binary in the main tree. (R2-011, carrying V-012.)

### AC2 — no document states something the tree contradicts — **NOT MET**

**The round-1 items are genuinely closed, and I checked each rather than accepting T28's report.**
`STATUS_CURRENT.md` limitations 3 and 4 are struck through and named to `5235a6d` / `18afa36`; the
ticker clause is corrected in `STATUS_CURRENT.md` §10 and `README.md:37`; all three documents now say
the certificate-renewal timer **is** installed on both hosts. `ECHOLET_CLEANUP_INTERVAL_SECONDS` is
gone from all six operator-facing files, and `OPS-23_LOCAL_ENV_VARS.md` states the residual honestly
("Поле `CleanupIntervalSec` … по-прежнему объявлено с `envDefault:\"60\"`… Удаление самого поля из
Go-кода — изменение продукта и требует отдельной задачи с тестами").

**And then the pool landed and reopened the criterion, on the design's own enumerated list.**
`t26-replenishment-design.md:525-540` enumerates — "enumerated, not sampled" — the **eleven** sites
that state "a published bundle serves exactly one first-contact sender", and says: "Every one of them
becomes false and must be edited in the same change, or the tree carries a statement the code
contradicts." `PAUSED.md:26` repeats the warning to whoever implements it.

Re-running that enumeration myself on `1ed5b2a`
(`keryx ctx rg "exactly one first-contact sender|serves exactly one|one first-contact|ровно одного
первого отправителя" .`), **two of the eleven were edited and nine were not**:

| site | state at `1ed5b2a` |
|---|---|
| `apps/cli/src/commands/cli.ts:35` | **edited** — now "each bundle serves exactly one first-contact sender, so an exhausted recipient is one whose whole pool is gone" |
| `apps/cli/src/runtime/outbound.ts:65` | **edited** — rationale rewritten for a finite pool |
| `docs/requirements/echolet-cli-prototype/specification.md:118` | **stale** — "**Limitation, structural for this prototype:** … the CLI has no command to allocate a fresh one-time prekey … A re-run of `relay publish` reports `claimable: false` rather than restoring availability." All three clauses are now false. |
| `docs/requirements/echolet-cli-prototype/README.md:33` | **stale** — "a second distinct sender receives `PREKEY_BUNDLE_UNAVAILABLE`; rotation exists in the runtime but has no CLI entry point" |
| `docs/requirements/echolet-cli-prototype/runbook.md:246-248` | **stale** — "a republish reports `claimable: false`" |
| `docs/requirements/echolet-cli-prototype/deployment-runbook.md:1118` | **stale** |
| `docs/STATUS_CURRENT.md:98` | **stale** — limitation 2, unstruck, unqualified |
| `docs/PROTOCOL-07_MVP_MESSAGE_FLOW.md:919` | **stale** |
| `apps/cli/src/runtime/outbound.publicationPrecondition.test.ts:24, :85, :216` | **stale rationale prose** — ":216 … the one first-contact bundle they have no CLI command to replace". The assertions are correct; only the reasoning is now false. |

`docs/requirements/echolet-cli-prototype/prd.md:58` adds a twelfth: "prekey pool replenishment is a
later capability." It landed in this wave.

Nothing in `1ed5b2a` touched `docs/` at all, and the operator-visible result shape changed in the
same commit (`relay publish --json` now returns `pool: {target, claimable, minted}`), which no
document describes. This is round 1's V-003 recurring for the third time in one wave. (R2-002)

`docs/STATUS_CURRENT.md` also still pins itself to **`4346e2b`**, now **13 commits** behind HEAD; the
T28 note inside it pins its corrections to `c5fde09`, four commits behind. The freshness gate
therefore prints STALE DOCUMENTATION on every push and, by design, blocks nothing. (R2-008)

### AC3 — `test:e2e` runs every e2e file, and every quoted figure is corrected — **PARTIAL**

*First clause — MET.* `apps/cli/package.json` now declares `"test:e2e": "vitest run test/e2e"`. Run
alone on an idle host it is **exit 0, 7 files, 30 tests, 30 passed, 885.14 s**. Repointed, not
renamed, as the wave decided.

*Second clause — NOT MET, again.* Both documents that quote the figure quote the **wrong** one:

- `docs/requirements/echolet-cli-prototype/metrics-and-validation.md:20,24` — "`apps/cli/test/e2e/`
  holds **six files and 29 tests**" and "a clean run of **6 files, 29 tests, all passed**, real
  wall-clock **4m52.6s**".
- `docs/STATUS_CURRENT.md:53` — "**6 файлов, 29 тестов, все зелёные**".

The tree holds **seven** files and **thirty** tests: `d49ec6c` added
`test/e2e/prekey-pool-replenishment.test.ts` two commits after the reconciliation that wrote those
sentences. The wall-clock figure is out by 3× on my host (885 s), because the seventh file both costs
538 s of its own under the script's parallelism and slows every sibling. (R2-003)

*And the script is not reliably green.* Its **first** run in this worktree exited **143** with
**eleven** failures across `two-process` (2), `publication-claimability` (1) and `flood-closure` (8),
every one an `E2E child timeout` — the suites' own 30 s per-child bound, not vitest's. The same files
had all passed minutes earlier inside `pnpm -r test`. `apps/cli/vitest.config.ts` sets no pool limit,
so `vitest run test/e2e` starts all seven process-spawning e2e files at once; the full `test` script
interleaves them with 45 cheap files instead. `metrics-and-validation.md` already records "one
transient failure … recorded as observed flakiness"; the honest figure is that a whole-directory
`test:e2e` failed 11 tests on one of my two runs. A gate step or a release check that runs this
script will be red for reasons that are not the code. (R2-004)

### AC4 — configuration that binds nothing is made to bind or removed — **MET**

*First half, now met.* `ECHOLET_CLEANUP_INTERVAL_SECONDS` is absent from `deploy/relay/docker-compose.yml`,
`docker-compose.insecure-loopback.yml`, `run-relay.sh` and all three `deploy/relay/env/*.example`
files. `keryx ctx rg` over the whole tree finds it in exactly three places: `config.go:58` (the Go
field), `docs/OPS-23_LOCAL_ENV_VARS.md` (documenting the removal), and one test comment. The
surviving Go field is recorded with the reason it is not being removed and the statement that doing
so needs its own task with tests — which is the shape AC1 asks for and I am not double-counting it as
a failure. (R2-013, info.)

*Second half, still met and now better pinned.* `CleanupService.Stop()`'s **join** — not merely its
signal — is now pinned by `TestCleanupServiceStopWaitsForItsGoroutineInsteadOfOnlySignallingIt`,
which I killed and un-killed myself (§4, MU-3).

### AC5, AC6, AC7 — **MET**, unchanged

Re-confirmed green in the full matrix; no file behind them changed in this range.
`internal/api/handler`, `internal/storage/repository`, `internal/config`, `tui-shell.singleFlight`,
`main.processDriven`, `shell-chrome.overflow`, `shell-chrome.recency` all pass.

### AC8 — **MET**, with the carried edge

`shell-chrome.legend` 3/3 and `tui-shell.smallViewport` 1/1 green. Round 1's V-009 is unchanged: no
test covers a viewport smaller than 40×10, and the unaudited-prototype notice is truncated at 10×3
and below. The new `tui-shell.trustViewport.test.ts` now drives 40×10, 71×16 and 72×15, which
narrows but does not close it.

### AC9 — flow 002's properties re-verified, **and the last unguarded one now guarded** — **MET**

- `renderFrame` pure/total/deterministic/escape-free/rows×cols: `shell-chrome.test.ts` 12/12.
- No key material in any frame or child argv: `tui.keyMaterial.test.ts` 9/9.
- The notice on every frame: green, with the V-009 edge.
- **The trust modal cannot confirm what was never painted — now enforced, not merely true.** Round 1
  measured that deleting `&& !isBelowMinViewport(painted)` from `tui-shell.ts:343` left 108 tests
  green. I re-ran that exact mutation on this tree: **3 tests fail** (§4, MU-1), one per axis of the
  disjunction. The new suite drives the real `runTuiShell` through `onTrustIdentifiers`, asserts the
  frames at sub-minimum viewports carry **none** of the four identifiers, asserts the refusal is not
  deafness (ESC still answers `false`), and asserts acceptance at 72×16 and 96×28 with all four
  identifiers present — so a shell that simply never stamped `renderedAt` fails too. V-001 is closed.
- Full matrix green with zero data races: §1.

### AC10 — nothing weakened, and the ordering provable from git — **PARTIAL**

*Nothing weakened, skipped, narrowed or deleted — checked directly.* `git diff --numstat
c5fde09..1ed5b2a` over `*_test.go` and `*.test.ts` shows 14 files, of which 8 are new. I read every
removed line in the six edited files. Every change is a count made **exact and derived** from
`LIMITS.PREKEY_MIN_COUNT` (`toEqual`/`toHaveLength` throughout; nothing relaxed to `toContain` or to
a range), plus two genuine index corrections and one re-baselining. No assertion was dropped: in
`outbound.test.ts:184` the "no `/v1/messages/send`" property is preserved verbatim; in
`inbound.test.ts:318` the snapshot baseline moved from before `publish()` to after it, which is
correct — the property under test is the atomicity of `send()`'s own transaction, and the old
baseline only worked by accident of pool size 1.

*The three corrections, each re-derived rather than accepted.*

1. **The off-by-one** (`publication-claimability.test.ts:270`, `PREKEY_MIN_COUNT - 2` → `- 1`). I
   derived the timeline independently from the file: bob publishes 20 → alice's send consumes 1 (19)
   → step 6's `relay publish` mints exactly 1 replacement and the file asserts `pool.claimable === 20`
   → carol's send consumes 1 (19) → the raw-claim drain must therefore return **19 = N−1**. The
   rejected reading (N−2 = 18) is only consistent with a tree where step 6's top-up did not happen,
   and would contradict step 6's own assertion in the same file. **Correct, and correctly sided:**
   changing step 6 instead would have left the file self-consistent and wrong.
2. `two-process.test.ts:168`, literal `2` → `2 * LIMITS.PREKEY_MIN_COUNT`. Two fresh profiles × one
   pool publish each = 40; measured (§4, MU-P) that a first publish is exactly 20 requests.
3. `inbound.test.ts` baseline, above.

*The recorded digests, verified.* The commit message for `d49ec6c` states that for these three the
ordering claim "rests on the recorded digests rather than on commit order". I hashed all fifteen
files the T27/T30/T36/T37 results record and **every one matches the committed tree byte-for-byte** —
`cli.test.ts` `478b69a4…`, `outbound.test.ts` `25a219e5…`, `outbound.publish.test.ts` `84bbb5a7…`,
`publication-claimability.test.ts` `05511724…`, `two-process.test.ts` `36e0f135…`,
`inbound.test.ts` `00218673…`, `tui-shell.ts` `185e8a9f…`, `limits.ts` `3e2cdb25…`, `limits.go`
`0225c19e…`, `cleanup_service.go` `3b4f42ce…`, `tui-shell.trustViewport.test.ts` `e5cfb692…`,
`relayClient.protocolMirror.test.ts` `df404e73…`, `limits_mirror_test.go` `71019ebe…`,
`cleanup_service_stop_join_test.go` `5431caf1…`, and the untouched reservation guard
`prekey_bundle_v2_test.go` `44e4c27d…`. The chain is internally consistent and the guard file is
provably unedited.

*The ordering that IS provable.* `d49ec6c` (tests) → `1ed5b2a` (fix), and **`1ed5b2a` touches no test
file at all** — 4 product files plus flow artifacts. That is real discipline.

*Why it is still PARTIAL.* Round 1's **V-005 is unchanged**: `5235a6d` still carries product code and
two test-file changes in one commit, both importing a package that same commit creates, so red-first
for those two remains unprovable from history. Nothing in this range addressed it.

---

## 3. The three things the dispatch told me to dig hardest at

### 3.1 The reservation property, attacked rather than read

**Verdict: it holds, including under concurrency, and the new pin is not vacuous.**

*Reading first, to know where to hit.* `SaveSignalV2`
(`storage/repository/signal_prekey_bundle_v2.go:37`) reserves two permanent indexes on first store —
`v2:otk:tuple:<sha256>` and `v2:otk:public:<sha256>` — and refuses `ErrV2PreKeyReused` on either
collision, so a fresh `bundle_id` around an already-published prekey cannot re-enter. The idempotent
branch re-stores identical bytes, answers `claimable = !stored.Claimed`, and **never re-adds the
availability index**. `ClaimSignalV2` iterates `v2:available:<identity>:<created_at_ms>:<bundle_id>`
in ascending key order, skips anything `Claimed` or out of window, and in one Badger transaction sets
`Claimed`, deletes the availability key and writes the claim record.

*The attack.* The wave's own `prekey_pool_test.go` drives the claim route **sequentially**, which
cannot see the hazard the property is about. I wrote my own test
(`TestVerifierPoolNeverServesOnePreKeyToTwoConcurrentClaimants`, added to the worktree and removed
afterwards): 20 published members, **80 goroutines released from a single barrier**, each with its
own `claim_id`.

```
statuses=map[200:20 404:60]  served=20  distinct_bundles=20  distinct_prekeys=20
```

Exactly 20 served, 20 distinct `bundle_id`s, 20 distinct one-time prekey public keys, 60 refused
404. **`-count=5 -race`: 5/5 pass, 0 data races.** No prekey was ever handed to two claimants.

*Non-vacuity of the wave's own pin.* `TestSignalV2PoolNeverReOffersAConsumedMember` is a green
regression pin, declared as such in advance by T26 §6 group D — which means nobody had shown it could
fail. I showed it: mutation **MU-4** makes `SaveSignalV2`'s idempotent branch re-add the availability
index (the single most plausible decay, since a top-up runs that path 20 times per invocation), and
the test **FAILS**. The pin is real.

*The client half.* Mutation **MU-5** makes `mintPublicationSlot` never rotate, so all 20 pool members
would share one one-time prekey — two tests go red. `SignalClient.rotateOneTimePreKey()`
(`SignalClient.ts:266`) takes `max(current, all allocated) + 1`, is strictly increasing, generates a
fresh private key, and **retains** every previous `pre:` record, so an in-flight first contact against
a replaced member still decrypts.

### 3.2 The pool's stated cost — measured, not read

**Verdict: the headline number is honest. Two subsidiary claims around it are wrong, one of them in
the defender's favour.**

*The headline, 120 → 6 victims/minute, is honest.* `middleware/rate_limit.go` applies a per-**host**
quota of `cfg.RateLimitPerMinute` (default and shipped: **120**, `config.go:57`,
`geekom.env.example:62`) as a global `r.Use` in `router.go:47`, so it covers `/v2/prekeys/claim`. The
quota key is the peer host with the TCP port stripped and IPs canonicalised, so it is not trivially
refreshed per connection. One claim consumes one member (measured above), a pool is 20 members, so
one source goes from 120 destroyed victims a minute to 6. **20×, and stated everywhere as a price
increase and a recovery path rather than a closure.** That framing is accurate and repeatedly stated
against interest.

*What the accounting leaves out, measured.* I instrumented the real `publish()` loop against the
suite's own fake relay (probe appended to `outbound.publicationPool.test.ts`, run, then reverted with
the digest re-checked — `d7a8db80…` before and after):

```
first publish on an empty profile      = 20 requests
steady state, full live pool           = 20 requests
one dead slot                          = 21 requests
FULL-DRAIN top-up                      = 40 requests   (minted = 20)
```

The cost is **N + k**, where k is the number of dead slots — so **2N = 40** at full drain, not 20.
`t26-replenishment-design.md:157` states "A full-drain `relay publish`: … and **20 requests** — 17 %
of the shipped 120/min budget", and §2.3 says six publishes a minute hit the limiter. The correct
figures are **40 requests, 33 %, and three**. `t31-implementation-report.md` §4.5 already catches
this and states it correctly; the **design was never corrected**, and
`test/e2e/prekey-pool-replenishment.test.ts:121-123` still tells the next reader "at N = 20 one
`relay publish` is 20 requests". (R2-005)

*The claim that runs the wrong way.* `t26` (via `PAUSED.md:20`) and
`prekey-pool-replenishment.test.ts:35` both say **"Two source addresses drain a pool faster than its
owner can refill it."** With the measured 2 requests per restored member and 1 request per destroyed
member, under the same shipped 120/min per-host budget:

- one attacking source destroys **120 members/minute**;
- one recovering victim restores at most **60 members/minute** (and as few as ~5.7/minute if drained
  one member at a time, since a single dead slot still costs 21 requests).

**One source address already out-drains the owner by at least 2:1.** The "two addresses" sentence
overstates the defence by a factor of two, and it sits in the file whose whole job is to state the
honest cost. (R2-006)

*One more figure that is benign-case only.* `t26` §2.2 says the one-time prekey id space
(`maxOneTimePreKeyId = 0xffffff`) "lasts ~16 000 centuries" at 20 ids per week. Under the attack the
pool exists to price, the burn rate is the recovery rate: 60 ids/minute sustained from one source
exhausts 16 777 215 ids in **~194 days**, after which `rotateOneTimePreKey()` throws "One-time prekey
identifiers are exhausted" and the recovery path fails permanently — and the design explicitly
forbids any pool GC, so the `pre:` records accumulate too. Slow, bounded, and not stated. (R2-010,
info.)

**Summary answer to the question asked:** the stated cost is **honest on the number it states**
(120 → 6) and **understated on what recovery costs** — the request budget of a full recovery is
double what the design says, and one attacking source, not two, out-paces a recovering victim.

### 3.3 The three mutation-killed tests, re-mutated by me

Every one kills its mutation. Full results in §4.

- **V-001 / `tui-shell.trustViewport.test.ts`** — MU-1 kills 3 of its 5 tests, one per axis, exactly
  as the file claims a single-axis narrowing would be caught.
- **V-006 / `relayClient.protocolMirror.test.ts` + `limits_mirror_test.go`** — MU-2 (lower the
  TypeScript constant) fails the TS mirror test **and** the Go mirror test; MU-2b (lower the Go
  constant) fails the Go mirror test with the mirrored diagnosis. Both directions are now caught from
  either suite.
  **Correction to round 1, against my predecessor.** Round 1's V-006 said lowering
  `MAX_MESSAGE_BYTES` to 131072 left "21 files / 83 tests green" in `apps/cli`. It does not:
  `relayClient.pollCapacity.test.ts` fails **two** tests under that mutation, because it hard-codes
  `responseByteBound = 1024 * 1024` and `maxMessageBytes = 262144` at lines 20-22. My measurement:
  `2 failed | 22 passed (24) files`, `3 failed | 91 passed (94) tests`. The TypeScript direction was
  already guarded, incidentally, by a third hand-written copy of the number. The **Go** direction was
  genuinely unguarded and is what `limits_mirror_test.go` now closes. T27 reported this discrepancy
  itself rather than quietly benefiting from it, which I am recording in its favour. (R2-009)
- **V-007 / `cleanup_service_stop_join_test.go`** — MU-3 fails it with
  "Stop() returned while the goroutine Start() launched was STILL executing runCleanup", while
  `internal/server` stays `ok` — i.e. it detects exactly what nothing else could.

### 3.4 The gate — I found a state where it passes something it should stop

**The 27 rows of `scripts/gate/selftest.sh` are real.** I counted them (G1-G5, D1-D7, J1/J1b/J1c/J1d,
J2-J5, S1, V1-V6 = 27) and read each. G3 injects a genuine data race to prove `-race` is actually on;
J3 blocks when nothing can run the suite where the stock keryx hook exited 0 "skipped"; S1 blocks a
deleted gate step; V2-V4 unset `core.hooksPath` and prove the tripwire both announces and still runs
the tracked gate. I also probed the claim the whole redesign rests on, in a scratch repo with a red
test script: **`keryx test run --strict` at project scope resolves the runner and exits 1**
(`scope: project, runner: npm-script, command: npm run test --, failed: 1`) — it does not pass
vacuously. And I verified the `-tags relayv2` superset claim: `keryx ctx rg "go:build|\+build"` over
`apps/relay` returns exactly one constraint, `//go:build relayv2`, so nothing is excluded by the tag.

**But the gate verifies the working tree, not the commits being pushed.** The hook's own header says
reading git's stdin "lets the gate ask about the commits actually being pushed rather than about the
working tree — which is the mistake that made the old gate pass vacuously". Only steps 1 (security
scan) and 4 (docs pin) use the pushed range. Steps 2 and 3 — the two **blocking** steps — run
`go test ./...` and `keryx test run --strict` against whatever is on disk.

I built the state and ran it (`/tmp/echolet-r2-gate-probe.sh`, the same scratch-repo construction
`selftest.sh` uses):

```
committed suite.sh at the pushed sha:   echo "SUITE RAN: red";   exit 1
working-tree suite.sh:                  echo "SUITE RAN: green"; exit 0
---- gate exit: 0
push gate (js): running fallback test gate: npm run test
SUITE RAN: green
```

**The gate allowed a push whose committed suite is red.** This is not weaker than what it replaced —
keryx's `--changed` was working-tree-scoped too — so the "strictly no weaker" claim survives. What
does not survive is the header's range-awareness claim and the completeness of the 27-row table: all
27 rows are constructed with the working tree equal to `HEAD`, so this state cannot appear in them by
construction. Real scenarios that hit it: commit, notice the break, fix locally without committing,
push; or push an older branch while the working tree carries newer code. (R2-001)

---

## 4. Every mutation I ran (all inside the worktree; all reverted; digests re-verified)

| # | Mutation | Result |
|---|---|---|
| MU-1 | `tui-shell.ts:343`: drop `&& !isBelowMinViewport(painted)` | **killed** — `trustViewport` 3 failed / 110 passed (113) |
| MU-2 | `LIMITS.MAX_MESSAGE_BYTES` → 131072 | **killed** — TS: `protocolMirror` ×1 + `pollCapacity` ×2 (3 failed / 91 passed); Go: `TestMaxMessageBytesMirrorsTheTypeScriptProtocolConstant` FAIL |
| MU-2b | `protocol.MaxMessageBytes` → 131072 | **killed** — Go mirror test FAIL with the mirrored diagnosis |
| MU-3 | `CleanupService.Stop`: `<-stopped` → `_ = stopped` | **killed** — `…StopWaitsForItsGoroutineInsteadOfOnlySignallingIt` FAIL; `internal/server` still `ok` |
| MU-4 | `SaveSignalV2` idempotent branch re-adds the availability index | **killed** — `TestSignalV2PoolNeverReOffersAConsumedMember` FAIL |
| MU-5 | `mintPublicationSlot` never rotates (all members share one prekey) | **killed** — `profile.publicationPool` ×1 + `outbound.publicationPool` ×1 |
| MU-6 | `publish()` stops re-submitting stored members | **killed** — all 5 `outbound.publicationPool` tests |
| MU-P | probe: instrument `publish()` and print request counts | measurement only — 20 / 20 / 21 / **40** |
| ATT-1 | 80 concurrent claims against a 20-member pool (my own test) | **property holds** — 20 served, 20 distinct prekeys, 5/5 runs, 0 races |
| GP-1 | push gate against a red commit with a green working tree | **gate exit 0** — R2-001 |

Reverted digests, all matching: `tui-shell.ts` `185e8a9f…`, `limits.ts` `3e2cdb25…`, `limits.go`
`0225c19e…`, `cleanup_service.go` `3b4f42ce…`, `signal_prekey_bundle_v2.go` `48f02d2d…`,
`profile.ts` `cb73092d…`, `outbound.ts` `edc21b8a…`, `outbound.publicationPool.test.ts` `d7a8db80…`.
Whole-tree manifest identical before and after: `883e5323…`.

---

## 5. Findings

| id | severity | one-line reproduction |
|---|---|---|
| **R2-001** | major | `sh /tmp/echolet-r2-gate-probe.sh` (scratch repo, red committed suite, green uncommitted working tree) → the pre-push gate exits **0**. |
| **R2-002** | major | `keryx ctx rg "exactly one first-contact sender\|serves exactly one\|one first-contact\|ровно одного первого отправителя" .` — 9 of the 11 sites `t26-replenishment-design.md:525-540` enumerated as "must be edited in the same change" are unedited at `1ed5b2a`. |
| **R2-003** | major | `ls apps/cli/test/e2e` → 7 files / 30 tests, while `metrics-and-validation.md:20,24` and `STATUS_CURRENT.md:53` both say "6 files, 29 tests" and "4m52.6s". |
| **R2-004** | major | `pnpm --filter @echolet/cli test:e2e` — exit **143**, 11 tests failed on `E2E child timeout` (run 1); exit 0 in 885 s on an idle host (run 2). `vitest.config.ts` sets no pool limit, so all 7 process-spawning e2e files start at once. |
| **R2-005** | minor | `t26-replenishment-design.md:157` says a full-drain `relay publish` is "20 requests — 17 %"; measured **40 requests / 33 %** (§3.2). `prekey-pool-replenishment.test.ts:121-123` repeats the wrong figure. |
| **R2-006** | minor | `prekey-pool-replenishment.test.ts:35` and `PAUSED.md:20`: "Two source addresses drain a pool faster than its owner can refill it." At 120 req/min per host, one source destroys 120 members/min while the owner restores ≤60/min — **one** source suffices. |
| **R2-007** | minor | `flow.json` — 16 of 37 tasks are `todo`, among them T20, T24, T26, T27, T32 and T34, all of which have committed artifacts or code; still no post-wave disposition table over T1's 62 items. |
| **R2-008** | minor | `docs/STATUS_CURRENT.md:9` still pins `4346e2b`, 13 commits behind HEAD; `scripts/gate/docs-freshness.sh` therefore warns on every push and blocks nothing. |
| **R2-009** | info | Round 1's V-006 reproduction is wrong: `MAX_MESSAGE_BYTES: 131072` fails `relayClient.pollCapacity.test.ts` ×2 as well as the new mirror test (`3 failed / 91 passed`), because that file hard-codes 262144 at line 22. The Go direction was the genuinely unguarded one. |
| **R2-010** | info | `SignalClient.ts:60` `maxOneTimePreKeyId = 0xffffff` with no pool GC: at the sustained recovery rate the pool exists to enable (~60 ids/min), the id space exhausts in ~194 days of single-source attack and `rotateOneTimePreKey()` then throws permanently. `t26` §2.2 quotes the benign-case "~16 000 centuries". |
| **R2-011** | info | `gofmt -l apps/relay` still lists three files; `apps/relay/relay` is still an 18,094,306-byte untracked binary. Round 1's V-009, V-010, V-011 and V-005 are all unchanged. |
| **R2-012** | info | `pnpm install` inside **any** git worktree runs `scripts/hooks/install.sh`, which resolves `git rev-parse --git-common-dir` and therefore rewrites the **main** repository's `.git/hooks/pre-push` and writes `core.hooksPath` into the shared config. Observed here. |
| **R2-013** | info | `apps/relay/internal/config/config.go:58` still reads `ECHOLET_CLEANUP_INTERVAL_SECONDS` (`envDefault:"60"`) for a service with an empty body — recorded honestly in `OPS-23_LOCAL_ENV_VARS.md` and not counted against AC4. |

**Closed since round 1:** V-001 (MU-1), V-002 (AC4 first half), V-004 (AC3 first clause),
V-007 (MU-3), V-013 (the gate is tracked, and `pnpm run hooks:verify` reports it live). V-003 is
closed on its four round-1 items and reopened on a larger set (R2-002). V-006 is closed in the
direction that was genuinely open, and its round-1 reproduction is corrected (R2-009).
V-005, V-008, V-009, V-010, V-011, V-012 are unchanged.

---

## 6. What I did not verify, and why

- **Host state on `geekom` and `depr`.** One read-only HTTPS `GET /health` against `depr` (§0). I did
  not SSH to either host, so the `systemd` timers and `geekom`'s certificate configuration are
  documentary claims here, not verified ones.
- **The gate as actually installed for a real `git push`.** I exercised it through the tracked
  `.githooks/pre-push` in scratch repositories, never by pushing.
- **The 30.6× per-bundle CPU asymmetry** (61.6 ms vs 2.0 ms). I re-derived the *request*-budget
  arithmetic, which is where the errors were; the millisecond figures are T26's and I did not re-time
  them.

---

## 7. Routing audit

- `graph_used`: **no** — *not relevant*. Every target was named by an acceptance criterion, a report
  `file:line`, or a commit; the work was running and mutating those exact files, not discovering them.
- `wiki_used`: **no** — *not relevant*. The authoritative sources for a verification pass against
  frozen criteria are the criteria, the commits and the code, all read directly.
- `ctx_used`: **yes** — `keryx ctx rg` for every search over project code, `keryx ctx run` for git,
  `keryx ctx read` for schemas. Raw logs under `.metaproject/data/gdctx/`.
- `raw_rg_used`: **yes**, with a `# keryx:raw` reason at each use, and **never as a search over
  project code**: exact vitest and `go test` summary lines, `shasum` manifests, per-commit
  `--numstat`, tool version strings, and `grep` over my own logs under `/tmp/echolet-r2-logs`. Each
  needed verbatim output that a compacted summary elides, because those counts *are* the evidence.
