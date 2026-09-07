# T32 implementation

The existing validated T32 task input specifies the integration correction: successful v2 publication must register its already root-verified device for mailbox authorization, in the same transaction.

The validated Signal model now carries the embedded DeviceRecord. Validation converts that record only after root and bundle signatures pass. `SaveSignalV2` writes the existing `device_record:<identity>:<device>` authorization index inside its bundle/OTK Badger transaction. Existing records require matching identity, device and public key and are preserved. Identical bundle republish can backfill missing authorization without changing raw bytes, claim state or OTK reservations. Bundle conflicts and device key conflicts return without committing any writes.

No second transaction, v1 route change, test edits, CLI edits, dependency changes, commits or flow state edits.

## Verification

- RED: real-router publication succeeded but challenge returned 403 (`2026-09-06T11-36-45-991Z_run.md`).
- Focused `go test -race -tags=relayv2 ./internal/api/router`: PASS (`2026-09-06T11-37-41-955Z_run.md`). Includes all three unchanged T32 cases: restart authorization, invalid publication, conflicting key rejection.
- Full `go test -race -tags=relayv2 -timeout=90s ./...`: PASS (`2026-09-06T11-37-59-563Z_run.md`).
- Full `go test -timeout=90s ./...`: PASS (`2026-09-06T11-38-03-903Z_run.md`).

Logs are under `.metaproject/data/gdctx/artifacts/` relative to the relay command's project discovery. This is bounded integration evidence, not a production-readiness claim.

Routing: ctx_used=yes; raw_rg_used=no; graph_used=no (not-relevant: exact dispatch files); wiki_used=no (not-relevant: explicit task contract and existing repository format).
