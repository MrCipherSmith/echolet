# T44 — Multi-sender prekey-claim diagnosis

Flow: `001-2026-09-05-echolet-assessment-fixes`
Dispatch: `001-T44-investigate`
Role: `context-collector` (diagnosis only — no source, test or configuration file was modified)
Date: 2026-09-06

## 1. The observation under investigation

T42's independent verifier recorded, out of scope and undiagnosed
(`t42-verification-report.md:365`):

> a second distinct sender could not claim the recipient's prekey bundle
> (`PROTOCOL_REJECTED`, a non-retryable relay 4xx), and a `relay publish` by Bob did not restore
> claimability.

The orchestrator's hypothesis was that this is the functional consequence of finding
**T38-L-001** (`rotateBundle()` has no CLI entry point) combined with the specification's
one-time-prekey reservation rule, rather than a new defect. **The hypothesis is confirmed on the
mechanism, and refuted on the error code**: the relay is correct, the CLI's error reporting is not.

## 2. Deterministic reproduction

A bounded probe was run entirely outside the repository (scratchpad `probe.mjs`, since removed).
It built the relay from source into a temporary directory, started it on loopback with a temporary
`ECHOLET_DATA_DIR`, created three profiles from the already-built `apps/cli/dist/cli.js`, and ran
only the frozen eight-command CLI surface plus two direct HTTP claims at the relay boundary.

| Step | Action | Result |
|---|---|---|
| 1 | recipient `relay publish` | exit `0`, `ok` |
| 2 | sender A `send --to <recipient>` | exit `0`, `ok` |
| 3 | sender B `send --to <recipient>` | **exit `3`, `PROTOCOL_REJECTED`** |
| 4 | direct `POST /v2/prekeys/claim` (fresh `claim_id`) | **HTTP `404`, `PREKEY_BUNDLE_UNAVAILABLE`** |
| 5 | recipient `relay publish` again | exit `0`, `ok` — **reports success, restores nothing** |
| 6 | sender B `send` again (new message id) | **exit `3`, `PROTOCOL_REJECTED`** |
| 7 | direct `POST /v2/prekeys/claim` after re-publish | **HTTP `404`, `PREKEY_BUNDLE_UNAVAILABLE`** |

Reproduction is deterministic: steps 3–7 depend only on step 2 having consumed the recipient's
single published bundle. No plaintext, ciphertext, store key or HTTP body was printed by the probe;
only exit codes, error codes and HTTP status codes were captured.

Step 5 is the sharpest part of the reproduction and was not in the original observation: the
recipient's `relay publish` **returns `ok` while restoring nothing**. The CLI reports success for
an operation that had no effect on claimability.

## 3. Mechanism, at file:line

### 3.1 The recipient can only ever offer one bundle through the CLI

`apps/cli/src/runtime/profile.ts:137-145` — `publicationBundle()` writes the signed bundle durably
on first call and thereafter **returns the stored bundle unchanged**. This is deliberate and
correct: it is what makes a lost publish response retryable with byte-identical bytes around the
identical reserved one-time prekey (the comment at `profile.ts:132-136` says exactly this).

`apps/cli/src/runtime/outbound.ts:34` — `publish()` submits `await this.profile.publicationBundle()`,
so every `relay publish` after the first resubmits the same bytes.

`apps/cli/src/runtime/profile.ts:151-160` — `rotatePublicationBundle()` is the only operation that
allocates a fresh one-time prekey and signs a new bundle. `apps/cli/src/runtime/outbound.ts:36`
exposes it as `rotateBundle()`.

`apps/cli/src/commands/cli.ts:52-61` and `cli.ts:290-296` — the command table contains exactly eight
commands, and `relay publish` maps only to `messenger.publish()`. **`rotateBundle()` has no CLI
entry point** — this is T38-L-001, confirmed here by search: `rotateBundle` appears only at
`outbound.ts:36` and in `outbound.publish.test.ts:131`. Same for `retryPending()`
(`outbound.ts:110`), which is likewise unreachable from the CLI.

### 3.2 The relay consumes the bundle on the first claim and never returns it

`apps/relay/internal/storage/repository/signal_prekey_bundle_v2.go:114-181` — `ClaimSignalV2`
iterates the `v2:available:<identity>:` prefix, and on the first eligible record sets
`bundle.Claimed = true` (line 154) and **deletes the availability index entry** (line 162). When
the iteration finds nothing it returns `model.ErrV2Unavailable` (line 175). The `Claimed` guard at
line 151 makes the consumed bundle permanently ineligible.

### 3.3 A re-publish is idempotent and does not restore availability

`apps/relay/internal/storage/repository/signal_prekey_bundle_v2.go:33-45` — on re-publish the
existing `v2:bundle:<id>` record is found, the submitted `Raw` bytes are byte-identical, and the
function returns after `saveSignalV2Authorization` **without re-adding the `v2:available:` key**
that line 73 writes only on the first-store path. The bundle therefore stays claimed and
unavailable while the handler still reports `stored: true`.

Had the CLI instead submitted a *different* bundle reusing the same one-time prekey, the
reservation indexes at lines 49-62 would have rejected it with `ONE_TIME_PREKEY_REUSED`. Either
way the CLI alone cannot restore claimability.

### 3.4 The sender's claim path

`apps/cli/src/runtime/outbound.ts:52-62` — `sendOwned` mints or reuses a persisted `claim_id` and
calls `relay.claimBundle(...)` whenever no session exists for the contact. Sender B has no session,
so it claims; the claim 404s; the `RelayError` propagates through `serial()` unchanged
(`outbound.ts:27`) and reaches the CLI classifier.

## 4. Error-code resolution

**The relay returns exactly what the specification requires. The CLI discards it — twice.**

- `apps/relay/internal/model/signal_prekey_bundle_v2.go:12` defines
  `ErrV2Unavailable = errors.New("PREKEY_BUNDLE_UNAVAILABLE")`.
- `apps/relay/internal/api/handler/signal_prekey_bundle_v2.go:14-28` maps it to
  `http.StatusNotFound` with code `PREKEY_BUNDLE_UNAVAILABLE`.
- Probe steps 4 and 7 observed `404 PREKEY_BUNDLE_UNAVAILABLE` at the wire. Specification
  `specification.md:92` is satisfied verbatim: "No available bundle returns
  `404 PREKEY_BUNDLE_UNAVAILABLE`."

The loss happens on the client:

1. **`apps/cli/src/transport/relayClient.ts:11`** — the `remoteCodes` allowlist is
   `["BUNDLE_ID_CONFLICT", "CLAIM_ID_CONFLICT", "PREKEYS_EXHAUSTED", "NOT_FOUND", "INVALID_REQUEST", "UNAUTHORIZED", "ENVELOPE_ID_CONFLICT", "RATE_LIMITED"]`.
   It **does not contain `PREKEY_BUNDLE_UNAVAILABLE`** — it carries the unrelated v1-era
   `PREKEYS_EXHAUSTED` instead. At `relayClient.ts:105` the parsed remote code therefore falls
   through to `undefined`, and `relayClient.ts:106` constructs
   `new RelayError("RELAY_HTTP_ERROR", false, 404, undefined)`. The relay's own diagnosis is
   dropped before it ever reaches the CLI.
2. **`apps/cli/src/commands/cli.ts:336`** — `classify()` collapses *every* non-retryable
   `RelayError` to one code:
   `return new CliFailure(error.retryable ? "RELAY_UNAVAILABLE" : "PROTOCOL_REJECTED", error.retryable ? 4 : 3);`
   Neither `error.remoteCode` nor `error.httpStatus` is consulted, even though `RelayError`
   carries both (`relayClient.ts:5`).

**Consequence.** A recipient with no unclaimed prekey — an ordinary, expected, recoverable
condition — is reported to the operator identically to a genuine protocol violation: a forged
signature, a `BUNDLE_ID_CONFLICT`, an `INVALID_REQUEST`, a rejected envelope. Exit code `3` is
documented at `specification.md:74` as "trust/protocol rejection", so an exhausted prekey is being
reported as a trust failure. The operator has no signal distinguishing "the recipient needs to
publish a fresh bundle" from "something is wrong with the cryptography", and no way to discover
which from the CLI at all.

## 5. Classification

**(b) — behaviour consistent with the specification, but reported through a misleading error code:
a small defect.**

Evidence for each half:

- *Consistent with the specification.* `specification.md:88` requires a non-null one-time prekey per
  publication, requires the relay to reserve permanent indexes on it, and states that "a device may
  publish another independently signed bundle only with a newly generated one-time prekey".
  `specification.md:92` requires the claim to select "the oldest unexpired, unclaimed bundle" and to
  return `404 PREKEY_BUNDLE_UNAVAILABLE` when there is none. One published bundle plus one claim
  therefore *must* leave nothing for a second sender. The relay does precisely this. Nothing in the
  specification requires a device to keep more than one bundle published, and nothing requires
  `publish` to allocate a new prekey — `profile.ts:132-136` documents the opposite as a deliberate
  requirement of the lost-response retry rule at `specification.md:130`.
- *Misleadingly reported.* Section 4. The relay's specified `404 PREKEY_BUNDLE_UNAVAILABLE` is
  discarded at `relayClient.ts:11` and again at `cli.ts:336`, surfacing as `PROTOCOL_REJECTED`
  (exit 3, "trust/protocol rejection"). Additionally `relay publish` returns `ok` for a re-publish
  that restores nothing (probe step 5), which actively misleads an operator attempting recovery.

This is **not** (a), because a documented limitation would still be entitled to a truthful error
code. It is **not** (c), because no specification statement is violated by the relay or by the
claim/publish semantics; the defect is confined to client-side error classification and to the
absence of a rotation entry point (T38-L-001), neither of which the specification mandates.

The structural limitation the orchestrator suspected is real and should be stated plainly: **through
the frozen eight-command CLI surface, a recipient can serve exactly one first-contact sender per
profile lifetime.** Once that bundle is claimed, no CLI command can restore claimability. The
capability to fix it exists in the codebase (`rotateBundle()`) and is simply unreachable.

## 6. Consequence for the acceptance criteria

**No acceptance criterion is broken. Nothing in `specification.md` or `metrics-and-validation.md`
requires two distinct senders to reach one recipient.**

Quoting what the documents actually say:

- `specification.md:144` — "AC-03: two separate profiles exchange and import contact cards, pin each
  other's Signal identities, and then exchange a first message and reply through HTTP relay calls
  without direct in-process session setup." Two profiles, one each way; the reply reuses the
  established session (`specification.md:105`: "Replies reuse the established session"), so it never
  claims a second time.
- `specification.md:98` — the message flow is scoped to "Alice and Bob each initialize a separate
  profile"; step 2 is "Each publishes a signed v2 bundle" (singular), and step 3 has Alice claim
  Bob's bundle once.
- `specification.md:141` — "AC-02: a race-enabled Go test proves exactly one successful claim from at
  least twenty concurrent requests." This is the *only* criterion involving multiple claimants, and
  it demands that the extra claimants **fail** — the observed behaviour is the criterion being met,
  not violated. `specification.md:131` likewise lists "Concurrent claims → Exactly one claimant
  receives a bundle".
- `metrics-and-validation.md:36-47` — the manual runbook is a strict two-party script: "initialize
  both profiles", "publish both v2 bundles", "stop Bob, send from Alice", "reply from Bob", "print
  both histories". No third party appears anywhere.
- `metrics-and-validation.md:78` — the claim allowed after a pass is scoped to "Two local computer
  CLI clients exchanged encrypted text through the Echolet relay".

So this breaks an **unclaimed** guarantee, not a claimed one. The prototype's stated scenario is
unaffected, and the T42 verification result stands. What it does affect is AC-10
(`specification.md:151`: "documentation and status reports describe the result as a computer
technical prototype and retain the dependency/security limitations") — a limitation of this shape
belongs in the retained limitations list, not in a footnote.

## 7. Recommendation

**Recommended: a small fix inside the frozen eight-command surface, plus a documented limitation.
Not a new command.**

Two changes, both strictly inside the eight commands:

1. **Preserve the relay's error code (the actual defect).** Add `PREKEY_BUNDLE_UNAVAILABLE` to the
   `remoteCodes` allowlist at `relayClient.ts:11`, and let `cli.ts:336` surface
   `error.remoteCode` when present instead of flattening every non-retryable `RelayError` to
   `PROTOCOL_REJECTED`. Exit code `3` may stay — this is about the operator being able to tell an
   exhausted prekey from a trust failure. Trade-off: the CLI's failure vocabulary grows beyond the
   five codes an operator currently has to learn, and `cli.ts:336` stops being a single line. That
   is a small, contained cost against an error that is currently actively misleading.
2. **Do not silently succeed on a re-publish that restores nothing.** Probe step 5 is the more
   dangerous half: the recipient's recovery attempt reports `ok`. At minimum the `relay publish`
   result should distinguish "stored, available for claim" from "already stored, previously claimed".

**Do not** add a ninth `rotate` command, and do not make `publish` rotate implicitly. Adding a
command breaks the frozen surface this flow is validating. Making `publish` rotate implicitly would
destroy the lost-response retry guarantee at `specification.md:130` ("Claim response lost → Retry
the same `claim_id` and receive the same exact bundle") and the deliberate design recorded at
`profile.ts:132-136`; it would also collide with the OTK reservation at
`signal_prekey_bundle_v2.go:49-62`. T38-L-001 should stay open as a known gap.

3. **Document the limitation.** The final status documentation should state plainly: *through the
   CLI, a published bundle serves exactly one first-contact sender; the CLI has no command to
   allocate a fresh one-time prekey, so a second distinct sender cannot establish a first session
   with the same recipient.* This is a real structural limitation of the prototype, correctly
   derived from the specification's one-time-prekey rules, and it is not covered by any acceptance
   criterion.

Nothing was implemented. No source, test or configuration file was modified.

## 8. Probe artifact removal

The probe lived entirely outside the repository at
`<scratchpad>/probe.mjs`, and created its temporary relay binary, relay data directory and three
profiles under a `mkdtemp` directory inside the scratchpad. That directory is removed in the
probe's own `finally` block (confirmed by its final log line). The probe script itself was deleted
after the run. `git status --porcelain` after the probe is byte-identical to the session-start
snapshot — 23 untracked entries, no modified, added or deleted paths. The only writes inside the
repository were `.gocache/` (pre-existing Go build cache, present at session start) and
`.metaproject/data/gdctx/` routing logs written by the mandated tooling.

## 9. Routing audit

- `graph_used`: yes — `keryx gdgraph context` for freshness (working tree clean, 79 files indexed);
  concept-to-code navigation then went through `keryx ctx rg`.
- `wiki_used`: partial — `wiki/index.md` was read first as required; all 16 pages are auto-generated
  drafts with no domain, business-rule or decision content, so it carried nothing on prekey claim
  semantics (`not-relevant` beyond the index read).
- `ctx_used`: yes — `keryx ctx rg` for every code search, `keryx ctx run` for every long-output
  command.
- `raw_rg_used`: no.
