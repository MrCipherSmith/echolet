# T24 implementation

Implemented the reviewed CLI outbound scope from `docs/requirements/echolet-cli-prototype/specification.md` and validated `dispatches/001-T24-implement-input.json`.

- Strict publish/claim/send transport validates both complete response structure and correlated identifiers. Deadline covers fetch and body parsing; response size is bounded. Remote messages and underlying exceptions are never exposed.
- First send commits a claim identifier before contacting the relay. All four trusted contact identifiers and native/root/device signatures are checked before creating a session.
- Native encryption state and the exact CLI mailbox envelope commit in one encrypted transaction. Pending sends verify their native durable ciphertext using `SignalClient.retry`; reopen retry preserves the serialized request and allocates no identifiers.
- Identical delivered replay performs no network request. Changed content under an existing message identifier fails locally. Runtime operations serialize within the messenger.
- `Profile.withRuntime` is an internal composition boundary; callbacks must not retain the transaction, native client, or record. Public diagnostics return only the existing redacted summary.

## Wire contract for inbound integration

`MailboxEnvelope.ciphertext` is base64url of UTF-8 JSON with exactly `{version:1,type:number,body:string}`, where body is canonical base64url native Signal message bytes. Use the outer `message_id` when passing `{messageId,type,body:Uint8Array}` to native decrypt; the native authenticated payload verifies that identifier. Inbound must validate the wrapper strictly before decoding. Envelope `size_bytes` counts UTF-8 bytes of the encoded ciphertext string.

The runtime's `delivered` result means relay acceptance, not a recipient read/decrypt receipt. Incoming poll/decrypt/history and CLI command wiring remain separate tasks.

## Verification

- RED: focused suites failed to import the two missing modules (`2026-09-06T11-15-44-897Z_run.md`).
- GREEN: unchanged focused tests 9/9; final CLI suite 18/18 (`2026-09-06T11-19-43-802Z_run.md`).
- Workspace tests passed, 63 tests across seven packages (`2026-09-06T11-19-11-842Z_run.md`).
- Workspace typecheck passed (`2026-09-06T11-19-17-690Z_run.md`); final CLI typecheck passed (`2026-09-06T11-19-45-343Z_run.md`).
- Logs above are in `.metaproject/data/gdctx/artifacts/`. Existing normalized health/testing artifacts predate this change; no new security or production-readiness claim is made.
- No test edits, relay edits, dependency changes, commits, or flow/acceptance changes.

Routing: ctx_used=yes; raw_rg_used=no; graph_used=no (not-relevant: exact file dispatch, no structural discovery); wiki_used=no (not-relevant: reviewed task specification supplies bounded behavior).
