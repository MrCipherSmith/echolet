# T28 Review Report

Version: 0.1.2

Status: final

## Verdict: REQUEST_CHANGES

The prototype implements its stated end-to-end scenario, but this review identifies defects in mailbox durability, authorization selection, concurrency and CLI recovery. Passing T27 regressions do not settle these newly identified scenarios.

## Review Scope

- Path mode: 98 explicitly enumerated files in CLI, relevant Go relay and protocol/crypto/client/session packages; scope.json records the deterministic pre-filter.
- Branch: unborn main. Parent ref, merge-base and commit SHA: unavailable. source-hashes-before.json identifies the reviewed files; all 98 hashes remained unchanged after the domain passes.
- Stage 1: initial AC-01 through AC-10 implementation mapping passed. These findings concern existing code behavior, rather than wholly missing feature areas.
- Five domain roles: review-logic, review-backend, review-security-code, review-highload, review-testing-practices. Runtime slot refusals required sequential reuse of one worker actor under separate validated contracts. This is not a claim of five independent actors.
- Final review-verifier runs as a separate non-author actor. Verification mode: annotate; refuted claims remain visibly marked rather than silently removed.
- Model strategy: current-session; hosted anchor OpenAI/GPT-6. Mechanical tiers resolved to session-fallback because provider discovery could not rank hosted models. No stale rapid-mlx model was dispatched.
- Budget: maximum 10 findings per role, blockers exempt; spend/tokens unavailable rather than reported as zero. Initial two-slot plan fell back to one active worker. See dispatch-budget.txt and verifier-budget.txt.
- No PR target, external comment publication, frontend/MobX pass, legacy profile or project-local review skill. Explicit domain selection; stack detector reported workspace uncertainty.

## Stats

- blocker: 4
- major: 7
- minor: 1
- info: 0

## Stage counts

Stated as counts, never as a precision figure: no precision baseline
exists to improve on (see the flow's baseline.md — 53/53 = 100% by
construction, refused as a baseline).

### Dropped by the pre-filter

files_seen: 98
files_retained: 98
files_dropped: 0
blocks_seen: 0
blocks_retained: 0
blocks_dropped: 0
changed_lines_retained: 0
changed_lines_dropped: 0

_the pre-filter ran and dropped nothing_

### Refuted by the verifier

verification_mode: annotate
claims_received: 12
claims_applied: 12
claims_rejected: 0
verdicts_capped_to_unverifiable: 0
confirmed: 10
refuted: 0
unverifiable: 2
unverified: 0

### Retained

findings_in: 12
findings_removed_by_verifier: 0
findings_retained: 12

### Verification claims discarded

_none_



## Blockers

### [F-004] Saving an existing envelope ID silently replaces the accepted mailbox record.

- Severity: blocker; reviewer: review-backend; confidence: high.
- Site: [apps/relay/internal/storage/repository/mailbox_repo.go:30](/Users/Goodea/goodea/projects/echolet/apps/relay/internal/storage/repository/mailbox_repo.go:30).
- Impact: Submit envelope A, then a different otherwise accepted envelope B with the same recipient mailbox and envelope ID before the receiver polls. Both sends succeed, but B overwrites A; the original accepted message is irretrievably lost. Sequential requests suffice.
- Fix: Read the existing record inside the same transaction. Return success only for an identical envelope; reject changed content with a conflict error and map it to HTTP 409. Retry transaction conflicts safely.
- Evidence: mailbox_repo.go:28-31 constructs mailbox:<recipient>:<envelope-id> and calls SetEntry without reading old content. mailbox_handler.go:66-79 returns success for both writes. ValidateMailboxEnvelope does not enforce envelope identity uniqueness. Unlike SaveSignalV2, no mailbox equality/conflict check exists. Source-derived reproduction; no live writes performed.
- Verification: confirmed (execution) by review-verifier: A temporary Badger repository probe saved two different envelopes under the same mailbox/envelope key. The second save returned success and retrieval produced one record containing the second message identifier, demonstrating silent overwrite. Command summary: the gdctx command artifact referenced by review-verifier-result.json

### [F-006] V1 request bodies are unbounded and send-envelope limits trust attacker-supplied size_bytes.

- Severity: blocker; reviewer: review-security-code; confidence: high.
- Site: [apps/relay/internal/validation/validate.go:82](/Users/Goodea/goodea/projects/echolet/apps/relay/internal/validation/validate.go:82).
- Impact: The configured message-byte limit is bypassed, accepted oversized records make a mailbox unreadable through the CLI, and parsing permits memory exhaustion. No signature or victim key is needed for the send path.
- Fix: Apply explicit MaxBytesReader limits before every v1 decoder, reject over-limit bodies with a bounded error, and validate actual ciphertext bytes against both size_bytes and the configured maximum before persistence. Bound other variable-length request fields/arrays as part of the same decoder contract.
- Evidence: MailboxHandler.SendEnvelope at mailbox_handler.go:46 decodes r.Body directly. ValidateMailboxEnvelope at validate.go:82 only compares the supplied SizeBytes with maxBytes, never len(Ciphertext); MailboxRepository.SaveEnvelope persists the result. RelayClient.request at relayClient.ts:86 rejects cumulative response bytes over 1 MiB. Other v1 handlers decode before authorization or signature validation. V2 alone uses MaxBytesReader at signal_prekey_bundle_v2.go:31.
- Attack vector: An unauthenticated caller posts to /v1/messages/send with a ciphertext field above the configured maximum while declaring size_bytes=1. Decoder and validator accept it and the mailbox repository persists it. A field above the CLI 1 MiB response budget then makes every affected poll fail; arbitrarily large bodies also allocate memory before any validation.
- Verification: confirmed (execution) by review-verifier: ValidateMailboxEnvelope accepted a synthetic envelope whose ciphertext field exceeded the supplied maximum while size_bytes was declared below it. Site inspection of the handler found json.Decoder reading the request body without a limiting reader. Command summary: the gdctx command artifact referenced by review-verifier-result.json

### [F-007] Mailbox authorization selects a device UUID globally rather than within its owning mailbox identity.

- Severity: blocker; reviewer: review-security-code; confidence: high.
- Site: [apps/relay/internal/storage/repository/device_record_repo.go:68](/Users/Goodea/goodea/projects/echolet/apps/relay/internal/storage/repository/device_record_repo.go:68).
- Impact: An unrelated identity can disable a legitimate recipient mailbox until the conflicting record is removed. This is denial of service; the subsequent ownership comparison still prevents the attacker from reading the victim mailbox.
- Fix: Resolve authorization by mailbox identity plus device UUID, using an immutable indexed mailbox/device binding populated by both v1 and v2 publication. Never select a global first UUID match and only then test mailbox ownership.
- Evidence: DeviceRecordRepository.Save keys records by identity+device, allowing same device UUID under different identities. GetByDeviceID scans device_record keys and stops at first candidate.DeviceID match (device_record_repo.go:68-79). authorizeMailboxDevice calls that method at mailbox_handler.go:267 and only afterward compares the derived mailbox at :275-277. Root/device signature validation authenticates the attacker own identity, not global UUID uniqueness. V2 saveSignalV2Authorization uses the same identity/device key convention.
- Attack vector: An attacker who knows a victim public device UUID publishes a valid record signed by the attacker own root key using that UUID. Choose an attacker identity whose storage key sorts before the victim identity. Publication permits both records, then victim challenge/poll/ack selects the attacker record first and rejects the legitimate mailbox ownership match.
- Verification: confirmed (execution) by review-verifier: A temporary Badger probe stored the same device_id under two identity IDs. GetByDeviceID returned the other identity rather than the designated victim identity, confirming that authorization lookup is global and ambiguous. Command summary: the gdctx command artifact referenced by review-verifier-result.json

### [F-008] Concurrent same-ID sends can create duplicate outbound history and replace the CLI outbox envelope.

- Severity: blocker; reviewer: review-highload; confidence: high.
- Site: [apps/cli/src/runtime/outbound.ts:68](/Users/Goodea/goodea/projects/echolet/apps/cli/src/runtime/outbound.ts:68).
- Impact: With an existing peer session, two messenger instances/processes can both read no CLI outbox record, then commit sequentially. The second native encrypt returns the prior ciphertext, but the outer transaction creates a new envelope and appends history again. One logical message gets two local history entries and two envelope IDs.
- Fix: Re-read and validate the CLI outbox inside the transaction that encrypts and writes history. If it already exists, return the persisted record without regenerating the envelope or appending history; retain the outer lookup only as an optimization.
- Evidence: outbound.ts:41 performs prior lookup separately from mutation transaction at :68. Native SignalClient.encrypt returns the existing ciphertext at SignalClient.ts:308, but outbound.ts:82-83 still writes the new outer record/history. serial queue at outbound.ts:23 is per messenger, not cross-process. SQLite transaction serialization prevents simultaneous writes but not this stale check.
- Failure mode: Two concurrent sends using the same profile, trusted peer, message ID and content; prior checks finish before either write transaction.
- Verification: unverifiable (reasoning) by review-verifier: Source inspection places the prior outbox lookup before the profile mutation transaction and shows serialization only within one Messenger instance. No deterministic scheduler or transaction hook was available to prove the claimed duplicate history/envelope outcome across concurrent instances.

## Major Issues

### [F-001] Repeated relay publication creates a different signed bundle for the same reserved one-time prekey.

- Severity: major; reviewer: review-logic; confidence: high.
- Site: [apps/cli/src/runtime/outbound.ts:33](/Users/Goodea/goodea/projects/echolet/apps/cli/src/runtime/outbound.ts:33).
- Impact: After relay publish commits but its response is lost, rerunning the CLI command submits a new bundle ID containing the same OTK. The relay rejects the retry under its permanent OTK uniqueness contract, so the user cannot recover a successful publication result. Even repeating a successful publish fails.
- Fix: Persist the exact signed publication bundle before the first network call and reuse it across attempts and process restarts. Keep allocation of a fresh OTK and a fresh bundle as a separate explicit operation.
- Evidence: outbound.ts:33 calls profile.exportContact on every attempt; profile.ts:89 calls exportSignedSignalBundleV2; wire.ts:51 assigns randomUUID; SignalClient.ts:228 reads the unchanged pre:1. Specification Relay v2 Publish permits idempotence only for identical stored bundle bytes and forbids OTK reuse under a new ID. This is a source-derived reproduction; no relay mutation was performed.
- Verification: confirmed (execution) by review-verifier: A synthetic local HTTP relay captured two consecutive `relay publish` requests from one initialized profile. Both commands exited 0; bundle_id changed while the one-time-prekey key_id and public_key were identical. Command summary: the gdctx command artifact referenced by review-verifier-result.json

### [F-002] Interactive contact confirmation waits for stdin EOF instead of accepting a completed input line.

- Severity: major; reviewer: review-logic; confidence: high.
- Site: [apps/cli/src/commands/cli.ts:144](/Users/Goodea/goodea/projects/echolet/apps/cli/src/commands/cli.ts:144).
- Impact: A user entering yes followed by Enter at the displayed [y/N] prompt remains blocked; contact import does not finish until the user supplies EOF. A negative line also waits for EOF.
- Fix: Read one bounded line using a readline interface or stop at the first newline, close the reader, and settle on EOF or an overlong answer without requiring stdin to close after a valid line.
- Evidence: cli.ts:144-148 iterates until stdin ends, with only an overlength early return. A read-only probe extracted the exact function and supplied a PassThrough: settledAfterCompleteLine=false after a yes newline, acceptedAfterEOF=true only after input.end(). cli.test.ts:29 always ends stdin, masking terminal behavior.
- Verification: confirmed (execution) by review-verifier: A spawned contact-import process received `yes` plus newline while stdin remained open. It was still unsettled after 1.5 seconds and exited 0 only after EOF. Command summary: the gdctx command artifact referenced by review-verifier-result.json

### [F-003] Runtime database failures are converted into trust/protocol errors and exit code 3.

- Severity: major; reviewer: review-logic; confidence: high.
- Site: [apps/cli/src/runtime/outbound.ts:28](/Users/Goodea/goodea/projects/echolet/apps/cli/src/runtime/outbound.ts:28).
- Impact: For example, let send finish its HTTP request while another SQLite connection holds BEGIN IMMEDIATE; the post-send delivery-state transaction fails with SQLITE_BUSY. Outbound serial rewrites it to OUTBOUND_REJECTED and classify returns 3, although the documented result for local persistence failure is 5. Inbound history/poll and contact-import commits similarly hide database failures as protocol or invalid-card errors.
- Fix: Introduce a typed persistence failure at the store boundary and preserve it through runtime and contact-import catch blocks; map it to redacted PERSISTENCE_FAILURE/exit 5. Keep typed validation, trust and native decrypt failures mapped to exit 3.
- Evidence: EncryptedSqliteStore.ts:25 uses busy_timeout=0 and :61 begins each transaction with BEGIN IMMEDIATE. Outbound.ts:26-28 and inbound.ts:23-25 replace all non-domain/non-relay errors; cli.ts:201 catches all import errors as INVALID_CONTACT_CARD, and :252-253 maps domain errors to trustFailure. Wrong-key open failures are handled correctly, but failures after opening are not. Reproduction is source-derived, not executed.
- Verification: unverifiable (reasoning) by review-verifier: Source inspection shows broad catches in outbound.ts and inbound.ts and trust-category CLI mappings, but no controlled storage-failure injection was executed. The claimed user-visible misclassification therefore lacks independent causal runtime evidence.

### [F-005] Mailbox retention and selection ignore the envelope expiry time.

- Severity: major; reviewer: review-backend; confidence: high.
- Site: [apps/relay/internal/storage/repository/mailbox_repo.go:30](/Users/Goodea/goodea/projects/echolet/apps/relay/internal/storage/repository/mailbox_repo.go:30).
- Impact: A normal CLI send expires after 24 hours, but SaveEnvelope retains it for 7 days. If the recipient returns after 24 hours, GetEnvelopes still returns the expired envelope; inbound rejects the entire batch before ack. Repeated polls remain blocked by that expired record, including new valid messages selected in the same batch, until physical TTL expiry.
- Fix: Reject already-expired envelopes, retain each envelope no longer than its remaining declared lifetime (and configured server cap), and filter expiry during retrieval before applying the batch limit. Do not extend expiry on identical retries.
- Evidence: outbound.ts:79 sets expires_at_ms to created+86400000; mailbox_repo.go:30 assigns fixed WithTTL(7*24*time.Hour), and :47-55 appends stored records without checking ExpiresAtMs. cleanup_service.go:43-45 relies solely on Badger TTL. inbound.ts:46 rejects expires_at_ms<=now before any pending ack is recorded. This is a normal delayed-receiver scenario, not a malicious-input claim.
- Verification: confirmed (execution) by review-verifier: A temporary Badger repository probe saved an envelope whose expires_at_ms was already in the past and immediately retrieved it from the mailbox. Source inspection also shows a fixed seven-day Badger TTL and no expires_at_ms filter. Command summary: the gdctx command artifact referenced by review-verifier-result.json

### [F-009] The valid relay poll batch can exceed the CLI response-byte limit and cannot be drained.

- Severity: major; reviewer: review-highload; confidence: high.
- Site: [apps/cli/src/transport/relayClient.ts:86](/Users/Goodea/goodea/projects/echolet/apps/cli/src/transport/relayClient.ts:86).
- Impact: Ten valid messages each carrying 64 KiB plaintext produce over 1 MiB of doubly base64-encoded ciphertext even before envelopes/native overhead. The server default batch100 returns all ten, but the client rejects the response before decrypt/ack. Every retry returns the same batch.
- Fix: Define a shared aggregate response-byte budget and enforce it server-side while selecting a batch, ensuring at least one valid envelope fits. Honor a bounded client batch preference or support progress through pagination; keep client response validation bounded.
- Evidence: config.go:16 defaults MaxMailboxBatch=100; mailbox_handler.go:199 fetches that many and :211 returns next_cursor=null. relayClient.ts:86 rejects responses above1048576 bytes. Outbound accepts65536 plaintext bytes and base64-encodes native ciphertext twice. Numeric-only lower-bound probe measured10*ceil(ceil(65536*4/3)*4/3)=1165100 bytes, without any payload output. CLI poll_batch_size is validated but never forwarded.
- Failure mode: Ten normal maximum-size CLI sends to an offline receiver, followed by poll using default configuration; no malformed or oversize individual message needed.
- Verification: confirmed (site-check) by review-verifier: Bounded source checks found the client response cap at 1,048,576 bytes, the relay default batch at 100, the envelope maximum at 65,536 bytes, and no use of poll_batch_size. Ten maximum payloads already have a double-base64 lower bound above the client cap, so a valid default poll batch can be rejected client-side.

### [F-010] The rate limiter holds its global mutex while invoking downstream handlers.

- Severity: major; reviewer: review-highload; confidence: high.
- Site: [apps/relay/internal/middleware/rate_limit.go:31](/Users/Goodea/goodea/projects/echolet/apps/relay/internal/middleware/rate_limit.go:31).
- Impact: A slow body read, storage operation or response write in one request blocks every other route/client at the same mutex, including health checks. Independent requests cannot progress concurrently.
- Fix: Update quota counters under the mutex, compute allow/deny, unlock, then write the rejection or invoke next.ServeHTTP. Never hold the shared limiter lock across request processing.
- Evidence: rate_limit.go:30 locks, :31 defers unlock until the entire middleware returns, and both allowed paths call next.ServeHTTP at :37 and :48. Router installs this single limiter globally before all routes.
- Failure mode: Two simultaneous valid HTTP requests, one slow enough to exceed the second request client timeout; the second waits regardless of its own client quota.
- Verification: confirmed (execution) by review-verifier: A temporary httptest probe held the first downstream handler for 250 ms. A request from a different address remained blocked for more than 180 ms, confirming the global limiter mutex is held across next.ServeHTTP. Command summary: the gdctx command artifact referenced by review-verifier-result.json

### [F-011] Quota accounting uses the TCP source port as part of the client key and never removes old entries.

- Severity: major; reviewer: review-highload; confidence: high.
- Site: [apps/relay/internal/middleware/rate_limit.go:29](/Users/Goodea/goodea/projects/echolet/apps/relay/internal/middleware/rate_limit.go:29).
- Impact: Fresh connections from one host obtain fresh per-minute quotas. The normal one-command-per-process CLI also creates separate buckets, so the configured host limit is not enforced across commands; retained connection buckets accumulate across hosts and ports.
- Fix: Normalize RemoteAddr to its host with net.SplitHostPort, define trusted-proxy handling explicitly, and expire/prune idle buckets. Preserve per-host quota across connection churn.
- Evidence: rate_limit.go:29 assigns the full r.RemoteAddr string to ip, :34 indexes clients by it, and :36 replaces only the bucket for that exact address. Full RateLimiter implementation contains no deletion or expiry sweep. This report makes no unmeasured OOM timing claim.
- Failure mode: More than RateLimitPerMinute requests in one minute from a single host using new TCP connections; each unseen host:port starts with count1.
- Verification: confirmed (execution) by review-verifier: With limit 1, two requests from the same IP but different source ports both received success, while repeating the first full RemoteAddr was rate-limited. Source inspection shows the unpruned map is keyed directly by r.RemoteAddr. Command summary: the gdctx command artifact referenced by review-verifier-result.json

## Minor & Info

### [F-012] Unknown-sender rejection test does not pin the explicit CONTACT_NOT_TRUSTED guard.

- Severity: minor; reviewer: review-testing-practices; confidence: high.
- Site: [apps/cli/src/runtime/inbound.test.ts:167](/Users/Goodea/goodea/projects/echolet/apps/cli/src/runtime/inbound.test.ts:167).
- Impact: Deleting the dedicated missing-contact guard still leaves the nearest suite green: the later decode of a missing value rejects, satisfying rejects.toThrow. A future edit can remove the intended typed trust rejection unnoticed, although the current mutant still fails closed.
- Fix: Assert the public rejection code CONTACT_NOT_TRUSTED for the unknown-sender fixture, while retaining unchanged-state and no-ack assertions. Keep changed-device and malformed-data cases distinct so each names its own intended failure.
- Evidence: Isolated deletion of inbound.ts:50 ran inbound.test.ts with exit0 and10/10 tests passing; unmodified baseline also10/10. Test at inbound.test.ts:167 only asserts rejects.toThrow. Removing confirmation, duplicate-hash and batch-minimum gates in the same bounded pass caused1 focused failure each, demonstrating the harness detects real assertion failures.
- Verification: confirmed (site-check) by review-verifier: The focused test asserts only that the promise throws. The inspected implementation passes the contact bytes to deserialization immediately after the explicit trust guard; removing the guard still supplies a throwing path for an unknown sender, so the assertion cannot distinguish the required error from a later decode error.

## Checked and cleared

- review-logic: A retry advances the outbound ratchet or changes ciphertext. — outbound.ts loads the persisted CLI outbox, rejects changed contentHash, calls client.retry and compares exact ciphertext before HTTP; no new encrypt in the prior-record branch.
- review-logic: Ack loss duplicates history or decrypts twice. — inbound.ts commits native state, inbox hash, history and pending ack together. Duplicate ciphertext checks hash and bypasses decrypt/history. E2E verifies unchanged native snapshot and history after ack loss.
- review-logic: Relay claim or inbound ciphertext silently creates a trust pin. — profile.importContact alone records CLI contact and explicit native approval. Outbound compares the claim with pinned identity/device/keys; inbound requires both contact and native trust before decrypt.
- review-logic: History read mutates ordering or mixes contacts. — history.ts uses safe monotonic sequence keys and filters by exact contact identity; writes participate in enclosing atomic transactions.
- review-backend: Concurrent v2 claims can allocate the same OTK twice. — ClaimSignalV2 reads bundle state, marks claimed, removes availability and stores claim replay in one conflict-retried Badger transaction; T27 records the 20-contender race proof.
- review-backend: OTK tombstones are released after claim or expiry. — SaveSignalV2 reserves tuple and public-key indexes in the publication transaction; claim only deletes availability. No TTL or delete exists for reservation keys.
- review-backend: Claim replay changes bytes or accepts a changed selector. — Persisted claim stores Bundle as bytes and exact selector; replay compares identity/device before returning. Handler writes original raw bytes directly without re-encoding.
- review-backend: V2 validation skips the root/device binding or accepts duplicate signed fields. — Ordered decoder rejects duplicates and unknown fields; validation verifies root-signed DeviceRecord and complete device-signed transcript before repository writes. Native SPK/Kyber verification remains intentionally client-side.
- review-backend: Mailbox poll consumes a challenge before authenticating the caller. — PollMailbox verifies mailbox/device matching and signature before atomic Invalidate; repository treats racing consumption as invalid challenge.
- review-backend: Ack retry of already-deleted envelopes fails its expected count. — DeleteEnvelope is idempotent and handler returns requested count only after all deletions succeed; partial failures remain safely retryable.
- review-security-code: Contact import or relay ciphertext can replace an existing Signal identity pin. — Profile.importContact verifies signed wire before explicit confirmation, rejects changed identifiers and calls approveRemote, which refuses changed native keys; inbound and outbound compare stored pins before native operations.
- review-security-code: V2 publication accepts modified DeviceRecord or bundle fields. — Strict ordered decoder verifies root and device signatures before atomic authorization/OTK writes; native SPK/Kyber validation intentionally occurs at the Node trust boundary.
- review-security-code: An invalid mailbox signature consumes a valid poll challenge. — Mailbox handler checks identity/mailbox/device binding and signature before atomic challenge invalidation; racing consumers cannot both succeed.
- review-security-code: Wrong database keys silently replace existing identities. — EncryptedSqliteStore authenticates existing snapshot with AES-GCM; profile opening refuses missing/corrupt profile replacement. No fallback plaintext or auto-reset path found.
- review-security-code: Routine CLI errors and relay logs expose plaintext or secret material. — CLI outputs fixed classified error codes; identity material stays in encrypted snapshot, history is explicit. Relay handlers log no request bodies, and T27 E2E records synthetic-marker absence. No broad secret/history scan is claimed.
- review-security-code: Relay URL redirects send credentials or messages to a second origin. — RelayClient requires HTTPS or loopback HTTP, rejects credentials/path/query, and fetch uses redirect:error.
- review-highload: Concurrent OTK claims deadlock or both return the same bundle. — Single Badger update transaction reads/claims selected bundle and records replay; conflicts retry at most64 times. No nested update or external network call in this transaction. T27 records20-request race evidence.
- review-highload: Concurrent first-session setup silently overwrites an established session. — SignalClient.establish checks for an existing session inside the transaction and refuses implicit reset. A racing setup fails rather than replacing native state; error classification belongs to logic.
- review-highload: SQLite same-instance queues permit overlapping snapshot writes. — Store transaction tail serializes operations, BEGIN IMMEDIATE coordinates process writers, and callbacks/native stores share the same caller transaction. Concurrent-process busy errors fail closed; they are not silently discarded.
- review-highload: Ack loss advances the ratchet again. — Inbound dedup check and history mutation occur together; pending ack persists beyond commit and replay skips native decrypt. No network call is held inside the decrypt transaction.
- review-highload: Relay requests retry without bounds or leave default network hangs. — CLI request has a configured deadline and AbortController; runtime retries are explicitly caller-triggered. No automatic infinite client retry loop found.
- review-testing-practices: Contact confirmation can be ignored without test detection. — Deleted the false-confirmation guard at profile.ts:105 in the temporary copy: baseline6/6 green; mutant5 passed/1 failed.
- review-testing-practices: Duplicate ciphertext content binding is not tested. — Deleted inbound.ts:63 hash-conflict guard: baseline10/10 green; mutant9 passed/1 failed.
- review-testing-practices: The minimum polling batch size is merely schema decoration. — Removed min(1) from poll_batch_size: baseline3/3 green; mutant2 passed/1 failed.
- review-testing-practices: Networked E2E silently substitutes in-process session setup. — two-process.test.ts spawns actual CLI command processes and local Go relay, exchanges contact cards, and observes network requests; native snapshots are read only for assertions. Test validates offline send, lost response, restart, ack recovery and replay.
- review-testing-practices: Runtime tests can escape to arbitrary external services. — Inbound/outbound provide explicit fetch boundary fakes whose unrecognized routes throw; process/E2E servers bind dynamically allocated loopback ports and include cleanup/deadlines.
- review-testing-practices: Failed mutation assertions leak fixture material into review artifacts. — All subprocess stdout/stderr was captured in memory; only exit codes and aggregate counts were emitted/persisted. No raw failing assertion logs or request bodies were saved.

## Mutation evidence and limitations

Four mutations ran only in temporary copies: confirmation guard killed (1/6 failed), inbound trusted-peer guard survived (10/10 passed), duplicate-content guard killed (1/10 failed), and minimum batch-size guard killed (1/3 failed). Unmodified baselines passed. Twenty-one other conditional sites in the three selected files were not mutated; other modules and schema predicates were not exhaustively enumerated. Initial copy dependency resolution was repaired before recording the successful profile baseline. Canonical files were unchanged and temporary copies removed.

T27 supplies prior broad evidence: 82 workspace tests, seven TypeScript packages, real E2E 3/3, and Go race tests passed. This review did not repeat broad regressions. Lint/health adapter limitations remain; neither tests nor this review establish cryptographic-audit, mobile or production readiness. Wiki pages are drafts and freshness has no Git revision range. Accepted-memory search found no matching entries.

## Skill Learning

- none: routing each affected module returned generic catalog entries, with no covering project skill to update.

The report scanner mistook a timestamped gdctx artifact path for a secret. Its full reference remains in the original verifier result; this report uses that indirection without changing any verification outcome.

## Routing Audit

- graph_used: graph context/affected queries; Go scope came from explicit candidate paths because the graph indexes TypeScript.
- wiki_used: wiki index and session-node draft page; approved requirements/source remain authoritative.
- ctx_used: compact reads, routed searches and bounded command summaries. Mutation failure output remained in memory; only safe counts were saved.
- raw_rg_used: no.

## Machine-readable findings

```json keryx:findings
[
  {
    "id": "F-001",
    "reviewer": "review-logic",
    "severity": "major",
    "problem": "Repeated relay publication creates a different signed bundle for the same reserved one-time prekey.",
    "impact": "After relay publish commits but its response is lost, rerunning the CLI command submits a new bundle ID containing the same OTK. The relay rejects the retry under its permanent OTK uniqueness contract, so the user cannot recover a successful publication result. Even repeating a successful publish fails.",
    "suggested_fix": "Persist the exact signed publication bundle before the first network call and reuse it across attempts and process restarts. Keep allocation of a fresh OTK and a fresh bundle as a separate explicit operation.",
    "evidence": "outbound.ts:33 calls profile.exportContact on every attempt; profile.ts:89 calls exportSignedSignalBundleV2; wire.ts:51 assigns randomUUID; SignalClient.ts:228 reads the unchanged pre:1. Specification Relay v2 Publish permits idempotence only for identical stored bundle bytes and forbids OTK reuse under a new ID. This is a source-derived reproduction; no relay mutation was performed.",
    "confidence": "high",
    "file": "apps/cli/src/runtime/outbound.ts",
    "line": 33,
    "dedupe_key": "F-001-logic",
    "blocking_merge": false,
    "class_scope": {
      "sites": [
        "apps/cli/src/runtime/outbound.ts:33",
        "apps/cli/src/runtime/profile.ts:89",
        "packages/session-node/src/wire.ts:51",
        "packages/session-node/src/SignalClient.ts:228"
      ],
      "enumeration_method": "Enumerated the single runtime publish producer and its export/publicBundle call chain; keryx ctx rg for publish, bundle_id: randomUUID, and preBytes verifies the producer and reuse sites."
    },
    "global_id": "2026-09-06-path-echolet-cli-prototype-t28#F-001",
    "verification": {
      "verdict": "confirmed",
      "method": "execution",
      "evidence": "A synthetic local HTTP relay captured two consecutive `relay publish` requests from one initialized profile. Both commands exited 0; bundle_id changed while the one-time-prekey key_id and public_key were identical. Command summary: the gdctx command artifact referenced by review-verifier-result.json",
      "verifier": "review-verifier"
    }
  },
  {
    "id": "F-002",
    "reviewer": "review-logic",
    "severity": "major",
    "problem": "Interactive contact confirmation waits for stdin EOF instead of accepting a completed input line.",
    "impact": "A user entering yes followed by Enter at the displayed [y/N] prompt remains blocked; contact import does not finish until the user supplies EOF. A negative line also waits for EOF.",
    "suggested_fix": "Read one bounded line using a readline interface or stop at the first newline, close the reader, and settle on EOF or an overlong answer without requiring stdin to close after a valid line.",
    "evidence": "cli.ts:144-148 iterates until stdin ends, with only an overlength early return. A read-only probe extracted the exact function and supplied a PassThrough: settledAfterCompleteLine=false after a yes newline, acceptedAfterEOF=true only after input.end(). cli.test.ts:29 always ends stdin, masking terminal behavior.",
    "confidence": "high",
    "file": "apps/cli/src/commands/cli.ts",
    "line": 144,
    "dedupe_key": "F-002-logic",
    "blocking_merge": false,
    "class_scope": {
      "sites": [
        "apps/cli/src/commands/cli.ts:144"
      ],
      "enumeration_method": "keryx ctx rg readConfirmation found its single definition and sole contact-import caller at cli.ts:199; no other interactive reader exists in the CLI command implementation."
    },
    "global_id": "2026-09-06-path-echolet-cli-prototype-t28#F-002",
    "verification": {
      "verdict": "confirmed",
      "method": "execution",
      "evidence": "A spawned contact-import process received `yes` plus newline while stdin remained open. It was still unsettled after 1.5 seconds and exited 0 only after EOF. Command summary: the gdctx command artifact referenced by review-verifier-result.json",
      "verifier": "review-verifier"
    }
  },
  {
    "id": "F-003",
    "reviewer": "review-logic",
    "severity": "major",
    "problem": "Runtime database failures are converted into trust/protocol errors and exit code 3.",
    "impact": "For example, let send finish its HTTP request while another SQLite connection holds BEGIN IMMEDIATE; the post-send delivery-state transaction fails with SQLITE_BUSY. Outbound serial rewrites it to OUTBOUND_REJECTED and classify returns 3, although the documented result for local persistence failure is 5. Inbound history/poll and contact-import commits similarly hide database failures as protocol or invalid-card errors.",
    "suggested_fix": "Introduce a typed persistence failure at the store boundary and preserve it through runtime and contact-import catch blocks; map it to redacted PERSISTENCE_FAILURE/exit 5. Keep typed validation, trust and native decrypt failures mapped to exit 3.",
    "evidence": "EncryptedSqliteStore.ts:25 uses busy_timeout=0 and :61 begins each transaction with BEGIN IMMEDIATE. Outbound.ts:26-28 and inbound.ts:23-25 replace all non-domain/non-relay errors; cli.ts:201 catches all import errors as INVALID_CONTACT_CARD, and :252-253 maps domain errors to trustFailure. Wrong-key open failures are handled correctly, but failures after opening are not. Reproduction is source-derived, not executed.",
    "confidence": "high",
    "file": "apps/cli/src/runtime/outbound.ts",
    "line": 28,
    "dedupe_key": "F-003-logic",
    "blocking_merge": false,
    "class_scope": {
      "sites": [
        "apps/cli/src/runtime/outbound.ts:28",
        "apps/cli/src/runtime/inbound.ts:25",
        "apps/cli/src/commands/cli.ts:201",
        "apps/cli/src/commands/cli.ts:252"
      ],
      "enumeration_method": "Enumerated catch blocks with keryx ctx rg catch|OUTBOUND_REJECTED|INBOUND_REJECTED|PERSISTENCE_FAILURE across command and runtime files, then followed every store-transaction caller into the single CLI classify function; these runtime/import catch boundaries erase persistence errors while profile-open boundaries preserve exit 5."
    },
    "global_id": "2026-09-06-path-echolet-cli-prototype-t28#F-003",
    "verification": {
      "verdict": "unverifiable",
      "method": "reasoning",
      "evidence": "Source inspection shows broad catches in outbound.ts and inbound.ts and trust-category CLI mappings, but no controlled storage-failure injection was executed. The claimed user-visible misclassification therefore lacks independent causal runtime evidence.",
      "verifier": "review-verifier"
    }
  },
  {
    "id": "F-004",
    "reviewer": "review-backend",
    "severity": "blocker",
    "problem": "Saving an existing envelope ID silently replaces the accepted mailbox record.",
    "impact": "Submit envelope A, then a different otherwise accepted envelope B with the same recipient mailbox and envelope ID before the receiver polls. Both sends succeed, but B overwrites A; the original accepted message is irretrievably lost. Sequential requests suffice.",
    "suggested_fix": "Read the existing record inside the same transaction. Return success only for an identical envelope; reject changed content with a conflict error and map it to HTTP 409. Retry transaction conflicts safely.",
    "evidence": "mailbox_repo.go:28-31 constructs mailbox:<recipient>:<envelope-id> and calls SetEntry without reading old content. mailbox_handler.go:66-79 returns success for both writes. ValidateMailboxEnvelope does not enforce envelope identity uniqueness. Unlike SaveSignalV2, no mailbox equality/conflict check exists. Source-derived reproduction; no live writes performed.",
    "confidence": "high",
    "file": "apps/relay/internal/storage/repository/mailbox_repo.go",
    "line": 30,
    "dedupe_key": "backend-F-001",
    "blocking_merge": true,
    "class_scope": {
      "sites": [
        "apps/relay/internal/storage/repository/mailbox_repo.go:30",
        "apps/relay/internal/api/handler/mailbox_handler.go:66"
      ],
      "enumeration_method": "keryx ctx rg ENVELOPE_ID_CONFLICT|WithTTL|ExpiresAtMs|DeleteEnvelope across apps/relay/internal plus full MailboxService read enumerates the single mailbox writer and its single send-handler path; no existing conflict branch."
    },
    "global_id": "2026-09-06-path-echolet-cli-prototype-t28#F-004",
    "verification": {
      "verdict": "confirmed",
      "method": "execution",
      "evidence": "A temporary Badger repository probe saved two different envelopes under the same mailbox/envelope key. The second save returned success and retrieval produced one record containing the second message identifier, demonstrating silent overwrite. Command summary: the gdctx command artifact referenced by review-verifier-result.json",
      "verifier": "review-verifier"
    }
  },
  {
    "id": "F-005",
    "reviewer": "review-backend",
    "severity": "major",
    "problem": "Mailbox retention and selection ignore the envelope expiry time.",
    "impact": "A normal CLI send expires after 24 hours, but SaveEnvelope retains it for 7 days. If the recipient returns after 24 hours, GetEnvelopes still returns the expired envelope; inbound rejects the entire batch before ack. Repeated polls remain blocked by that expired record, including new valid messages selected in the same batch, until physical TTL expiry.",
    "suggested_fix": "Reject already-expired envelopes, retain each envelope no longer than its remaining declared lifetime (and configured server cap), and filter expiry during retrieval before applying the batch limit. Do not extend expiry on identical retries.",
    "evidence": "outbound.ts:79 sets expires_at_ms to created+86400000; mailbox_repo.go:30 assigns fixed WithTTL(7*24*time.Hour), and :47-55 appends stored records without checking ExpiresAtMs. cleanup_service.go:43-45 relies solely on Badger TTL. inbound.ts:46 rejects expires_at_ms<=now before any pending ack is recorded. This is a normal delayed-receiver scenario, not a malicious-input claim.",
    "confidence": "high",
    "file": "apps/relay/internal/storage/repository/mailbox_repo.go",
    "line": 30,
    "dedupe_key": "backend-F-002",
    "blocking_merge": false,
    "class_scope": {
      "sites": [
        "apps/relay/internal/storage/repository/mailbox_repo.go:30",
        "apps/relay/internal/storage/repository/mailbox_repo.go:53",
        "apps/relay/internal/service/cleanup_service.go:43",
        "apps/relay/internal/validation/validate.go:85"
      ],
      "enumeration_method": "keryx ctx rg WithTTL|ExpiresAtMs|DeleteEnvelope across relay internal code enumerates the only mailbox writer, reader, cleanup and lifetime validation boundaries; none uses current time to enforce envelope lifetime."
    },
    "global_id": "2026-09-06-path-echolet-cli-prototype-t28#F-005",
    "verification": {
      "verdict": "confirmed",
      "method": "execution",
      "evidence": "A temporary Badger repository probe saved an envelope whose expires_at_ms was already in the past and immediately retrieved it from the mailbox. Source inspection also shows a fixed seven-day Badger TTL and no expires_at_ms filter. Command summary: the gdctx command artifact referenced by review-verifier-result.json",
      "verifier": "review-verifier"
    }
  },
  {
    "id": "F-006",
    "reviewer": "review-security-code",
    "severity": "blocker",
    "problem": "V1 request bodies are unbounded and send-envelope limits trust attacker-supplied size_bytes.",
    "impact": "The configured message-byte limit is bypassed, accepted oversized records make a mailbox unreadable through the CLI, and parsing permits memory exhaustion. No signature or victim key is needed for the send path.",
    "suggested_fix": "Apply explicit MaxBytesReader limits before every v1 decoder, reject over-limit bodies with a bounded error, and validate actual ciphertext bytes against both size_bytes and the configured maximum before persistence. Bound other variable-length request fields/arrays as part of the same decoder contract.",
    "evidence": "MailboxHandler.SendEnvelope at mailbox_handler.go:46 decodes r.Body directly. ValidateMailboxEnvelope at validate.go:82 only compares the supplied SizeBytes with maxBytes, never len(Ciphertext); MailboxRepository.SaveEnvelope persists the result. RelayClient.request at relayClient.ts:86 rejects cumulative response bytes over 1 MiB. Other v1 handlers decode before authorization or signature validation. V2 alone uses MaxBytesReader at signal_prekey_bundle_v2.go:31.",
    "confidence": "high",
    "file": "apps/relay/internal/validation/validate.go",
    "line": 82,
    "dedupe_key": "security-F-001",
    "blocking_merge": true,
    "class_scope": {
      "sites": [
        "apps/relay/internal/api/handler/mailbox_handler.go:46",
        "apps/relay/internal/api/handler/mailbox_handler.go:96",
        "apps/relay/internal/api/handler/mailbox_handler.go:149",
        "apps/relay/internal/api/handler/mailbox_handler.go:225",
        "apps/relay/internal/api/handler/device_record_handler.go:38",
        "apps/relay/internal/api/handler/prekey_bundle_handler.go:28",
        "apps/relay/internal/api/handler/signal_prekey_bundle_v2.go:31",
        "apps/relay/internal/validation/validate.go:82"
      ],
      "enumeration_method": "keryx ctx rg json.NewDecoder across handler files enumerated seven decoder sites: six unbounded v1 sites and one bounded v2 sibling. keryx ctx rg SizeBytes|maxMessageBytes identified the sole claimed-size comparison before mailbox persistence."
    },
    "global_id": "2026-09-06-path-echolet-cli-prototype-t28#F-006",
    "verification": {
      "verdict": "confirmed",
      "method": "execution",
      "evidence": "ValidateMailboxEnvelope accepted a synthetic envelope whose ciphertext field exceeded the supplied maximum while size_bytes was declared below it. Site inspection of the handler found json.Decoder reading the request body without a limiting reader. Command summary: the gdctx command artifact referenced by review-verifier-result.json",
      "verifier": "review-verifier"
    }
  },
  {
    "id": "F-007",
    "reviewer": "review-security-code",
    "severity": "blocker",
    "problem": "Mailbox authorization selects a device UUID globally rather than within its owning mailbox identity.",
    "impact": "An unrelated identity can disable a legitimate recipient mailbox until the conflicting record is removed. This is denial of service; the subsequent ownership comparison still prevents the attacker from reading the victim mailbox.",
    "suggested_fix": "Resolve authorization by mailbox identity plus device UUID, using an immutable indexed mailbox/device binding populated by both v1 and v2 publication. Never select a global first UUID match and only then test mailbox ownership.",
    "evidence": "DeviceRecordRepository.Save keys records by identity+device, allowing same device UUID under different identities. GetByDeviceID scans device_record keys and stops at first candidate.DeviceID match (device_record_repo.go:68-79). authorizeMailboxDevice calls that method at mailbox_handler.go:267 and only afterward compares the derived mailbox at :275-277. Root/device signature validation authenticates the attacker own identity, not global UUID uniqueness. V2 saveSignalV2Authorization uses the same identity/device key convention.",
    "confidence": "high",
    "file": "apps/relay/internal/storage/repository/device_record_repo.go",
    "line": 68,
    "dedupe_key": "security-F-002",
    "blocking_merge": true,
    "class_scope": {
      "sites": [
        "apps/relay/internal/storage/repository/device_record_repo.go:68",
        "apps/relay/internal/api/handler/mailbox_handler.go:267",
        "apps/relay/internal/storage/repository/device_record_repo.go:29",
        "apps/relay/internal/storage/repository/signal_prekey_bundle_v2.go:79"
      ],
      "enumeration_method": "keryx ctx rg GetByDeviceID|candidate.DeviceID|derivedMailboxID identified the sole global selector and shared authorization helper. Full Save and saveSignalV2Authorization reads enumerate both publication writers that permit identity-scoped duplicate UUIDs. The helper serves challenge, poll and ack."
    },
    "global_id": "2026-09-06-path-echolet-cli-prototype-t28#F-007",
    "verification": {
      "verdict": "confirmed",
      "method": "execution",
      "evidence": "A temporary Badger probe stored the same device_id under two identity IDs. GetByDeviceID returned the other identity rather than the designated victim identity, confirming that authorization lookup is global and ambiguous. Command summary: the gdctx command artifact referenced by review-verifier-result.json",
      "verifier": "review-verifier"
    }
  },
  {
    "id": "F-008",
    "reviewer": "review-highload",
    "severity": "blocker",
    "problem": "Concurrent same-ID sends can create duplicate outbound history and replace the CLI outbox envelope.",
    "impact": "With an existing peer session, two messenger instances/processes can both read no CLI outbox record, then commit sequentially. The second native encrypt returns the prior ciphertext, but the outer transaction creates a new envelope and appends history again. One logical message gets two local history entries and two envelope IDs.",
    "suggested_fix": "Re-read and validate the CLI outbox inside the transaction that encrypts and writes history. If it already exists, return the persisted record without regenerating the envelope or appending history; retain the outer lookup only as an optimization.",
    "evidence": "outbound.ts:41 performs prior lookup separately from mutation transaction at :68. Native SignalClient.encrypt returns the existing ciphertext at SignalClient.ts:308, but outbound.ts:82-83 still writes the new outer record/history. serial queue at outbound.ts:23 is per messenger, not cross-process. SQLite transaction serialization prevents simultaneous writes but not this stale check.",
    "confidence": "high",
    "file": "apps/cli/src/runtime/outbound.ts",
    "line": 68,
    "dedupe_key": "highload-F-001",
    "blocking_merge": true,
    "class_scope": {
      "sites": [
        "apps/cli/src/runtime/outbound.ts:41",
        "apps/cli/src/runtime/outbound.ts:68",
        "apps/cli/src/runtime/outbound.ts:82",
        "apps/cli/src/runtime/outbound.ts:83"
      ],
      "enumeration_method": "keryx ctx rg prior|profile.withRuntime|client.encrypt|appendHistory|tx.set(keyFor enumerated the sole outbound producer, separate read and enclosing mutation. Native idempotent encrypt inspected; inbound checks duplicates inside its mutation transaction and is not affected."
    },
    "global_id": "2026-09-06-path-echolet-cli-prototype-t28#F-008",
    "verification": {
      "verdict": "unverifiable",
      "method": "reasoning",
      "evidence": "Source inspection places the prior outbox lookup before the profile mutation transaction and shows serialization only within one Messenger instance. No deterministic scheduler or transaction hook was available to prove the claimed duplicate history/envelope outcome across concurrent instances.",
      "verifier": "review-verifier"
    }
  },
  {
    "id": "F-009",
    "reviewer": "review-highload",
    "severity": "major",
    "problem": "The valid relay poll batch can exceed the CLI response-byte limit and cannot be drained.",
    "impact": "Ten valid messages each carrying 64 KiB plaintext produce over 1 MiB of doubly base64-encoded ciphertext even before envelopes/native overhead. The server default batch100 returns all ten, but the client rejects the response before decrypt/ack. Every retry returns the same batch.",
    "suggested_fix": "Define a shared aggregate response-byte budget and enforce it server-side while selecting a batch, ensuring at least one valid envelope fits. Honor a bounded client batch preference or support progress through pagination; keep client response validation bounded.",
    "evidence": "config.go:16 defaults MaxMailboxBatch=100; mailbox_handler.go:199 fetches that many and :211 returns next_cursor=null. relayClient.ts:86 rejects responses above1048576 bytes. Outbound accepts65536 plaintext bytes and base64-encodes native ciphertext twice. Numeric-only lower-bound probe measured10*ceil(ceil(65536*4/3)*4/3)=1165100 bytes, without any payload output. CLI poll_batch_size is validated but never forwarded.",
    "confidence": "high",
    "file": "apps/cli/src/transport/relayClient.ts",
    "line": 86,
    "dedupe_key": "highload-F-002",
    "blocking_merge": false,
    "class_scope": {
      "sites": [
        "apps/cli/src/transport/relayClient.ts:86",
        "apps/relay/internal/api/handler/mailbox_handler.go:199",
        "apps/relay/internal/config/config.go:16",
        "apps/cli/src/runtime/config.ts:14"
      ],
      "enumeration_method": "keryx ctx rg maxMailboxBatch|next_cursor|size >|poll_batch_size enumerated producer batch limit, consumer byte bound and unused client batch setting; only poll produces a valid multi-envelope response."
    },
    "global_id": "2026-09-06-path-echolet-cli-prototype-t28#F-009",
    "verification": {
      "verdict": "confirmed",
      "method": "site-check",
      "evidence": "Bounded source checks found the client response cap at 1,048,576 bytes, the relay default batch at 100, the envelope maximum at 65,536 bytes, and no use of poll_batch_size. Ten maximum payloads already have a double-base64 lower bound above the client cap, so a valid default poll batch can be rejected client-side.",
      "verifier": "review-verifier"
    }
  },
  {
    "id": "F-010",
    "reviewer": "review-highload",
    "severity": "major",
    "problem": "The rate limiter holds its global mutex while invoking downstream handlers.",
    "impact": "A slow body read, storage operation or response write in one request blocks every other route/client at the same mutex, including health checks. Independent requests cannot progress concurrently.",
    "suggested_fix": "Update quota counters under the mutex, compute allow/deny, unlock, then write the rejection or invoke next.ServeHTTP. Never hold the shared limiter lock across request processing.",
    "evidence": "rate_limit.go:30 locks, :31 defers unlock until the entire middleware returns, and both allowed paths call next.ServeHTTP at :37 and :48. Router installs this single limiter globally before all routes.",
    "confidence": "high",
    "file": "apps/relay/internal/middleware/rate_limit.go",
    "line": 31,
    "dedupe_key": "highload-F-003",
    "blocking_merge": false,
    "class_scope": {
      "sites": [
        "apps/relay/internal/middleware/rate_limit.go:37",
        "apps/relay/internal/middleware/rate_limit.go:48"
      ],
      "enumeration_method": "keryx ctx rg mu.Lock|mu.Unlock|next.ServeHTTP enumerated the single shared lock and both downstream calls; both calls execute under the deferred unlock."
    },
    "global_id": "2026-09-06-path-echolet-cli-prototype-t28#F-010",
    "verification": {
      "verdict": "confirmed",
      "method": "execution",
      "evidence": "A temporary httptest probe held the first downstream handler for 250 ms. A request from a different address remained blocked for more than 180 ms, confirming the global limiter mutex is held across next.ServeHTTP. Command summary: the gdctx command artifact referenced by review-verifier-result.json",
      "verifier": "review-verifier"
    }
  },
  {
    "id": "F-011",
    "reviewer": "review-highload",
    "severity": "major",
    "problem": "Quota accounting uses the TCP source port as part of the client key and never removes old entries.",
    "impact": "Fresh connections from one host obtain fresh per-minute quotas. The normal one-command-per-process CLI also creates separate buckets, so the configured host limit is not enforced across commands; retained connection buckets accumulate across hosts and ports.",
    "suggested_fix": "Normalize RemoteAddr to its host with net.SplitHostPort, define trusted-proxy handling explicitly, and expire/prune idle buckets. Preserve per-host quota across connection churn.",
    "evidence": "rate_limit.go:29 assigns the full r.RemoteAddr string to ip, :34 indexes clients by it, and :36 replaces only the bucket for that exact address. Full RateLimiter implementation contains no deletion or expiry sweep. This report makes no unmeasured OOM timing claim.",
    "confidence": "high",
    "file": "apps/relay/internal/middleware/rate_limit.go",
    "line": 29,
    "dedupe_key": "highload-F-004",
    "blocking_merge": false,
    "class_scope": {
      "sites": [
        "apps/relay/internal/middleware/rate_limit.go:29",
        "apps/relay/internal/middleware/rate_limit.go:34",
        "apps/relay/internal/middleware/rate_limit.go:36"
      ],
      "enumeration_method": "keryx ctx rg RemoteAddr|clients[ and full file read enumerate the single key derivation and map access/update paths; no other quota store or pruning implementation exists."
    },
    "global_id": "2026-09-06-path-echolet-cli-prototype-t28#F-011",
    "verification": {
      "verdict": "confirmed",
      "method": "execution",
      "evidence": "With limit 1, two requests from the same IP but different source ports both received success, while repeating the first full RemoteAddr was rate-limited. Source inspection shows the unpruned map is keyed directly by r.RemoteAddr. Command summary: the gdctx command artifact referenced by review-verifier-result.json",
      "verifier": "review-verifier"
    }
  },
  {
    "id": "F-012",
    "reviewer": "review-testing-practices",
    "severity": "minor",
    "problem": "Unknown-sender rejection test does not pin the explicit CONTACT_NOT_TRUSTED guard.",
    "impact": "Deleting the dedicated missing-contact guard still leaves the nearest suite green: the later decode of a missing value rejects, satisfying rejects.toThrow. A future edit can remove the intended typed trust rejection unnoticed, although the current mutant still fails closed.",
    "suggested_fix": "Assert the public rejection code CONTACT_NOT_TRUSTED for the unknown-sender fixture, while retaining unchanged-state and no-ack assertions. Keep changed-device and malformed-data cases distinct so each names its own intended failure.",
    "evidence": "Isolated deletion of inbound.ts:50 ran inbound.test.ts with exit0 and10/10 tests passing; unmodified baseline also10/10. Test at inbound.test.ts:167 only asserts rejects.toThrow. Removing confirmation, duplicate-hash and batch-minimum gates in the same bounded pass caused1 focused failure each, demonstrating the harness detects real assertion failures.",
    "confidence": "high",
    "file": "apps/cli/src/runtime/inbound.test.ts",
    "line": 167,
    "dedupe_key": "testing-unknown-sender-guard",
    "blocking_merge": false,
    "global_id": "2026-09-06-path-echolet-cli-prototype-t28#F-012",
    "verification": {
      "verdict": "confirmed",
      "method": "site-check",
      "evidence": "The focused test asserts only that the promise throws. The inspected implementation passes the contact bytes to deserialization immediately after the explicit trust guard; removing the guard still supplies a throwing path for an unknown sender, so the assertion cannot distinguish the required error from a later decode error.",
      "verifier": "review-verifier"
    }
  }
]
```
