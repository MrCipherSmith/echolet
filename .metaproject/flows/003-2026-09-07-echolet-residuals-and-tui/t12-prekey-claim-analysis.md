# T12 — how the prekey claim and the mailbox deposit actually relate

Flow 003, task T12 (tests-creator). Tests only; no production file was changed.
Everything below was established by reading the tree at this commit and by running
measurements locally. No connection was made to `geekom` or `depr`.

File identity by SHA-256 (not mtime):

| file | sha256 |
|---|---|
| `apps/cli/src/runtime/outbound.claimResidual.test.ts` (new) | `56285ada4a242f160b1c6ae04dfdf4e6baedcfe896b31b6cfde3393abf6d6714` |
| `apps/cli/src/runtime/outbound.ts` (unchanged) | `07c3960bec152ba640e1f5077710a5273e8112978434e5098e48bdaeafcd8454` |
| `apps/cli/src/runtime/profile.ts` (unchanged) | `29c654f22cea55d525e7b6caf544dd18b2efc52e794b571e0220cefec15a851e` |
| `apps/relay/internal/storage/repository/signal_prekey_bundle_v2.go` (unchanged) | `48f02d2d03fc9ba04b1c3adbdae5ba483d7d1fe1e41fd774427006b7bef44096` |
| `apps/relay/internal/storage/repository/prekey_bundle_v2_test.go` (unchanged) | `44e4c27da8a274d29496c3ab07a97fcb2b0e1685d7057c280829fdcda580a91d` |
| `apps/cli/src/runtime/outbound.test.ts` (unchanged) | `de0b4877d5af612bae352eba217250e1a646aa497933d2e11d5036d0218c7d98` |

---

## 1. The two steps, established

**They are two separate client-issued requests, not one request doing two things.**
`OutboundMessenger.sendOwned` (`apps/cli/src/runtime/outbound.ts`) issues
`POST /v2/prekeys/claim` (line 62), then commits the envelope locally, then issues
`POST /v1/messages/send` from `deliver()` (line 117). The relay registers the two
routes independently and with no shared transaction
(`apps/relay/internal/api/router/router.go:91` and `:98`).

**The failure T11 hit is server-side, on the second request, after the first had
committed.** The T11 report (§10.1) records
`{"ok":false,"error":{"code":"UNAUTHORIZED_MAILBOX_ACCESS"}}` on the deposit: since
T50 the relay authenticates a send against an already-published, root-signed device
record, and that sender profile had run `init` and `contact import` but never
`relay publish`. `cli.ts:40-46` documents this exact precondition. The claim had
already succeeded, because **nothing on the claim route depends on the claimant
having published anything** — `/v2/prekeys/claim` carries no authentication at all.

Reproduced locally (measurement D, throwaway): a profile that has never run
`relay publish` sends, and the recorded relay path sequence is
`['/v2/prekeys/claim', '/v1/messages/send']`, ending in
`RELAY_HTTP_ERROR httpStatus 403 remoteCode UNAUTHORIZED_MAILBOX_ACCESS`. The
recipient's one-time prekey is spent by a send that could not possibly have been
accepted.

## 2. The claim is legitimately permanent. A rollback would be wrong.

The reservations were made permanent deliberately, and the reasons still hold:

- `SaveSignalV2` writes two permanent one-time-prekey tombstones — a hash of the
  `(identity_id, device_id, signal_identity_key, key_id)` tuple and a hash of the
  public key — and `specification.md` states that expiry, a previous claim, and a
  relay restart never release them.
- `ClaimSignalV2` binds the exact bundle bytes to the `claim_id` so a retry replays
  them, and marks the bundle claimed and deletes the availability entry in one
  transaction so two claim ids can never reach the same one-time prekey
  (AC-02, AC-02b; `prekey_bundle_v2_test.go`
  `TestSignalPreKeyBundleV2ConcurrentClaimsAllocateExactlyOnce` and
  `TestSignalPreKeyBundleV2ClaimReplayIsExactAndSelectorBound`).

Releasing a claim because a later deposit failed would hand one Signal one-time
prekey to two senders. The relay also cannot know the deposit failed: the sender may
still deliver from its durable outbox minutes or days later, using the very bundle a
rollback would have re-offered. **No rollback test is written, and the existing Go
tests that forbid one are left untouched** — they are the standing guard against a
future "fix" of that shape.

## 3. Measured: the relay is not where the residual is

Throwaway Go test against the real `PreKeyBundleService`/`PreKeyBundleRepository`
over real Badger, using the already-present but until now unused `independent_bundle`
fixture variant in `packages/protocol/src/types/fixtures/relay-v2.json` (new
`bundle_id`, new one-time prekey key id and public key, re-signed):

```
publish primary:              claimable=true  err=<nil>
claim A:                      got=true        err=<nil>
claim B before replenish:                     err=PREKEY_BUNDLE_UNAVAILABLE
republish identical:          claimable=false err=<nil>
publish independent_bundle:   claimable=true  err=<nil>
claim B after replenish:      matchesRotated=true err=<nil>
claim A replay:               matchesPrimary=true err=<nil>
```

So replenishment already works end to end on the relay, and the earlier claim id
keeps replaying its own bundle afterwards. Nothing on the relay side is red, which is
why this task adds no Go test.

## 4. Measured: the same sender's own retry already recovers

Two throwaway CLI measurements:

- **Deposit rejected 403, same profile retries.** Recorded paths across both
  attempts: `['/v2/prekeys/claim', '/v1/messages/send', '/v1/messages/send']` — one
  claim id in total. The retry goes through the durable outbox record and never
  re-claims, so it cannot answer `PREKEY_BUNDLE_UNAVAILABLE`.
- **Claim response lost, same profile retries.** The two claim requests carry the
  *identical* `claim_id`, because `sendOwned` writes `cli:claim:<identity>` durably
  *before* issuing the claim and deletes it only in the transaction that commits the
  envelope. The retry delivered.

`outbound.test.ts` "keeps an ambiguous send pending and reuses byte-identical IDs,
ciphertext, and envelope after restart" already covers the analogous path.
**This is the pin the brief asked for as "a retry of the same failed send by the same
sender must be able to succeed", and it is already GREEN.** No test is added for it,
because a green test would violate the RED-only constraint; it is recorded here as a
measured fact instead.

The T11 retry failed not because this path is broken but because that retry was made
from a **different profile**: §9 of the T11 report says each demo store key lived only
in the environment of the process that used it, so the second attempt was a new
identity — a genuinely different first-contact sender, facing the documented
one-bundle-one-sender limit.

## 5. What is actually wrong: two missing bounds on the client

Both turn an operator-fixable or transient condition into a permanent denial of first
contact, for a recipient who has **no CLI command to replenish**.

### R1 — the irreversible step is taken before the reversible preconditions are checked

`sendOwned` claims the recipient's scarce, non-renewable one-time prekey before
anything has established that this profile's own deposit can be accepted. The profile
already knows locally: `cli:publication` is written by `Profile.publicationBundle()`,
which only `publish()` calls, so its absence means `relay publish` has never even been
attempted, and the relay is certain to refuse. Today the CLI finds out one request too
late, and the recipient pays for it.

Note the same asymmetry at the relay: `/v2/prekeys/claim` is unauthenticated, so any
party that can reach the relay and knows an identity id can consume that identity's
first-contact bundle without ever being able to send anything. That is a design
question (§7), not something these tests assert.

### R2 — a stored claim is never released, even when it has become dead

The durable `cli:claim:<identity>` key is what makes a lost claim response
recoverable, and it must stay. But it is only ever deleted on success. If the sender
comes back after the claimed bundle's validity window has closed, the relay replays
that bundle exactly (correctly — replay must be byte-exact for idempotency), the
client's `importVerifiedSignalBundleV2` refuses it as "Bundle is not currently valid",
and the CLI is wedged against that recipient **forever**, even while a fresh,
claimable publication sits on the relay. Measured: the second attempt issues a claim
with the same `claim_id` and ends in `OutboundError: CONTACT_PIN_MISMATCH`.

The diagnosis is wrong as well as the outcome. `sendOwned` funnels every failure of
the verification block into `CONTACT_PIN_MISMATCH`, so an expired prekey is reported
to the operator as *your peer may be an impostor*, when the pinned identity, device,
device key and Signal identity key all still match and only the window has closed.
`cli.ts:26-29` states the project's own rule: the failure vocabulary should grow
"where flattening actively misleads".

## 6. The tests

`apps/cli/src/runtime/outbound.claimResidual.test.ts`, three tests, all RED on their
own assertion in 221–477 ms against 60 s budgets (so none is a timeout), typecheck
clean, and the other 109 tests in `src/runtime`, `src/transport` and `src/commands`
all still pass.

1. **`does not spend the recipient's one-time prekey on a send the relay is certain to
   refuse`** — R1, stated as an outcome rather than a mechanism: after an unpublished
   sender's doomed attempt, a *different*, properly published sender must still be
   able to first-contact the same recipient.
   RED: `promise rejected "RelayError: RELAY_HTTP_ERROR { …(4) }" instead of
   resolving`, `Serialized Error: { code: 'RELAY_HTTP_ERROR', retryable: false,
   httpStatus: 404, remoteCode: 'PREKEY_BUNDLE_UNAVAILABLE' }`.
2. **`does not stay wedged on a stored claim whose bundle has expired, once the
   recipient replenishes`** — R2.
   RED: `promise rejected "OutboundError: CONTACT_PIN_MISMATCH { code: '…' }" instead
   of resolving`.
3. **`does not report an expired stored claim as a contact pin mismatch`** — R2's
   diagnosis half, with nothing left to replenish it, so the honest answer is the
   exhausted-recipient condition the CLI already carries under the relay's own code.
   The assertion is deliberately negative and prescribes no replacement code.
   RED: `expected 'CONTACT_PIN_MISMATCH' not to be 'CONTACT_PIN_MISMATCH'`.

The relay behaviour they run against is modelled in-file from the measurements in §3
and §1 — one claimable publication, permanent consumption, exact replay by `claim_id`,
404 when nothing is available, 403 `UNAUTHORIZED_MAILBOX_ACCESS` for a deposit from an
unpublished device, and **no authentication on the claim route**, because pretending
otherwise would hide the very ordering test 1 is about.

**Achievability was verified, tests-only.** A throwaway probe reproduced test 2's
scenario and, in place of any production change, deleted the dead `cli:claim:` key
from the profile store before the retry. The existing client then claimed the
replenished bundle and delivered. So the target state is reachable; the tests are not
structurally unsatisfiable. The probe was deleted.

No store key, private key, plaintext or HTTP request body is asserted on or printed in
any of the three tests: the assertions carry request paths, error codes and booleans
only.

## 7. The design question, handed back rather than answered

**The claim is legitimately permanent. What is missing is a reachable way to
replenish — and the product deliberately does not have one.**

`specification.md` states it plainly: "through the CLI, a published bundle serves
exactly one first-contact sender; the CLI has no command to allocate a fresh one-time
prekey… The capability exists in the codebase (`OutboundMessenger.rotateBundle()`, and
`retryPending()` alongside it) and is deliberately unreachable, because a ninth
command would change the frozen CLI surface this prototype validates."

The two bounds in §5 shrink the window in which a bundle is wasted; they do not remove
it. A recipient's bundle is still consumed by the first sender who claims it, and once
consumed the recipient cannot restore first contact without a command that does not
exist. On top of that the claim route is unauthenticated, so consumption is not even
limited to parties who could plausibly have sent something.

Three questions, none of which this task answers:

1. **Does the frozen eight-command surface get a ninth entry point for rotation?**
   The capability, its tests and its relay support all already exist; only the command
   is missing. Leaving it out is defensible for a validated prototype and indefensible
   for anything an operator has to run.
2. **Should `/v2/prekeys/claim` authenticate the claimant?** Today any reachable party
   who knows an identity id can permanently consume that identity's first-contact
   bundle without being able to deliver anything. That is a denial-of-first-contact
   primitive, cheap and silent. Closing it is a protocol change and belongs in a
   design decision, not in a test.
3. **What should a send do when its stored claim is dead?** Test 2 pins the outcome
   "the sender can still reach a recipient who replenished", which the obvious fix
   (release the dead claim, claim once more) satisfies. If instead the decision is that
   a dead claim must be surfaced to the operator rather than silently re-claimed, test
   2 is the one to revisit — test 3 holds either way, since it only forbids calling an
   expired bundle a trust violation.
