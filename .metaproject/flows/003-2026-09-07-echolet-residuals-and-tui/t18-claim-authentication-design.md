# T18 — authenticating `POST /v2/prekeys/claim`

Flow 003, task T18. **Design only.** No source, test, schema or documentation file outside this
deliverable and its dispatch result was created, edited or deleted. No connection was made to
`geekom` or `depr`. No store key, private key, plaintext or HTTP request body is printed or recorded
below.

Measured against tree `c5fde09`, clean apart from `journal.md`. Every measurement ran against the
**real relay binary** built from that tree
(`sha256 f60b1570c4ac7c0631c8916b15abcc97abab42f0b94d98e3c3afbacf697ecca4`) on Node v26.5.0, on
loopback, with throwaway data directories under the session scratchpad. The probe scripts live in
the scratchpad and were never written into the repository.

Everything labelled **Measured** was run. Everything labelled **Inferred** was read off the tree and
reasoned about, and says so.

---

## 0. The answer in three sentences

Make `/v2/prekeys/claim` require the claimant to be an identity the relay already holds a published,
root-signed `DeviceRecord` for — the exact predicate `/v1/messages/send` already applies to a
depositor — by adding `claimant_identity_id`, `claimant_device_id` and `claimant_signature` to the
request and verifying that signature over a new versioned transcript
`echolet-prekey-claim:v1:<claim_id>:<identity_id>:<device_id|"">:<claimant_identity_id>:<claimant_device_id>`
built byte-identically in TypeScript and Go, before the claim transaction runs. This is a
**consistency and attribution** fix, not a cost fix: it deletes the class of attacker who holds no
key material at all, and it makes every consumed bundle attributable to a relay-resolvable identity,
but it raises an attacker's measured price per destroyed first-contact bundle from one HTTP request
to one HTTP request, because minting a fresh publishable identity costs **2.9 ms and one
unauthenticated POST**. The denial-of-first-contact class therefore stays open, and this design says
so in the words the brief asked for: **free identity creation is a documented open limitation, and
this design merely moves the cost.**

---

## 1. The hole, measured end to end

Two profiles on a throwaway relay, one victim (`bob`), one legitimate published first-contact sender
(`alice`). A third party with no profile, no key material, no publication and no session issues one
raw POST knowing only bob's `identity_id` — the value bob hands out in his own contact card.

```
M1 bob relay publish        -> claimable=true
M2 alice relay publish      -> claimable=true
M3 stranger raw claim       -> http=200 ok=true hasBundle=true elapsedMs=5
M4 bob relay publish again  -> claimable=false
M5 published alice send     -> exit=3 code=PREKEY_BUNDLE_UNAVAILABLE
```

**Measured.** One request, 5 ms, no key material. Bob's only first-contact bundle is permanently
consumed (M4), and alice — a properly published sender who did everything right — can no longer make
first contact with him (M5). Bob has no command that restores it: `relay publish` re-submits the
identical stored bundle and reports `claimable: false`, and `rotateBundle()` is deliberately
unreachable behind the frozen eight-command surface (`specification.md:118`).

The asymmetry in one line: the same stranger's **deposit** is refused `403
UNAUTHORIZED_MAILBOX_ACCESS` (T50, `mailbox_handler.go:199`), while their **claim** returns 200 with
the bundle. The relay grants, unauthenticated, a capability whose only legitimate use it would
refuse one request later.

### 1.1 The ceiling that exists today

```
W4 200 claims from one source -> reached_handler=116 rate_limited=84 in 344 ms
```

**Measured** at the shipped default `ECHOLET_RATE_LIMIT_PER_MINUTE=120`, on a fresh relay whose
bucket had already spent four requests on readiness and earlier probes — 116 is exactly the
remainder. The limiter is global across every route and keyed on the transport peer host
(`middleware/rate_limit.go`, `quotaKey`). So from one source address the current price of the attack
is **up to 120 permanently destroyed first-contact bundles per minute**, 172 800 per day, each one
irreversible for the victim.

---

## 2. The design

### 2.1 The predicate

The claimant must resolve through the immutable `(mailbox identity, device UUID)` binding, exactly as
a depositor does:

```
authorizeMailboxDevice(DeriveMailboxID(claimant_identity_id), claimant_device_id)
```

That binding is written by `SaveDeviceMailboxBinding` from **both** publication routes:
`/v1/device-records/publish` (`device_record_repo.go:42`) and, transitively, `/v2/prekeys/publish`
through `saveSignalV2Authorization` (`signal_prekey_bundle_v2.go:99`). So a CLI profile that has run
`relay publish` is already resolvable — no new client step, no new stored state, no new key.

**Inferred from the tree, then measured:** a synthetic identity minted from nothing and published
through `/v1/device-records/publish` satisfies the identical predicate at
`/v1/mailbox/challenge` — `authorizeMailboxDevice` plus a device-key signature over a fixed
transcript, which is precisely the pair this design adds to the claim route:

```
N1 mint+publish one identity     -> http=200 stored=true elapsedMs=17
N2 minted identity authenticates -> http=200 ok=true code=none
```

### 2.2 The transcript

New, versioned, pinned literally in both languages, following the rule
`packages/crypto-core/src/mailbox/auth.ts` states for every other transcript on this wire ("change it
only by minting a new version prefix in both languages together"):

```
echolet-prekey-claim:v1:<claim_id>:<identity_id>:<device_id or "">:<claimant_identity_id>:<claimant_device_id>
```

Field by field, and why each is inside the signature:

| Bound field | Why it must be signed |
|---|---|
| `claim_id` | It is the idempotency key. Unsigned, a signature captured from one claim authorises an unlimited number of *new* consumptions under fresh ids. |
| `identity_id` | The victim. Unsigned, one captured signature destroys every recipient's bundle, not one. |
| `device_id` selector | It decides *which* of a multi-device recipient's bundles is consumed. |
| `claimant_identity_id` | Names who is spending it. This is the whole attribution property. |
| `claimant_device_id` | The other half of the binding the verification key is resolved through; without it the signature says nothing about which of the identity's devices acted. |

`device_id` is `uuid | null` on the wire and the decoder **requires the key to be present**, so
"absent" and "null" are not distinguishable states here and one version suffices. `null` encodes as
the empty string, which is not a valid UUID, so the encoding is unambiguous. This is deliberately
*not* the two-version pattern `createMailboxAckMessage` uses: there the field is genuinely optional
on the wire, here it is not.

**No nonce and no timestamp, on purpose.** A replayed signed claim carries a `claim_id` the relay has
already bound, so `ClaimSignalV2` replays the stored bundle and consumes nothing new
(`signal_prekey_bundle_v2.go:139-151`). Freshness buys nothing, and omitting it preserves two
existing guarantees exactly: ed25519 is deterministic, so an exact retry of an ambiguous claim is
byte-identical including the signature (AC-02b, and the same argument `specification.md:128` makes
for the envelope signature), and nothing in the transcript depends on a clock the two sides must
agree on.

### 2.3 The wire

Request grows from three fields to six. Both sides stay closed and strict.

| Field | Shape | Side |
|---|---|---|
| `claim_id` | uuid | unchanged |
| `identity_id` | base64url, 32 bytes | unchanged |
| `device_id` | uuid \| null | unchanged |
| `claimant_identity_id` | base64url, 32 bytes — same `$defs/base64url32` as `identity_id` | new |
| `claimant_device_id` | uuid | new |
| `claimant_signature` | base64url ed25519 signature, **≤ 256 bytes** | new |

256 is not a new number: it is `maxSenderSignatureBytes` (`mailbox_handler.go:184`), which is itself
`validation.MaxIdentifierBytes` and the client's own `z.string().min(1).max(256)` slot. Reusing it
keeps one bound meaning one thing. The added fields cost well under 200 bytes against the route's
existing 64 KiB body cap (`decodeV2Request`), so no limit moves.

The **response does not change at all** — still `{"ok":true,"data":{"bundle":…}}` with the stored
bytes served back unmodified, still written without re-encoding so exact replay survives.

### 2.4 Where the check runs, and in what order

In `ClaimSignalPreKeyBundleV2` (`handler/signal_prekey_bundle_v2.go:101`):

1. decode and shape-check the request (existing);
2. `ValidateSignalSelector` (existing) — a malformed selector keeps answering with the rule it
   violated;
3. bound `claimant_signature` at 256 bytes → `400 INVALID_SCHEMA`;
4. resolve the claimant through `authorizeMailboxDevice` → on miss, `403
   UNAUTHORIZED_MAILBOX_ACCESS` with the deposit route's own message ("sender device record is not
   published; publish it before sending");
5. `cryptoutil.VerifyMessageSignature(transcript, claimant_signature, record.DevicePubKey)` → on
   failure, `403 INVALID_SIGNATURE`;
6. **only then** `service.ClaimSignalPreKeyBundleV2`.

Step 6 last is the entire security property, and it is the same ordering rule
`SendEnvelope` already states for the store: authenticate before the irreversible step, so a caller
the relay cannot authenticate never consumes a byte of somebody else's scarce key material.

### 2.5 Codes, and what the operator sees

**No allowlist on either side needs to change.** `UNAUTHORIZED_MAILBOX_ACCESS` is already in
`relayClient.ts`'s `remoteCodes` and in `cli.ts`'s `reportedRelayCodes` (`cli.ts:57`), so a claim
refused for a missing publication reaches the operator as
`{"ok":false,"error":{"code":"UNAUTHORIZED_MAILBOX_ACCESS"}}` at exit 3 — the same code, the same
exit, the same meaning the deposit route already gives that condition. `INVALID_SIGNATURE` is
deliberately *not* added to either allowlist: a claimant whose own signature does not verify is a
client defect, and `PROTOCOL_REJECTED` at exit 3 is the honest report for it.

### 2.6 One implementation constraint worth naming now

`decodeV2Request` consumes `r.Body`. A handler that tries the six-field required set and then
"falls back" by decoding a second time reads an empty body and answers `INVALID_SCHEMA` for every
legacy request. The decoder must therefore grow a single call that takes a required set **and** an
optional set and reports which optional keys were present. A naive two-decode implementation passes
every unit test written against a fake and fails only against the real binary — which is why test
group 3 below runs at handler level with a real request body.

Second constraint: `authorizeMailboxDevice` is currently a method on `MailboxHandler`, and
`PreKeyBundleHandler` holds no `DeviceRecordService`. One predicate must not become two. Extract it
(to `service.DeviceRecordService` or a package-level helper both handlers call) and pass
`deviceRecordSvc` into `NewPreKeyBundleHandler` from `router.go:73`.

---

## 3. What it costs an attacker: before and after, with numbers

| | Before | After |
|---|---|---|
| Key material needed | **none** | 2 ed25519 keypairs |
| Requests, first victim | 1 | 2 |
| Requests, each further victim | 1 | **1** |
| Measured setup cost | 0 | **2.9 ms** per identity, one unauthenticated POST |
| Victims/min from one source at the shipped 120/min limit | **120** | **119** in the first minute, **120** thereafter |
| Victims/min if a per-claimant quota of 16 were added | 120 | **113** |

The minting measurement, run against the real binary:

```
N3 minted 50/50 identities sequentially in 143 ms -> 349.7 identities/s, 2.9 ms each
```

**Stated plainly, as the brief requires: this does not raise the cost. It adds a step.** The step is
one unauthenticated POST to a route (`/v1/device-records/publish`) that requires only a `DeviceRecord`
self-signed by a freshly generated key — `validation.ValidateDeviceRecord` verifies the record
against `record.IdentityID`, which *is* the verification key, so the caller chooses both halves of
its own identity. The relay's own source says as much in a comment at
`validation/validate.go`. The price increase is **0.8 % in the first minute and 0 % thereafter**;
with a per-claimant quota of 16 it is **5.8 %**. Both round to nothing.

### 3.1 What it does buy, stated as capability rather than cost

1. **The keyless attacker class disappears.** Today the capability requires knowing a public
   identity id. After, it requires holding an ed25519 signing key and leaving a durable device record
   on the relay. That is not expensive; it is *different*, and it is the difference between an
   anonymous read-only observer of a contact card and a party that has written attributable state.
2. **Consumption becomes attributable.** Every claim names an identity the relay can resolve. No
   abuse response exists today — no blocklist, no per-claimant accounting, no audit — and none is
   *constructible* while the route is anonymous. This is the precondition for all of them.
3. **It closes T20 residual #4.** T20's client guard refuses a send from a profile that never
   *attempted* publication; it deliberately allows a profile whose publication the relay **rejected**,
   which then spends the recipient's one-time prekey before failing at the deposit. The relay knows
   what the client cannot: whether the record was actually stored. This is the one case only a
   server-side check can cover.
4. **It covers every caller, not just this CLI.** T20's guard is client-side and therefore not a
   security control at all — measurement M3 above is a raw `fetch`, not the CLI. A control that any
   caller can decline to run is a courtesy.
5. **It removes the "one bundle, one sender, and the sender need not be a sender" property** that the
   threat model's §6.3 risk ("нехватка one-time prekeys") depends on.

---

## 4. What it breaks for a genuine first-contact sender

A first-contact sender by definition has no session with the recipient. The check is on the
claimant's **own** publication, never on any relationship with the recipient, so that property is
untouched. Enumerated, exhaustively:

| Change | Verdict |
|---|---|
| `send` now requires a prior `relay publish` **at the relay** as well as locally | Not new. `/v1/messages/send` has required it since T50, and the CLI has refused locally since T20 (`SENDER_NOT_PUBLISHED`). A correct CLI can never reach the new refusal. |
| The claim must be signed with the profile's device key | The same key signs the envelope milliseconds later (`profile.ts:234` `signEnvelopeBinding`). No new key, no new storage, no new derivation path. |
| Publication must precede the claim in time | Already the documented order: `specification.md` message flow step 2 precedes step 3. |
| The claimant must be published **to this relay** | Same as the deposit. Multi-relay is out of scope for this prototype. |
| A profile whose publish response was *lost* | Still works. The relay stored the record; the client's uncertainty is irrelevant to the relay's answer. |
| A profile whose publish was *rejected* | Now refused at the claim instead of at the deposit — one request earlier, and without spending the recipient's key. This is the improvement, not a regression. |
| The lost-response claim retry (AC-02b) | Preserved byte-for-byte: the signature is deterministic and covers only fields the retry replays unchanged. |
| Concurrent claims allocating exactly once (AC-02) | Untouched — the check runs entirely before the transaction and changes nothing inside it. |
| Response shape | Unchanged. |

**Nothing a legitimate first-contact sender does today stops working.** That is what makes the change
tractable to test: the observable behaviour of a correct client is identical.

---

## 5. Interaction with the sender-authentication extension and the per-sender quota

**Sender authentication (T50).** Same predicate, same helper, same error code, same ordering rule.
This design deliberately reuses `authorizeMailboxDevice` rather than inventing a second notion of
"a device the relay knows", and reuses `UNAUTHORIZED_MAILBOX_ACCESS` rather than minting a fourth
name for one condition. The two routes then state one rule: *the relay serves a party it has a
published, root-signed device record for.* The transcript is separate and separately versioned,
because a signature over the envelope transcript must never be reusable as a claim and vice versa —
the two strings share no prefix.

**Per-sender quota (T54).** No interaction. The quota counts live unacked envelopes per
`(sender identity, recipient mailbox)` and is evaluated after authentication on the deposit route
only. A claim stores no envelope and occupies no mailbox byte, so it consumes no allowance. **This
design adds no quota to the claim route**, and the reason is measured rather than asserted: a
per-claimant quota of `Q` costs an attacker `1/Q` extra requests per victim — 5.8 % at `Q = 16` — while
permanently breaking a legitimate operator who makes first contact with more than `Q` new people,
with no command that could reset it. The relay's own comment at `mailbox_handler.go:278-283` already
records this exact arithmetic for the deposit route ("a linear price increase, not a structural
fix"), and on the claim route even the linear part is absent because the attacker mints identities in
2.9 ms.

---

## 6. Alternatives, and why each is rejected

### 6.1 Rate-limit claims per source address — rejected: it already exists, and it is the real bound

`middleware.RateLimiter` allows 120 requests/minute per transport peer host across every route
(**measured**, §1.1). It is the only thing standing between an attacker and unbounded destruction
today. It cannot be tightened into a control: it is keyed on the peer address, so a second source
defeats it entirely, and on a proxied or tailnet-fronted deployment it can collapse many honest
clients into one bucket. The real client already needs headroom — the repository's own e2e suites
raise it to 1000/min to run. Keep it as the ambient bound it is; do not mistake it for
authentication.

### 6.2 Rate-limit claims per *victim* identity — rejected: the resource is already bounded at one

A recipient has at most one claimable bundle (`specification.md:118`, **measured** at M4). A
per-victim limit above 1 changes nothing; at 1 it *is* current behaviour. It bounds a quantity that
is already bounded.

### 6.3 Rate-limit claims per *claimant* identity — rejected as a cost control, kept as a follow-on

Only constructible **after** this design lands, which makes it a consequence, not an alternative.
Priced above: 5.8 % at `Q = 16`, against a real risk of permanently silencing a sociable operator.
Worth revisiting only once identity creation costs something.

### 6.4 Make bundles replenish automatically — rejected here, but it is the better fix and should be a task

The relay **cannot** mint one-time prekeys: only the recipient holds the private half, and
`SaveSignalV2` permanently tombstones both `(identity, device, signal identity, key_id)` and the
public key, so a re-publish can never restore availability (**measured** at M4, and T12 §3 measured
the converse — an independently signed bundle with a *fresh* one-time prekey publishes and becomes
claimable). Replenishment is therefore not a relay capability at all; it is a client one.

What blocks it is the CLI, not cryptography: `relay publish` resubmits the one stored bundle, and
`rotateBundle()` — which exists, is tested, and has full relay support — is unreachable behind the
frozen eight-command surface. Maintaining a pool of `N` claimable bundles would need no ninth
command, only a changed meaning for an existing one.

**Honest comparison.** A pool of `N` raises the attacker's per-victim price *linearly*: `N` requests
instead of one, i.e. `120/N` victims per minute instead of 120. At `N = 8` that is a **8× price
increase**, against this design's **1.0×**. It also gives the victim a recovery path through a
command that already exists. On the cost axis it is strictly better than authentication.

It is rejected *as this task's deliverable*, not on its merits, for three reasons that are about
scope rather than preference: it does not close the asymmetry (an anonymous stranger still drains the
pool, just `N` times over); it contradicts assertions that currently pin `bundleId` stable across
republish (`test/e2e/publication-claimability.test.ts` step 2) and the specification's "a published
bundle serves exactly one first-contact sender"; and it is a client-side change to a frozen surface's
semantics, which is a product decision above a relay-authentication task. **Recommendation: file it as
the companion task.** The two are complementary — authentication decides *who may spend*, a pool
decides *how much there is to spend* — and only the pool actually helps the victim.

### 6.5 Proof of work on the claim — rejected: it cannot bite where the attacker actually is

The attacker is bounded at 120 requests/minute by the limiter, not by CPU. A puzzle cheap enough for
an honest CLI on a laptop (say ≤ 100 ms) costs an attacker 100 ms × 120/min = **20 % of one core** to
sustain the maximum rate the limiter permits — the entire extractable price, and it is negligible. It
also requires a difficulty parameter negotiated on the wire, which contradicts the stated principle
that every schema here is closed and agreed in advance rather than negotiated
(`relayClient.ts`, the `MAX_MESSAGE_BYTES` comment: "the relay is the adversary-adjacent component").
New wire contract, new failure mode, new tuning knob, no measurable gain.

### 6.6 Bind the claim to the deposit, so an unused claim expires — rejected: it risks an undecryptable message

This becomes *thinkable* only after this design lands, because the relay must know who claimed. Its
one real merit is significant and should not be waved away: it is the only option that restores the
victim **without a new command and without the recipient acting**.

It is rejected because making a consumed one-time prekey available again can hand the same OTPK to
two senders, and in X3DH the recipient's store consumes the private half exactly once — the second
sender's `PreKeySignalMessage` then fails to decrypt **permanently and silently**. Turning a denial of
first contact into an undecryptable message is a worse outcome, not a better one. Enforcement would
have to be airtight across relay restart, Badger compaction, and a deposit racing the expiry, and the
relay explicitly cannot know that a sender will not deliver later: the sender's durable outbox holds
the exact ciphertext indefinitely, and AC-05 *requires* that late retry to succeed. `prekey_bundle_v2_test.go`'s
existing guards forbid re-offering, and T12 §2 records them as the standing guard against precisely
this shape of "fix". It also would not raise the attacker's cost — it converts a one-shot permanent
denial into a sustained one at roughly one request per victim per expiry window, which at 120 req/min
holds thousands of victims hostage for free.

### 6.7 Make claims reservations that expire rather than consumptions — rejected, same class

The same OTPK-reuse hazard, plus one more: a reservation would have to survive restart to be safe,
while prototype retention is deliberately indefinite and unbounded (`specification.md:120`) precisely
so restart behaviour is deterministic. Adding a timed state to that store trades a determinism
property the prototype relies on for a cost reduction §6.6 already shows to be zero.

---

## 7. What this does NOT close

**Free identity creation is a documented open limitation; this design merely moves the cost.**
Measured: 2.9 ms and one unauthenticated POST per publishable identity, 350 per second sequentially
from one process on loopback. The denial-of-first-contact class stays open. An attacker who mints one
identity destroys first-contact bundles at the same 120/min the rate limiter already permits.

This is the identical residue the sender quota left on the deposit route, which the relay's own
source states in the same terms (`mailbox_handler.go:278-283`: "`POST /v1/device-records/publish` is
unauthenticated, so an attacker mints another identity for the cost of one request"). It stays open
here for the same reason and should be recorded next to it, not as a new finding.

Also not closed, and each belongs elsewhere:

- The recipient still has **no command to replenish** a consumed bundle. §6.4 is the fix and it is a
  separate task.
- `/v1/device-records/publish` and `/v1/prekeys/publish` and `/v2/prekeys/publish` remain
  unauthenticated by construction — a self-signed record is the only thing they can verify against,
  since the identity id *is* the key.
- A malicious relay operator is unaffected: they hold the bundles and can refuse or serve them at
  will. This changes what a *third party* can do through the API, nothing about §4.3 of the threat
  model.
- Nothing here bounds a claimant who is a legitimate contact and simply claims maliciously. That is
  §4.4 Malicious Contact and is out of scope.

---

## 8. Effect on the deployed relays — read this before shipping

`geekom` and `depr` run the current protocol on their tailnet addresses with real TLS. **Measured**
against the binary built from this tree:

```
V1 contracted 3 fields    -> {"status":404,"code":"PREKEY_BUNDLE_UNAVAILABLE"}
V2 device_id omitted      -> {"status":400,"code":"INVALID_SCHEMA"}
V3 one extra field        -> {"status":400,"code":"INVALID_SCHEMA"}
V4 extra field on publish -> {"status":400,"code":"INVALID_SCHEMA"}
```

The v2 decoder is **exactly closed**: every contracted key is required and no additional key is
tolerated (`decodeV2Request` refuses an unknown key and refuses `len(fields) != len(required)`). So:

- **A client carrying the new fields is refused `400 INVALID_SCHEMA` by `geekom` and `depr` as they
  run today** (V3). Through `classify()` that reaches the operator as `PROTOCOL_REJECTED` at exit 3 —
  `INVALID_SCHEMA` is not in `remoteCodes`, so the diagnosis is lost. There is no additive rollout on
  this route.
- **A relay that requires the new fields refuses every client that predates the change**, with the
  same code and the same lost diagnosis.

**Therefore the design ships with a mode switch and a strict order.** One boolean,
`ECHOLET_REQUIRE_CLAIM_AUTH`, defaulting to **off**:

| Mode | 3-field claim | 6-field claim |
|---|---|---|
| off (default) | accepted, as today | accepted, **and the signature is still verified** — permissive means "unsigned is tolerated", never "signatures are ignored" |
| on | **refused `400 INVALID_SCHEMA`, nothing consumed** | accepted after authentication |

Rollout: deploy the relay to `geekom` and `depr` with the flag **off** — at which point their
observable behaviour is unchanged and no client breaks — then upgrade every client that uses them,
then flip the flag. Never in the other order. The flag is a migration device and its removal should
be filed as a follow-up the moment both relays are enforcing, so the permissive branch does not
become permanent.

**Answering the constraint directly: yes, a deployed relay's behaviour changes — but only when the
flag is turned on, and turning it on is the act that closes the hole.** With the flag off, deploying
this change alters nothing an existing client can observe on any route.

---

## 9. Test plan

The repository's method is tests-first by one agent, implementation by another, so every item below
is a RED test that fails on the current tree and is written without reference to an implementation
that does not exist yet. Groups are ordered by dependency: nothing in a later group is meaningful
until the earlier group is pinned.

Three of these must exist **on both sides of the wire**, marked ⇄.

### Group 1 — the transcript (⇄, write first)

Nothing downstream means anything until both languages produce the same bytes.

1. ⇄ **TS**: `createPrekeyClaimMessage` produces the exact `:v1:` string for a shared fixture vector,
   including the `null → ""` device-id encoding, and a different string for a non-null selector.
   *New file* `packages/crypto-core/src/mailbox/prekeyClaim.test.ts`.
2. ⇄ **Go**: `cryptoutil.CreatePreKeyClaimMessage` produces the byte-identical string for the same
   vector. `apps/relay/internal/cryptoutil/signatures_test.go`.
3. ⇄ **Go**: a signature produced by the **TypeScript** signer over that vector verifies with
   `VerifyMessageSignature` against the vector's device public key. A Go-only round trip proves
   nothing about the wire; this is the test that does.
   Shared vector: *new file* `packages/protocol/src/types/fixtures/prekey-claim-v1.json`, read by
   both languages, alongside `relay-v2.json`.

### Group 2 — the refusals (Go, handler level, real request bodies)

Each of 4–7 asserts **two** things: the code the caller was told, **and** that the target's bundle is
still claimable afterwards. The second assertion is the load-bearing one — a code says what the
caller saw, only the relay's own state says what the caller cost somebody else. This is the
discipline `test/e2e/publication-claimability.test.ts` already applies.

4. A 3-field claim with the flag **on** → `400 INVALID_SCHEMA`; target still claimable.
5. A 6-field claim from a claimant the relay holds no device record for → `403
   UNAUTHORIZED_MAILBOX_ACCESS`; target still claimable.
6. Table-driven: a signature made over a transcript with **each** bound field substituted in turn
   (wrong `claim_id`, wrong target `identity_id`, wrong `device_id` selector, wrong
   `claimant_identity_id`, wrong `claimant_device_id`) → `403 INVALID_SIGNATURE`; target still
   claimable. One row per field, because a transcript that silently omits a field is exactly the
   defect that makes the whole signature decorative.
7. A `claimant_signature` over 256 bytes → `400 INVALID_SCHEMA`, refused before any store read.
8. **Ordering.** After a refused claim, retrying that same `claim_id` with a *valid* signature
   succeeds and returns a bundle. If the refused attempt had bound the claim id, this would answer
   `CLAIM_ID_CONFLICT` or replay a bundle. This is how "the refusal happened before the transaction"
   is pinned without reaching into storage.
   *New file* `apps/relay/internal/api/handler/prekey_claim_authentication_test.go`, modelled on
   `mailbox_sender_authentication_test.go`.

### Group 3 — the existing contract must not move (Go)

9. A valid signed claim from a published claimant returns the stored bundle bytes **unmodified**, and
   the response object is shape-identical to today's.
10. AC-02b under the new shape: retrying the identical signed claim (same `claim_id`, same signature
    bytes) returns the same exact bundle. AC-02 under the new shape: 20 concurrent signed claims
    allocate exactly once. These re-pin the two guarantees `prekey_bundle_v2_test.go` owns, at the
    handler level where the new code sits.

### Group 4 — the rollout switch (Go, handler level)

11. Flag **off**: a 3-field claim is accepted exactly as today. This is the test that keeps `geekom`
    and `depr` deployable.
12. Flag **off**: a 6-field claim with a **bad** signature is still refused `403 INVALID_SIGNATURE`.
    Permissive must never mean "signatures are ignored".
13. Flag **on**: covered by test 4; assert here additionally that the flag's default is off, read
    from `config.Config`.

### Group 5 — the client half (TypeScript)

14. ⇄ `relayClient.claimBundle` puts exactly the six contracted fields on the wire under its strict
    schema, and refuses locally — issuing no request — if the claimant fields are missing.
    `apps/cli/src/transport/relayClient.test.ts`.
15. `OutboundMessenger` signs the claim with the same device key that will sign the envelope, through
    a `Profile` method that follows `signEnvelopeBinding`'s boundary (derive inside the transaction,
    use once, zero the key), and the signature is byte-identical across a process restart — the
    deterministic-retry property. Model: `outbound.test.ts`'s "keeps an ambiguous send pending and
    reuses byte-identical IDs".
    *New file* `apps/cli/src/runtime/outbound.claimAuthentication.test.ts`.
16. A relay answering the claim with `403 UNAUTHORIZED_MAILBOX_ACCESS` reaches the operator under
    that code at exit 3, not flattened. This pins that **no** change to `remoteCodes` or
    `reportedRelayCodes` is needed, so a future edit to either is caught.

### Group 6 — the hole, closed, against the real binary (TypeScript e2e, last)

17. ⇄ With the flag **on**: a raw `fetch` issuing the legacy unauthenticated claim — *not* the CLI,
    because the CLI is not the attacker — leaves the victim's bundle claimable (`relay publish` →
    `claimable: true`, same `bundleId`), and a genuine published sender then delivers. This is the
    only test that actually pins measurement M3 closed.
    *New file* `apps/cli/test/e2e/claim-authentication.test.ts`. **Not** an added step in
    `publication-claimability.test.ts`: that file's SHA-256 is load-bearing evidence in the T19 and
    T20 reports, and a new file keeps it so.

### Files the implementer will touch (for the dispatch that follows)

`packages/crypto-core/src/mailbox/auth.ts` (+ package index) ·
`apps/relay/internal/cryptoutil/signatures.go` ·
`apps/relay/internal/api/handler/signal_prekey_bundle_v2.go` (+ the shared decode change) ·
`apps/relay/internal/api/handler/prekey_bundle_handler.go` (gains the device-record service) ·
`apps/relay/internal/api/router/router.go` · `apps/relay/internal/config/config.go` ·
`apps/cli/src/transport/relayClient.ts` · `apps/cli/src/runtime/outbound.ts` ·
`apps/cli/src/runtime/profile.ts` ·
`docs/API-11_JSON_SCHEMAS.md` §12.3 ·
`docs/requirements/echolet-cli-prototype/specification.md` (Atomic claim) ·
`docs/requirements/echolet-cli-prototype/schemas/relay-v2.schema.json` (`claimRequest`).

Note for whoever edits `specification.md`: T20 residual #2 records that existing **test-file
comments** cite `specification.md:92` and `:130` by line number, so inserting lines above them
silently invalidates those citations. Edit the citations in the same change or append rather than
insert.

---

## 10. The honest bottom line

This is worth doing, and it is not a fix for the thing it looks like a fix for.

It is worth doing because a route that grants, to anyone, a capability the adjacent route refuses is
an inconsistency that will be found again by the next person who looks, because it closes the one
case T20's client-side guard provably cannot (a publication the relay rejected), because it covers
callers that are not this CLI, and because attribution is the precondition for every response to
abuse that this relay might later want.

It is not a fix for denial of first contact. **Measured**, the attacker's price goes from one request
per destroyed bundle to one request per destroyed bundle. The class stays open, and the thing that
would actually close it — letting the recipient hold and restore more than one claimable bundle — is
a client change to the meaning of an existing command, filed here as §6.4 and recommended as the
companion task.

---

## Routing audit

`graph_used: no` (not-relevant — every file was named in the dispatch or reached from a named one via
`keryx ctx rg`); `wiki_used: no` (not-relevant — `specification.md`, `API-11`, `THREAT-08` and the
T12/T13/T20 flow reports are the cited authority for this behaviour, and the dispatch named them);
`ctx_used: yes` (`keryx ctx rg` for every search, `keryx ctx run` for every command, build,
measurement and large read); `raw_rg_used: no`.
