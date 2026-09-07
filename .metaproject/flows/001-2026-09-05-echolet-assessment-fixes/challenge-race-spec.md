# Atomic challenge consumption

Problem: concurrent authenticated polls can both validate a challenge before separate unconditional deletes, allowing repeated use.

Scope: Go challenge repository/service and mailbox handler with colocated tests; no API or crypto change.

Implementation: make repository Invalidate a transactional read/validate-expiry/used/delete operation. Badger conflict or missing/expired/used record maps to invalid-challenge sentinel. Handler invokes this only after signature and ownership verification; invalid challenge returns existing CHALLENGE_EXPIRED HTTP 400; storage failures remain HTTP 500.

Acceptance:
- Competing consumers that both already observed the same valid challenge: exactly one successful atomic consumption.
- Concurrent authenticated HTTP polls: exactly one HTTP 200, others CHALLENGE_EXPIRED.
- Invalid signature cannot consume challenge; existing ownership validation preserved.
- Expiry and used flag are rechecked during consumption.
- Focused Go tests and race detector pass. Runtime tests require no new dependencies.
