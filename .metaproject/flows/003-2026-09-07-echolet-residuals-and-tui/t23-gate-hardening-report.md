# T23 / T24 / T32 — the push gate, hardened and proved

Date: 2026-09-08.
Tree: HEAD `c5fde09` plus uncommitted work.
Predecessor: [`t23-push-gate-diagnosis.md`](t23-push-gate-diagnosis.md) — what the
gate used to do and why it gated nothing. This report does not repeat that
diagnosis; it covers durability (T23), the Go suite (T24), documentation
freshness (T32), and the evidence for every claim.

Nothing here was taken on trust from the interrupted session that left these
files on disk. Every claim its comments made was re-derived, and the two that
were false are named in §1.

---

## 0. Summary

| | |
|---|---|
| Gate cost before | ~220 s (security ~5 s + `pnpm -r test` 215 s); **no Go test, no docs check** |
| Gate cost after | **246 s** measured end to end (security ~5 s + **Go 26 s** + `pnpm -r test` 215 s + **docs ~1 s**) |
| Added cost | **+27 s, +12 %** — and the added part is the cheap part |
| Rows in the state table | 27, all exercised, all as documented |
| Self-test | `pnpm run gate:selftest` — ~20 s, `27 ok, 0 wrong, 0 skipped` |
| Freshness check | **warns** on drift, **blocks** on a broken pin |
| Weakenings | none — see §6 |

---

## 1. What the interrupted work got wrong or left unproven

The previous session wrote the hooks and scripts and then ended without a
report. Read as a claim, its comments asserted six things. Four were true and
are now proved rather than asserted; two were false.

**Wrong — the gate was not tracked.** `.githooks/pre-push` states in its own
header: *"it is tracked, so it survives a clone"*. It was not. At the start of
this session `git status` reported `?? .githooks/` and `?? scripts/` — both
directories were untracked, present in this checkout and nowhere else. The whole
durability argument for moving the gate out of `.git/hooks` rests on the files
being version-controlled, and they were not. That was the single biggest hole:
the gate would have vanished on any clone exactly as the old one did, and no
review could see a change to it.
Fixed: both directories are staged (`git add .githooks scripts`), the header now
says *"once committed"*, and `scripts/hooks/verify.sh` now **fails** when any
gate file is untracked (state-table row V5) so the mistake cannot recur silently.
The commit itself is deliberately left to you.

**Wrong by omission — moving the gate created a new silent-revert path.**
`core.hooksPath` is local config. No commit carries it, `git clone` does not
reproduce it, and one `git config --unset core.hooksPath` switches the entire
gate off without touching a tracked file. git then falls back to
`.git/hooks/pre-push`, which keryx keeps regenerating — the stock hook that
reports `SKIPPED` and allows a push having run nothing. So the interrupted work,
taken alone, converted "the gate can be reverted by `keryx update`" into "the
gate can be reverted by one `git config` command, silently, back to the exact
broken hook this flow removed". Nothing anywhere would have said so.
Fixed by the tripwire, §2.3.

**True and now proved, not assumed:**

- keryx never consults `core.hooksPath`. The string `hooksPath` does not occur
  anywhere in the installed bundle (`@mrciphersmith/keryx@0.2.80`,
  `dist/cli.js`, zero matches); `resolveGitHooksRoot()` (line 314) resolves
  `git rev-parse --git-common-dir` + `/hooks` and nothing else.
- `keryx init`, `keryx update --hooks` and `keryx sync install-hooks` all leave a
  tracked `.githooks/pre-push` byte-identical — §2.1.
- Content placed *above* keryx's `# keryx:<id>:begin` markers in
  `.git/hooks/pre-push` survives all three — §2.1. This is what makes the
  tripwire possible.
- `-tags relayv2` is a strict superset: exactly one file in `apps/relay` carries
  a build tag (`internal/storage/repository/prekey_bundle_v2_test.go`, and it is
  a test file), so the tagged run excludes nothing.
- The hook environment is the interactive one. The brief warned that the last
  hypothesis about this was wrong, so it was re-checked independently rather
  than inherited from the diagnosis — and without contacting `origin`: a
  throwaway bare repository in the scratch directory as the push target,
  `--dry-run`, and `core.hooksPath` overridden for that one invocation so the
  real gate did not run.

  ```
  === cwd:   /Users/Goodea/goodea/projects/echolet
  === node:  /opt/homebrew/bin/node -> v26.5.0     node:sqlite: available
  === bun:   /Users/Goodea/.bun/bin/bun -> 1.3.12
  === pnpm:  /opt/homebrew/bin/pnpm -> 10.0.0
  === go:    /opt/homebrew/bin/go -> go1.26.1 darwin/arm64
  === keryx: /opt/homebrew/bin/keryx
  === GIT_DIR=unset GIT_INDEX_FILE=unset GIT_WORK_TREE=unset
  === stdin refs:
      HEAD c5fde09… refs/heads/probe 0000000…
  PUSH_EXIT=1
  ```

  Node in a real hook is **v26.5.0 with `node:sqlite` available**, not the
  login-shell v22.12.0; `go`, `bun`, `pnpm` and `keryx` all resolve; no `GIT_*`
  variable rewrites the repository view; the cwd is the work-tree root; and git
  hands the hook the push range on stdin. `PUSH_EXIT=1` is worth its own line:
  it is end-to-end proof through git itself that a non-zero pre-push hook stops
  a real `git push`, which every "BLOCK" row in §5 ultimately depends on.

**Also fixed while verifying (smaller):**

- `verify.sh` compared the working tree against the **index**, so a staged
  weakening of the gate produced no note at all. It now compares against `HEAD`,
  and covers `scripts/hooks/` as well as `scripts/gate/`.
- `pre-push` ran `sh $REPO_ROOT/scripts/gate/<step>.sh` with no existence check.
  A deleted step did block — with `No such file or directory` and exit 127. It
  now names the missing step and says why the push is blocked (row S1).
- The keryx fallback tested `[ -f "package.json" ]` relative to the current
  directory. Git happens to run hooks from the work-tree root, but the tripwire
  and `pnpm run` do not have to; the hook now `cd`s to the repository root and
  uses absolute paths.
- `docs-freshness.sh` ran one `git diff-tree` per candidate commit. With a pin
  left unmoved for a few hundred commits that is a few hundred processes at
  every push — a gate step that gets slower the longer it is ignored is one that
  gets deleted. It is now a single `git log --name-only` pass plus one `awk`.
  Verified to produce byte-identical output on the live repository (the same
  nine commits, same order).
- `core.hooksPath` replaces `.git/hooks` **wholesale** — every hook type. The
  three passthrough shims (`post-commit`, `post-merge`, `post-checkout`) cover
  what keryx installs today, but nothing would have noticed a fourth. `verify.sh`
  now warns about any hook in `.git/hooks` with no counterpart in `.githooks/`.

---

## 2. T23 — durability

### 2.1 What survives `keryx init` and `keryx update`

Measured, not reasoned about. A throwaway repository was created with
`core.hooksPath = .githooks` and a tracked `.githooks/pre-push` containing a
deliberately planted `# keryx:testing-pre-push:begin/end` block — bait, so that a
keryx that *did* rewrite by marker would be caught doing it.

```
BEFORE_SHA=feee22bc…5763e      hooksPath_before=.githooks
keryx init --yes               -> exit 0   AFTER_INIT_SHA=feee22bc…5763e   hooksPath=.githooks
keryx update --skip-runtime --hooks -> exit 0   AFTER_UPDATE_SHA=feee22bc…5763e   hooksPath=.githooks
keryx sync install-hooks       -> exit 0   AFTER_SYNC_SHA=feee22bc…5763e   hooksPath=.githooks
TRACKED_HOOK_UNCHANGED=yes     planted_decoy_still_present=1
keryx_regenerated_git_hooks_pre_push=yes
```

A second probe planted a sentinel *above* every keryx marker in
`.git/hooks/pre-push` and re-ran all three commands: `after_init_top=1`,
`after_update_top=1`, `after_sync_top=1`, keryx's own block still present.

| | survives `keryx init` / `update` / `sync install-hooks` | survives a clone |
|---|---|---|
| `.githooks/**` (the gate) | **yes** — keryx writes only to `<git-common-dir>/hooks` | **yes, once committed** |
| `scripts/gate/**`, `scripts/hooks/**` | yes | yes, once committed |
| Content above keryx's markers in `.git/hooks/pre-push` (the tripwire) | **yes** | no — `.git/hooks` is never cloned |
| Content *between* keryx's markers | **no** — rewritten every time | no |
| `core.hooksPath` | yes (keryx never touches it) | **no** — local config, no commit carries it |
| `.git/hooks/{post-commit,post-merge,post-checkout}` | rewritten by keryx, which is intended: the shims forward to them | no |

The one thing that does not survive a clone is the `core.hooksPath` setting
itself. Two mechanisms answer that, and they are different in kind:

1. the root `prepare` script runs `scripts/hooks/install.sh` on every
   `pnpm install`, so a fresh clone is gated as soon as anyone installs
   dependencies — which is before they can run a test or build anything;
2. the tripwire, below, covers the case where someone has already installed and
   the setting is later lost.

### 2.2 How a person notices a silent revert

Eight independent detectors, in the order they would fire:

| Revert | What notices it | What the person sees |
|---|---|---|
| `core.hooksPath` unset / clone never `pnpm install`ed | **the tripwire** (§2.3) | a banner on the next push, and the gate runs anyway |
| ditto | `pnpm run hooks:verify` | `FAIL — core.hooksPath is 'unset'` (row V2) |
| `.githooks/pre-push` replaced by something else | `hooks:verify` marker check | `FAIL — does not carry the echolet push-gate marker` (row V6) |
| gate files never committed | `hooks:verify` tracked check | `FAIL — <path> is NOT tracked by git` (row V5) |
| gate weakened locally | `hooks:verify` diff-against-`HEAD` | `note — .githooks/ … differ from HEAD` |
| a gate step deleted | **the gate itself** | blocked push naming the missing step (row S1) |
| keryx ships a different security block | `hooks:verify` fingerprints | `WARNING — keryx regenerated its 'security-pre-push' block` |
| keryx starts installing a new hook type | `hooks:verify` shim check | `WARNING — .git/hooks/<name> exists but .githooks/<name> does not` |

`hooks:verify` is not a thing anyone must remember to run: `prepare` runs it on
every `pnpm install`, and `install.sh` ends by `exec`ing it.

### 2.3 The tripwire

`scripts/hooks/install.sh` writes a block into `<git-common-dir>/hooks/pre-push`,
above keryx's markers (which is why it survives — §2.1). git can only reach that
file when `core.hooksPath` is *not* `.githooks`, i.e. precisely when the gate has
been switched off. It then:

- prints `echolet: THE PUSH GATE IS NOT INSTALLED`, naming the actual
  `core.hooksPath` value and the one-line fix; and
- `exec`s the tracked gate anyway, so the push is still gated.

It warns *and* gates, rather than blocking outright, deliberately: blocking would
punish someone whose only mistake is not having run `pnpm install` yet, and it
would leave the push unverified. Warning alone would be a message nobody acts on
while pushes silently go ungated. Doing both means the push is safe and the
banner keeps appearing until someone runs `pnpm run hooks:install`.

The block is rewritten — not skipped — on every `install.sh` run, so the tripwire
cannot itself go stale; re-running the installer twice leaves exactly one block
(verified: two markers in `.git/hooks/pre-push`, not four).

**Residual limitation, stated rather than papered over.** If someone points
`core.hooksPath` at a *third* directory (neither `.githooks` nor `.git/hooks`),
neither the gate nor the tripwire runs, and only `pnpm run hooks:verify` — or the
next `pnpm install` — reports it. Git offers no hook that survives its own
`core.hooksPath`, so this cannot be closed from inside the repository. It is a
deliberate act, not an accident, and it is visible in `git config --list`.

---

## 3. T24 — the Go suite inside the gate

Until now `pnpm -r test` walked the pnpm workspace, `apps/relay` is a Go module
and not in it, and keryx's changed-scope selection is JS/TS-only. **No Go test
had ever run in the gate.** A relay defect passed with a green report.

### 3.1 Cost, measured

All figures `-count=1` (Go caches results; without it a green line is a replay),
on this machine, warm:

| run | wall clock |
|---|---|
| `go test -count=1 -tags relayv2 ./...` | 23 s |
| `go test -race -count=1 ./...` (no tag) | 25 s |
| **`go test -race -count=1 -tags relayv2 ./...`** (what the gate runs) | **26 s** (29 s cold) |

11 packages have tests; the longest is `internal/server` at 23.5 s, so the
suite is essentially one package's latency plus scheduling.

| | before | after |
|---|---|---|
| security scan over the pushed range | ~5 s | ~5 s |
| **Go relay suite, race-enabled** | **not run at all** | **26 s** |
| `keryx test run --strict` → `pnpm -r test` | 215 s | 215 s |
| documentation freshness | not run at all | ~1 s |
| **total** | **~220 s** | **~247 s** |

Measured end-to-end through the real hook, fed the ref lines git supplies on
stdin: `GATE_SECONDS=246`, `GATE_EXIT=1`.

The run was repeated after every change in this task, and came back
`GATE_SECONDS=343`, `GATE_EXIT=1` — quoted here rather than dropped, because it
is the more honest number about *variance*. Nothing in the hardening accounts for
the extra 97 s: the Go step's own contribution is fixed at ~26 s and was measured
in isolation five times, and the second run shared the machine with another agent
running the `apps/cli` suite plus this task's own `gate:selftest` runs. The JS
suite is the variable part (215 s quiet), which is exactly why the Go step was
put *first*: a relay regression is reported in half a minute rather than after
whatever the JavaScript suite happens to cost that day.

### 3.2 Why the full matrix, and not a subset

The brief allows choosing a subset if the full matrix is too slow. It is not,
and each flag pays for itself:

- **`-race` costs 3 s** (26 s vs 23 s). The relay's guarantees *are* concurrency
  guarantees — exactly-one-winner prekey claim, cleanup-service shutdown join. A
  non-race run does not test the property the code is about. Three seconds is not
  a reason to stop testing it. Proved to be really on: state-table row **G3**
  injects a genuine data race into a throwaway module and the step blocks.
- **`-tags relayv2` costs 1 s** and is a strict superset: exactly one file in the
  module carries a build tag and it is a test file, so the tag excludes nothing
  and includes `prekey_bundle_v2_test.go`, which is otherwise silently skipped.
- **No changed-file scoping.** Narrowing selection is the exact defect that made
  the previous gate useless. At 26 s it does not need scoping to stay affordable,
  and a Go-only change is caught because the step is unconditional — which is
  the whole point of T24.

A subset would have been a token guard: the two things worth catching here
(a race, a v2-tagged repository regression) are precisely the two a "fast subset"
would drop.

### 3.3 Failure policy

A missing Go toolchain **blocks** (row G4). It is the same rule the JavaScript
half already applies to a missing package manager: code that cannot be verified
does not get pushed. Making it advisory would reopen the exact hole the step
closes — with a friendlier message.

A tree with no `apps/relay/go.mod` exits 0 with a notice (row G5). That is not a
skip: there is nothing to gate.

---

## 4. T32 — documentation staleness, made mechanical

`scripts/gate/docs-freshness.sh` parses the pinned revision out of
`docs/STATUS_CURRENT.md` (the prose form the document uses today, an explicit
`<!-- status-pin: <sha> -->` marker, or an English fallback), then asks git —
in one pass — for commits in `<pin>..<pushed tip>` touching `apps/` or
`packages/` whose payload is not exclusively markdown or a `docs/` directory.

Live output on this tree:

```
push gate (docs): STALE DOCUMENTATION — 9 behaviour-changing commit(s)
on apps/ or packages/ since docs/STATUS_CURRENT.md was pinned at 4346e2b (tip c5fde09).
   5235a6d  fix: one protocol constant governs message size on both sides of the wire
   … 7 more …
   da24daa  docs: reconcile every document with the tree
Remedy: reconcile the document against the tree, then move its pin —
   Ревизия, к которой относится этот статус, — коммит `c5fde09`
```

It uses the **pushed tip** from git's stdin, not `HEAD` — the mistake that made
the old testing gate ask about the working tree instead of about the push.

### 4.1 Blocks or warns — the decision

Two conditions, deliberately treated differently.

**Drift (code commits exist past the pin) → warns.** Drift appears the moment
anyone commits to `apps/` or `packages/`; it is the normal state of a healthy
repository, and a check that fails every ordinary push is a check that is deleted
or routed around with `--no-verify` within a day — and then it guards nothing.
This is the same judgement T28 §6 reached ("fail the push, **or at minimum emit a
named, visible warning in the gate's own report**"). It is the "at minimum" arm,
and chosen on purpose.

Against "a check nobody sees is not a check": the warning is a boxed banner, it
names each offending commit by subject, it prints the exact replacement pin line
ready to paste, and it is **the last thing the gate prints before the push
proceeds** — the position in a four-minute run where a message is actually read.
It is also runnable on demand as `pnpm run gate:docs`, and
`ECHOLET_DOCS_FRESHNESS_STRICT=1` escalates drift to a block for anyone who wants
that. There is deliberately no variable that weakens anything.

**A broken pin → blocks.** If `STATUS_CURRENT.md` exists but declares no
parseable revision (row D2), or names a revision that is not a commit in this
repository (row D3), the push is blocked. Neither can arise from ordinary work:
writing code does not delete a line from a markdown header. Both mean the
freshness check has been silently defeated — and deleting the pin line is
otherwise the cheapest way to switch this check off without appearing to switch
anything off. It is the one place where a block cannot become routine, so it is
the one place that blocks.

Two deliberate non-blocks: no `STATUS_CURRENT.md` at all (nothing claims a
revision, row D1), and a pin missing because the clone is shallow (the clone is
incomplete, not the document).

### 4.2 Cost

~1 s, one `git log` invocation regardless of how far the pin has fallen behind.
0.4 % of the gate.

---

## 5. The state table, every row exercised

Not a table of intentions: `scripts/gate/selftest.sh` builds a disposable git
repository per row, runs the real gate files against it, and compares exit codes.
It touches no working tree, no git config of this repository, and no remote.

```
$ pnpm run gate:selftest          # ~20 s
state table: 27 ok, 0 wrong, 0 skipped
```

Rows whose toolchain is genuinely absent on a given machine are reported as
`SKIP`, never as a pass — a self-test that goes green because it could not run
is the same class of lie as a gate that goes green because it ran nothing.

| row | state | expected | result |
|---|---|---|---|
| G1 | Go module present, tests green | allow | exit 0 ✓ |
| **G2** | **a failing Go test** | **BLOCK** | exit 1 ✓ |
| **G3** | **a genuine data race** | **BLOCK** | exit 1 ✓ (proves `-race` is really on) |
| **G4** | **no Go toolchain** | **BLOCK** | exit 1 ✓ |
| G5 | no `apps/relay/go.mod` | allow (nothing to gate) | exit 0 ✓ |
| D1 | no `STATUS_CURRENT.md` | allow | exit 0 ✓ |
| **D2** | **pin line deleted** | **BLOCK** | exit 1 ✓ |
| **D3** | **pin names a non-commit** | **BLOCK** | exit 1 ✓ |
| D4 | pin current, no code commit since | allow, "OK" | exit 0 ✓ |
| D5 | code commits past the pin | allow, **warn** | exit 0 ✓ |
| D6 | same drift, `…STRICT=1` | BLOCK | exit 1 ✓ |
| D7 | markdown-only commit past the pin | not drift | exit 0 ✓ |
| J1 | no keryx, npm suite green | allow | exit 0 ✓ |
| J1b | — | the fallback really ran the test script | sentinel observed ✓ |
| J1c | — | keryx really was absent | `keryx command not found` observed ✓ |
| **J1d** | — | **a passing gate reaches the docs step** | `push gate (docs)` observed ✓ — without this, the freshness check would only ever run on pushes that were going to be blocked anyway |
| **J2** | **no keryx, suite red** | **BLOCK** | exit 3 ✓ |
| **J3** | **no keryx and no package manager** | **BLOCK** | exit 1 ✓ (stock hook: exit 0, skipped) |
| **J4** | **keryx present but too old for `test status`** | **fall back, still BLOCK** | exit 4 ✓ |
| **J5** | **`keryx test run --strict` fails** | **BLOCK** | exit 1 ✓ |
| **S1** | **a gate step deleted from the tree** | **BLOCK** | exit 1 ✓ |
| V1 | installed and tracked | verify passes | exit 0 ✓ |
| **V2** | **`core.hooksPath` unset** | **verify FAILS** | exit 1 ✓ |
| V3 | ditto, on push | tripwire announces it | banner observed ✓ |
| V4 | ditto, on push | tripwire runs the gate anyway | gate output observed ✓ |
| **V5** | **gate files untracked** | **verify FAILS** | exit 1 ✓ |
| **V6** | **`pre-push` replaced, marker gone** | **verify FAILS** | exit 1 ✓ |

Plus three rows that cannot be staged in a scratch repository and were exercised
against the live tree:

| row | state | evidence |
|---|---|---|
| **R1** | **clean tree really runs the whole suite** | `scope: project`, `runner: pnpm-script`, `command: pnpm run test`, `durationMs: 215147` in `.metaproject/data/testing/artifacts/latest.json`. Project scope performs no selection, so it cannot report `runner: n/a` and cannot pass vacuously. |
| **R2** | **the real suite is red, so the real gate blocks** | full hook run over the pushed range, twice — before the hardening (`GATE_EXIT=1`, 246 s) and again after every change in this task (`GATE_EXIT=1`, 343 s), both with the Go step green and the report reading `scope: project`, `runner: pnpm-script`, `command: pnpm run test`, `# Test Report: FAIL`. The suite is red by design (nineteen tests specifying unimplemented behaviour); the gate reported that honestly and blocked. |
| **R3** | **a non-zero pre-push hook really stops `git push`** | the environment probe in §1: a real `git push --dry-run` into a throwaway bare repository, hook exiting 1, `PUSH_EXIT=1`, `error: failed to push some refs`. Every "BLOCK" row above rests on this, so it is measured rather than assumed. |

---

## 6. Is the gate weaker anywhere? No.

| situation | stock keryx gate | after the T23 diagnosis | now |
|---|---|---|---|
| clean tree | `SKIPPED`, 0 tests, push allowed | full JS suite | full JS suite **+ Go + docs** |
| dirty tree, JS/TS changed | blocked on a selection failure, 0 tests run | full JS suite | full JS suite + Go + docs |
| dirty tree, Go-only change | passed, 0 tests run | full JS suite, **no Go test** | **Go suite runs, race-enabled** |
| dirty tree, docs-only change | passed, 0 tests run | full JS suite | full suite + **stale-doc warning** |
| a relay defect | invisible | invisible | **blocks** (G2) |
| a data race in the relay | invisible | invisible | **blocks** (G3) |
| keryx missing | skipped, push allowed | project test script | project test script + Go |
| keryx too old | skipped, push allowed | project test script | project test script + Go (J4) |
| no runner at all | skipped, push allowed | blocked | blocked (J3) |
| no Go toolchain | n/a | n/a | **blocked** (G4) |
| a gate step deleted | n/a | exit 127, unexplained | blocked, **named** (S1) |
| `core.hooksPath` unset | n/a | **silently back to the stock hook** | **announced, and gated anyway** (V3/V4) |
| gate files untracked | n/a | **silently absent from every clone** | `hooks:verify` fails (V5) |
| `keryx init` / `update` / `sync install-hooks` | rewrites the gate | rewrites the gate | leaves it byte-identical (§2.1) |

No failure was made advisory. No scope was narrowed. No bypass was added. There
is no environment variable that weakens anything — the only one that exists
(`ECHOLET_DOCS_FRESHNESS_STRICT=1`) strengthens. `--no-verify` was not used, and
nothing was pushed.

The security block's advisory mode is unchanged: it is set by
`.metaproject/security.config.json` (`"mode": "advisory"`), the hook delegates
the mapping entirely to the CLI, and this task neither duplicated nor overrode
it. Its findings — `egress.ssrf-metadata` and `pii.*` in flow reports and
requirements documents — print and allow the push exactly as before, and still
deserve a human look.

---

## 7. Nothing required weakening the gate

Every objective was reachable without softening anything, so there is no
"couldn't do it without weakening X" item. Three things are worth flagging as
outside this task's reach:

1. **Committing the gate is yours.** `.githooks/` and `scripts/` are staged, not
   committed, and pushing is explicitly yours. Until that commit lands, the
   durability guarantee in §2.1 holds only in this checkout — `hooks:verify` says
   so if it is forgotten (V5).
2. **The `core.hooksPath`-points-somewhere-else case** cannot be closed from
   inside the repository (§2.3). Detected, not preventable.
3. **The upstream keryx bugs** listed in the diagnosis (§8 there) are unchanged
   and still worth reporting: `--changed` in a pre-push hook should use the
   pushed range git already supplies; changed-scope selection appends
   repo-relative paths to a recursive workspace `test` script; and
   `no-related-tests-selected` is a selection failure reported as a P0 test
   failure. This repository now routes around all three rather than depending on
   them, so none is blocking.

This task changed no product file and no test under `apps/` or `packages/`, and
nothing under `deploy/` — the uncommitted changes visible there belong to T28 and
to the agent working concurrently in `apps/cli/src`, and were left alone. The
failing-Go-test and data-race rows were staged in throwaway modules under a
temporary directory precisely so that no file in `apps/relay` had to be touched
to prove the Go step blocks. Neither `geekom` nor `depr` was contacted; the only
`git push` invoked anywhere was `--dry-run` into a throwaway bare repository in
the scratch directory. No store key, private key, plaintext or HTTP request body
appears in this report or in anything it wrote; the security step's findings are
referred to by rule name only.

---

## 8. Files

| path | change |
|---|---|
| `.githooks/pre-push` | gate-step existence check; `cd` to the repository root; absolute paths in the keryx fallback; header corrected on "tracked" and extended with the `core.hooksPath` story |
| `.githooks/{post-commit,post-merge,post-checkout}` | unchanged (passthrough shims to keryx's own hooks) |
| `.githooks/keryx-blocks.sha256` | unchanged; both fingerprints re-verified against the live `.git/hooks/pre-push`, including after the tripwire was planted in it |
| `scripts/hooks/install.sh` | installs and refreshes the `core.hooksPath` tripwire in `.git/hooks/pre-push` |
| `scripts/hooks/verify.sh` | tracked-file check; diff against `HEAD` not the index; missing-shim check; tripwire-presence check |
| `scripts/gate/go-tests.sh` | unchanged — verified, measured, and its scope argument re-derived (§3) |
| `scripts/gate/docs-freshness.sh` | drift computed in one `git log` pass instead of one `git diff-tree` per commit; identical output |
| `scripts/gate/selftest.sh` | **new** — the state table, executable |
| `package.json` | `gate:selftest` script added |
| this report, `dispatches/003-T23-implement-result.json` | new |

## 9. Routing audit

- `graph_used`: **no** — *not relevant*. Every file was named by the dispatch or
  by the file being read; no "where does X live" or blast-radius question arose.
- `wiki_used`: **no** — *not relevant*. Hook execution, keryx CLI behaviour and
  shell semantics; no architecture, domain or decision question.
- `ctx_used`: **yes** — `keryx ctx run` for git, timing and probe scripts,
  `keryx ctx read` for reports, configs and the keryx test-report JSON,
  `keryx ctx rg` for every search over project files.
- `raw_rg_used`: **yes, and only outside the repository** — `grep`/`sed` against
  the installed `@mrciphersmith/keryx` bundle (`/opt/homebrew/lib/node_modules/…/dist/cli.js`),
  which is not project code and is not indexed by `keryx ctx rg`, with the reason
  recorded inline via the `# keryx:raw` escape. No raw search ran over project
  code.
