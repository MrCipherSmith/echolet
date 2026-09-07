# Structured Plan

1. `identity-mobile`
   - fix `createIdentityProfile`
   - reuse generated profile in onboarding
   - wire app entry screens
2. `crypto-session`
   - replace placeholder encrypt/decrypt behavior
   - preserve serializable session state
3. `relay-auth`
   - verify `device_record` signatures
   - verify mailbox challenge/poll/ack ownership signatures
4. `tests`
   - add vitest coverage for identity/session/mailbox helpers
   - add Go tests for relay validation and mailbox auth
5. `docs`
   - correct status overstatements
   - finalize job report

---

<!-- Document Metadata -->
| Key | Value |
|-----|-------|
| Created | 2026-04-12T20:14:09Z |
| Agent | job-orchestrator |
| Task | Structured plan |
| Job | task--echolet-fix-critical-review-findings |
| Version | 1.0 |
| Status | final |
