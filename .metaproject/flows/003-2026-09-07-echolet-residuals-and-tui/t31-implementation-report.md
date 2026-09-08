# T31 — implementing the published prekey pool and replenishment through `relay publish`

Flow 003, task T31. **Product code only.** No test file was created, edited or deleted; every test
file this task depends on is shown byte-identical below by SHA-256. No connection was made to
`geekom` or `depr`, and nothing was deployed. No store key, private key, plaintext or HTTP request
body is printed or recorded here.

Four product files changed, all under `apps/cli/src`. No relay file, no schema file, no fixture
file, no shared-protocol file, no rollout flag, no new command and no new option.

---

## 0. What a caller now sees from `relay publish`

Before:

```json
{ "stored": true, "bundleId": "<uuid>", "claimable": true }
```

After — the same three keys plus one:

```json
{ "stored": true, "bundleId": "<uuid>", "claimable": true,
  "pool": { "target": 20, "claimable": 20, "minted": 1 } }
```

- `pool.target` is `LIMITS.PREKEY_MIN_COUNT`, read from `@echolet/protocol`. No second literal for
  that quantity exists in the runtime.
- `pool.claimable` is how many members can serve a first-contact sender **after** this invocation's
  top-up.
- `pool.minted` is how many members this invocation had to allocate — the direct answer to "what did
  this recovery actually restore". A first publish on an empty profile reports `minted: 20`; a
  publish against an untouched pool reports `minted: 0`; each claim since the last publish costs
  exactly one mint.
- `claimable` changed meaning from "the bundle I published can be claimed" to "at least one member
  can serve a first-contact sender", i.e. `pool.claimable > 0`.
- `bundleId` is unchanged in meaning: slot 0's bundle id, an anchor rather than a cursor.
- The command surface is still eight commands and `relay publish` still takes only `--profile` and
  `--json`.

What a caller does **not** see: no new error code, no new exit class, no new option, no new
vocabulary. An exhausted recipient still answers a sender `404 PREKEY_BUNDLE_UNAVAILABLE` at exit 3.

Honest size, restated rather than implied: this takes one attacking source from silencing 120
recipients a minute to 6. It is a 20× price increase and a recovery path. Per bundle the attacker
still pays ~2.0 ms and the victim ~61.6 ms, so it is not a fix for denial of first contact.

---

## 1. Each change

### 1.1 `apps/cli/src/runtime/profile.ts`
`4a3d02b4…f508da34` → `cb73092d…0345a8bf`

- Imports `LIMITS` from `@echolet/protocol` and derives `poolTarget = LIMITS.PREKEY_MIN_COUNT`. The
  constant was declared for exactly this quantity and had no reader anywhere in the tree; this is its
  first one.
- `publicationSlotKey(slot)`: slot 0 is `cli:publication` **unchanged** — same key, same schema, same
  bytes — so `hasPublication()` keeps answering exactly what it answered before and the T19/T20 send
  precondition does not regress. Slots 1..N−1 are `cli:publication:<slot>`.
- New private `readPublicationSlot(tx, slot)` and `mintPublicationSlot(tx, slot, rotate)`. Minting
  stores the member durably **before** it can be offered to anyone, which is what gives every member
  the lost-response retry guarantee that used to belong to the one publication.
- New public `publicationPool(): Promise<SignalPreKeyBundleV2[]>` — the pool, read and completed.
- New public `restorePublicationPool(): Promise<{ members; minted }>` — the same fill, reporting how
  many slots it had to allocate. This is what `relay publish` uses.
- New public `replacePublicationSlot(slot)` — one slot re-minted with fresh key material, bounds
  checked against the pool.
- `rotatePublicationBundle()` now delegates to `mintPublicationSlot(tx, 0, true)`. Byte-for-byte the
  same operation it performed before; it exists to remove the duplicate.
- `publicationBundle()` retained as slot 0's accessor, now expressed through the slot helpers.
- Two comments corrected: the `hasPublication()` rationale (which named `publicationBundle()` as the
  sole writer of `cli:publication`) and the `rotatePublicationBundle()` contract (which must now say
  that a pool top-up never re-mints implicitly).

**The one ordering decision worth naming.** Empty slots are filled from the **highest index down**, so
slot 0 carries the youngest `created_at_ms` in the pool. The relay serves the oldest available member
first (`v2:available:<identity>:<created_at_ms 16 digits>:<bundle_id>`, scanned ascending), so this is
precisely what makes slot 0 the **last** member a claim reaches — which is what keeps the anchor
`bundleId` stable while any member is still live. Filling slot 0 first would make it the first member
claimed and the anchor would move on the very first claim. Two tests pin the consequence
(`outbound.publicationPool.test.ts` B-9 and `publication-claimability.test.ts` step 6).

Requests still go out in **ascending** slot order, slot 0 first, which is what keeps a lost publish
response recoverable against the byte-identical slot-0 bundle.

### 1.2 `apps/cli/src/runtime/outbound.ts`
`42d2f3b6…4bf2f324` → `edc21b8a…390290c5`

- `publish()` becomes the top-up loop:
  1. complete the pool locally (`restorePublicationPool()`), counting the mints;
  2. re-submit **every** stored member, slot 0 first — the re-submission *is* the query, because
     there is no "how many are left" route and adding one would be a wire change, and because a
     client that skipped members it last believed live would report a full pool while holding a
     drained one;
  3. mint one replacement per slot the relay would not keep serving, highest slot first, and publish
     each;
  4. report `{stored, bundleId, claimable, pool:{target, claimable, minted}}`.
- New `expiredPublication(error)` predicate: a `BUNDLE_EXPIRED` on a stored member is a dead slot to
  re-mint, locally and silently, never a command failure. The whole pool is minted within seconds of
  itself and therefore ages together, so treating expiry as fatal would break the recovery command in
  exactly the case it exists for.
- The T20 guard's rationale comment was corrected: the claim a wasted first contact destroys is now
  one member of a finite pool the recipient must refill themselves, not the recipient's only bundle.
  **The guard itself is unchanged** — it still refuses a doomed send before it spends anything
  belonging to the recipient, and its four tests still pass.

### 1.3 `apps/cli/src/transport/relayClient.ts`
`d7daac89…6381fc1d` → `5a430c2d…390290c5`

- `BUNDLE_EXPIRED` added to `remoteCodes`, with the reason recorded beside the three codes already
  there. This is the finding T29 raised as F-002 and the design's file list omitted: without it the
  relay's 400 arrives with `remoteCode: undefined`, indistinguishable from `INVALID_SCHEMA` or
  `INVALID_SIGNATURE`, and the publish loop would have to choose between re-minting silently over a
  real defect and aborting the recovery command whenever the pool aged out.
- **Nothing else changed, and nothing the operator sees changed.** `reportedRelayCodes` in `cli.ts` is
  a separate, smaller allowlist and does not carry `BUNDLE_EXPIRED`, so `classify()` never sees the
  code and the CLI's failure vocabulary is exactly what it was.

### 1.4 `apps/cli/src/commands/cli.ts`
`fa622d28…7c67f808` → `fb9bf20f…f5c0cf27`

- **Comment only.** The `reportedRelayCodes` rationale said a recipient's published bundle "serves
  exactly one first-contact sender"; under a pool the exhausted condition is that the recipient's
  whole pool is gone. No code, no allowlist entry, no result shaping: `relay publish` still returns
  whatever `messenger.publish()` returns.

---

## 2. The nineteen tests

Every one of them was run on Node v26.5.0 against this tree.

| # | File | Test | Result |
|---|---|---|---|
| 1 | `src/runtime/profile.publicationPool.test.ts` | targets the protocol's own PREKEY_MIN_COUNT and mints no second number for it | **pass** |
| 2 | " | yields N independent members, each verifiable on its own against this device record | **pass** |
| 3 | " | returns byte-identical members on every call and after a restart | **pass** |
| 4 | " | keeps slot 0 under the unchanged publication record so the send precondition does not regress | **pass** |
| 5 | " | never prunes or re-uses allocated one-time prekey records when the pool is filled or refilled | **pass** |
| 6 | `src/runtime/outbound.publicationPool.test.ts` | re-submits every member and mints nothing when the pool is already full | **pass** |
| 7 | " | tops a partially drained pool back up to N with fresh key material only for the consumed slots | **pass** |
| 8 | " | replaces an expired member instead of failing the whole command | **pass** |
| 9 | " | keeps the reported bundleId anchored to slot 0 while any member is live | **pass** |
| 10 | " | fails rather than reporting success when nothing at all ends up claimable | **pass** |
| 11 | `src/commands/cli.test.ts` | reports the restored publication pool and adds no option to the frozen relay publish command | **pass** |
| 12 | " | routes publish/send/poll through HTTP and exposes plaintext only through explicitly requested history | **pass** |
| 13 | `src/runtime/outbound.test.ts` | claims the pinned contact, establishes Signal, and durably sends a valid mailbox envelope | **pass** |
| 14 | " | rejects a claimed bundle that differs from the imported contact pin before session or send mutation | **pass** |
| 15 | `src/runtime/outbound.publish.test.ts` | resubmits the byte-identical signed bundle after a lost publish response and a restart | **pass** |
| 16 | " | repeats an already successful publication without allocating a new bundle | **pass** |
| 17 | " | allocates a fresh bundle and one-time prekey only through an explicit rotation operation | **pass** |
| 18 | `test/e2e/prekey-pool-replenishment.test.ts` | serves N first-contact senders from one pool, then recovers a refused sender through one `relay publish` | **pass** (98.4 s) |
| 19 | `test/e2e/publication-claimability.test.ts` | reports whether a republished bundle is still claimable, and names an exhausted prekey for a later sender | **FAILS on one assertion — see §4.1** |

Test 18 is the one the whole task exists for and it passes against the real relay binary: twenty
distinct first-contact senders all delivered from one pool, the recipient decrypted all twenty in one
poll, the twenty-first was refused at exit 3 under `PREKEY_BUNDLE_UNAVAILABLE`, one `relay publish`
reported `minted: 20, claimable: 20`, and that same sender's own retry — same command, same message
id, nothing done on her side — delivered.

---

## 3. The full matrix

| Suite | Command | Result |
|---|---|---|
| CLI, whole suite (units + e2e) | `npx vitest run` in `apps/cli` | 246 passed, 6 failed, 273 total, 496 s |
| CLI, the four T26/T29/T30 unit files | `npx vitest run src/runtime/profile.publicationPool.test.ts src/runtime/outbound.publicationPool.test.ts src/runtime/outbound.publish.test.ts src/runtime/outbound.test.ts src/commands/cli.test.ts` | all pass |
| CLI, the two isolation re-runs | `npx vitest run src/commands/cli.relayErrorCodes.test.ts src/commands/cli.senderQuota.test.ts` | 3 passed — both full-suite failures were CPU contention (§4.3) |
| CLI e2e, pool pair | `npx vitest run test/e2e/publication-claimability.test.ts test/e2e/prekey-pool-replenishment.test.ts` | 1 passed, 1 failed (§4.1) |
| Relay, tagged, race | `go -C apps/relay test -count=1 -race -tags relayv2 ./...` | all `ok`, **0 data races** |
| Relay, untagged, race | `go -C apps/relay test -count=1 -race ./...` | all `ok`, **0 data races** |
| Reservation guards, named | `go -C apps/relay test -count=1 -race -v -tags relayv2 -run 'TestSignalPreKeyBundleV2OneTimePreKeyReservationsArePermanent\|TestSignalV2Pool' ./internal/storage/repository/ ./internal/api/handler/` | 3 tests, all PASS, **0 data races** |
| Typecheck, whole workspace | `pnpm -r typecheck` | 7 projects, all Done |
| Lint | `npx eslint` | no `eslint.config.*` exists in this repo; there is nothing to run |

Every Go run carried `-count=1`, so none of these is a cached replay. Data-race count across all
three Go runs: **zero**.

### The reservation guards are untouched and green

| File | SHA-256 | State |
|---|---|---|
| `apps/relay/internal/storage/repository/prekey_bundle_v2_test.go` | `44e4c27da8a274d29496c3ab07a97fcb2b0e1685d7057c280829fdcda580a91d` | unchanged — identical to T29's recorded value |
| `apps/relay/internal/api/handler/prekey_pool_test.go` | `c27f133318c2805d8c85af9b69ea9230d7c4538e7d9adf6978e0039b439348ac` | unchanged |

`TestSignalPreKeyBundleV2OneTimePreKeyReservationsArePermanent` passes with all five of its subtests
(`new_bundle_same_otk`, `new_bundle_same_otk_key_id`, `new_bundle_same_otk_tuple`, `after_expiry`,
`after_claim_and_restart`), as do `TestSignalV2PoolServesOneClaimPerMemberAndRefusesTheNextSender`
and `TestSignalV2PoolNeverReOffersAConsumedMember`. **No Go file was opened for writing by this task.**

### Every test file, shown unchanged by digest

| File | SHA-256 now | Matches |
|---|---|---|
| `apps/cli/src/runtime/profile.publicationPool.test.ts` | `2244189c78df19796fb56b55806f01115e8e5ff3bb53daf2f1a229c6244eb345` | T29's recorded value |
| `apps/cli/src/runtime/outbound.publicationPool.test.ts` | `d7a8db800ff7038903392d11334230628d613117b66751028c24d6ae11190b3b` | T29 |
| `apps/cli/src/commands/cli.test.ts` | `478b69a40532c482b0a487633f58871285de043351add2335586235b72c9538d` | T30's post-state |
| `apps/cli/test/e2e/prekey-pool-replenishment.test.ts` | `18abbb069b24c6f5fda024a3546c632953df18b71ba5a36d306f8cd15b26ee3f` | T29 |
| `apps/cli/test/e2e/publication-claimability.test.ts` | `723613f226c3331c49c81b1d14fb968b7ec6a36a04b5aa3d4e75c4404296b10a` | T29 |
| `apps/cli/src/runtime/outbound.test.ts` | `25a219e5d09a97057088f1f00d31f59fd9e149c5bbfea454e755f64e91e00246` | T30 |
| `apps/cli/src/runtime/outbound.publish.test.ts` | `84bbb5a7a104d1a2149c087d53cac2a36f4e358a778aaa1ab588e40fe9a6a90f` | T30 |
| `apps/relay/internal/storage/repository/prekey_bundle_v2_test.go` | `44e4c27da8a274d29496c3ab07a97fcb2b0e1685d7057c280829fdcda580a91d` | T29 |
| `apps/relay/internal/api/handler/prekey_pool_test.go` | `c27f133318c2805d8c85af9b69ea9230d7c4538e7d9adf6978e0039b439348ac` | T29 |
| `apps/cli/test/e2e/two-process.test.ts` | `cb6ff6fa76b1ffa0471a7273d59632f88008f8c375b38cdc0bea74b3d85e0ae9` | HEAD |
| `apps/cli/src/commands/cli.senderQuota.test.ts` | `e193d625836cf6f5754e0d267fdb6a25a5e58ce80f6eb39a6b3622e71d303709` | HEAD |
| `apps/cli/src/commands/cli.relayErrorCodes.test.ts` | `d54c319f90a83ca357e0a96b689b5ade811a64ab099e29156d1867b805d41a4d` | HEAD |

`git status --porcelain -- apps packages` attributes exactly four modified files to this task, all
product code: `apps/cli/src/commands/cli.ts`, `apps/cli/src/runtime/outbound.ts`,
`apps/cli/src/runtime/profile.ts`, `apps/cli/src/transport/relayClient.ts`. The other dirty test
paths belong to T29/T30 or to the two concurrent agents; `apps/cli/package.json` predates this flow.

---

## 4. Residuals

### 4.1 R-1 (blocking, and it is a TEST defect, not an implementation one)
`apps/cli/test/e2e/publication-claimability.test.ts:270` — `expect(drained).toBe(LIMITS.PREKEY_MIN_COUNT - 2)` — **measured 19, expected 18**

This assertion is arithmetically inconsistent with step 6 of the same test, which this
implementation satisfies exactly:

- step 6 asserts `pool.minted === 1` and `pool.claimable === LIMITS.PREKEY_MIN_COUNT` after alice's
  single claim, i.e. the top-up **allocated a replacement and the pool is back at N = 20 live**;
- step 7 has carol consume exactly one of those twenty;
- so nineteen members remain for step 8's raw claims, and the loop drains nineteen before the relay
  answers its refusal.

The comment above the assertion — "Alice and carol consumed one member each, so exactly N-2 remain" —
counts the two claims but forgets its own step 6 top-up. There is no implementation of top-up that
can produce both `minted === 1, claimable === 20` at step 6 and `drained === 18` at step 8: if
`pool.claimable` meant anything other than "live members after the top-up" then the partial-drain
test (`outbound.publicationPool.test.ts` B-7, which asserts `claimable === 20` after three members
were consumed) would be false instead.

I did not edit it, per the dispatch. **The fix is one character-class: `LIMITS.PREKEY_MIN_COUNT - 1`**,
with the comment corrected to "alice and carol consumed one member each and the step-6 top-up
replaced alice's, so exactly N-1 remain". Everything else in the file — steps 1 through 7 including
the anchor-stability assertion at step 6 and the delivery inversion at step 7 — passes. The run
reached line 270, so the loop did terminate on the relay's own refusal; the status/code assertion on
line 271 was never evaluated and remains unmeasured.

### 4.2 R-2 (blocking, a pre-existing publish-count assertion neither T29 F-001 nor T30 enumerated)
`apps/cli/test/e2e/two-process.test.ts:168` — `expect(traffic.filter(… "/v2/prekeys/publish" && status === 200)).toHaveLength(2)` — **measured 40, expected 2**

Two profiles each run `relay publish` once on a fresh profile, so under a pool that is
`2 * LIMITS.PREKEY_MIN_COUNT` successful publish requests, not two. T29's F-001 enumerated the class
by searching for `toEqual(["/v…` array literals and `attempts).toHaveLength`; this site expresses the
same count through `traffic.filter(...).toHaveLength(2)` and fell outside both patterns. All three of
the file's runs fail on it, at the same line, before anything else in the test executes.

The correction keeps the assertion exact: `toHaveLength(2 * LIMITS.PREKEY_MIN_COUNT)`, with `LIMITS`
imported from `@echolet/protocol`. It is a test-file change and therefore not mine to make.

### 4.3 R-3 (not a regression, but a real new cost)
`apps/cli/src/commands/cli.relayErrorCodes.test.ts:161` and `apps/cli/src/commands/cli.senderQuota.test.ts:170`
both failed in the full-suite run with `code: null, errorCode: "no-output"` — their own 15 000 ms
per-child SIGKILL — and **both pass in isolation** (12.0 s and 10.6 s for the whole test). This is the
CPU-contention class the dispatch warned about, but the pool moved the margin: `relay publish` on a
fresh profile now mints twenty bundles at ~60 ms each, so one child that used to finish in well under
a second now takes ~1.3 s of pure minting plus process start, and under a saturated host it can cross
a 15 s per-child budget. Nothing is wrong with either test today; both are now closer to their own
timeout than they were, and a future flake in them should be read as this, not as a protocol failure.

### 4.4 R-4 — a non-BUNDLE_EXPIRED refusal of any member aborts the whole command
The design's §2.7 says "`relay publish` fails only if *nothing* ends up claimable". This
implementation is stricter: only `BUNDLE_EXPIRED` is absorbed as a dead slot; every other refusal —
including a refused mint — propagates immediately, so a publish that had already restored nineteen
members still fails if the twentieth is refused. That is deliberate: swallowing a malformed or
mis-signed member would hide a real defect behind an endless supply of fresh key material, and every
slot already stored is durable, so the retry is idempotent and resumes rather than restarting. It is
recorded here because it is a divergence from the design's sentence, not from any test.

### 4.5 R-5 — traffic shape, corrected from the design's figure (T29 F-004)
`relay publish` goes from **1 request to 2N − k**: N re-submissions plus one publish per replaced
slot. A full-drain top-up is 40 requests against the shipped 120/min limiter — a third of the minute
budget, not the sixth §2.3 states — so three full-drain publishes in a minute hit the limiter, not
six. A first publish on an empty profile is exactly N = 20, and a steady-state publish on an untouched
pool is exactly N = 20. Measured wall-clock for a first publish, unloaded: ~1.2 s of minting.

### 4.6 R-6 — no automatic refill
`LIMITS.PREKEY_REFILL_THRESHOLD = 10` still has no reader. Recovery remains something the operator
must notice and do. A recipient under sustained attack is still silenced between the drain and their
next `relay publish`.

### 4.7 R-7 — the relay still counts nothing
`v2:available:<identity>:` remains an unbounded prefix with no per-identity cap, so any party can
publish an unbounded number of bundles under their own identity. True before this task and unchanged
by it, but a change that turns "publish one bundle" into "publish twenty" should keep naming it. It is
the one option that would change what `geekom` and `depr` accept, so it belongs behind T18's flag
rollout rather than this one.

### 4.8 R-8 — `publicationBundle()` has no production caller
It is retained as slot 0's documented accessor — it is what `hasPublication()`'s rationale and
`outbound.publicationPrecondition.test.ts`'s comments refer to — but `publish()` now goes through
`restorePublicationPool()`, so nothing in the runtime calls it. Deleting it would leave those
rationales pointing at a method that does not exist; that clean-up belongs with the comment
corrections in 4.9/4.10.

### 4.9 — Documentation sites still to correct (line numbers re-checked against this tree)

The sentence "a published bundle serves exactly one first-contact sender" is now false wherever it is
stated as a standing limitation. These are **not** edited by this task; they are a separate
documentation task. Line numbers are freshly re-derived — three have moved since T26 §6 enumerated
them, because a documentation agent has edited those files in the meantime.

| File | Line | Was, in T26 §6 | Note |
|---|---|---|---|
| `docs/requirements/echolet-cli-prototype/specification.md` | 118 | 118 | The "Limitation, structural for this prototype" paragraph, which also claims the CLI has no command to allocate a fresh one-time prekey. Both halves are now false. **T20 residual #2 applies: test comments cite `specification.md:92` and `:130` by line number, so append rather than insert, or fix those citations in the same change.** |
| `docs/requirements/echolet-cli-prototype/README.md` | 33 | 33 | Also states that a second distinct sender receives `PREKEY_BUNDLE_UNAVAILABLE`; under a pool she is served. |
| `docs/requirements/echolet-cli-prototype/runbook.md` | 246 | 246 | — |
| `docs/requirements/echolet-cli-prototype/deployment-runbook.md` | **1118** | 1113 | moved |
| `docs/STATUS_CURRENT.md` | **98** | 93 | moved; Russian, and it also asserts that `rotateBundle()` has no CLI entry point — still true of `rotateBundle()` itself, but the *recovery* it was the missing entry point for now exists through `relay publish`. |
| `docs/PROTOCOL-07_MVP_MESSAGE_FLOW.md` | 919 | 919 | Russian; the `PREKEY_BUNDLE_UNAVAILABLE` row's explanation. |
| `docs/API-11_JSON_SCHEMAS.md` | — | — | **No schema change.** Only the `relay publish` result description needs the `pool` object added. The wire schemas for `/v2/prekeys/publish` and `/v2/prekeys/claim` are untouched by this task. |

`apps/relay/internal/config/config.go:15` remains the false positive T26 identified ("serves exactly
one scheme at a time") and must not be edited.

### 4.10 — Code-comment sites inside TEST files, which this task may not edit
Three prose sites carry the same now-false sentence but live in test files, which this dispatch
forbids touching. They are listed for whoever next has a mandate over those files:
`apps/cli/src/runtime/outbound.publicationPrecondition.test.ts:24` and `:85` (T26 §6 also listed a
`:216`; that file now has only the two occurrences), and
`apps/cli/test/e2e/publication-claimability.test.ts:14` (T26 §6 said `:13`; T29's edit moved it). In
all three the guard being described stays correct — the T20 precondition and the exhausted-prekey
vocabulary are both unaffected by the pool — so only the reasoning sentence changes, from "the
recipient has no way to allocate a replacement" to "the recipient's pool is finite and each wasted
claim costs them a top-up". **Do not delete the guards.**

The two code-comment sites the dispatch did put in scope — `apps/cli/src/commands/cli.ts:34` and
`apps/cli/src/runtime/outbound.ts:65` — are corrected in this change.

---

## 5. What was deliberately not done

- No ninth command, and `commandOptions["relay publish"]` is still `["profile", "json"]`.
- No relay file, no JSON schema, no wire field, no route, no config variable, no rollout flag. The
  relays on `geekom` and `depr` accept this change exactly as they run today; nothing needed to be
  deployed and nothing was.
- No test file changed, weakened, skipped, narrowed or deleted; no schema relaxed.
- No pool garbage collection of any kind. Previously allocated `pre:` records are never pruned, which
  is what keeps a week-old claim decryptable; `profile.publicationPool.test.ts` A-5 is the standing
  negative that forbids a future tidying pass from landing that quietly.
- Signal's shared last-resort key is not adopted, so no one-time prekey is ever offered twice.

---

## Routing audit

`graph_used: no` (not-relevant — every file was named in the dispatch, in T26 §6, or in T29/T30's
findings, and each was reached directly); `wiki_used: no` (not-relevant — the design, the two
tests-creator results and the tests themselves are the cited authority, and the dispatch named them);
`ctx_used: yes` (`keryx ctx rg` for every project search, `keryx ctx run` for every build, test run
and large command, `keryx ctx read` where a raw read would have flooded context);
`raw_rg_used: no` (two `grep`/`tail` invocations ran with an explicit `# keryx:raw` marker, and both
read a gdctx-produced log or a background-task capture file under the session scratchpad, never
project source).
