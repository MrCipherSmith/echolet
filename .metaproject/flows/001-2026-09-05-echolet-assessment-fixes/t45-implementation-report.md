# T45 — Implementation report: exhausted-prekey reporting and publication claimability

Flow: `001-2026-09-05-echolet-assessment-fixes`
Dispatch: `001-T45-implement`
Role: `task-implementer` (GREEN phase for the RED suite written under `001-T45-tests`)
Date: 2026-09-06

## 1. What was implemented

The two defects diagnosed in `t44-multisender-diagnosis.md`, both inside the frozen eight-command
CLI surface:

- **T44-001** — the relay's `404 PREKEY_BUNDLE_UNAVAILABLE` now survives both places the CLI used to
  destroy it, so an ordinary exhausted recipient prekey is no longer reported as a trust/protocol
  rejection.
- **T44-002** — `relay publish` now reports whether the published bundle is actually available for
  claiming, so a recovery re-publish that restores nothing no longer reports plain success.

No command was added, `rotateBundle()` was left without an entry point, and `publish` still
resubmits the identical stored bundle — the e2e suite pins one `bundle_id` across all three
publishes, and the F-001 suite (`outbound.publish.test.ts`) was neither opened for writing nor
weakened.

## 2. T44-001 — surfacing the exhausted-prekey condition

### 2.1 First flattening: the transport allowlist

`apps/cli/src/transport/relayClient.ts:11` (now `:11-16`). `PREKEY_BUNDLE_UNAVAILABLE` was added to
the `remoteCodes` allowlist, so `relayClient.ts` constructs
`RelayError("RELAY_HTTP_ERROR", retryable=false, httpStatus=404, remoteCode="PREKEY_BUNDLE_UNAVAILABLE")`
instead of dropping the code to `undefined`.

The allowlist itself was **kept**, and the comment now states why: a relay-chosen string ends up in
the operator's machine-readable output, so an unrecognised code must still be discarded rather than
forwarded verbatim. That property is pinned by a green guard in
`relayClient.prekeyUnavailable.test.ts`, and deleting the allowlist would have satisfied the RED
test while breaking the guard.

**T45-N-003 (dead v1-era entry).** `PREKEYS_EXHAUSTED` was **removed** from the same line. No v2
relay path emits it (`model/signal_prekey_bundle_v2.go:5-13` is the complete v2 error set) and the
CLI speaks only v2 endpoints, so the entry was dead; leaving it next to the new code is what made
the missing `PREKEY_BUNDLE_UNAVAILABLE` look intentional in the first place. No test pinned its
presence or absence; the full suite is green with it gone.

### 2.2 Second flattening: the CLI classifier

`apps/cli/src/commands/cli.ts`. `classify()` no longer collapses every non-retryable `RelayError`
to one code. Retryable failures keep `RELAY_UNAVAILABLE` / exit 4 unchanged; non-retryable ones are
now looked up in a small, explicit, closed set:

```ts
const reportedRelayCodes: ReadonlySet<string> = new Set(["PREKEY_BUNDLE_UNAVAILABLE"]);
```

A `remoteCode` in that set is reported under the relay's own name at exit 3; everything else stays
`PROTOCOL_REJECTED` at exit 3.

**Why a set of one rather than "surface every `remoteCode`".** The other allowlisted relay codes —
`BUNDLE_ID_CONFLICT`, `CLAIM_ID_CONFLICT`, `ENVELOPE_ID_CONFLICT`, `INVALID_REQUEST`,
`UNAUTHORIZED`, `NOT_FOUND` — genuinely *are* protocol rejections, so folding them into
`PROTOCOL_REJECTED` is accurate rather than misleading. The exhausted prekey is the one case where
an ordinary, expected, recoverable condition was being reported as a trust failure. The operator's
failure vocabulary therefore grows by exactly one code, which is the trade-off
`t44-multisender-diagnosis.md:201-207` recommended, and the structure makes the policy explicit and
extensible instead of hiding it in a ternary.

**Exit code.** Unchanged at 3, exactly as the diagnosis recommended: this change is about the
operator being able to *tell the conditions apart*, not about renumbering the documented exits in
`specification.md`.

**T45-N-002 (code name).** The relay's own `PREKEY_BUNDLE_UNAVAILABLE` was chosen, so one name means
one thing on both sides of the wire. See §5 for where it is (and is not) documented.

## 3. T44-002 — the claimability signal, and the wire-contract change

### 3.1 Why the relay had to answer

The CLI cannot derive this. `profile.ts:137-145` deliberately resubmits the stored bundle, and a
successful publish response was byte-identical on the relay's fresh-store path
(`signal_prekey_bundle_v2.go:63-73`) and its idempotent re-store path (`:33-45`). Only the relay
knows `stored.Claimed`. This is test-author note **T45-N-001**, and the e2e test was deliberately
written against the real relay binary to leave that option open.

### 3.2 The change, layer by layer

**Repository** — `apps/relay/internal/storage/repository/signal_prekey_bundle_v2.go`.
`SaveSignalV2` now returns `(bool, error)`. On the first-store path the transaction writes the
`v2:available:` index, so the answer is `true`; on the idempotent re-store path the answer is
`!stored.Claimed`, because `ClaimSignalV2` sets `Claimed` and deletes that same index inside one
transaction. Expiry does not enter into it: `ValidateSignalPreKeyBundleV2` rejects an out-of-window
bundle with `BUNDLE_EXPIRED` before publication reaches the repository. The flag is reset at the top
of the closure because `updateV2` re-runs it on a Badger conflict — the answer must belong to the
attempt that commits.

**Service** — `apps/relay/internal/service/signal_prekey_bundle_v2.go`. A new
`PublishSignalPreKeyBundleV2Claimable(raw, nowMS) (bool, error)` carries the answer;
`PublishSignalPreKeyBundleV2(raw, nowMS) error` is kept and delegates to it.

This split is load-bearing, not stylistic. The relayv2-tagged test at
`apps/relay/internal/storage/repository/prekey_bundle_v2_test.go:24-27` declares the relay v2 API as
a Go interface with an **error-only** publish signature and asserts
`any(legacy).(relayV2Service)` at `:209`. Widening the existing method in place would have made that
type assertion fail and the test `t.Fatal` — a pre-existing test I may not weaken. Keeping the
declared signature and adding a sibling satisfies the contract the test states and the new
requirement at the same time. The reason is recorded in a comment on the method.

**Handler** — `apps/relay/internal/api/handler/signal_prekey_bundle_v2.go`. The publish success
envelope gains one field:

```
{"ok":true,"data":{"stored":true,"bundle_id":"…","claimable":true|false}}
```

The field is **always present** on the relay side and always a boolean. The existing handler test
(`signal_prekey_bundle_v2_test.go:124-136`) unmarshals into a struct carrying only `stored` and
`bundle_id`, so the addition breaks nothing and no Go assertion was touched.

**CLI transport** — `apps/cli/src/transport/relayClient.ts`. The publish response schema is widened
in the same style the `next_cursor` widening required: a named, documented, closed schema constant
rather than an inline loosening, and the object stays `.strict()` so unknown keys are still refused.

```ts
const claimableSchema = z.boolean().optional();
```

`publishBundle()` returns `{ stored, bundleId, claimable }`, and `relay publish` prints it.

### 3.3 The one judgement call: `optional`, not required

`claimable` is `z.boolean().optional()` rather than a required boolean, and the reason is a hard
constraint rather than a preference. Five **pre-existing** CLI tests stub the publish response as
`{ stored: true, bundle_id }` with no `claimable` — `cli.test.ts:129`,
`cli.dashOptionValues.test.ts:274`, `outbound.publish.test.ts:65`, `outbound.test.ts:78`,
`relayClient.test.ts:32`. A required field would have made the strict schema reject every one of
those stubs as `INVALID_RELAY_RESPONSE`, and repairing them means editing tests this dispatch is
forbidden to touch.

It is closed in every other sense: a boolean and nothing else, never a string, never null, on an
object that still refuses unknown keys. When the field is absent the CLI reports **nothing** — the
key is simply omitted from the JSON result — rather than guessing `true` and inventing the very lie
T44-002 is about. Against the real relay it is always present, which is what the e2e test asserts.

If a later task is allowed to touch those five stubs, promoting `claimable` to a required boolean is
a one-line change here plus five stub updates, and would close the contract completely.

## 4. Files changed

| File | Change |
|---|---|
| `apps/relay/internal/storage/repository/signal_prekey_bundle_v2.go` | `SaveSignalV2` returns `(claimable bool, err error)`; `true` on first store, `!stored.Claimed` on idempotent re-store. |
| `apps/relay/internal/service/signal_prekey_bundle_v2.go` | Added `PublishSignalPreKeyBundleV2Claimable`; the declared error-only `PublishSignalPreKeyBundleV2` delegates to it. |
| `apps/relay/internal/api/handler/signal_prekey_bundle_v2.go` | Publish success data gains `claimable`. |
| `apps/cli/src/transport/relayClient.ts` | `remoteCodes`: `PREKEY_BUNDLE_UNAVAILABLE` added, dead `PREKEYS_EXHAUSTED` removed; publish response schema gains closed `claimable`; `publishBundle()` returns it. |
| `apps/cli/src/commands/cli.ts` | `classify()` reports non-retryable relay conditions listed in `reportedRelayCodes` under the relay's own code; everything else stays `PROTOCOL_REJECTED`. Exit codes unchanged. |

No test file, no configuration file, `apps/cli/vitest.config.ts` and `apps/cli/test/globalSetup.ts`
included, was modified. No `git commit` was made.

## 5. Documentation status

`specification.md:74` documents exit codes only and enumerates no machine-readable CLI error codes,
and `schemas/relay-v2.schema.json` describes request/bundle shapes only — it carries no response
contract. So there is no existing operator-facing error-code list into which
`PREKEY_BUNDLE_UNAVAILABLE` could be recorded, and no response schema into which `claimable` could
be added. Both belong in the flow's documentation task, together with the structural limitation
`t44-multisender-diagnosis.md:219-224` asks to state plainly. Two sentences are needed there:

- `send` reports `PREKEY_BUNDLE_UNAVAILABLE` (exit 3) when the recipient has no unclaimed published
  bundle — a recoverable condition, not a trust failure.
- `relay publish` reports `claimable`; `false` means the publication is stored but its bundle has
  already been consumed, so the re-publish restored nothing.

`specification.md` and `metrics-and-validation.md` are change-controlled requirements documents and
were deliberately not edited by this dispatch.

## 6. Verification

All commands run with Node v26.5.0 (`/opt/homebrew/bin`); the default `/usr/local/bin/node` on this
machine is v22.12.0, which is below the package's `>=22.13` engine requirement and fails to load
`node:sqlite`, collapsing 13 suites for reasons unrelated to any code change.

| Check | Result |
|---|---|
| `pnpm --filter @echolet/cli test` | **17 files / 89 tests passed, 0 failed** (was 86 passed / 3 failed) |
| `pnpm test` (workspace) | protocol 8, client-db 1, crypto-core 4, client-core 2, session-node 24, mobile 6, cli 89 = **134 passed, 0 failed** |
| `pnpm typecheck` (workspace) | all 7 projects green |
| `go -C apps/relay test -race -count=1 ./...` | all packages `ok` |
| `go -C apps/relay test -tags relayv2 -race -count=1 ./...` | all packages `ok` |
| `git status --porcelain` | 23 untracked entries — byte-identical to the session-start snapshot |

The three previously RED tests now pass unmodified:

- `apps/cli/src/transport/relayClient.prekeyUnavailable.test.ts` — the 404 claim rejection carries
  `remoteCode: "PREKEY_BUNDLE_UNAVAILABLE"`, and both green guards (unrecognised code still
  discarded, 503 still retryable) hold.
- `apps/cli/src/commands/cli.relayErrorCodes.test.ts` — the exhausted send reports
  `PREKEY_BUNDLE_UNAVAILABLE` at exit 3 while the `400 INVALID_SIGNATURE` publish stays
  `PROTOCOL_REJECTED` at exit 3; the two never share a code, and the over-correction guard
  (`CONTACT_NOT_TRUSTED`, `BUNDLE_ID_CONFLICT`, exit-4 `RELAY_UNAVAILABLE`, `CONTACT_PIN_MISMATCH`)
  is unchanged.
- `apps/cli/test/e2e/publication-claimability.test.ts` — against the real relay binary, `claimable`
  is `true` / `true` / `false` across the three publishes, `bundle_id` is identical across all
  three, and Carol's second-sender send exits 3 naming the prekey condition.

## 7. Routing audit

- `graph_used`: `not-relevant` — the dispatch named every file:line to change (T44 diagnosis plus
  the T45 RED result); no structural discovery was required beyond targeted symbol searches.
- `wiki_used`: `not-relevant` — the domain knowledge for this task is the T44 diagnosis and
  `specification.md`, both read directly; the wiki pages are auto-generated drafts with no prekey
  semantics (recorded in `t44-multisender-diagnosis.md:245`).
- `ctx_used`: yes — `keryx ctx rg` for every code search, `keryx ctx run` for every build, test and
  status command, `keryx ctx read` for the contract schemas.
- `raw_rg_used`: no.
