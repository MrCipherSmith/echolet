# Independent review — development messaging containment

Date: 2026-09-06. Reviewer: crypto worker, reviewing parent-authored runtime guard and other workers' documentation. Own crypto spike/report excluded from independent review. Go changes excluded as requested. No runtime/documentation changes made by reviewer.

## Scope and verdict

APPROVE for the bounded runtime containment change. No actionable blocker, major or minor found. This verdict is not acceptance of cryptographic implementation, production readiness or the whole flow.

No Git base exists; explicit path review used: `apps/mobile/src/screens/MessagingScreen.tsx`, `MessagingScreen.test.mjs`, `apps/mobile/src/app/App.tsx`, `apps/mobile/package.json`; docs README, STATUS_CURRENT, APP-03, OPS-23, DELIVERY-13 and PILOT-29. Read `runtime-guard-spec.md` and frozen ACs first. Used local review-logic skill.

## Stage 1: spec compliance

- MessagingScreen lines 46–79 requires both literal boolean `__DEV__ === true` and exact string `EXPO_PUBLIC_ECHOLET_ENABLE_UNSAFE_DEMO === "true"`. Undefined development flag is guarded with typeof. Release and unknown builds cannot enable demo through environment alone.
- Disabled branch returns before creating DemoMessagingScreen element; therefore its hooks and handlers do not mount. Demo implementation remains private to module. Static imports remain, which the spec does not prohibit.
- Enabled branch renders persistent warning outside the demo child, including when the child shows onboarding or chat content.
- App labels the product Prototype and Experimental relay messaging.
- Tests exercise actual exported MessagingScreen via server rendering and native primitive mocks. They prove gate rendering; they do not demonstrate device behavior or crypto correctness.
- Full workspace checks are orchestrator-owned; focused mobile execution passed. Real-device, library integration and pilot ACs remain open by design.

## Stage 2: logic and documentation

No newly introduced asynchronous, null-state or conditional-hook defects found in the wrapper. Parent routes messages through the guarded export. Existing demo crypto/state flaws remain intentionally contained and are not represented as fixed.

README routes readiness to STATUS_CURRENT and differentiates specifications from implementation evidence. APP-03 explicitly marks the client design as a target and describes containment. OPS-23 acknowledges Expo inlining versus explicit injection in other build setups; the repository currently starts via React Native, so real mobile opt-in is not demonstrated. This is an explicitly documented integration limit, not grounds to claim a device test passed.

DELIVERY-13 places G0 before dependent implementation, and PILOT-29 requires real-phone evidence, independent review and explicit pending product evidence. No material contradiction detected in these revised sections.

Assembly note: reviewed STATUS_CURRENT still says typecheck/Go results will be entered after current execution. Orchestrator must replace those in-progress placeholders with final evidence before user delivery; do not treat this review as validation of results not yet assembled.

## Verification evidence

Focused command `pnpm --filter @echolet/mobile test`: exit 0, six tests passed, 2026-09-05T23:56:54Z. Compact command artifact: `.metaproject/data/gdctx/artifacts/2026-09-05T23-56-54-498Z_run.md`. Testing normalized latest report was read first; this review does not overwrite project health status or turn server-render tests into native evidence.

Routing: graph_used=yes (affected screen, configuration find); wiki_used=index previously read, empty; ctx_used=yes (read/search/run); raw_rg_used=no. Targeted exact excerpts supplement compact output.


## Independent Go follow-up: atomic challenge consumption

Date: 2026-09-06. APPROVE for T14. No introduced blocker/major/minor found. Scope: challenge-race-spec/report, ChallengeRepository, ChallengeService, PollMailbox and corresponding repository/HTTP tests. Go execution is delegated to separate verifier; this follow-up is source review, not a new test-run claim.

Stage 1: transaction reads the same key it deletes, checks Used and expiry inside that transaction, and maps missing/conflicting records to ErrInvalidChallenge. Storage setup uses Badger defaults and does not disable conflict detection. PollMailbox checks request binding, mailbox ownership and signature before calling Invalidate. Only successful consumption reaches envelope retrieval; generic consume errors return 500 rather than permitting access.

Stage 2: the repository concurrency test synchronizes 16 successful pre-consumption reads before release, exercising precisely the old validation/delete gap. It requires one success and invalid-challenge errors for every loser. The HTTP test signs an actual shared challenge and requires one 200, all others 400 CHALLENGE_EXPIRED. The existing bad-signature-then-valid-signature case proves invalid signature does not consume. Used/expired cases exercise transactional rechecks. No ignored transactional errors or new acceptance path detected.

Documentation precision: mailbox_handler.go's pre-existing GetValid error branch maps even storage-read failures to CHALLENGE_EXPIRED 400. The report statement that storage failures remain 500 is accurate for the new consume/update branch, not all reads; parent notified to narrow wording. This pre-existing behavior denies access and is not a new replay defect.

Go graph discovery found no relevant Go nodes; exact assigned paths and ctx searches used. No own implementation reviewed. raw_rg_used=no.
