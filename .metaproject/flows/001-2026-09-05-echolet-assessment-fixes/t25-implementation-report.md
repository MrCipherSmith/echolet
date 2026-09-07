# T25 implementation

Implemented the reviewed CLI specification and validated T25 task input. No tests, relay code, dependencies, commits, or flow state were changed.

- RelayClient now exposes strict challenge/poll/ack methods through the existing bounded, redacted request boundary. Ack responses must match the requested count.
- Profile signs mailbox-specific transcripts internally using the stable encrypted identity. Temporary decoded key bytes are wiped and private identity material is not returned.
- Incoming envelopes validate recipient routing, timestamps, size, sender device and persisted Signal identity pin. The ciphertext wrapper requires canonical base64url, strict version/type/body fields and valid UTF-8. Native decrypt verifies the authenticated message ID and remote identity.
- The entire received batch commits native session/prekey changes, inbox hashes, monotonic encrypted history and pending acknowledgements together. A failure rolls the batch back and sends no ack.
- Acknowledgements occur after commit. Pending ack records survive restart; explicit retry performs only ack calls. Exact redelivery under another envelope ID reuses the inbox hash and adds no history; changed ciphertext fails closed.
- Outbound history is now appended within the same transaction as native encryption and the CLI outbox. Offline history reads are ordered by a durable local sequence shared across directions.

## Verification

All logs are under `.metaproject/data/gdctx/artifacts/`.

- RED: missing inbound module (`2026-09-06T11-30-32-678Z_run.md`).
- Focused GREEN: all ten unchanged T25 tests (`2026-09-06T11-32-42-694Z_run.md`).
- Workspace GREEN: 73 tests, including CLI 28/28 (`2026-09-06T11-33-19-923Z_run.md`).
- Workspace typecheck PASS (`2026-09-06T11-33-19-178Z_run.md`).
- Tests exercise real official Signal and encrypted SQLite, including commit failure injection, wrong native identity, replay, ack timeout/restart and plaintext absence on disk/network/diagnostics.

## Integration notes

`openInboundMessenger` exposes `poll`, `retryPendingAcks`, `history`, `diagnostics`, and `close`. `poll` returns the delivered batch count as `received`; history contains authenticated plaintext and must be displayed only by an explicit history command. Native runtime composition remains internal to the CLI; callers must not retain transactional objects. The Go relay currently owns batch size and returns no cursor; the client requires `next_cursor:null`.

The prototype still needs the separate CLI entrypoint and real relay E2E demonstration. These tests do not establish production readiness.

Routing audit: ctx_used=yes; raw_rg_used=no; graph_used=no (not-relevant: exact bounded dispatch paths); wiki_used=no (not-relevant: reviewed specification and explicit relay contract supplied).
