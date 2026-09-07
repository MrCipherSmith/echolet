STATUS: DONE_WITH_CONCERNS

# Logic review

Stage 1: PASS for implementation coverage; AC mapping is in the result JSON. T27 is prior verification evidence, not a fresh test run.

Three major findings; no blockers.

## [F-001] Repeated relay publication creates a different signed bundle for the same reserved one-time prekey.

- Severity: major
- Location: `apps/cli/src/runtime/outbound.ts:33`
- Impact: After relay publish commits but its response is lost, rerunning the CLI command submits a new bundle ID containing the same OTK. The relay rejects the retry under its permanent OTK uniqueness contract, so the user cannot recover a successful publication result. Even repeating a successful publish fails.
- Evidence: outbound.ts:33 calls profile.exportContact on every attempt; profile.ts:89 calls exportSignedSignalBundleV2; wire.ts:51 assigns randomUUID; SignalClient.ts:228 reads the unchanged pre:1. Specification Relay v2 Publish permits idempotence only for identical stored bundle bytes and forbids OTK reuse under a new ID. This is a source-derived reproduction; no relay mutation was performed.
- Fix: Persist the exact signed publication bundle before the first network call and reuse it across attempts and process restarts. Keep allocation of a fresh OTK and a fresh bundle as a separate explicit operation.
- Class scope: apps/cli/src/runtime/outbound.ts:33, apps/cli/src/runtime/profile.ts:89, packages/session-node/src/wire.ts:51, packages/session-node/src/SignalClient.ts:228
- Enumeration: Enumerated the single runtime publish producer and its export/publicBundle call chain; keryx ctx rg for publish, bundle_id: randomUUID, and preBytes verifies the producer and reuse sites.

## [F-002] Interactive contact confirmation waits for stdin EOF instead of accepting a completed input line.

- Severity: major
- Location: `apps/cli/src/commands/cli.ts:144`
- Impact: A user entering yes followed by Enter at the displayed [y/N] prompt remains blocked; contact import does not finish until the user supplies EOF. A negative line also waits for EOF.
- Evidence: cli.ts:144-148 iterates until stdin ends, with only an overlength early return. A read-only probe extracted the exact function and supplied a PassThrough: settledAfterCompleteLine=false after a yes newline, acceptedAfterEOF=true only after input.end(). cli.test.ts:29 always ends stdin, masking terminal behavior.
- Fix: Read one bounded line using a readline interface or stop at the first newline, close the reader, and settle on EOF or an overlong answer without requiring stdin to close after a valid line.
- Class scope: apps/cli/src/commands/cli.ts:144
- Enumeration: keryx ctx rg readConfirmation found its single definition and sole contact-import caller at cli.ts:199; no other interactive reader exists in the CLI command implementation.

## [F-003] Runtime database failures are converted into trust/protocol errors and exit code 3.

- Severity: major
- Location: `apps/cli/src/runtime/outbound.ts:28`
- Impact: For example, let send finish its HTTP request while another SQLite connection holds BEGIN IMMEDIATE; the post-send delivery-state transaction fails with SQLITE_BUSY. Outbound serial rewrites it to OUTBOUND_REJECTED and classify returns 3, although the documented result for local persistence failure is 5. Inbound history/poll and contact-import commits similarly hide database failures as protocol or invalid-card errors.
- Evidence: EncryptedSqliteStore.ts:25 uses busy_timeout=0 and :61 begins each transaction with BEGIN IMMEDIATE. Outbound.ts:26-28 and inbound.ts:23-25 replace all non-domain/non-relay errors; cli.ts:201 catches all import errors as INVALID_CONTACT_CARD, and :252-253 maps domain errors to trustFailure. Wrong-key open failures are handled correctly, but failures after opening are not. Reproduction is source-derived, not executed.
- Fix: Introduce a typed persistence failure at the store boundary and preserve it through runtime and contact-import catch blocks; map it to redacted PERSISTENCE_FAILURE/exit 5. Keep typed validation, trust and native decrypt failures mapped to exit 3.
- Class scope: apps/cli/src/runtime/outbound.ts:28, apps/cli/src/runtime/inbound.ts:25, apps/cli/src/commands/cli.ts:201, apps/cli/src/commands/cli.ts:252
- Enumeration: Enumerated catch blocks with keryx ctx rg catch|OUTBOUND_REJECTED|INBOUND_REJECTED|PERSISTENCE_FAILURE across command and runtime files, then followed every store-transaction caller into the single CLI classify function; these runtime/import catch boundaries erase persistence errors while profile-open boundaries preserve exit 5.

## Checked and cleared

- A retry advances the outbound ratchet or changes ciphertext. outbound.ts loads the persisted CLI outbox, rejects changed contentHash, calls client.retry and compares exact ciphertext before HTTP; no new encrypt in the prior-record branch.
- Ack loss duplicates history or decrypts twice. inbound.ts commits native state, inbox hash, history and pending ack together. Duplicate ciphertext checks hash and bypasses decrypt/history. E2E verifies unchanged native snapshot and history after ack loss.
- Relay claim or inbound ciphertext silently creates a trust pin. profile.importContact alone records CLI contact and explicit native approval. Outbound compares the claim with pinned identity/device/keys; inbound requires both contact and native trust before decrypt.
- History read mutates ordering or mixes contacts. history.ts uses safe monotonic sequence keys and filters by exact contact identity; writes participate in enclosing atomic transactions.

## Limits

- No fresh full test suite was run; T27 evidence was read. Only the bounded confirmation-reader probe was executed.
- Deep review focused on CLI and its session/store/wire call chains; retained legacy helpers and relay implementation are not claimed as independently exhaustively audited.
- Publication and persistence scenarios are proven by source paths rather than live fault-injection runs.

Routing audit: graph_used: affected CLI; wiki_used: index (CLI domain pages unavailable); ctx_used: read/rg; raw_rg_used: no.
