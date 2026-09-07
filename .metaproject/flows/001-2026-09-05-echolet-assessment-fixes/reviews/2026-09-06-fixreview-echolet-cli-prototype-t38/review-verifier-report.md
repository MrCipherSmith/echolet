# T38 fix review — independent verification report

Verifier: `review-verifier` (independent; did not write the fixes, did not write the reviews)
Flow `001`, dispatch `001-T38-review-verifier`, project root `/Users/Goodea/goodea/projects/echolet`.

Every verdict below cites something that was **run**, not something that was re-read.
The repository was left byte-identical: five source mutations and three probe files were
applied and reverted, with sha256 verification and both suites re-run green (section 7).

## Method mix

| Method | Count | Findings |
|---|---|---|
| execution | 8 | HL-N-001, BE-R-001, BE-R-002, SEC-R-001, HL-N-003, T38-TP-001, T38-TP-002, T38-TP-003 |
| site-check | 2 | HL-N-002, T38-L-001 |
| reasoning (capped to `unverifiable`) | 0 | — |
| not checked | 0 | — |

**Confirmed 10, refuted 0, unverifiable 0.** Four *sub-claims* inside otherwise confirmed
findings did not survive and are reported in section 5.

---

## 1. HL-N-001 (major) — CONFIRMED, execution

The only open major, and the one that drives a fix wave. Each link was attacked separately.

### Link 1 — the whole batch aborts and `ackPending()` is never reached

Temporary vitest probe (`apps/cli/src/runtime/zzverifierprobe.test.ts`, created and deleted)
built three profiles: `alice` (pinned by `bob`), `bob`, and `mallory` (never imported by
`bob`). `alice` sent one legitimate envelope and `mallory` one envelope; both were placed in
`bob`'s mailbox, in **both** orders.

```
vitest run src/runtime/zzverifierprobe.test.ts   ->  1 passed (1155ms)
```

Inside it, for each order:

- three consecutive `receiver.poll()` calls rejected with `code: "CONTACT_NOT_TRUSTED"`;
- `fake.acks()` was `[]` — **not a single `/v1/mailbox/ack` request was ever issued**;
- `receiver.history({contactIdentityId: alice})` was `[]`;
- both envelopes were still in the mailbox afterwards.

Control, same harness, poison envelope removed: the first `poll()` succeeded, issued exactly
one ack, wrote one history entry and drained the mailbox. The position of the offending
envelope inside the batch is irrelevant, because `accept()` wraps the whole loop in one
`profile.withRuntime` transaction (`inbound.ts:47-78`) and `Profile.transact`
(`profile.ts:76-85`) rolls it back, so `poll()` throws at `inbound.ts:41` and never reaches
`ackPending()` at `:42`.

### Link 2 — `/v1/messages/send` has no sender authentication

Confirmed. `router.go:24-26` installs only `Recover`, `RequestID` and the rate limiter;
`router.go:76` wires `/v1/messages/send` straight to `SendEnvelope`. `mailbox_handler.go:75-114`
checks the body bound, `ValidateMailboxEnvelope` and the expiry, then stores.
`validation/validate.go:72-99` checks `type`, `version`, ciphertext presence, the two size
comparisons and the expiry ordering — **no signature, no challenge, no device record for the
sender, and nothing tying `sender_identity_id` to anything**. The target mailbox is
`SHA-256(identity_id + ":mailbox:v1")` (`cryptoutil/signatures.go:14-17`), computable by anyone
holding the published contact card. One unauthenticated POST is the whole trigger.

### Link 3 — are queued messages actually lost? **Yes.**

Temporary Go probe under `apps/relay/internal/storage/repository` with an injected clock:

```
T+0h : GetEnvelopeBatch -> 2 envelopes            (the CLI rejects the batch and acks nothing)
T+25h: GetEnvelopeBatch -> [0000-poison]          (legitimate envelope aged out, undelivered)
T+31d: GetEnvelopeBatch -> 0 envelopes            (poison finally aged out too)
```

The legitimate envelope is never delivered and then disappears. **Messages queued behind the
blocking envelope are lost.**

### What did *not* survive

Two wording claims, neither of which weakens the harm:

1. **"permanently wedge" is too strong.** The wedge lasts as long as the poison envelope
   survives — bounded by its declared expiry and, physically, by `retentionDeadlineSeconds`
   clamping badger's TTL to the 7-day cap (`mailbox_repo.go:229-246`). The T+31d row above is
   the mailbox unwedging on its own. In practice this is a distinction without much comfort:
   re-arming it costs the attacker one more unauthenticated POST.
2. **The loss deadline is 24h, not the 7-day retention cap the finding cites.** CLI envelopes
   declare `expires_at_ms = created + 86400000` (`outbound.ts:83`), and `GetEnvelopeBatch`
   filters on the *declared* expiry (`mailbox_repo.go:183`). Legitimate traffic is lost after a
   day, so the finding **understates** how fast the loss arrives.
3. Minor mechanism correction: "the identical batch is returned forever" is imprecise.
   `mailbox_repo.go:169` iterates lexicographically by `envelope_id` under a `batch_size`
   bound, so the identical batch recurs only while the poison sits inside the selection
   window — which it always does once the envelopes ahead of it drain or expire. Conclusion
   unchanged.

---

## 2. The other nine open findings

| Finding | Verdict | Method | The check that produced it |
|---|---|---|---|
| **BE-R-001** | confirmed | execution | Go probe through the existing handler harness: 70000-byte `recipient_mailbox_id` → **500**; identical envelope with a short id → **200**; 70000-byte `envelope_id` → **500**. `validate.go:72-99` inspects no identifier length. |
| **BE-R-002** | confirmed | execution + site-check | All four `SaveDeviceMailboxBinding` call sites enumerated: `device_record_repo.go:53` (inside `Save`'s 64-attempt loop), `signal_prekey_bundle_v2.go:91` and `:103` (both inside `updateV2`'s identical 64-attempt loop), and `device_record_repo.go:157` — a bare `r.db.Update`. The enumeration is exactly right. Abort leg: seeded two healthy records plus one undecodable value → `BackfillDeviceMailboxBindings()` returned a JSON error and **0 of 2** healthy records were bound. |
| **SEC-R-001** | confirmed | execution | `parseArgs(["--text","--json"], {strict:true})` on node v26.5.0 throws `ERR_PARSE_ARGS_INVALID_OPTION_VALUE`; `["--text=--json"]` yields `text === "--json"` with no `json` key. The built CLI run as `send … --text --json` exited **3 / CONTACT_NOT_TRUSTED** — the parser accepted it and swallowed the flag. The exit-0 form is already pinned green in the tree at `cli.dashOptionValues.test.ts:286`. |
| **HL-N-002** | confirmed | site-check | 14 matches for `next_cursor` across 6 files; outside `relayClient.ts`'s schema every one is a test fixture, and the only **read** anywhere is `relayClient.pollCapacity.test.ts:118`. `inbound.ts:38-43` returns `{received}` only. The drain loop exists only in that test. |
| **HL-N-003** | confirmed | execution | `config.go` parses `ECHOLET_MAX_MESSAGE_BYTES` with no validation and `Load()` adds none. Go probe with `maxMessageBytes = 2 MiB`: a 2097152-byte ciphertext accepted **200**, then a real signed challenge + poll returned **2097781 bytes** — 2× the client's 1 MiB reader bound at `relayClient.ts:96`, which throws non-retryable `INVALID_RELAY_RESPONSE` so nothing is acked. Regression leg confirmed from the change record: `t35-implementation-report.md:145-165` states the send route previously carried a hand-chosen 1 MiB constant. |
| **T38-TP-001** | confirmed | execution | MC3b reproduced: deleting `outbound.ts:44-46` left `outbound.concurrentSend.test.ts` green in **215ms**. Counter-mutation MC2 (delete the in-transaction re-read instead) went RED with 3 of 4 soft assertions firing, so the barrier is load-bearing only while the pre-read exists. |
| **T38-TP-002** | confirmed | execution | MG4 reproduced: expiry filter removed from `GetEnvelopeBatch` → `go test ./...` under `apps/relay` **all ok**. `GetEnvelopes` re-enumerated: definition, service pass-through and two test files only — no production caller. |
| **T38-TP-003** | confirmed | execution | (1) Under MC2 the `outboxKeys` assertion did not fire while the other three did — inert under exactly the defect it accompanies. (2) The client's reader bound at `relayClient.ts:96` was widened 1 MiB → 1 GiB and `relayClient.pollCapacity.test.ts` still passed 2/2: the assertion at `:123` is unaffected by a 1024× change to the only production bound it names. |
| **T38-L-001** | confirmed | site-check | `rotateBundle` appears only at `outbound.ts:36` and one test; `retryPending` only at `outbound.ts:110` and two tests. Neither name occurs in `cli.ts`, and all eight branches of `execute()` reach only `publish/send/poll/history/summary/diagnostics/exportContact/importContact`. |

---

## 3. MC10 — reproduced, and worse than reported

The orchestrator relied on the six over-correction guard tests as the defence against the fix
being obtained by disabling strict parsing. **That reliance was not justified.**

```
baseline, unmodified tree:
  vitest run src/commands/cli.dashOptionValues.test.ts   ->  16 passed (16)

cli.ts:107  strict: true  ->  strict: false
  vitest run src/commands/cli.dashOptionValues.test.ts   ->  16 passed (16)
  vitest run  (whole apps/cli suite)                     ->  13 files, 69 tests, all passed
```

Not one test in the entire CLI package distinguishes strict from non-strict parsing. The reason
is structural, and worth recording because it explains why adding *more* tests of the same shape
would not help: every guard the suite asserts is enforced by `parseCommand` itself rather than by
`parseArgs`. Unknown flags and command/option mismatches are caught by the token loop at
`cli.ts:114-118`; repeats by the same loop's `seen` set; missing values by `required()` at
`cli.ts:120` and `:124-128`; operands after `--` by the `commandOptions[command]` lookup at
`cli.ts:111-112`. `strict` only ever governs `parseArgs`'s own rejections, and `parseCommand`
re-implements every one of them.

`cli.ts` restored, sha256 `40886948f89de38ffe05750c6be627a77a82d0465b1b4230a2002b4e79c5f7ef`.

---

## 4. Adversarial spot-checks of the `fixed` dispositions

Eight claims were attacked. **None broke.**

| Claim | Attack | Outcome |
|---|---|---|
| **F-004** — the read genuinely joins badger's conflict set | 32 goroutines calling `SaveEnvelope` on the same `(mailbox, envelope_id)` with **different** bodies, released together | **Holds.** accepted=1, `ErrEnvelopeIDConflict`=31, other=0, stored records=1. The accepted record was never replaced. `badger.DefaultOptions` carries `DetectConflicts = true`. |
| **F-007** — first-writer-wins cannot bind a foreign identity | Attacker and victim publish the **same device UUID**, in both orders; then a record claiming the victim's `identity_id` handed straight to the binding writer | **Holds.** Each mailbox resolved only to its own identity in both orders; the legitimate owner was never denied. Structurally: the key is derived from `record.IdentityID` and the value **is** `record.IdentityID`, so a binding can only ever point a mailbox at the identity it was derived from, and reaching the writer at all requires that identity's own signature (`ValidateDeviceRecord`, ed25519 over canonical JSON). `DeriveMailboxID` is a full untruncated SHA-256. |
| **F-008** — the fix is real | MC2: delete the in-transaction re-read at `outbound.ts:70-72` | **Holds.** The defect returns immediately — history entries `[2,3]`, two relayed envelope ids, differing receipt ids. The fix is load-bearing. |
| **F-003** — a domain error cannot be swallowed as `PERSISTENCE_FAILURE` | Trace the one place the type could be lost | **Holds.** `EncryptedSqliteStore.perform` (`:77-79`) does `ROLLBACK; throw error` — the **same object** — so `Profile.transact`'s `Object.is` guard (`profile.ts:82`) preserves the domain type. Observed live: `CONTACT_NOT_TRUSTED` propagated out of `poll()` in the HL-N-001 probe. The type is only lost if the `ROLLBACK` itself throws, which is a genuine store failure. |
| **F-006** — bodies bounded before decoding, ciphertext length authoritative | Seven shapes | **Holds.** 1 MiB ciphertext → **413**; 300000-byte ciphertext inside the body cap → **400**; `size_bytes` understating → **400**; overstating → **400**; `size_bytes` = 2³⁰ with a 4-byte ciphertext → **400**; honest 262144-byte envelope → **200**; oversized `/v1/mailbox/poll` body → **413**. |
| **F-001** — a publication retry resubmits the identical signed bundle | Two **separate CLI processes** running `relay publish` against a recording relay | **Holds.** Both exited 0, two submissions, **1 distinct payload** — byte-identical. |
| **F-002** — confirmation settles on a completed line, not on EOF | Spawn `contact import` with stdin **deliberately held open** | **Holds.** `y\n` → exit 0 `{"trusted":true}`; `n\n` → exit 3 `CONTACT_NOT_CONFIRMED`. Neither run waited for EOF or hit the 12s kill timer. |
| **F-013** — the fix works | Baseline suite plus a live dash-leading send | **Holds.** 16/16 green unmodified; a dash-leading `--to` reaches the trust layer verbatim. The MC10 weakness in section 3 is about the *tests*, not the fix. |

`F-005`, `F-009`, `F-010` and `F-011` were outside the requested spot-check set and were **not**
adversarially attacked. Not checking removes nothing: those dispositions stand as their
reviewers reported them.

---

## 5. Everything that did not survive verification

No finding was refuted. Four sub-claims were:

1. **HL-N-001, "permanently wedge".** Refuted as stated; the wedge is bounded by the poison
   envelope's own lifetime (≤ the 7-day retention cap) and re-armed by one more unauthenticated
   POST. Evidence: the T+31d row in section 1.
2. **HL-N-001, "lost once they age past the 7-day retention cap".** Refuted as stated, in the
   direction that makes the finding worse: CLI envelopes declare a 24h expiry
   (`outbound.ts:83`) and `GetEnvelopeBatch` filters on the declared expiry, so loss begins
   after a day. Evidence: the T+25h row.
3. **HL-N-001, "the identical batch is returned forever".** Imprecise: selection is
   lexicographic by `envelope_id` under a `batch_size` bound, so the identical batch recurs only
   while the poison sits inside the selection window. It always does eventually.
4. **T38-TP-002, mutation MG4 as literally described.** Deleting `|| envelope.ExpiresAtMs <= nowMS`
   alone does **not compile** (`vet: declared and not used: nowMS`); the reproduction needed a
   compensating `_ = nowMS`. The finding's conclusion is unaffected.

One **understatement**, which per the verifier contract is not a refutation and is not mine to
correct: **BE-R-001** names `recipient_mailbox_id`, but `envelope_id` — the other half of the
badger key at `mailbox_repo.go:261-263` — produces the identical 500 and was not enumerated.

---

## 6. Recommendation per confirmed finding

### Fix now, in this flow

| Finding | Why now |
|---|---|
| **HL-N-001** (major) | One unauthenticated request permanently-enough disables the documented `poll` contract for a chosen recipient, and destroys their legitimate traffic within 24h. This is a functional defect in the prototype's own contract, not production hardening. Smallest correct change: process each envelope in its own transaction and aggregate rejections into the poll result, or quarantine the offending `envelope_id` locally and include it in the ack set. The `CONTACT_NOT_TRUSTED` guarantee is preserved either way — the point is not to decrypt it, only to stop it blocking the queue. |
| **BE-R-001** (minor) | Three lines in `ValidateMailboxEnvelope` turn a 500 on purely attacker-controlled input into a 400, and the fix should bound `envelope_id` as well as `recipient_mailbox_id`. |
| **SEC-R-001** (minor) | Docstring only — **no behaviour change**. `cli.ts:77-84` currently asserts something `cli.ts:95-96` does not do. Cheapest possible correction of a claim the next author would rely on. |
| **HL-N-002** (minor) | One field: `return { received, more: batch.next_cursor !== null }`. It closes the operator-visible half of F-009, which is otherwise fixed on the wire and invisible at the CLI. |
| **T38-TP-001** (minor, test-only) | Re-anchor the barrier to `idFactory("envelope")` — the envelope-allocation event inside the mutation transaction — so no refactor of the "Optimization only" pre-read can silently turn the concurrency test into an idempotency test. |
| **T38-TP-002** (minor, test-only) | Add a `GetEnvelopeBatch` expiry regression. The F-005(c) regression currently pins `GetEnvelopes`, which nothing in production calls, so the actual poll path is unprotected. Include one case where non-strict `parseArgs` observably differs, per section 3. |
| **T38-TP-003** (minor, test-only) | `tx.keys("cli:outbox:")` instead of the complete key; restate or delete the `pollCapacity` byte assertion. Both are one-line edits that stop two assertions reading as coverage they do not provide. |

### Record as a documented prototype limitation

| Finding | Why |
|---|---|
| **BE-R-002** (minor) | Unreachable today: the backfill runs before `ListenAndServe` and badger's directory lock excludes a second writer. Record the class divergence — "every writer of `device_mailbox` retries a conflict" now has exactly one exception — so a later change that moves the backfill off the pre-serve path knows to close it. The two-line "continue past a per-record failure instead of returning" change is cheap enough to take opportunistically. |
| **HL-N-003** (minor) | Unreachable at the shipped default of 262144, and reachable only by an operator deliberately raising an env var on a loopback relay they run themselves. Record the coupling; the one-line startup clamp is optional. |
| **T38-L-001** (minor) | Wiring commands would exceed the documented command surface at `specification.md:63-72`. Record that `rotateBundle()` and `retryPending()` are deliberately library-only for the prototype. Note the interaction worth writing down: `rotateBundle()` being unreachable is currently what *protects* F-001's persisted-bundle invariant from accidental rotation. |

---

## 7. Mutation ledger and tree restoration

Five source mutations, each applied, executed and reverted; three probe files created and
deleted. Nothing was fixed and nothing was left behind.

| File | Mutation | sha256 after revert | Matches baseline |
|---|---|---|---|
| `apps/cli/src/commands/cli.ts` | MC10: `strict: true` → `strict: false` (`:107`) | `40886948…9c5f7ef` | yes |
| `apps/cli/src/runtime/outbound.ts` | MC3b: delete `:44-46`; then MC2: delete `:70-72` | `3720f372…7e8bba0f` | yes |
| `apps/cli/src/transport/relayClient.ts` | reader bound `:96` 1 MiB → 1 GiB | `d01e31c0…e584e843` | yes |
| `apps/relay/internal/storage/repository/mailbox_repo.go` | MG4: expiry filter out of `GetEnvelopeBatch` (`:183`) + `_ = nowMS` | `d598cbe1…7fc36ef7` | yes |

Probe files created and deleted: `apps/cli/src/runtime/zzverifierprobe.test.ts`,
`apps/relay/internal/api/handler/zzverifier_probe_test.go`,
`apps/relay/internal/storage/repository/zzverifier_probe_test.go`. The F-001/F-002 probe ran
entirely outside the repository, against the built `dist/cli.js`.

Final state of the restored tree:

```
go test ./...   (apps/relay)  ->  handler, router, middleware, repository, validation all ok
vitest run      (apps/cli)    ->  13 files, 69 tests, all passed
git status --short apps packages -> empty
```

`apps/cli/dist/cli.js` is a build artifact; the vitest `globalSetup` rebuilt it during the
probes and the final clean run rebuilt it from the restored sources.

No plaintext body, ciphertext, store key, private key material or HTTP request body appears in
this report; probes asserted on counts, exit codes, status codes and byte lengths only.

---

## Routing audit

`graph_used: no` (gdgraph would have answered from a build predating this session's temporary
probe files; every navigation question here was a targeted symbol search or a known file path).
`wiki_used: no` (not-relevant — this is a verification pass against named `file:line` claims and
executed behaviour, not an architecture question).
`ctx_used: yes` (`keryx ctx rg` for every code search, `keryx ctx run` for directory and
compact-file output).
`raw_rg_used: no`.
