# Paused — resume state

Paused by the user on 2026-09-08 at HEAD `c5fde09`, which is pushed and green.

## Tree state

No product file was modified after the last commit, so the committed tree is exactly what was pushed. Two agents were stopped mid-flight and left **four untracked, incomplete and unverified** test files:

- `apps/cli/src/tui/tui-shell.trustViewport.test.ts`
- `apps/cli/src/transport/relayClient.protocolMirror.test.ts`
- `apps/relay/internal/protocol/limits_mirror_test.go`
- `apps/relay/internal/service/cleanup_service_stop_join_test.go`

None was committed, and **none has been shown to kill the mutation it exists for**. Treat them as drafts to finish, not as work done. `t26-replenishment-design.md` landed just after the pause; its result is summarised below but has not been acted on.

## The replenishment design, as delivered

N = 20 independently signed bundles — the count the protocol already declares as `PREKEY_MIN_COUNT` and that no source file references, so the pool was specified and never built. `relay publish` becomes idempotent-with-top-up. **No relay change, no wire change, no schema change, no rollout flag.**

The honest arithmetic: victims per minute is `R·S/N`, so N = 20 turns 120 into 6 from one source — a 20× increase and nothing more. Holding one source below one victim per minute needs N ≥ 120, which costs the victim 7.4 s per publish and their whole request budget. And the per-unit asymmetry runs against the defender: measured, an attacker destroys a bundle in 2.0 ms while the victim mints and publishes one in 61.6 ms — one request destroys a member, two requests (a resubmit plus a fresh mint-and-publish) restore one — so **one** source address already out-drains a refilling victim, at two to one: 120 members destroyed a minute against a recovery ceiling of at most 60, and the rate limiter cannot help, being keyed on the peer host. *(Corrected 2026-09-08 per T25 round 2, finding R2-006 — this note originally said "two source addresses"; the design document has been corrected to match.)*

Signal's last-resort key is **not** adopted: both its shapes were measured to be refused by the deployed protocol, it would need its own two-deployment flag, and it contradicts the standing reservation guards.

Sequencing: **replenishment lands before claim authentication.** It is client-only against authentication's two strictly-ordered deployments, and it is the only one of the two that helps a victim who has already been drained. The payoff worth filing afterwards is the joint one: attribution plus a pool plus a per-claimant quota Q bounds a minted identity to Q/N victims — the first non-linear bound in this work, and neither change reaches it alone.

Two warnings for whoever implements it: `publication-claimability.test.ts` steps 6 and 7 become false under a pool and must be rewritten even though that file's hash is cited as evidence in two earlier tasks; and the sentence "a published bundle serves exactly one first-contact sender" is false at eleven enumerated sites across documentation and code comments.

## Why the wave is not closed

The independent verification (`t25-verification-report.md`) returned DONE_WITH_CONCERNS and should be read first on resume. Four criteria are not met, and two properties this wave presents as load-bearing are pinned by no test at all:

- ~~**The trust-modal viewport guard.**~~ **Closed (T27, re-verified by mutation on 2026-09-09).** Deleting `&& !isBelowMinViewport(painted)` from `tui-shell.ts:343` now fails three tests in `tui-shell.trustViewport.test.ts`, one per axis, which drive the real shell through `onTrustIdentifiers` at four viewports. The claim below — that it was a comment with no enforcement — was true when written and is false at `ac51393`.
- ~~**The size relationship, in one direction only.**~~ **Closed (re-verified by mutation on 2026-09-09).** Lowering `MAX_MESSAGE_BYTES` to 131072 now fails the Go mirror test and three TypeScript tests; lowering `MaxMessageBytes` on the Go side fails the mirror test. Both directions are dead. Round 1's "83 tests green" reproduction was itself wrong.

## Decisions already taken — do not re-open them

- `test:e2e` is **repointed** at the whole `test/e2e` directory, not renamed. The name says what it should do, so it should do it; renaming would leave a state where nothing runs the full set under any name.
- The cleanup interval knob is **removed**, not implemented behind. Retention is the store's TTL. An operator-facing dial that turns nothing is worse than no dial.
- The ninth CLI command for rotation is **retired** in favour of bundle replenishment, which reaches recovery through `relay publish` — a command that already exists.
- Claim authentication ships **behind a flag defaulting off**, in the order: relays flag-off, then clients, then flip. The v2 decoder is exactly closed, so there is no additive rollout in either direction, and two relays are live.

## Open tasks

T27 (tests for the three unpinned properties) and T28 (second documentation reconciliation, repoint the script, remove the knob) were dispatched and stopped; both need re-dispatching from scratch.

Still outstanding beyond those: the claim-authentication implementation from its design, the replenishment design's review and implementation, the push-gate fix's durability (it lives in untracked `.git/hooks` and `keryx update` will revert it), bringing the Go suite inside the push gate, the tests that fail under CPU contention, and the fifteen items in the inventory's *fix with care* bucket.

## One structural problem worth solving rather than repeating

Documentation was reconciled mid-wave at `4346e2b`; six behaviour-changing commits landed after it, and by the end of the wave the same documents were stale again. That has now happened twice. A third reconciliation pass would be the wrong answer.

## Deployment

Both relays are live and unaffected by the pause: `geekom` and `depr` serve real TLS on their tailnet addresses, certificates valid to 6 December 2026, renewal automated on both — a user-scope timer on one, a root-scope timer on the other, a difference documented in four places because it is silent.
