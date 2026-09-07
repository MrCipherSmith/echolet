# Plan

## Execution Order
1. Fix deterministic identity creation and reuse generated profile in onboarding.
2. Add mobile app flow state so the real screens are reachable from app entry.
3. Replace placeholder session crypto with real encryption/decryption and serialization-safe state handling.
4. Add relay-side signature verification and mailbox ownership validation.
5. Add tests for seed derivation, challenge signing, session encryption, relay validation, and mailbox auth.
6. Update status documentation to reflect actual implemented scope and residual gaps.
7. Run verification: targeted `pnpm` tests/typecheck and `go test ./...` with local `GOCACHE`.

## Acceptance Criteria
- Same identity profile is used for display and publish in onboarding.
- Seed deterministically recreates identity/device key material.
- Relay rejects invalid signatures for device records and mailbox auth requests.
- Mailbox poll/ack requires verified request ownership tied to stored device records.
- Session layer no longer returns placeholder ciphertext/plaintext.
- App entry mounts actual onboarding + terminal flow.
- Status docs do not overclaim implemented completeness.
- Automated tests cover the critical flows touched in this job.

---

<!-- Document Metadata -->
| Key | Value |
|-----|-------|
| Created | 2026-04-12T20:14:09Z |
| Agent | job-orchestrator |
| Task | Build implementation plan |
| Job | task--echolet-fix-critical-review-findings |
| Version | 1.0 |
| Status | final |
