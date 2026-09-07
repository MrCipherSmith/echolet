# T51 — Sender authentication on `/v1/messages/send` (closes T49-F-001)

Flow: `001-2026-09-05-echolet-assessment-fixes`
Dispatch: `001-T51-implement`
Worker: `task-implementer`
Date: 2026-09-07

---

## 1. What was closed

`/v1/messages/send` had never authenticated anyone. Knowing a victim's
`recipient_mailbox_id` — a SHA-256 digest of an identity id the victim publishes in its own
contact card — was sufficient to place arbitrary envelopes in that victim's mailbox. T49's
verification measured the cost on the real relay binary at default configuration: **49
unauthenticated POSTs (~12.8 MB, under 30 s, inside the 120/min rate limit) wedge a victim's
mailbox for up to the 168 h retention cap**, and 800 minimum-size envelopes do the same. T48's
16-page client walk raised the price from one envelope to forty-nine; it did not remove the
capability, because a client-side page bound cannot outrun a mailbox an unauthenticated party can
fill.

The route now refuses, **with a bounded 4xx and before anything is written**, every envelope whose
sender it cannot authenticate against an already-published, root-signed `DeviceRecord`.

---

## 2. The transcript (design T50-D-001, implemented as pinned)

A plain UTF-8 string, signed with the sender's **device** secret key, ed25519, carried as
base64url without padding:

```
echolet-mailbox-envelope:v1:<recipient_mailbox_id>:<envelope_id>:<sender_identity_id>:<sender_device_id>:<base64url_raw(SHA-256(utf8(ciphertext)))>:<created_at_ms>:<expires_at_ms>
```

Seven bound fields — where the envelope lands, which envelope it is, who it claims to be from,
what it contains, and how long it occupies the mailbox. Every input to the flooding capability.

The ciphertext is bound **by digest, not inline**, so the signed string stays a few hundred bytes
for a 256 KiB envelope while still pinning the exact payload bytes.

Implemented in two languages that must reproduce it byte for byte, and pinned **literally** in
both languages' tests so a divergence fails rather than drifts:

| Side | Helpers |
|---|---|
| TypeScript | `packages/crypto-core/src/mailbox/auth.ts` — `hashMailboxEnvelopeCiphertext`, `createMailboxEnvelopeMessage`, `signMailboxEnvelopeMessage`, `verifyMailboxEnvelopeMessage` |
| Go | `apps/relay/internal/cryptoutil/signatures.go` — `HashMailboxEnvelopeCiphertext`, `CreateMailboxEnvelopeMessage` |

The TypeScript helpers sit beside the existing `createMailboxChallengeMessage` /
`createMailboxAckMessage` family and use the same `signUtf8Message` / `verifyUtf8Message`
primitives, so nothing about key handling is new. `hashMailboxEnvelopeCiphertext` uses
`createHash("sha256")` and `encodeBase64Url`, exactly as `deriveMailboxId` already does — which is
what makes it usable unchanged from the React Native demo.

ed25519 is deterministic and the transcript is deterministic, so a byte-identical retry produces a
byte-identical signature. That is what keeps **F-004** intact: an ambiguous send retried with the
identical envelope stays an idempotent replay rather than becoming an `ENVELOPE_ID_CONFLICT`.

---

## 3. The verification point

`MailboxHandler.SendEnvelope` (`apps/relay/internal/api/handler/mailbox_handler.go`), in a new
`authenticateSender` helper. Ordering inside the route:

1. body bound + JSON decode (unchanged)
2. `envelope is required` (unchanged)
3. `validation.ValidateMailboxEnvelope` — type, version, identifier length bounds, UUID shape,
   payload type, ciphertext presence, `size_bytes` agreement, expiry ordering (unchanged)
4. `expires_at_ms` not already past (unchanged)
5. **sender authentication (new)**
6. `StoreEnvelope` (unchanged, including F-004 replay/409 semantics)

Steps 3 and 4 stay ahead of step 5 deliberately. This is finding **T50-I-002** from the test
author, confirmed by their probe: an oversized or malformed identifier keeps answering with the
bound it violated rather than with a signature complaint, so every existing identifier-bound and
shape test still asserts what it was written for.

The check is **not** in `validation.ValidateMailboxEnvelope` — this is finding **T50-I-001**.
Three `internal/validation` tests call that function directly with unsigned envelopes, and it has
no access to the device records the check resolves against. Putting it there turns those three red.

`authenticateSender` does, in order:

| Condition | Answer |
|---|---|
| `sender_signature` absent or empty | `400 INVALID_SCHEMA` |
| longer than 256 bytes (`maxSenderSignatureBytes`) | `400 INVALID_SCHEMA` |
| sender not resolvable to a published `DeviceRecord` | `403 UNAUTHORIZED_MAILBOX_ACCESS` |
| signature does not verify under that record's `device_pubkey` | `403 INVALID_SIGNATURE` |

Resolution **reuses `authorizeMailboxDevice`** — the same immutable `(mailbox identity, device
UUID)` binding the challenge, poll and ack routes already resolve — applied to
`cryptoutil.DeriveMailboxID(envelope.SenderIdentityID)` instead of the recipient's mailbox. No
second trust machinery was built. Its defence-in-depth ownership check (`DeriveMailboxID(record
.IdentityID) == mailboxID`) applies unchanged, and a device UUID published under an unrelated
identity lives under that identity's own key space and is therefore invisible here.

`writeSenderAuthorizationError` answers under the **same** wire code the mailbox routes already
use for "no such binding", so one name keeps meaning one thing on both sides of the wire; only the
message differs, and it names the actual precondition and echoes no caller-supplied value.

The 256-byte bound matches `validation.MaxIdentifierBytes` and the client's own
`z.string().min(1).max(256)` slot. A raw ed25519 signature is 64 bytes — 86 base64url characters —
so it is far above every legitimate value.

---

## 4. The wire contract change

### `sender_signature` on the envelope

* **`packages/protocol/src/types/mailboxEnvelope.ts`** — `sender_signature: z.string().min(1).max(256).optional()`.
  `MailboxEnvelopeSchema` stays `.strict()` and still refuses every other unknown key.
* **`apps/relay/internal/model/mailbox_envelope.go`** — `SenderSignature string \`json:"sender_signature,omitempty"\``.

**Optional on the parse schema, required by the relay.** This is load-bearing, not laxity, and the
orchestrator reviewed and accepted it. The client parses a whole poll response as one
`z.array(MailboxEnvelopeSchema.strict())`. A record stored before this field existed must still
parse, or one legacy envelope fails the batch and wedges the mailbox — which is precisely the
class of defect (R2-001 path A) this wave has been closing. `omitempty` on the Go side is the
other half of the same guarantee: such a record is served **without the key**, never as `""`,
which the client's non-empty bounded string would refuse. `TestPollNeverServesAnEmptySenderSignature`
pins that.

The enforcement point that matters for T49-F-001 is the relay, because only the relay holds the
sender's `DeviceRecord`. It was not "tightened" to required on the parse schema.

### CLI send path

`apps/cli/src/runtime/outbound.ts` now signs every envelope it builds.

The signature has to be produced inside the same durable transaction that encrypts the payload and
writes the outbox, so `Profile.withRuntime` gained a fourth callback argument:
`signEnvelope(binding) => Promise<string>`. It is offered **lazily** — the read-only `withRuntime`
callers pay nothing — and it derives the device key from the profile's own seed inside the
transaction, uses it once, and **zeroes it in a `finally`**, exactly as `Profile.mailboxAuthorization`
already does. Only the transcript's bound fields cross the boundary; no key material leaves it.
The four existing `withRuntime` callers are unchanged (the extra parameter is additive).

Because the signature is written into the durable outbox record alongside the envelope, the retry
path (`deliver` / `retryPending`) replays the stored bytes verbatim — the same property the exact
retry already had.

### Documentation

* `docs/requirements/echolet-cli-prototype/specification.md` — message-flow step 5 now states the
  transcript, the verification, the `relay publish` precondition and the reported code; two rows
  added to the failure-behavior table.
* `docs/API-11_JSON_SCHEMAS.md` — `MailboxEnvelope` (3.3), the `/v1/messages/send` request, and the
  `/v1/mailbox/poll` response.
* `docs/PROTOCOL-07_MVP_MESSAGE_FLOW.md` — 7.4 Mailbox Envelope rules and the send-route checks.

---

## 5. T50-F-001 — the mobile demo (minor)

`apps/mobile/src/screens/MessagingScreen.tsx` built envelopes the relay would now refuse.

Fixed minimally, in the envelope literal at what was line 243: `envelope_id`,
`recipient_mailbox_id` and `expires_at_ms` are hoisted into consts so they can be signed, and
`sender_signature` is computed with `signMailboxEnvelopeMessage(...)` +
`hashMailboxEnvelopeCiphertext(...)` from the same `@echolet/crypto-core` module the screen already
imports `signMailboxAckMessage` / `signMailboxChallengeMessage` /
`signMailboxCreateChallengeMessage` from, using `profile.deviceSecretKey` — the same value the
screen's own poll path already signs with two functions later. Nothing else in `apps/mobile`
changed.

The demo's device record is published by `OnboardingScreen` through
`relayApi.publishDeviceRecord`, so the precondition is already satisfied on that path.

Its 6 tests are green and unchanged. As the test author recorded, they can only observe the double
`__DEV__` / `EXPO_PUBLIC_ECHOLET_ENABLE_UNSAFE_DEMO` gate and never reach `sendEnvelope`, so this
change is correct-by-construction rather than test-verified. Carried forward as **T51-F-002**
below.

---

## 6. T50-F-002 — naming the new precondition (minor)

`send` now presupposes `relay publish`: the relay can only resolve a sender whose `DeviceRecord` it
already holds. Before this change that surfaced as a bare `PROTOCOL_REJECTED`, because
`relayClient.ts`'s `remoteCodes` allowlist carried no sender-unknown code.

Fixed exactly as the earlier `PREKEY_BUNDLE_UNAVAILABLE` fix (R2-L-002) did, option (a) — the
smaller change the finding preferred:

* `apps/cli/src/transport/relayClient.ts` — `UNAUTHORIZED_MAILBOX_ACCESS` added to `remoteCodes`,
  so the transport boundary is willing to carry the relay's own code inland instead of discarding it.
* `apps/cli/src/commands/cli.ts` — `UNAUTHORIZED_MAILBOX_ACCESS` added to `reportedRelayCodes`, so
  `classify()` reports it under the relay's own name.

Not collapsed into the generic protocol rejection. **Exit code stays 3**, as documented; the
0/2/3/4/5 contract is untouched. Option (b) — publishing the sender's record as a side effect of
`send` — was not taken: it was rejected in the finding because every CLI fake relay throws on an
unexpected path, and it would also reintroduce implicit publication, which this flow deliberately
removed.

---

## 7. Verification

Node v26.5.0 (`/opt/homebrew/bin/node`), Go 1.26.1.

| Suite | Result |
|---|---|
| `pnpm test` (whole workspace) | **158 passed, 0 failed** — protocol 12, crypto-core 16, client-db 1, client-core 2, session-node 24, mobile 6, cli 97 (20 files) |
| `pnpm typecheck` | **Done on all 7 projects** |
| `go -C apps/relay test ./...` | **all packages ok** |
| `go -C apps/relay test -race -count=1 -tags=relayv2 ./...` | **all packages ok, 0 data races** |
| `go -C apps/relay vet ./...` | clean |
| `gofmt -l` | no changed file listed (two pre-existing `signal_prekey_bundle_v2.go` files were already unformatted before this task and were not touched) |
| `pnpm lint` | no package defines a `lint` script |

This matches the test author's satisfiability target exactly: 20 files / 97 tests in `apps/cli`,
158 workspace-wide.

Both `apps/cli` E2E suites are included in that 97 and both pass, including the real two-process
run against the built relay binary (3 iterations) and the unauthenticated re-injection now refused
with a bounded 4xx.

### No test was weakened

All eight T50 test files verify **byte-identical by SHA-256** against the hashes recorded in
`001-T50-tests-result.json`:

```
ba3398c381963ff88f581e2d204225fe29fe21394eba7d4c903b6d6983b0a21e  packages/crypto-core/src/mailbox/auth.envelope.test.ts
88f58c4e27eae76a56cda27d3e56d48d54f3d96f9e898b31ba14527c547304db  packages/protocol/src/types/mailboxEnvelope.test.ts
6dc3ffc5173d45ad1149ac867eec77d8a89500689e2227510951072258b1cf1d  apps/relay/internal/api/handler/mailbox_sender_authentication_test.go
a6953606c1d1fd8351fa780c7aff3b4dfedf5a50e5dbc52b438d61c59d00242c  apps/cli/src/runtime/outbound.senderAuthentication.test.ts
f7c0dd285f1791952699b2af9349dccb046d1c74a40e58b265f25952c240583a  apps/relay/internal/api/handler/mailbox_envelope_lifecycle_test.go
988c7c8dffbbba21b3d92149d3beefc078d73b488d2988000520367c5e67f285  apps/relay/internal/api/handler/mailbox_poll_capacity_test.go
cb6ff6fa76b1ffa0471a7273d59632f88008f8c375b38cdc0bea74b3d85e0ae9  apps/cli/test/e2e/two-process.test.ts
c591666924a86acec6dfeff819f78cefed108e7c4da2e34d55283208da37ef3b  apps/cli/test/e2e/publication-claimability.test.ts
```

No test file of any kind was edited, created or deleted by this task. A scan across every
`*.test.ts`, `*.test.mjs` and `*_test.go` in the repository returns **0** matches for
`.skip(` / `.only(` / `.todo(` / `xit(` / `xdescribe(` / `t.Skip(` / `t.Skipf(`.

`apps/cli/vitest.config.ts` (`da0c9db0ed3b0b193e5b65b83f3b765c8ae26b88fa78744aff436a16c97c94d4`) and
`apps/cli/test/globalSetup.ts` (`a27ae89746a9b4d69ec17f8697ad3b67be79765c8e066b52f8bbf76de8b6cf69`)
were not opened for edit. `flow.json` and `acceptance-criteria.md` were not written.

### Landed work preserved

Confirmed green, unmodified: F-004 replay/409 semantics
(`TestAuthenticatedSendKeepsEnvelopeIDReplaySemantics` plus the whole lifecycle suite), F-005
expiry ordering, F-006 identifier bounds, T48 shape parity and cursor resumption, `claimable`
required on publish, no implicit publication rotation, and the 0/2/3/4/5 exit-code contract. Every
`.strict()` schema stays strict and closed.

---

## 8. Files changed

| File | Change |
|---|---|
| `packages/crypto-core/src/mailbox/auth.ts` | +4 exported helpers: ciphertext digest, transcript, sign, verify |
| `packages/protocol/src/types/mailboxEnvelope.ts` | `sender_signature` optional, bounded 1..256, schema still `.strict()` |
| `apps/relay/internal/model/mailbox_envelope.go` | `SenderSignature` with `omitempty` |
| `apps/relay/internal/cryptoutil/signatures.go` | `HashMailboxEnvelopeCiphertext`, `CreateMailboxEnvelopeMessage` |
| `apps/relay/internal/api/handler/mailbox_handler.go` | `authenticateSender` + `writeSenderAuthorizationError`, called after validation/expiry and before storage |
| `apps/cli/src/runtime/profile.ts` | `MailboxEnvelopeBinding`, `signEnvelopeBinding` (key zeroed), lazy 4th `withRuntime` argument |
| `apps/cli/src/runtime/outbound.ts` | every sent envelope carries a `sender_signature` |
| `apps/cli/src/transport/relayClient.ts` | `UNAUTHORIZED_MAILBOX_ACCESS` in `remoteCodes` |
| `apps/cli/src/commands/cli.ts` | `UNAUTHORIZED_MAILBOX_ACCESS` in `reportedRelayCodes` |
| `apps/mobile/src/screens/MessagingScreen.tsx` | demo signs its envelope (T50-F-001) |
| `docs/requirements/echolet-cli-prototype/specification.md` | message flow step 5, two failure rows |
| `docs/API-11_JSON_SCHEMAS.md` | envelope schema, send request, poll response |
| `docs/PROTOCOL-07_MVP_MESSAGE_FLOW.md` | 7.4 rules, send-route checks |

No test file, config file or flow file was modified. `apps/cli/dist/cli.js` is a build artifact
regenerated by `apps/cli/test/globalSetup.ts`.

---

## 9. Findings for the verifier

### T51-F-001 (minor) — `UNAUTHORIZED_MAILBOX_ACCESS` is now also reported for poll and ack

`reportedRelayCodes` is consulted by `classify()` for **every** non-retryable `RelayError`, not only
for sends. A `403 UNAUTHORIZED_MAILBOX_ACCESS` raised by `/v1/mailbox/challenge`, `/v1/mailbox/poll`
or `/v1/mailbox/ack` — a device the relay holds no binding for — therefore now reports under that
code instead of `PROTOCOL_REJECTED`.

This is deliberate and, I believe, correct: it is literally the same condition seen from the other
side, and naming it is strictly more informative than flattening it. The exit code is unchanged (3)
and no test asserted the old flattening. But it is a behaviour change slightly wider than T50-F-002
literally asked for, so it is stated rather than left for a reviewer to notice.

### T51-F-002 (minor) — the mobile signing change is unverifiable by any test

Carried forward from T50-F-001. `apps/mobile`'s 6 tests render only the disabled-state gate and
never reach `sendMessage`, and `sender_signature` is optional in the typed envelope, so neither the
suite nor `tsc` can observe whether the demo signs correctly. The change was made against the same
transcript the CLI and relay tests pin literally in both languages, and the demo's device record is
published by onboarding — but if the demo's runtime behaviour matters, it needs a test that reaches
`sendEnvelope`, and mobile was explicitly out of scope for more than the minimal change.

### T51-F-003 (info) — an unpublished-identity oracle on `/v1/messages/send`

Resolving the sender through `DeriveMailboxID(sender_identity_id)` means an unauthenticated caller
can distinguish "this identity has published a device record" (`403 INVALID_SIGNATURE`, having
failed at the signature) from "it has not" (`403 UNAUTHORIZED_MAILBOX_ACCESS`). The same oracle
already exists on `/v1/mailbox/challenge` for any known mailbox id, and both codes are 403 with no
body distinction beyond the code, so this adds no capability that was not already reachable. Noted
for completeness; no change made.

### T51-F-004 (info, carried from T50-I-002) — three envelope fields stay unbound

`message_id`, `recipient_identity_id` and `recipient_device_id` are deliberately **not** in the v1
transcript, exactly as the design pinned. An on-path attacker can rewrite them on an otherwise
valid envelope without invalidating the signature. Blast radius does not include the T49-F-001
capability: the envelope cannot be retargeted at another mailbox, its `envelope_id` cannot be
reused, its payload cannot be swapped, its lifetime cannot be extended, and nothing can be sent
from an unpublished sender. A rewritten `recipient_*` or `message_id` is refused by the recipient's
own `acceptOne` checks (`apps/cli/src/runtime/inbound.ts:158-165`) or fails to decrypt. If a later
round wants them bound, mint `:v2` and change both languages together — do not silently extend the
v1 string.
