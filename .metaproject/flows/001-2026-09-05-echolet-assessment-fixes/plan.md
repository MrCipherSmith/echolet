# Implementation plan

1. Correct security/transport/auth specs against actual code; preserve current wire protocol.
2. Reorder delivery around crypto/mobile feasibility; document pilot hypothesis, measurable success/failure criteria, early independent review, and explicit deferred scope.
3. Investigate session runtime and mature-library integration with executable tests; implement safe, bounded corrections where possible and record unresolved platform dependencies.
4. Consolidate current status and link all authoritative documents; verify claims, contracts and links, run appropriate existing checks, independent review.
5. Keep runtime/mobile field tests and actual demand-validation tasks open until performed.

## Computer CLI prototype wave

6. T22: implement shared TypeScript/Go relay v2 fixtures, immutable raw-bundle persistence, permanent one-time-prekey indexes, and atomic idempotent claims.
7. T23: implement isolated CLI profiles, strict configuration and mutually verified contact cards that pin Signal identities before messaging.
8. T31: align the v2 publish success response with the strict client by echoing the validated `bundle_id`.
9. T32: atomically register the root-verified DeviceRecord embedded in v2 publish so existing mailbox challenge authorization works without a legacy publish call.
10. T24-T25: add typed relay transport, durable exact-byte send retry, authenticated polling, transactional decrypt/history and post-commit acknowledgement.
11. T30: expose the reviewed `init`, contact, relay, send, poll, history, and doctor command surface with stable exit/error behavior.
12. T26: prove the behavior with two child CLI processes, separate stores, offline delivery, ambiguous-send replay, receiver restart and duplicate suppression.
13. T27-T28: run focused and workspace checks, Go race tests, Code Health and independent logic/backend/security/high-load review; fix all blocker/major/minor findings.
14. T29: update current status and write the audited change report. Keep mobile/audit/pilot tasks open and make no product-readiness claim.

The implementation specification is the reviewed package at `docs/requirements/echolet-cli-prototype/`; the user's instruction to start implementation confirms that spec. TDD applies to every code task.

## Alternatives
Full rewrite rejected: no evidence it solves demand or runtime risk. Documentation-only closure rejected: does not prove secure mobile messaging. Chosen staged remediation ties claims to evidence and keeps missing runtime gates visible.
