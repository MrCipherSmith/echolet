# T38 fix review — review-security-code

STATUS: DONE

Run `001` · dispatch `001-T38-review-security-code` · reviewer `review-security-code`
Assigned set: **F-006**, **F-007**, plus a **secret-leakage** and **exit-code-integrity**
audit across T33/T34/T35/T39.

## Scope

- Branch `main`, unborn: no commits, no merge-base. `git diff` is empty by
  construction, so the review is of the **working tree** against the T28 finding
  evidence, the implementation reports and `docs/requirements/echolet-cli-prototype/specification.md`.
- Read-only. No source, test or configuration file was modified.
- The verification matrix was **not** re-run (T37 owns that). One bounded
  read-only probe was executed: `node -e` against `node:util.parseArgs` with
  synthetic literals, to establish the parser behaviour F-013 depends on. No
  repository state was touched.
- No plaintext, ciphertext, store key, private key material or HTTP request body
  is reproduced anywhere below.

## Dispositions

| Finding | Disposition | One-line basis |
|---|---|---|
| F-006 (blocker) | **fixed** | All six v1 decoder sites bound the body before `encoding/json`; ciphertext length is now the authority and is checked against both `size_bytes` and the configured maximum. |
| F-007 (blocker) | **fixed** | The global `device_record:*` UUID scan is gone; authorization resolves through `device_mailbox:<mailbox_id>:<device_id>`, populated by both v1 and v2 publication, and the binding cannot be pre-empted by a non-owner. |
| Secret leakage (audit) | **fixed** (no leakage found) | No key material, ciphertext, plaintext or request body reaches logs, diagnostics or error output on any new path, including `cli:publication` (F-001) and the poll byte-budget code (F-009). |
| Exit-code integrity (audit) | **fixed** | The set is still exactly 0/2/3/4/5 with the spec's meanings; the new exit-5 persistence path and the argument-parsing change add no sixth code and remove none. One accepted behaviour change is recorded as R-001 below. |

---

## F-006 — bounded v1 bodies and a real ciphertext-length check → `fixed`

### (a) Bounded bodies before decoding

`apps/relay/internal/api/handler/request_body.go:42-56` introduces
`decodeJSONRequest`, which wraps `r.Body` in `http.MaxBytesReader` **before**
constructing the decoder (`:43` precedes `:45`), maps `*http.MaxBytesError` to
413 `PAYLOAD_TOO_LARGE` and every other decode failure to 400 `INVALID_JSON`.

Enumeration (`keryx ctx rg "json.NewDecoder|decodeJSONRequest|MaxBytesReader|io.ReadAll|r\.Body" --glob "apps/relay/**/*.go"`)
returns exactly seven decoder sites in production code, and every one is bounded:

| Site | Bound |
|---|---|
| `mailbox_handler.go:77` `SendEnvelope` | `h.envelopeBodyLimit()` — derived, see below |
| `mailbox_handler.go:142` `CreateChallenge` | `compactRequestBodyLimit` (64 KiB) |
| `mailbox_handler.go:199` `PollMailbox` | 64 KiB |
| `mailbox_handler.go:306` `AckMailbox` | 64 KiB |
| `device_record_handler.go:38` `PublishDeviceRecord` | 64 KiB |
| `prekey_bundle_handler.go:28` `PublishPreKeyBundle` | `envelopeRequestBodyLimit` (1 MiB) |
| `signal_prekey_bundle_v2.go:31` (v2, pre-existing) | 64 KiB |

`router.go:64-79` registers no POST route outside that set, so the class is
closed at the router.

The send bound is derived, not hand-chosen: `mailbox_handler.go:67-73` returns
`maxMessageBytes + envelopeJSONOverheadBytes` (64 KiB), which resolves T34-I-003.
The derivation is sound: the envelope's fixed fields are a few hundred bytes of
UUIDs, base64url ids and integers, so 64 KiB of headroom over the maximum
ciphertext is generous while keeping the decoder's exposure within a small
multiple of the configured maximum.

Variable-length arrays are bounded too: `mailbox_handler.go:315` caps
`envelope_ids` at the configured mailbox batch (falling back to
`maxAckEnvelopeIDs` = 1000), and `prekey_bundle_handler.go:37` caps
`one_time_prekeys` at 1000. Individual unbounded string fields are bounded
transitively by the body limit, so no single request can force an allocation
above the route's bound.

### (b) Real ciphertext length, not the attacker's `size_bytes`

`apps/relay/internal/validation/validate.go:85-94` now derives the authority from
`len(envelope.Ciphertext)` and rejects in three separate ways: actual length over
`maxBytes` → `PAYLOAD_TOO_LARGE`; declared `SizeBytes` over `maxBytes` →
`PAYLOAD_TOO_LARGE` (the inflated declaration is still refused); and a mismatch
between the two → `INVALID_SCHEMA`. The order matters and is correct — the
oversized-with-understated-size case is caught by the first check before the
mismatch check can turn it into a mere schema error.

The comparison is against the base64url **string** length on both sides of the
wire: the CLI sets `size_bytes: Buffer.byteLength(ciphertext)` at
`apps/cli/src/runtime/outbound.ts:83` and re-checks the same equality on receipt
at `apps/cli/src/runtime/inbound.ts:51`. Go and TypeScript therefore agree on
what `size_bytes` counts.

The attack described in F-006 — a small declared `size_bytes` smuggling an
oversized ciphertext into Badger, with no signature or victim key needed — is
closed at `validate.go:86` before `mailboxService.StoreEnvelope` is reached
(`mailbox_handler.go:102`).

### Test integrity for this finding

`apps/relay/internal/api/handler/request_body_limit_test.go` asserts on **bytes
consumed from the body** (a counting reader, `:87`), not on a status code alone,
and enumerates all six v1 sites by name. `apps/relay/internal/validation/mailbox_envelope_size_test.go`
pins all three rejection shapes plus the accepted consistent case. Neither test
was loosened; both predate their implementations by mtime
(`request_body_limit_test.go` 17:16:02 < `request_body.go` 18:06:40;
`mailbox_envelope_size_test.go` 17:16 < `validate.go` 17:26).

---

## F-007 — identity-scoped mailbox authorization → `fixed`

### No global device-UUID scan remains

`GetByDeviceID` no longer exists in the tree. `keryx ctx rg "GetByDeviceID|candidate\.DeviceID|deviceRecordPrefix|NewIterator" --glob "apps/**/*.go"`
returns one remaining `device_record:` prefix iteration, at
`device_record_repo.go:129-133`, and it belongs to `BackfillDeviceMailboxBindings`
— a startup index-derivation pass, not an authorization path. The only remaining
mention of the old method is a comment in the RED test at
`mailbox_device_authorization_test.go:17`.

Authorization now runs `mailbox_handler.go:359-375` →
`device_record_service.go:24` → `device_record_repo.go:85-120`, which does a
point `txn.Get` on `device_mailbox:<mailbox_id>:<device_id>`, then a point `Get`
on `device_record:<identity_id>:<device_id>` using the identity the binding
returned. No iteration, no first-match. All three consumers (challenge `:151`,
poll `:222`, ack `:320`) go through the same helper, and
`writeMailboxAuthorizationError` (`:384-391`) collapses "no binding" and
"ownership mismatch" into one indistinguishable 403.

### Immutable, first-writer-wins, and populated by both publication paths

`SaveDeviceMailboxBinding` (`device_record_repo.go:170-185`) does `txn.Get(key)`
and returns early on success, writing only on `badger.ErrKeyNotFound` — first
writer wins, no rebind. Both writers call it inside the publication transaction:

- **v1** — `DeviceRecordRepository.Save:49-54` writes the record and the binding
  in one `db.Update`, with bounded conflict retry.
- **v2** — `saveSignalV2Authorization:91` (record already present, re-asserted)
  and `:103` (first write), both inside the caller's publish transaction.

### Can an attacker pre-empt a binding for a mailbox it does not own?

**No, and the reason is structural rather than procedural.** The binding key is
built as `deviceMailboxBindingKey(cryptoutil.DeriveMailboxID(record.IdentityID), record.DeviceID)`
(`device_record_repo.go:175`) — the mailbox half is *derived from the record's own
identity*, never from a request field. `DeriveMailboxID` is
`SHA-256(identity_pubkey + ":mailbox:v1")` (`cryptoutil/signatures.go:14-17`), so
`mailbox_id` determines `identity_id` up to a SHA-256 collision. First-writer-wins
can therefore only ever bind a mailbox to the single identity whose hash that
mailbox is; a foreign identity cannot occupy the slot at all, in either write
order.

Reaching that slot at all requires owning the identity's root key:

- v1: `validation/validate.go:27` verifies the record's canonical-JSON signature
  with `record.IdentityID` **as the public key**, so `identity_id` is the
  ed25519 root public key and a record under a victim's identity cannot be
  forged.
- v2: `validation/signal_prekey_bundle_v2.go:227` verifies the same root
  signature over the embedded device record before the bundle is accepted, and
  `:232` additionally verifies the transcript under `device_pubkey`.

So the first-writer-wins denial-of-service the orchestrator asked about does not
exist here, and the stronger attack it would imply — an attacker binding their
own device key into the victim's mailbox and then polling it — is blocked one
layer earlier by root-signature verification. The defence-in-depth comparison at
`mailbox_handler.go:370` is genuinely redundant, as its comment claims.

Key rotation still works: `Save` overwrites `device_record:<identity>:<device>`
under the owner's own signature while the binding, which points at the identity
rather than at a key, is unchanged.

### Test integrity for this finding

`mailbox_device_authorization_test.go` deterministically orders the two identities
so the unrelated one sorts first in the `device_record:` key space (`:44-49`),
exercises challenge + poll + ack for the legitimate owner, and asserts the
unrelated identity still gets 403 (`:142`). It is a real reproduction, not a
weakened one, and predates `device_record_repo.go` (17:15:41 < 17:25:50).

---

## Secret-leakage audit → no leakage found

Surfaces enumerated with `keryx ctx rg "console\.|process\.stderr|process\.stdout|slog\.|log\.|fmt\.Print"`
over `apps/**` and `packages/**` excluding tests.

**Relay.** Four `slog` call sites reach the new code: `router.go:40` (backfill
failure), `middleware/recover.go:12` (panic), `storage.go:20` (data dir),
`cleanup_service.go:38-45` (counters only). `router.go:40` logs a Badger or
`encoding/json` error — Go's JSON errors carry offsets and type names, not
document content — and the values it iterates are device records, which contain
only public keys. Poll byte-budget selection (`mailbox_repo.go:153-213`) logs
nothing at all; it consumes `len(val)` and never materialises the value outside
the badger callback. Handler error paths write fixed literal codes and messages;
`v2Error` (`signal_prekey_bundle_v2.go:11-29`) writes the sentinel error's own
name as both code and message and never `err.Error()` of an arbitrary error.

**CLI.** Exactly three write sites (`cli.ts:192`, `:223`, `:334`).
`writeResult` emits `{ok:false,error:{code}}` — the *code* only, never
`error.message`, never a stack, never the offending argument. Every code that can
reach it is a fixed literal: `CliFailure` codes, `ConfigurationError.code`
(`config.ts:4`, a literal), `ProfileError.code`, `PersistenceError.code`, and the
`OutboundError`/`InboundError` code constants. `printIdentifiers` (`:223`) writes
`identity_id`, `device_id`, `device_pubkey`, `signal_identity_key` to stderr —
all public, and required by the specification's contact-import contract
("shows the exact `identity_id`, `device_id`, `device_pubkey`, and
`signal_identity_key` before trust is recorded").

**F-001, the persisted publication bundle.** `profile.ts:26` stores it under
`cli:publication` inside the `EncryptedSqliteStore`, i.e. in the same AES-256-GCM
snapshot as the identity seed (`EncryptedSqliteStore.ts:113-123`). Its contents
are public bundle material — public prekeys, the device record, signatures — and
`publicationBundle()`/`rotatePublicationBundle()` return it only to
`RelayClient.publishBundle`. Nothing prints it.

**F-009, the poll byte budget.** `relayClient.ts:96` discards the response and
throws `RelayError("INVALID_RELAY_RESPONSE")` on over-limit without retaining or
rendering the bytes; `RelayError`'s message is its code (`:6`). `inbound.ts`
returns `{received: n}` from `poll()` — a count.

**Store boundary.** `EncryptedSqliteStore` errors are fixed literals; the key is
zeroed on close and on constructor failure (`:38`, `:55`), plaintext buffers are
zeroed in `finally` (`:110`, `:122`), and `readStoreKey` zeroes its intermediate
buffer on both paths (`config.ts:38`, `:42`).

The one path that renders plaintext at all is `history`, which returns decrypted
bodies on stdout as the command's documented product. That is the command, not a
leak; the dash-option suite asserts the complementary property that stderr never
carries it (`cli.dashOptionValues.test.ts:299`).

---

## Exit-code integrity audit → contract intact

Specification (`specification.md:74`): 0 success, 2 input/configuration, 3
trust/protocol, 4 temporary relay/network, 5 local persistence.

`cli.ts:11` types `ExitCode` as the closed union `2 | 3 | 4 | 5`; `main()` returns
0 on success (`:342`) and `failure.exitCode` otherwise (`:346`). No sixth code can
be produced. `classify` (`:323-331`) is total:

| Input | Code | Exit |
|---|---|---|
| `CliFailure` | as constructed | 2 / 3 / 5 |
| `PersistenceError` | `PERSISTENCE_FAILURE` | **5** (the F-003 path) |
| `ConfigurationError` | `INVALID_CONFIGURATION` | 2 |
| `RelayError` retryable / not | `RELAY_UNAVAILABLE` / `PROTOCOL_REJECTED` | 4 / 3 |
| `OutboundError` `INVALID_MESSAGE` / other | own code | 2 / 3 |
| `InboundError`, `ProfileError` | own code | 3 |
| anything else | `PERSISTENCE_FAILURE` | 5 |

The exit-5 path is genuinely new and genuinely narrow: `PersistenceError` is
raised only at `profile.ts:76-85`, which rethrows the operation's own error
untouched when `Object.is` identifies it, and substitutes `PersistenceError` only
when the failure came from the store itself. Typed validation, trust and native
decrypt rejections therefore keep their own types and their exit 3 —
`outbound.ts:27` and `inbound.ts:24` both let `PersistenceError` pass through
their `OUTBOUND_REJECTED`/`INBOUND_REJECTED` wrappers, which is what F-003 asked
for. The unhandled-rejection handler at `cli.ts:350-353` also lands on 5, which
keeps the process from ever exiting 1.

**A rejected argument value is never echoed.** `parseCommand` throws
`inputFailure()` with the literal `INVALID_ARGUMENTS` and discards the
`parseArgs` exception entirely (`cli.ts:108`, bare `catch`). The parser's own
message, which does contain the offending token, never leaves that block.

Neither F-003 nor F-013 widened or narrowed the *set* of codes. One behavioural
change in what counts as a valid argument is recorded below.

---

## Findings

### [R-001] `--<string option>` now consumes a following flag token as its value

- **Severity**: minor · does **not** block acceptance
- **File**: `apps/cli/src/commands/cli.ts:89-102` (docstring claim at `:77-84`)
- **Attack vector**: none — this is not attacker-reachable; it is a local
  usability and exit-code-surface change, reported because the exit-code audit is
  in scope.
- **Problem**: `inlineStringOptionValues` rewrites `--opt value` into
  `--opt=value` for every declared string option whenever the next argument
  exists and is not `--`. Bounded probe against `node:util.parseArgs`
  (v26.5.0): `["--text","--json"]` raises `ERR_PARSE_ARGS_INVALID_OPTION_VALUE`
  while `["--text=--json"]` yields `text: "--json"`. So
  `echolet send --profile p --to X --text --json` previously exited 2
  `INVALID_ARGUMENTS` and now exits 0, having silently consumed the user's
  `--json` flag as the message body. The docstring's claim that "everything
  `parseArgs` and `parseCommand` reject today keeps reaching them unchanged" is
  therefore not accurate for this class.
- **Why it matters**: a mistyped invocation now succeeds and sends unintended
  content instead of failing closed. Impact is bounded in practice: `values.json`
  is never read (output is always JSON), a missing value at the end of the
  argument list still fails closed, and `cli.dashOptionValues.test.ts:286` pins
  this exact behaviour deliberately — it is the standard GNU/POSIX
  option-argument convention and the unavoidable cost of supporting base64url
  values that begin with `-`.
- **Fix**: no code change required. Correct the docstring at `cli.ts:77-84` to
  state the trade-off explicitly: a declared string option consumes the next
  token unconditionally, so `--<string option> --<flag>` is a value, not an
  error.

### [R-002] `ProfileError` maps to exit 5 inside `openProfile` and to exit 3 elsewhere

- **Severity**: info (pre-existing shape, not introduced by this wave)
- **File**: `apps/cli/src/commands/cli.ts:158-161`, `:247-250`, `:284-285`,
  `:293-294`, `:302-303`, `:309-310` vs `cli.ts:329`
- **Problem**: `ProfileError` raised inside `openProfile` — "Profile database is
  missing; refusing replacement" (`profile.ts:217`), "Incomplete profile"
  (`:222`), "Database belongs to another profile" (`:229`) — is caught and
  converted to `persistenceFailure()` / exit 5, while the same class raised from
  a `Profile` method reaches `classify` and becomes exit 3.
- **Why it matters**: only diagnostic precision. All of these are local-store
  conditions, so 5 is defensible; the inconsistency is worth knowing when reading
  exit codes in the field. `classify`'s trailing `return persistenceFailure()`
  makes exit 5 the residual bucket for any error that escapes the typed
  boundaries.
- **Fix**: none required for the prototype. If tightened later, decide once
  whether a profile-identity mismatch is 2, 3 or 5 and apply it at both sites.

### [R-003] `maxMessageBytes <= 0` is handled inconsistently between the body bound and validation

- **Severity**: info · fail-closed
- **File**: `apps/relay/internal/api/handler/mailbox_handler.go:67-73` vs `:86`
- **Problem**: `envelopeBodyLimit()` substitutes `defaultMaxMessageBytes`
  (262144) when the handler was constructed with a non-positive maximum, but
  `ValidateMailboxEnvelope` is handed the raw `h.maxMessageBytes` at `:86`. With
  a zero maximum the route accepts a ~326 KiB body and then rejects every
  envelope, since `actualCiphertextBytes > 0` always exceeds it.
- **Why it matters**: unreachable through `NewRouter` — `config.go:13` gives
  `MaxMessageBytes` an `envDefault` of 262144 — and the failure is closed, not
  open. It only bites a handler constructed directly, as several tests do.
- **Fix**: resolve the default once (a `maxMessageBytes()` accessor) and use it
  at both sites.

### [R-004] `BackfillDeviceMailboxBindings` re-scans and buffers every device record at every start

- **Severity**: info (this is worker concern **T34-I-001**, dispositioned)
- **File**: `apps/relay/internal/storage/repository/device_record_repo.go:125-165`,
  invoked from `apps/relay/internal/api/router/router.go:39`
- **Problem**: the pass reads the whole `device_record:*` key space into a
  `pending` slice before writing, with no completion marker, so startup cost and
  peak memory grow linearly with the number of published devices. Publication is
  unauthenticated apart from owning *some* identity, so the key space is
  attacker-inflatable (rate-limited at `RateLimitPerMinute`, default 120/min).
- **Why it matters**: correctness is fine — the binding is a pure function of the
  record, so re-running is idempotent and cannot rebind anything (see F-007
  above), and a failure is logged rather than fatal (`router.go:39-41`). This is
  a startup-time cost, acceptable at prototype scale.
- **Fix**: none required now. If it ever matters, stream the write inside the
  iteration instead of buffering, and record a completion marker keyed by the
  binding schema version.

### [R-005] The relay's poll byte budget and `ECHOLET_MAX_MESSAGE_BYTES` are still independent

- **Severity**: info (this is worker concern **T35-I-001**, dispositioned;
  unreachable at defaults)
- **File**: `apps/relay/internal/api/handler/mailbox_handler.go:52`,
  `apps/relay/internal/storage/repository/mailbox_repo.go:190`,
  `apps/cli/src/transport/relayClient.ts:96`
- **Problem**: `pollEnvelopeByteBudget` is the fixed constant `1 MiB − 4 KiB`,
  and the first envelope of a batch is deliberately exempt from it
  (`mailbox_repo.go:190` requires `len(batch.Envelopes) > 0`). The exemption is
  the right call — otherwise a maximum-size envelope would wedge the mailbox
  forever — but it means that if `ECHOLET_MAX_MESSAGE_BYTES` is raised above
  ~1 MiB, a single stored envelope produces a response the CLI's hard 1 MiB bound
  refuses, and that mailbox cannot drain. `mailbox_poll_capacity_test.go:202`
  configures exactly that maximum (2 MiB) for the send-path assertion, which
  shows the state is constructible.
- **Why it matters**: unreachable at the shipped default of 262144, where the
  worst single envelope is ~256 KiB against a ~1020 KiB budget.
- **Fix**: derive `pollEnvelopeByteBudget` from a shared limits constant, or
  refuse to start when `MaxMessageBytes + wrapper > ` the client bound.

---

## Non-negotiable criteria

1. **No test weakened** — *met for the reviewed code*. `request_body_limit_test.go`,
   `mailbox_envelope_size_test.go`, `mailbox_device_authorization_test.go`,
   `mailbox_poll_capacity_test.go` and `cli.dashOptionValues.test.ts` all assert
   on the mechanism (bytes consumed, rejection code, poll progress, verbatim
   value delivery), not on a weaker proxy; none contains a `t.Skip`, `.skip`,
   `.only` or `.todo` (`keryx ctx rg` over all test globs returned zero matches
   repo-wide). Every one of them has an mtime earlier than the implementation
   file it constrains — e.g. `request_body_limit_test.go` 17:16:02 <
   `request_body.go` 18:06:40; `mailbox_device_authorization_test.go` 17:15:41 <
   `device_record_repo.go` 17:25:50; `cli.dashOptionValues.test.ts` 18:45:37 <
   `cli.ts` 18:53:26. `cli.dashOptionValues.test.ts:303-377` additionally carries
   an explicit over-correction guard: unknown flags, missing values, repeats,
   disallowed options and post-`--` operands must all still exit 2.
2. **No strict schema loosened** — *met*. `next_cursor` is
   `z.union([z.string().min(1).max(256), z.null()])` on a `.strict()` object,
   with no `.optional()`, no `.passthrough()` and no `any`
   (`relayClient.ts:24`, `:66`). Go always emits the key — the response map at
   `mailbox_handler.go:274-280` includes it unconditionally, as a `*string` that
   is either `nil` or the fixed server-controlled token `"more"`
   (`mailbox_handler.go:62`, `:266-270`) — so the closed union and the wire
   agree, and an omitted field would be rejected rather than silently accepted.
   The token is a compile-time constant, never derived from envelope data, so a
   sender cannot influence its size. Unknown fields are still rejected on both
   sides: `.strict()` throughout `relayClient.ts`, and `decodeV2Request`
   (`signal_prekey_bundle_v2.go:30-74`) still rejects unknown keys, duplicate
   keys and trailing content on the v2 surface.
3. **No secret leakage** — *met*. See the audit above.
4. **Exit-code contract intact** — *met*. See the audit above. R-001 records the
   one behavioural change in what counts as a valid argument.
5. **Prototype scope respected** — *met*. No finding here demands production
   hardening, mobile support, deployment or external audit. R-004 and R-005 are
   explicitly dispositioned as acceptable at prototype scale.

## Worker concerns dispositioned here

| ID | Disposition |
|---|---|
| `T34-I-001` | Accepted — R-004. Idempotent and structurally incapable of misbinding; startup cost only. |
| `T34-I-003` | Resolved — the send body bound is now derived (`mailbox_handler.go:67-73`); the derivation is sound. |
| `T35-I-001` | Accepted — R-005. Unreachable at defaults. |
| `T39-Q1` | Adequate. The dash-leading `--to` test proves the value reaches the trust layer verbatim by comparing against the dash-stripped control run (`cli.dashOptionValues.test.ts:227-230`), and the flag-shaped `--text` case proves end-to-end success plus verbatim round-trip through history (`:285-298`). Since `identity_id` is a hash of a generated key, that pairing is the strongest deterministic boundary available. |

## Routing audit

- `graph_used`: no — *not-relevant*. The dispatch named the file set and the T28
  `class_scope` entries enumerate the sites; class closure was re-derived with
  `keryx ctx rg` rather than from the graph, and the working tree is untracked so
  a graph built before this wave would predate every change under review.
- `wiki_used`: no — *not-relevant*. The authoritative contract for this review is
  `docs/requirements/echolet-cli-prototype/specification.md`, named by the
  dispatch and read directly.
- `ctx_used`: yes — all searches through `keryx ctx rg`; all command output and
  large listings through `keryx ctx run`.
- `raw_rg_used`: no.
