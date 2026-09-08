#!/usr/bin/env sh
# Echolet push gate — self-test (flow 003 / T23, T24, T32).
#
# The gate's state table, executable. Every row that the hardening report claims
# — a failing test blocks, a missing runner blocks, a Go defect is caught, a
# deleted gate step blocks, an unset core.hooksPath is announced and gated
# anyway — is exercised here against disposable git repositories built in a temp
# directory. Nothing in this script touches the working tree, the repository's
# git config, or any remote.
#
# Run it after any change to .githooks/ or scripts/gate/: a gate whose own
# guarantees are only asserted in a document is a gate that quietly rots.
#
#   pnpm run gate:selftest
#
# 44 rows, about 2 minutes: three throwaway Go modules to compile, and the P
# rows each check a commit out and run a suite against it. A row
# whose toolchain is genuinely absent is reported SKIP, never OK: a self-test
# that goes green because it could not run is the same class of lie as a gate
# that goes green because it ran nothing.
# Exit 0 = every row behaved as documented.
#
# What the first 27 rows could not see (flow 003 / T38)
# -----------------------------------------------------
# Every one of them built its scratch repository with the working tree equal to
# HEAD. The gate ran the suites against the working tree; the self-test asked
# about the working tree; the two agreed, and neither could tell you whether the
# gate had ever looked at the commits being pushed. It had not — R2-001. A
# self-test written in the same frame as the thing it tests will always agree
# with it, whatever the frame is.
#
# So the P rows below deliberately break that frame: in each of them the
# committed content and the working tree DISAGREE, and the row says which of the
# two the gate must have obeyed. Where the answer is "it must block", the row
# also asserts the sentinel the suite prints when it actually runs — an exit code
# alone would be satisfied by the gate failing for some unrelated reason (a
# worktree that could not be created, a missing tool), which is exactly how a
# closed hole gets reported as closed while being open.
#
# The rows come in matched pairs on purpose. P1 fails if the gate stops looking
# at the push; P2 fails if it stops looking at the working tree. Deleting either
# half of the fix therefore turns a row red, and no single edit can satisfy both
# by cheating.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
SRC="$(cd "$HERE/../.." && pwd)"
ROOT="${TMPDIR:-/tmp}/echolet-gate-selftest.$$"
rm -rf "$ROOT"
mkdir -p "$ROOT"
trap 'rm -rf "$ROOT"' EXIT INT TERM

pass=0
failn=0
skipped=0

skip() { # skip <id> <why>
  echo "SKIP  $1  $2"
  skipped=$((skipped + 1))
}

check() { # check <id> <actual> <expected> <note>
  if [ "$2" = "$3" ]; then
    echo "OK    $1  exit=$2 (expected $3)  $4"
    pass=$((pass + 1))
  else
    echo "WRONG $1  exit=$2 (expected $3)  $4"
    failn=$((failn + 1))
  fi
}

# --- a scratch repo with the gate copied in ---------------------------------
mkrepo() { # mkrepo <name>
  d="$ROOT/$1"
  mkdir -p "$d/.githooks" "$d/scripts/gate" "$d/scripts/hooks" "$d/docs"
  cp "$SRC/.githooks/pre-push" "$d/.githooks/pre-push"
  cp "$SRC/.githooks/keryx-blocks.sha256" "$d/.githooks/keryx-blocks.sha256"
  cp "$SRC/scripts/gate/go-tests.sh" "$d/scripts/gate/"
  cp "$SRC/scripts/gate/suites.sh" "$d/scripts/gate/"
  cp "$SRC/scripts/gate/pushed-range.sh" "$d/scripts/gate/"
  cp "$SRC/scripts/gate/docs-freshness.sh" "$d/scripts/gate/"
  cp "$SRC/scripts/gate/selftest.sh" "$d/scripts/gate/"
  cp "$SRC/scripts/hooks/install.sh" "$d/scripts/hooks/"
  cp "$SRC/scripts/hooks/verify.sh" "$d/scripts/hooks/"
  # The scratch repo's own copy of suites.sh gets the same treatment as the hook
  # (see neutralise_tool_paths): it carries the `$HOME/.local/bin/keryx`
  # fallback, which no PATH can hide. Without this, every "no keryx" row would
  # quietly find keryx there and stop exercising the fallback route it claims to
  # exercise. Done before the commit, so the scratch tree stays clean.
  neutralise_tool_paths "$d/scripts/gate/suites.sh"
  chmod +x "$d/.githooks/pre-push" "$d/scripts/gate/"*.sh "$d/scripts/hooks/"*.sh
  ( cd "$d" && git init -q . && git config user.email t@e.st && git config user.name T )
  echo "$d"
}

commit_all() { ( cd "$1" && git add -A && git commit -qm "$2" ); }

# A copy of the hook whose hardcoded PATH preamble points nowhere, so that
# "tool not on PATH" cases can actually be staged.
#
# It is written OUTSIDE the scratch repository (T38). Left inside it, this copy
# was an untracked file in every JS row's working tree — which, now that the gate
# asks whether the working tree is the commit being pushed, would have put every
# row on the two-tree path and quietly changed what the rows measure. The hook
# resolves its repository from the cwd, so running it from elsewhere on disk
# gates the same repository.
NOPATH_DIR="$ROOT/nopath"
mkdir -p "$NOPATH_DIR"
nopath_hook() { # nopath_hook <repo> -> path to the PATH-neutralised hook
  echo "$NOPATH_DIR/$(basename "$1")-pre-push"
}
# Rewrite every absolute tool location a gate file names, in place. PATH alone
# cannot stage "this tool is absent": the gate also looks for keryx at the
# hardcoded $HOME/.local/bin/keryx, which is reachable whatever PATH says.
neutralise_tool_paths() { # neutralise_tool_paths <file>
  sed -e 's#/opt/homebrew/bin#/echolet-nope/a#' \
      -e 's#/opt/homebrew/sbin#/echolet-nope/b#' \
      -e 's#/usr/local/bin#/echolet-nope/c#' \
      -e 's#\$HOME/.bun/bin#/echolet-nope/d#' \
      -e 's#\$HOME/.local/bin#/echolet-nope/e#' \
      -e 's#\$HOME/Library/pnpm#/echolet-nope/f#' \
      -e 's#\$HOME/.volta/bin#/echolet-nope/g#' \
      "$1" > "$1.neutralised"
  mv "$1.neutralised" "$1"
  chmod +x "$1"
}
neutralise_path() { # neutralise_path <repo>
  out="$(nopath_hook "$1")"
  cp "$1/.githooks/pre-push" "$out"
  neutralise_tool_paths "$out"
}

REFS_STDIN() { printf 'refs/heads/main %s refs/heads/main 0000000000000000000000000000000000000000\n' "$1"; }

HAVE_GO=no
command -v go >/dev/null 2>&1 && HAVE_GO=yes
HAVE_NPM=no
command -v npm >/dev/null 2>&1 && HAVE_NPM=yes

# ===========================================================================
# GO STEP (T24)
# ===========================================================================
if [ "$HAVE_GO" = "no" ]; then
  skip G1 "no Go toolchain on this machine"
  skip G2 "no Go toolchain on this machine"
  skip G3 "no Go toolchain on this machine"
else
d="$(mkrepo go-pass)"
mkdir -p "$d/apps/relay"
printf 'module scratch/relay\n\ngo 1.21\n' > "$d/apps/relay/go.mod"
printf 'package relay\n\nimport "testing"\n\nfunc TestGreen(t *testing.T) {}\n' > "$d/apps/relay/x_test.go"
REPO_ROOT="$d" sh "$d/scripts/gate/go-tests.sh" >/dev/null 2>&1
check G1 $? 0 "Go module present, tests green -> allowed"

d="$(mkrepo go-fail)"
mkdir -p "$d/apps/relay"
printf 'module scratch/relay\n\ngo 1.21\n' > "$d/apps/relay/go.mod"
printf 'package relay\n\nimport "testing"\n\nfunc TestRed(t *testing.T) { t.Fatal("a relay defect") }\n' > "$d/apps/relay/x_test.go"
REPO_ROOT="$d" sh "$d/scripts/gate/go-tests.sh" >/dev/null 2>&1
check G2 $? 1 "a failing Go test BLOCKS (this is the T24 hole, closed)"

d="$(mkrepo go-race)"
mkdir -p "$d/apps/relay"
printf 'module scratch/relay\n\ngo 1.21\n' > "$d/apps/relay/go.mod"
cat > "$d/apps/relay/x_test.go" <<'EOF'
package relay

import (
	"testing"
)

func TestDataRace(t *testing.T) {
	n := 0
	done := make(chan struct{})
	go func() { n++; close(done) }()
	n++
	<-done
	_ = n
}
EOF
REPO_ROOT="$d" sh "$d/scripts/gate/go-tests.sh" >/dev/null 2>&1
check G3 $? 1 "a data race BLOCKS (proves -race is really on)"
fi

d="$(mkrepo go-missing-toolchain)"
mkdir -p "$d/apps/relay"
printf 'module scratch/relay\n\ngo 1.21\n' > "$d/apps/relay/go.mod"
printf 'package relay\n\nimport "testing"\n\nfunc TestGreen(t *testing.T) {}\n' > "$d/apps/relay/x_test.go"
env PATH=/usr/bin:/bin REPO_ROOT="$d" sh "$d/scripts/gate/go-tests.sh" >/dev/null 2>&1
check G4 $? 1 "no Go toolchain -> BLOCKS, never passes on unrun tests"

d="$(mkrepo go-no-module)"
REPO_ROOT="$d" sh "$d/scripts/gate/go-tests.sh" >/dev/null 2>&1
check G5 $? 0 "no apps/relay/go.mod -> nothing to gate"

# ===========================================================================
# DOCS FRESHNESS (T32)
# ===========================================================================
d="$(mkrepo docs-none)"
printf 'x\n' > "$d/a.txt"; commit_all "$d" c1
REPO_ROOT="$d" sh "$d/scripts/gate/docs-freshness.sh" HEAD >/dev/null 2>&1
check D1 $? 0 "no STATUS_CURRENT.md -> nothing claims a revision"

d="$(mkrepo docs-nopin)"
printf '# status\nno revision here\n' > "$d/docs/STATUS_CURRENT.md"
printf 'x\n' > "$d/a.txt"; commit_all "$d" c1
REPO_ROOT="$d" sh "$d/scripts/gate/docs-freshness.sh" HEAD >/dev/null 2>&1
check D2 $? 1 "pin line deleted -> BLOCKS (the check cannot be silently disabled)"

d="$(mkrepo docs-badpin)"
printf '# status\n<!-- status-pin: deadbeefdeadbeef -->\n' > "$d/docs/STATUS_CURRENT.md"
printf 'x\n' > "$d/a.txt"; commit_all "$d" c1
REPO_ROOT="$d" sh "$d/scripts/gate/docs-freshness.sh" HEAD >/dev/null 2>&1
check D3 $? 1 "pin names a commit not in history -> BLOCKS"

d="$(mkrepo docs-fresh)"
mkdir -p "$d/apps/cli"
printf 'code\n' > "$d/apps/cli/main.ts"
printf '# status\n<!-- status-pin: 0000000 -->\n' > "$d/docs/STATUS_CURRENT.md"
commit_all "$d" c1
sha="$( cd "$d" && git rev-parse HEAD )"
printf '# status\n<!-- status-pin: %s -->\n' "$sha" > "$d/docs/STATUS_CURRENT.md"
commit_all "$d" c2
REPO_ROOT="$d" sh "$d/scripts/gate/docs-freshness.sh" HEAD >/dev/null 2>&1
check D4 $? 0 "pin current, no code commit since -> OK"

d="$(mkrepo docs-drift)"
mkdir -p "$d/apps/cli"
printf 'code\n' > "$d/apps/cli/main.ts"
printf '# status\n<!-- status-pin: 0000000 -->\n' > "$d/docs/STATUS_CURRENT.md"
commit_all "$d" c1
sha="$( cd "$d" && git rev-parse HEAD )"
printf '# status\n<!-- status-pin: %s -->\n' "$sha" > "$d/docs/STATUS_CURRENT.md"
commit_all "$d" c2
printf 'changed behaviour\n' > "$d/apps/cli/main.ts"
commit_all "$d" c3
REPO_ROOT="$d" sh "$d/scripts/gate/docs-freshness.sh" HEAD >/dev/null 2>&1
check D5 $? 0 "code commits past the pin -> WARNS, push proceeds"
REPO_ROOT="$d" ECHOLET_DOCS_FRESHNESS_STRICT=1 sh "$d/scripts/gate/docs-freshness.sh" HEAD >/dev/null 2>&1
check D6 $? 1 "same drift with STRICT=1 -> BLOCKS (opt-in strengthening only)"

# doc-only commit past the pin must NOT count as drift
d="$(mkrepo docs-doconly)"
mkdir -p "$d/apps/cli"
printf 'code\n' > "$d/apps/cli/main.ts"
printf '# status\n<!-- status-pin: 0000000 -->\n' > "$d/docs/STATUS_CURRENT.md"
commit_all "$d" c1
sha="$( cd "$d" && git rev-parse HEAD )"
printf '# status\n<!-- status-pin: %s -->\n' "$sha" > "$d/docs/STATUS_CURRENT.md"
commit_all "$d" c2
printf 'readme\n' > "$d/apps/cli/README.md"
commit_all "$d" c3
REPO_ROOT="$d" sh "$d/scripts/gate/docs-freshness.sh" HEAD >/dev/null 2>&1
check D7 $? 0 "markdown-only commit past the pin -> not drift"

# ===========================================================================
# JS STEP + WHOLE HOOK
# ===========================================================================
mk_js_repo() { # mk_js_repo <name> <test-script-body>
  d="$(mkrepo "$1")"
  printf '{"name":"scratch","private":true,"scripts":{"test":"%s"}}\n' "$2" > "$d/package.json"
  printf '# status\n<!-- status-pin: 0000000 -->\n' > "$d/docs/STATUS_CURRENT.md"
  printf 'x\n' > "$d/a.txt"
  commit_all "$d" c1 >/dev/null 2>&1
  sha="$( cd "$d" && git rev-parse HEAD )"
  printf '# status\n<!-- status-pin: %s -->\n' "$sha" > "$d/docs/STATUS_CURRENT.md"
  commit_all "$d" c2 >/dev/null 2>&1
  neutralise_path "$d"
  echo "$d"
}

# A PATH with a package manager on it but definitively NO keryx.
#
# The bin directory lives outside the scratch repository (T38). Inside it, its
# three symlinks were untracked files in the row's working tree, which now means
# "the working tree is not the commit being pushed" — every row would take the
# two-tree path and no row could exercise the one-tree path at all.
pmbin() { # pmbin <repo, unused: the directory is shared>
  mkdir -p "$ROOT/pmbin"
  for t in npm node npx; do
    p="$(command -v "$t" 2>/dev/null)"
    [ -n "$p" ] && ln -sf "$p" "$ROOT/pmbin/$t"
  done
  echo "$ROOT/pmbin:/usr/bin:/bin"
}

# Same reasoning for the fake keryx binaries some rows put on PATH.
fakebin() { # fakebin <name> -> a directory outside every scratch repo
  mkdir -p "$ROOT/fakebin-$1"
  echo "$ROOT/fakebin-$1"
}

if [ "$HAVE_NPM" = "no" ]; then
  skip J1 "no npm on this machine"
  skip J2 "no npm on this machine"
else
# keryx absent (PATH neutralised and no keryx on PATH), npm present, suite green
d="$(mk_js_repo js-green "echo ECHOLET_TESTS_REALLY_RAN")"
P="$(pmbin "$d")"
out="$( cd "$d" && REFS_STDIN "$( git rev-parse HEAD )" | env PATH="$P" sh "$(nopath_hook "$d")" origin url 2>&1 )"
rc=$?
check J1 $rc 0 "no keryx, npm suite green -> allowed"
case "$out" in
  *ECHOLET_TESTS_REALLY_RAN*) echo "OK    J1b  the fallback really executed the project test script" ; pass=$((pass+1));;
  *) echo "WRONG J1b  fallback did not run the test script"; failn=$((failn+1));;
esac
case "$out" in
  *"keryx command not found"*) echo "OK    J1c  keryx really was absent for this case"; pass=$((pass+1));;
  *) echo "WRONG J1c  keryx was reachable; the no-keryx case was not exercised"; failn=$((failn+1));;
esac
# A green suite must reach step 4; otherwise the freshness check only ever runs
# on pushes that were going to be blocked anyway.
case "$out" in
  *"push gate (docs)"*) echo "OK    J1d  a passing gate reaches the documentation step"; pass=$((pass+1));;
  *) echo "WRONG J1d  the documentation step was never reached"; failn=$((failn+1));;
esac

# keryx absent, suite red
d="$(mk_js_repo js-red "exit 3")"
P="$(pmbin "$d")"
( cd "$d" && REFS_STDIN "$( git rev-parse HEAD )" | env PATH="$P" sh "$(nopath_hook "$d")" origin url >/dev/null 2>&1 )
rc=$?
if [ "$rc" -ne 0 ]; then
  echo "OK    J2  exit=$rc (non-zero)  no keryx, suite red -> BLOCKS"
  pass=$((pass + 1))
else
  echo "WRONG J2  exit=0  a red suite was allowed through the fallback"
  failn=$((failn + 1))
fi
fi

# keryx absent AND no package manager at all
d="$(mk_js_repo js-noruntime "echo hi")"
( cd "$d" && REFS_STDIN "$( git rev-parse HEAD )" | env PATH="/usr/bin:/bin" sh "$(nopath_hook "$d")" origin url >/dev/null 2>&1 )
check J3 $? 1 "nothing can run the suite -> BLOCKS (stock keryx hook: exit 0, skipped)"

# a keryx that exists but cannot run the testing module -> fallback, still gated
if [ "$HAVE_NPM" = "no" ]; then
  skip J4 "no npm on this machine"
else
d="$(mk_js_repo js-oldkeryx "exit 4")"
fb="$(fakebin old)"
printf '#!/usr/bin/env sh\necho "Unknown command: $*" >&2\nexit 1\n' > "$fb/keryx"
chmod +x "$fb/keryx"
P="$(pmbin "$d")"
( cd "$d" && REFS_STDIN "$( git rev-parse HEAD )" | env PATH="$fb:$P" sh "$(nopath_hook "$d")" origin url >/dev/null 2>&1 )
check J4 $? 4 "keryx too old for 'test status' -> falls back and still BLOCKS"
fi

# a working keryx whose test run fails
d="$(mk_js_repo js-keryxfail "echo unused")"
fb="$(fakebin fail)"
cat > "$fb/keryx" <<'EOF'
#!/usr/bin/env sh
case "$1 $2" in
  "test status") exit 0 ;;
  "security status") exit 0 ;;
  "test run") echo "# Test Report: FAIL" >&2; exit 1 ;;
  "security scan") echo "findings: 0"; exit 0 ;;
esac
exit 0
EOF
chmod +x "$fb/keryx"
( cd "$d" && REFS_STDIN "$( git rev-parse HEAD )" | env PATH="$fb:/usr/bin:/bin" sh "$(nopath_hook "$d")" origin url >/dev/null 2>&1 )
check J5 $? 1 "keryx test run --strict fails -> BLOCKS"

# gate step script deleted from the tree.
# The PATH here carries a working package manager on purpose: with none, the
# push would be blocked anyway for want of a runner, and the row would prove
# nothing about the missing step. (T38: it used to run with PATH=/usr/bin:/bin
# and passed for that unrelated reason.)
d="$(mk_js_repo js-nostep "echo hi")"
rm -f "$d/scripts/gate/go-tests.sh"
P="$(pmbin "$d")"
( cd "$d" && REFS_STDIN "$( git rev-parse HEAD )" | env PATH="$P" sh "$(nopath_hook "$d")" origin url >/dev/null 2>&1 )
rc=$?
if [ "$rc" -ne 0 ]; then
  echo "OK    S1  exit=$rc (non-zero)  a deleted gate step BLOCKS"
  pass=$((pass + 1))
else
  echo "WRONG S1  exit=0  a deleted gate step was ignored"
  failn=$((failn + 1))
fi

# the two steps T38 added are steps like any other: deleting one blocks
for _step in suites.sh pushed-range.sh; do
  case "$_step" in suites.sh) id=S2 ;; *) id=S3 ;; esac
  d="$(mk_js_repo "js-nostep-$id" "echo hi")"
  rm -f "$d/scripts/gate/$_step"
  P="$(pmbin "$d")"
  ( cd "$d" && REFS_STDIN "$( git rev-parse HEAD )" | env PATH="$P" sh "$(nopath_hook "$d")" origin url >/dev/null 2>&1 )
  rc=$?
  if [ "$rc" -ne 0 ]; then
    echo "OK    $id  exit=$rc (non-zero)  a deleted scripts/gate/$_step BLOCKS"
    pass=$((pass + 1))
  else
    echo "WRONG $id  exit=0  scripts/gate/$_step could be deleted silently"
    failn=$((failn + 1))
  fi
done
unset _step

# ===========================================================================
# THE PUSHED RANGE (T38) — the rows the first 27 could not express
# ===========================================================================
# Each repo below is built so that the COMMITTED content and the WORKING TREE
# disagree, and each row names which of the two the gate must have obeyed. The
# old gate could not tell them apart, and neither could a self-test that only
# ever built trees equal to HEAD.
mk_split_repo() { # mk_split_repo <name> <committed suite body> <working-tree suite body>
  d="$(mkrepo "$1")"
  printf '{"name":"scratch","private":true,"scripts":{"test":"sh ./suite.sh"}}\n' > "$d/package.json"
  printf '# status\n<!-- status-pin: 0000000 -->\n' > "$d/docs/STATUS_CURRENT.md"
  printf '%s\n' "$2" > "$d/suite.sh"
  commit_all "$d" c1 >/dev/null 2>&1
  sha="$( cd "$d" && git rev-parse HEAD )"
  printf '# status\n<!-- status-pin: %s -->\n' "$sha" > "$d/docs/STATUS_CURRENT.md"
  commit_all "$d" c2 >/dev/null 2>&1
  # working tree only, never committed:
  printf '%s\n' "$3" > "$d/suite.sh"
  neutralise_path "$d"
  echo "$d"
}

if [ "$HAVE_NPM" = "no" ]; then
  skip P1 "no npm on this machine"
  skip P1b "no npm on this machine"
  skip P2 "no npm on this machine"
  skip P2b "no npm on this machine"
  skip P3 "no npm on this machine"
  skip P4 "no npm on this machine"
  skip P4b "no npm on this machine"
  skip P5 "no npm on this machine"
  skip P6 "no npm on this machine"
  skip P7 "no npm on this machine"
  skip P8 "no npm on this machine"
else

# --- P1/P1b: THE hole (R2-001). Committed red, working tree green. ----------
# Before T38 this was exit 0 — reproduced by the independent verifier with
# /tmp/echolet-r2-gate-probe.sh and again in t38-gate-range-report.md §1.
d="$(mk_split_repo range-committed-red \
      'echo "SUITE RAN: committed-red"; exit 1' \
      'echo "SUITE RAN: tree-green"; exit 0')"
P="$(pmbin "$d")"
before_status="$( cd "$d" && git status --porcelain )"
out="$( cd "$d" && REFS_STDIN "$( git rev-parse HEAD )" | env PATH="$P" sh "$(nopath_hook "$d")" origin url 2>&1 )"
rc=$?
if [ "$rc" -ne 0 ]; then
  echo "OK    P1  exit=$rc (non-zero)  committed suite RED, working tree green -> BLOCKS"
  pass=$((pass + 1))
else
  echo "WRONG P1  exit=0  a push whose committed suite is red was allowed (R2-001 is open)"
  failn=$((failn + 1))
fi
# An exit code alone is not evidence: it would also be produced by a worktree
# that could not be created. The committed suite must have actually run.
case "$out" in
  *"SUITE RAN: committed-red"*) echo "OK    P1b  the COMMITTED suite really executed"; pass=$((pass+1));;
  *) echo "WRONG P1b  the block did not come from running the committed suite"; failn=$((failn+1));;
esac

# --- P7/P8: and it left nothing behind --------------------------------------
wt_lines="$( cd "$d" && git worktree list | grep -c . )"
if [ "$wt_lines" = "1" ]; then
  echo "OK    P7   the throwaway worktree was removed (git worktree list: 1)"
  pass=$((pass + 1))
else
  echo "WRONG P7   $wt_lines worktrees left registered after the gate ran"
  failn=$((failn + 1))
fi
after_status="$( cd "$d" && git status --porcelain )"
if [ "$before_status" = "$after_status" ]; then
  echo "OK    P8   the repository's own working tree was not touched"
  pass=$((pass + 1))
else
  echo "WRONG P8   the gate modified the working tree it was verifying"
  failn=$((failn + 1))
fi

# --- P2/P2b: the mirror state. Committed green, working tree RED. -----------
# This row is what stops the fix from being "test the range instead". The gate
# has always blocked a red working tree; it still must.
d="$(mk_split_repo range-tree-red \
      'echo "SUITE RAN: committed-green"; exit 0' \
      'echo "SUITE RAN: tree-red"; exit 1')"
P="$(pmbin "$d")"
out="$( cd "$d" && REFS_STDIN "$( git rev-parse HEAD )" | env PATH="$P" sh "$(nopath_hook "$d")" origin url 2>&1 )"
rc=$?
if [ "$rc" -ne 0 ]; then
  echo "OK    P2  exit=$rc (non-zero)  committed suite green, working tree RED -> still BLOCKS"
  pass=$((pass + 1))
else
  echo "WRONG P2  exit=0  the gate stopped looking at the working tree (a weakening)"
  failn=$((failn + 1))
fi
case "$out" in
  *"SUITE RAN: committed-green"*)
    case "$out" in
      *"SUITE RAN: tree-red"*) echo "OK    P2b  both trees really ran, in that order"; pass=$((pass+1));;
      *) echo "WRONG P2b  the working-tree suite never ran"; failn=$((failn+1));;
    esac ;;
  *) echo "WRONG P2b  the committed suite never ran"; failn=$((failn+1));;
esac

# --- P3: the forgotten `git add` --------------------------------------------
# The committed suite needs a file that exists only as an untracked file on
# disk. The working tree is green; what the remote would receive is not. This
# row also pins the equivalence rule: widen it to ignore untracked files and
# this goes red.
d="$(mk_split_repo range-forgotten-add 'sh ./apps/newmod/dep.sh' 'sh ./apps/newmod/dep.sh')"
mkdir -p "$d/apps/newmod"
printf 'echo "SUITE RAN: dep-green"; exit 0\n' > "$d/apps/newmod/dep.sh"
P="$(pmbin "$d")"
out="$( cd "$d" && REFS_STDIN "$( git rev-parse HEAD )" | env PATH="$P" sh "$(nopath_hook "$d")" origin url 2>&1 )"
rc=$?
if [ "$rc" -ne 0 ]; then
  echo "OK    P3  exit=$rc (non-zero)  a file the commit needs but never added -> BLOCKS"
  pass=$((pass + 1))
else
  echo "WRONG P3  exit=0  an untracked dependency made a broken commit look green"
  failn=$((failn + 1))
fi

# --- P4/P4b: the ordinary case still costs one run --------------------------
# Clean tree, HEAD is the pushed tip, and the only untracked files are the two
# kinds no suite can read. The gate must prove the equivalence and run ONCE:
# without this row, a later change could silently double every push.
# The sentinel is inside suite.sh rather than in the package.json script body,
# so that a package manager echoing the script line does not count as a run.
d="$(mk_split_repo range-equivalent \
      'echo "SUITE RAN: once"; exit 0' \
      'echo "SUITE RAN: once"; exit 0')"
mkdir -p "$d/.metaproject" "$d/docs"
printf '{}\n' > "$d/.metaproject/scratch.json"
printf 'notes\n' > "$d/docs/notes.md"
P="$(pmbin "$d")"
out="$( cd "$d" && REFS_STDIN "$( git rev-parse HEAD )" | env PATH="$P" sh "$(nopath_hook "$d")" origin url 2>&1 )"
rc=$?
check P4 $rc 0 "working tree provably IS the push -> allowed"
ran="$( printf '%s\n' "$out" | grep -c 'SUITE RAN: once' )"
saw_proof=no
case "$out" in *"working tree IS the commit being pushed"*) saw_proof=yes ;; esac
if [ "$ran" = "1" ] && [ "$saw_proof" = "yes" ]; then
  echo "OK    P4b  the suite ran exactly once, on the stated equivalence"
  pass=$((pass + 1))
else
  echo "WRONG P4b  suite ran $ran time(s), equivalence announced: $saw_proof"
  failn=$((failn + 1))
fi

# --- P5: pushing something that is not HEAD ---------------------------------
# The second real-world route into R2-001: the working tree is clean and green,
# but the ref being pushed points at an older, red commit.
d="$(mkrepo range-old-ref)"
printf '{"name":"scratch","private":true,"scripts":{"test":"sh ./suite.sh"}}\n' > "$d/package.json"
printf '# status\n<!-- status-pin: 0000000 -->\n' > "$d/docs/STATUS_CURRENT.md"
printf 'echo "SUITE RAN: old-red"; exit 1\n' > "$d/suite.sh"
commit_all "$d" c1 >/dev/null 2>&1
old_sha="$( cd "$d" && git rev-parse HEAD )"
printf 'echo "SUITE RAN: head-green"; exit 0\n' > "$d/suite.sh"
printf '# status\n<!-- status-pin: %s -->\n' "$old_sha" > "$d/docs/STATUS_CURRENT.md"
commit_all "$d" c2 >/dev/null 2>&1
neutralise_path "$d"
P="$(pmbin "$d")"
out="$( cd "$d" && REFS_STDIN "$old_sha" | env PATH="$P" sh "$(nopath_hook "$d")" origin url 2>&1 )"
rc=$?
if [ "$rc" -ne 0 ] && case "$out" in *"SUITE RAN: old-red"*) true ;; *) false ;; esac; then
  echo "OK    P5  exit=$rc (non-zero)  pushing a ref older than HEAD verifies THAT commit"
  pass=$((pass + 1))
else
  echo "WRONG P5  exit=$rc  the older pushed commit's suite was never run"
  failn=$((failn + 1))
fi

# --- P6: every ref in the push, not just the first --------------------------
d="$(mkrepo range-two-refs)"
printf '{"name":"scratch","private":true,"scripts":{"test":"sh ./suite.sh"}}\n' > "$d/package.json"
printf '# status\n<!-- status-pin: 0000000 -->\n' > "$d/docs/STATUS_CURRENT.md"
printf 'echo "SUITE RAN: main-green"; exit 0\n' > "$d/suite.sh"
commit_all "$d" c1 >/dev/null 2>&1
main_sha="$( cd "$d" && git rev-parse HEAD )"
printf '# status\n<!-- status-pin: %s -->\n' "$main_sha" > "$d/docs/STATUS_CURRENT.md"
commit_all "$d" c2 >/dev/null 2>&1
main_sha="$( cd "$d" && git rev-parse HEAD )"
( cd "$d" && git checkout -q -b side )
printf 'echo "SUITE RAN: side-red"; exit 1\n' > "$d/suite.sh"
commit_all "$d" c3 >/dev/null 2>&1
side_sha="$( cd "$d" && git rev-parse HEAD )"
( cd "$d" && git checkout -q main 2>/dev/null || git checkout -q master )
neutralise_path "$d"
P="$(pmbin "$d")"
out="$( cd "$d" && { REFS_STDIN "$main_sha"; printf 'refs/heads/side %s refs/heads/side 0000000000000000000000000000000000000000\n' "$side_sha"; } |
        env PATH="$P" sh "$(nopath_hook "$d")" origin url 2>&1 )"
rc=$?
if [ "$rc" -ne 0 ] && case "$out" in *"SUITE RAN: side-red"*) true ;; *) false ;; esac; then
  echo "OK    P6  exit=$rc (non-zero)  a second pushed ref is verified too, not skipped"
  pass=$((pass + 1))
else
  echo "WRONG P6  exit=$rc  only the first pushed ref was verified"
  failn=$((failn + 1))
fi
fi

# ===========================================================================
# VERIFY / INSTALL (T23 durability)
# ===========================================================================
d="$(mkrepo verify-ok)"
printf '{"name":"s"}\n' > "$d/package.json"
commit_all "$d" c1 >/dev/null 2>&1
( cd "$d" && sh scripts/hooks/install.sh >/dev/null 2>&1 )
( cd "$d" && sh scripts/hooks/verify.sh >/dev/null 2>&1 )
check V1 $? 0 "installed and tracked -> verify passes"

( cd "$d" && git config --unset core.hooksPath )
( cd "$d" && sh scripts/hooks/verify.sh >/dev/null 2>&1 )
check V2 $? 1 "core.hooksPath unset -> verify FAILS loudly"

# ... and the tripwire still gates that push
mkdir -p "$d/apps"
tw_out="$( cd "$d" && REFS_STDIN "$( git rev-parse HEAD )" | sh .git/hooks/pre-push origin url 2>&1 )"
case "$tw_out" in
  *"THE PUSH GATE IS NOT INSTALLED"*) echo "OK    V3   tripwire announced the disabled gate"; pass=$((pass+1));;
  *) echo "WRONG V3   tripwire silent when core.hooksPath was unset"; failn=$((failn+1));;
esac
case "$tw_out" in
  *"push gate (go)"*|*"push gate (js)"*) echo "OK    V4   tripwire ran the tracked gate anyway"; pass=$((pass+1));;
  *) echo "WRONG V4   tripwire did not run the tracked gate"; failn=$((failn+1));;
esac

( cd "$d" && git config core.hooksPath .githooks )
d2="$(mkrepo verify-untracked)"
printf '{"name":"s"}\n' > "$d2/package.json"
( cd "$d2" && git config core.hooksPath .githooks )
( cd "$d2" && sh scripts/hooks/verify.sh >/dev/null 2>&1 )
check V5 $? 1 "gate present but UNTRACKED -> verify FAILS"

d3="$(mkrepo verify-nomarker)"
printf '{"name":"s"}\n' > "$d3/package.json"
printf '#!/usr/bin/env sh\nexit 0\n' > "$d3/.githooks/pre-push"
chmod +x "$d3/.githooks/pre-push"
commit_all "$d3" c1 >/dev/null 2>&1
( cd "$d3" && git config core.hooksPath .githooks )
( cd "$d3" && sh scripts/hooks/verify.sh >/dev/null 2>&1 )
check V6 $? 1 "pre-push replaced by something without the gate marker -> verify FAILS"

# ===========================================================================
# THE INSTALLER'S BLAST RADIUS (T38, closing R2-012)
# ===========================================================================
# `git rev-parse --git-common-dir` resolves from any linked worktree to the MAIN
# repository's .git. The installer used that to write the tripwire, so a
# `pnpm install` in a throwaway worktree rewrote the main checkout's
# .git/hooks/pre-push — observed by the verifier while merely installing
# dependencies. These rows pin that it no longer does, and that the main
# checkout still installs it (a fix that just stopped writing the tripwire
# everywhere would be a weakening, and I2 is what would catch it).
d="$(mkrepo install-main)"
printf '{"name":"s"}\n' > "$d/package.json"
commit_all "$d" c1 >/dev/null 2>&1
( cd "$d" && sh scripts/hooks/install.sh >/dev/null 2>&1 )
if grep -qF '# echolet:hookspath-tripwire:begin' "$d/.git/hooks/pre-push" 2>/dev/null; then
  echo "OK    I2   the MAIN checkout still installs the core.hooksPath tripwire"
  pass=$((pass + 1))
else
  echo "WRONG I2   the main checkout no longer installs the tripwire"
  failn=$((failn + 1))
fi

if command -v shasum >/dev/null 2>&1; then
  _hash() { shasum -a 256 "$1" 2>/dev/null | awk '{print $1}'; }
elif command -v sha256sum >/dev/null 2>&1; then
  _hash() { sha256sum "$1" 2>/dev/null | awk '{print $1}'; }
else
  _hash() { cksum "$1" 2>/dev/null | awk '{print $1}'; }
fi

hook_before="$(_hash "$d/.git/hooks/pre-push")"
git -c core.hooksPath=/dev/null -C "$d" worktree add --detach -q "$ROOT/install-main-linked" HEAD 2>/dev/null
i1_out="$( cd "$ROOT/install-main-linked" && sh scripts/hooks/install.sh 2>&1 || true )"
hook_after="$(_hash "$d/.git/hooks/pre-push")"
if [ -n "$hook_before" ] && [ "$hook_before" = "$hook_after" ]; then
  echo "OK    I1   install.sh in a linked worktree left the MAIN .git/hooks/pre-push byte-identical"
  pass=$((pass + 1))
else
  echo "WRONG I1   a linked worktree rewrote the main checkout's pre-push hook (R2-012 is open)"
  failn=$((failn + 1))
fi
case "$i1_out" in
  *"linked worktree"*) echo "OK    I1b  and it said so, naming the main checkout"; pass=$((pass+1));;
  *) echo "WRONG I1b  it stayed silent about refusing"; failn=$((failn+1));;
esac
git -C "$d" worktree remove --force "$ROOT/install-main-linked" >/dev/null 2>&1 || true

# ... and the shared config is repository-wide, so a linked worktree does not
# write that either.
d="$(mkrepo install-unset)"
printf '{"name":"s"}\n' > "$d/package.json"
commit_all "$d" c1 >/dev/null 2>&1
git -c core.hooksPath=/dev/null -C "$d" worktree add --detach -q "$ROOT/install-unset-linked" HEAD 2>/dev/null
( cd "$ROOT/install-unset-linked" && sh scripts/hooks/install.sh >/dev/null 2>&1 || true )
cfg_after="$( cd "$d" && git config --get core.hooksPath || true )"
if [ -z "$cfg_after" ]; then
  echo "OK    I3   a linked worktree did not write the repository-wide core.hooksPath"
  pass=$((pass + 1))
else
  echo "WRONG I3   a linked worktree set core.hooksPath='$cfg_after' for the whole repository"
  failn=$((failn + 1))
fi
git -C "$d" worktree remove --force "$ROOT/install-unset-linked" >/dev/null 2>&1 || true

echo ""
echo "state table: $pass ok, $failn wrong, $skipped skipped"
[ "$failn" -eq 0 ]
