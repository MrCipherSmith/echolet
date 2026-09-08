#!/usr/bin/env sh
# Echolet — point git at the repository's tracked hooks (flow 003 / T23).
#
# Git never clones .git/hooks, and keryx rewrites the blocks it owns inside
# .git/hooks/pre-push on every `keryx init` / `keryx update`. So the gate cannot
# live there. It lives in the tracked directory .githooks/, and this script is
# what makes git use it: `core.hooksPath = .githooks`.
#
# keryx resolves its hook target as `git rev-parse --git-common-dir`/hooks and
# never consults core.hooksPath (verified against the installed bundle and by
# running `keryx init` and `keryx update` against a scratch repository with
# core.hooksPath set: both wrote .git/hooks/* and left .githooks/* byte-identical).
# Once this is set, keryx keeps regenerating a hook git no longer executes, and
# the repository's gate survives untouched.
#
# It runs automatically from the root `prepare` script, i.e. on every
# `pnpm install`, so a fresh clone is gated as soon as anyone installs deps.
#
# Linked worktrees (flow 003 / T38, closing R2-012)
# -------------------------------------------------
# `git rev-parse --git-common-dir` resolves, from ANY linked worktree, to the
# MAIN repository's .git. Until T38 this script used that to write the tripwire —
# so a `pnpm install` inside a throwaway worktree silently rewrote
# <main checkout>/.git/hooks/pre-push, with whatever version of this script that
# worktree happened to be checked out at. An independent verifier hit exactly
# that while merely installing dependencies to run the test suite, and reported
# it (t25-verification-report-r2.md, R2-012).
#
# A helper that reaches out of its own worktree to rewrite a sibling's hooks is
# a surprise waiting to happen, so it no longer does. From a linked worktree
# this script now touches nothing outside that worktree: it reports the shared
# state, names the main checkout and the one command to run there, and lets
# verify.sh have the last word on whether the gate is actually in force.
set -eu

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || true)"
if [ -z "$REPO_ROOT" ]; then
  # Installed from a tarball or in a sandbox with no git: nothing to wire up.
  echo "echolet hooks: not a git work tree; skipping hook installation" >&2
  exit 0
fi

cd "$REPO_ROOT"

if [ ! -d .githooks ]; then
  echo "echolet hooks: .githooks/ is missing from the work tree — the push gate" >&2
  echo "  cannot be installed. Restore it (git checkout -- .githooks) and re-run" >&2
  echo "  'pnpm run hooks:install'." >&2
  exit 1
fi

for hook in .githooks/*; do
  [ -f "$hook" ] || continue
  case "$hook" in
    *.sha256|*.md) continue ;;
  esac
  [ -x "$hook" ] || chmod +x "$hook"
done

# --- whose repository is this? ----------------------------------------------
# In the main worktree, --git-dir and --git-common-dir are the same directory.
# In a linked worktree they are not: --git-dir is .git/worktrees/<name> and
# --git-common-dir is the MAIN checkout's .git. Everything shared — the config
# file and the hooks directory — lives in the latter, which is precisely why
# writing to it from a linked worktree is a cross-checkout side effect.
GIT_DIR_ABS="$(cd "$(git rev-parse --git-dir)" && pwd)"
GIT_COMMON_ABS="$(cd "$(git rev-parse --git-common-dir)" && pwd)"
MAIN_WORKTREE="$(git worktree list --porcelain 2>/dev/null |
                 awk '/^worktree /{ sub(/^worktree /, ""); print; exit }')"
IS_LINKED_WORKTREE=no
if [ "$GIT_DIR_ABS" != "$GIT_COMMON_ABS" ]; then
  IS_LINKED_WORKTREE=yes
fi

current="$(git config --get core.hooksPath || true)"
if [ "$current" != ".githooks" ] && [ "$IS_LINKED_WORKTREE" = "yes" ]; then
  # core.hooksPath is repository-wide: writing it here would change how git
  # behaves in the main checkout and in every other worktree, from a checkout
  # that may not even be at the same commit. Refuse, and say exactly why and
  # what to do. verify.sh, below, then reports the gate as NOT in force — which
  # it is not, in any worktree, until this is run in the main checkout.
  echo "echolet hooks: this is a linked worktree, and core.hooksPath is" >&2
  echo "  '${current:-unset}', not '.githooks'. That setting is repository-wide:" >&2
  echo "  changing it from here would silently change the main checkout too, so" >&2
  echo "  it is left alone." >&2
  echo "  Install the gate once, in the main checkout:" >&2
  echo "     (cd ${MAIN_WORKTREE:-<main checkout>} && pnpm run hooks:install)" >&2
  echo "  It covers every worktree, including this one." >&2
elif [ "$current" != ".githooks" ]; then
  git config core.hooksPath .githooks
  echo "echolet hooks: core.hooksPath -> .githooks (was: ${current:-unset})" >&2
fi

# --- the tripwire -----------------------------------------------------------
# core.hooksPath is local config. No commit carries it, `git clone` does not
# reproduce it, and one `git config --unset core.hooksPath` switches the entire
# gate off without changing a single tracked file. That is the gate's one silent
# failure mode: git then quietly falls back to .git/hooks/pre-push — keryx's
# stock hook, the one that reports SKIPPED and allows a push having run nothing.
#
# So plant a block in .git/hooks/pre-push that only git can reach when the gate
# has been switched off. It says so, loudly, and then execs the tracked gate
# anyway, so the push is still gated while the misconfiguration is announced on
# every push until someone fixes it.
#
# It is written ABOVE keryx's own `# keryx:<id>:begin/end` markers. keryx
# rewrites only what is between its markers and leaves everything else in the
# file alone — verified against `keryx init`, `keryx update --hooks` and
# `keryx sync install-hooks`, all three of which left a planted preamble intact.
#
# It is written only from the MAIN checkout. .git/hooks is shared by every
# worktree, so writing it from a linked worktree rewrites the main checkout's
# hook — with whatever version of this script the worktree is checked out at —
# which is R2-012. From a linked worktree the block is reported, never written.
GIT_COMMON_DIR="$(git rev-parse --git-common-dir 2>/dev/null || true)"
GIT_HOOKS_DIR=""
if [ -n "$GIT_COMMON_DIR" ]; then
  GIT_HOOKS_DIR="$GIT_COMMON_DIR/hooks"
fi
GIT_PRE_PUSH="$GIT_HOOKS_DIR/pre-push"
TRIPWIRE_BEGIN='# echolet:hookspath-tripwire:begin'
TRIPWIRE_END='# echolet:hookspath-tripwire:end'

install_tripwire() {
  mkdir -p "$GIT_HOOKS_DIR" 2>/dev/null || return 0

  # Always rewrite the block rather than skipping when a marker is already
  # present: a tripwire that never updates is a second thing that can silently
  # go stale, which is the class of bug this whole change exists to remove.
  tmp="$GIT_PRE_PUSH.echolet.$$"
  {
    echo '#!/usr/bin/env sh'
    echo "$TRIPWIRE_BEGIN"
    echo '# Installed by scripts/hooks/install.sh (pnpm run hooks:install).'
    echo '# git reaches this file ONLY when core.hooksPath is not .githooks, i.e.'
    echo "# when the repository's tracked push gate has been switched off."
    echo '_echolet_root="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"'
    echo '_echolet_gate="$_echolet_root/.githooks/pre-push"'
    echo 'if [ -f "$_echolet_gate" ]; then'
    echo '  [ -x "$_echolet_gate" ] || chmod +x "$_echolet_gate" 2>/dev/null || true'
    echo '  _echolet_hp="$(git config --get core.hooksPath 2>/dev/null || true)"'
    echo '  echo "" >&2'
    echo '  echo "=============================================================================" >&2'
    echo '  echo " echolet: THE PUSH GATE IS NOT INSTALLED." >&2'
    echo '  echo "   core.hooksPath is \"${_echolet_hp:-unset}\", not \".githooks\", so git ran" >&2'
    echo '  echo "   .git/hooks/pre-push instead of the tracked gate. Running the tracked" >&2'
    echo '  echo "   gate anyway so this push is not left unverified." >&2'
    echo '  echo "   Fix it permanently:  pnpm run hooks:install" >&2'
    echo '  echo "=============================================================================" >&2'
    echo '  echo "" >&2'
    echo '  exec sh "$_echolet_gate" "$@"'
    echo 'fi'
    echo "$TRIPWIRE_END"
    if [ -f "$GIT_PRE_PUSH" ]; then
      # Keep whatever is already there (keryx's managed blocks), minus its
      # shebang and minus any previous copy of this block.
      sed '1{/^#!/d;}' "$GIT_PRE_PUSH" |
        awk -v b="$TRIPWIRE_BEGIN" -v e="$TRIPWIRE_END" '
          $0 == b { skip = 1; next }
          $0 == e { skip = 0; next }
          !skip   { print }
        '
    fi
  } > "$tmp" 2>/dev/null || { rm -f "$tmp"; return 0; }

  chmod +x "$tmp" 2>/dev/null || true
  mv "$tmp" "$GIT_PRE_PUSH" 2>/dev/null || { rm -f "$tmp"; return 0; }
  echo "echolet hooks: core.hooksPath tripwire refreshed in $GIT_PRE_PUSH" >&2
}

if [ "$IS_LINKED_WORKTREE" = "yes" ]; then
  if [ -f "$GIT_PRE_PUSH" ] && grep -qF "$TRIPWIRE_BEGIN" "$GIT_PRE_PUSH" 2>/dev/null; then
    echo "echolet hooks: linked worktree — the core.hooksPath tripwire in" >&2
    echo "  $GIT_PRE_PUSH belongs to the main checkout and is already installed;" >&2
    echo "  left untouched." >&2
  else
    echo "echolet hooks: linked worktree — the core.hooksPath tripwire is NOT" >&2
    echo "  installed in $GIT_PRE_PUSH. That file is shared with the main" >&2
    echo "  checkout, so this worktree will not write it. Install it there:" >&2
    echo "     (cd ${MAIN_WORKTREE:-<main checkout>} && pnpm run hooks:install)" >&2
  fi
elif [ -n "$GIT_HOOKS_DIR" ]; then
  install_tripwire
fi

exec sh "$REPO_ROOT/scripts/hooks/verify.sh"
