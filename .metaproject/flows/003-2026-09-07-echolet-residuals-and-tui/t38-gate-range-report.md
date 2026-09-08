# T38 — the push gate verifies what is being pushed

Flow 003, task T38. Closes **R2-001** (the gate tested the working tree, not the commits being
pushed) and **R2-012** (`pnpm install` in any worktree rewrote the main checkout's hooks).

Date: 2026-09-08. Tree: HEAD **`23a17aa`** plus the uncommitted work of two other agents, which was
not touched. Machine: macOS 26.5.0 (Darwin 25.5.0), arm64, 10 cores; `node` **v26.5.0** measured in
the hook's own environment, not assumed; `pnpm` 10.0.0; `go1.26.1 darwin/arm64`; `git` 2.x with
worktree support. Nothing was pushed, `--no-verify` was not used, and neither `geekom` nor `depr` was
contacted. No store key, private key, plaintext or HTTP request body appears here.

---

## 1. The hole, reproduced first

The verifier's probe survived at `/tmp/echolet-r2-gate-probe.sh`. It builds a scratch repository the
way `selftest.sh` does, commits a **red** test script, then edits the working tree copy **green
without committing**, and feeds the hook the ref line naming the red commit.

**Before this task**, against the tracked gate at `23a17aa`:

```
---- gate exit: 0
push gate (go): no apps/relay/go.mod; nothing to run
push gate (js): keryx command not found; falling back to the project test script
push gate (js): running fallback test gate: npm run test
SUITE RAN: green
push gate (docs): OK — docs/STATUS_CURRENT.md is pinned at 7ca20d9d… and no behaviour-changing
---- committed suite.sh at the pushed sha:
echo "SUITE RAN: red"; exit 1
---- working-tree suite.sh:
echo "SUITE RAN: green"; exit 0
```

`gate exit: 0` on a state whose committed suite is red. R2-001 confirmed, not taken on trust.

**After this task**, the same probe run unmodified blocks — but for a bookkeeping reason, because the
probe vendors only two of the gate's four step scripts and the hook now names the missing one:

```
---- gate exit: 1
push gate: FAILED — scripts/gate/suites.sh is missing from the work tree.
```

So the probe was re-run with all of `scripts/gate/*.sh` vendored (the only change;
`scratchpad/r2-gate-probe-v2.sh`), which is the honest comparison:

```
---- gate exit: 1
push gate: the working tree is NOT the commit being pushed, so both are
push gate (deps): no lockfile with an available package manager at 4ceca94;
push gate: verifying the commits being pushed (tip 4ceca94)
push gate (go): no apps/relay/go.mod; nothing to run
push gate (js): running fallback test gate: npm run test
SUITE RAN: red
push gate: FAILED (exit 1) — the COMMITS BEING PUSHED are red at 4ceca94
---- committed suite.sh at the pushed sha:
echo "SUITE RAN: red"; exit 1
---- working-tree suite.sh:
echo "SUITE RAN: green"; exit 0
```

`SUITE RAN: red` is the load-bearing line. The exit code alone would also be produced by a worktree
that could not be created; the sentinel says the **committed** suite is what ran and what refused.

---

## 2. The approach, and why this one

Three were on the table.

**Refuse to push with a dirty tree.** Cheapest, and wrong for this repository. It is a policy change
that punishes anyone mid-work, and this tree is *never* clean in practice — agent bookkeeping under
`.metaproject/` and in-flight edits are its normal state. A gate that refuses the normal state is a
gate that gets `--no-verify`'d, and then it protects nothing.

**Check the range out into a temporary worktree and test there.** Chosen. It answers the actual
question — "is what the remote is about to hold green?" — and its *fixed* cost is small enough to
pay: **32.6–51.9 s** over six measured runs (§4), against a suite that costs a quarter of an hour.
What it does add, in the state where it runs at all, is a second pass of the suites — which is the
price of the property, and is why the equivalence fast path exists.

**Test only the range.** Rejected, and the rejection is the whole reason the fix is two runs rather
than one. Today's gate blocks when the working tree is red and the commit is green. Replacing the
working-tree run with a range run would allow that state — a weakening, forbidden by the brief and
worth refusing on its own merits. So the working-tree run stays exactly as it was.

### The shape that came out of it

`scripts/gate/suites.sh` now holds the one definition of "the suites" — the Go relay suite
race-enabled, then the JavaScript/TypeScript suite, same routes and same blocking policy as before —
parameterised by which tree to run against. Two runs of the same thing, never two different things;
otherwise the weaker of the two silently becomes the gate's real strength.

`.githooks/pre-push` then decides **which trees** must be verified, and proves the answer:

> The working tree is the push **iff** the push updates exactly one ref, `HEAD` is that ref's tip,
> and nothing that a suite can read differs from `HEAD`.

When all three hold, one run answers both questions and the gate costs what it cost before. When any
fails, the gate verifies **every distinct pushed tip** in a throwaway worktree (`pushed-range.sh`)
**and then** the working tree, and prints which paths made them differ.

"Nothing a suite can read" is `git status --porcelain -uall` minus two prefixes: `.metaproject/`
(agent bookkeeping) and `docs/` (prose). Both were checked rather than assumed —
`keryx ctx rg "docs/|\.metaproject" --glob "apps/**/*.test.ts" --glob "packages/**/*.test.ts" --glob
"apps/**/*_test.go"` returns exactly one hit, a comment in
`apps/cli/src/runtime/outbound.claimResidual.test.ts:16`. Everything else counts, including paths
that do not exist yet: the default is "these differ, run both", never "assume harmless". Untracked
files count too, which is what catches the forgotten `git add` — a commit that needs a file nobody
added is red on the remote and green on the author's disk, and that is the same bug as R2-001 wearing
a different hat (self-test row P3).

Three deliberate details:

* **The gate that runs is always the checkout's gate**, even when the tree under test is a pushed
  commit: `suites.sh` is invoked from the working tree's `scripts/gate/`, never from the checkout of
  the commit under test. A commit cannot bring a weaker gate along with it.
* **`--ignore-scripts` on the range install.** Not a shortcut: it means the gate cannot execute a
  lifecycle script out of the commit it is judging, and it keeps the root `prepare` script out of the
  way. If a suite genuinely needs a build step it fails there and the push is blocked — the safe
  direction. Verified that the full JS suite runs under it (50 of 52 `apps/cli` files completed; the
  two that did not are the `Timeout calling "onTaskUpdate"` worker-RPC flakes already recorded as
  R2-004, not missing modules).
* **`git -c core.hooksPath=/dev/null worktree add`**, so creating the throwaway checkout does not
  fire this repository's own `post-checkout` hook in the middle of a push.

The range run verifies each pushed **tip**, not every commit in the range. The tip is what the branch
will be; verifying every commit would multiply the cost by the number of commits and is not what the
gate is for.

---

## 3. Is the gate weaker anywhere? No.

There is only one way out of this hook with exit 0, and it is narrower than before:

| state | before T38 | after T38 |
|---|---|---|
| tree == push, suites green | allow | allow (one run — identical work) |
| tree == push, suites red | **BLOCK** | **BLOCK** |
| committed red, tree green | **allow** ← R2-001 | **BLOCK** (P1) |
| committed green, tree red | **BLOCK** | **BLOCK** (P2, unchanged) |
| commit needs an unadded file | **allow** | **BLOCK** (P3) |
| pushing a ref older than HEAD | tested the wrong tree | **that commit is tested** (P5) |
| two refs, one red | tested neither | **both tested, the red one blocks** (P6) |
| `git worktree add` unavailable / TMPDIR full | n/a | **BLOCK**, named |
| pushed lockfile out of sync with pushed package.json | invisible | **BLOCK**, named |
| a gate step deleted | blocked (S1) | blocked, and the two new steps too (S2, S3) |

Every allow-path in the "after" column runs the working-tree suites at least once, so no state that
blocked before can pass now. Nothing was made advisory, no scope was narrowed, no bypass and no new
environment variable was added. The only variable that exists remains
`ECHOLET_DOCS_FRESHNESS_STRICT=1`, which strengthens.

The gate does gain two new *blocking* states (no worktree support; an install that cannot be
performed). Both are the same rule the gate already applies to a missing Go toolchain: code that
cannot be verified does not get pushed.

---

## 4. Cost, measured

### 4.1 End to end, through the real hook

A disposable `git clone` of this repository was made in the scratch directory, the T38 gate committed
inside it (so the working tree could be clean), and dependencies installed once — `pnpm install
--frozen-lockfile` with lifecycle scripts, exactly as a human would, **7 s**, leaving
`git status --porcelain -uall` empty. The clone was then fed the ref lines git supplies on stdin,
three times: the pre-T38 hook, the new hook on a clean tree, and the new hook with one untracked file
under `apps/`. Nothing here touched the repository the other two agents are working in.

| leg | wall clock | exit | what it ran |
|---|---|---|---|
| **BEFORE** — pre-T38 gate | **970 s** | 1 | security + Go + one pass of the JS suite + docs |
| **AFTER** — fast path, tree proved to be the push | **829 s** | 1 | the same work, one pass |
| **AFTER** — two-tree path (untracked `apps/.gate-measure-marker`) | **451 s** | 1 | install + Go + JS **in the pushed checkout**, which went red and stopped there |

**These three totals are not comparable to each other, and saying so is the point.** All three exited
1 because the committed suite at `23a17aa` is red — `4 failed | 45 passed (52)` files in `apps/cli`,
alongside nine `Timeout calling "onTaskUpdate"` worker-RPC errors, in precisely the files another
agent is editing in the main working tree right now. A red suite stops the run wherever it happens to
fail, and R2-004's flakiness moves that point around: the same content took 829 s to fail on one leg
and 451 s on another. The wall clock of a red run measures the flake, not the gate.

### 4.2 What the gate actually adds, measured in isolation

This is the number that survives the noise, taken against the real repository (and separately against
the clone, which agreed):

| path | added work | measured |
|---|---|---|
| **fast path** (the ordinary push) | one `git status --porcelain -uall` | **0.084–0.147 s**, five runs |
| **two-tree path** | checkout + install + cleanup | **32.6–51.9 s**, six runs (mean ≈ 41 s) |
| — of which `git worktree add --detach` (1019 files) | | 0.8–5.4 s |
| — of which `pnpm install --frozen-lockfile --prefer-offline --ignore-scripts` | | 20.4–35.1 s |
| — of which removal of the worktree and its `node_modules`, plus `prune` | | 8.6–16.3 s |

So, stated plainly:

* **an ordinary push costs what it cost before, plus a tenth of a second.** The fast path does not
  install anything, does not check anything out, and runs the suites exactly once — self-test row P4b
  asserts the "exactly once" so a later change cannot quietly double it;
* **a push whose working tree is not the commit being pushed costs two passes of the suites plus
  about 41 s.** On today's suite that is the difference between roughly a quarter of an hour and
  roughly half an hour.

An earlier single measurement of 0.45 s / 4.7 s for checkout and install (taken in a worktree with a
warm page cache and no `node_modules` to delete afterwards) is quoted here only to be withdrawn: it
was one lucky run, the six-run range above is the honest figure, and the difference is almost all
`node_modules` — installing it and then deleting it again.

### 4.3 Against the T23 baseline

`t23-gate-hardening-report.md` measured the whole gate at **246 s** on `c5fde09`. That number no
longer describes this repository: one pass of `pnpm run test` now costs 800–970 s here, because
`apps/cli`'s `test` script picked up the seven `test/e2e` files (R2-003) and one of them alone runs
for over two minutes. That growth is not T38's doing and T38 does not fix it — but it is what makes
the equivalence fast path load-bearing rather than a nicety. At 246 s a doubling would have been
tolerable; at 900 s it would not, and a gate people route around protects nothing.

### 4.4 Cleanup, checked rather than assumed

After the two-tree leg, `git worktree list` in the clone reported **1** worktree and
`git status --porcelain -uall` **0** lines: the throwaway checkout, its `node_modules` and its
registration were all gone, and the repository being pushed from was untouched. The same two
assertions are self-test rows **P7** and **P8**, and the overhead runs above ended with the real
repository's worktree count back at its starting value.

---

## 5. The self-test: rows that could not have been written in the old frame

The old table had 27 rows and **every one of them built its scratch repository with the working tree
equal to `HEAD`**. That is why none of them could see R2-001: the gate asked the working tree, the
self-test asked the working tree, the two agreed, and their agreement carried no information about
the commits being pushed. This is the part worth keeping: a self-test written in the same frame as
the thing it tests will agree with it, whatever the frame is, and the agreement will read exactly
like a pass.

The table is now **44 rows, 44 ok, 0 wrong, 0 skipped** (`pnpm run gate:selftest`, **1 m 59 s**, up
from ~20 s: the new rows each check a commit out and run a suite against it). Seventeen rows are new
(27 + 17 = 44) and two more were repaired. The ones that matter:

| row | state it builds | what it asserts |
|---|---|---|
| **P1** | committed suite RED, working tree green | the push is **blocked** — the hole itself |
| **P1b** | same | `SUITE RAN: committed-red` appears — the **committed** suite is what ran |
| **P2** | committed suite green, working tree RED | still **blocked** — the old property, kept |
| **P2b** | same | both sentinels appear, push first — both trees really ran |
| **P3** | commit needs `apps/newmod/dep.sh`, which is untracked | **blocked** — the forgotten `git add` |
| **P4** | clean tree, HEAD is the tip, untracked files only under `.metaproject/` and `docs/` | **allowed**, equivalence announced |
| **P4b** | same | the suite ran **exactly once** — the cost claim, pinned |
| **P5** | pushing a ref older than HEAD, tree clean and green | **blocked**, `SUITE RAN: old-red` |
| **P6** | two refs pushed, first green, second red | **blocked**, `SUITE RAN: side-red` |
| **P7** | after P1's run | `git worktree list` is back to 1 — nothing leaked |
| **P8** | after P1's run | the repository's own working tree is byte-for-byte as before |
| **S2, S3** | `suites.sh` / `pushed-range.sh` deleted | **blocked**, named |
| **I1, I1b** | `install.sh` run from a linked worktree | the main checkout's `.git/hooks/pre-push` is **byte-identical**, and it says why |
| **I2** | `install.sh` run from the main checkout | the tripwire **is** installed — the fix did not just switch it off |
| **I3** | linked worktree, `core.hooksPath` unset | the repository-wide setting is **not** written |

### They fail when the hole is open — proved four ways, not asserted

A row that would agree with the new code the way the old rows agreed with the old code is worth
nothing, so each was run against code where the property is absent.

**Against the pre-T38 gate** (`git show HEAD:.githooks/pre-push` and friends, with the new
`selftest.sh`): **33 ok, 11 wrong** — P1, P1b, P2b, P3, P4b, P5, P6 (the range hole), S2, S3 (the new
steps), I1b, I3 (the installer). P2 stays **ok**, which is the point of the pairing: the old gate
already had that half.

**Against four mutants of the new gate:**

| mutant | edit | killed by |
|---|---|---|
| MU-A | drop the working-tree run from the two-tree branch ("just test the range") | **P2, P2b** |
| MU-B | equivalence condition replaced by `if true` ("the tree is always the push") | **P1, P1b, P2b, P3, P5, P6** |
| MU-C | equivalence ignores untracked files (`??` lines skipped) | **P3** |
| MU-D | verify only the first pushed tip instead of every tip | **P6** |

MU-A is the tempting simplification and MU-C the tempting optimisation; both are caught. No single
edit satisfies P1 and P2 at once by cheating, because they demand opposite things of a gate that
looks at only one tree.

### Two rows that were passing for the wrong reason

Found while extending the table, and repaired rather than left:

* **S1** ("a deleted gate step blocks") ran with `PATH=/usr/bin:/bin`, so the push was blocked for
  want of any test runner at all. It would have passed with the step present. It now runs with a
  working package manager on PATH, so the block is attributable to the missing step. S2 and S3 were
  written the same way from the start — and this is exactly why they fail against the pre-T38 gate
  and would not have if I had copied S1's construction.
* **J1c** ("keryx really was absent") was satisfied by a message the security block prints, while the
  test step could still reach keryx through the hardcoded `$HOME/.local/bin/keryx` fallback that no
  `PATH` can hide. The self-test's PATH neutralisation now rewrites that fallback in every gate file
  that carries it, not just in the hook, so the "no keryx" rows genuinely have no keryx.

Two harness changes fell out of the new equivalence rule and are worth naming, because they change
what the old rows exercise: the PATH-neutralised hook copy and the scratch `pmbin`/`fakebin`
directories used to live **inside** the scratch repository, where they were untracked files. Under
the new rule that means "the working tree is not the push", and every row would have quietly moved to
the two-tree path. They now live outside the repository, so the rows exercise the path they claim.

---

## 6. The installer (R2-012)

`git rev-parse --git-common-dir` resolves, from **any** linked worktree, to the **main** repository's
`.git`. `scripts/hooks/install.sh` used that to write its `core.hooksPath` tripwire — so a
`pnpm install` in a throwaway worktree rewrote `<main checkout>/.git/hooks/pre-push`, with whatever
version of `install.sh` that worktree happened to be checked out at. The verifier hit it while merely
installing dependencies to run the suite. It is also, now, a path the gate itself would have taken on
every two-tree push, since the range run installs dependencies in a worktree.

The rule the installer now follows, stated once:

> It writes only inside the worktree it was invoked in. The two pieces of shared state — the
> repository-wide `core.hooksPath` setting and the shared `.git/hooks/pre-push` — are written only
> from the **main** checkout. From a linked worktree they are reported, never written, naming the
> main checkout and the one command to run there.

The gate is not weakened by this: `core.hooksPath` is one repository-wide setting, so installing once
in the main checkout gates every worktree, and `verify.sh` — which `install.sh` still `exec`s, and
which `prepare` still runs on every `pnpm install` — still **fails** loudly in any worktree where the
gate is not in force. What changed is that a sibling checkout can no longer be edited behind its
owner's back. Rows I1/I1b/I2/I3 pin all four halves of that.

Belt and braces: the gate's own range install runs with `--ignore-scripts`, so it does not run
`prepare` at all.

---

## 7. Files

| path | change |
|---|---|
| `.githooks/pre-push` | reads every pushed tip from git's stdin, not just the first; proves whether the working tree is the push; runs the range first and the working tree second when they differ; header rewritten; the two new steps added to the missing-step check |
| `scripts/gate/suites.sh` | **new** — the one definition of "the suites", parameterised by tree (moved out of the hook verbatim in behaviour) |
| `scripts/gate/pushed-range.sh` | **new** — checks a pushed tip out into a throwaway worktree, installs its own lockfile with `--ignore-scripts`, runs the suites there, cleans up on every exit path |
| `scripts/gate/selftest.sh` | 17 rows added or repaired (P1–P8, S2, S3, I1–I3, S1 and J1c strengthened); harness files moved outside the scratch repositories; tool-path neutralisation extended to every gate file that names one |
| `scripts/hooks/install.sh` | acts only on the worktree it was invoked in; the shared hook and the shared config are written only from the main checkout |
| `scripts/hooks/verify.sh` | the two new gate steps added to the step-presence and tracked-file checks |
| `package.json` | `gate:range` script |
| this report, `dispatches/003-T38-implement-result.json` | new |

No test and no product file under `apps/` or `packages/` was changed; nothing under `deploy/` was
touched. The failing-suite states were staged in throwaway repositories under `TMPDIR`, exactly so
that no file in this repository had to be broken to prove the gate blocks.

---

## 8. What I could not do, and what remains

Nothing required weakening the gate, so there is no "could only be done by weakening X" item. Three
things are outside this task's reach and are stated rather than hidden:

1. **Committing is yours, and pushing is yours.** Nothing here was committed or pushed, and
   `--no-verify` was not used. The two new step scripts are **staged** (`git add`), which is what row
   V5 requires: before staging, `pnpm run hooks:verify` failed with
   `scripts/gate/suites.sh is NOT tracked by git` and reported the gate NOT in force; after staging it
   exits 0 with the "differ from HEAD" note that it is designed to print while the gate is being
   edited. Both states were run and are quoted here rather than described.
2. **The two-tree path costs two full suite runs**, and on a repository whose JS suite is 5–15
   minutes that is the difference between a four-minute gate and a nine-minute one. The equivalence
   fast path is what keeps that off the ordinary push, and it only stays fast while the working tree
   is genuinely the push. The gate names the offending paths on every slow run precisely so the
   ordinary case is easy to get back to.
3. **R2-004 is unchanged and now costs more.** `apps/cli`'s e2e files time out under load
   (`E2E child timeout`, `Timeout calling "onTaskUpdate"`), and a two-tree push runs the suite twice,
   which doubles the exposure. That is a test-configuration defect, not a gate defect, and another
   agent is working in that area; it is not fixed here.
4. **The `docs/` half of the equivalence allowlist is a judgement**, not a proof: it rests on no test
   reading `docs/`, which is true today and is checked by a search recorded in §2, not by anything
   mechanical. If a test ever reads a document, that list is where the mistake will be, and the
   comment above it says so.
5. **Ignored files are outside the equivalence claim, and outside git's view.** `git status
   --porcelain -uall` does not list `.gitignore`d paths, and it cannot: listing them means walking
   `node_modules`, which would put every push on the two-tree path forever. So a gitignored file that
   a suite reads — a fixture, a local `.env` — can still make the working tree green where the pushed
   commit is red, and the fast path would not notice. It is a smaller hole than R2-001 (it needs a
   suite to depend on a file the author deliberately told git to ignore) and it is the same
   limitation every local test run has, but it is a hole and it is stated rather than left for the
   next verifier to find.
6. **Step 4 still reads one file from the working tree, deliberately.** `docs-freshness.sh` takes its
   commit range from the pushed tip (T32 got that right) but parses the pin out of the
   `docs/STATUS_CURRENT.md` **on disk**. Changing it to read the pin from the pushed commit would
   *weaken* the gate in one state: a working tree whose pin line has been deleted currently **blocks**
   (row D2), and it would then be allowed whenever the committed copy still had a pin. Making it
   block on either copy would strengthen it, but that is a change to what the documentation check
   means and belongs to whoever owns T32, not to a task whose brief is the two blocking steps. Stated
   here rather than quietly fixed or quietly ignored.

---

## 9. Routing audit

- `graph_used`: **no** — *not relevant*. Every file was named by the dispatch, by a finding's
  `file:line`, or by the file being read. No "where does X live" or blast-radius question arose.
- `wiki_used`: **no** — *not relevant*. Git hook semantics, worktree behaviour, package-manager
  behaviour and shell portability; no architecture, domain or decision question.
- `ctx_used`: **yes** — `keryx ctx rg` for every search over project code, `keryx ctx run` for git and
  for the probe runs, `keryx ctx read` for reports and schemas. Raw logs under
  `.metaproject/data/gdctx/`.
- `raw_rg_used`: **yes**, with a `# keryx:raw` reason at each use, and **never as a search over
  project code**: verbatim self-test row verdicts, vitest and gate timing summary lines, and `grep`
  over my own logs in the scratch directory. Those counts and verdicts *are* the evidence, and a
  compacted summary elides them.
