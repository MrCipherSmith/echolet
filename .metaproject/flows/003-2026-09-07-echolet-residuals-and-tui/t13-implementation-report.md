# T13 — bounding the client around a first-contact claim

Flow 003, task T13 (task-implementer). Product code only. No test file was created, edited or
deleted; no Go file was touched; `apps/relay` was not entered. No connection was made to `geekom` or
`depr`.

File identity by SHA-256 (not mtime):

| file | sha256 | state |
|---|---|---|
| `apps/cli/src/runtime/outbound.ts` | `337031b1540c87b956f420cb42eead8cb123e7a7b7a33dfd9f81cfc3fab1fd5e` | CHANGED (was `07c3960b…`) |
| `apps/cli/src/runtime/outbound.claimResidual.test.ts` | `56285ada4a242f160b1c6ae04dfdf4e6baedcfe896b31b6cfde3393abf6d6714` | unchanged — identical to T12's recorded digest |
| `apps/cli/src/runtime/outbound.test.ts` | `de0b4877d5af612bae352eba217250e1a646aa497933d2e11d5036d0218c7d98` | unchanged |
| `apps/cli/src/runtime/profile.ts` | `29c654f22cea55d525e7b6caf544dd18b2efc52e794b571e0220cefec15a851e` | unchanged (a probe edit was made and fully reverted; the file is byte-identical to baseline) |
| `apps/relay/internal/storage/repository/prekey_bundle_v2_test.go` | `44e4c27da8a274d29496c3ab07a97fcb2b0e1685d7057c280829fdcda580a91d` | unchanged — the standing guards against a claim rollback are exactly as T12 left them |

Result: **two of the three tests are now green; the third is not implementable without regressing the
existing suite, and the reason is a provable contradiction rather than a judgement call.** Details in
§3.

---

## 1. The change

One file, one behaviour: `OutboundMessenger.sendOwned`'s claim block became
`OutboundMessenger.claimFirstContact` (`apps/cli/src/runtime/outbound.ts`).

**Before**, the block claimed once under the durable `cli:claim:<identity>` id and funnelled every
failure of the verification that followed — a changed pin, a bad signature, a closed validity window
— into a single `OutboundError("CONTACT_PIN_MISMATCH")`.

**After**, three things are true that were not:

1. **The pin is checked separately from the window.** The pinned identity, device id, device public
   key and Signal identity key are compared first and still answer `CONTACT_PIN_MISMATCH`. Only once
   they all match is the bundle's validity window considered, against a single reading of the clock
   that is then reused for `importVerifiedSignalBundleV2`, so a bundle cannot be judged dead by one
   check and live by the next.
2. **A dead stored claim is released exactly once and replaced.** If the replayed bundle is outside
   its window (`at < created_at_ms || at >= expires_at_ms`), a fresh claim id is generated, written
   durably to `cli:claim:<identity>` **before** the second claim is issued — exactly the ordering
   that made the first claim recoverable — and the claim is retried once. At most once per send, so
   a recipient whose replacement publication is also outside its window cannot turn one send into a
   claim loop.
3. **An expired bundle is never reported as a trust violation.** A second expired bundle answers the
   new `OutboundError("PREKEY_BUNDLE_EXPIRED")`; a replacement claim that finds nothing left to
   claim surfaces the relay's own `PREKEY_BUNDLE_UNAVAILABLE` (404), which is exactly the
   exhausted-recipient condition `cli.ts` already carries inland. Both keep exit code 3 through the
   unchanged `classify()`, so no exit-code contract moved.

Nothing was rolled back and no relay behaviour was assumed beyond the replenishment T12 measured
against the real repository. The relay's consumption of the abandoned one-time prekey stays
permanent — that is what keeps one one-time prekey bound to one sender, and it is why dropping the
dead id is safe: the only thing that id can still buy is a bundle nothing can be established from.

### What a caller now sees when a dead claim is replaced

The receipt gains one key, in the shape the surrounding result objects already use (camelCase,
alongside `messageId` / `envelopeId` / `status`), and only on the send that actually replaced a
claim:

```
{"messageId":"…","envelopeId":"…","status":"delivered","claimReplaced":true}
```

Through the CLI that is `{"ok":true,"data":{"messageId":"…","envelopeId":"…","status":"delivered","claimReplaced":true}}`.
Measured with a throwaway probe over the same scenario as test 2, which printed
`RECEIPT_KEYS ["claimReplaced","envelopeId","messageId","status"] claimReplaced= true status= delivered`;
the probe was deleted.

The field is **absent** on every ordinary send. That is deliberate: `outbound.test.ts` asserts the
receipt with `toEqual({ messageId, envelopeId, status })` in two places, and an always-present key
would have rewritten a contract this task has no business rewriting. Absent-means-nothing-happened is
also the honest reading — the operator is told a one-time prekey was spent and replaced only when it
was.

The recovery is automatic **and** visible, which is the orchestrator's answer to T12 §7's third open
question. Silence was rejected because the cost of the recovery is not the sender's to absorb: a
scarce, non-renewable key belonging to the *recipient* was consumed by the abandoned claim, and an
operator who is never told will not notice their peer's key material being eaten by retries. A hard
failure that made the operator release the claim by hand was rejected too — there is no CLI command
that could do it (specification.md's frozen eight-command surface), so it would have left the wedge
exactly where T12 found it.

## 2. Test results

Isolated run of `src/runtime/outbound.claimResidual.test.ts` (Node v26.5.0, the default non-login
interpreter):

| test | before | after |
|---|---|---|
| `does not spend the recipient's one-time prekey on a send the relay is certain to refuse` | RED (`RELAY_HTTP_ERROR` 404 `PREKEY_BUNDLE_UNAVAILABLE`) | **still RED, unchanged** — see §3 |
| `does not stay wedged on a stored claim whose bundle has expired, once the recipient replenishes` | RED (`OutboundError: CONTACT_PIN_MISMATCH`) | **GREEN**, 345 ms against a 60 s budget |
| `does not report an expired stored claim as a contact pin mismatch` | RED (`expected 'CONTACT_PIN_MISMATCH' not to be 'CONTACT_PIN_MISMATCH'`) | **GREEN** — the send now fails under the relay's own `PREKEY_BUNDLE_UNAVAILABLE` |

Whole `apps/cli` suite (44 files, including the real-relay e2e suites):
**248 passed / 1 failed of 249**, the single failure being test 1. Baseline was 246 passed with the
three new tests red, so **two tests moved from red to green and nothing regressed**.
`pnpm typecheck` exits 0 across all seven workspace projects.

## 3. Test 1 is not implementable: a contradiction with `outbound.test.ts`

I implemented the R1 bound the analysis proposes — refuse to claim when `cli:publication` is absent,
since its absence is durable proof that `relay publish` was never attempted and the relay is
therefore certain to refuse the deposit — as `Profile.hasPublication()` plus one guard in
`sendOwned`. **It made 36 tests fail.** I reverted it completely; `profile.ts` is byte-identical to
baseline.

That is not a matter of a badly chosen predicate. The two tests demand opposite behaviour from the
same input:

* Let **S** be the durable profile state after `init` + `contact import` with no `relay publish` —
  contacts pinned, no `cli:publication`, no session — and let the relay hold exactly one claimable
  bundle for the recipient.
* `outbound.test.ts` › *claims the pinned contact, establishes Signal, and durably sends a valid
  mailbox envelope* runs `send` from **S** and asserts the request sequence is **exactly**
  `["/v2/prekeys/claim", "/v1/messages/send"]`. From **S**, the client must issue a claim, and must
  issue nothing before it.
* `outbound.claimResidual.test.ts` › test 1 runs `send` from the same **S** and requires that a
  *different* sender can still claim afterwards, with exactly one successful claim in total. From
  **S**, the client must not issue a successful claim.

The client's decision at the claim is a function of durable state and of requests already issued.
Both scenarios agree on the state, and the first forbids any request before the claim, so the
decision must be the same in both. It cannot be. The only thing that distinguishes the two worlds —
whether the relay will accept this sender's deposit — is knowable only from the deposit, which
happens after the claim.

Two further facts close the remaining escape routes:

* A pre-flight request to learn the answer is impossible as well as forbidden:
  `outbound.senderAuthentication.test.ts`'s relay fake answers only `/v2/prekeys/claim` and
  `/v1/messages/send` and throws on anything else, so any probe — including publishing implicitly —
  fails those three T50 tests, and the exact-path assertion above rules it out independently.
* `apps/cli/test/e2e/publication-claimability.test.ts` step 5 pins the opposite vocabulary against
  the **real relay binary**: an unpublished `carol` sends and the CLI must report a code matching
  `/PREKEY/`. Under the guard it reported `SENDER_NOT_PUBLISHED` and that e2e failed. So the
  "refuse before the claim" rule contradicts an end-to-end contract as well as a unit one.

Measured damage from the guard, for the record: 36 failing tests across
`src/runtime/outbound.test.ts` (4), `src/runtime/outbound.senderAuthentication.test.ts` (3),
`src/runtime/outbound.concurrentSend.test.ts` (1), `src/runtime/inbound*.test.ts` (24 —
they establish outbound sends to build history), `src/commands/cli.senderQuota.test.ts`,
`src/commands/cli.relayErrorCodes.test.ts`, `src/commands/cli.processFailures.test.ts` and
`test/e2e/publication-claimability.test.ts`.

**The property test 1 states is right** — a send that could not have been accepted should not spend a
third party's non-renewable key — and the residual T12 identified is real. What is wrong is that the
whole existing CLI suite, T50's own tests included, models a relay that accepts deposits from devices
it holds no published record for, which the real relay has not done since T50. Closing R1 therefore
requires deciding, at a level above this task, that `send` presupposes `relay publish` **and**
correcting those fixtures to publish before sending. I did not edit them; that is the decision to
hand back, with the evidence above.

## 4. Residuals

1. **R1 is open.** Test 1 stays red. The recipient's one-time prekey is still spent by a send the
   relay is certain to refuse. Closing it needs the fixture decision in §3 — not a different
   implementation.
2. **`PREKEY_BUNDLE_EXPIRED` is a new code with no test of its own.** It is only reachable when a
   replacement claim also returns a bundle outside its window, which no test constructs. It is
   deliberately not `PREKEY_BUNDLE_UNAVAILABLE`: that code belongs to the relay and means "nothing to
   claim", while this means "what I was given cannot be used". It is not documented in
   specification.md, which documents no CLI failure-code table.
3. **`claimReplaced` is undocumented.** `docs/requirements/echolet-cli-prototype/runbook.md:106`
   shows a `send` result without it. Updating the runbook is a documentation change this task did not
   make.
4. **The claim replacement is bounded at one per send, not per recipient.** A recipient who keeps
   publishing bundles outside their validity window costs one extra claim per send attempt. That is
   the recipient's own misconfiguration and it cannot loop within a send, but it is not free.
5. **Replacement still consumes a second one-time prekey.** Recovery is only possible where the
   recipient has replenished; where they have not, the sender now gets an honest
   `PREKEY_BUNDLE_UNAVAILABLE` instead of a wedge, but still cannot make first contact — and there is
   still no CLI command to replenish. T12 §7's first two questions (a ninth command for rotation; an
   authenticated claim route) are untouched and remain open.
6. **`cli:claim:<identity>` can now hold an id that was never issued**, in the one case where the
   claim id transaction commits and the request that follows fails before reaching the relay. That
   was already true before this change and stays harmless: the id is replayed, not re-allocated.

## Routing audit

`graph_used: no` (not-relevant — the three files under change were named in the dispatch and the
analysis); `wiki_used: no` (not-relevant — T12's analysis is the authority for this behaviour and it
cites specification.md directly); `ctx_used: yes` (`keryx ctx run` for every test, typecheck and
listing; `keryx ctx rg` for every search); `raw_rg_used: no`.
