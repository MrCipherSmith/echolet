# Official session reference implementation

Date: 2026-09-06. User requested continuation of flow 001; implementation of safe replacement is authorized.

## Evidence and decision
Official @signalapp/libsignal-client 0.102.0 passed isolated trust, session and replay/tamper tests on Node/darwin arm64. Unlike rejected community candidates, its async trust decisions are enforced. Implement a Node-only reference package using these native bindings. Do not import Node bindings into React Native. Do not label Node evidence as device acceptance or release approval.

## Scope
New packages/session-node provides official SignalClient and EncryptedSqliteStore, separated from existing demo exports. Preserve existing relay/mobile wire contracts until explicit versioned integration. Release demo guard remains enabled. Reference package is an executable contract for future Swift/Java bridge work.

## Storage contract
src/store.ts defines synchronous get/set/delete/keys within serialized async transaction callbacks. Every callback commits all opaque records or none; resolution follows durable commit. Store returns/copies bytes to prevent external mutation. No network I/O in transaction. Exactly one local device per store; encryption key supplied separately by caller, never generated alongside encrypted database or persisted by store.

## SQLite implementation
Node built-in SQLite, encrypted authenticated snapshot per commit with AES-256-GCM from Node crypto and fresh random nonce. SQL transaction holds read through write, FULL synchronous mode, fail-fast competing writer behavior. Reopen validates existing ciphertext and key; errors must not reset state. Snapshot approach is bounded reference implementation, not scalable production mobile DB. No rollback protection against a replaced old valid database snapshot is claimed.

## Acceptance and tests
- Close/reopen restores official identity, prekeys and sessions, including replies and delayed delivery.
- Untrusted/changed remote identities reject both first and subsequent traffic.
- Session advancement and exact outbox ciphertext commit together; retry sends stored bytes without re-encryption.
- Failed transactions do not advance sessions, consume prekeys or expose ciphertext for sending.
- Concurrent writes serialize without lost updates; another connection cannot overwrite an active transaction.
- On-disk files contain no plaintext record values/keys; wrong encryption key and modified ciphertext fail closed without rewriting data.
- Native/real-device tests, wire migration and external audit remain open.

## Sources
https://github.com/signalapp/libsignal
https://nodejs.org/api/sqlite.html
https://nodejs.org/api/crypto.html
