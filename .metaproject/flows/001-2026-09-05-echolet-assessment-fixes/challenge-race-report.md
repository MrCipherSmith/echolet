# T14: Atomic mailbox challenge consumption

Implemented transactional read + validity recheck + delete in ChallengeRepository.Invalidate. Badger conflict/missing/used/expired maps to ErrInvalidChallenge; authenticated handler maps it to existing CHALLENGE_EXPIRED HTTP 400. Other storage failures during the new consume/update operation return HTTP 500. The pre-existing GetValid read-error branch still maps read errors to CHALLENGE_EXPIRED; this change does not claim to fix that classification. Ownership and signature checks occur before consumption. Service exposes sentinel and no longer tries to consume an already expired challenge as cleanup.

## Files
- apps/relay/internal/storage/repository/challenge_repo.go
- apps/relay/internal/storage/repository/challenge_repo_test.go (new)
- apps/relay/internal/service/challenge_service.go
- apps/relay/internal/api/handler/mailbox_handler.go
- apps/relay/internal/api/handler/mailbox_handler_test.go
- docs/PROTOCOL-07_MVP_MESSAGE_FLOW.md
- docs/API-11_JSON_SCHEMAS.md
- docs/THREAT-08_MODEL.md

## Executable evidence
RED: repository test synchronizes 16 readers before consumption. Original implementation allowed 16 successful consumers; also accepted expired and used challenges. Command: go test ./internal/storage/repository -run TestChallengeInvalidate -count=1.

GREEN: go test -race ./internal/storage/repository ./internal/service ./internal/api/handler -count=1 passed (service has no test files). Repository asserts exactly one consumption and all losers ErrInvalidChallenge; handler concurrent test asserts exactly one HTTP 200 and all others HTTP 400 CHALLENGE_EXPIRED. Existing handler invalid-signature followed by successful valid poll confirms invalid signature does not consume.

After tightening loser error assertions, focused race detector command passed: go test -race ./internal/storage/repository ./internal/api/handler -run 'TestChallengeInvalidate|TestMailboxConcurrentPoll|TestMailboxPollAndAck' -count=1.

No API widening, crypto change, new dependency, or Git/flow state writes. No claim of full security readiness. Deterministic create-challenge and ack replay limitations remain documented.

## Routing
Graph find attempted: no Go challenge nodes; targeted keryx ctx rg/read fallback. Wiki index previously read (empty). Testing context read; related-test tool had no Go tests, explicit Go checks used. gdctx captured raw test logs and summaries under .metaproject/data/gdctx. graph_used: yes (no match); wiki_used: empty index; ctx_used: yes; raw_rg_used: no. New test file requires graph rebuild before relying on subsequent graph answers.
