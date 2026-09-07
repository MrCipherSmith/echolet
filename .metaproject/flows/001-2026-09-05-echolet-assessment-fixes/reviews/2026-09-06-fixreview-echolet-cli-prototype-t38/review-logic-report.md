# T38 fix review — review-logic (F-001, F-002, F-003, F-008, F-013)

Run `001` · Dispatch `001-T38-review-logic` · Date 2026-09-06
Project root `/Users/Goodea/goodea/projects/echolet`

## Review scope

- Branch: `main` (unborn — no commits). `git diff` is empty by construction; the
  **working tree** was reviewed against the T28 finding evidence.
- Files read in full: `apps/cli/src/commands/cli.ts`, `apps/cli/src/runtime/profile.ts`,
  `apps/cli/src/runtime/outbound.ts`, `apps/cli/src/runtime/inbound.ts`,
  `apps/cli/src/runtime/history.ts`, `apps/cli/src/transport/relayClient.ts`,
  `packages/session-node/src/EncryptedSqliteStore.ts`,
  `packages/session-node/src/SignalClient.ts` (bundle/rotation region),
  `packages/protocol/src/types/signalPreKeyBundleV2.ts` (schema region),
  plus the four fix-wave test files and `docs/requirements/echolet-cli-prototype/specification.md`
  (command surface, exit codes, relay v2 publish contract).
- Bounded read-only probe: Node `parseArgs` behaviour under `strict: true` for the exact
  argv shapes the fix relies on (scratchpad only; no repository file created or modified).
- The verification matrix was **not** re-run (T37 owns that).

## Summary

All five assigned findings are **fixed**. Each fix addresses the root cause rather than the
symptom, each is reachable from the CLI command surface, and none was obtained by weakening a
test or loosening a schema. No blocker and no major defect was introduced. Two minor/info
observations are recorded below; neither blocks acceptance of the fix wave.

### Stats

- blocker: 0 | major: 0 | minor: 1 | info: 3

### Dispositions

| Finding | Original severity | Disposition |
|---|---|---|
| F-001 publication retry regenerates the bundle | major | **fixed** |
| F-002 confirmation waits for stdin EOF | major | **fixed** |
| F-003 persistence failure classified as exit 3 | major | **fixed** |
| F-008 concurrent same-id send duplicates history/envelope | blocker | **fixed** |
| F-013 dash-leading option values rejected | blocker | **fixed** |

---

## F-001 — durable publication bundle · **fixed**

**What the fix is.** `Profile.publicationBundle()` (`apps/cli/src/runtime/profile.ts:137-145`)
reads `cli:publication`; on a hit it returns the stored bundle, on a miss it signs one and
`tx.set`s it inside the same transaction before returning. `OutboundMessenger.publish()`
(`apps/cli/src/runtime/outbound.ts:34`) is the only consumer.

**Durability before the first network call.** `publicationBundle()` runs through
`Profile.transact` → `EncryptedSqliteStore.perform`, which executes `this.write(records)` and
`this.db.exec("COMMIT")` **synchronously before resolving**
(`packages/session-node/src/EncryptedSqliteStore.ts:74-76`), with `PRAGMA synchronous = FULL`
(`:25`). `publish()` awaits that promise before calling `relay.publishBundle`, so the record is
committed to disk before any HTTP request exists.

**Byte-identity across retries and restarts.** The stored value is validated by `publicationSchema`
(`profile.ts:45-48`), whose `bundle` is a `z.custom` — zod returns the *same object reference*,
so nothing is reconstructed or reordered. `SignalPreKeyBundleV2Schema`'s `device_record` is
likewise `z.custom` (`packages/protocol/src/types/signalPreKeyBundleV2.ts:38-50`), so the nested
DeviceRecord ordering survives the JSON round-trip that a restart forces. `RelayClient.validate`
(`apps/cli/src/transport/relayClient.ts:73-77`) then applies the *same* deterministic
`JSON.parse(JSON.stringify(zod-parsed))` normalisation on every attempt, so identical values
produce identical request bytes. `apps/cli/src/runtime/outbound.publish.test.ts:77-103` pins this
with a lost response plus a full messenger restart and asserts `retry.bodyText === original.bodyText`
as a boolean (no bytes rendered); `:105-119` pins the repeat-of-a-success case.

**`rotateBundle()` cannot be reached implicitly.** `publish()` calls only `publicationBundle()`,
which never calls `rotatePublicationBundle()` and never calls `client.rotateOneTimePreKey()`.
`rotatePublicationBundle()` (`profile.ts:151-160`) has exactly one caller, `outbound.ts:36`, and
that method has no caller in `apps/cli/src` at all. Enumerated by
`keryx ctx rg "rotateBundle|rotatePublicationBundle|rotateOneTimePreKey|publicationBundle"` —
13 matches over 7 files, complete: the only non-definition references are `profile.ts:155`,
`outbound.ts:34`, and `outbound.publish.test.ts:131`.

**Backward compatibility of the session-node addition.** `currentOneTimePreKeyId`
(`packages/session-node/src/SignalClient.ts:58-72`) returns `1` when the `pre-current` pointer is
absent, and `"pre-current"` does not collide with the `pre:` prefix scanned by
`rotateOneTimePreKey` (`:270`). Existing stores and freshly created stores are unchanged on disk.

---

## F-002 — bounded interactive confirmation · **fixed**

`readConfirmation()` (`apps/cli/src/commands/cli.ts:191-220`) settles on the **first** of three
events: a `\r`/`\n` found by `answer.search(/[\r\n]/)` (`:210-211`), an answer exceeding
`answerLimit = 16` (`:212`), or `end`/`error` (`:214`). `release()` is idempotent via `done`,
detaches all three listeners, pauses stdin and `unref()`s the handle when it supports it
(`:197-207`), so the process can exit while a terminal still holds the write end open. The
accept predicate `/^(?:y|yes)$/i` on the trimmed answer (`:183`) is unchanged from the original.

`apps/cli/src/commands/cli.processFailures.test.ts:163-203` exercises all four shapes at the
process level with `keepStdinOpen: true` (the parent end deliberately left open) and asserts
`timedOut: false` in every case, including the EOF-without-newline path that the pre-fix code
depended on.

---

## F-003 — persistence classification by origin · **fixed**

**Store-machinery failure cannot be misclassified as a domain error.** `Profile.transact`
(`profile.ts:76-85`) captures the operation's own rejection in `raised` and rethrows it; only a
rejection produced by `store.transaction` that is *not* that object becomes `PersistenceError`.
The named F-003 scenario reaches it: with `busy_timeout = 0` (`EncryptedSqliteStore.ts:25`),
`db.exec("BEGIN IMMEDIATE")` at `:61` throws **before** `perform`'s `try` block, so `raised`
is `undefined` and `transact` produces `PersistenceError`. Both runtime queues let that type
through untouched (`outbound.ts:27`, `inbound.ts:24`), contact import re-raises it as
`persistenceFailure()` rather than a trust verdict (`cli.ts:274`), and `classify` maps it to
`PERSISTENCE_FAILURE` / exit 5 **before** the `OutboundError`/`InboundError`/`ProfileError`
branches (`cli.ts:325` vs `:328-329`). Three process-level scenarios pin this
(`cli.processFailures.test.ts:205-261`), each using a real second SQLite connection holding
`BEGIN IMMEDIATE`.

**A domain error cannot be swallowed as `PERSISTENCE_FAILURE`.** This is the direction that
matters and it holds by control flow. `EncryptedSqliteStore.perform` rethrows the *identical*
error object it caught (`:77-79`), so `Object.is(raised.error, error)` is true for every
rejection originating inside the callback, and `transact` rethrows the original type.
`OutboundError("CONTACT_PIN_MISMATCH")` raised **inside** the mutation transaction
(`outbound.ts:74`) therefore still reaches `classify` as an `OutboundError` → exit 3, and so does
a native libsignal decrypt failure raised inside `accept()` (`inbound.ts:70`) → `INBOUND_REJECTED`
→ exit 3. `cli.processFailures.test.ts:263-302` is the control: forged device-record signature
(exit 3, `INVALID_CONTACT_CARD`), unpinned recipient (exit 3, `CONTACT_NOT_TRUSTED`) and native
decrypt failure (exit 3, `INBOUND_REJECTED`, with an explicit `expect(polled.code).not.toBe(5)`).

**Exit 5 was not widened and exits 2/3/4 were not narrowed.** `classify` (`cli.ts:323-331`) is
unchanged apart from the inserted `PersistenceError` branch; `RelayError` still splits 4/3 on
`retryable` (`:327`), `OutboundError("INVALID_MESSAGE")` still maps to 2 (`:328`), and the
terminal `return persistenceFailure()` (`:330`) was already the pre-existing default. The
`ConfigurationError` branch precedes `RelayError`, so configuration errors keep exit 2.

The only reachability caveat I looked for and could not construct: `perform`'s catch runs
`db.exec("ROLLBACK")` before rethrowing (`:78`), so a ROLLBACK that itself threw would replace a
domain error with a store error and yield exit 5. After a *domain* throw no SQL statement has
failed, the transaction opened by `BEGIN IMMEDIATE` is still active, and ROLLBACK needs no lock at
`busy_timeout = 0`; I could not name an input that reaches it, so this is recorded as an
observation, not a finding.

---

## F-008 — in-transaction outbox recheck · **fixed**

**The recheck is inside the same transaction that encrypts and writes history.** The mutation
transaction opens at `outbound.ts:69` (`profile.withRuntime`), and `tx.get(keyFor(input.messageId))`
is its **first statement** (`:71`), before the pin check (`:73`), `client.encrypt` (`:76`), the
envelope construction (`:79`), `tx.set` of the outbox record (`:86`) and `appendHistory` (`:87`).
`Profile.withRuntime` routes through the single `store.transaction` boundary, and
`EncryptedSqliteStore.perform` snapshots state with `this.read()` *after* `BEGIN IMMEDIATE`
(`:61-64`), so the recheck observes any commit that landed while the claim was in flight.
The pre-transaction lookup at `:45` is now explicitly labelled and used only as an optimisation.

**Returning the persisted record cannot skip a required state transition.** The `existed: true`
branch returns through `settle()` (`:91`, `:94-97`), which raises `MESSAGE_ID_CONFLICT` on a
`contentHash` mismatch and otherwise falls into `deliver()`. `deliver()` (`:98-109`) short-circuits
only when `record.status === "delivered"`; a `pending` record still runs `client.retry`, the
ciphertext equality check, `relay.sendEnvelope` and the `pending → delivered` write. So the early
return skips re-encryption, envelope allocation and the history append — and nothing else.
History sequence allocation stays inside the same transaction (`history.ts:10-17`).

**The test is not vacuous.** `outbound.concurrentSend.test.ts:84-112` installs a deterministic
barrier (no sleeps) that holds the first transaction which reads a *missing* `cli:outbox:<id>`,
letting the second messenger run to completion against the same database file. The assertions at
`:180-183` are `expect.soft` (a reporting aid — soft assertions still fail the test, they do not
weaken it) and check one history entry, one outbox key, one relayed envelope id and receipt
equality. The T33 report's neutralisation experiment (recheck replaced by a constant `undefined`,
barrier untouched, three original failures reproduced) is consistent with this control flow.

No claim-key leak arises from the early return: the `existed` branch skips `tx.delete(claimKey)`
(`:88`), but the instance that actually committed performed that delete in the same transaction,
and the losing instance's own claim lookup at `:52-59` short-circuits on the now-present
`sessionKey`. The losing instance does discard a claimed bundle, which wastes one relay-side
one-time prekey; that is inherent to two processes racing the same send and is not a correctness
defect.

---

## F-013 — `inlineStringOptionValues` · **fixed**

`inlineStringOptionValues` (`cli.ts:89-102`) is applied to raw argv at `cli.ts:105`, before
`parseArgs`, which keeps `strict: true` (`:107`). The rewrite fires only when **all** of these
hold (`:95-96`): the argument starts with `--`, contains no `=`, its name is in `stringOptions`,
a following argument exists, and that argument is not the bare `--`.

The four consumption hazards the dispatch named:

| Hazard | Why it cannot happen | Evidence |
|---|---|---|
| Boolean option swallows an operand | `stringOptions` is derived from `cliOptions` by `option.type === "string"` (`:63-65`), so `json`/`yes` are excluded by construction and cannot drift from the option table | `cli.ts:63-65`; `cli.dashOptionValues.test.ts:321` (`doctor --json --profile` → exit 2) |
| Option already inline is re-wrapped | `!arg.includes("=")` fails, the argument is pushed verbatim and `index` is **not** advanced, so the next argument is processed normally | `cli.ts:95`, `:97` |
| Option with nothing after it invents a value | `value !== undefined` fails at end of argv, so the bare option reaches `parseArgs`, which still raises | `cli.ts:96`; probe: `["doctor","--json","--profile"]` → `ERR_PARSE_ARGS_INVALID_OPTION_VALUE`; `cli.dashOptionValues.test.ts:314-326` |
| Anything after a bare `--` is consumed | The loop copies `args.slice(index)` and `break`s on the first `--` (`:93`); an option *followed by* `--` is excluded separately by `value !== optionSeparator` | `cli.ts:93`, `:96`; probe: `["send","--text","--","--profile=/p"]` → `ERR_PARSE_ARGS_INVALID_OPTION_VALUE`; `cli.dashOptionValues.test.ts:353-377` |

The bounded probe confirmed every load-bearing `parseArgs` assumption independently of the fix:
inline dash values are accepted (`--to=-AbC` → `-AbC`); the separated form still throws
`ERR_PARSE_ARGS_INVALID_OPTION_VALUE` (the defect); unknown options still throw
`ERR_PARSE_ARGS_UNKNOWN_OPTION` both inline and as a standalone `-value`; a repeated inline option
emits **two** `option` tokens, so `parseCommand`'s `seen` check (`:113-118`) still fires; and
operands after `--` become positionals, so `commandOptions[command]` misses and exit 2 stands.
Downstream validation is untouched: `--message-id` still goes through the UUID regex (`:290`),
`--relay-url`/`--store-key-env` through `parseClientConfig`, and an inline empty value
(`--profile=`) still fails the `trim() === ""` check (`:120`).

The exit-code contract is unaffected: `inlineStringOptionValues` runs before `parseArgs`, every
parser throw still maps to `inputFailure()` / exit 2 (`:108`), and no branch of `classify` was
touched.

---

## New observations

### [T38-L-001] `rotateBundle()` and `retryPending()` have no CLI entry point — **minor**, non-blocking

- **File**: `apps/cli/src/runtime/outbound.ts:36` (also `:110`)
- **Problem**: `OutboundMessenger.rotateBundle()` is the explicit fresh-allocation operation F-001
  asked for, but no `execute()` branch in `apps/cli/src/commands/cli.ts:231-321` reaches it, and
  the documented command surface (`specification.md:63-72`) has no rotate command. Same shape for
  the pre-existing `retryPending()`.
- **Why it matters**: once `cli:publication` is written, the CLI can only ever resubmit that one
  bundle, so after its single one-time prekey is claimed a second peer's `claim` cannot succeed.
  This is **not a regression** — before the fix a second publish was rejected by the relay's
  permanent OTK uniqueness contract (`specification.md:88`) as well — and adding a command exceeds
  the prototype's documented surface, which is why this is minor and not blocking.
- **Fix**: either wire `rotateBundle()`/`retryPending()` to commands in a later scope decision, or
  record in the flow that they are deliberately library-only for now.

### [T38-L-002] A string option consumes a following flag-shaped argument — **info**

- **File**: `apps/cli/src/commands/cli.ts:95-99`
- `send --to ID --text --profile /p --json` now yields the literal body `--profile` instead of the
  pre-fix exit 2, because the rewrite is applied uniformly rather than only to dash-leading values.
  This is unavoidable once `--text` must accept a value beginning with `-`, it is deliberate, and
  `cli.dashOptionValues.test.ts:286-289` pins it as intended behaviour. When the swallowed option
  is not duplicated later in argv, the command still fails closed (the required `--profile` check
  at `:120`, or an unmatched positional). Recorded so the trade-off is visible, not as a defect.

### [T38-L-003] Corruption of a persisted record still classifies as exit 3, not exit 5 — **info**

- **File**: `apps/cli/src/runtime/profile.ts:140`, `apps/cli/src/runtime/outbound.ts:45`
- F-003's boundary is deliberately "store machinery". A schema/JSON failure while decoding a record
  that was already read successfully (`publicationSchema.parse` of `cli:publication`,
  `decode<Outbox>` of an outbox record, `metadataSchema.parse` in `readMetadata`) originates inside
  the operation callback, keeps its own type, and therefore lands on `OUTBOUND_REJECTED` /
  `PROFILE_REJECTED` → exit 3 rather than exit 5. Reachable only by store corruption or manual
  editing, so no input reaches it in normal operation. Noted because `cli:publication` is a *new*
  record in this class.

### [T38-L-004] `--json` is accepted but never read — **info**

- **File**: `apps/cli/src/commands/cli.ts:39`, `:52-61`
- `values.json` has no reader anywhere in `apps/cli/src` (`keryx ctx rg "values\.json"` → 0 hits);
  `writeResult` (`:333-335`) always emits JSON. Pre-existing, outside this fix wave, and consistent
  with `specification.md:74` ("Machine-readable mode writes one JSON result to stdout"). Listed only
  because the F-013 work touched the option table.

---

## The five non-negotiable criteria

1. **No test was weakened.** For the four fix-wave test files in my scope, `mtime` of every test
   file precedes the `mtime` of the production file its fix lives in
   (`outbound.publish.test.ts` 17:18 and `outbound.concurrentSend.test.ts` 17:22 before
   `outbound.ts` 17:41; `cli.processFailures.test.ts` 17:23 before `profile.ts` 18:08 and `cli.ts`
   18:53; `cli.dashOptionValues.test.ts` 18:45 before `cli.ts` 18:53). No `.skip(`, `.only(`,
   `.todo(` or `.fails(` markers. The only `expect.soft` uses
   (`outbound.concurrentSend.test.ts:180-183`) are a multi-failure reporting aid — a soft assertion
   still fails the test — and each still asserts the strict `toHaveLength(1)` / equality the finding
   requires. Assertions I checked for loosening and found intact: exit-3 control at
   `cli.processFailures.test.ts:280-301`, `bodyText` equality at `outbound.publish.test.ts:102`
   and `:118`, and the over-correction guards at `cli.dashOptionValues.test.ts:303-351`.
2. **No strict schema was loosened.** In the files under my scope nothing was widened.
   `publicationSchema` (`profile.ts:45-48`) is a new `.strict()` object with a `z.literal(1)`
   version and a `z.custom` bundle validated by `SignalPreKeyBundleV2Schema` — additive, not a
   relaxation. `inputSchema` (`outbound.ts:15`), `MailboxEnvelopeSchema.strict()` (`:79`) and every
   `RelayClient` response schema remain `.strict()` with no `.optional()`, no passthrough and no
   `any`. `nextCursorSchema` (`relayClient.ts:24`) is the closed union
   `z.union([z.string().min(1).max(256), z.null()])` on a `.strict()` object — the TypeScript side of
   criterion 2 holds; the Go side is another reviewer's scope.
3. **No secret leakage.** The only writers are `process.stderr.write` at `cli.ts:192` (a fixed
   prompt string) and `:223` (the four public contact identifiers the spec requires be shown before
   trust), and `process.stdout.write` at `:334`, which emits `{ok:true,data}` or
   `{ok:false,error:{code}}` — never an error message or stack. The top-level rejection handler
   (`:350-353`) also emits only a code. The persisted publication bundle travels solely from
   `profile.ts:143` to `relay.publishBundle` (`outbound.ts:34`); it is never rendered into
   diagnostics, and the F-001 test asserts equality as a boolean rather than printing bytes
   (`outbound.publish.test.ts:102`). `PersistenceError`'s message is a fixed string
   (`profile.ts:22`) and carries no path, key or SQL text. Plaintext is written only to the
   encrypted store via `appendHistory` and returned only by the `history` command, which is its
   documented purpose.
4. **Exit-code contract intact.** 0/2/3/4/5 all still reachable and unmoved: `classify`
   (`cli.ts:323-331`) gained one branch ahead of the trust branches and lost none; F-013 changed
   only pre-parse normalisation and every parser rejection still maps to exit 2; the exit-3 control
   test (`cli.processFailures.test.ts:263-302`) and the exit-5 tests (`:205-261`) cover both
   directions.
5. **Prototype scope respected.** No finding here demands production hardening, mobile support,
   deployment or external audit. T38-L-001 explicitly declines to demand a new command.

## Worker-reported concerns in my scope

- **`T33-I2` (prekey retention after rotation)** — acceptable for the prototype. Superseded
  `pre:<n>` records must be retained or in-flight PreKey sessions referencing the old id stop
  resolving; growth is bounded by `maxOneTimePreKeyId = 0xffffff` and, in practice, by rotation
  being unreachable from the CLI (T38-L-001).
- **`T33-I3` (`PersistenceError` also covers "nested transaction" and "store closed")** —
  acceptable. Both are raised by `EncryptedSqliteStore.transaction` at `:44-45` before the operation
  runs, so `raised` is `undefined` and the classification is structurally correct. A nested
  transaction is a programming error rather than a storage failure, but reporting it as exit 5 is
  no worse than the pre-fix exit 3 and it is not reachable from the current call graph.
- **`T33-I4` (F-008 barrier is test-only instrumentation)** — acceptable and, in my reading,
  preferable. `holdFirstMissingOutboxRead` (`outbound.concurrentSend.test.ts:84-112`) spies on
  `EncryptedSqliteStore.prototype.transaction` from the test file only; production code carries no
  hook, and the barrier is deterministic rather than timing-based.
- **`T39-Q1` (a real dash-leading `identity_id` cannot be generated deterministically)** —
  adequate. The boundary chosen is the right one: `cli.dashOptionValues.test.ts:220-232` proves the
  dash-leading value reaches the trust layer verbatim by comparing it against the identical run with
  the leading `-` removed (same exit 3 / `CONTACT_NOT_TRUSTED`), and `:270-300` proves end-to-end
  success for the same command shape. What remains unproven — that a *real* key whose base64url
  encoding starts with `-` also succeeds — is a property of the encoder, not of the parser, and the
  parser is what F-013 was about.

## Verdict

`DONE`. No blocker and no major. All five assigned findings are `fixed`. Nothing in my scope blocks
acceptance of the fix wave.

## Routing audit

- `graph_used`: no — the change set was named exactly by the dispatch's `files_to_read` and the
  T28 `class_scope` site lists, so navigation was not the question (`not-relevant`).
- `wiki_used`: no — `docs/requirements/echolet-cli-prototype/specification.md` is the authoritative
  contract for the command surface, exit codes and the relay v2 publish rules, and it was read
  directly (`not-relevant`).
- `ctx_used`: yes — all searches through `keryx ctx rg`, all command output through `keryx ctx run`,
  schema reads through `keryx ctx read --mode compact`.
- `raw_rg_used`: no.
