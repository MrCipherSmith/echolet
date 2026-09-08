#!/usr/bin/env sh
# Echolet push gate — Go step (flow 003 / T24).
#
# Why this exists
# ---------------
# The JavaScript half of the gate runs `pnpm -r test`, which iterates the pnpm
# workspace. `apps/relay` is a Go module and is not a pnpm workspace package, so
# `pnpm -r test` has never run a single Go test. keryx's changed-scope selection
# is JS/TS-only as well (SOURCE_FILE_RE / TEST_FILE_RE), so no Go change could
# ever select a test either. Until this script existed, a relay defect could be
# pushed with the gate reporting a pass.
#
# Scope decision
# --------------
# The whole matrix runs, unconditionally, with the race detector on:
#
#     go test -race -count=1 -tags relayv2 ./...
#
#   * `-race` because the relay's guarantees are concurrency guarantees
#     (exactly-one-winner prekey claim, cleanup-service shutdown join); a
#     non-race run does not test the property the code is about. Measured cost
#     of `-race` over a plain run: ~1 s (24.6 s vs 23.2 s warm) — there is no
#     honest reason to drop it.
#   * `-tags relayv2` because `internal/storage/repository/prekey_bundle_v2_test.go`
#     is behind that build tag and is otherwise silently skipped. No file in the
#     module is excluded *by* the tag, so the tagged run is a strict superset.
#   * `-count=1` because Go caches test results; without it a green line can be
#     a replay of a run that happened against different code.
#   * No changed-file scoping. Narrowing selection is precisely the defect that
#     made the previous gate useless (see t23-push-gate-diagnosis.md §4). At
#     ~25 s warm this does not need scoping to stay affordable.
#
# Failure policy
# --------------
# A missing Go toolchain BLOCKS. It is the same rule the JS half already
# applies to a missing package manager: code that cannot be verified does not
# get pushed. Anything else would reopen the exact hole this script closes.
set -u

REPO_ROOT="${REPO_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
RELAY_DIR="$REPO_ROOT/apps/relay"

if [ ! -f "$RELAY_DIR/go.mod" ]; then
  # No Go module in this tree: nothing to gate, and nothing is being skipped.
  echo "push gate (go): no apps/relay/go.mod; nothing to run" >&2
  exit 0
fi

if ! command -v go >/dev/null 2>&1; then
  echo "push gate (go): FAILED — 'go' is not on PATH, so apps/relay cannot be" >&2
  echo "  tested and its ~50 tests would go unverified. Install Go (brew install go)" >&2
  echo "  and push again. The gate blocks rather than passing on unrun tests." >&2
  exit 1
fi

echo "push gate (go): go -C apps/relay test -race -count=1 -tags relayv2 ./..." >&2
go -C "$RELAY_DIR" test -race -count=1 -tags relayv2 ./...
status=$?

if [ "$status" -ne 0 ]; then
  echo "push gate (go): FAILED (exit $status) — relay tests are red; push blocked." >&2
fi

exit "$status"
