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
# 27 rows, about 20 s, most of it compiling three throwaway Go modules. A row
# whose toolchain is genuinely absent is reported SKIP, never OK: a self-test
# that goes green because it could not run is the same class of lie as a gate
# that goes green because it ran nothing.
# Exit 0 = every row behaved as documented.
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
  cp "$SRC/scripts/gate/docs-freshness.sh" "$d/scripts/gate/"
  cp "$SRC/scripts/gate/selftest.sh" "$d/scripts/gate/"
  cp "$SRC/scripts/hooks/install.sh" "$d/scripts/hooks/"
  cp "$SRC/scripts/hooks/verify.sh" "$d/scripts/hooks/"
  chmod +x "$d/.githooks/pre-push" "$d/scripts/gate/"*.sh "$d/scripts/hooks/"*.sh
  ( cd "$d" && git init -q . && git config user.email t@e.st && git config user.name T )
  echo "$d"
}

commit_all() { ( cd "$1" && git add -A && git commit -qm "$2" ); }

# A copy of the hook whose hardcoded PATH preamble points nowhere, so that
# "tool not on PATH" cases can actually be staged.
neutralise_path() { # neutralise_path <repo>
  sed -e 's#/opt/homebrew/bin#/echolet-nope/a#' \
      -e 's#/opt/homebrew/sbin#/echolet-nope/b#' \
      -e 's#/usr/local/bin#/echolet-nope/c#' \
      -e 's#\$HOME/.bun/bin#/echolet-nope/d#' \
      -e 's#\$HOME/.local/bin#/echolet-nope/e#' \
      -e 's#\$HOME/Library/pnpm#/echolet-nope/f#' \
      -e 's#\$HOME/.volta/bin#/echolet-nope/g#' \
      "$1/.githooks/pre-push" > "$1/.githooks/pre-push.nopath"
  chmod +x "$1/.githooks/pre-push.nopath"
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
pmbin() { # pmbin <repo>
  mkdir -p "$1/pmbin"
  for t in npm node npx; do
    p="$(command -v "$t" 2>/dev/null)"
    [ -n "$p" ] && ln -sf "$p" "$1/pmbin/$t"
  done
  echo "$1/pmbin:/usr/bin:/bin"
}

if [ "$HAVE_NPM" = "no" ]; then
  skip J1 "no npm on this machine"
  skip J2 "no npm on this machine"
else
# keryx absent (PATH neutralised and no keryx on PATH), npm present, suite green
d="$(mk_js_repo js-green "echo ECHOLET_TESTS_REALLY_RAN")"
P="$(pmbin "$d")"
out="$( cd "$d" && REFS_STDIN "$( git rev-parse HEAD )" | env PATH="$P" sh "$d/.githooks/pre-push.nopath" origin url 2>&1 )"
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
( cd "$d" && REFS_STDIN "$( git rev-parse HEAD )" | env PATH="$P" sh "$d/.githooks/pre-push.nopath" origin url >/dev/null 2>&1 )
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
( cd "$d" && REFS_STDIN "$( git rev-parse HEAD )" | env PATH="/usr/bin:/bin" sh "$d/.githooks/pre-push.nopath" origin url >/dev/null 2>&1 )
check J3 $? 1 "nothing can run the suite -> BLOCKS (stock keryx hook: exit 0, skipped)"

# a keryx that exists but cannot run the testing module -> fallback, still gated
if [ "$HAVE_NPM" = "no" ]; then
  skip J4 "no npm on this machine"
else
d="$(mk_js_repo js-oldkeryx "exit 4")"
mkdir -p "$d/fakebin"
printf '#!/usr/bin/env sh\necho "Unknown command: $*" >&2\nexit 1\n' > "$d/fakebin/keryx"
chmod +x "$d/fakebin/keryx"
P="$(pmbin "$d")"
( cd "$d" && REFS_STDIN "$( git rev-parse HEAD )" | env PATH="$d/fakebin:$P" sh "$d/.githooks/pre-push.nopath" origin url >/dev/null 2>&1 )
check J4 $? 4 "keryx too old for 'test status' -> falls back and still BLOCKS"
fi

# a working keryx whose test run fails
d="$(mk_js_repo js-keryxfail "echo unused")"
mkdir -p "$d/fakebin"
cat > "$d/fakebin/keryx" <<'EOF'
#!/usr/bin/env sh
case "$1 $2" in
  "test status") exit 0 ;;
  "security status") exit 0 ;;
  "test run") echo "# Test Report: FAIL" >&2; exit 1 ;;
  "security scan") echo "findings: 0"; exit 0 ;;
esac
exit 0
EOF
chmod +x "$d/fakebin/keryx"
( cd "$d" && REFS_STDIN "$( git rev-parse HEAD )" | env PATH="$d/fakebin:/usr/bin:/bin" sh "$d/.githooks/pre-push.nopath" origin url >/dev/null 2>&1 )
check J5 $? 1 "keryx test run --strict fails -> BLOCKS"

# gate step script deleted from the tree
d="$(mk_js_repo js-nostep "echo hi")"
rm -f "$d/scripts/gate/go-tests.sh"
( cd "$d" && REFS_STDIN "$( git rev-parse HEAD )" | env PATH="/usr/bin:/bin" sh "$d/.githooks/pre-push.nopath" origin url >/dev/null 2>&1 )
rc=$?
if [ "$rc" -ne 0 ]; then
  echo "OK    S1  exit=$rc (non-zero)  a deleted gate step BLOCKS"
  pass=$((pass + 1))
else
  echo "WRONG S1  exit=0  a deleted gate step was ignored"
  failn=$((failn + 1))
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

echo ""
echo "state table: $pass ok, $failn wrong, $skipped skipped"
[ "$failn" -eq 0 ]
