# T33 implementation report (GREEN phase)

Flow: `001-2026-09-05-echolet-assessment-fixes`
Dispatch: `001-T33-implement` (task-implementer, dispatched by flow-orchestrator)
Scope: `apps/cli` production code plus a minimal additive one-time-prekey rotation capability in
`packages/session-node`. `apps/relay` was not touched. No test file was created, edited, skipped
or deleted.

## Files changed

| File | Change |
|---|---|
| `packages/session-node/src/SignalClient.ts` | one-time prekey pointer + `rotateOneTimePreKey()` |
| `apps/cli/src/runtime/profile.ts` | `PersistenceError`, single `transact()` store boundary, `publicationBundle()`, `rotatePublicationBundle()`, extracted `signBundle()` |
| `apps/cli/src/runtime/outbound.ts` | durable publication bundle, `rotateBundle()`, persistence passthrough, in-transaction outbox recheck |
| `apps/cli/src/runtime/inbound.ts` | persistence passthrough |
| `apps/cli/src/commands/cli.ts` | bounded interactive confirmation reader, persistence classification |

---

## F-001 (major) — publication retry regenerated the bundle around the same reserved prekey

`outbound.ts:33` used to call `profile.exportContact()` on every publish, which allocates a new
`bundle_id` (and a new `created_at_ms`/`expires_at_ms`) around the *same* `pre:1` one-time prekey.
Under the relay's permanent OTK uniqueness contract a retry after a lost publish response could
therefore never be accepted.

**New durable record.** Key `cli:publication` inside the encrypted profile store, shape:

```
{ "version": 1, "bundle": <the exact signed SignalPreKeyBundleV2 as submitted> }
```

The bundle is stored with `z.custom` (`publicationSchema`), i.e. structurally validated but never
reconstructed, exactly like the existing `device_record` handling — the v2 signature covers the
original nested property ordering, so a reconstructed object would not round-trip byte-identically.

* `Profile.publicationBundle()` returns the stored bundle if present, otherwise signs one and
  commits it **before** returning — so the record is durable before the first network call.
* `OutboundMessenger.publish()` now submits that record. Retries and process restarts resubmit the
  identical bytes (same `bundle_id`, same one-time prekey, same validity window).
* `OutboundMessenger.rotateBundle()` is the separate explicit allocation. It calls
  `Profile.rotatePublicationBundle()`, which generates a genuinely new one-time prekey and then
  signs and stores a new bundle. Nothing else in the code path ever allocates a fresh bundle.

The stored bundle is never rendered into diagnostics, errors or logs; it only ever travels to
`RelayClient.publishBundle()`.

### session-node rotation addition (minimal, additive)

`SignalClient` previously read `pre:1` unconditionally and had no rotation entry point.

* New pointer record `pre-current` (a JSON number) names the one-time prekey currently offered by
  `publicBundle()`. **Absent means `1`**, so every existing store and every newly created store is
  unchanged on disk — the pointer is only written by rotation.
* `publicBundle()` reads `pre:${currentOneTimePreKeyId(tx)}` instead of the literal `pre:1`.
* `SignalClient.rotateOneTimePreKey()` allocates the next unused `pre:<n>` (max of the pointer and
  every existing `pre:` id, plus one; bounded by `0xffffff`), stores the new `PreKeyRecord` and
  repoints `pre-current`. **Previous prekey records are retained**, so in-flight PreKey sessions
  that referenced the old id still resolve. No existing behaviour, record format or public method
  signature was changed.

Because rotation runs through `within(tx)`, it participates in the caller's profile transaction:
the new prekey and the new signed bundle commit atomically or not at all.

---

## F-002 (major) — interactive confirmation waited for stdin EOF

`cli.ts:144` iterated `process.stdin` until end of stream, so a user typing `yes` + Enter in a
terminal was never released.

`readConfirmation()` is now an explicit bounded reader that settles on the **first** of:

* a `\r` or `\n` terminator (the answer is the text before it),
* end of input without a terminator,
* an answer longer than 16 characters (rejected).

On settling it removes its `data`/`end`/`error` listeners, calls `pause()` and — when the handle
supports it (a pipe/TTY does, a file-backed stdin does not) — `unref()`, so the process is free to
exit while the parent still holds the write end of the pipe open. The accept predicate
(`/^(?:y|yes)$/i` on the trimmed answer) is unchanged.

---

## F-003 (major) — post-open SQLite failures were rewritten into trust/protocol errors

A SQLite failure occurring after the profile store had opened (for example a concurrent
`BEGIN IMMEDIATE` holder with `busy_timeout = 0`) surfaced as an untyped `Error`, which the runtime
catch blocks rewrote into `OUTBOUND_REJECTED` / `INBOUND_REJECTED` / `INVALID_CONTACT_CARD` and
exit 3, while the documented result for a local persistence failure is exit 5.

**Typed boundary.** `apps/cli/src/runtime/profile.ts` now exports `PersistenceError`
(`code = "PERSISTENCE_FAILURE"`) and routes **every** profile store transaction through one private
helper:

```
Profile.transact(operation)
  -> store.transaction(tx => { try { return await operation(tx) } catch (e) { raised = {error: e}; throw e } })
     .catch(e => { if (raised && Object.is(raised.error, e)) throw e; throw new PersistenceError() })
```

The discrimination is by *origin*, not by message: a rejection raised by the operation callback is
rethrown with its own type, and only a rejection produced by the store machinery itself (a failed
`BEGIN IMMEDIATE`, a failed commit, a failed snapshot read/decrypt) becomes `PersistenceError`.
`mailboxAuthorization`, `withRuntime`, `exportContact`, `publicationBundle`,
`rotatePublicationBundle`, `importContact`, `listContacts` and `summary` all go through it.

**Preservation through the catch blocks.**

* `outbound.ts` `serial()` and `inbound.ts` `serial()` now let `PersistenceError` pass through
  instead of collapsing it into `OUTBOUND_REJECTED` / `INBOUND_REJECTED`.
* `cli.ts` contact import (`catch { throw trustFailure("INVALID_CONTACT_CARD") }`) rethrows
  `persistenceFailure()` for a `PersistenceError` — a storage failure is not a trust decision about
  the card.
* `cli.ts` `classify()` maps `PersistenceError` to the redacted `PERSISTENCE_FAILURE` / exit 5
  before the `ProfileError` / `InboundError` branches.

Exit 5 was **not** widened: typed validation (forged device-record signature), typed trust
(unpinned recipient) and native decrypt failures still originate inside the operation callback, keep
their own types, and still map to exit 3. The suite's green control test asserts exactly that and
still passes.

---

## F-008 (blocker) — outbox lookup outside the mutation transaction

`outbound.ts:41` read `cli:outbox:<message-id>` in its own transaction and `:68` mutated in another,
so two instances could both observe "no record" and both commit — two envelope ids and two history
entries for one logical message.

`sendOwned()` now re-reads and validates the outbox **inside** the encrypt/history transaction, as
its first action:

* if the record already exists, it is returned without encrypting again, without allocating an
  envelope id and without appending history;
* the returned record is reconciled by the new `settle()` helper, which raises
  `MESSAGE_ID_CONFLICT` for a different `contentHash` and otherwise delivers idempotently;
* the pre-transaction lookup is retained purely as an optimization (it now also delegates to
  `settle()`), so the common already-delivered case still avoids the heavier transaction.

### Anti-vacuity evidence (mandatory)

After the suite was green, only the in-transaction recheck was neutralised (the
`tx.get(keyFor(input.messageId))` read replaced by a constant `undefined`, everything else including
the barrier and the outer lookup untouched) and
`vitest run src/runtime/outbound.concurrentSend.test.ts` was re-run. It failed again with exactly
the three original soft assertions:

```
expected [ …(2) ] to have a length of 1 but got 2     (history entries, :180)
expected [ …(2) ] to have a length of 1 but got 2     (relayed envelope ids, :182)
expected 'aaaaaaaa-…' to be 'bbbbbbbb-…'              (envelopeId equality, :183)
```

The barrier therefore still fires under the fix; the test is not passing because the stale-read
event stopped occurring. The recheck was then restored and the file re-verified green.

---

## Verification

| Check | Result |
|---|---|
| `outbound.publish.test.ts`, `cli.processFailures.test.ts`, `outbound.concurrentSend.test.ts` | 12/12 passed, unmodified |
| `pnpm --filter @echolet/cli test` (includes `test/e2e/two-process.test.ts`) | 49/49 passed |
| `pnpm test` (workspace) | protocol 8, client-db 1, crypto-core 4, client-core 2, session-node 24, mobile 6, cli 49 — all passed |
| `pnpm typecheck` (workspace, 7 projects) | passed |
| `pnpm lint` | no package defines a `lint` script |

One flake was observed and is recorded rather than hidden: on the first full `apps/cli` run,
`test/e2e/two-process.test.ts` run 3 failed with `CLI send exit (INVALID_ARGUMENTS): expected 2 to
be 4`. `INVALID_ARGUMENTS` is raised only by `parseCommand()`/`required()`, neither of which this
change touches, and the same file passed in isolation and in two subsequent full runs. The likely
cause is the pre-existing race between `cli.test.ts` (`pnpm run build`) and
`two-process.test.ts` (`pnpm --filter @echolet/cli build`), which build the same `dist/cli.js`
concurrently while both spawn it. Filed as a concern for the verifier, not fixed here.
