# Protocol and security corrections

AC1 and AC2 addressed in five owned documents.

- HTTP JSON over TLS is the MVP transport; local HTTP is development-only, libp2p/QUIC deferred.
- Removed unsupported comparative metadata benefit; relay sees both identities/devices, timestamps and deterministic mailbox linkage. E2EE and ratchet described as requirements, not proof of current readiness.
- Challenge creation now includes required device signature. Documented exact domain-separated UTF-8 create/poll/ack signing inputs and ownership checks from TypeScript and Go.
- Documented padded nonce preservation, UUIDv4 runtime challenge IDs, sorted ack IDs, ack count semantics and lack of previous-poll binding.
- Clarified replay limits: creation and ack are deterministic signed requests; poll checks and invalidates in separate calls. Concurrent replay resistance is not claimed.
- Updated repeat flow instructions and actual listener ECHOLET_HTTP_ADDR. Callsign mining deferred consistently with pilot scope.

## Evidence read
- packages/crypto-core/src/mailbox/auth.ts
- apps/mobile/src/services/relayApi.ts
- apps/relay/internal/api/handler/mailbox_handler.go
- apps/relay/internal/cryptoutil/signatures.go
- apps/relay/internal/service/challenge_service.go
- apps/relay/internal/config/config.go (targeted setting lookup)

## Verification
All five documents: relative file link targets exist, non-placeholder JSON fences parse. No runtime edits; tests not applicable for these documentation-only changes. No commits (project not Git).

## Remaining concern
Concurrent poll check/invalidate race needs runtime follow-up; this change records the limitation without changing wire protocol. TLS deployment requirement is not evidence that current installation terminates TLS.

## Routing audit
- graph_used: gdgraph find mailbox challenge
- wiki_used: index read, no pages available
- ctx_used: targeted rg/read; gdctx saved raw logs. Exact sections read directly where compact output omitted needed signing details.
- raw_rg_used: no

## Modified files
- docs/SEC-01_IDENTITY.md
- docs/REP-02_REPEATER_NODE.md
- docs/PROTOCOL-07_MVP_MESSAGE_FLOW.md
- docs/API-11_JSON_SCHEMAS.md
- docs/THREAT-08_MODEL.md
