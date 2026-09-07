# Wire v2 independent verification

STATUS: DONE_WITH_CONCERNS. VERIFICATION_RESULT: **PASS_WITH_WARNINGS**.

## Acceptance and review

**T20 spec acceptance: PASS** for strict shared Signal bundle v2 and Node export/verified import only. **T21 independent review: APPROVE, no remaining actionable findings.** Source review in signal-wire-v2-review.md. No relay routes, one-time-key allocation service, mobile bridge or device readiness accepted by this increment.

Reviewed protocol schema/test/index and Node wire.ts/wire.test.ts/index. Signature coverage, stable tuple, canonical base64url/prefixes, original legacy DR capabilities ordering, trusted expected root/device, pre-await snapshots, native signatures, null consumed OTK and immutable existing trust pins satisfy the bounded spec.

## Independent executed checks

| Check | Result | Evidence |
|---|---|---|
| pnpm typecheck | PASS | 6 selected packages; `.metaproject/data/gdctx/artifacts/2026-09-06T08-42-37-208Z_run.md` |
| keryx test run | PASS | normalized `.metaproject/data/testing/artifacts/latest.md`, pnpm-script exit 0 |
| Vitest cases | 43 PASS | protocol6 (4 v2+2 existing), crypto-core4, client-db1, client-core2, session-node24 (7 wire+10 client+7 store), mobile6 |
| Public entry bundle/import | PASS with ESM/CJS interoperability shim | Four functions/classes present: SignalClient, EncryptedSqliteStore, exportSignedSignalBundleV2, importVerifiedSignalBundleV2 |
| Graph | PASS for graph scope | rebuilt55 nodes/72 edges; no cycles |
| Lint | UNAVAILABLE / ineffective | pnpm lint exit0 but no selected package has lint script; `.metaproject/data/gdctx/artifacts/2026-09-06T08-42-29-412Z_run.md` |
| Docs | PASS |35 top-level Markdown documents, zero broken relative links;52 JSON fences parse; anchors/semantic schemas not claimed |
| Go | PRIOR PASS, not rerun | Go unchanged this increment; earlier race suite evidence retained in verification-report.md |

## Build caveat

The package exports source TypeScript and has no production build script. Existing esbuild0.25.12 was used to bundle protocol/crypto with Node platform and official libsignal external. Initial plain ESM bundle import failed because existing tweetnacl uses dynamic require('crypto'). Adding standard createRequire(import.meta.url) interoperability shim to the temporary bundle made import pass. No source changed, temporary bundle deleted. This proves a bounded configured bundle can load; it does not establish ready-to-publish packaging or browser/mobile bundling. The public wire exports were explicitly checked.

## Normalized report limitations

Read normalized Testing Module output before raw runner log. Its aggregate counts passed=2 do not equal individual cases;43 cases derived from the runner log, archived in `.metaproject/data/gdctx/artifacts/2026-09-06T08-43-07-516Z_read.md`.

Fresh health auto PASS/score97 generated2026-09-06T08:42:53.957Z still lists ESLint/typescript skipped, tests and coverage missing. Two P2 complexity findings remain (MessagingScreen max16, EncryptedSqliteStore max18). Health did not integrate separately run typecheck/tests, so auto PASS is not a comprehensive quality claim.

## Remaining boundaries

Caller expected identity/device must originate from a trusted contact decision. Direct exchange of an optional OTK is not transactional relay allocation; previous signed bundles can still contain already consumed public keys and are not a server allocation protocol. Legacy DR root signatures deliberately depend on nested capabilities order even though the v2 transcript itself does not. Native device tests, external audit, revocation/current DeviceRecord selection, relay migration and actual pilot evidence remain open. No implementation of custom Signal cryptography was introduced.

Routing: project index read; local review-logic/security and code-verifier/testing skills used in same task chain. graph_used: build/query; wiki_used: empty index; ctx_used: spec/source/testing/report reads and command summaries; raw_rg_used:no. No runtime/dependency/flow-state/Git edits by reviewer.
