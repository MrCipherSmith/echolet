# T26 — a pool of one-time bundles, and replenishment through `relay publish`

Flow 003, task T26. **Design only.** No source, test, schema or documentation file outside this
deliverable and its dispatch result was created, edited or deleted. No connection was made to
`geekom` or `depr`. No store key, private key, plaintext or HTTP request body is printed or recorded
below.

Measured against tree `c5fde09`. The tree carries pre-existing uncommitted modifications
(`apps/cli/package.json`, `deploy/relay/*`, the flow's own `flow.json` and `journal.md`) that predate
this task and that T25 already records as uncommitted at its own start; none was touched here.

Every measurement ran against the **real relay binary** built from that tree
(`sha256 f60b1570c4ac7c0631c8916b15abcc97abab42f0b94d98e3c3afbacf697ecca4` — byte-identical to the
binary T18 measured against, so the two sets of numbers are directly comparable) on Node v26.5.0, on
loopback, with throwaway data directories under the session scratchpad. Probe scripts live in the
scratchpad and were never written into the repository.

Everything labelled **Measured** was run. Everything labelled **Inferred** was read off the tree and
reasoned about, and says so.

T18's measurements are taken as the starting point and are not re-derived: identities mint at 349.7/s
(2.9 ms each) through one unauthenticated POST; the shipped rate limit is 120 requests/minute keyed on
the transport peer host across every route; a stranger's raw claim consumes a victim's only bundle in
one request; the v2 decoder is exactly closed in both directions.

---

## 0. The answer in three sentences

A recipient publishes **N = 20 independently signed bundles** — the number the protocol already
declares as `LIMITS.PREKEY_MIN_COUNT` — one per call to the *unchanged* `/v2/prekeys/publish` route,
so a claim consumes one of twenty rather than the only one, and `relay publish` changes meaning from
"submit my publication" to "bring my published pool back up to N", which is the recovery command a
drained victim has never had. This needs **no relay change, no wire change, no schema change and no
rollout flag**: measured against the real binary, a pool of four published, stayed simultaneously
claimable, served four distinct first-contact senders who all delivered, was decrypted in full by the
recipient, answered the fifth sender with today's exact `PREKEY_BUNDLE_UNAVAILABLE`, and was restored
by one further publish after which that same refused sender's retry delivered. The price is honest and
linear: the attacker goes from 120 to 6 destroyed victims per minute from one source, while the victim
pays **61.6 ms to mint and publish each bundle the attacker destroys for 2.0 ms** — a 30.6× cost
disadvantage per unit — so this buys a 20× rarer denial and a working recovery path, not a structural
fix.

---

## 1. The measurements this design rests on

### 1.1 A pool works today, unmodified, end to end

One recipient (`bob`), four first-contact senders, one relay binary, no source change anywhere:

```
P1 pool publish N=4      -> claimable=[true,true,true,true] distinctBundles=4 distinctKeyIds=4 keyIds=[1,2,3,4]
P2 republish current     -> claimable=true  sameBundleId=true
P3 4 distinct senders    -> [delivered, delivered, delivered, delivered]
P4 bob poll              -> decryptedMessages=4 rejected=0 rounds=1
P5 5th sender            -> RelayError httpStatus=404 remoteCode=PREKEY_BUNDLE_UNAVAILABLE
P6 replenish one bundle  -> claimable=true ; the refused sender's retry -> delivered
```

**Measured.** Every line is load-bearing:

- **P1** — the relay holds N simultaneously claimable bundles for one identity with no change at all.
  `ClaimSignalV2` scans the prefix `v2:available:<identity>:` and takes the first unclaimed, unexpired,
  selector-matching entry (`storage/repository/signal_prekey_bundle_v2.go:155-195`), so N entries mean
  N claims. The key is `v2:available:<identity>:<createdAtMS as 16 digits>:<bundleID>`, iterated in
  ascending byte order, so **the oldest pool member is consumed first** — the correct order, because
  it is the one closest to expiry.
- **P1 (key ids)** — four *distinct* one-time prekeys, ids 1..4. Each publication reserves its own
  `(identity, device, signal identity, key_id)` tombstone and its own public-key tombstone, so no pool
  member ever collides with another. This is the whole permanent-reservation argument, measured rather
  than asserted (§5).
- **P3/P4** — the recipient decrypted all four. `SignalClient.rotateOneTimePreKey()` allocates
  `pre:<next>` and moves a pointer; it **never deletes a previously allocated record**, and its own
  comment says why ("Previously allocated prekey records are retained so in-flight sessions still
  resolve"). `Records.getPreKey(id)` resolves any allocated id, and only libsignal's `removePreKey` —
  driven by an actual `PreKeySignalMessage` decrypt — removes one. The client-side half of a pool is
  therefore already built and already tested by the code that exists.
- **P5** — at exhaustion the sender sees exactly what it sees today. Not a new code, not a new shape.
- **P6** — replenishment restores availability, and a sender previously refused delivers on retry
  without operator intervention on the sender's side. This is the recovery today's tree cannot do.

### 1.2 What a bundle costs each side

```
C1 victim per pooled bundle : mint+sign+store 57.7 ms  +  publish POST 3.9 ms  =  61.6 ms   (n=24)
C2 attacker per destroyed bundle : raw unauthenticated claim POST  2.0 ms      (24/24 destroyed)
C3 ratio victim:attacker per bundle = 30.6x
L0 one bundle on the wire = 3350 bytes
```

**Measured**, same binary, rate limit raised to 100 000/min so the limiter is not the thing being
measured. This is the number that keeps this design honest and it is stated before any of the good
news: **per unit of key material, the defender pays thirty times what the attacker pays.** A pool does
not reverse that. What it does is make the attacker spend twenty units where they used to spend one,
and give the defender a way to spend theirs at all.

### 1.3 Signal's last-resort answer does not fit this wire

```
L1 valid bundle (control)                       -> 200 ok=true
L2 one_time_prekey:null (last-resort shape)     -> 400 INVALID_SCHEMA
L3 extra `last_resort:true` field               -> 400 INVALID_SCHEMA
L4 same one-time prekey, new bundle_id          -> 400 INVALID_SIGNATURE
```

**Measured** against the deployed protocol. L2 and L3 are the two shapes a last-resort key could take
and the relay refuses both; the publish route's decoder is exactly as closed as the claim route's that
T18 measured. L4 is a bonus: `bundle_id` is inside the signed tuple
(`validation/signal_prekey_bundle_v2.go:231`), so a reused one-time prekey is refused at the
*signature* one step before the tombstone even runs. §4 uses these.

---

## 2. The design

### 2.1 What changes, in one table

| | Today | After |
|---|---|---|
| `/v2/prekeys/publish` request/response | `{bundle}` → `{stored, bundle_id, claimable}` | **unchanged** |
| `/v2/prekeys/claim` request/response | 3 fields → `{bundle}` | **unchanged** |
| Relay storage, service, handler, config | — | **unchanged** |
| Relay JSON schemas | — | **unchanged** |
| CLI command surface | eight commands | **eight commands** |
| `relay publish` means | submit the one stored bundle | bring the published pool up to N |
| `Profile` publication record | `cli:publication` — one bundle | `cli:publication:<slot>` — N bundles, plus `cli:publication` kept as slot 0's alias |
| `relay publish` result | `{stored, bundleId, claimable}` | `{stored, bundleId, claimable, pool:{target, claimable, minted}}` |

**This is a client-only change.** That single fact settles most of the questions the brief asks, and
it is why this design is smaller than T18's despite doing more for the victim.

### 2.2 How many, and who decides

**N is fixed by the protocol at `LIMITS.PREKEY_MIN_COUNT = 20`.** Not invented here: it already sits in
`packages/protocol/src/constants/limits.ts:5` beside `PREKEY_REFILL_THRESHOLD: 10`, and
`docs/PROTOCOL-07_MVP_MESSAGE_FLOW.md` §22 lists both under "рекомендуемые лимиты" with the rule that
such limits "MUST быть захардкожены или вынесены в config". **Measured:** both constants are declared
and referenced nowhere in any source file — the pool was specified and never built. This design builds
the thing the constant was written for rather than minting a second number for the same quantity.

That places N in exactly the category `LIMITS.MAX_MESSAGE_BYTES` is already in, and `relayClient.ts`
already states the rule for that category: closed, agreed in advance by both sides, **never negotiated
on the wire**, because "the relay is the adversary-adjacent component". N is a client constant. The
relay learns nothing about it and enforces nothing about it.

The three options, and what each costs when the pool is exhausted anyway:

| Who decides | What it costs when the pool runs out | Why not |
|---|---|---|
| **Protocol-fixed (chosen)** | The operator sees today's `PREKEY_BUNDLE_UNAVAILABLE` and runs `relay publish`. Nothing is unrecoverable. | The relay does not enforce N, so a hostile publisher can put an unbounded number of bundles under `v2:available:<their identity>:` — 3350 bytes each (L0), with no per-identity cap anywhere in `SaveSignalV2`. That is a storage-growth abuse against the relay, not against any user, and it is **already possible today**; the pool neither creates nor worsens it. Named as a follow-on in §8. |
| Publisher-chosen | Same, plus the operator can under-provision themselves silently. | It needs a knob in `ClientConfig`, which is `z.object({…}).strict()` at `profile_version: z.literal(1)`. Admitting an optional field into a closed schema, or bumping the version and migrating every profile on disk, are both larger changes than the feature — for a value that has no per-install meaning, since a sender's profile and a recipient's profile are different installs. |
| Relay-bounded | Same for the operator; the relay gains a real defence against the storage abuse above. | It is the only option that **changes what `geekom` and `depr` accept**: a publish above the cap becomes a new refusal, which is a wire-observable behaviour change and therefore needs its own flag, its own two-deployment ordering, and its own migration. That is T18's problem, not this one's, and inheriting it would forfeit this design's single best property. Recommended as a follow-on that can ride T18's rollout (§8). |

**Cost of N = 20, measured rather than guessed.**

- A full-drain `relay publish`: 20 × 61.6 ms ≈ **1.23 s**, and 20 requests — **17 % of the shipped
  120/min budget**.
- A steady-state `relay publish` on a full pool: 20 publish POSTs and zero mints ≈ **78 ms**.
- Relay storage: 20 × 3350 B ≈ **67 KB per device generation**.
- Client storage: the same 67 KB inside the encrypted profile store.
- One-time prekey id exhaustion: `maxOneTimePreKeyId = 0xffffff` (16 777 215). A full weekly refresh at
  N = 20 burns 20 ids per week, so the space lasts ~16 000 centuries. Not a constraint. *(Inferred from
  `SignalClient.ts:60` and the seven-day bundle window.)*

**A note that decides a design question by arithmetic:** 20 bundles batched into one request would be
67 000 bytes, and `decodeV2Request` wraps the body in `http.MaxBytesReader(w, r.Body, 64*1024)` =
65 536. **A batch-publish route could not carry N = 20 even if someone built one.** One bundle per
request is not merely the zero-change option; it is the only shape that fits the cap the relay already
enforces.

### 2.3 Replenishment: idempotent-with-top-up, never a fresh pool

`relay publish` runs one loop:

1. Read the N stored pool members from the profile (durable, byte-exact, written before any request —
   the same discipline `publicationBundle()` uses today).
2. Re-submit **every** stored member to `/v2/prekeys/publish`. Each is idempotent: `SaveSignalV2`
   re-stores byte-identical bytes and deliberately never re-adds the availability index, and it answers
   `claimable` truthfully for each. Count the `true`s as `k`.
3. Mint `N − k` fresh bundles (`rotatePublicationBundle`, one per empty slot), store each durably
   **before** publishing it, then publish it.
4. Report `{stored: true, bundleId: <slot 0>, claimable: k + minted > 0, pool: {target: N, claimable,
   minted}}`.

**Why re-submit all N rather than only the ones believed live.** Belief goes stale the moment a claim
lands. A client that skipped re-submission of members it last saw as claimable would never learn they
had since been consumed, and would report a full pool while holding an empty one. The re-submission
*is* the query — there is no separate "how many are left" route, and adding one would be a wire change.
Measured cost of using publish as the query: 3.9 ms per member, 78 ms for the whole pool. That is
cheaper than any new route would be to design.

**Why top-up rather than always-fresh.** Three reasons, each measured or read off the tree:

1. Always-fresh mints N bundles on every invocation and every one of them permanently tombstones a
   one-time prekey the operator never used. `apps/cli/test/e2e/publication-claimability.test.ts` alone
   runs `relay publish` four times for `bob` in one test; at N = 20 that is 80 permanently reserved
   prekeys for a test that needs one working pool.
2. Always-fresh destroys the lost-response retry guarantee. `specification.md:130` and
   `publicationBundle()`'s own contract require that a retried publication resubmits the byte-identical
   bundle around the identical reserved prekey. A pool member is a publication; the guarantee applies
   per member.
3. **Measured (P2):** republishing the current stored publication today reports `claimable: true` with
   the same `bundle_id`. Top-up preserves that exactly; always-fresh would make it false on every call.

**What the operator can and cannot cause.** Running `relay publish` six times in a minute at N = 20
issues 120 requests and hits the shipped limiter. That is a real, visible cost of the pool and it is
stated here rather than discovered later: the command goes from 1 request to 20, and the operator's
per-minute headroom for `send` and `poll` shrinks accordingly. It is bounded, self-inflicted, and
recovers in the next minute.

### 2.4 Where the local state lives

`cli:publication` today holds one `{version, bundle}` record and is the sole witness `hasPublication()`
consults for the T20 send precondition. The pool must not disturb that:

- Slot 0 keeps writing `cli:publication` **unchanged, with the same schema and the same bytes it would
  have had**, so `hasPublication()` keeps answering exactly what it answers today and the T19/T20
  precondition tests keep meaning what they mean.
- Slots 1..N−1 go to `cli:publication:<slot>` under a schema identical to `publicationSchema`.
- `bundleId` in the `relay publish` result stays **slot 0's** bundle id, permanently. It is an anchor,
  not a cursor. This is what keeps `publication-claimability.test.ts` steps 1–3's `bundleId` stability
  assertions — load-bearing evidence in the T19 and T20 reports — true and meaningful.

**Slot 0 is never re-minted while any member is live.** If slot 0 has been claimed but slot 7 has not,
top-up mints into slot 7's neighbours and leaves slot 0's stored bytes alone; the anchor id stays
stable across the whole life of the profile. Only a total drain re-mints slot 0, and at that point the
old id names nothing on the relay anyway. *(Inferred; a test pins it — §6, B-9.)*

### 2.5 `claimable` changes meaning, and two existing assertions become false

`claimable` in the `relay publish` result becomes **"at least one pool member can serve a first-contact
sender"** — the honest answer to the only question the operator is asking. The per-member truth is
still available in `pool.claimable`.

Under that reading, two assertions in `apps/cli/test/e2e/publication-claimability.test.ts` stop being
true and **must be rewritten** — this is a real cost of the design and it is not hidden:

- **step 6**, `afterClaim.data.claimable === false` after exactly one claim. Under a pool, 19 members
  remain, so it is `true`. The property step 6 was protecting — *a publish that restored nothing must
  say so rather than reporting plain success* — survives and gets sharper: it becomes
  `pool.claimable === N − 1` and `pool.minted === 0` before top-up, and `pool.claimable === N` after.
- **step 7**, a second distinct sender is refused `/PREKEY/`. Under a pool she succeeds. That is the
  entire point of the task. The exhausted-prekey vocabulary assertion moves to a sender who arrives
  after all N are gone (measured: P5 answers her identically today).

T18 §9 notes that this file's SHA-256 is cited as evidence in the T19 and T20 reports, and chose a new
file to keep it stable. This design **cannot** do that: the two assertions are false under a pool, and
leaving a knowingly-false assertion in the tree to preserve a hash would be worse than editing it. The
implementer must edit the file and record the new hash in the implementation report, noting that T19's
and T20's citations refer to the pre-T26 revision.

### 2.6 What replenishment costs a sender still holding a claim

A sender may hold `cli:claim:<identity>` and a durable outbox record for days. **Nothing about
replenishment touches them, by construction**, and the design's job is to keep it that way:

1. **The relay.** `ClaimSignalV2` binds the exact bundle bytes to the claim id and replays them
   forever. Replenishment writes new `v2:bundle:*`, `v2:available:*` and tombstone keys; it never
   touches `v2:claim:*` and never rewrites a claimed bundle's stored bytes. *(Read off
   `signal_prekey_bundle_v2.go`; the claim branch is not on the publish path at all.)*
2. **The sender.** `deliver()` re-encrypts through `client.retry()` against the session it already
   established and issues only `/v1/messages/send`. It never re-claims. T12 §4 measured this: a
   rejected deposit retried by the same profile records
   `['/v2/prekeys/claim', '/v1/messages/send', '/v1/messages/send']` — one claim in total. AC-05's late
   retry is untouched.
3. **The recipient's private half.** The one thing that could break this is a client that prunes
   `pre:` records when a pool slot is refilled. **This design forbids any pool GC.** The private half
   of every bundle the recipient has ever published stays in the store until libsignal's `removePreKey`
   consumes it, which is today's behaviour and is exactly what P4 measured (four senders decrypted
   after the recipient had rotated four times past the first prekey). It is a "keep doing nothing"
   property, which is the strongest kind, and it gets a test (§6, A-5) precisely so that a future
   tidying pass cannot quietly remove it.
4. **The one genuine hazard, already handled.** A claimed-but-unused bundle can expire (seven-day
   window). `claimFirstContact` already releases a dead claim exactly once and takes one fresh claim in
   its place (T13). Under a pool that replacement claim now finds N − k live members instead of
   nothing, so **the pool strictly improves a recovery path that already exists** rather than
   interacting with it.

### 2.7 Expired pool members

A stored member whose window has closed is refused on re-submission: `validation` answers
`ErrV2Expired` → `400 BUNDLE_EXPIRED` before the bundle reaches storage
(`validation/signal_prekey_bundle_v2.go`, `now >= expires`). *(Inferred from the tree — the seven-day
window makes this expensive to measure directly and the code path is unambiguous.)*

`BUNDLE_EXPIRED` is **not** in `reportedRelayCodes`, so left alone it would surface to the operator as
`PROTOCOL_REJECTED` at exit 3 and abort the whole command. The design therefore treats a
`BUNDLE_EXPIRED` on one member as **"this slot is dead, mint a replacement"** — locally, silently,
counted in `pool.minted` — and never as a command failure. `relay publish` fails only if *nothing* ends
up claimable.

Because all N are minted within a second of each other, the whole pool ages together and expires
together. That is not a regression — today's single bundle has the same seven-day life — but it means
a `relay publish` more than seven days after the last one mints all N. Measured cost of that worst
case: 1.23 s. **No allowlist changes**: `BUNDLE_EXPIRED` is handled locally and never reaches
`classify()`.

---

## 3. What it costs an attacker, as a function of N

Let `R` = the limiter's requests per minute per source (shipped default 120), `S` = the number of
source addresses the attacker controls, `N` = the pool size.

```
victims silenced per minute  =  R · S / N
```

| N | Victims/min, one source | Victims/day | Attacker requests per victim |
|---|---|---|---|
| 1 (today) | **120** | 172 800 | 1 |
| 8 | 15 | 21 600 | 8 |
| **20 (recommended)** | **6** | **8 640** | **20** |
| 100 | 1.2 | 1 728 | 100 |
| 120 | 1.0 | 1 440 | 120 |

**With claim authentication (T18) also on**, add one identity mint — 2.9 ms and one POST — per attacker
identity, i.e. `N + 1` requests for the first victim and `N` for each one after. T18 measured that as a
step rather than a cost, and it stays a step here: at N = 20 it changes 6.00 victims/min to 5.95.

**What N would have to be to matter, and whether that is practical here.** To hold one attacking source
below one victim per minute you need `N ≥ R = 120`. Measured cost of N = 120 to the victim: **7.4 s of
mint-and-publish per `relay publish`** and **120 requests — the operator's entire per-minute budget**,
leaving nothing for `send` or `poll` in that minute, and 402 KB of bundles per generation on both
sides. That is not practical for an interactive command in this prototype, and it still only holds off
*one* source: the limiter is keyed on the transport peer host (`middleware/rate_limit.go`, `quotaKey`),
so `S = 10` restores today's 60 victims/min against N = 20 and 12/min against N = 120. **A linear price
increase against a linear attacker is not a bound.** N = 20 is chosen because it is the project's own
declared number, it is a 20× improvement, and its cost to the victim (1.23 s worst case, 17 % of the
minute budget) is one an operator will actually pay. It is not chosen because it makes the attack
uneconomic. It does not.

**The 30× asymmetry, stated plainly.** Per bundle the attacker pays 2.0 ms and the victim 61.6 ms
(C1/C2/C3). A victim who wanted to out-produce one attacking source sustaining 120 claims/min would
need 120 × 61.6 ms = 7.4 s of CPU per minute — 12 % of one core, affordable — **but also 120 publish
requests per minute, which is their entire rate-limit allowance**. So the race is exactly break-even
against a single source and lost against two. What the pool actually buys is not winning the race. It
is surviving a burst, and having any recovery path at all.

---

## 4. What a sender sees when the pool is empty

**Signal's last-resort key is not adopted.** Three reasons, in order of how decisive they are:

1. **It does not fit this wire, measured.** L2: a bundle with `one_time_prekey: null` is refused
   `400 INVALID_SCHEMA` by the relay as `geekom` and `depr` run it — `validation` requires the object
   and reads `key_id`/`public_key` off it unconditionally. L3: an additive `last_resort: true` marker
   is refused `400 INVALID_SCHEMA` too. So Signal's answer costs a relay change, a signed-tuple change,
   a tombstone-rule change and **its own two-deployment rollout flag**, against this design's zero.
2. **It contradicts a guard the tree already enforces.** A reusable key means the same one-time prekey
   is offered to two senders. `prekey_bundle_v2_test.go`'s
   `TestSignalPreKeyBundleV2OneTimePreKeyReservationsArePermanent` forbids it across three variants,
   after expiry, and after claim-and-restart; T12 §2 records those tests as the standing guard against
   exactly this shape of fix. L4 measured that the guard bites even earlier than the tombstone: the
   `bundle_id` is inside the signed tuple, so a re-offered prekey is refused `INVALID_SIGNATURE` first.
3. **The weakening is not worth buying here.** In X3DH the one-time prekey is what gives a first-contact
   session its per-session forward secrecy against later compromise of the recipient's long-term and
   signed keys. Signal accepts a shared last-resort key because at their scale exhaustion is routine and
   undeliverable first contact is unacceptable. Here exhaustion has a recovery command that takes one
   invocation and 1.23 s, and the recipient population is one operator, so the trade runs the other way.

**So: what the sender sees at exhaustion is exactly what it sees today.** Measured (P5): the claim
answers `404`, `RelayError.remoteCode = PREKEY_BUNDLE_UNAVAILABLE`, and because that code is already in
`reportedRelayCodes` (`cli.ts:57`) the operator is told the recipient's prekey is exhausted at exit 3 —
not a trust rejection, not a protocol rejection. No new code, no new exit class, no new vocabulary.

**Is that better or worse than today?** Strictly better, on three counts and no counts against:

- It takes **20 claims instead of 1** to reach that message.
- The recipient can now **clear it**, with a command that already exists, in one invocation (measured:
  P6, including the previously-refused sender's retry delivering afterwards).
- The **sender's own recovery is automatic**: the refused send stored its claim id, the retry reuses it,
  the relay has no binding for it, so it allocates a fresh member. Measured in P6 — no operator action
  on the sender's side, no new state, no new code.

The one thing it is not: a guarantee. A pool that is drained faster than it is refilled empties, and
then the sender sees the same message it sees today. §3 prices exactly how fast that is.

---

## 5. Whether the permanent-reservation property survives — exactly how

It survives untouched, for four independent reasons. None of them is "we were careful"; each is a
property of code this design does not modify.

1. **The design writes only new key material and never revives old.** A pool is N *distinct* bundles
   with N *distinct* one-time prekeys. Measured (P1): four members, four distinct `bundle_id`s, four
   distinct `key_id`s (1,2,3,4) and four distinct public keys. `SaveSignalV2` writes each member's
   `v2:otk:tuple:<sha256>` and `v2:otk:public:<sha256>` tombstone once, and no member ever re-hits
   another member's tombstone. Replenishment mints a *new* prekey through `rotateOneTimePreKey()`, which
   allocates `max(allocated) + 1`; it can never produce a colliding id.
2. **`ClaimSignalV2` is not modified, and neither is anything it reads or writes.** It still marks the
   bundle `Claimed` and deletes the availability entry in **one transaction**, and still binds the exact
   bundle bytes to the claim id. AC-02 (concurrent claims allocate exactly once) and AC-02b (replay is
   exact and selector-bound) are properties of that transaction and are untouched by publishing more
   bundles into the index it scans.
3. **A consumed member is never re-offered, and the re-store path is what guarantees it.**
   `SaveSignalV2`'s idempotent branch re-stores byte-identical bytes and **deliberately never re-adds
   the availability index** — the comment at `signal_prekey_bundle_v2.go:29-36` says so and step 6 of
   the existing e2e measures it. Top-up re-submits every member on every `relay publish`, so this path
   runs N times per invocation; it is the single most-exercised guarantee in the design, and it is the
   one that makes "handing one prekey to two senders" impossible rather than merely unlikely.
4. **Two earlier guards catch the mistake before the tombstone would.** L4, measured: republishing the
   same one-time prekey under a fresh `bundle_id` is refused `400 INVALID_SIGNATURE`, because
   `bundle_id` is inside the signed tuple. And a byte-identical republish takes the idempotent branch
   above. There is no path from this design's client loop to a re-offered prekey.

**`prekey_bundle_v2_test.go` is not edited.** Its guards were run on this tree as a baseline and pass:
`go -C apps/relay test -tags relayv2 -run TestSignalPreKeyBundleV2 ./internal/storage/repository/` →
`ok … 1.756s` (**measured**). They must still pass, unmodified, after the implementation — that is
acceptance criterion, not commentary.

The one thing that *would* weaken the property, and that this design explicitly forbids, is a client
that prunes `pre:` records when a pool slot is refilled (§2.6, item 3). Pruning would not re-offer a
key on the relay; it would do something worse — leave the relay correctly serving a bundle whose private
half the recipient has thrown away, turning a refusable first contact into an undecryptable message.
Test A-5 exists to make that regression impossible to land quietly.

---

## 6. The RED tests, in dependency order

The repository's method is tests-first by one agent, implementation by another. Groups are ordered so
that nothing in a later group is meaningful until the earlier one is pinned.

**On the ⇄ question the brief asks — which tests must exist on both sides of the wire — the answer is
"none, and that is the finding".** There is no wire change, no shared transcript and no shared fixture,
so nothing has to be built twice in two languages and kept byte-identical. T18 needed three ⇄ tests and
a new shared fixture file. This design needs zero. Two Go tests (group D) do exist, but they pin a relay
property the TypeScript client now *depends on* rather than one it must reproduce; the dependency is
one-directional, and the e2e in group E is the joint witness.

### Group A — the pool exists locally and is durable (TypeScript, unit; write first)

*New file* `apps/cli/src/runtime/profile.publicationPool.test.ts`.

1. **The target is the protocol's number.** The pool target is `LIMITS.PREKEY_MIN_COUNT`, read from
   `@echolet/protocol`, and no literal `20` appears in the runtime. A guard against a second number for
   one quantity.
2. **N distinct members.** `publicationPool()` yields exactly N bundles with distinct `bundle_id`,
   distinct `one_time_prekey.key_id` and distinct `one_time_prekey.public_key`, each independently
   accepted by `importVerifiedSignalBundleV2` against the profile's own device record.
3. **Byte-exact durability, per member.** Calling it twice returns byte-identical bundles for every
   slot — the lost-response retry guarantee, inherited by each member from `publicationBundle()`.
4. **The T20 precondition does not regress.** `hasPublication()` answers `true` once a pool exists, and
   slot 0's stored bytes under `cli:publication` parse under the unchanged `publicationSchema`.
5. **No pool GC.** After building a pool of N and rotating past every slot, the store still resolves
   `pre:<id>` for **every** allocated id, and no `pre:` key was deleted. This is the test that keeps a
   sender's week-old durable outbox decryptable, and it is written as a negative assertion on purpose:
   it forbids a future tidying pass, it does not prescribe a mechanism.

### Group B — top-up semantics (TypeScript, unit, against a fake relay)

*New file* `apps/cli/src/runtime/outbound.publicationPool.test.ts`, modelled on
`outbound.publish.test.ts`.

6. **Full pool is a no-op.** With the fake answering `claimable: true` for all N: exactly N publish
   requests, **zero** mints, and every request body byte-identical to the stored member.
7. **Partial drain tops up.** With the fake answering `claimable: false` for `k` members: exactly N
   requests and exactly `N − k` mints, and the `N − k` fresh bundles carry key ids not previously seen.
8. **An expired member is replaced, not fatal.** With the fake answering `400 BUNDLE_EXPIRED` for one
   member: that slot is re-minted, the command succeeds, `pool.minted` counts it, and **no**
   `PROTOCOL_REJECTED` reaches `classify()`.
9. **The anchor is stable.** Across a full-pool publish, a partial-drain publish and an expired-member
   publish, `bundleId` in the result never changes while any member is live.
10. **Total failure is still a failure.** If every member is refused and every mint's publish is
    refused, `relay publish` fails rather than reporting success with an empty pool.

### Group C — what the operator is told (TypeScript, unit)

*Extend* `apps/cli/src/commands/cli.test.ts`'s existing publish assertions.

11. `relay publish` emits `{stored, bundleId, claimable, pool:{target, claimable, minted}}`, `target`
    equals `LIMITS.PREKEY_MIN_COUNT`, and `claimable` is `true` iff `pool.claimable > 0`.
12. The eight-command surface is unchanged — `cli.test.ts:84`'s existing enumeration must still pass
    verbatim. No ninth command, no new option on `relay publish` (`commandOptions["relay publish"]`
    stays `["profile", "json"]`).

### Group D — the relay contract the client now depends on (Go, handler level, real request bodies)

*New file* `apps/relay/internal/api/handler/prekey_pool_test.go`.

**These two cannot be RED, and the plan says so rather than pretending.** Both properties are GREEN on
this tree — measured at P1 and P5 — and nothing in the tree asserts them. The pool's entire correctness
rests on them, so they are written as regression pins and must be labelled as such in the tests-creator
report.

13. **N simultaneously claimable, one consumed per claim.** N distinct valid bundles from one identity
    are all available; N claims under N distinct claim ids return N distinct bundles; the N+1st answers
    `404 PREKEY_BUNDLE_UNAVAILABLE`. Assert also that claims arrive **oldest first** (ascending
    `created_at_ms`), because that ordering is what keeps the member closest to expiry from being the
    one left behind.
14. **Permanent reservation across a pool.** After member *j* is claimed, re-publishing member *j*
    byte-identically answers `claimable: false` and re-adds no availability entry; a second claim id
    never reaches member *j*'s one-time prekey; and re-publishing every other member still answers
    `claimable: true`. `prekey_bundle_v2_test.go` is **not edited** and must still pass unmodified.

### Group E — the whole point, against the real binary (TypeScript e2e, last)

15. *New file* `apps/cli/test/e2e/prekey-pool-replenishment.test.ts`. N distinct published
    first-contact senders each deliver to one recipient's pool; the recipient polls once and decrypts
    all N. (Feasibility measured: P3/P4 at N = 4.)
16. Same file: the N+1st sender is refused at **exit 3** under `PREKEY_BUNDLE_UNAVAILABLE`; the
    recipient runs `relay publish` **once**; that same sender's retry — with no other change and no
    operator action on the sender's side — **delivers**. (Feasibility measured: P5/P6.) *This is the
    property the whole task exists for, and nothing in the tree pins it today.*
17. *Edit* `apps/cli/test/e2e/publication-claimability.test.ts` steps 6 and 7 per §2.5. Step 6's
    property becomes `pool.claimable === N − 1` before top-up and `N` after; step 7's
    exhausted-prekey vocabulary assertion moves behind a full drain. Steps 1–5 are untouched, including
    every `bundleId` stability assertion and the `SENDER_NOT_PUBLISHED` assertion T19/T20 rest on. The
    implementation report must record the new SHA-256 and note that the T19 and T20 citations refer to
    the pre-T26 revision.

### Files the implementer will touch

Code: `packages/protocol/src/constants/limits.ts` (export only — the constants already exist; no value
changes) · `apps/cli/src/runtime/profile.ts` (pool record, `publicationPool()`, `hasPublication()`
unchanged in behaviour) · `apps/cli/src/runtime/outbound.ts` (`publish()` becomes the top-up loop;
`rotateBundle()` becomes reachable through it) · `apps/cli/src/commands/cli.ts` (result shape only).

**No relay file. No schema file. No fixture file.**

**Every place that states "a published bundle serves exactly one first-contact sender" — enumerated,
not sampled.** `keryx ctx rg "exactly one first-contact sender|serves exactly one|one first-contact|
ровно одного первого отправителя"` over the whole tree returns exactly eleven true sites (a twelfth,
`apps/relay/internal/config/config.go:15`, is "serves exactly one scheme at a time" and is unrelated).
Every one of them becomes false and must be edited in the same change, or the tree carries a statement
the code contradicts:

`docs/requirements/echolet-cli-prototype/specification.md:118` ·
`docs/requirements/echolet-cli-prototype/README.md:33` ·
`docs/requirements/echolet-cli-prototype/runbook.md:246` ·
`docs/requirements/echolet-cli-prototype/deployment-runbook.md:1113` ·
`docs/STATUS_CURRENT.md:93` · `docs/PROTOCOL-07_MVP_MESSAGE_FLOW.md:919` ·
`apps/cli/src/commands/cli.ts:34` (the `reportedRelayCodes` rationale) ·
`apps/cli/src/runtime/outbound.ts:65` (the T20 guard rationale) ·
`apps/cli/src/runtime/outbound.publicationPrecondition.test.ts:24, :85, :216` ·
`apps/cli/test/e2e/publication-claimability.test.ts:13`.

`docs/API-11_JSON_SCHEMAS.md` needs no schema change — only the `relay publish` result description.
The two `outbound.publicationPrecondition.test.ts` comment sites and `cli.ts:34`/`outbound.ts:65` are
*rationale prose* for guards that stay correct: the T20 precondition and the exhausted-prekey
vocabulary are both unaffected by the pool. Their reasoning sentence changes from "the recipient has no
way to allocate a replacement" to "the recipient's pool is finite and each wasted claim costs them a
top-up". Do not delete the guards.

Note for whoever edits `specification.md`: T20 residual #2 records that existing test-file comments cite
`specification.md:92` and `:130` by line number. Edit the citations in the same change, or append rather
than insert.

---

## 7. Effect on the deployed relays

**`geekom` and `depr` accept this design exactly as they run today, and their observable behaviour does
not change at all.**

That is not an inference. Every measurement in §1.1 — P1 through P6, including a pool of four published
and claimed and delivered and replenished — ran against the binary built from this tree, which is the
protocol those two hosts are running, using only `/v2/prekeys/publish` and `/v2/prekeys/claim` with
their **contracted three- and one-field bodies**. No new field, no new route, no new code, no new
config variable, no flag.

Concretely:

- A **new client** talking to a **current relay**: works. It issues N publishes instead of one, each a
  request the relay already answers. (Measured: P1.)
- An **old client** talking to a **current relay**: works, unchanged. It publishes one bundle; that is
  a pool of size 1, which is today's behaviour exactly.
- A **current relay** with **no redeploy**: correct. There is nothing to deploy.

**Therefore this design needs no rollout flag and must not share T18's.** Sharing
`ECHOLET_REQUIRE_CLAIM_AUTH` would couple a change that needs zero relay deployments to one that needs
two, and would make the victim's only recovery path wait on a flag flip that, by T18's own strict
ordering, cannot happen until every client is upgraded. The two mechanisms are independent by
construction and must stay independent in the deployment.

The one thing that does change for an operator is a **traffic shape**: `relay publish` goes from 1
request to N = 20 against a 120/min limiter (§2.3). Nothing refuses it; a burst of six publishes in one
minute is rate-limited like any other burst, and recovers.

---

## 8. What this does not fix

**Free identity creation remains open, and this design does not touch it.** T18 measured it: 2.9 ms and
one unauthenticated POST per publishable identity, 349.7 per second sequentially from one process. It
is the same residue the sender quota left on the deposit route and that the relay's own source states at
`mailbox_handler.go:278-283`. Nothing here changes it, and nothing here should be read as though it did.

**A linear price increase is still linear.** §3 gives the exact function `R·S/N` and the exact N that
would be needed to matter (`N ≥ 120`) and the exact reason it is impractical (7.4 s and the operator's
whole minute budget per publish). At N = 20 the attack costs twenty requests instead of one. Twenty
requests is not expensive.

**The defender pays 30× per unit.** C3, measured. An attacker with two source addresses drains faster
than a victim can refill, and the limiter cannot help because it is keyed on the peer host.

**And specifically not closed:**

- **Automatic refill.** `LIMITS.PREKEY_REFILL_THRESHOLD = 10` exists and is deliberately **not** used
  by this design. Refilling during `poll` would make recovery passive and is the obvious next step, but
  it gives an inbound-only command up to N outbound publish side effects the operator did not ask for
  and cannot see. Named as a follow-on with its cost already measured (78 ms full-pool, 1.23 s full
  drain). Without it, **a victim under sustained attack must notice and act.**
- **A relay-side per-identity availability cap.** `v2:available:<identity>:` is an unbounded prefix and
  `SaveSignalV2` counts nothing, so any party can publish an unbounded number of 3350-byte bundles under
  their own identity. This is true today and the pool neither creates nor worsens it, but a design that
  turns "publish one bundle" into "publish twenty" should name it. It is the one option that would
  change what `geekom` and `depr` accept, so it belongs behind T18's flag rollout, not this one.
- **A malicious relay operator** is unaffected: they hold the bundles and can refuse or serve them at
  will. This is §4.3 of the threat model and nothing here touches it.
- **A legitimate contact claiming maliciously** is unaffected — §4.4, out of scope.

---

## 9. Sequencing against the claim-authentication work

**T26 should land first.** Five reasons, in order of weight:

1. **It is client-only and needs one deployment; T18 needs two, in a strict order.** T18 must reach
   `geekom` and `depr` with the flag off, then every client must be upgraded, then the flag flips. T26
   ships by upgrading clients alone, against the relays as they run right now.
2. **It is the only one of the two that helps a victim who has already been drained**, and that
   population exists today — every recipient whose bundle any of this flow's e2e runs consumed.
3. **T18's own §6.4 says so.** "On the cost axis it is strictly better than authentication… only the
   pool actually helps the victim. Recommendation: file it as the companion task." T17's disposition in
   `flow.json` records the same decision.
4. **It makes T18's tests writable once.** T18's e2e test 17 asserts that a raw legacy claim leaves the
   victim's bundle claimable, witnessed through `relay publish` returning `claimable: true` with the
   same `bundleId`. Under a pool, `claimable` means "at least one member" and `bundleId` is the anchor
   (§2.4/§2.5). If T18 lands first, that test is written against a shape that changes underneath it and
   must be rewritten; if T26 lands first, it is written once, correctly, and the stronger assertion
   `pool.claimable === N` (nothing was consumed) is available to it.
5. **The reverse order has no compensating benefit.** Nothing in T26 depends on authentication.

**How the two interact if both land.**

- **On the wire: not at all.** T18 changes the claim request; T26 changes neither request. T18 needs a
  flag; T26 needs none. They must keep separate flags — and T26's is the empty set.
- **In the source: same files, disjoint methods.** `outbound.ts` (T26: `publish()`; T18: `sendOwned`
  and `claimFirstContact`), `profile.ts` (T26: the publication pool record; T18: a claim-signing
  method beside `signEnvelopeBinding`), `cli.ts` (T26: the publish result shape; T18: nothing — it
  measured that no allowlist changes). A rebase, not a conflict of meaning.
- **On the arithmetic: additive and small.** N + 1 attacker requests for the first victim, N for each
  after; 6.00 → 5.95 victims/min at N = 20.
- **On what becomes possible: this is the part worth naming.** T18 §5 rejected a per-claimant claim
  quota because at a pool of 1 a quota `Q` permanently silences an operator who makes more than `Q`
  first contacts, for a measured 5.8 % price increase. With **both** landed, that objection weakens and
  the arithmetic changes: authentication makes the relay able to attribute a claim, and a pool makes
  one victim cost `N` claims, so a quota `Q` bounds one minted identity to `Q/N` victims — the first
  bound in this whole flow that is not linear in the attacker's request budget. At `Q = 64` and
  `N = 20` a legitimate operator keeps 64 first contacts and a minted identity is worth 3 victims
  instead of unbounded. **Neither change gets there alone.** That is the case for doing both, and it
  should be filed as the joint follow-on once both have landed.

---

## 10. The honest bottom line

A pool is the right shape here, and the measurements say so more strongly than the design argument
does: it works today, at N = 4, against the unmodified binary those two hosts are running — published,
claimed by four distinct senders, decrypted in full, exhausted with today's exact error, and restored
by one existing command after which the refused sender's own retry delivered. It needs no relay change,
no wire change, no schema change, no shared fixture, no two-language transcript, and no rollout flag,
and it uses a constant the protocol declared and never built.

It is not a fix for denial of first contact either. It is a 20× price increase against an attacker who
pays 2.0 ms per unit while the victim pays 61.6 ms, and the number that would actually bind — N ≥ 120 —
costs the operator their entire per-minute request budget. What it genuinely changes is the thing T18
could not: **a victim whose bundles are consumed now has a way back, through a command that already
exists, and the sender who was refused gets through on their next attempt without being told anything
new.**

Land it before the authentication work.

---

## Routing audit

`graph_used: no` (not-relevant — every file was named in the dispatch or reached from a named one via
`keryx ctx rg`); `wiki_used: no` (not-relevant — `specification.md`, `PROTOCOL-07`, `PROTOCOL-30` and
the T12/T17/T18 flow records are the cited authority, and the dispatch named them); `ctx_used: yes`
(`keryx ctx rg` for every search, `keryx ctx run` for every command, build, measurement and large read);
`raw_rg_used: no`.
