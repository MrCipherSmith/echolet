STATUS: DONE_WITH_CONCERNS

# Backend review

Spec implementation coverage: PASS. Path mode; Go/Badger-specific review, NestJS rules not applicable.

One blocker and one major finding.

## [F-001] Saving an existing envelope ID silently replaces the accepted mailbox record.

- Severity: blocker
- Location: `apps/relay/internal/storage/repository/mailbox_repo.go:30`
- Impact: Submit envelope A, then a different otherwise accepted envelope B with the same recipient mailbox and envelope ID before the receiver polls. Both sends succeed, but B overwrites A; the original accepted message is irretrievably lost. Sequential requests suffice.
- Evidence: mailbox_repo.go:28-31 constructs mailbox:<recipient>:<envelope-id> and calls SetEntry without reading old content. mailbox_handler.go:66-79 returns success for both writes. ValidateMailboxEnvelope does not enforce envelope identity uniqueness. Unlike SaveSignalV2, no mailbox equality/conflict check exists. Source-derived reproduction; no live writes performed.
- Fix: Read the existing record inside the same transaction. Return success only for an identical envelope; reject changed content with a conflict error and map it to HTTP 409. Retry transaction conflicts safely.
- Class scope: apps/relay/internal/storage/repository/mailbox_repo.go:30, apps/relay/internal/api/handler/mailbox_handler.go:66
- Enumeration: keryx ctx rg ENVELOPE_ID_CONFLICT|WithTTL|ExpiresAtMs|DeleteEnvelope across apps/relay/internal plus full MailboxService read enumerates the single mailbox writer and its single send-handler path; no existing conflict branch.

## [F-002] Mailbox retention and selection ignore the envelope expiry time.

- Severity: major
- Location: `apps/relay/internal/storage/repository/mailbox_repo.go:30`
- Impact: A normal CLI send expires after 24 hours, but SaveEnvelope retains it for 7 days. If the recipient returns after 24 hours, GetEnvelopes still returns the expired envelope; inbound rejects the entire batch before ack. Repeated polls remain blocked by that expired record, including new valid messages selected in the same batch, until physical TTL expiry.
- Evidence: outbound.ts:79 sets expires_at_ms to created+86400000; mailbox_repo.go:30 assigns fixed WithTTL(7*24*time.Hour), and :47-55 appends stored records without checking ExpiresAtMs. cleanup_service.go:43-45 relies solely on Badger TTL. inbound.ts:46 rejects expires_at_ms<=now before any pending ack is recorded. This is a normal delayed-receiver scenario, not a malicious-input claim.
- Fix: Reject already-expired envelopes, retain each envelope no longer than its remaining declared lifetime (and configured server cap), and filter expiry during retrieval before applying the batch limit. Do not extend expiry on identical retries.
- Class scope: apps/relay/internal/storage/repository/mailbox_repo.go:30, apps/relay/internal/storage/repository/mailbox_repo.go:53, apps/relay/internal/service/cleanup_service.go:43, apps/relay/internal/validation/validate.go:85
- Enumeration: keryx ctx rg WithTTL|ExpiresAtMs|DeleteEnvelope across relay internal code enumerates the only mailbox writer, reader, cleanup and lifetime validation boundaries; none uses current time to enforce envelope lifetime.

## Checked and cleared

- Concurrent v2 claims can allocate the same OTK twice. ClaimSignalV2 reads bundle state, marks claimed, removes availability and stores claim replay in one conflict-retried Badger transaction; T27 records the 20-contender race proof.
- OTK tombstones are released after claim or expiry. SaveSignalV2 reserves tuple and public-key indexes in the publication transaction; claim only deletes availability. No TTL or delete exists for reservation keys.
- Claim replay changes bytes or accepts a changed selector. Persisted claim stores Bundle as bytes and exact selector; replay compares identity/device before returning. Handler writes original raw bytes directly without re-encoding.
- V2 validation skips the root/device binding or accepts duplicate signed fields. Ordered decoder rejects duplicates and unknown fields; validation verifies root-signed DeviceRecord and complete device-signed transcript before repository writes. Native SPK/Kyber verification remains intentionally client-side.
- Mailbox poll consumes a challenge before authenticating the caller. PollMailbox verifies mailbox/device matching and signature before atomic Invalidate; repository treats racing consumption as invalid challenge.
- Ack retry of already-deleted envelopes fails its expected count. DeleteEnvelope is idempotent and handler returns requested count only after all deletions succeed; partial failures remain safely retryable.

## Limits

- Path-mode source review; T27 tests were not rerun. Reproduction scenarios are source-derived pending independent verifier.
- NestJS/Prisma-specific rules do not apply to this Go/Badger backend.
- CLI publication retry, stdin and error-classification findings are owned by logic and not repeated.
- Resource limits, device-ID collision abuse and poll-response byte budget are deferred to security/highload roles.

Routing: graph_used: find relay (TS only, explicit Go input paths); wiki_used: index (relay pages unavailable); ctx_used: read/rg; raw_rg_used: no.
