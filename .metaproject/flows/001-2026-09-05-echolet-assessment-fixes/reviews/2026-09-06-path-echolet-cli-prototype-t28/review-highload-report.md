STATUS: DONE_WITH_CONCERNS

# Highload review

One blocker; three majors. Load triggers are bounded and stated per finding.

## [F-001] Concurrent same-ID sends can create duplicate outbound history and replace the CLI outbox envelope.

- Severity: blocker
- Location: `apps/cli/src/runtime/outbound.ts:68`
- Failure mode: Two concurrent sends using the same profile, trusted peer, message ID and content; prior checks finish before either write transaction.
- Impact: With an existing peer session, two messenger instances/processes can both read no CLI outbox record, then commit sequentially. The second native encrypt returns the prior ciphertext, but the outer transaction creates a new envelope and appends history again. One logical message gets two local history entries and two envelope IDs.
- Evidence: outbound.ts:41 performs prior lookup separately from mutation transaction at :68. Native SignalClient.encrypt returns the existing ciphertext at SignalClient.ts:308, but outbound.ts:82-83 still writes the new outer record/history. serial queue at outbound.ts:23 is per messenger, not cross-process. SQLite transaction serialization prevents simultaneous writes but not this stale check.
- Fix: Re-read and validate the CLI outbox inside the transaction that encrypts and writes history. If it already exists, return the persisted record without regenerating the envelope or appending history; retain the outer lookup only as an optimization.
- Class scope: apps/cli/src/runtime/outbound.ts:41, apps/cli/src/runtime/outbound.ts:68, apps/cli/src/runtime/outbound.ts:82, apps/cli/src/runtime/outbound.ts:83
- Enumeration: keryx ctx rg prior|profile.withRuntime|client.encrypt|appendHistory|tx.set(keyFor enumerated the sole outbound producer, separate read and enclosing mutation. Native idempotent encrypt inspected; inbound checks duplicates inside its mutation transaction and is not affected.

## [F-002] The valid relay poll batch can exceed the CLI response-byte limit and cannot be drained.

- Severity: major
- Location: `apps/cli/src/transport/relayClient.ts:86`
- Failure mode: Ten normal maximum-size CLI sends to an offline receiver, followed by poll using default configuration; no malformed or oversize individual message needed.
- Impact: Ten valid messages each carrying 64 KiB plaintext produce over 1 MiB of doubly base64-encoded ciphertext even before envelopes/native overhead. The server default batch100 returns all ten, but the client rejects the response before decrypt/ack. Every retry returns the same batch.
- Evidence: config.go:16 defaults MaxMailboxBatch=100; mailbox_handler.go:199 fetches that many and :211 returns next_cursor=null. relayClient.ts:86 rejects responses above1048576 bytes. Outbound accepts65536 plaintext bytes and base64-encodes native ciphertext twice. Numeric-only lower-bound probe measured10*ceil(ceil(65536*4/3)*4/3)=1165100 bytes, without any payload output. CLI poll_batch_size is validated but never forwarded.
- Fix: Define a shared aggregate response-byte budget and enforce it server-side while selecting a batch, ensuring at least one valid envelope fits. Honor a bounded client batch preference or support progress through pagination; keep client response validation bounded.
- Class scope: apps/cli/src/transport/relayClient.ts:86, apps/relay/internal/api/handler/mailbox_handler.go:199, apps/relay/internal/config/config.go:16, apps/cli/src/runtime/config.ts:14
- Enumeration: keryx ctx rg maxMailboxBatch|next_cursor|size >|poll_batch_size enumerated producer batch limit, consumer byte bound and unused client batch setting; only poll produces a valid multi-envelope response.

## [F-003] The rate limiter holds its global mutex while invoking downstream handlers.

- Severity: major
- Location: `apps/relay/internal/middleware/rate_limit.go:31`
- Failure mode: Two simultaneous valid HTTP requests, one slow enough to exceed the second request client timeout; the second waits regardless of its own client quota.
- Impact: A slow body read, storage operation or response write in one request blocks every other route/client at the same mutex, including health checks. Independent requests cannot progress concurrently.
- Evidence: rate_limit.go:30 locks, :31 defers unlock until the entire middleware returns, and both allowed paths call next.ServeHTTP at :37 and :48. Router installs this single limiter globally before all routes.
- Fix: Update quota counters under the mutex, compute allow/deny, unlock, then write the rejection or invoke next.ServeHTTP. Never hold the shared limiter lock across request processing.
- Class scope: apps/relay/internal/middleware/rate_limit.go:37, apps/relay/internal/middleware/rate_limit.go:48
- Enumeration: keryx ctx rg mu.Lock|mu.Unlock|next.ServeHTTP enumerated the single shared lock and both downstream calls; both calls execute under the deferred unlock.

## [F-004] Quota accounting uses the TCP source port as part of the client key and never removes old entries.

- Severity: major
- Location: `apps/relay/internal/middleware/rate_limit.go:29`
- Failure mode: More than RateLimitPerMinute requests in one minute from a single host using new TCP connections; each unseen host:port starts with count1.
- Impact: Fresh connections from one host obtain fresh per-minute quotas. The normal one-command-per-process CLI also creates separate buckets, so the configured host limit is not enforced across commands; retained connection buckets accumulate across hosts and ports.
- Evidence: rate_limit.go:29 assigns the full r.RemoteAddr string to ip, :34 indexes clients by it, and :36 replaces only the bucket for that exact address. Full RateLimiter implementation contains no deletion or expiry sweep. This report makes no unmeasured OOM timing claim.
- Fix: Normalize RemoteAddr to its host with net.SplitHostPort, define trusted-proxy handling explicitly, and expire/prune idle buckets. Preserve per-host quota across connection churn.
- Class scope: apps/relay/internal/middleware/rate_limit.go:29, apps/relay/internal/middleware/rate_limit.go:34, apps/relay/internal/middleware/rate_limit.go:36
- Enumeration: keryx ctx rg RemoteAddr|clients[ and full file read enumerate the single key derivation and map access/update paths; no other quota store or pruning implementation exists.

## Checked and cleared

- Concurrent OTK claims deadlock or both return the same bundle. Single Badger update transaction reads/claims selected bundle and records replay; conflicts retry at most64 times. No nested update or external network call in this transaction. T27 records20-request race evidence.
- Concurrent first-session setup silently overwrites an established session. SignalClient.establish checks for an existing session inside the transaction and refuses implicit reset. A racing setup fails rather than replacing native state; error classification belongs to logic.
- SQLite same-instance queues permit overlapping snapshot writes. Store transaction tail serializes operations, BEGIN IMMEDIATE coordinates process writers, and callbacks/native stores share the same caller transaction. Concurrent-process busy errors fail closed; they are not silently discarded.
- Ack loss advances the ratchet again. Inbound dedup check and history mutation occur together; pending ack persists beyond commit and replay skips native decrypt. No network call is held inside the decrypt transaction.
- Relay requests retry without bounds or leave default network hangs. CLI request has a configured deadline and AbortController; runtime retries are explicitly caller-triggered. No automatic infinite client retry loop found.

## Limits

- No fresh broad regressions or load benchmarks; numeric-only encoding budget probe executed, remaining interleavings are source-derived for independent verifier.
- Technical prototype scope; no distributed production readiness claim.
- Security oversized-input attack, backend overwrite/expiry, and earlier logic defects not repeated.

Routing: graph_used: outbound affected; wiki_used: index (concurrency pages unavailable); ctx_used: read/rg; raw_rg_used: no.
