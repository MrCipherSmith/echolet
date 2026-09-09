#!/usr/bin/env sh
# Echolet push gate — the JavaScript/TypeScript step (flow 004 / T31).
#
#   usage:  js-suite.sh <tree-root> [<label>]
#
# Why this file exists
# --------------------
# The JS half of the gate used to be eleven lines at the bottom of suites.sh:
# resolve a runner, run the whole suite, propagate the exit code. That is still
# what happens on an ordinary push, and nothing about how the suite runs has
# changed. What is new is what happens when the run comes back INCOMPLETE.
#
# The condition, measured three times with identical numbers on 2026-09-09
# (10-core Mac carrying the operator's VM and browser; load averages
# 11.22 / 29.17 / 57.96 at the time of measurement):
#
#     Test Files  75 passed (77)
#          Tests  496 passed (517)
#         Errors  5-6 errors, every one of them
#                 Error: [vitest-worker]: Timeout calling "onTaskUpdate"
#     exit 1, ZERO failing tests
#
# The same tree with --no-file-parallelism: 77 of 77 files, 517 of 517 tests,
# exit 0 (504 s against 296 s). The two files that lose their reports are in
# apps/cli/src/runtime and pass in isolation: 2 files, 21 tests, exit 0.
# 496 + 21 = 517. So the cause is vitest 3.0.8's own worker->main RPC deadline
# expiring on a starved worker — not a flaky test, not machine noise, and not
# anything a vitest option can raise (the 60 s ceiling is hardcoded). The suite
# crossing 77 files is what turned an occasional loss into a reliable one.
# First recorded in flow 003 (t40-suite-regression-report.md §1 and the T43
# note in flow 001); this is the second time it has cost a day.
#
# The gate was right to refuse that run: from outside, a lost report and a
# hidden failure look identical. But refusing was all it could do, so every
# push was blocked.
#
# What this step does instead
# ---------------------------
# It finishes the job rather than refusing it:
#
#   1. run the suite exactly as before — same command, same parallelism,
#      same whole-suite scope, same route;
#   2. read the run's own output and ask whether every test file on disk
#      reported;
#   3. if some did not, re-run PRECISELY those files, serially
#      (--no-file-parallelism), and require them to be green;
#   4. pass only when every test file in every workspace package has been
#      reported green, across the parallel run plus the serial completion.
#
# A run that reports everything never reaches step 3 and costs nothing beyond
# reading a log file. A run that loses reports is COMPLETED rather than
# abandoned — which is stricter than the old behaviour, not looser, because the
# old behaviour was to give up.
#
# What this step is NOT
# ---------------------
# It is not "treat lost reports as a pass". Nothing is inferred about a file
# that did not report; the file is RUN, and its result is what decides. Two
# independent conditions must both hold before the completion path is even
# entered:
#
#   * the run reported no failing test and no failing file anywhere, and
#   * every error the run raised is a worker-RPC report-loss error
#     (`[vitest-worker]: Timeout calling "..."`), with the count of recognised
#     ones equal to vitest's own `Errors N errors` tally.
#
# Any other error — an unhandled rejection from product code, a crashed global
# setup, a build failure — blocks exactly as it did before, without any re-run
# being attempted. The gate names the one condition it knows how to finish and
# refuses to finish any other. That narrowing is deliberate: it is what keeps
# an asynchronous real defect, raised by a file that already reported green,
# from being swallowed by a completion pass.
#
# Answers to the three questions this design has to answer, stated where a
# later reader meets them:
#
#   * "the files whose reports were lost" means, per workspace package, the set
#     difference between the test files vitest itself resolves on disk
#     (`vitest list --filesOnly`, the same config and the same include globs the
#     run used) and the files that printed a report line in the run. It is NOT
#     taken from the "This error originated in ..." attribution vitest prints
#     with the RPC error: that names the file whose worker was blocked, which
#     in the measured runs was not the same as the files that lost their
#     reports. A workspace package that produced no vitest tally at all — one
#     `pnpm -r` never reached because it stopped at the failure, say — is not
#     completed and not assumed: a failing run carrying any such package BLOCKS,
#     naming it, because a package that never ran must never be mistaken for a
#     package that passed.
#
#   * if the re-run also loses a report, the push is BLOCKED. There is one
#     completion pass and no second chance: the re-run is already the
#     configuration measured at 77 of 77, and if even that cannot produce a
#     report then nothing here distinguishes the state from a hidden failure.
#
#   * a file that legitimately fails still blocks, and cannot be mistaken for a
#     lost report, because a failing file REPORTS. It prints its own report
#     line carrying `failed`, and it lands in the `Test Files ... failed` tally.
#     Both are checked before anything else, and either one blocks immediately
#     with no completion attempted. A lost report is the absence of a line; a
#     failure is the presence of one. They are not the same observation and the
#     gate never has to guess between them.
#
# Failure policy: every path that cannot answer the question blocks. An
# unreadable log on a failing run blocks (as before). A package whose file set
# cannot be enumerated blocks. A missing set that is empty while the run failed
# blocks — the gate does not invent an explanation for a failure it cannot
# name. The single exception is stated at `echolet_js_unobservable_green`.
#
# `pnpm run gate:selftest` exercises every state named above (rows L1-L8).
set -u

TREE="${1:-}"
LABEL="${2:-${1:-}}"
if [ -z "$TREE" ] || [ ! -d "$TREE" ]; then
  echo "push gate (js): FAILED — js-suite.sh needs a tree root; got '${TREE:-}'." >&2
  exit 1
fi
HERE="$(cd "$(dirname "$0")" && pwd)"
: "${HERE:=.}"

WORK="${TMPDIR:-/tmp}/echolet-gate-js.$$"
rm -rf "$WORK" 2>/dev/null || true
mkdir -p "$WORK" || { echo "push gate (js): FAILED — cannot create $WORK" >&2; exit 1; }
ECHOLET_JS_KEEP=0
echolet_js_cleanup() {
  # The logs are the evidence for whatever this step decided. They are kept
  # whenever the decision was anything other than "the run was complete and
  # green", and their location is printed with the decision.
  [ "$ECHOLET_JS_KEEP" = "1" ] || rm -rf "$WORK" 2>/dev/null || true
}
trap 'echolet_js_cleanup' EXIT INT TERM

OBS="$WORK/suite.log"

# ---------------------------------------------------------------------------
# 1. Run the suite — unchanged from what the gate has always run.
# ---------------------------------------------------------------------------
# Fall back to the project's own test script when keryx is missing or too old to
# run the gate. This is a different route to the same suite, not a bypass: it
# still runs every test and still blocks on failure. Only a machine with no
# JavaScript package manager at all cannot be gated, and that blocks the push.
echolet_js_fallback_run() {
  # The fallback route writes its own observation, so the completeness check
  # works on it too. `tee` keeps the operator's terminal exactly as loud as it
  # was before; the exit status is captured inside the pipeline's left-hand
  # side, because the status of a pipeline is the status of its LAST command
  # and `tee` always succeeds.
  cd "$TREE" || return 1
  if [ -f "$TREE/package.json" ]; then
    if [ -f "$TREE/bun.lockb" ] && command -v bun >/dev/null 2>&1; then
      echo "push gate (js): running fallback test gate: bun run test" >&2
      { bun run test 2>&1; echo $? > "$WORK/rc"; } | tee "$OBS"
      return "$(cat "$WORK/rc")"
    fi
    if [ -f "$TREE/pnpm-lock.yaml" ] && command -v pnpm >/dev/null 2>&1; then
      echo "push gate (js): running fallback test gate: pnpm run test" >&2
      { pnpm run test 2>&1; echo $? > "$WORK/rc"; } | tee "$OBS"
      return "$(cat "$WORK/rc")"
    fi
    if [ -f "$TREE/yarn.lock" ] && command -v yarn >/dev/null 2>&1; then
      echo "push gate (js): running fallback test gate: yarn test" >&2
      { yarn test 2>&1; echo $? > "$WORK/rc"; } | tee "$OBS"
      return "$(cat "$WORK/rc")"
    fi
    if command -v npm >/dev/null 2>&1; then
      echo "push gate (js): running fallback test gate: npm run test" >&2
      { npm run test 2>&1; echo $? > "$WORK/rc"; } | tee "$OBS"
      return "$(cat "$WORK/rc")"
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
  suite_rc=$?
elif ! ( cd "$TREE" && "$gdm" test status >/dev/null 2>&1 ); then
  # Probe once, so a keryx that cannot run the testing module is distinguished
  # from a failing test suite instead of blocking the push with a confusing
  # error. An unusable keryx routes to the fallback gate, never to a skip.
  echo "push gate (js): installed keryx cannot run 'test status' (update it);" >&2
  echo "  falling back to the project test script" >&2
  echolet_js_fallback_run
  suite_rc=$?
else
  # keryx's stock line — `keryx test run --changed --strict` — cannot gate this
  # repository (see .githooks/pre-push and t23-push-gate-diagnosis.md §4): its
  # --changed scope is the working tree, not the push, and its changed-scope
  # selection is JS/TS-only and fans repo-relative paths out across the
  # workspace. Project scope needs no selection: it always resolves the runner
  # and runs the whole suite.
  #
  # keryx does not stream the suite's output to its own stdout — it captures it
  # and prints a summary — so the observation is taken from the raw log keryx
  # writes, whose path is named by the normalized report it just produced.
  # Verified on this machine: `keryx test run --strict` in a scratch project
  # emitted nine summary lines and zero lines of the child's output, and
  # .metaproject/data/testing/artifacts/latest.json carried rawLogPath.
  touch "$WORK/started"
  ( cd "$TREE" && "$gdm" test run --strict )
  suite_rc=$?

  raw=""
  raw_rel="$(
    node -e '
      const fs = require("fs");
      try {
        const j = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
        if (typeof j.rawLogPath === "string") process.stdout.write(j.rawLogPath);
      } catch {}
    ' "$TREE/.metaproject/data/testing/artifacts/latest.json" 2>/dev/null || true
  )"
  [ -n "$raw_rel" ] || raw_rel=".metaproject/data/testing/logs/latest.raw.log"
  case "$raw_rel" in
    /*) raw="$raw_rel" ;;
    *)  raw="$TREE/$raw_rel" ;;
  esac
  # Freshness, not just existence: a log left over from an earlier run would
  # answer a question about a different tree. `find -newer` compares against the
  # marker touched immediately before the run started.
  if [ -f "$raw" ] && [ -n "$(find "$raw" -newer "$WORK/started" 2>/dev/null)" ]; then
    cp "$raw" "$OBS" 2>/dev/null || : > "$OBS"
  else
    : > "$OBS"
  fi
fi

# ---------------------------------------------------------------------------
# 2. Can this run be observed at all?
# ---------------------------------------------------------------------------
echolet_js_unobservable_green() {
  # The one place this step is deliberately no stricter than the gate was
  # before. If the suite exited 0 but its output could not be read, the
  # completeness question cannot be asked. Blocking here would put every push
  # at the mercy of keryx renaming a log file, and a gate nobody trusts is
  # worse than one that is occasionally too lax. It is also no weaker than the
  # old gate, which never asked the question at all — and it is unreachable by
  # the condition this change is about, which always exits 1.
  echo "" >&2
  echo "push gate (js): the suite passed, but its output could not be read, so" >&2
  echo "  completeness was NOT verified. Allowing the push, exactly as the gate" >&2
  echo "  did before this check existed. If this persists, the observation route" >&2
  echo "  is broken and the check is silently doing nothing — fix it." >&2
}

if [ ! -s "$OBS" ]; then
  if [ "$suite_rc" -eq 0 ]; then
    echolet_js_unobservable_green
    exit 0
  fi
  echo "" >&2
  echo "push gate (js): FAILED (exit $suite_rc) — and the run's output could not be" >&2
  echo "  read, so the gate cannot tell a real failure from a lost report. Push" >&2
  echo "  blocked, which is what the gate has always done here." >&2
  ECHOLET_JS_KEEP=1
  exit "$suite_rc"
fi

# ---------------------------------------------------------------------------
# 3. Read the run.
# ---------------------------------------------------------------------------
# The parser turns vitest's own reporter output — as pnpm prefixes it in a
# recursive run — into four kinds of fact, one per line:
#
#   T <pkg> <reported> <total> <failed>   the `Test Files` tally
#   E <pkg> <n>                           the `Errors N errors` tally
#   R <pkg>                               one recognised worker-RPC loss error
#   F <pkg> <path> <failed>               one file that reported
#
# It never needs colour handling in practice (output is piped, so vitest emits
# none) but strips ANSI anyway, because a future TTY-capturing route would
# otherwise turn every path into a non-match and every run into "incomplete".
#
# Every pattern that would need a "/" or a parenthesis inside a regex literal is
# written as a dynamic regex with bracket expressions instead. A "/" inside an
# awk regex literal ends the literal, and a backslash inside a bracket
# expression means different things in different awks; both mistakes fail
# SILENTLY here, by matching nothing — which would report a complete run as
# incomplete, or worse, a failing file as one that never reported.
ECHOLET_JS_AWK='
function strip(s) { gsub(/\033\[[0-9;]*[A-Za-z]/, "", s); return s }
{
  line = strip($0)
  dir = DEF
  # `pnpm -r` prefixes every child line with "<dir> test: ", and announces each
  # package it starts with "<dir> test$ <command>".
  p = index(line, " test: ")
  q = index(line, " test$ ")
  if (q > 0 && (p == 0 || q < p)) {
    d = substr(line, 1, q - 1)
    if (d !~ / /) { print "S " d; next }
  }
  if (p > 0) {
    d = substr(line, 1, p - 1)
    if (d !~ / /) { dir = d; line = substr(line, p + 7) }
  }

  if (match(line, /Test Files +/)) {
    rest = substr(line, RSTART + RLENGTH)
    total = -1
    if (match(rest, "[(][0-9]+[)]")) total = substr(rest, RSTART + 1, RLENGTH - 2) + 0
    head = rest; sub("[(].*", "", head)
    n = split(head, seg, "[|]")
    rep = 0; fail = 0
    for (i = 1; i <= n; i++) {
      if (match(seg[i], /[0-9]+/)) {
        v = substr(seg[i], RSTART, RLENGTH) + 0
        rep += v
        if (seg[i] ~ /failed/) fail += v
      }
    }
    if (total < 0) total = rep
    print "T " dir " " rep " " total " " fail
    next
  }
  if (line ~ /^ *Errors +[0-9]+ error/) {
    match(line, /[0-9]+ error/)
    print "E " dir " " (substr(line, RSTART, RLENGTH) + 0)
    next
  }
  if (line ~ "[[]vitest-worker[]]: Timeout calling") { print "R " dir; next }

  # A file report line: an optional status glyph, a path, then " (N tests...)".
  if (match(line, "[-A-Za-z0-9_@.+/]+[.](test|spec)[.][A-Za-z]+ [(]")) {
    head = substr(line, 1, RSTART - 1)
    gsub(/ /, "", head)
    # Only a status glyph (three bytes of UTF-8) may sit in front of the path;
    # anything longer is prose that happens to mention a test file.
    if (length(head) <= 3) {
      pathtok = substr(line, RSTART, RLENGTH - 2)
      tail = substr(line, RSTART + RLENGTH - 1)
      sub("[)].*", "", tail)
      print "F " dir " " pathtok " " ((tail ~ /failed/) ? 1 : 0)
    }
  }
}
'
awk -v DEF="." "$ECHOLET_JS_AWK" "$OBS" > "$WORK/facts" 2>/dev/null || : > "$WORK/facts"

# The packages the suite was supposed to cover, from the workspace definition
# rather than from the run — a package the run never reached must still be
# accounted for.
echolet_js_expected_packages() {
  node -e '
    const fs = require("fs"), path = require("path");
    const root = process.argv[1];
    const globs = [];
    const ws = path.join(root, "pnpm-workspace.yaml");
    if (fs.existsSync(ws)) {
      let inPkgs = false;
      for (const raw of fs.readFileSync(ws, "utf8").split("\n")) {
        if (/^packages:/.test(raw)) { inPkgs = true; continue; }
        if (inPkgs) {
          const m = /^\s+-\s*["\x27]?([^"\x27#]+?)["\x27]?\s*$/.exec(raw);
          if (m) { globs.push(m[1]); continue; }
          if (/^\S/.test(raw)) inPkgs = false;
        }
      }
    }
    if (globs.length === 0) {
      try {
        const p = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
        if (Array.isArray(p.workspaces)) globs.push(...p.workspaces);
      } catch {}
    }
    const dirs = [];
    for (const g of globs) {
      if (g.endsWith("/*")) {
        const base = g.slice(0, -2);
        let entries = [];
        try { entries = fs.readdirSync(path.join(root, base), { withFileTypes: true }); } catch {}
        for (const e of entries) if (e.isDirectory()) dirs.push(base + "/" + e.name);
      } else if (!g.includes("*")) {
        dirs.push(g);
      } else {
        // A glob shape this gate does not understand. Refuse rather than guess
        // which packages it covers.
        console.error("unsupported workspace glob: " + g);
        process.exit(2);
      }
    }
    if (dirs.length === 0) dirs.push(".");
    const out = [];
    for (const d of dirs) {
      try {
        const p = JSON.parse(fs.readFileSync(path.join(root, d, "package.json"), "utf8"));
        if (p.scripts && typeof p.scripts.test === "string" && p.scripts.test.trim()) out.push(d);
      } catch {}
    }
    if (out.length) process.stdout.write(out.join("\n") + "\n");
  ' "$1"
}

if ! command -v node >/dev/null 2>&1; then
  echo "push gate (js): FAILED — node is not on PATH, so the workspace cannot be" >&2
  echo "  enumerated and the run's completeness cannot be checked. Push blocked." >&2
  ECHOLET_JS_KEEP=1
  exit 1
fi
echolet_js_expected_packages "$TREE" > "$WORK/expected" 2>"$WORK/expected.err"
if [ ! -s "$WORK/expected" ]; then
  echo "push gate (js): FAILED — no workspace package with a test script could be" >&2
  echo "  identified under $TREE, so there is nothing to check the run against." >&2
  echo "  Push blocked rather than passed on an unverifiable run." >&2
  [ -s "$WORK/expected.err" ] && sed 's/^/    /' "$WORK/expected.err" >&2
  ECHOLET_JS_KEEP=1
  exit 1
fi

# ---------------------------------------------------------------------------
# 4. A real failure blocks here, before anything else is considered.
# ---------------------------------------------------------------------------
# A failing file REPORTS: it prints its own line carrying `failed` and lands in
# the `Test Files ... failed` tally. That presence is what separates it from a
# lost report, which is an absence. Neither of these two checks can be
# satisfied by a report that never arrived, so no failure can be re-labelled as
# a loss and completed away.
fail_files="$(awk '$1 == "T" && $5 + 0 > 0 { s += $5 } END { print s + 0 }' "$WORK/facts")"
fail_lines="$(awk '$1 == "F" && $4 + 0 > 0 { n++ } END { print n + 0 }' "$WORK/facts")"
if [ "$fail_files" -gt 0 ] || [ "$fail_lines" -gt 0 ]; then
  echo "" >&2
  echo "push gate (js): FAILED (exit $suite_rc) — the suite reported failing tests." >&2
  echo "  $fail_files failing file(s) in the tally, $fail_lines failing file report line(s)." >&2
  echo "  This is a real failure, not a lost report, and no completion pass is" >&2
  echo "  attempted for it. Full output: $OBS" >&2
  ECHOLET_JS_KEEP=1
  [ "$suite_rc" -ne 0 ] && exit "$suite_rc"
  exit 1
fi

# ---------------------------------------------------------------------------
# 5. Did every package report every file it has?
# ---------------------------------------------------------------------------
# A package is ASSESSABLE only if it printed a vitest `Test Files` tally. That
# is not a formality: the gate has to work for a repository whose test script is
# not vitest at all (the self-test's own scratch repositories are exactly that),
# and for such a suite there is no per-file reporting to be complete or
# incomplete. For those packages the exit code decides, which is precisely what
# the gate did before this step existed — no weaker, and no pretence of a check
# that did not happen.
expected_n="$(awk 'END { print NR + 0 }' "$WORK/expected")"
: > "$WORK/assessed"
: > "$WORK/unassessed"
: > "$WORK/short"
while IFS= read -r pkg; do
  [ -n "$pkg" ] || continue
  if awk -v p="$pkg" '$1 == "T" && $2 == p { f = 1 } END { exit f ? 0 : 1 }' "$WORK/facts"; then
    printf '%s\n' "$pkg" >> "$WORK/assessed"
    if awk -v p="$pkg" '$1 == "T" && $2 == p && $3 + 0 < $4 + 0 { f = 1 } END { exit f ? 0 : 1 }' "$WORK/facts"; then
      printf '%s\n' "$pkg" >> "$WORK/short"
    fi
  else
    printf '%s\n' "$pkg" >> "$WORK/unassessed"
  fi
done < "$WORK/expected"
assessed_n="$(awk 'END { print NR + 0 }' "$WORK/assessed")"
unassessed_n="$(awk 'END { print NR + 0 }' "$WORK/unassessed")"
short_n="$(awk 'END { print NR + 0 }' "$WORK/short")"

if [ "$assessed_n" -eq 0 ]; then
  # Nothing in this run reports per test file, so there is no completeness
  # question to ask of it. Exactly the pre-T31 gate.
  if [ "$suite_rc" -eq 0 ]; then
    exit 0
  fi
  echo "" >&2
  echo "push gate (js): FAILED (exit $suite_rc) — the suite is red. No test file" >&2
  echo "  reporting was found in its output, so there is nothing to complete;" >&2
  echo "  push blocked. Full output: $OBS" >&2
  ECHOLET_JS_KEEP=1
  exit "$suite_rc"
fi

# The cheap pass: every reporting package reported everything it collected, and
# the suite passed. No subprocess runs, so an ordinary push pays nothing for any
# of the machinery below.
if [ "$short_n" -eq 0 ] && [ "$suite_rc" -eq 0 ]; then
  exit 0
fi

# From here on the run is either failing or short of a report, and the step
# spends real time to find out which.
ECHOLET_JS_KEEP=1
echo "" >&2
echo "push gate (js): the run did not obviously report everything (exit $suite_rc;" >&2
echo "  $assessed_n of $expected_n package(s) reported per file, $short_n of those" >&2
echo "  short of their own file count)." >&2
echo "  Working out which test files did not report, rather than guessing." >&2
echo "  Run output kept at: $OBS" >&2

# A package that reports per file elsewhere in this workspace but produced no
# tally here either never ran or never finished. Neither can be completed from
# the outside, and neither may be assumed green.
if [ "$unassessed_n" -gt 0 ] && [ "$suite_rc" -ne 0 ]; then
  echo "" >&2
  echo "push gate (js): FAILED — these workspace package(s) produced no test file" >&2
  echo "  report at all, so the gate cannot say whether they ran:" >&2
  sed 's/^/    /' "$WORK/unassessed" >&2
  echo "  A package that never ran is not a package that passed. Push blocked." >&2
  exit "$suite_rc"
fi

# Every error the run raised must be a worker-RPC report-loss error, and there
# must be exactly as many recognised ones as vitest counted. An unhandled
# rejection from product code, a crashed setup file, anything else at all — the
# step stops here and blocks, exactly as the gate did before it existed.
err_tally="$(awk '$1 == "E" { s += $3 } END { print s + 0 }' "$WORK/facts")"
err_known="$(awk '$1 == "R" { n++ } END { print n + 0 }' "$WORK/facts")"
if [ "$err_tally" -ne "$err_known" ]; then
  echo "" >&2
  echo "push gate (js): FAILED — the run raised $err_tally error(s), of which only" >&2
  echo "  $err_known are the vitest worker-RPC report loss this gate knows how to" >&2
  echo "  finish. The rest are unexplained, so the push is blocked and no" >&2
  echo "  completion pass is attempted. Full output: $OBS" >&2
  [ "$suite_rc" -ne 0 ] && exit "$suite_rc"
  exit 1
fi

# The missing set, per package: what vitest resolves on disk minus what
# reported. `vitest list --filesOnly` is used rather than a glob of the gate's
# own, so the file set is the one the run itself would have used — same config,
# same include patterns, same root.
echolet_js_vitest_bin() { # <tree> <pkg>
  for _c in "$1/$2/node_modules/.bin/vitest" "$1/node_modules/.bin/vitest"; do
    if [ -x "$_c" ]; then echo "$_c"; return 0; fi
  done
  return 1
}

: > "$WORK/plan"
blocked=0
while IFS= read -r pkg; do
  [ -n "$pkg" ] || continue
  safe="$(printf '%s' "$pkg" | tr '/.' '__')"
  # Only the packages that came up short are enumerated. A package that
  # reported every file it collected has already answered the question, and
  # asking vitest again would put a subprocess on the ordinary path for nothing.
  vb="$(echolet_js_vitest_bin "$TREE" "$pkg" || true)"
  if [ -z "$vb" ]; then
    echo "push gate (js): FAILED — no vitest binary for package '$pkg', so its test" >&2
    echo "  files cannot be enumerated and its part of the run cannot be verified." >&2
    blocked=1
    continue
  fi
  if ! ( cd "$TREE/$pkg" && "$vb" list --filesOnly ) > "$WORK/ondisk.$safe" 2>"$WORK/ondisk.$safe.err"; then
    echo "push gate (js): FAILED — 'vitest list --filesOnly' failed in '$pkg', so the" >&2
    echo "  gate cannot say which test files exist there. See $WORK/ondisk.$safe.err" >&2
    blocked=1
    continue
  fi
  sort -u "$WORK/ondisk.$safe" | sed '/^[[:space:]]*$/d' > "$WORK/ondisk.$safe.sorted"

  awk -v p="$pkg" '$1 == "F" && $2 == p { print $3 }' "$WORK/facts" |
    sort -u > "$WORK/reported.$safe"

  ondisk_n="$(awk 'END { print NR + 0 }' "$WORK/ondisk.$safe.sorted")"
  reported_n="$(awk 'END { print NR + 0 }' "$WORK/reported.$safe")"

  # Cross-check against vitest's own arithmetic where there is a tally to check
  # against. If the gate and vitest disagree about how many files exist, or
  # about how many reported, the gate is reading the run wrongly and must not
  # act on it.
  t_total="$(awk -v p="$pkg" '$1 == "T" && $2 == p { print $4; exit }' "$WORK/facts")"
  t_rep="$(awk -v p="$pkg" '$1 == "T" && $2 == p { print $3; exit }' "$WORK/facts")"
  if [ -n "$t_total" ]; then
    if [ "$t_total" -ne "$ondisk_n" ] || [ "$t_rep" -ne "$reported_n" ]; then
      echo "push gate (js): FAILED — the gate and vitest disagree about '$pkg':" >&2
      echo "  vitest says $t_rep of $t_total files, the gate reads $reported_n of $ondisk_n." >&2
      echo "  The gate does not act on a run it is reading wrongly. Push blocked." >&2
      blocked=1
      continue
    fi
  fi

  comm -23 "$WORK/ondisk.$safe.sorted" "$WORK/reported.$safe" > "$WORK/missing.$safe"
  missing_n="$(awk 'END { print NR + 0 }' "$WORK/missing.$safe")"
  if [ "$missing_n" -gt 0 ]; then
    if grep -q '[[:space:]]' "$WORK/missing.$safe"; then
      echo "push gate (js): FAILED — a test file path in '$pkg' contains whitespace," >&2
      echo "  which this step cannot pass to vitest as a filter. Push blocked." >&2
      blocked=1
      continue
    fi
    printf '%s\n' "$pkg" >> "$WORK/plan"
    echo "  $pkg: $missing_n of $ondisk_n test file(s) did not report" >&2
  fi
done < "$WORK/short"

if [ "$blocked" -ne 0 ]; then
  echo "push gate (js): push blocked; nothing was assumed about the unread files." >&2
  exit 1
fi

if [ ! -s "$WORK/plan" ]; then
  # Every file reported, and none of them failed — yet the run did not exit 0.
  # There is no story here the gate can tell, so it tells none and blocks.
  if [ "$suite_rc" -ne 0 ]; then
    echo "" >&2
    echo "push gate (js): FAILED (exit $suite_rc) — every test file reported and none" >&2
    echo "  failed, yet the suite did not pass. The gate cannot name the cause, so it" >&2
    echo "  does not guess: push blocked. Full output: $OBS" >&2
    exit "$suite_rc"
  fi
  # Exit 0 with a tally shortfall the per-package check could not confirm:
  # nothing to complete, and nothing wrong.
  ECHOLET_JS_KEEP=0
  exit 0
fi

# ---------------------------------------------------------------------------
# 6. Finish the job: re-run precisely the files that did not report, serially.
# ---------------------------------------------------------------------------
# --no-file-parallelism is the configuration measured at 77 of 77 files and
# 517 of 517 tests on this machine. It is used HERE, for a handful of files,
# rather than for the whole gate, because the parallel run is also the only
# thing in this project that stresses cross-file interference: making the gate
# serial would buy a green light by dropping coverage.
echo "" >&2
echo "push gate (js): completing the run — the files that did not report are being" >&2
echo "  run again, serially. They must be green; nothing is assumed about them." >&2

while IFS= read -r pkg; do
  [ -n "$pkg" ] || continue
  safe="$(printf '%s' "$pkg" | tr '/.' '__')"
  vb="$(echolet_js_vitest_bin "$TREE" "$pkg")"
  filters="$(tr '\n' ' ' < "$WORK/missing.$safe")"
  echo "" >&2
  echo "push gate (js): $pkg — vitest run --no-file-parallelism $filters" >&2
  # shellcheck disable=SC2086
  ( cd "$TREE/$pkg" && "$vb" run --no-file-parallelism $filters ) > "$WORK/rerun.$safe" 2>&1
  rerun_rc=$?
  cat "$WORK/rerun.$safe" >&2

  awk -v DEF="$pkg" "$ECHOLET_JS_AWK" "$WORK/rerun.$safe" > "$WORK/rerunfacts.$safe" 2>/dev/null ||
    : > "$WORK/rerunfacts.$safe"

  if [ "$rerun_rc" -ne 0 ]; then
    echo "" >&2
    echo "push gate (js): FAILED — the completion run for '$pkg' exited $rerun_rc." >&2
    echo "  The files that did not report in the parallel run are not green when run" >&2
    echo "  on their own. Push blocked. Output: $WORK/rerun.$safe" >&2
    exit "$rerun_rc"
  fi

  r_fail="$(awk '$1 == "T" && $5 + 0 > 0 { s += $5 } END { print s + 0 }' "$WORK/rerunfacts.$safe")"
  r_rep="$(awk '$1 == "T" { print $3; exit }' "$WORK/rerunfacts.$safe")"
  r_tot="$(awk '$1 == "T" { print $4; exit }' "$WORK/rerunfacts.$safe")"
  if [ -z "$r_rep" ] || [ "$r_fail" -gt 0 ] || [ "$r_rep" -ne "$r_tot" ]; then
    echo "" >&2
    echo "push gate (js): FAILED — the completion run for '$pkg' did not itself report" >&2
    echo "  completely (${r_rep:-no} of ${r_tot:-?} files, $r_fail failing). A serial" >&2
    echo "  re-run that also loses a report is indistinguishable from a hidden" >&2
    echo "  failure, and there is no second retry: push blocked." >&2
    echo "  Output: $WORK/rerun.$safe" >&2
    exit 1
  fi

  # Every file the gate asked for must appear, by name, in the re-run's own
  # report. vitest's positional arguments are filename FILTERS, not paths; this
  # is what proves the filter actually selected the file rather than silently
  # matching nothing.
  awk '$1 == "F" { print $3 }' "$WORK/rerunfacts.$safe" | sort -u > "$WORK/reran.$safe"
  unrun="$(comm -23 "$WORK/missing.$safe" "$WORK/reran.$safe")"
  if [ -n "$unrun" ]; then
    echo "" >&2
    echo "push gate (js): FAILED — the completion run for '$pkg' never reported these" >&2
    echo "  files it was asked to run:" >&2
    printf '%s\n' "$unrun" | sed 's/^/    /' >&2
    echo "  Push blocked; an unrun file is not a passing file." >&2
    exit 1
  fi
  echo "push gate (js): $pkg — completion run green, every requested file reported." >&2
done < "$WORK/plan"

echo "" >&2
echo "push gate (js): the run is COMPLETE. Every test file in every workspace" >&2
echo "  package reported, and none failed — the parallel run plus the serial" >&2
echo "  completion above. Evidence: $WORK" >&2
exit 0
