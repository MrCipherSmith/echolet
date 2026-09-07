Task ID: Fix critical review findings
Status: completed

What was implemented:

- deterministic seed-derived identity and device keys
- onboarding reuse of one generated identity profile for publish
- signed mailbox challenge creation request
- mobile app wiring to onboarding, messaging, and terminal screens
- relay-side cryptographic verification for device records and prekey bundles
- mailbox challenge/poll/ack ownership and signature checks
- working session encrypt/decrypt path in `packages/crypto-core`
- mobile demo flow for publish prekey → send envelope → poll mailbox → decrypt
- automated tests across protocol, client-db, client-core, crypto-core, and relay

Checks performed:

- `pnpm typecheck`
- `pnpm test`
- `env GOCACHE=/Users/Goodea/goodea/projects/echolet/.gocache go test ./...` from `apps/relay`

Acceptance result:

- PASS with known remaining architectural gaps

Remaining gaps:

- session layer is still not the final libsignal/double-ratchet target
- full production-grade multi-contact mobile messaging flow is still absent

Next recommended task:

- replace the current demo session/bootstrap flow with the final RFC-aligned production stack and grow it into multi-contact chat UX
