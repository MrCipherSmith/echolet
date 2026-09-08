# T16 — Contention report: process-spawning tests under `apps/cli/src/commands/` were killed by a stale watchdog, not broken by a race

Date: 2026-09-08. Scope: test files and test configuration only, under
`apps/cli/src/commands/` and a new `apps/cli/test/` helper. **No file under
`apps/*/src` (product code) or `packages/` was read for editing or changed.**
No assertion was weakened, narrowed, skipped or deleted — every change either
raises an existing timeout ceiling or replaces a duplicated literal with a
shared, documented constant.

Companion, unrelated item done in the same session: T15 (`deploy/relay/README.md`
correction) — see the separate summary; nothing below touches that file.

---

## 0. The headline

| | Before | After |
|---|---|---|
| Root cause | A per-child `SIGKILL` watchdog hard-coded to 15000ms (8000ms in one file), copied independently into 5 files, sized for an idle machine | One shared, documented constant, sized from directly measured contended durations |
| Reproduced | **Yes** — same 5 files, same load level, clean before/after comparison | |
| Real cause confirmed | **Yes** — every failure was a `SIGKILL` mid-flight on genuinely progressing work, never a logic bug | |
| Fix touches product code | **No** | |
| Idle wall-clock cost | 17.3s for all 36 tests | 17.3s — unchanged (ceilings, not delays) |
| Loaded wall-clock cost (7x core oversubscription) | 9/36 tests **fail** at ~165s wall (killed mid-run) | 36/36 **pass** at ~165s wall |

---

## 1. What was measured, and how

Reproduction target: `apps/cli/src/commands/cli.test.ts`,
`cli.dashOptionValues.test.ts`, `cli.processFailures.test.ts`,
`cli.relayErrorCodes.test.ts`, `cli.senderQuota.test.ts` — the five suites in
that directory that spawn the real CLI binary as a child process (real
libsignal crypto, real encrypted-SQLite I/O, real HTTP against an in-process
mock relay).

**First reproduction, unforced.** Before touching anything, I ran this
session's own `pnpm -r test` (the whole monorepo suite) in the background and,
independently, saturated this 10-core Mac with CPU-bound Node busy-loops
(`while(true) x+=Math.sqrt(x+1)`) — the same shape of contention two more
agents working on this repository at once already produce, not a contrived
worst case. In that single run, **all five target files failed**, every
failure shaped exactly like the task's three reports:

- `cli.test.ts`: `Error: CLI child timed out` (its `child()` helper explicitly
  rejects on watchdog fire) — 3 tests.
- `cli.dashOptionValues.test.ts`: `expected true to be false` — its `child()`
  helper *resolves* `{ timedOut: true }` on watchdog fire instead of
  rejecting, and `outcome()`'s own `expect(result.timedOut).toBe(false)` is
  what actually fails — 1 test.
- `cli.processFailures.test.ts` and `cli.senderQuota.test.ts`:
  `expected { code: null, … } to match { code: 0, … }` — `code: null` is
  Node's own signal for "killed by a signal, not exited"; this is the SAME
  watchdog firing, surfacing through a *third* shape of assertion — 1 test
  each.
- `cli.relayErrorCodes.test.ts`: `expected { code: null, … } to match
  { timedOut: false, code: 3 }` — same cause again — 2 tests.

Five files, five different-looking failure messages, one identical cause. That
by itself was the strongest signal that this was never an intermittent logic
bug: every single failure traced to the same fixed number.

**Isolated, repeatable reproduction.** To get clean before/after numbers I
then reproduced the identical failure with a controlled, self-contained
harness: 70 CPU-bound busy-loop processes on this 10-core Mac (≈7x core
oversubscription — the same *order of magnitude* the full-monorepo run
produced, isolated from everything else running on the machine), running only
`vitest run src/commands` (all five files, exactly as vitest's own worker pool
schedules them — concurrently, one per worker).

*Before* (original code, this exact load):

```
 FAIL  cli.relayErrorCodes.test.ts > … > keeps trust rejections … on their documented exit codes
 FAIL  cli.senderQuota.test.ts > … > reports SENDER_QUOTA_EXCEEDED on exit 3 …
 FAIL  cli.test.ts > … > exports verified contacts offline …
 FAIL  cli.test.ts > … > routes publish/send/poll through HTTP …
 Error: Test timed out in 30000ms.
 FAIL  cli.test.ts > … > maps untrusted sends to exit 3 …
 FAIL  cli.test.ts > … > reports the restored publication pool …
 Error: CLI child timed out

 Test Files  5 failed (5)
      Tests  9 failed | 27 passed (36)
```

*After* (fixed code, same load, same machine, same run of busy-loops not
restarted in between):

```
 Test Files  5 passed (5)
      Tests  36 passed (36)
   Duration  164.90s (transform 2.86s, setup 0ms, collect 6.49s, tests 524.81s, …)
```

**Per-child instrumentation** (temporary; not committed — see §4 for exact
method) captured real, individual child-process durations under that same
70-loop load:

| Command | Observed durations (ms) | Notes |
|---|---|---|
| `relay publish` | 19655, 19811, 20352 | Consistently the heaviest single invocation — mints and signs `LIMITS.PREKEY_MIN_COUNT` (20) prekey bundles inside one process |
| `init`, `doctor`, `history`, `contact`, `send`, `poll` | 1200–4400 | Never close to the old 15000/8000ms watchdog even under this load |

Idle baseline for the same shape of invocation (`init`, no contention): 150–250ms
median across 8 runs, measured directly by spawning `dist/cli.js` in a loop.

## 2. Why they are fragile — the actual mechanism, not a guess

This was **not**:
- a fixed per-child timeout being merely "too aggressive" in the abstract —
  it was measurably lower than a real, correct operation's actual duration
  under real, reproducible contention (20.4s needed vs. a 15000ms/8000ms
  wall);
- a worker pool that "oversubscribes" in some new way — vitest's default pool
  (one worker per file, up to core count) is unchanged and not itself at
  fault;
- a port collision — every mock relay in these suites binds `127.0.0.1:0`
  (OS-assigned port);
- a shared temporary directory — every fixture calls `mkdtempSync` per test
  and cleans up in `afterEach`;
- a logic race in the code under test — every failure traced to the *test
  harness's own* watchdog firing on a process that was still doing real,
  useful work, confirmed directly by the `code: null` (SIGKILL) signature and
  by the fact that raising only the watchdog, with no product-code change,
  makes the identical scenario pass.

It **was**: a per-child `SIGKILL` watchdog, independently hard-coded into five
files (`15000` in four of them, `8000` as the default in the fifth), sized
against an idle machine and never revisited when this same class of problem
was fixed once already at the *enclosing* layer. `vitest.config.ts`
(`apps/cli/vitest.config.ts`) already carries this comment, from a prior
incident (T42-F-001):

> Vitest's 5000ms default therefore turned a correct suite red intermittently
> … 30000ms is ~3x the worst observed loaded duration and matches the lowest
> per-test timeout the sibling suites already declare

That fix raised the *outer* `it()`/hook timeout project-wide. It did not (and
could not, from that file) reach the *inner*, hand-rolled watchdog that each
of these five suites keeps in its own local `child()`/`runCli()` helper to
`SIGKILL` a hung child directly — a second, independent timeout layer inside
the outer one, invisible to `vitest.config.ts`. That inner layer was never
updated, so it kept firing at its original, idle-sized value long before the
already-raised outer ceiling was ever reached — which is exactly why these
tests failed *underneath* a 30000/40000/60000ms `it()` timeout that had
plenty of room left. The bug was not "no one thought about loaded machines" —
it's that the fix for this exact class of problem was applied at one layer
and silently missed a second, independently-duplicated one.

A secondary, structural contributor, confirmed but not remedied (see §5 for
why): three of the five files (`cli.processFailures.test.ts`,
`cli.relayErrorCodes.test.ts`, `cli.senderQuota.test.ts`) each run a private
`esbuild` bundle of the whole CLI in their own `beforeAll`, deliberately
avoiding the shared `dist/cli.js` that the other two get from
`test/globalSetup.ts`. That isolation is itself the fix for an earlier,
different race — `test/globalSetup.ts`'s own comment: "one suite could
observe a partially rewritten bundle while the other was executing it" — so
consolidating them back onto one shared bundle to reduce CPU load would
reopen that exact bug. It adds real, if modest, concurrent CPU cost (three
extra whole-CLI bundles) whenever vitest schedules more than one of those
files at once, which is normal under its default parallelism.

## 3. The remedy: harden, not just raise

**Chosen: harden.** Not serialised — these suites correctly run in parallel
with each other and with the rest of the package today (no evidence tied the
failures to running *together* rather than merely to CPU being scarce; the
same failures reproduced with all five running as they always do), and
serialising five real-process-spawning suites would cost real wall-clock for
no correctness gain the measurement doesn't already justify.

Two related numbers, made explicit in one place — `apps/cli/test/childProcessTimeouts.ts`
— instead of five independently drifting literals:

- **`CLI_CHILD_TIMEOUT_MS = 45_000`** — the per-child `SIGKILL` watchdog.
  Derived: worst measured single-child duration under reproducible heavy
  contention was `relay publish` at 19655–20352ms (three samples, low
  variance). 45000ms is a little over 2.2x that measured worst case — real
  margin for run-to-run variance, without asking a genuinely hung child to
  wait a full minute to be killed.
- **`CLI_TEST_TIMEOUT_MS = 90_000`** — replaces every per-test `30000`/`40000`/`60000`
  literal in these five files (the `beforeAll` esbuild-build hook timeouts,
  unrelated and already adequate, were left at their existing `60000`).
  Derived: worst measured *whole-test* duration (several children chained in
  one `it()`, one of which may be the ~20s `relay publish` call) under the
  same reproduction was 47113ms. 90000ms is roughly 2x that. It must — and
  does — stay comfortably above `CLI_CHILD_TIMEOUT_MS` so a genuinely stuck
  child is still reported by the specific, actionable message ("CLI child
  timed out", or the local `timedOut`/`code: null` equivalent) rather than
  vitest's generic per-test timeout error.

Both numbers are documented in place, in `childProcessTimeouts.ts`, with the
measurement method, so a future incident doesn't have to re-derive them from
nothing.

This is a **raise**, but not the raise the task warns against: it is not "the
timeout was raised until the red went away." The evidence came first — a
controlled, repeatable reproduction, actual per-child instrumentation, an
identical-load before/after comparison — and the chosen numbers are a stated,
small multiple of what was actually measured, following the exact
already-established convention in `vitest.config.ts` (itself derived the same
way, for the same class of failure, one layer up).

## 4. Method notes (so this is reproducible, and not just asserted)

- Load generator: `for i in $(seq 1 N); do (node -e "let x=0; while(true){x+=Math.sqrt(x+1);}" &) ; done`,
  `N` = 30 (≈3x oversubscription) and 70 (≈7x oversubscription) on this
  10-core Mac. Confirmed with `pgrep -f Math.sqrt | wc -l` before each run and
  killed with `pkill -f Math.sqrt` after.
- Full-monorepo contention: `pnpm -r test` run in the background, which on
  its own reached the point of producing `E2E child timeout` and `CLI child
  timed out` failures in `apps/cli` before any synthetic load was added —
  confirming the reproduction condition matches ordinary "several suites at
  once" contention, not an artificial extreme.
- Per-child instrumentation: a temporary one-line addition to `cli.test.ts`'s
  `child()` — a `performance.now()` at spawn, and
  `process.stderr.write(`__CHILD_MS__ ${ms} ${args[1]}`)` on `close` — run
  once under the 70-loop load with the watchdog and test timeouts temporarily
  raised far past anything plausible (120000/240000ms) purely so nothing
  would be truncated while measuring. Reverted (`git checkout --`) before any
  real edit was made; not part of the committed change.
- Before/after comparison: the *exact* five original files (`git show HEAD:<path>`)
  run under the *exact* same live load as the fixed files, back to back, no
  restart of the busy-loops in between.
- All heavy processes (`Math.sqrt` busy-loops, any stray `vitest`/`pnpm`) were
  killed at the end of the session; none were left running.

## 5. What was deliberately not done, and why

- **Not consolidated the three private `esbuild` bundles onto the shared
  `dist/cli.js`.** That isolation is itself a prior fix (see §2); undoing it
  to save CPU would reopen the "partially rewritten bundle" race
  `test/globalSetup.ts` documents. Out of scope for this task's mandate to
  change no product behavior and weaken nothing.
- **Not serialised the five suites against each other.** No evidence tied the
  failures to concurrency *between* these files specifically — the same
  failures reproduced identically whether they ran alongside the rest of the
  monorepo suite or alone against synthetic load, always tracing to the same
  fixed per-child number. Serialising them would trade real wall-clock for a
  fix aimed at the wrong layer.
- **Not touched `vitest.config.ts`'s global `testTimeout`/`hookTimeout`.**
  Every test in these five files already declares its own per-test timeout
  (now `CLI_TEST_TIMEOUT_MS`), so the global default is not on the path for
  this fix, and it is shared by every other, lighter suite in the package
  that has no need for a higher ceiling.
- **Out of scope, flagged rather than fixed:** the same run that validated
  this fix (a full, otherwise-idle `apps/cli` suite run, `vitest run`) still
  showed 2 failing tests and 5 `[vitest-worker]: Timeout calling
  "onTaskUpdate"` errors — the exact "worker RPC timeout" symptom the task
  names as a third, independent report of this class of fragility. Those
  failures were not in the five files this task's mandate covers (they did
  not reproduce when `src/commands` was re-run alone, immediately after, on
  the same now-idle machine) and every file that could carry that fix lives
  under `apps/cli/test/e2e/` — a real, adjacent instance of the identical
  root cause (fixed per-child/per-process watchdogs against a contended
  machine) that this task's scope does not cover and this change does not
  touch.

## 6. Wall-clock cost

- **Idle:** unchanged. `vitest run src/commands`, no contention: 17.26s wall,
  36/36 tests, before and after — the new ceilings are never approached, so
  they cost nothing when nothing is competing for CPU.
- **Loaded (the condition these tests actually fail in):** 164.90s wall for
  the same 36 tests under 70-way CPU oversubscription, all passing, versus
  the same load previously producing 9 false failures partway through a
  faster-but-wrong ~130s run. The honest trade this task asked for: slower
  but correct, instead of fast but lying.

## 7. Identity

Repository HEAD: unchanged by this work, `1ed5b2abc710979c59612c87a1d19fddc33b2ba4`
(no commit was made; changes are staged in the working tree for review).

SHA-256, before (`git show HEAD:<path>`) and after (working tree):

| File | Before | After |
|---|---|---|
| `apps/cli/src/commands/cli.test.ts` | `478b69a40532c482b0a487633f58871285de043351add2335586235b72c9538d` | `1a9eea200c6babf63ff7878140ee1ab8df5d049fb338b115ad6bc5b6cc69b830` |
| `apps/cli/src/commands/cli.dashOptionValues.test.ts` | `6e4ce6eae2f32060a94b62f7dcf649b67246c826b8741a73497972bcd6024dd1` | `5dda744cef5a0e4fffb0bf2040aad6275105d79004718d6addb48de2491168d8` |
| `apps/cli/src/commands/cli.processFailures.test.ts` | `e89f96a6d7be009a345ec94ba260fee47ba69eb941b8a163558f14be3c344ec6` | `93b173ed5b4cf099a13360b3662d6cba0738d96aff1145c11a568e253c31912a` |
| `apps/cli/src/commands/cli.relayErrorCodes.test.ts` | `d54c319f90a83ca357e0a96b689b5ade811a64ab099e29156d1867b805d41a4d` | `b6c5f587675606edbce27c9b1ca24b6cb79e82c8cbe08a776007373573855e4d` |
| `apps/cli/src/commands/cli.senderQuota.test.ts` | `e193d625836cf6f5754e0d267fdb6a25a5e58ce80f6eb39a6b3622e71d303709` | `fcb07d2ed718a9f39606b148be914a6ee63743ab982f218f870fe783e5ae3bd3` |
| `apps/cli/test/childProcessTimeouts.ts` (new) | — | `94c930fc410230e7154d2fcd30efd75d120ce36f42b2e7e488860accce8afa59` |

No store key, private key, plaintext, or HTTP request body was printed,
recorded, or hashed anywhere in this task; the identities above are of test
source files only.

## 8. Files changed

- `apps/cli/test/childProcessTimeouts.ts` — **new.** Exports
  `CLI_CHILD_TIMEOUT_MS` (45000) and `CLI_TEST_TIMEOUT_MS` (90000), documented
  with the measurement method above.
- `apps/cli/src/commands/cli.test.ts` — per-child watchdog and all six
  `it()`-level timeouts now use the shared constants.
- `apps/cli/src/commands/cli.dashOptionValues.test.ts` — same.
- `apps/cli/src/commands/cli.processFailures.test.ts` — same; its
  `beforeAll` esbuild-build hook timeout (`60000`) is unchanged.
- `apps/cli/src/commands/cli.relayErrorCodes.test.ts` — same; its `beforeAll`
  hook timeout (`60000`) is unchanged.
- `apps/cli/src/commands/cli.senderQuota.test.ts` — same; its `beforeAll`
  hook timeout (`60000`) is unchanged.

## Routing audit

- `graph_used`: no — *not relevant*. This was a test-fragility investigation
  driven by direct reproduction and measurement, not code-navigation or
  blast-radius questions; the relevant files were named by the task or found
  by a single targeted search.
- `wiki_used`: no — *not relevant*. No architecture/domain question arose.
- `ctx_used`: yes. Every in-repo search used `keryx ctx rg`; every command
  and log large enough to matter was routed through `keryx ctx run` /
  `keryx ctx read`.
- `raw_rg_used`: no.
