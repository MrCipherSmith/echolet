# Analysis

## Scope
Job targets the concrete findings provided by the caller and only the code present in this workspace:
- mobile onboarding and app wiring
- client identity/session helpers
- relay validation and mailbox authorization
- status docs accuracy
- automated coverage for the affected flows

## Confirmed Current Problems
1. `apps/mobile/src/screens/OnboardingScreen.tsx` generates one identity for display and a second one before relay publish.
2. `packages/client-core/src/identity/createIdentityProfile.ts` generates a mnemonic but does not derive any keys from it, so recovery is impossible.
3. `apps/relay/internal/validation/validate.go` checks signature presence only; no cryptographic verification is performed.
4. `apps/relay/internal/api/handler/mailbox_handler.go` accepts challenge/poll/ack requests without proving mailbox ownership through a verified signature.
5. `packages/crypto-core/src/session/session.ts` returns placeholder ciphertext/plaintext and uses zero shared secret material.
6. `apps/mobile/src/app/App.tsx` mounts only a placeholder view and does not route onboarding/terminal into the live app.
7. `docs/STATUS*.md` claim stronger completeness than the codebase actually provides.
8. The workspace has no existing tests for these critical paths.

## Feasible Fix Strategy
- Make identity generation deterministic from seed and reuse the same profile through onboarding publish flow.
- Add shared helpers for relay/device signatures and mailbox challenge signing.
- Enforce relay-side signature verification for `device_record`, `prekey_bundle`, and mailbox poll/ack ownership checks.
- Replace placeholder session encrypt/decrypt path with real authenticated encryption based on derived shared secret material that works within current repo constraints.
- Wire the actual mobile app flow so onboarding leads into terminal.
- Add Vitest coverage for TS crypto/identity/app helpers and Go tests for relay validation/mailbox auth.
- Rewrite status docs to explicitly state what is now implemented and what is still incomplete.

## Constraints
- No branch/worktree or PR creation.
- Complete as much as possible in one pass inside the current workspace.
- Keep docs under `/Users/Goodea/goodea/projects/echolet/jobs/task--echolet-fix-critical-review-findings/`.

---

<!-- Document Metadata -->
| Key | Value |
|-----|-------|
| Created | 2026-04-12T20:14:09Z |
| Agent | job-orchestrator |
| Task | Analyze critical review findings and feasible implementation scope |
| Job | task--echolet-fix-critical-review-findings |
| Version | 1.0 |
| Status | final |
