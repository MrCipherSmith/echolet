STATUS: DONE_WITH_CONCERNS

# Security code review

Two blockers with explicit attack paths. No production security claim.

## [F-001] V1 request bodies are unbounded and send-envelope limits trust attacker-supplied size_bytes.

- Severity: blocker
- Location: `apps/relay/internal/validation/validate.go:82`
- Attack vector: An unauthenticated caller posts to /v1/messages/send with a ciphertext field above the configured maximum while declaring size_bytes=1. Decoder and validator accept it and the mailbox repository persists it. A field above the CLI 1 MiB response budget then makes every affected poll fail; arbitrarily large bodies also allocate memory before any validation.
- Impact: The configured message-byte limit is bypassed, accepted oversized records make a mailbox unreadable through the CLI, and parsing permits memory exhaustion. No signature or victim key is needed for the send path.
- Evidence: MailboxHandler.SendEnvelope at mailbox_handler.go:46 decodes r.Body directly. ValidateMailboxEnvelope at validate.go:82 only compares the supplied SizeBytes with maxBytes, never len(Ciphertext); MailboxRepository.SaveEnvelope persists the result. RelayClient.request at relayClient.ts:86 rejects cumulative response bytes over 1 MiB. Other v1 handlers decode before authorization or signature validation. V2 alone uses MaxBytesReader at signal_prekey_bundle_v2.go:31.
- Fix: Apply explicit MaxBytesReader limits before every v1 decoder, reject over-limit bodies with a bounded error, and validate actual ciphertext bytes against both size_bytes and the configured maximum before persistence. Bound other variable-length request fields/arrays as part of the same decoder contract.
- Class scope: apps/relay/internal/api/handler/mailbox_handler.go:46, apps/relay/internal/api/handler/mailbox_handler.go:96, apps/relay/internal/api/handler/mailbox_handler.go:149, apps/relay/internal/api/handler/mailbox_handler.go:225, apps/relay/internal/api/handler/device_record_handler.go:38, apps/relay/internal/api/handler/prekey_bundle_handler.go:28, apps/relay/internal/api/handler/signal_prekey_bundle_v2.go:31, apps/relay/internal/validation/validate.go:82
- Enumeration: keryx ctx rg json.NewDecoder across handler files enumerated seven decoder sites: six unbounded v1 sites and one bounded v2 sibling. keryx ctx rg SizeBytes|maxMessageBytes identified the sole claimed-size comparison before mailbox persistence.

## [F-002] Mailbox authorization selects a device UUID globally rather than within its owning mailbox identity.

- Severity: blocker
- Location: `apps/relay/internal/storage/repository/device_record_repo.go:68`
- Attack vector: An attacker who knows a victim public device UUID publishes a valid record signed by the attacker own root key using that UUID. Choose an attacker identity whose storage key sorts before the victim identity. Publication permits both records, then victim challenge/poll/ack selects the attacker record first and rejects the legitimate mailbox ownership match.
- Impact: An unrelated identity can disable a legitimate recipient mailbox until the conflicting record is removed. This is denial of service; the subsequent ownership comparison still prevents the attacker from reading the victim mailbox.
- Evidence: DeviceRecordRepository.Save keys records by identity+device, allowing same device UUID under different identities. GetByDeviceID scans device_record keys and stops at first candidate.DeviceID match (device_record_repo.go:68-79). authorizeMailboxDevice calls that method at mailbox_handler.go:267 and only afterward compares the derived mailbox at :275-277. Root/device signature validation authenticates the attacker own identity, not global UUID uniqueness. V2 saveSignalV2Authorization uses the same identity/device key convention.
- Fix: Resolve authorization by mailbox identity plus device UUID, using an immutable indexed mailbox/device binding populated by both v1 and v2 publication. Never select a global first UUID match and only then test mailbox ownership.
- Class scope: apps/relay/internal/storage/repository/device_record_repo.go:68, apps/relay/internal/api/handler/mailbox_handler.go:267, apps/relay/internal/storage/repository/device_record_repo.go:29, apps/relay/internal/storage/repository/signal_prekey_bundle_v2.go:79
- Enumeration: keryx ctx rg GetByDeviceID|candidate.DeviceID|derivedMailboxID identified the sole global selector and shared authorization helper. Full Save and saveSignalV2Authorization reads enumerate both publication writers that permit identity-scoped duplicate UUIDs. The helper serves challenge, poll and ack.

## Checked and cleared

- Contact import or relay ciphertext can replace an existing Signal identity pin. Profile.importContact verifies signed wire before explicit confirmation, rejects changed identifiers and calls approveRemote, which refuses changed native keys; inbound and outbound compare stored pins before native operations.
- V2 publication accepts modified DeviceRecord or bundle fields. Strict ordered decoder verifies root and device signatures before atomic authorization/OTK writes; native SPK/Kyber validation intentionally occurs at the Node trust boundary.
- An invalid mailbox signature consumes a valid poll challenge. Mailbox handler checks identity/mailbox/device binding and signature before atomic challenge invalidation; racing consumers cannot both succeed.
- Wrong database keys silently replace existing identities. EncryptedSqliteStore authenticates existing snapshot with AES-GCM; profile opening refuses missing/corrupt profile replacement. No fallback plaintext or auto-reset path found.
- Routine CLI errors and relay logs expose plaintext or secret material. CLI outputs fixed classified error codes; identity material stays in encrypted snapshot, history is explicit. Relay handlers log no request bodies, and T27 E2E records synthetic-marker absence. No broad secret/history scan is claimed.
- Relay URL redirects send credentials or messages to a second origin. RelayClient requires HTTPS or loopback HTTP, rejects credentials/path/query, and fetch uses redirect:error.

## Limits

- Source-derived attack paths only; no systems contacted and no exploit request bodies or sensitive artifacts created. Independent verifier should use temporary synthetic local fixtures.
- This is a bounded code review, not a cryptographic audit, dependency audit or deployment approval.
- Backend mailbox overwrite/expiry and logic publication/stdin/errors are not duplicated. Legitimate batch-byte budget and limiter concurrency belong to highload.

Routing: graph_used: wire affected; wiki_used: index (security pages unavailable); ctx_used: read/rg; raw_rg_used: no.
