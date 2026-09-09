# T17 — Contention report: the reported failures were never in `test/e2e/`, and the e2e per-child watchdog was inherited rather than measured

Date: 2026-09-08/09. Base: `origin/main` at `860005b`. Scope: test files and test
configuration only. **No file under `apps/*/src` (product code, excluding
`*.test.ts`) or `packages/` was read for editing or changed.** No assertion was
weakened, narrowed, skipped or deleted; every change either raises a ceiling or
moves a literal onto a measured constant.

Follow-up to T16's finding `003-T16-tests#F-001`. It overlaps T40, which had
already extended T16's constants to this directory — see §0.

---

## 0. Read this first: what this report corrects, including about itself

This task was dispatched to find out which E2E test produced 2 failures and five
`[vitest-worker]: Timeout calling "onTaskUpdate"` errors, and to fix the e2e
timeouts without blindly reusing T16's numbers. Three of its starting premises
turned out to be wrong, two of them the task's and one of them mine.

**1. The reported failures are not in `test/e2e/`, and they are not failures.**
They are `apps/cli/src/runtime/inbound.test.ts` and
`inbound.batchIsolation.test.ts`, whose results never arrived because their vitest
worker was torn down. Zero assertions failed anywhere in the reproduction. §1.

**2. The e2e timeout work had already been done upstream, by T40 — but with an
inherited number.** While this investigation ran on a stale base, `origin/main`
already had all seven suites importing shared constants. T40 measured e2e
*whole-test* durations honestly (hence `E2E_TEST_TIMEOUT_MS`, which this change
leaves untouched) but took the *per-child* watchdog from T16's measurement of
`relay publish` in `src/commands/`, against an in-process mock relay. Nobody had
measured the e2e children. That is the one real gap, and it is what this change
closes. §3.

**3. My own finding F-005 was wrong and is withdrawn.** I reported that T16's fix
"was never committed" because `apps/cli/test/childProcessTimeouts.ts` was absent
and `cli.test.ts` still held its `15000` literal. Both observations were true; the
conclusion was not. The worktree's base was **30 commits behind `origin/main`**,
where T16's fix had landed long before. Every check I ran was local, so none could
see it. The branch was reset onto `origin/main` and the change reduced to the real
delta. Recorded as a lesson in project memory
(`memory/lessons/check-the-base-branch-before-concluding-earlier-work-was-lost.md`).

What survives all three corrections is the measurement, because durations do not
depend on the ceiling that was in place when they were taken.

| | Finding |
|---|---|
| Did the reported failures live in `test/e2e/`? | **No** — `src/runtime/inbound.test.ts`, `inbound.batchIsolation.test.ts` |
| Did anything assert-fail in the reproduction? | **No.** Zero `×` in a full 52-file verbose run |
| Is the worker-RPC timeout fixable by configuration? | **No.** birpc's hard-coded `DEFAULT_TIMEOUT = 6e4`; `createForksRpcOptions` passes no `timeout` |
| Children measured | **932**, across two full loaded runs |
| Distribution | p50 1588ms · p90 14066ms · p95 19459ms · p99 38855ms · **max 69465ms** |
| Breaches of main's 45000ms child wall | **2** direct (`relay publish`, 47889 / 48025ms), plus 6 `poll` samples to 69465ms that survive only behind one file's private 120000ms literal |
| Change | one new measured constant, `E2E_CHILD_TIMEOUT_MS = 150_000`; `E2E_TEST_TIMEOUT_MS` unchanged |
| Diff | 73 insertions, 27 deletions across 8 files; no new file |

---

## 1. Attribution: which tests actually produced the reported symptom

**Step 1 — E2E alone, verbose.** `vitest run test/e2e --reporter=verbose`:

```
 × test/e2e/init-relay-url.test.ts > guard: an unreachable relay is not reported
   as a local persistence failure 35110ms
   → init E2E child timeout

 Test Files  1 failed | 6 passed (7)
      Tests  1 failed | 29 passed (30)
   Duration  375.83s
```

One real e2e failure, and **zero** worker-RPC errors. So the RPC errors are not an
e2e-file property.

**Step 2 — the whole package, verbose, instrumented.** All 52 files reproduced the
reported symptom exactly:

```
 Test Files  50 passed (52)
      Tests  252 passed (273)
     Errors  6 errors        (all: Error: [vitest-worker]: Timeout calling "onTaskUpdate")
   Duration  907.25s
```

Vitest names the origin of each unhandled error, and named the same two files four
times:

> This error originated in "src/runtime/inbound.test.ts" test file. (×2)
> This error originated in "src/runtime/inbound.batchIsolation.test.ts" test file. (×2)

(the remaining two are raised main-process side and carry no file).

Three independent checks establish what "2 failed test files" means here:

- `grep -c '^ ×'` over the whole run: **0**. Not one assertion failed.
- `✓ src/runtime/inbound.test.ts >` occurrences: **0**, same for
  `inbound.batchIsolation.test.ts` — those two files reported *no tests at all*,
  while every other file reported all of its own.
- They declare 11 and 8 tests; `273 − 252 = 21` tests went unreported.

The two files were **victims, not causes**. The 2 failures and the RPC errors are
one symptom, located in `src/runtime/`.

**Why no timeout the repository controls can fix it.** Walked call site by call
site in vitest 3.0.8's bundle:

- `chunks/rpc.TVf73xOu.js:61` raises the message from `onTimeoutError`.
- Its only caller is `worker.js:98`, via `worker.getRpcOptions(ctx)`.
- For the forks pool this package uses, `workers/forks.js:20` →
  `createForksRpcOptions(v8)`.
- `chunks/utils.Cn0zI1t3.js:29` — that function returns only
  `serialize`/`deserialize`/`post`/`on`. **No `timeout`.**
- So birpc's default applies: `chunks/index.68735LiX.js:1`,
  `const DEFAULT_TIMEOUT = 6e4`, used at line 19.

A fixed 60s on the worker→main round trip, with no vitest option reaching it. It
fires when the machine is too saturated for the main process to answer within a
minute. The dangerous part is the reporting, not the timeout: the run still prints
"passed" twice while 21 tests never executed.

**How saturated.** A 2s sampler ran throughout. During the whole-package run (222
samples): mean load1 **202.6**, peak **386.4**, on a **10-core** machine, with
peaks of 7 relay processes, 8 CLI children and 6 `go build` toolchain processes
concurrently. The e2e suite alone drove load1 to 194–204. Later in the session,
load1 reached **600–790** with three foreign `vitest` mains live. Two other agents
were running this same suite for part of the window — this is the contention this
repository actually operates under, and it is only partly the suite's own doing.

---

## 2. What was measured

Every `command()` helper in all seven suites was instrumented to record real
spawn-to-close durations, to a file outside the repository — deliberately a file
and not `console`, because vitest routes console output through the very worker RPC
channel under investigation. **932 child invocations** across two loaded runs:

| p50 | p90 | p95 | p99 | max |
|---|---|---|---|---|
| 1588ms | 14066ms | 19459ms | 38855ms | **69465ms** |

Per command:

| command | n | mean | max |
|---|---|---|---|
| `poll` (flooded mailbox) | 159 | 13180ms | **69465ms** |
| `relay publish` | 138 | 19010ms | **48025ms** |
| `send` | 112 | 3427ms | 20401ms |
| `init` | 146 | 2001ms | 12476ms |
| `contact export` | 122 | 2327ms | 8912ms |
| `contact import` | 167 | 1360ms | 5972ms |
| `history` | 94 | 1304ms | 4293ms |

Relay lifecycle, same runs: `relayReady()` worst **4459ms** (n=18) against a
10000ms window; `stop()` teardown worst **519ms** (n=20) against 4000/6000ms; one
`go build` worst **6623ms** under six concurrent builds, against 150000–240000ms
hook ceilings.

Idle baseline, measured the same way: `relay publish` against an unreachable relay
1292ms, the whole `init`-then-publish test 1524ms, the file 5.31s for 9 tests.

**Ruled out by direct check, not assumed:** port collisions (every relay and proxy
binds an OS-assigned port), shared temp directories (`mkdtempSync` per suite,
removed in `afterAll`), concurrent child spawning inside a test (the directory's
only `Promise.all` bounds concurrent **HTTP requests**, not processes), and a logic
race — with the watchdogs temporarily raised far out of the way, **not one e2e
assertion failed** in either loaded run.

---

## 3. The gap this change closes

T40's own comment in `childProcessTimeouts.ts` records extending
`CLI_CHILD_TIMEOUT_MS` to this directory because the old e2e watchdogs were
"20000/30000ms — at or BELOW the 19655-20352ms T16 measured for the very same
`relay publish` child". That reasoning is sound as far as it goes, and its
whole-test half was measured here properly. But `relay publish` in `src/commands/`
runs against an **in-process mock relay**; in `test/e2e/` it runs against a real Go
relay process over real loopback HTTP, with several suites orchestrating multiple
processes at once. Same command name, different workload — and the e2e figure is
**2.4x** the one the constant was sized from.

Against main's 45000ms, eight of the 932 children ran over:

| what | where | measured | on main |
|---|---|---|---|
| `relay publish` ×2 | `prekey-pool-replenishment` | 47889, 48025ms | **breach** — routed through the base `command()` default |
| `poll` ×6 | `flood-closure` | 48899–69465ms | survives only behind that file's private `poll()` literal of 120000ms (58% of it) |

The six survivors are the stronger argument. Whether a correct child lived or died
depended on **which helper routed it**, not on what it did: in one and the same
file, `poll` children sat behind 120000ms while every other child sat behind
45000ms. That is exactly the drift a shared constant exists to remove.

For scale: 45000ms sat at roughly the **p99** of correct behaviour in this
directory; the pre-T40 literals sat at about the **p95**. Where T17's and T40's
measurements overlap they agree — heavy suites 124826–152610ms against T40's
124217ms — which is what makes a disagreement about the *child* number credible
rather than a measurement artefact. `E2E_TEST_TIMEOUT_MS` is therefore unchanged.

---

## 4. The remedy

Two constants added to the existing `apps/cli/test/childProcessTimeouts.ts` — the
file T16 and T40 already consolidated into, rather than a competing module.

- **`E2E_CHILD_TIMEOUT_MS = 150_000`** — the per-child `SIGKILL` watchdog for
  `test/e2e/`. **2.16x** the worst measured single e2e child (69465ms), the same
  margin `CLI_CHILD_TIMEOUT_MS` carries over its own worst case (2.21x), applied to
  this scope's own number. The margin must be a real multiple rather than a snug
  fit because the quantity is not a property of the code: the worst case rose from
  48025ms to 69465ms purely because other agents started their own runs.
  Zero of the 932 measured children exceed it.
- **`E2E_RELAY_READY_TIMEOUT_MS = 60_000`** — `relayReady()`'s `/health` polling
  window, replacing the 10000ms each relay-bearing suite hard-coded. 13x the
  measured worst (4459ms). Not observed failing; at 10000ms it carried the
  thinnest margin (2.2x) of any relay-lifecycle ceiling here and was demonstrably
  the next to start firing.

`CLI_CHILD_TIMEOUT_MS` is left at 45000 and still correct for `src/commands/`.
The scopes stay separate deliberately: one shared number would mean either a wall
this directory measurably breaches, or a 150000ms wall for CLI-only suites whose
worst child is 20.4s.

Deliberately **left alone**, each with the measurement that justifies it:

| ceiling | value | worst measured | margin |
|---|---|---|---|
| `E2E_TEST_TIMEOUT_MS` (T40) | 300000ms | 124217–152610ms | stays 2x the new child watchdog |
| `stop()` relay teardown | 4000 / 6000ms | 519ms | 8–11x |
| `beforeAll` hooks (one `go build`) | 150000–240000ms | 6623ms | 22–36x |
| `rewalk` `pollOnce` / `interruptPollAtPage` | 180000ms | 15873ms | already above the new watchdog — unifying would narrow |
| `rewalk` `holdPollAfter` | 120000ms | — | a proxy-hold ceiling, not a child watchdog |
| heavy `it()` in flood-closure / rewalk / prekey-pool | 300000–900000ms | 124826–152610ms | individually justified in place |
| `relay-tls` `httpsGet` / `servedFingerprint` | 3000ms | not instrumented | HTTPS request, not a child — measure before touching |

---

## 5. Verification, and the limit of it

**Before/after at one held load.** Thirty CPU-bound busy-loops started once and
**not restarted between the arms**; arms back to back, on the file whose failure §1
attributed:

| arm | load1 at start | result | the attributed test |
|---|---|---|---|
| before | 407 | `1 failed \| 8 passed (9)`, exit 1 | **× 44161ms — `init E2E child timeout`** |
| after | **529** | `9 passed (9)`, exit 0 | **✓ 59175ms** |

The after arm ran at a *higher* load than the before arm, which strengthens the
result. Wall clock 104s → 139s: the child previously SIGKILLed now runs to
completion.

**The limit, stated plainly.** These arms were run on the stale base, where that
suite's watchdog was **30000ms**, not main's 45000ms. So they prove the per-child
watchdog is what decides this test's fate — they do not by themselves prove 45000
would have failed it. What supports that is the arithmetic of the passing arm: 9
tests, the last of them 59175ms for an `init` (1.9–4.4ms measured range: 1683–4447ms)
followed by one `relay publish`, which puts that single child near 55s — above
45000, and consistent with the 47889/48025ms directly measured for the same command
in `prekey-pool-replenishment`. The direct evidence against 45000 is those two
measurements; this arm is corroboration, not proof.

**Full e2e suite** (also on the stale base, with the then-equivalent ceilings):
`7 passed (7)`, `30 passed (30)`, exit 0, 1250.96s, having *started* at load1 443
with three foreign `vitest` runs live.

**On this branch:** `tsc -p apps/cli/tsconfig.json --noEmit` clean. The pre-push
gate runs both suites against the pushed range and the working tree.

Two residual margins observed under load1 443, both left as they were: the heaviest
`flood-closure` volume took **644155ms** and the heaviest `rewalk` test
**582903ms** against their 900000ms ceilings — a 1.4–1.5x margin. If load of that
kind becomes normal, those are the next numbers to revisit.

---

## 6. What was deliberately not done, and why

- **Not reduced the suite's own contention, though it was measured.** Two sources:
  (a) **six concurrent `go build`** of the identical relay binary, one per suite
  `beforeAll`, 4259–6623ms each, all firing at run start — the moment the RPC
  channel is most congested; (b) **seven-way e2e file parallelism**, peaking at 7
  relays + 8 CLI children on 10 cores. Both have an obvious fix and both obvious
  fixes break something specific:
  - (a) The precedent is `test/globalSetup.ts`, which builds `dist/cli.js` once for
    exactly this reason (its comment records the "partially rewritten bundle" race).
    But moving the relay build there unconditionally makes the **Go toolchain a hard
    dependency of every `vitest run`**, including `vitest run src/commands`, which
    needs no relay.
  - (b) The lever is a project-scoped `fileParallelism: false` for `test/e2e/**`. On
    vitest **3.0.8** that means a `vitest.workspace.ts` (`test.projects` is 3.2+),
    and a naive two-project split runs `globalSetup` **per project**, rebuilding
    `dist/cli.js` concurrently — reintroducing the very race `globalSetup.ts`
    prevents.

  Both belong in a change verified against pool and setup semantics, not bolted
  onto a timeout fix. And the measurement says this is the right order anyway: even
  a perfect within-package fix cannot prevent the observed starvation, because the
  dominant contributor is external (load1 600–790 with three foreign runs, against
  ~200 from this suite alone).

- **Not attempted to fix the worker-RPC timeout.** Not configurable (§1), and the
  files it struck are outside this scope. The useful fix is to make the
  under-report loud — fail when reported test count is below collected count — so a
  starved worker cannot be mistaken for a pass.

- **Not fixed the orphaned-relay leak,** and the measurement narrowed it usefully:
  it is **not** only a consequence of killed workers. The fully passing e2e run
  still left **two** relays reparented to `pid 1`, from `flood-closure` and
  `prekey-pool-replenishment`, with their `$TMPDIR` data directories intact. So at
  least one relay in those suites is reachable by a path that never runs through
  `stop()`. That is a teardown change, not a ceiling change.

- **An abandoned experiment, reported rather than hidden.** A
  parallel-versus-`--fileParallelism=false` comparison was started to price
  serialisation. The parallel arm took 2206s; during it, ambient load1 rose from
  163 to 578 as other agents started their own runs, and by the serial arm's start
  it was 578 rising to 727. The arms were not comparable and the serial arm was
  killed. **The serialisation cost is not quantified in this report** — measure it
  on a quiet machine rather than quoting a number from incomparable arms.

---

## 7. Cost

- **Idle:** unchanged. Nothing approaches these ceilings on an unloaded machine —
  the heaviest single child there is 1292ms against a 150000ms wall. Ceilings, not
  delays.
- **Loaded:** the suite is slower and correct instead of faster and wrong. The
  before/after arm is the whole trade in one line: 104s with a false failure,
  139s with the truth.

---

## 8. Identity

Base commit: `860005bcd4639f95f5403642046812dbf2e59e00` (`origin/main`).
SHA-256 (first 16 hex), before = `git show HEAD:<path>`, after = working tree:

| File | Before | After |
|---|---|---|
| `apps/cli/test/childProcessTimeouts.ts` | `1b77fa94bf93241d` | `5b8797c84d129713` |
| `apps/cli/test/e2e/flood-closure.test.ts` | `b2820f880b24f9f8` | `c544969aab514b69` |
| `apps/cli/test/e2e/init-relay-url.test.ts` | `2ea56ff49a81e233` | `d8d765e0f339f67b` |
| `apps/cli/test/e2e/prekey-pool-replenishment.test.ts` | `166756488f732f8b` | `cb2ca75ed2c7e1ea` |
| `apps/cli/test/e2e/publication-claimability.test.ts` | `d5720d9444fd90d2` | `6f847269aaf19328` |
| `apps/cli/test/e2e/relay-tls.test.ts` | `7095fbf536aebdf5` | `454e4493074ed67e` |
| `apps/cli/test/e2e/rewalk-crash-safety.test.ts` | `1cb6dae3aad473ae` | `5ca408e2058fcd0f` |
| `apps/cli/test/e2e/two-process.test.ts` | `40e93d55558c0a7f` | `751223c0bba7a249` |

No store key, private key, plaintext or HTTP request body was printed, recorded or
hashed. The instrumentation logged a label built from the first four argv entries
with absolute paths replaced by `<path>`; store keys travel in the environment
(`ECHOLET_E2E_KEY`), never in argv, and were never read. Loopback addresses are
written `[REDACTED:ip]` throughout, matching this flow's convention.

---

## 9. Files changed

**73 insertions, 27 deletions across 8 files. No new file.** Every changed line is
a ceiling raise or a literal moved onto a measured constant. No assertion, test
name, control flow or spawn argument was touched.

- `apps/cli/test/childProcessTimeouts.ts` — adds `E2E_CHILD_TIMEOUT_MS` (150000)
  and `E2E_RELAY_READY_TIMEOUT_MS` (60000) with the T17 derivation documented in
  place; corrects the one now-stale sentence in `E2E_TEST_TIMEOUT_MS`'s comment
  ("6.7x above `CLI_CHILD_TIMEOUT_MS`" → "2x above `E2E_CHILD_TIMEOUT_MS`").
  `CLI_CHILD_TIMEOUT_MS`, `CLI_TEST_TIMEOUT_MS` and `E2E_TEST_TIMEOUT_MS` keep
  their values.
- `flood-closure.test.ts` — 3 child sites off `CLI_CHILD_TIMEOUT_MS`
  (`command`, `runRaw`, `run`), 2 nested literals raised (`poll`,
  `killPollAfterPages`, 120000 → 150000), `relayReady`.
- `init-relay-url.test.ts` — 1 child site. No relay in this suite.
- `prekey-pool-replenishment.test.ts` — 1 child site (the suite with the two
  measured breaches), `relayReady`.
- `publication-claimability.test.ts` — 1 child site, `relayReady`.
- `relay-tls.test.ts` — 1 child site. Its two 3000ms HTTPS ceilings and the
  10000ms "Relay did not exit" ceiling untouched.
- `rewalk-crash-safety.test.ts` — 1 child site, 2 nested literals raised
  (`runRaw`, `run`, 60000 → 150000), `relayReady`. Its 180000ms poll defaults and
  `holdPollAfter` untouched.
- `two-process.test.ts` — 1 child site, `relayReady`.

Each replacement was applied by a script that asserts its expected hit count per
file and re-asserts that every must-not-touch site still reads as before, so a
silent miss or an accidental narrowing could not pass.

---

## 10. Method notes

- **Attribution:** e2e alone verbose first, then the whole package verbose, so each
  symptom could be pinned to a named file. Vitest's own "This error originated in
  …" lines, the absence of any `×`, and per-file `✓` counts were cross-checked
  against `vitest list`.
- **Instrumentation:** `Date.now()` at spawn, appended `kind\tfile\tlabel\tms` on
  `close` to a file outside the repository. Watchdogs and `it()` ceilings
  temporarily raised to 900000/1800000ms purely so nothing truncated a measurement.
  Reverted with `git checkout -- apps/cli/test/e2e` before any real edit.
- **Sampler:** every 2s, `vm.loadavg` plus counts of relay processes,
  `dist/cli.js` children, Go toolchain processes, `vitest` processes and `node`
  processes — which is how the peak census and the presence of foreign runs are
  known rather than assumed.
- **Load generator:** `for i in $(seq 1 N); do (node -e "let x=0; while(true){x+=Math.sqrt(x+1);}" &); done`,
  verified with `pgrep -f Math.sqrt | wc -l`, killed with `pkill -f Math.sqrt`,
  confirmed at 0 remaining at the end.
- **Housekeeping:** every process this task started was accounted for; orphaned
  relays found at the start and after runs were recorded and killed. Foreign
  agents' live runs and their children were left strictly alone, as were the relays
  on `geekom` and `depr`, which this task never contacted.

---

## Routing audit

- `graph_used`: no — *not relevant*. Driven by reproduction and measurement, not by
  code-navigation or blast-radius questions.
- `wiki_used`: no — *not relevant*. The question was "how long does this child
  actually take", which only measurement answers.
- `ctx_used`: yes. Every in-repo search through `keryx ctx rg`; file reads and
  repository commands through `keryx ctx read` / `keryx ctx run`. Findings recorded
  through `keryx memory new` / `index` / `check`; both artifacts scanned with
  `keryx security check-output`.
- `raw_rg_used`: no. Raw shell was used, with an explicit escape marker and reason,
  only for (a) live-growing test logs in the session scratchpad **outside** the
  repository, which `keryx ctx read` cannot follow while they are being written,
  (b) exact source lines from `node_modules` needed to establish the birpc timeout,
  (c) cross-ref blob comparison against `origin/main`, which `keryx ctx read`
  cannot address, and (d) process censuses (`ps`/`pgrep`), which read no repository
  content.
