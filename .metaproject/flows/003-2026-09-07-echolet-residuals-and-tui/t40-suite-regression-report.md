# T40 — Suite regression report: the `apps/cli` suite was not red, the machine was saturated; and the ceilings that would have made it red anyway

Date: 2026-09-09. Scope: test files and one test helper only, under `apps/cli/test/`
and `apps/cli/src/runtime/`. **No file under `apps/*/src` product code or under
`packages/` was changed.** No assertion was weakened, narrowed, skipped or deleted —
every change either raises an existing ceiling to a measured value or replaces a
duplicated literal with a shared, documented constant.

Tree at the start: HEAD `23a17aa` plus the uncommitted T16/T38 work. Two commits
(`9318130`, `e083761`) landed from another session while this task ran; neither touches
`apps/cli` or `packages/`, and neither is on the path of anything measured here.

---

## 0. The headline

| | |
|---|---|
| Reported | `pnpm --filter @echolet/cli exec vitest run` → exit 1, 8 files failed of 52, 21 tests failed of 273, **803 s** |
| Cause of the 3.6x | **Neither hypothesis. The machine was saturated.** Load averages **188 / 305 / 394** on 10 cores, **0.1 % idle**, 55.8 % sys, with a second full `vitest run test/e2e` from another worktree in flight plus an orphaned vitest worker and two orphaned relays from earlier runs |
| Same tree, same command, quiet machine | **52 files, 273 tests, all passing, exit 0, 243.76 s** — matching the 223.69 s green baseline |
| Hypothesis 1 (pool cost landed on unsized timeouts) | **Half right.** Real defect, and it is fixed here. It does not explain the slowdown: the pool landed in `1ed5b2a`, *before* both green baselines |
| Hypothesis 2 (the raise let a genuine hang run longer) | **Refuted.** No test in those five suites asserts a fired watchdog; a watchdog that never fires costs no wall clock, and the green baseline proves none fired |
| Relay Go change implicated? | **No.** The zero-refusal needs the variable to be explicitly set; no harness sets it. The removed knob's default moved to the service unchanged at 60 s |
| Fix touches product code | **No** |
| After the fix | **52 files, 273 tests, all passing, exit 0, 228.20 s** — and under the reproduced 7x contention the four measured files go from 4 failed of 10 to 10 passed of 10 |
| Residual that survives the fix | `[vitest-worker]: Timeout calling "onTaskUpdate"` — vitest's own worker RPC ceiling, not a test ceiling. Present identically before and after this change (same two files, same count). It alone turns a run with **zero failing tests** into exit 1 |

---

## 1. What the machine was doing

Captured at 00:07:08 +0400, before anything was changed
(`scratchpad/machine-state-1.txt`):

```
load averages: 188.36 304.96 394.06          (10 physical / 10 logical cores)
Processes: 943 total, 64 running, 3 stuck, 876 sleeping, 6941 threads
CPU usage: 44.18% user, 55.80% sys, 0.1% idle
PhysMem: 15G used (3977M wired, 6924M compressor), 117M unused
```

Not one of these processes belongs to this session:

| PID | Started | What |
|---|---|---|
| 20413 | 23:51:17 | `npm exec vitest run test/e2e --reporter=verbose`, cwd `.claude/worktrees/compassionate-nash-a31cb6` — **a second full end-to-end run of this same suite, from another worktree**, still running at 00:19 |
| 11504 | 23:29:25 | vitest worker, **orphaned** (`ppid 1`), still burning 16-33 % CPU 38 minutes later |
| 16800 | 23:38:09 | `echolet-flood-closure-e2e-AQafFj/relay`, child of that orphan |
| 20028 | 23:49:07 | `echolet-prekey-pool-e2e-rHgvxL/relay`, **orphaned** (`ppid 1`) |

An 803 s run reported as finished shortly before the task was written spans
roughly 23:50-00:04 — entirely inside that window. The 15-minute load average of
**394** covers exactly it.

Independent corroboration of the magnitude: commit `2d15634` measured
`vitest run test/e2e` at **4 min 52 s**. PID 20413's run of that same directory was
still going after **28 minutes** — 5.7x.

Two other sessions are indeed editing this tree, as the task warned. Their most
recent writes to `apps/cli/test/e2e/*` and `apps/cli/src/runtime/inbound.test.ts`
all predate this task (18:29-20:08); no file was written under me during it, and
every file touched here was verified unmodified against `HEAD` before being edited
and hash-verified after each temporary instrumentation was reverted.

## 2. The measurement that settles it

Seven runs, all captured to files and read from files. Node v26.5.0 (the default
non-login interpreter), the task's own command, `--reporter=verbose` added so
per-test durations are recorded.

| Run | When | Machine | Result | Wall |
|---|---|---|---|---|
| **A** | 00:10:38-00:19:43 | PID 20413's e2e run in flight; load 104-180 (1 min), ~250 (15 min) | exit 1 — **50 of 52 files, 252 of 273 tests reported passed, zero failures**, 6 `onTaskUpdate` errors | **540.77 s** |
| **B** | 00:36:03-00:40:08 | quiet (load 11.5 at start; the rise to ~125 during the run is the suite's own 10 workers) | **exit 0 — 52 files, 273 tests, all passing** | **243.76 s** |
| **C** | 00:43:12-00:48:09 | T16's reproduction: 70 CPU busy loops, ~7x oversubscription | 4 files, 10 tests passed **with every ceiling raised out of the way**, to measure real durations | 291.24 s |
| **before-D** | 00:54:37-00:56:45 | same 70 busy loops, **original ceilings** | **exit 1 — 2 files, 4 tests failed, every failure `E2E child timeout`** | 121.73 s |
| **after-D** | 00:57:34-01:02:41 | same 70 busy loops, **fixed ceilings** | **exit 0 — 4 files, 10 tests, all passing** | 300.78 s |
| **E** | 01:04:04-01:08:34 | fixed ceilings; machine still carrying 1-min load 47-130 | exit 1 — 51 of 52 files, 263 of 273 tests reported passed, **zero failures**, 2 `onTaskUpdate` errors | 268.95 s |
| **F** | 01:22:36-01:27:35 | fixed ceilings; three Chrome renderers at ~100 % each, a VM at 61 %, a Time Machine backup at 37 % | exit 1 — 50 of 52, 252 of 273 reported passed, **zero failures**, 6 `onTaskUpdate` errors | 298.33 s |
| **G** | 01:31:06-01:34:55 | fixed ceilings; quiet (1-min load 11.7 at start, comparable to run B) | **exit 0 — 52 files, 273 tests, all passing, zero errors** | **228.20 s** |

Run **B** is the answer to the task's central question. The same tree, the same
command, the same 52 files and 273 tests: **803 s and red on a saturated machine,
243.76 s and green on a quiet one.** Nothing in the tree changed between them.

Run **A** is the more interesting one. At roughly half the reported contention the
suite produced **no failing test at all** — not one assertion, not one `it()`
timeout. It still exited 1, because six `[vitest-worker]: Timeout calling
"onTaskUpdate"` unhandled errors cost two files (`inbound.test.ts`,
`inbound.batchIsolation.test.ts`) their results entirely: `50 passed (52)`,
`252 passed (273)`, with no failure list to show for the missing 21. That is a
third failure mode, it is not a test ceiling, and it is §6's first residual.

### Accounting for 224 s → 803 s

Per-test contention factor, measured between B (quiet) and A (one foreign suite):

| Test | B, quiet | A, loaded | factor |
|---|---|---|---|
| `publication-claimability` | 24 283 ms | 80 061 ms | 3.30x |
| `rewalk-crash-safety` (SIGINT) | 27 105 ms | 80 512 ms | 2.97x |
| `two-process` (worst of 3) | 20 223 ms | 56 716 ms | 2.80x |
| `prekey-pool-replenishment` | 101 146 ms | 276 400 ms | 2.73x |
| `flood-closure` (8000 poison) | 104 587 ms | 249 075 ms | 2.38x |

Wall clock 243.76 s → 540.77 s is 2.22x for one competing suite. The reported run
carried a competing suite **plus** an orphaned worker, two orphaned relays, a
running VM at 107 % CPU and Chrome at ~460 % across helpers, on a host with 117 MB
of free physical memory. 803 s is 3.30x the quiet baseline; the per-test factors
above reach 3.30x at *half* that contention. The slowdown is fully accounted for by
CPU and memory saturation, and by nothing else.

## 3. Hypothesis 2, refuted

Raising a `SIGKILL` watchdog from 15 000 ms to 45 000 ms lengthens a run only if a
child was actually being killed at 15 000 ms. Two independent reasons it was not:

1. **No test in those five suites tolerates a fired watchdog.** Every assertion
   reads `timedOut: false` (`cli.processFailures` 175/185/195/205/230/246/268,
   `cli.relayErrorCodes` 171/172/199/203/209/215, `cli.senderQuota` 178/191/202)
   or `expect(result.timedOut).toBe(false)` (`cli.dashOptionValues` 88).
   `timedOut: true` is asserted nowhere. A watchdog that fired would have produced a
   *failure*, not a longer green run.
2. **The 223.69 s green baseline had zero failures.** So no watchdog fired in it, so
   raising the wall changed no test's duration. Confirmed directly in run B, where
   the slowest test in the whole `src/commands/` group is 8 448 ms — 5.3x below even
   the old 15 000 ms wall.

There is no hang underneath. The change was inert on wall clock, exactly as its own
header claims.

## 4. The relay's Go configuration is not implicated

Checked because the end-to-end suites build and run the real relay binary.

- **The zero refusal cannot fire here.** `refuseAnExplicitlyDisabledMaxMessageBytes`
  returns `nil` unless `os.LookupEnv("ECHOLET_MAX_MESSAGE_BYTES")` reports the
  variable *set*, and no harness in `apps/cli/test/e2e` sets it — every one spawns
  the binary with `ECHOLET_HTTP_ADDR`, `ECHOLET_DATA_DIR` and at most
  `ECHOLET_RATE_LIMIT_PER_MINUTE` / `ECHOLET_TLS_*`. Unset resolves to the
  `envDefault:"262144"`, as before.
- **The removed knob changed no behaviour.** `Config.CleanupIntervalSec` carried
  `envDefault:"60"`; `service.DefaultCleanupIntervalSeconds` is 60. A stale
  `ECHOLET_CLEANUP_INTERVAL_SECONDS` in the environment is inert because no field
  claims it.
- **Empirically the relay starts, and fast.** All seven e2e files passed in run B at
  `23a17aa`, each building and running the real binary; `relayReady()`'s 10 s
  readiness budget was never exhausted in any of the seven runs.

## 5. The defect that is real, and the fix

Two classes, both instances of the root cause T16 named and explicitly left out of
its own scope: *"every file that could carry that fix lives under
`apps/cli/test/e2e/` — a real, adjacent instance of the identical root cause (fixed
per-child/per-process watchdogs against a contended machine) that this task's scope
does not cover"* (t16-contention-report.md §5).

### 5.1 The per-child watchdog is below the measured duration of the child it guards

Every end-to-end suite spawns the real `dist/cli.js` through one `command()` helper
whose default `timeoutMs` was **20 000 ms** (`flood-closure`,
`publication-claimability`, `rewalk-crash-safety`, `two-process`) or **30 000 ms**
(`init-relay-url`, `prekey-pool-replenishment`, `relay-tls`). T16 measured the
heaviest such child — `relay publish`, which mints and signs
`LIMITS.PREKEY_MIN_COUNT` = 20 bundles in one process — at **19 655 / 19 811 /
20 352 ms** under this same reproduction. The wall is at or below the work.

`flood-closure` carries the same literal twice more, in its `runRaw` and `run`
wrappers.

Reproduced directly (**run before-D**, 70 busy loops, original ceilings):

```
 × test/e2e/publication-claimability.test.ts > reports whether a republished bundle … 39056ms
   → E2E child timeout
 × test/e2e/two-process.test.ts > clean real two-process run 1 … 37768ms
   → E2E child timeout
 × test/e2e/two-process.test.ts > clean real two-process run 2 … 35198ms
   → E2E child timeout
 × test/e2e/two-process.test.ts > clean real two-process run 3 … 35109ms
   → E2E child timeout

 Test Files  2 failed | 2 passed (4)
      Tests  4 failed | 6 passed (10)
```

Four failures, one cause, and it is a `SIGKILL` on a child that was still working —
the identical signature T16 documented for `src/commands/`.

### 5.2 Per-test ceilings sized before the pool, or never sized at all

- `outbound.publish.test.ts` declares `30000` three times. Those literals are
  **unchanged since `d5540a6`**, the original prototype commit — written when
  `publish()` minted **one** bundle. `d49ec6c`/`1ed5b2a` (T26) made every
  `publish()` mint twenty, and its third test performs three publishes plus a
  rotation, without the ceiling being looked at.
- `outbound.senderAuthentication.test.ts` has **no explicit ceiling at all** on any
  of its three tests, so they run on vitest's 30 000 ms default; each calls
  `messenger.publish()` — a full pool — before it can assert anything.
- `publication-claimability` and `two-process` declare `90000`; `relay-tls`
  `90000`/`120000`; `init-relay-url` `60000`.

Measured under the reproduction, with the ceilings temporarily raised far out of the
way so the number recorded is the real duration and not the wall (run C), and again
against the fixed constants (run after-D):

| Test | quiet (B) | run C | run after-D | old ceiling | verdict |
|---|---|---|---|---|---|
| `publication-claimability` | 24 283 | **120 798** | **124 217** | 90 000 | **over by 38 %** |
| `two-process` (worst of 3) | 20 223 | **96 643** | **101 442** | 90 000 | **over by 13 %** |
| `outbound.senderAuthentication` (worst) | 5 037 | 21 310 | 21 510 | 30 000 | 72 % of the wall |
| `outbound.publish` (worst) | 4 219 | 19 151 | 19 125 | 30 000 | 64 % of the wall |

The two end-to-end tests exceed their declared ceiling on a machine carrying the
contention this project has already ratified as normal. The two runtime tests do not
— but their wall was written for a one-bundle publish, T26 made it twenty, and a
28 % margin is not a ceiling.

### 5.3 What was changed, and what bounds each number

One file holds the numbers, extending the shared helper T16 introduced rather than
adding a fourth place for them to drift:

- **`CLI_CHILD_TIMEOUT_MS = 45 000`** — *unchanged, reused.* Already in the tree,
  already derived as ~2.2x T16's measured worst single child (20 352 ms) for exactly
  this child process. Every end-to-end `command()` default, and `flood-closure`'s two
  wrappers, now use it. **No new number.**
- **`CLI_TEST_TIMEOUT_MS = 90 000`** — *unchanged, reused.* Now also the ceiling for
  the two `src/runtime/` suites that mint a full pool in-process and spawn nothing:
  **4.2x** their worst measured 21 510 ms. **No new number.**
- **`E2E_TEST_TIMEOUT_MS = 300 000`** — *new constant, derived.* Bounded **below** by
  2x the worst measured end-to-end whole-test duration across two independent loaded
  runs (124 217 ms → 248 434 ms), following T16's own stated convention. Bounded
  **above** by the requirement that a genuinely stuck end-to-end test still fail
  within five minutes, and by staying 6.7x above `CLI_CHILD_TIMEOUT_MS` so the child
  watchdog fires first and reports the specific, actionable `E2E child timeout`
  instead of vitest's generic per-test message. 300 000 ms is the smallest value at
  or above 248 434 ms that this directory **already uses** (`flood-closure`'s 4x49
  volume), so no new magnitude enters the tree.

  It is a **floor**, not a replacement: the tests already declaring 300 000-900 000 ms
  keep the numbers their own recorded measurements justify.

This is a raise, and it is not the raise the task warns against. The evidence came
first — a controlled reproduction, real durations captured with the walls removed,
and an identical-load before/after — and each number is a stated multiple of
something measured, or a constant already derived that way.

### 5.4 The before/after, same load, same files

*Before* (original ceilings, 70 busy loops): `2 failed | 2 passed (4)` files,
`4 failed | 6 passed (10)` tests, all four `E2E child timeout`, 121.73 s.

*After* (fixed ceilings, 70 busy loops, same machine): `Test Files 4 passed (4)`,
`Tests 10 passed (10)`, 300.78 s.

Slower and correct, instead of faster and lying: the 179 s difference is work that
was previously being `SIGKILL`ed part-finished.

### 5.5 And the full suite, after

**Run G, quiet machine, fixed ceilings: `Test Files 52 passed (52)`,
`Tests 273 passed (273)`, exit 0, 228.20 s, zero errors** — against the pre-change
quiet baseline of 243.76 s and the task's own 223.69 s. The ceilings cost nothing
when nothing is competing for CPU, because they are never approached: they are
ceilings, not delays.

Runs E and F, taken on the same tree while the machine was busy again (competing
Chrome renderers, a virtual machine and a Time Machine backup, no competing test
run), each exited 1 with **zero failing tests** and only `onTaskUpdate` errors —
which is §6's first residual, not this fix, and is discussed there.

## 6. Residuals — found, not fixed, and why

1. **`[vitest-worker]: Timeout calling "onTaskUpdate"` (the one that matters).**
   Vitest 3.0.8's own worker→main RPC ceiling. It is not a test timeout, is not
   reachable from `vitest.config.ts`'s `testTimeout`/`hookTimeout`, and no ceiling in
   this change touches it. Reproduced three times, and **identically before and after
   the fix**, which is the control that shows this change neither causes nor cures it:

   | Run | Tree | Errors | Files losing their results | Reported |
   |---|---|---|---|---|
   | A | **before** the fix | 6 | `inbound.test.ts`, `inbound.batchIsolation.test.ts` | `50 passed (52)`, `252 passed (273)` |
   | E | after | 2 | `inbound.batchIsolation.test.ts` | `51 passed (52)`, `263 passed (273)` |
   | F | after | 6 | `inbound.test.ts`, `inbound.batchIsolation.test.ts` | `50 passed (52)`, `252 passed (273)` |

   Same two files, same counts, before and after — and neither file is touched by
   this change, contains an end-to-end ceiling, or publishes a pool. **No failing
   test appears in any of the three.** Absent on a quiet machine (runs B and G).
   T16 flagged the same symptom.
   **This is now the failure mode that makes a contended run untrustworthy**, and it
   needs a different fix from a different layer (worker pool configuration or a
   vitest upgrade), sized by its own measurement. Out of this task's scope.
2. **`beforeAll` hook ceilings of 150 000 ms** in `two-process`,
   `publication-claimability` and `prekey-pool-replenishment`, each enclosing a
   `go build` whose own child timeout is 120 000 ms. A *warm* `GOCACHE` build is
   seconds; a cold one under contention was not measured, so nothing was changed.
   Vitest's `hookTimeout: 30000` default also governs any hook that declares no
   ceiling of its own — which is the only place in the end-to-end files a literal
   `Test/Hook timed out in 30000ms` can come from.
3. **`two-process`'s proxy `AbortSignal.timeout(5000)` per upstream hop, and the 10 s
   `relayReady` budget.** Fixed ceilings of the same family. Neither was observed
   failing in seven runs, so neither was touched.
4. **`flood-closure`'s 8000-poison test (104 587 ms quiet, 900 000 ceiling) and
   `prekey-pool-replenishment` (101 146 ms, 600 000)** keep their own recorded
   ceilings. Their measured contention factor is 2.38-2.73x, not the 4.2-5.0x the
   short crypto-bound tests show, so their 8.6x and 5.9x margins hold. Raising them
   would be picking numbers, not deriving them.
5. **The reported error text could not be reproduced.** The task reports every
   inspected failure as `Test timed out in 30000ms`. At the contention reproduced
   here the same files fail as `E2E child timeout` — the child watchdog fires first.
   A literal 30 000 ms message can only come from a ceiling that *is* 30 000: the six
   tests in `outbound.publish` / `outbound.senderAuthentication` (both fixed here), or
   a hook running on the config default (residual 2). Nothing was tuned to make that
   message go away; it was traced to the only two places it can originate.

## 7. What was deliberately not done

- **Nothing under `apps/*/src` or `packages/` was changed**, and no product file was
  read for editing. The relay change was read to rule it out and left alone.
- **Nothing was weakened, narrowed, skipped or deleted.** Every edit either raises a
  ceiling to a measured value or replaces a duplicated literal with the shared
  constant. No assertion, no test, no volume, no case was touched. Test and file
  counts are identical before and after: 52 files, 273 tests.
- **The suites were not serialised**, for T16's reason: no evidence ties the failures
  to running *together* rather than to CPU being scarce, and serialising real
  process-spawning suites trades wall clock for no correctness the measurement does
  not already buy.
- **`vitest.config.ts` was not touched.** Its 30 000 ms default is correct for the
  light suites that rely on it; the files that need more now declare it.
- **The `onTaskUpdate` residual was not papered over** by raising something unrelated
  until exit 0 appeared.
- **Nothing was committed or pushed**, `geekom` and `depr` were not contacted, and no
  store key, private key, plaintext or HTTP request body was printed, recorded or
  hashed anywhere in this task.

## 8. Method notes

- Load generator, verbatim from T16 so the reproduction is the same one:
  `node -e "let x=0; while(true){x+=Math.sqrt(x+1);}"` x 70 on this 10-core Mac
  (~7x oversubscription), count confirmed with `pgrep -f Math.sqrt | wc -l` before
  each run and `pkill -f Math.sqrt` after; `busy_loops_left=0` recorded at the end of
  both loaded runs.
- Every run was captured to a file with its exit code, wall clock and a load-average
  sample series, and read from the file. Nothing was piped through `tail`.
  Scripts and logs: `scratchpad/run-suite.sh`, `run-loaded.sh`, `run-loaded2.sh`,
  `run-{contended-A,quiet-B,loaded-C,before-D,after-D,final-E,final-F,final-G}.log`,
  `meta-*.txt`, `load-*.log`, `machine-state-1.txt`.
- Run C's temporary instrumentation (ceilings raised to 1 800 000 / 600 000 ms so
  durations could be recorded rather than truncated) was applied only to four files
  that were verified unmodified against `HEAD` first, reverted with
  `git checkout --`, and the revert proved with `shasum -a 256 -c` against a
  pre-measurement snapshot: all four `OK`, `git status --porcelain` empty.
- The before/after comparison changed only the two constants in
  `childProcessTimeouts.ts` back to their original values, so the two runs differ in
  nothing else.
- `pnpm --filter @echolet/cli exec tsc -p tsconfig.json --noEmit` exits 0 after the
  change.

## 9. Files changed

- `apps/cli/test/childProcessTimeouts.ts` — adds `E2E_TEST_TIMEOUT_MS` (300 000) and
  records the T40 measurements and derivations beside T16's. (This file is itself
  still uncommitted work from T16.)
- `apps/cli/test/e2e/two-process.test.ts` — per-child default → `CLI_CHILD_TIMEOUT_MS`;
  `it.each` ceiling 90 000 → `E2E_TEST_TIMEOUT_MS`.
- `apps/cli/test/e2e/publication-claimability.test.ts` — same two changes.
- `apps/cli/test/e2e/relay-tls.test.ts` — per-child default → `CLI_CHILD_TIMEOUT_MS`;
  three ceilings (90 000, 120 000, 90 000) → `E2E_TEST_TIMEOUT_MS`.
- `apps/cli/test/e2e/init-relay-url.test.ts` — same shape; three 60 000 ceilings.
- `apps/cli/test/e2e/flood-closure.test.ts` — per-child default and both wrapper
  defaults → `CLI_CHILD_TIMEOUT_MS`. Its per-test ceilings (240 000-900 000) are
  already at or above the floor and are unchanged.
- `apps/cli/test/e2e/prekey-pool-replenishment.test.ts` — per-child default only.
- `apps/cli/test/e2e/rewalk-crash-safety.test.ts` — per-child default only. Its live
  wrappers already pass 60 000-180 000 explicitly and are unchanged; the 20 000 ms
  default they shadow is removed so the next call site cannot inherit it.
- `apps/cli/src/runtime/outbound.publish.test.ts` — three 30 000 ceilings →
  `CLI_TEST_TIMEOUT_MS`.
- `apps/cli/src/runtime/outbound.senderAuthentication.test.ts` — three tests given an
  explicit `CLI_TEST_TIMEOUT_MS` instead of the config default.

## 10. Routing audit

- `graph_used`: no — *not relevant*. This was a reproduction-and-measurement task;
  the files were named by the task or found by targeted search, and no blast-radius
  or structural question arose.
- `wiki_used`: no — *not relevant*. No architecture or domain question arose; the
  relay configuration question was answered from the commit and the code it changed.
- `ctx_used`: yes. `.metaproject/index.md` read before any other repository action;
  every code search through `keryx ctx rg`; every command and every file large enough
  to matter through `keryx ctx run` / `keryx ctx read`; every long run captured to a
  file and read from it.
- `raw_rg_used`: no. Raw `grep`/`sed`/`awk` was used only on my own captured run logs
  and scratchpad files under `/private/tmp/.../scratchpad`, where the verbatim counts
  and durations *are* the evidence, each with a `# keryx:raw` reason recorded.
