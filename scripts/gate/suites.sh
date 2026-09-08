#!/usr/bin/env sh
# Echolet push gate — the suites, run against one named tree (flow 003 / T38).
#
#   usage:  suites.sh <tree-root> <label>
#
# Why this is a separate file
# ---------------------------
# The gate now runs the suites against two different trees: the commits being
# pushed (materialised into a throwaway worktree by pushed-range.sh) and the
# working tree on disk. Those two runs must be the SAME run — same steps, same
# order, same routes, same blocking policy — or the weaker of the two becomes
# the gate's real strength and nobody notices which one it was. So there is
# exactly one definition of "the suites", here, and both callers use it.
#
# It is always the WORKING TREE's copy of this script that runs, even when the
# tree under test is a pushed commit: the gate is the checkout's gate, pointed
# at different content. A commit cannot bring its own, weaker, gate along.
#
# Steps, in order:
#   1. the Go relay suite, race-enabled           (blocks)   ~26 s
#   2. the JavaScript/TypeScript suite            (blocks)  ~215 s
#
# Go runs first because it is the cheap half: a relay regression is reported in
# half a minute rather than after whatever the JavaScript suite costs that day.
#
# There is no bypass here, no advisory downgrade of a test failure, and no
# changed-file narrowing. If nothing can run a suite, the push is blocked
# rather than left ungated.
set -u

TREE="${1:-}"
LABEL="${2:-${1:-}}"
if [ -z "$TREE" ] || [ ! -d "$TREE" ]; then
  echo "push gate: FAILED — suites.sh needs a tree root; got '${TREE:-}'." >&2
  exit 1
fi
HERE="$(cd "$(dirname "$0")" && pwd)"

echo "push gate: verifying $LABEL" >&2

# --- 1. Go -------------------------------------------------------------------
# Until this step existed no Go test ran in the gate at all — `pnpm -r test`
# walks the pnpm workspace and apps/relay is not in it.
REPO_ROOT="$TREE" sh "$HERE/go-tests.sh" || exit $?

# --- 2. JavaScript / TypeScript ----------------------------------------------
# Fall back to the project's own test script when keryx is missing or too old to
# run the gate. This is a different route to the same suite, not a bypass: it
# still runs every test and still blocks on failure. Only a machine with no
# JavaScript package manager at all cannot be gated, and that blocks the push.
echolet_js_fallback_run() {
  cd "$TREE" || return 1
  if [ -f "$TREE/package.json" ]; then
    if [ -f "$TREE/bun.lockb" ] && command -v bun >/dev/null 2>&1; then
      echo "push gate (js): running fallback test gate: bun run test" >&2
      bun run test
      return $?
    fi
    if [ -f "$TREE/pnpm-lock.yaml" ] && command -v pnpm >/dev/null 2>&1; then
      echo "push gate (js): running fallback test gate: pnpm run test" >&2
      pnpm run test
      return $?
    fi
    if [ -f "$TREE/yarn.lock" ] && command -v yarn >/dev/null 2>&1; then
      echo "push gate (js): running fallback test gate: yarn test" >&2
      yarn test
      return $?
    fi
    if command -v npm >/dev/null 2>&1; then
      echo "push gate (js): running fallback test gate: npm run test" >&2
      npm run test
      return $?
    fi
  fi
  echo "push gate (js): no usable test runner found (no keryx, no package manager);" >&2
  echo "  push blocked rather than left ungated." >&2
  return 1
}

gdm=""
if command -v keryx >/dev/null 2>&1; then
  gdm="keryx"
elif [ -x "$HOME/.local/bin/keryx" ]; then
  gdm="$HOME/.local/bin/keryx"
fi

if [ -z "$gdm" ]; then
  echo "push gate (js): keryx command not found; falling back to the project test script" >&2
  echolet_js_fallback_run
  exit $?
fi

# Probe once, so a keryx that cannot run the testing module is distinguished
# from a failing test suite instead of blocking the push with a confusing error.
# An unusable keryx routes to the fallback gate, never to a skip.
if ! ( cd "$TREE" && "$gdm" test status >/dev/null 2>&1 ); then
  echo "push gate (js): installed keryx cannot run 'test status' (update it);" >&2
  echo "  falling back to the project test script" >&2
  echolet_js_fallback_run
  exit $?
fi

# keryx's stock line — `keryx test run --changed --strict` — cannot gate this
# repository (see .githooks/pre-push and t23-push-gate-diagnosis.md §4): its
# --changed scope is the working tree, not the push, and its changed-scope
# selection is JS/TS-only and fans repo-relative paths out across the workspace.
# Project scope needs no selection: it always resolves the runner and runs the
# whole suite.
( cd "$TREE" && "$gdm" test run --strict )
exit $?
