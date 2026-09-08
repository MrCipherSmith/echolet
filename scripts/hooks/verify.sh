#!/usr/bin/env sh
# Echolet — is the push gate actually installed and intact? (flow 003 / T23)
#
# The gate's whole failure mode is being quietly absent: git does not clone
# hooks, core.hooksPath is local config that no commit can carry, and the
# previous incarnation of this gate reported "skipped" and allowed pushes for
# days without running a test. This script is how a human or an agent finds out,
# instead of assuming. It runs on every `pnpm install` (via `prepare`) and on
# demand as `pnpm run hooks:verify`.
#
# Exit 1  = the gate is not in force. Exit 0 = in force (warnings may print).
set -u

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || true)"
if [ -z "$REPO_ROOT" ]; then
  echo "echolet hooks: not a git work tree; nothing to verify" >&2
  exit 0
fi
cd "$REPO_ROOT"

fail=0
warn=0

hooks_path="$(git config --get core.hooksPath || true)"
if [ "$hooks_path" != ".githooks" ]; then
  echo "echolet hooks: FAIL — core.hooksPath is '${hooks_path:-unset}', not '.githooks'." >&2
  echo "  git is not running the repository's push gate. Fix: pnpm run hooks:install" >&2
  fail=1
else
  echo "echolet hooks: core.hooksPath = .githooks" >&2
fi

if [ ! -x .githooks/pre-push ]; then
  echo "echolet hooks: FAIL — .githooks/pre-push is missing or not executable." >&2
  echo "  Fix: git checkout -- .githooks && pnpm run hooks:install" >&2
  fail=1
elif ! grep -q '# echolet:push-gate:v1' .githooks/pre-push; then
  echo "echolet hooks: FAIL — .githooks/pre-push does not carry the echolet push-gate" >&2
  echo "  marker; it is not the repository's gate. Fix: git checkout -- .githooks" >&2
  fail=1
else
  for step in scripts/gate/go-tests.sh scripts/gate/suites.sh \
              scripts/gate/pushed-range.sh scripts/gate/docs-freshness.sh; do
    if [ ! -f "$step" ]; then
      echo "echolet hooks: FAIL — gate step $step is missing." >&2
      fail=1
    fi
  done
  if ! git diff HEAD --quiet -- .githooks scripts/gate scripts/hooks 2>/dev/null; then
    echo "echolet hooks: note — .githooks/, scripts/gate/ or scripts/hooks/ differ" >&2
    echo "  from HEAD. That is normal while editing the gate; it is reported so an" >&2
    echo "  accidental local weakening is visible rather than silent." >&2
    warn=1
  fi
fi

# The gate is only durable because it is version-controlled: that is what makes
# it survive a clone, and what makes a weakening show up in a diff instead of in
# nobody's terminal. An untracked .githooks/ looks identical to a tracked one
# from inside this checkout and is invisible everywhere else, so say so.
for tracked_path in .githooks/pre-push scripts/gate/go-tests.sh \
                    scripts/gate/suites.sh scripts/gate/pushed-range.sh \
                    scripts/gate/docs-freshness.sh scripts/gate/selftest.sh \
                    scripts/hooks/install.sh scripts/hooks/verify.sh; do
  if ! git ls-files --error-unmatch "$tracked_path" >/dev/null 2>&1; then
    echo "echolet hooks: FAIL — $tracked_path is NOT tracked by git." >&2
    echo "  It exists in this checkout only. A clone gets no gate at all, and no" >&2
    echo "  review can see a change to it. Fix: git add $tracked_path && commit." >&2
    fail=1
  fi
done

# core.hooksPath replaces .git/hooks wholesale — every hook type, not just
# pre-push. Each keryx hook therefore needs a passthrough shim in .githooks/ or
# it silently stops running. Today that is post-commit, post-merge and
# post-checkout; if keryx ever starts installing another one, this says so
# instead of letting the maintenance hook disappear unnoticed.
hooks_common="$(git rev-parse --git-common-dir 2>/dev/null || true)"
if [ -n "$hooks_common" ] && [ -d "$hooks_common/hooks" ]; then
  for installed in "$hooks_common/hooks"/*; do
    [ -f "$installed" ] || continue
    name="$(basename "$installed")"
    case "$name" in
      *.sample|pre-push) continue ;;
    esac
    if [ ! -f ".githooks/$name" ]; then
      echo "echolet hooks: WARNING — $hooks_common/hooks/$name exists but .githooks/$name" >&2
      echo "  does not, and core.hooksPath = .githooks means git no longer runs it." >&2
      echo "  Add a passthrough shim (copy .githooks/post-commit) so that hook keeps" >&2
      echo "  working, or confirm it is meant to be gone." >&2
      warn=1
    fi
  done
fi

# Is the tripwire in place? It is the only thing that speaks up when
# core.hooksPath has been unset — the gate's single silent failure mode.
tripwire_hook="$(git rev-parse --git-common-dir 2>/dev/null)/hooks/pre-push"
if [ ! -f "$tripwire_hook" ] || ! grep -qF '# echolet:hookspath-tripwire:begin' "$tripwire_hook" 2>/dev/null; then
  echo "echolet hooks: WARNING — the core.hooksPath tripwire is not installed in" >&2
  echo "  $tripwire_hook." >&2
  echo "  Without it, unsetting core.hooksPath silently disables the whole gate and" >&2
  echo "  git falls back to keryx's stock hook, which passes without running tests." >&2
  echo "  Fix: pnpm run hooks:install" >&2
  warn=1
fi

# keryx keeps regenerating .git/hooks/pre-push, which git no longer runs. That
# is harmless, except that the security block vendored into .githooks/pre-push
# is a copy: if keryx ships a new version of its own block, the copy silently
# ages. Compare fingerprints so the divergence is announced instead of found
# later.
fingerprints=".githooks/keryx-blocks.sha256"
git_hook="$(git rev-parse --git-common-dir 2>/dev/null)/hooks/pre-push"
if [ -f "$fingerprints" ] && [ -f "$git_hook" ]; then
  if command -v shasum >/dev/null 2>&1; then
    _sha() { shasum -a 256 | awk '{print $1}'; }
  elif command -v sha256sum >/dev/null 2>&1; then
    _sha() { sha256sum | awk '{print $1}'; }
  else
    _sha() { cat >/dev/null; echo "no-sha-tool"; }
  fi
  while read -r want block; do
    [ -n "${block:-}" ] || continue
    case "$want" in \#*) continue ;; esac
    got="$(awk -v b="$block" '
      $0 == "# keryx:" b ":begin" { on = 1 }
      on { print }
      $0 == "# keryx:" b ":end"   { on = 0 }
    ' "$git_hook" | _sha)"
    if [ -z "$got" ] || [ "$got" = "$(printf '' | _sha)" ]; then
      echo "echolet hooks: note — keryx block '$block' is no longer present in" >&2
      echo "  $git_hook (keryx hooks removed or disabled)." >&2
      warn=1
    elif [ "$got" != "$want" ]; then
      echo "echolet hooks: WARNING — keryx regenerated its '$block' block and it now" >&2
      echo "  differs from the copy vendored into .githooks/pre-push." >&2
      echo "  Review the new block in $git_hook, port any genuine improvement into" >&2
      echo "  .githooks/pre-push, and refresh $fingerprints." >&2
      warn=1
    fi
  done < "$fingerprints"
fi

if [ "$fail" -ne 0 ]; then
  echo "echolet hooks: the push gate is NOT in force." >&2
  exit 1
fi

if [ "$warn" -eq 0 ]; then
  echo "echolet hooks: push gate verified (tracked .githooks/pre-push is live)." >&2
else
  echo "echolet hooks: push gate is in force; see the notes above." >&2
fi
exit 0
