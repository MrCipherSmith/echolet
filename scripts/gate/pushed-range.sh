#!/usr/bin/env sh
# Echolet push gate — verify the commits being pushed (flow 003 / T38).
#
#   usage:  pushed-range.sh <tip-sha> [<label>]
#
# The hole this closes
# --------------------
# Until T38 the gate's two blocking steps ran the suites against whatever was on
# disk. Git hands a pre-push hook the range being pushed on stdin and the hook
# already read it — but only the security scan and the documentation pin used
# it. So a repository whose COMMITTED suite was red passed the gate whenever the
# working tree happened to be green:
#
#     committed suite at the pushed sha:  echo "SUITE RAN: red";   exit 1
#     working-tree suite:                 echo "SUITE RAN: green"; exit 0
#     ---- gate exit: 0
#
# Reproduced independently as R2-001 (t25-verification-report-r2.md §3.4) and
# again at the top of t38-gate-range-report.md. Two ordinary ways to reach it:
# commit, notice the break, fix it locally without committing, push; or push an
# older branch while the working tree carries newer code.
#
# What this does instead
# ----------------------
# Materialise the pushed commit into a throwaway git worktree under TMPDIR,
# install its dependencies from its own lockfile, and run the same suites there
# (scripts/gate/suites.sh — one definition, both callers). The worktree is
# removed on every exit path, including a signal.
#
# Cost, measured over six runs (t38-gate-range-report.md §4.2): 32.6-51.9 s of
# fixed overhead — a checkout (0.8-5.4 s), an install (20.4-35.1 s), and deleting
# node_modules again afterwards (8.6-16.3 s) — plus the suites themselves. The
# gate pays it only when the working tree is NOT the commit being pushed; when it
# is, .githooks/pre-push proves that and runs the suites once.
#
# The install runs with --ignore-scripts. That is not a shortcut: it means this
# step cannot execute a lifecycle script out of the commit under test — which
# would be arbitrary code from the push running inside the gate that is meant to
# be judging it — and it keeps the root `prepare` script out of the way. If a
# suite genuinely needs a build step, it fails here and the push is blocked;
# that is the safe direction.
set -u

TIP="${1:-}"
if [ -z "$TIP" ]; then
  echo "push gate: FAILED — pushed-range.sh needs the pushed tip sha." >&2
  exit 1
fi
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="${REPO_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
SHORT="$(git -C "$REPO_ROOT" rev-parse --short "$TIP" 2>/dev/null || echo "$TIP")"
LABEL="${2:-the commits being pushed (tip $SHORT)}"

if ! git -C "$REPO_ROOT" rev-parse -q --verify "$TIP^{commit}" >/dev/null 2>&1; then
  echo "push gate: FAILED — $TIP is not a commit in this repository, so the" >&2
  echo "  commits being pushed cannot be verified. Push blocked rather than" >&2
  echo "  left ungated." >&2
  exit 1
fi

WORKTREE="${TMPDIR:-/tmp}/echolet-push-gate.$$.$SHORT"

echolet_range_cleanup() {
  # --force twice: git refuses a worktree with modified or untracked files, and
  # this one always has both by the time the suites are done (node_modules,
  # build output, test scratch). rm -rf plus prune is the fallback for a git too
  # old to take the second --force, so the directory never survives either way.
  git -C "$REPO_ROOT" worktree remove --force --force "$WORKTREE" >/dev/null 2>&1 ||
    rm -rf "$WORKTREE" 2>/dev/null || true
  git -C "$REPO_ROOT" worktree prune >/dev/null 2>&1 || true
}
trap 'echolet_range_cleanup' EXIT INT TERM

rm -rf "$WORKTREE" 2>/dev/null || true

# core.hooksPath=/dev/null for this one invocation: checking out a throwaway
# worktree must not fire the repository's own post-checkout hook (keryx's
# maintenance pass) in the middle of a push.
if ! git -c core.hooksPath=/dev/null -C "$REPO_ROOT" \
       worktree add --detach --quiet "$WORKTREE" "$TIP" >/dev/null 2>&1; then
  echo "push gate: FAILED — could not check $SHORT out into $WORKTREE, so the" >&2
  echo "  commits being pushed cannot be verified. Push blocked rather than" >&2
  echo "  left ungated. (git worktree add --detach $WORKTREE $TIP)" >&2
  exit 1
fi

# --- dependencies, from the pushed commit's own lockfile ---------------------
echolet_range_install() {
  [ -f "$WORKTREE/package.json" ] || return 0
  if [ -f "$WORKTREE/pnpm-lock.yaml" ] && command -v pnpm >/dev/null 2>&1; then
    echo "push gate (deps): pnpm install --frozen-lockfile (at $SHORT)" >&2
    ( cd "$WORKTREE" && pnpm install --frozen-lockfile --prefer-offline \
        --ignore-scripts --reporter=silent )
    return $?
  fi
  if [ -f "$WORKTREE/bun.lockb" ] && command -v bun >/dev/null 2>&1; then
    echo "push gate (deps): bun install --frozen-lockfile (at $SHORT)" >&2
    ( cd "$WORKTREE" && bun install --frozen-lockfile --ignore-scripts )
    return $?
  fi
  if [ -f "$WORKTREE/package-lock.json" ] && command -v npm >/dev/null 2>&1; then
    echo "push gate (deps): npm ci --ignore-scripts (at $SHORT)" >&2
    ( cd "$WORKTREE" && npm ci --ignore-scripts )
    return $?
  fi
  if [ -f "$WORKTREE/yarn.lock" ] && command -v yarn >/dev/null 2>&1; then
    echo "push gate (deps): yarn install --frozen-lockfile (at $SHORT)" >&2
    ( cd "$WORKTREE" && yarn install --frozen-lockfile --ignore-scripts )
    return $?
  fi
  # No lockfile, or no package manager for it: install nothing and let the
  # suites speak. A suite that needs dependencies fails without them, which
  # blocks; a suite that does not need them is unaffected. Nothing is skipped.
  echo "push gate (deps): no lockfile with an available package manager at $SHORT;" >&2
  echo "  running the suites against the checkout as-is." >&2
  return 0
}

if ! echolet_range_install; then
  echo "push gate: FAILED — dependencies for $SHORT could not be installed, so" >&2
  echo "  the commits being pushed cannot be verified. Push blocked rather than" >&2
  echo "  left ungated. A --frozen-lockfile failure means the pushed lockfile" >&2
  echo "  does not match the pushed package.json files; commit the lockfile." >&2
  exit 1
fi

sh "$HERE/suites.sh" "$WORKTREE" "$LABEL"
status=$?

if [ "$status" -ne 0 ]; then
  echo "" >&2
  echo "push gate: FAILED (exit $status) — the COMMITS BEING PUSHED are red at" >&2
  echo "  $SHORT. This is what the remote would receive; your working tree is" >&2
  echo "  not what gets pushed. Commit the fix, then push again." >&2
fi

exit "$status"
