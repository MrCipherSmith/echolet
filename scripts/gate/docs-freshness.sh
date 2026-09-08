#!/usr/bin/env sh
# Echolet push gate — documentation freshness (flow 003 / T32).
#
# What it checks
# --------------
# docs/STATUS_CURRENT.md carries an explicit pinned revision in its header
# ("Ревизия, к которой относится этот статус, — коммит `<sha>`"). Everything the
# file asserts is true *as of that commit*. This script reads the pin, then asks
# git how many commits have landed on apps/ or packages/ since — excluding
# commits that only touch documentation — and reports the answer at the same
# gate that already inspects every push.
#
# Documentation was reconciled twice during flow 003 and went stale both times
# (T7 at 4346e2b, T28 at c5fde09), because behaviour-changing commits landed
# after the pass and nothing anywhere noticed. A third manual pass is the same
# failure mode with a higher number. This turns "the docs are stale" from a fact
# somebody has to remember to go looking for into a fact the gate states out
# loud on every push.
#
# Block or warn — and why
# -----------------------
# Two different conditions, deliberately treated differently:
#
#   DRIFT (code commits exist past the pin)  -> WARN, never blocks.
#     Drift is the normal state of a healthy repository: it appears the moment
#     anyone commits to apps/ or packages/, i.e. on essentially every push. A
#     check that fails every ordinary push is a check that gets deleted, or
#     routed around with --no-verify, within a day — and then it guards nothing.
#     So drift is reported, loudly and by name, as the last thing the gate
#     prints before the push proceeds, with the count, the offending subjects
#     and the one-line remedy.
#
#   BROKEN PIN (the file exists but declares no parseable revision, or names a
#   revision that is not in this repository's history) -> BLOCKS.
#     Neither condition can arise from ordinary work: writing code does not
#     erase a line from a markdown header. Both mean the freshness check itself
#     has been silently defeated, and deleting the pin line is otherwise the
#     easiest way to switch this check off without switching anything off. This
#     is the only place a block cannot become routine, so it is the only place
#     that blocks.
#
# ECHOLET_DOCS_FRESHNESS_STRICT=1 escalates DRIFT to a block as well. It is an
# opt-in strengthening; there is deliberately no variable that weakens anything.
set -u

REPO_ROOT="${REPO_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
DOC_REL="docs/STATUS_CURRENT.md"
DOC="$REPO_ROOT/$DOC_REL"

# The revision being pushed, when the caller knows it (the pre-push hook passes
# the local sha off git's stdin); HEAD otherwise.
TIP="${1:-HEAD}"

if [ ! -f "$DOC" ]; then
  # Nothing claims to describe a revision, so there is nothing to be stale.
  exit 0
fi

# --- read the pin ----------------------------------------------------------
# Preferred, machine-first form: <!-- status-pin: <sha> -->
pin="$(grep -m1 -oE '<!--[[:space:]]*status-pin:[[:space:]]*[0-9a-fA-F]{7,40}[[:space:]]*-->' "$DOC" 2>/dev/null \
        | grep -oE '[0-9a-fA-F]{7,40}' | head -1)"

# Prose form actually used by the document today.
if [ -z "$pin" ]; then
  pin="$(grep -m1 'Ревизия' "$DOC" 2>/dev/null \
          | grep -oE '`[0-9a-fA-F]{7,40}`' | head -1 | tr -d '`')"
fi

# English fallback, in case the header is ever translated.
if [ -z "$pin" ]; then
  pin="$(grep -m1 -iE 'pinned revision|revision this status' "$DOC" 2>/dev/null \
          | grep -oE '`[0-9a-fA-F]{7,40}`' | head -1 | tr -d '`')"
fi

if [ -z "$pin" ]; then
  echo "push gate (docs): FAILED — $DOC_REL exists but declares no pinned revision." >&2
  echo "  The header must carry the commit the status describes, either as" >&2
  echo "    Ревизия, к которой относится этот статус, — коммит \`<sha>\`" >&2
  echo "  or as an explicit marker: <!-- status-pin: <sha> -->" >&2
  echo "  Without it nothing can tell whether the document is current, so the" >&2
  echo "  freshness check would be silently disabled. Push blocked." >&2
  exit 1
fi

# --- validate the pin ------------------------------------------------------
if ! git -C "$REPO_ROOT" cat-file -e "${pin}^{commit}" 2>/dev/null; then
  if [ "$(git -C "$REPO_ROOT" rev-parse --is-shallow-repository 2>/dev/null)" = "true" ]; then
    echo "push gate (docs): WARNING — pinned revision '$pin' is not present in this" >&2
    echo "  shallow clone, so freshness could not be evaluated. Not blocking: the" >&2
    echo "  clone, not the document, is incomplete." >&2
    exit 0
  fi
  echo "push gate (docs): FAILED — $DOC_REL pins revision '$pin', which is not a" >&2
  echo "  commit in this repository. The pin is broken, so the document's claims" >&2
  echo "  cannot be dated and the freshness check cannot run. Push blocked." >&2
  exit 1
fi

# --- measure drift ---------------------------------------------------------
range="${pin}..${TIP}"

# One `git log` pass, not one `git diff-tree` per commit: a pin left unmoved for
# a few hundred commits would otherwise spawn a few hundred git processes at
# every push, and a gate step that gets slower the longer it is ignored is a gate
# step that gets deleted. `--name-only` with a pathspec lists only the changed
# paths under apps/ or packages/, so one awk pass can decide, per commit, whether
# any of them is something other than documentation. The `@@@<sha>` sentinel is
# matched by prefix *and* exact length (3 + 40), so a file literally named `@@@…`
# cannot be mistaken for a commit header. Only substr/length are used, not ERE
# interval syntax, which the awk shipped on macOS has not always supported.
#
# Non-doc payload only: a commit that touches nothing but markdown or a docs/
# directory inside apps/ or packages/ does not invalidate a status claim.
behaviour_commits="$(
  git -C "$REPO_ROOT" log --format='@@@%H' --name-only "$range" -- apps packages 2>/dev/null |
  awk '
    {
      if (substr($0, 1, 3) == "@@@" && length($0) == 43) {
        if (sha != "" && nondoc) print sha
        sha = substr($0, 4); nondoc = 0; next
      }
      if ($0 == "") next
      if ($0 ~ /\.md$/) next
      if ($0 ~ /(^|\/)docs\//) next
      nondoc = 1
    }
    END { if (sha != "" && nondoc) print sha }
  '
)"

count="$(printf '%s\n' "$behaviour_commits" | sed '/^[[:space:]]*$/d' | wc -l | tr -d ' ')"

if [ "$count" -eq 0 ]; then
  echo "push gate (docs): OK — $DOC_REL is pinned at $pin and no behaviour-changing" >&2
  echo "  commit has landed on apps/ or packages/ since." >&2
  exit 0
fi

pin_short="$(git -C "$REPO_ROOT" rev-parse --short "$pin" 2>/dev/null || echo "$pin")"
tip_short="$(git -C "$REPO_ROOT" rev-parse --short "$TIP" 2>/dev/null || echo "$TIP")"

echo "" >&2
echo "=============================================================================" >&2
echo " push gate (docs): STALE DOCUMENTATION — $count behaviour-changing commit(s)" >&2
echo " on apps/ or packages/ since $DOC_REL was pinned at $pin_short (tip $tip_short)." >&2
echo "-----------------------------------------------------------------------------" >&2
shown=0
for sha in $behaviour_commits; do
  if [ "$shown" -ge 12 ]; then
    echo "   … and $((count - shown)) more" >&2
    break
  fi
  git -C "$REPO_ROOT" log -1 --format='   %h  %s' "$sha" >&2
  shown=$((shown + 1))
done
echo "-----------------------------------------------------------------------------" >&2
echo " Every claim in $DOC_REL is dated $pin_short and may no longer hold." >&2
echo " Remedy: reconcile the document against the tree, then move its pin —" >&2
echo "   Ревизия, к которой относится этот статус, — коммит \`$tip_short\`" >&2
echo " This is a WARNING by design: drift is the normal state after any code" >&2
echo " commit, and a gate that failed here would be disabled within a day." >&2
echo "=============================================================================" >&2
echo "" >&2

if [ "${ECHOLET_DOCS_FRESHNESS_STRICT:-0}" = "1" ]; then
  echo "push gate (docs): ECHOLET_DOCS_FRESHNESS_STRICT=1 — treating drift as a failure." >&2
  exit 1
fi

exit 0
