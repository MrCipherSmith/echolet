# Independent encrypted storage review

STATUS: DONE. Verdict: APPROVE for bounded Node reference scope; not mobile security acceptance or external audit.

## Scope and spec gate

Reviewed `packages/session-node/src/EncryptedSqliteStore.ts`, `EncryptedSqliteStore.test.ts`, and `store.ts` against `official-session-spec.md`. No Git repository; exact file scope supplied by orchestrator. Spec compliance checked first: synchronous opaque record operations inside serialized async callbacks, commit-or-rollback snapshots, independent caller key, read validation without silent reset, and competing writers. These storage requirements are addressed. SignalClient-specific behavior is reviewed by another worker.

## Result

No blocker or major defect found. The promise queue recovers from callback rejection; AsyncLocalStorage rejects active nested calls; expired transaction access is rejected and byte buffers copied. BEGIN IMMEDIATE spans read, callback, encrypted snapshot update and COMMIT. Callback results return only after successful COMMIT. Existing state is authenticated before use; wrong keys/corruption do not initialize a replacement state. New files use exclusive creation; a competing initializer can fail rather than overwrite. Snapshot rollback attacks are explicitly outside the contract.

## Follow-up accepted

Initial review requested a meaningful COMMIT-failure regression, since callback-throw tests alone do not exercise failed durable commit. Parent added a real second SQLite connection holding a reader lock. The final test confirms a successful callback's return value is rejected when COMMIT fails, session/outbox changes are absent, the SAME store queue accepts a recovery transaction, and that recovery record survives reopen. Final source inspected at lines 103–132. This closes the suggestion. Independent final workspace run passed all 32 cases, including 17 session-node cases and 7 storage cases; see `official-session-verification.md`.

## Limits

No power-cut/filesystem-fault harness, formal crypto analysis, malicious filesystem-owner defense, memory-forensics guarantees or physical-device run. SignalClient tests separately cover SIGKILL before/after commit; SIGKILL is not a hardware power-loss simulation. Snapshot size/performance is intentionally bounded reference behavior. No demand for mobile production features imposed on this Node-only package.

## Routing

graph_used: rebuilt 51 nodes/65 edges, affected store context. wiki_used: empty index, no domain pages. ctx_used: source/spec/testing/skill reads and focused test command. raw_rg_used: no. Local review-logic and review-security-code skills used; testing context consulted. Normalized testing latest predates this package and is not evidence for the new package; focused command evidence is `.metaproject/data/gdctx/artifacts/2026-09-06T07-59-20-024Z_run.md`.
