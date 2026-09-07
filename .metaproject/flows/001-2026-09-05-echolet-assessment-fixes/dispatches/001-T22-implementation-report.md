# T22 Relay v2 implementation
Version: 0.1.0

Implemented additive v2 prekey publication and atomic claim, without changing v1 payload validators or routes. Local Go code, no commits or flow-state changes.

## Behavior

- Strict ordered JSON validation rejects unknown/duplicate fields, malformed encodings, invalid time/range/UUID constraints, forged root DeviceRecord signatures and forged device bundle signatures. Native EC/Kyber signature validation remains the claiming client's responsibility, as specified.
- Legacy root signature sorts only DeviceRecord top-level fields and preserves nested capabilities insertion order. V2 authenticates the shared fixed tuple, including all nested signatures.
- Immutable raw bundle bytes, permanent tuple/public-key reservations and available index commit in one Badger transaction. Repeated identical bytes are idempotent; bundle-ID mutation and OTK reuse conflict.
- Claim selection/marking/result storage are transactional with bounded conflict retry. Repeated claim and selector return exact persisted bytes; changed selector conflicts. Claimed/expired keys never become publishable again. Claim metadata includes bundle ID and claim time.
- Additive HTTP endpoints use bounded request bodies, strict required fields and stable 400/404/409/500 codes. Claim responses write the raw bundle slice directly rather than compacting via json.Encoder.

## Evidence

RED tagged repository suite failed because the v2 service methods were absent: 2026-09-06T10-49-53-771Z_run.log.

The independently authored mutation helper reconstructed every nested JSON object with Go map sorting, invalidating the fixture's legacy capabilities-order signature. Evidence: valid primary and concurrency/replay checks passed, but otherwise valid variants failed INVALID_SIGNATURE at 2026-09-06T10-53-38-900Z_run.log. Corrected only the helper to preserve untouched json.RawMessage subtrees; assertions and fixtures were not weakened.

GREEN:

- go test -race -tags=relayv2 ./...: all packages pass, 2026-09-06T10-56-57-106Z_run.log.
- go test ./...: all packages pass, 2026-09-06T10-57-27-856Z_run.log.
- pnpm --filter @echolet/protocol test: 8 passed, 2026-09-06T10-56-10-737Z_run.log.
- pnpm --filter @echolet/protocol typecheck: pass, 2026-09-06T10-57-25-842Z_run.log.
- Final repository race suite repeated after adding persisted claim time.

Added handler tests cover publish/repeat, strict errors, exact raw HTTP claim/replay, changed selector, unavailable and expiry; router test checks both v2 routes and surviving v1/health paths. Encoding regression tests distinguish literal escape text from U+2028 and match shared UUID version/variant constraints.

## Files

- apps/relay/internal/model/signal_prekey_bundle_v2.go
- apps/relay/internal/validation/signal_prekey_bundle_v2.go
- apps/relay/internal/validation/signal_v2_encoding_test.go
- apps/relay/internal/storage/repository/signal_prekey_bundle_v2.go
- apps/relay/internal/storage/repository/prekey_bundle_v2_test.go
- apps/relay/internal/service/signal_prekey_bundle_v2.go
- apps/relay/internal/api/handler/prekey_bundle_handler.go
- apps/relay/internal/api/handler/signal_prekey_bundle_v2.go
- apps/relay/internal/api/handler/signal_prekey_bundle_v2_test.go
- apps/relay/internal/api/router/router.go
- apps/relay/internal/api/router/signal_prekey_bundle_v2_test.go

## Limits and routing

Prototype retains reservations/claim results indefinitely; no public deployment or security-readiness claim. No Go lint script is configured; Go compilation/test tooling and race detector used. No new dependencies.

Paired task-implementer-input validated, current branch main verified; project/testing context and local skills read. graph_used: find PreKeyBundle; wiki_used: previously read empty index; ctx_used: searches/reads/test capture; raw_rg_used: no. Rebuild graph before relying on new files as indexed current code.
