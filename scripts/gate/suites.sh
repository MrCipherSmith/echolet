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
#   2. the JavaScript/TypeScript suite            (blocks)  ~300 s
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
# The JS step lives in its own file (flow 004 / T31). It runs the same suite,
# the same way, through the same routes as before — and additionally checks that
# the run actually REPORTED every test file on disk, completing it serially when
# it did not. See scripts/gate/js-suite.sh for why, and for how a lost report is
# kept distinct from a real failure.
sh "$HERE/js-suite.sh" "$TREE" "$LABEL"
exit $?
