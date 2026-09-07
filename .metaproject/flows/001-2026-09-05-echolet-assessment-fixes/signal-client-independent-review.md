# Independent SignalClient review

Verdict: APPROVE for the Node-only reference scope. No remaining actionable findings after the Unicode hash correction. This is not mobile/release/security-audit approval.

## Scope and Stage 1
Reviewed SignalClient.ts, its tests, store contract and README against official-session-spec.md. Local file review: no Git branch or issue fabricated. Stage 1 passes for SignalClient responsibilities: explicit pinned remote trust, official serialized identity/session/prekey records, session+exact outbox in one transaction, receive state+inbox in one transaction, no ciphertext resolved before commit, rollback after rejected operations. SQLite internals are independently reviewed by the parent/storage reviewer.

## Corrected finding
Original encrypt contentHash used UTF-8 plaintext while authenticated JSON escapes lone UTF-16 surrogates. Distinct strings \ud800 and \ud801 therefore compared equal for the same message ID, returning old ciphertext instead of rejecting different content. Crypto worker reproduced RED and changed hashing to the exact encoded {messageId,body} bytes passed to native encryption. Independent regression now passes. No client source was edited by this reviewer.

Class scope: all contentHash producers/consumers within SignalClient encrypt and OutboxRecord; one producer, one existing-record comparison. No separate retry hash producer.

## Stage 2 verification
- approveRemote snapshots address/key before queueing; replacement approvals reject.
- create freezes owned local address and refuses mismatched/reinitialized nonempty store.
- establish requires pinned identity, matched device and no implicit reset.
- native IdentityKeyStore rejects unknown/changed identities, including session traffic; no trust-on-first-use callback.
- encrypt snapshots input address, binds message ID inside ciphertext, stores session and exact ciphertext atomically; duplicate same-content IDs return original bytes.
- decrypt snapshots body/address/ID before async work, rejects unsupported types, requires authenticated inner/outer ID match, commits inbox only after decrypt success; transaction failure rolls back prekey/session consumption.
- Returned retry bodies are copied; mutating ciphertext/input objects does not mutate records or queued work.
- One-time prekey allocation/replenishment, identity reset UI, ACK retry API, wire/mobile integration are explicitly outside this reference; README does not claim shared bundle issuance is atomic allocation.

## Executable evidence
1. pnpm --filter @echolet/session-node test: 17 passed (SignalClient 10, store 7), independently rerun. Log .metaproject/data/gdctx/raw/2026-09-06T08-14-04-973Z_run.log.
2. Independent signal-client-review.test.ts: two tests pass. First confirms distinct lone-surrogate content rejects. Second mutates queued approval key/address, send remote address and receive body/ID/address, checks exact retry unaffected, runs concurrent duplicate-ID sends, rejects receive replay, then decrypts next message successfully.
3. No source modifications; review test is stored in this flow as an executable artifact. Run with pnpm --filter @echolet/session-node exec vitest run --root /Users/Goodea/goodea/projects/echolet/.metaproject/flows/001-2026-09-05-echolet-assessment-fixes signal-client-review.test.ts.

## Routing audit
Metaproject index re-read at each dispatched review. graph_used: gdgraph find SignalClient (navigation only); wiki_used: existing empty index; ctx_used: reads/search/test run capture; raw_rg_used: no. Targeted full reads used for compactly omitted methods. No graph answers relied upon after adding the review test artifact.
