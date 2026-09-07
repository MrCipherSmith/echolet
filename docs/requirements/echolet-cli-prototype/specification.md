# Echolet CLI Prototype Specification
Version: 0.1.1

## Module identity

- Package: `echolet-cli-prototype`
- Planned application: `apps/cli`, package name `@echolet/cli`
- Existing dependencies: `apps/relay`, `packages/protocol`, `packages/crypto-core`, and `packages/session-node`
- Status: implemented and locally verified as a computer technical prototype (2026-09-07). Production readiness, mobile delivery, deployment, external audit and user demand are not claimed
- Runtime target: Node 22.13+ and the local Go relay. **Node 22.12 and below lack `node:sqlite`; under them most CLI suites fail to collect in a way that is indistinguishable from a broken implementation.** Verification ran on Node 26.5.0

## Implementation state

| Capability | State at package creation | State on 2026-09-07 |
|---|---|---|
| Go relay v1 device, prekey, message, challenge, poll, and ack routes | Implemented | Implemented; `send` additionally authenticates the sender and enforces a per-sender unacked quota |
| Strict signed `SignalPreKeyBundleV2` plus verified Node import/export | Implemented | Implemented |
| Encrypted transactional Node session/inbox/outbox persistence | Implemented reference | Implemented |
| Relay v2 publication and atomic claim | Planned | Implemented over the network path, with `claimable` on the publish response |
| CLI profiles, contact commands, transport, history, and demo | Planned | Implemented; the eight-command surface below is frozen |
| Networked two-process end-to-end evidence | Planned | Implemented and passing: `test/e2e/two-process.test.ts`, 3/3 unfiltered iterations of one scenario (`t55-final-verification.md`). That file is what `pnpm --filter @echolet/cli test:e2e` runs; the other five files under `apps/cli/test/e2e/` run under `pnpm test` |

## Repository and storage structure

```text
apps/cli/
  package.json
  src/commands/
  src/contact/
  src/runtime/
  src/transport/
  src/history/
  test/e2e/
packages/protocol/
  src/types/relaySignalBundleV2.ts
  src/validators/
apps/relay/
  internal/model/
  internal/storage/repository/
  internal/service/
  internal/api/handler/
docs/requirements/echolet-cli-prototype/schemas/
```

Each client profile contains only public configuration and an encrypted database:

```text
<profile>/
  config.json
  client.sqlite
```

`config.json` conforms to [client-config.schema.json](schemas/client-config.schema.json). The 32-byte database key is supplied through the environment variable named by `store_key_env`; it is never stored in the profile or printed by normal commands. The encrypted store owns identity material, trusted contacts, native Signal records, inbox, outbox, and durable history.

## Configuration

Required fields are `profile_version`, `profile_id`, `relay_url`, `database_path`, `store_key_env`, `request_timeout_ms`, and `poll_batch_size`. Relative `database_path` values resolve against the profile directory. The CLI rejects unknown fields, non-loopback plain HTTP relay URLs, missing keys, or keys that do not decode to exactly 32 bytes.

## CLI surface

All eight commands are implemented and their acceptance tests pass. The surface is deliberately frozen: no ninth command was added during remediation, which is why bundle rotation and pending-send retry have no entry point (see the claim contract below).

```text
echolet init --profile <dir>
echolet contact export --profile <dir> --out <file>
echolet contact import --profile <dir> --from <file>
echolet relay publish --profile <dir>
echolet send --profile <dir> --to <identity-id> --text <text>
echolet poll --profile <dir>
echolet history --profile <dir> --with <identity-id> [--json]
echolet doctor --profile <dir>
```

Commands return exit code `0` on success, `2` for input/configuration errors, `3` for trust/protocol rejection, `4` for temporary relay/network failures, and `5` for local persistence failures. Machine-readable mode writes one JSON result to stdout; diagnostics go to stderr and redact secrets and plaintext.

Three relay refusals are reported under the relay's own code rather than as a generic `PROTOCOL_REJECTED`, because none of them is a trust violation and flattening them names nothing the operator can act on. All three stay at **exit 3**:

| Reported code | Condition |
|---|---|
| `PREKEY_BUNDLE_UNAVAILABLE` | No claimable bundle for this recipient (see the claim contract below). |
| `UNAUTHORIZED_MAILBOX_ACCESS` | The relay holds no published, root-signed device record for this profile. `send` presupposes a prior `relay publish`. |
| `SENDER_QUOTA_EXCEEDED` | This sender already holds its full unacked allowance in that one recipient's mailbox. Temporary; it clears on the recipient's ack or on expiry. |

### `poll` result

`poll` writes one result of shape `{ received, more, rejected }`:

- `received` — envelopes accepted and committed by this poll, across every page it walked;
- `more` — the relay's remaining-work signal (`next_cursor` non-null) as of the last page read: `true` means the relay cut that response short at its own batch or byte bound and the caller should poll again;
- `rejected` — permanently unacceptable envelopes in the order they were read, each entry carrying only `{ envelopeId, code }` and no envelope content. They are neither committed nor acknowledged, so the relay keeps them queued; they simply no longer stop the rest of the batch, or the pages behind it, from being delivered.

**A poll that accepted at least one envelope exits 0 even when `rejected` is non-empty.** Rejections are reported, not raised: the exit code answers "did this poll make progress", and the `rejected` list answers "what did it refuse".

The one exception is deliberate: if a poll accepts *nothing* and at least one envelope was rejected, the first rejection is re-raised as the command's failure and the `rejected` list is discarded. This preserves the whole-batch contract for a mailbox that holds nothing acceptable; the cost, accepted knowingly, is that the operator does not learn whether one envelope or fifty were refused.

## Contact contract

`contact export` writes a [contact card](schemas/contact-card.schema.json) containing the current complete signed Signal bundle v2 and an optional local display name. `contact import` validates the bundle against its embedded root-signed `DeviceRecord`, including native signatures, and shows the exact `identity_id`, `device_id`, `device_pubkey`, and `signal_identity_key` before trust is recorded. It pins the Signal identity but does not establish a session or consume the enclosed one-time prekey. Both parties exchange and import cards before messaging, so the receiver can authenticate the initiator before first decrypt. Later bundle data received from the relay must match this pin and never creates trust. A changed device or Signal identity fails closed; reset/rotation UX is outside this prototype.

## Relay v2 contract

Payloads conform to [relay-v2.schema.json](schemas/relay-v2.schema.json).

### Publish

`POST /v2/prekeys/publish` accepts `{ "bundle": SignalPreKeyBundleV2 }`. The relay validates the strict shape, lifetime, root-signed device record, and device signature over the complete v2 transcript. The claiming client uses official libsignal to validate the native signed and Kyber prekey signatures. The relay stores the original `bundle` JSON slice without reparsing/reordering its nested `DeviceRecord`; claim returns those exact bytes. A repeated publish is idempotent only when the stored and submitted bundle slices are byte-identical. Reuse of the same `bundle_id` with different bytes returns `409 BUNDLE_ID_CONFLICT`. Shared TypeScript/Go fixtures include a valid non-schema-order `capabilities` object.

The publish success response is `{ "stored": true, "bundle_id": uuid, "claimable": boolean }`. **`claimable` is required on every successful publish response** and the CLI parses it under a strict schema. It reports whether the stored publication is still available for a first-contact claim — the negation of the stored bundle's claimed flag, which `POST /v2/prekeys/claim` sets in the same transaction that removes the availability entry. It exists because publish is idempotent and a repeated publish of an already-claimed bundle succeeds while restoring nothing: without the field the response is byte-identical on the first-store and the re-store paths, so a client cannot tell a real publication from a recovery attempt that restored no availability. A re-publish after a claim therefore returns `stored: true` with the same `bundle_id` and `claimable: false`; it does not restore availability. Expiry does not enter into the value, because validation refuses an out-of-window bundle before publication reaches storage. A CLI from this tree against a relay predating the field fails with `INVALID_RELAY_RESPONSE`, which the operator sees as exit 3 `PROTOCOL_REJECTED` (open finding R2-I-003).

For this prototype, publication requires a non-null `one_time_prekey`. In the same publish transaction, the relay reserves two permanent indexes: `(identity_id, device_id, signal_identity_key, one_time_prekey.key_id)` and a hash of `one_time_prekey.public_key`. Any collision rejects the new bundle, including a different `bundle_id`, changed key ID, previous claim, expiry, or relay restart. Expiry makes a bundle unavailable but never releases its one-time-prekey tombstones. A device may publish another independently signed bundle only with a newly generated one-time prekey.

### Atomic claim

`POST /v2/prekeys/claim` accepts `{ "claim_id": uuid, "identity_id": string, "device_id": uuid|null }`. `claim_id` is a fresh client-generated idempotency key. In one Badger transaction the relay either returns the result already bound to that claim and selector, or selects the oldest unexpired, unclaimed bundle, marks it claimed, and stores the exact result under `claim_id`. Retrying the same claim and selector returns the same stored bundle; reusing a claim ID with a different selector returns `409 CLAIM_ID_CONFLICT`. Competing claim IDs cannot both receive the same `bundle_id` or one-time prekey. No available bundle returns `404 PREKEY_BUNDLE_UNAVAILABLE`. The relay never removes, replaces, or resigns fields inside the signed bundle.

`PREKEY_BUNDLE_UNAVAILABLE` covers four conditions, not only the first: the recipient's published bundle was already claimed, the recipient never published one, every published bundle is outside its validity window, or the requested `device_id` selector matches no available bundle. None of the four is a trust violation, so the CLI reports the relay's own code rather than flattening it into `PROTOCOL_REJECTED`; the exit code is 3.

**Limitation, structural for this prototype:** through the CLI, a published bundle serves exactly one first-contact sender; the CLI has no command to allocate a fresh one-time prekey, so a second distinct sender cannot establish a first session with the same recipient and receives `PREKEY_BUNDLE_UNAVAILABLE`. A re-run of `relay publish` reports `claimable: false` rather than restoring availability. The capability exists in the codebase (`OutboundMessenger.rotateBundle()`, and `retryPending()` alongside it) and is deliberately unreachable, because a ninth command would change the frozen CLI surface this prototype validates. No acceptance criterion here or in [metrics-and-validation.md](metrics-and-validation.md) requires two distinct senders to reach one recipient, so this breaks an unclaimed guarantee rather than a claimed one.

Expired unclaimed records are not returned. Claim records retain `claim_id`, selector, `bundle_id`, claim time, and the exact result needed for idempotent replay; they do not store message plaintext. Prototype retention is indefinite so restart and timeout behavior are deterministic. A later production design must define bounded retention without reissuing consumed keys.

## Message flow

1. Alice and Bob each initialize a separate profile, export their current signed bundle in a contact card, exchange cards out of band, verify identifiers, and pin each other's Signal identity.
2. Each publishes a signed v2 bundle.
3. Alice sends to Bob. If no session exists, she atomically claims Bob's bundle, verifies it against Bob's trusted identity/device, explicitly approves the Signal identity, and establishes the session.
4. Alice encrypts a payload that binds `message_id` to plaintext. Session state and exact ciphertext enter the durable outbox in one transaction.
5. The client wraps that ciphertext in the existing `MailboxEnvelope` v1, signs the sender transcript `echolet-mailbox-envelope:v1:<recipient_mailbox_id>:<envelope_id>:<sender_identity_id>:<sender_device_id>:<base64url_raw(SHA-256(utf8(ciphertext)))>:<created_at_ms>:<expires_at_ms>` with its own device key, carries the result as `sender_signature`, and calls `POST /v1/messages/send`. The relay resolves the sender through the same immutable `(mailbox identity, device UUID)` binding it uses for challenge/poll/ack — applied to `deriveMailboxId(sender_identity_id)` — and refuses with a bounded 4xx, before storage, any envelope whose signature is missing, malformed, over 256 bytes, made over a different transcript, or made by a device it holds no published root-signed `DeviceRecord` for. Sending therefore presupposes step 2: a profile that has not published is refused `403 UNAUTHORIZED_MAILBOX_ACCESS`, which the CLI reports under that code at exit 3 rather than as a generic `PROTOCOL_REJECTED`. The signature is deterministic, so an exact retry of an ambiguous send replays identical bytes and stays idempotent. On the response side the field is omitted, never empty, for records stored before it existed.
6. Bob creates a signed mailbox challenge request and polls. Before decrypt, the sender's bundle signature and Signal identity must match the pin created by contact import; ciphertext never creates or replaces trust. Bob decrypts each envelope, committing session changes, inbox deduplication, and history together. Each envelope is admitted in its own transaction, so an envelope that is permanently unacceptable rolls back only itself and the envelopes around it are still committed.
6a. One `poll` may walk several relay pages. The relay's `next_cursor` is both the remaining-work signal and a resume position, and the client sends it back as the request's `cursor` field, at most **16 pages** per `poll` and only while every page so far has yielded nothing. The walk exists because a permanently rejected envelope is deliberately never acknowledged and therefore keeps its place in the relay's selection order; without it a sender who fills one selection window stops every envelope behind it from ever being delivered. It is bounded because each page costs a challenge and a poll round trip and the mailbox is fillable by any published sender. The walk stops as soon as anything is accepted, and the next `poll` resumes the remainder from a fresh cursor.
7. Bob calls `POST /v1/mailbox/ack` only after the decrypt transaction commits. A failed ack is retried without decrypting or inserting history again.
8. Replies reuse the established session. Restarts reopen the same encrypted store.

## Durable records and invariants

- Contact key: trusted Echolet identity/device and pinned Signal identity.
- Session key: native serialized session records by exact remote address.
- Outbox key: remote address plus `message_id`, containing immutable ciphertext and delivery state.
- Inbox key: remote address plus `message_id`, containing the authenticated payload hash and ack state.
- History key: contact plus monotonic local sequence, containing direction, message ID, plaintext, and timestamps inside the encrypted store.

The same message ID with different content is rejected. An uncertain send reads existing ciphertext from the outbox. Duplicate envelopes do not advance the receiving session twice and do not duplicate history. Acknowledgement occurs after durable decrypt commit. Local history plaintext never crosses the relay API.

## Integration points

- `packages/session-node`: session establishment, encryption/decryption, verified wire import/export, and transactional store.
- `packages/protocol`: canonical TypeScript schemas and shared JSON fixtures.
- `apps/relay`: v2 publish/claim and existing mailbox transport.
- `packages/crypto-core`: DeviceRecord and mailbox signatures plus mailbox ID derivation.
- Existing v1 prekey endpoints remain unchanged for the guarded legacy demo; the CLI uses only v2 bundle endpoints.

## Failure behavior

| Failure | Required result |
|---|---|
| Invalid/expired/untrusted bundle or sender identity mismatch | Reject before trust or session mutation |
| Claim response lost | Retry the same `claim_id` and receive the same exact bundle |
| Concurrent claims | Exactly one claimant receives a bundle |
| Relay timeout after send | Keep outbox pending and retry exact bytes |
| Send whose sender the relay cannot authenticate | Refuse with a bounded 4xx before storage; store nothing in the recipient's mailbox |
| Send from a profile that has not published its device record | Report the relay's `UNAUTHORIZED_MAILBOX_ACCESS` at exit 3, not a generic protocol rejection |
| Send to a recipient where this sender already holds its full unacked allowance (default 16 live envelopes in that one mailbox) | Refuse with `403 SENDER_QUOTA_EXCEEDED` before storage; report it at exit 3 under its own code, never as `PROTOCOL_REJECTED` and never as a retryable exit 4. The allowance frees as the recipient acknowledges or the envelopes expire; a byte-identical replay of an already-stored `envelope_id` is exempt and stays a `200` |
| First contact with a recipient whose published bundle is already claimed, absent, expired, or matches no such device | Report the relay's `404 PREKEY_BUNDLE_UNAVAILABLE` at exit 3 under its own code, not as a generic protocol rejection. Through the CLI this is terminal for that pair: no command allocates a fresh one-time prekey |
| Envelope whose `size_bytes` disagrees with the actual `ciphertext` length | Refuse `400 INVALID_SCHEMA` before storage; the field is measured, not trusted |
| Poll page consisting entirely of permanently unacceptable envelopes | Walk to the next page with the server-issued cursor, at most 16 pages per `poll`; acknowledge nothing that was not committed |
| Poll that accepts some envelopes and rejects others | Exit 0; report the rejections as `rejected[{envelopeId, code}]` and ack only what committed |
| Poll that accepts nothing and rejects at least one | Re-raise the first rejection as the command's failure; acknowledge nothing and mutate nothing |
| Decrypt or database commit failure | Do not ack; leave envelope retriable |
| Ack timeout after decrypt commit | Retry ack; do not decrypt or add history twice |
| Wrong/missing database key | Fail closed without replacing the store |
| Process termination | Reopen last fully committed snapshot |

## Acceptance criteria

- AC-01: JSON fixtures pass both TypeScript and Go validation, including invalid signatures, expiry, unknown fields, and changed signed fields.
- AC-02: a race-enabled Go test proves exactly one successful claim from at least twenty concurrent requests.
- AC-02a: republishing a reserved or consumed one-time prekey under a new bundle ID, changed key ID, after expiry, or after relay restart is rejected.
- AC-02b: retrying a committed claim after a simulated lost response returns the same exact bundle; changing its selector rejects.
- AC-03: two separate profiles exchange and import contact cards, pin each other's Signal identities, and then exchange a first message and reply through HTTP relay calls without direct in-process session setup.
- AC-04: receiver-offline delivery succeeds after later poll.
- AC-05: sender restart preserves and retries byte-identical ciphertext after an ambiguous send.
- AC-06: receiver restart preserves history; duplicate delivery creates no duplicate entry.
- AC-07: invalid mailbox signature, malformed ciphertext, oversized envelope, wrong store key, and changed contact key fail closed.
- AC-08: relay storage and request logs contain no known plaintext marker used by the test.
- AC-09: the exact commands and evidence in [metrics-and-validation.md](metrics-and-validation.md) pass on a clean checkout.
- AC-10: documentation and status reports describe the result as a computer technical prototype and retain the dependency/security limitations.
