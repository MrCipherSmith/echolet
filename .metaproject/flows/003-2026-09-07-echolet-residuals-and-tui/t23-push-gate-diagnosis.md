# T23 — Pre-push test gate: diagnosis and fix

Date: 2026-09-08
Tree at diagnosis: `058bbe9`, working tree clean.

## Summary

The pre-push test gate did not fail for an environmental reason. The hook's
environment is byte-for-byte the one an interactive shell gets — same PATH, same
Node v26.5.0, same bun, same pnpm. The gate failed because
`keryx test run --changed --strict` cannot gate this repository at all: its
changed-scope selection is starved by a stale keryx testing context, its results
are structurally unusable against this repo's `pnpm -r test` root script, and its
notion of "changed" is the working tree rather than the commits being pushed.

The reported "failure" was a *selection* failure being reported as a *test*
failure, with `runner: n/a`, `command: n/a` and no test ever executed.

The gate is now project-scope (`keryx test run --strict`), which resolves the
runner unconditionally and runs the whole suite. That is strictly stronger than
either behaviour it replaces.

## 1. The environment hypothesis is disproven

The lead was that a git hook might see a login-shell Node v22.12.0 (no
`node:sqlite`) or a reduced PATH. It was checked directly rather than assumed, by
running a probe hook through a real `git push --dry-run` with
`git -c core.hooksPath=<tmp> push --dry-run origin main` (the repository's own
hooks untouched):

```
=== cwd: /Users/Goodea/goodea/projects/echolet
=== node: /opt/homebrew/bin/node -> v26.5.0
=== bun:  /Users/Goodea/.bun/bin/bun -> 1.3.12
=== pnpm: /opt/homebrew/bin/pnpm -> 10.0.0
=== keryx: /opt/homebrew/bin/keryx
=== GIT_DIR=unset GIT_INDEX_FILE=unset GIT_WORK_TREE=unset
=== stdin refs:
    refs/heads/main 058bbe9…dcfc2 refs/heads/main 4346e2b…c5869
```

Node in the hook is v26.5.0, not v22.12.0. bun, pnpm, keryx and git all resolve.
The cwd is the repository root and no `GIT_*` variable rewrites the repo view.
Nothing about the hook environment differs from the terminal.

The probe also shows something the fix depends on: git hands the pre-push hook
the exact push range on stdin (`local-sha`, `remote-sha`). The security block
consumes and uses it. The testing block throws it away.

## 2. Why "it passes when I run it by hand" was misleading

The two hand-run commands are not the command the hook runs.

- `keryx test run --strict` — no `--changed`, so **project scope**: it runs
  `pnpm run test` over everything and passes. Different code path entirely.
- `keryx test run --scope changed` — `--scope` takes a *path*, not the word
  `changed`. keryx recorded `selection.changed: false` and
  `changedFiles: ["changed"]` (see
  `.metaproject/data/testing/history/2026-09-07T23-32-08-118Z.json`): the literal
  string `changed` was treated as a path filter that matched no test file, so
  `selectScopeTests` produced an empty selection with `fallback: none`, and the
  runner fell through to the plain project command `pnpm run test`. It ran the
  full suite. Changed-scope selection was never exercised.

Only the hook ran `--changed`, so only the hook hit the defect.

## 3. Deterministic reproduction (no push, no tree mutation)

`--changed` resolves changed files as `git diff --name-only <since>` plus
untracked files, defaulting `<since>` to `HEAD`. With a clean tree that set is
empty, so the gate reports SKIPPED and exits 0. Passing `--since` reproduces the
failing file set exactly, without touching the working tree:

```
$ keryx test run --changed --strict --since HEAD~2
# Test Report: FAIL
scope: changed since HEAD~2
runner: n/a
command: n/a
passed: 0  failed: 1  selected tests: 0
EXIT=1
```

and in `.metaproject/data/testing/artifacts/latest.json`:

```json
"status": "fail", "runner": null, "command": null,
"exitCode": 1, "durationMs": 89,
"counts": {"passed": 0, "failed": 1, "skipped": 0, "total": 11},
"failures": [{
  "name": "no-related-tests-selected",
  "message": "Changed-scope test selection found no related tests (fallback: warn).",
  "priority": "P0"
}]
```

That is the reported push failure verbatim: `runner: n/a`, `command: n/a`,
`total: 11`, one synthetic failure, ~100 ms. The original push run is preserved
at `.metaproject/data/testing/history/2026-09-07T23-24-50-352Z.json` and matches
field for field.

## 4. Root cause

Three defects compose. The first two make the gate impossible to satisfy; the
third makes it impossible to trust even when satisfied.

### 4.1 The keryx testing context was stale, and `total: 11` is the tell

`.metaproject/data/testing/context.json` was generated `2026-09-06T09:22:42Z` and
knew **11** test files — none of them under `apps/cli`. keryx reports
`counts.total = context.testFiles.length` when no command is resolved, which is
why the failure said `total: 11` while the repository actually has 61 test files.

Selection therefore could not map `apps/cli/src/transport/relayClient.ts` to
`apps/cli/src/transport/relayClient.test.ts` — it did not know that file existed.
With zero tests selected, `resolveTestCommand` returns `null`
(`if (input.changed && tests.length === 0) return null;`), so no runner, no
command, 120 ms.

The strict failure then fires:

```js
if (input.strict && input.changed && !command &&
    selectedTests.fallback !== "none" && changedTestableSource) { … fail … }
```

`changedTestableSource` was true only because one `.ts` file was in the set. The
Go files, the docs and the `.metaproject/flows/**` artifacts that made up most of
the change are invisible to selection: keryx's `SOURCE_FILE_RE` is
`/\.[cm]?[tj]sx?$/` and `TEST_FILE_RE` is JS/TS-only, so no Go change can ever
select a test. `apps/relay/internal/config/max_message_bytes_config_test.go` — a
test file, changed in that very push — selected nothing.

The post-commit hook had been printing `testing context may be stale; run
'keryx test analyze' explicitly` for two days. That warning was the same root
cause announcing itself. It is non-mutating by design, so nothing acted on it.

### 4.2 Even with a fresh context, changed scope cannot run in this repo

After `keryx test analyze` (11 → 61 test files) the same reproduction resolves a
runner and selects 19 tests — and still fails, for a second, independent reason:

```
command: pnpm run test apps/cli/src/runtime/inbound.batchIsolation.test.ts … (19 paths)
```

The root `test` script is `pnpm -r test`. keryx appends the selected
repo-relative paths to it, so pnpm fans them out to every workspace package as
vitest filters, and each package resolves them against its own directory:

```
Scope: 7 of 8 workspace projects
packages/protocol test$ vitest run "apps/cli/src/runtime/inbound.batchIsolation.test.ts" …
packages/protocol test: No test files found, exiting with code 1
 ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL
```

Changed-scope selection is structurally incompatible with a recursive workspace
`test` script. No repository configuration fixes that — the only lever would be
rewriting the root `test` script to re-group paths per package, which changes
what `pnpm test` means for everyone.

(Useful side effect: this run is direct proof that a non-zero test command
propagates to a non-zero keryx exit and therefore blocks the push.)

### 4.3 `--changed` is the wrong question for a pre-push hook

`--changed` means *uncommitted work*, not *the commits being pushed*. So the
stock gate has two failure modes and no correct one:

- clean tree → nothing selected → `SKIPPED`, exit 0. **The push is allowed
  without a single test running.** Verified: `git push --dry-run origin main`
  against the pre-fix hook reported `# Test Report: SKIPPED`, and the push was
  allowed. Every commit in the range went ungated.
- dirty tree with any `.ts` change → §4.1 → hard block.

Neither tests the push. The one thing that would — the range on stdin — is
discarded by this block.

## 5. Whose hook is this

The gate belongs to **keryx**, not to this repository. It is generated by
`renderTestingPrePushHook()` in the installed
`@mrciphersmith/keryx/dist/cli.js` and written by `installManagedHook`, which
replaces everything between `# keryx:testing-pre-push:begin` and
`# keryx:testing-pre-push:end` on `keryx init` and `keryx update`.

`.metaproject/testing.config.json` exposes only `hooks.prePushGate: true|false`.
There is **no supported per-repository setting for the gate's scope** — the
choices keryx offers are the broken changed-scope gate or no gate. So the repo's
options are:

1. patch the managed block in `.git/hooks/pre-push` (done — see §6), accepting
   that `keryx init` / `keryx update` will silently revert it;
2. report upstream (recommended, see §8).

`.git/hooks/**` is not tracked by git, so this fix does not travel with a clone.
Anyone else working on this repository must re-apply it.

## 6. What changed

Only git hooks and one stale generated artifact. No test, no file under `apps/`
or `packages/`, no acceptance criterion was touched.

### `.git/hooks/pre-push`

- **New repository-owned PATH preamble**, placed *before* every keryx marker so
  `keryx update` cannot remove it (`# echolet:hook-path-preamble:begin/end`).
  It appends — never prepends, so an explicit caller PATH still wins — the usual
  tool directories (`~/.bun/bin`, `~/.local/bin`, `~/Library/pnpm`,
  `~/.volta/bin`, `/opt/homebrew/{bin,sbin}`, `/usr/local/bin`). This was not the
  cause here, but keryx is a `#!/usr/bin/env bun` script and a hook launched from
  a GUI client, an IDE or launchd would otherwise fail in a way that looks like a
  code failure. It benefits the security block too, which runs first.

- **`keryx:testing-pre-push` block rewritten**:
  - `keryx test run --changed --strict` → `keryx test run --strict`
    (project scope). Project scope performs no selection, so it always resolves
    the runner and always runs the whole suite. It cannot report `runner: n/a`
    and it cannot pass vacuously.
  - the same PATH hardening repeated inside the function, so the gate stays
    robust even if the preamble is lost to an edit;
  - a capability probe (`keryx test status`) mirroring the one the security block
    already has, so a keryx too old to run the testing module is distinguished
    from a failing suite;
  - **a fallback gate, not a bypass**: if keryx is missing or unusable, the hook
    runs the project's own test script directly (`bun`/`pnpm`/`yarn`/`npm`,
    chosen by lockfile) and still blocks on failure;
  - **if nothing can run the tests, the push is blocked**, where the stock hook
    printed `skipped testing gate` and returned 0;
  - a comment block recording why the stock line cannot gate this repo and
    pointing here, so a future reader does not "restore" the bug.

### `.git/hooks/post-commit`

- The same repository-owned PATH preamble, for the same reason. The post-commit
  blocks silently degrade to `keryx command not found` under a reduced PATH,
  which would mean a silently unrebuilt gdgraph. Behaviour is otherwise
  unchanged; all post-commit blocks remain non-blocking by design.

### `.metaproject/data/testing/context.{json,md}`, `recommendations.md`

- Refreshed with `keryx test analyze` (a supported refresh command). 11 → 61 test
  files. This is what the post-commit warning had been asking for. These are
  tracked files and are left modified in the working tree for you to commit.

## 7. Proof

**Before** — `git push --dry-run origin main`, pre-fix hook, clean tree:

```
# Test Report: SKIPPED
scope: changed   runner: n/a   command: n/a
passed: 0  failed: 0  selected tests: 0
```

Push allowed with nothing tested. With a dirty tree the same hook produced the
`FAIL / runner: n/a / total: 11` block quoted in §3.

**After** — `git push --dry-run origin main`, same clean tree:

```
# Test Report: PASS
scope: project
runner: pnpm-script
command: pnpm run test
passed: 3  failed: 0  selected tests: 0
```

`PUSH_EXIT=0`, and the report json confirms the suite genuinely ran:

```json
"status": "pass", "scope": "project", "runner": "pnpm-script",
"command": "pnpm run test", "exitCode": 0, "durationMs": 157928
```

158 seconds of real test execution, against 120 ms of resolving nothing. Nothing
was pushed; `--dry-run` was used throughout.

**The gate still blocks.** Three checks, run against a copy of the hook with the
PATH preamble neutralised so keryx really could not be found:

| case | condition | exit | meaning |
|---|---|---|---|
| A | keryx absent, `pnpm run test` passes | 0 | push allowed, tests actually ran |
| B | keryx absent, `pnpm run test` fails | 1 | push blocked |
| C | keryx absent, no package manager | 1 | push blocked (stock hook: exit 0, skipped) |

And on the primary path, §4.2's run is direct evidence that a non-zero test
command yields `EXIT=1` from `keryx test run --strict`, which the hook
propagates.

**Is the gate weaker?** No — it is strictly stronger in every state:

| situation | before | after |
|---|---|---|
| clean tree | SKIPPED, 0 tests run, push allowed | full suite runs, blocks on failure |
| dirty tree, JS/TS changed | blocked on a selection failure, 0 tests run | full suite runs, blocks on failure |
| dirty tree, Go/docs only | passed without running tests | full suite runs, blocks on failure |
| keryx missing | gate skipped, push allowed | project test script runs, blocks on failure |
| no runner at all | gate skipped, push allowed | push blocked |

Nothing was disabled, narrowed, made advisory, or given a bypass. `--no-verify`
was not used anywhere.

**Would a push now proceed?** Yes. `git push --dry-run origin main` exits 0 with
the full suite green. Pushing `4346e2b..058bbe9` is yours to do.

## 8. Not fixed / open items

1. **The fix does not survive `keryx init` or `keryx update`.** Those rewrite
   everything between the `# keryx:testing-pre-push:` markers. If a push starts
   failing again with `runner: n/a`, the block was regenerated; re-apply §6. The
   PATH preambles live outside the markers and do survive.

2. **`.git/hooks/**` is not version-controlled.** A fresh clone gets keryx's
   stock hook. There is no repo-tracked hooks directory today; if this should
   travel, the repository needs a checked-in hooks dir plus `core.hooksPath`,
   which is a separate decision.

3. **Upstream report to keryx** — three concrete bugs, all reproducible here:
   (a) `--changed` in a *pre-push* hook should use the pushed range that git
   already supplies on stdin, not the working tree; as written the gate passes
   vacuously on a clean tree;
   (b) changed-scope selection appends repo-relative paths to the root `test`
   script, which is wrong for any recursive workspace script such as
   `pnpm -r test`; it should run per package with package-relative paths;
   (c) `no-related-tests-selected` is a selection failure reported as a P0 test
   failure with `runner: n/a` — under `--strict` it should either fall back to
   the full suite or say plainly that selection, not the code, failed.
   A `hooks.prePushScope` setting in `testing.config.json` would also remove the
   need to patch a managed block.

4. **The Go suite is still outside the gate.** `pnpm -r test` does not run
   `apps/relay`, and keryx's selection is JS/TS-only, so no Go change can ever
   select a test. The change that triggered this whole episode was mostly Go.
   Adding `go -C apps/relay test -race -count=1 -tags relayv2 ./...` to the
   pre-push block would be a real strengthening; it was left out deliberately
   because it adds a toolchain dependency and push latency, and that is your
   call, not a defect fix.

5. **`keryx test analyze` must be re-run when test files are added.** The gate no
   longer depends on the context being fresh (project scope needs no selection),
   but `keryx test related`, the coverage map and the reported counts all do. The
   post-commit hook warns; nothing refreshes it automatically. It was left
   non-mutating rather than made to rewrite tracked files mid-commit.

6. **Reported counts are cosmetic.** `passed: 3` on a full run is keryx parsing
   `N pass` out of pnpm's aggregate output, not a test count. The gate keys on
   the runner's exit code, which is correct; only the number in the report is
   uninformative.

7. **The security gate is advisory by configuration**
   (`.metaproject/security.config.json` `"mode": "advisory"`), so its findings —
   `egress.ssrf-metadata` and `secrets.high-entropy` in
   `docs/requirements/echolet-cli-prototype/**` — print and allow the push. That
   is a deliberate existing setting and was not changed. The findings themselves
   deserve a human look; switching the mode to `enforced` would block the current
   push until they are resolved or waived.

## Routing audit

- `graph_used`: no — not-relevant. The question was about hook execution and
  keryx CLI behaviour, not about code structure or blast radius.
- `wiki_used`: no — not-relevant. No architecture, domain or decision question
  arose.
- `ctx_used`: yes — `keryx ctx run` for git/find/ls, `keryx ctx read` for hook
  logs, dry-run output and configs.
- `raw_rg_used`: yes, and only outside the repository — `grep`/`sed` against the
  installed `@mrciphersmith/keryx/dist/cli.js` (the bundle implementing the gate,
  not project code and not indexed by `keryx ctx rg`) and against a scratch test
  harness under the session scratchpad. No raw search was run over project code.
