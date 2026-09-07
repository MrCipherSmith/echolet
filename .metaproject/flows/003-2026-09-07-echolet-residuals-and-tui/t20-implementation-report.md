# T20 — `send` presupposes `relay publish`, and the client says so before it spends a third party's key

Flow 003, task T20 (task-implementer). **Product code only.** No test file was created, edited or
deleted; no Go file was touched; `apps/relay` was not entered. No CLI command was added. No
connection was made to `geekom` or `depr`. Nothing was weakened, skipped, narrowed or deleted, and no
Zod schema was relaxed.

Result: **all six failing tests are green, and the whole `apps/cli` suite is green** —
45 files, 253 tests, **253 passed / 0 failed**. `tsc --noEmit` exits 0 for `apps/cli` and for all
seven workspace projects.

---

## 1. File identity by SHA-256

The thirteen test files, all **unchanged** against the digests recorded by T19 (and, for
`outbound.claimResidual.test.ts`, by T12/T13):

| test file | sha256 | state |
|---|---|---|
| `apps/cli/src/runtime/outbound.publicationPrecondition.test.ts` | `1b8e41b48adfbe47e99a78655b6e26b895c3dac29bc2670647b92307c48e4324` | unchanged |
| `apps/cli/src/runtime/outbound.test.ts` | `58d0dd98cdb94c8122eabdb7f204f3784bbf81be95d49d1fa6156d5c1f0c0921` | unchanged |
| `apps/cli/src/runtime/outbound.senderAuthentication.test.ts` | `cec9cc7e3f91fc49a82cb5b67066614bea8a5948e2c7794e806ae6665302dd88` | unchanged |
| `apps/cli/src/runtime/outbound.concurrentSend.test.ts` | `c0fbb8d4b3786ed9d17b8afad636b4f0e885020f15bed5f3a825b3dc3c436321` | unchanged |
| `apps/cli/src/runtime/outbound.claimResidual.test.ts` | `56285ada4a242f160b1c6ae04dfdf4e6baedcfe896b31b6cfde3393abf6d6714` | unchanged |
| `apps/cli/src/runtime/inbound.test.ts` | `15122e939361c5b3410d15fa2a75b579953092b226e09ac75dd3c95f2d9dc1ee` | unchanged |
| `apps/cli/src/runtime/inbound.batchIsolation.test.ts` | `e1d36ae61a854c8565fec463cd96c85973b9bd80ba1eda46b8485547c8a740ad` | unchanged |
| `apps/cli/src/runtime/inbound.pollProgress.test.ts` | `088f53ae4aff5c134379934264e32a4fba4e3d53237a0e07fff65e674b017875` | unchanged |
| `apps/cli/src/runtime/inbound.readMark.test.ts` | `ef23b69343818cacefaeba527adae40de0f06b26b692809d986856db80bf18f1` | unchanged |
| `apps/cli/src/commands/cli.senderQuota.test.ts` | `e193d625836cf6f5754e0d267fdb6a25a5e58ce80f6eb39a6b3622e71d303709` | unchanged |
| `apps/cli/src/commands/cli.relayErrorCodes.test.ts` | `d54c319f90a83ca357e0a96b689b5ade811a64ab099e29156d1867b805d41a4d` | unchanged |
| `apps/cli/src/commands/cli.processFailures.test.ts` | `e89f96a6d7be009a345ec94ba260fee47ba69eb941b8a163558f14be3c344ec6` | unchanged |
| `apps/cli/test/e2e/publication-claimability.test.ts` | `a8037c56cc054b26d006d8ec7a75a1de7af1a4f8747966b902f59c35352a2b24` | unchanged |

The two product files, changed exactly as the baseline predicted:

| product file | sha256 before | sha256 after |
|---|---|---|
| `apps/cli/src/runtime/outbound.ts` | `337031b1540c87b956f420cb42eead8cb123e7a7b7a33dfd9f81cfc3fab1fd5e` | `42d2f3b6eb4d933502bb5dc13c376508e3d91e0bf9638a40382843b44bf2f324` |
| `apps/cli/src/runtime/profile.ts` | `29c654f22cea55d525e7b6caf544dd18b2efc52e794b571e0220cefec15a851e` | `4a3d02b4e495c6af82e4c4bb94dc455a818991d6848ec56b0c5594a2f508da34` |

Nothing else under `apps/`, `packages/` or `docs/` was edited. (`apps/cli/dist/` is rebuilt by the
vitest `globalSetup` on every run; it is a build artifact, not a source change.)

## 2. The change

Two additions, no deletions, no signature broken.

### 2.1 `Profile.hasPublication()` — `apps/cli/src/runtime/profile.ts`

```ts
hasPublication(): Promise<boolean> {
  return this.transact((tx) => tx.get(publicationKey) !== undefined);
}
```

The predicate is the **conservative** one T19 pins. `cli:publication` is written by
`publicationBundle()` alone — reached only from `publish()` and `rotateBundle()` — and it is written
*inside the transaction that precedes the relay call*, so its absence is durable proof that no
publication was ever **offered**. Only under that proof is the deposit certain to be refused.

The converse is deliberately not claimed: a profile whose publication the relay rejected, or whose
publish response was lost, **has** attempted it and answers `true`. Refusing only the *provably*
doomed send is what keeps the guard from ever blocking a send that could have succeeded. The stored
bytes are never decoded — presence is the whole question, and a publication that fails to parse is
still an attempt.

### 2.2 One guard in `sendOwned` — `apps/cli/src/runtime/outbound.ts`

Placed immediately **after** the `CONTACT_NOT_TRUSTED` check and **before** the durable claim-id
transaction, so nothing is written and no request is issued:

```ts
if (!contact) throw new OutboundError("CONTACT_NOT_TRUSTED");
…
if (!(await this.profile.hasPublication())) {
  throw new OutboundError("SENDER_NOT_PUBLISHED", "This profile has never published its device record, …");
}
```

The ordering is a priority between two live local guards, not one swallowing the other: an unpinned
recipient keeps reporting `CONTACT_NOT_TRUSTED` (which `cli.processFailures.test.ts` relies on), and
a pinned recipient from the same unpublished profile reports `SENDER_NOT_PUBLISHED`. Both checks are
local, so the ordering costs nothing either way.

Because the guard sits ahead of the claim-id write, the Signal establish, the outbox commit and the
history append, a refused send leaves the profile exactly as it found it: no `cli:claim:`, no
`cli:outbox:`, no `session:` key. `relay publish` is then sufficient to lift it — the guard is a
precondition on this profile's own state, never a verdict.

### 2.3 `OutboundError` gained an optional message

```ts
constructor(readonly code: string, message: string = code) { super(message); this.name = "OutboundError"; }
```

`code` — the machine name `classify()` reads and the CLI reports — is untouched, and the default
keeps every one of the four pre-existing throw sites byte-identical in behaviour. The added
free-text message is the idiom `ProfileError` and `ConfigurationError` already use (a fixed code
beside an operator-readable sentence), and it is used at exactly one site, where naming the condition
is not enough to act on it:

> `This profile has never published its device record, so the relay cannot accept its messages; run `relay publish` for this profile, then send again.`

It names the action, the subject and the retry. No store key, private key, plaintext or HTTP request
body appears in it, and none is printed or recorded anywhere by this change.

## 3. The exit class, and why

`classify()` (`apps/cli/src/commands/cli.ts:376`) maps an `OutboundError` to
`error.code === "INVALID_MESSAGE" ? inputFailure(code) : trustFailure(code)` — i.e. **exit 2** for
the one input error, **exit 3** otherwise, under the error's own code. `SENDER_NOT_PUBLISHED`
therefore reaches the operator as `{"ok":false,"error":{"code":"SENDER_NOT_PUBLISHED"}}` on **exit
3**, through the existing default branch. **`classify()` needed no change, and got none.**

That is the right class, on three independent grounds:

1. **It is not a relay failure, and cannot be mistaken for one.** The refusal is an `OutboundError`
   and explicitly not a `RelayError`, so it never enters the relay branch — it can never be reported
   as retryable `RELAY_UNAVAILABLE` (exit 4) nor flattened into `PROTOCOL_REJECTED`. `outbound.publicationPrecondition.test.ts`
   asserts both instance checks directly. It is also not flattened into the generic `TRUST_REJECTED`:
   `trustFailure(error.code)` carries the specific code through, so the operator sees the condition
   by name.
2. **Exit 2 would be wrong.** specification.md:74 defines exit 2 as *input/configuration errors* —
   a malformed argument, a missing flag, an unparseable `config.json`. Here the command line and the
   profile configuration are both entirely valid; what is missing is a prior **step**. Routing a
   valid command through the argument-error class would tell an operator to re-read their flags.
3. **Exit 3 is where this condition already lives.** `UNAUTHORIZED_MAILBOX_ACCESS` is the relay's own
   late statement of this exact condition and specification.md:76–82 pins it at exit 3, alongside
   `PREKEY_BUNDLE_UNAVAILABLE` and `SENDER_QUOTA_EXCEEDED`, as an operator-fixable precondition that
   is *not* a trust violation. Reporting the local pre-flight refusal on a different exit code from
   the relay's own detection of the same condition would split one condition across two exit classes
   for no gain. `test/e2e/publication-claimability.test.ts:159` pins exit 3 against the real relay
   binary.

## 4. What an operator now sees

Measured with the built CLI (`apps/cli/dist/cli.js`, Node v26.5.0) against a profile that has run
`init` and `contact import` and nothing else, with the configured relay URL pointing at a port
**nothing is listening on**:

```
$ echolet send --profile <dir> --to <identity-id> --text "…" --json
{"ok":false,"error":{"code":"SENDER_NOT_PUBLISHED"}}
$ echo $?
3
```

The dead relay port is itself part of the evidence: had any request been issued the failure would
have been a connection error on exit 4. It is `SENDER_NOT_PUBLISHED` on exit 3, so nothing left the
process.

The same is witnessed end-to-end by the real relay binary
(`test/e2e/publication-claimability.test.ts`): after carol's refused send, bob's `relay publish`
still reports `claimable: true` with the identical `bundleId` — the relay attesting that no claim
ever reached it — and carol's reported code is `SENDER_NOT_PUBLISHED`, neither `PROTOCOL_REJECTED`
nor anything matching `/PREKEY/`.

## 5. Test results

The six tests T19 left red, by name:

| test | before | after |
|---|---|---|
| `outbound.publicationPrecondition.test.ts` › refuses locally, issuing no relay request at all, when the profile has never published | RED | **GREEN** |
| `outbound.publicationPrecondition.test.ts` › leaves the recipient claimable by a different, properly published sender | RED | **GREEN** |
| `outbound.publicationPrecondition.test.ts` › leaves no durable trace of the refused send, so publishing and retrying starts clean | RED | **GREEN** |
| `outbound.publicationPrecondition.test.ts` › keeps CONTACT_NOT_TRUSTED for an unpinned recipient, and still issues no request | RED | **GREEN** |
| `test/e2e/publication-claimability.test.ts` › reports whether a republished bundle is still claimable, and names an exhausted prekey for a later sender | RED | **GREEN** (9.6 s) |
| `outbound.claimResidual.test.ts` › does not spend the recipient's one-time prekey on a send the relay is certain to refuse | RED since T12/T13 | **GREEN** (465 ms) |

Whole `apps/cli` suite, one unfiltered run (Node v26.5.0, the default non-login interpreter):
**45 files, 253 tests, 253 passed / 0 failed**, 154.8 s. Baseline was 247 passed / 6 failed of 253,
so six tests moved red → green and **nothing regressed**. The timing-sensitive process-spawning
files in `src/commands/` all passed in that same run (`cli.test.ts` 6/6, `cli.relayErrorCodes.test.ts`
2/2, `cli.senderQuota.test.ts`, `cli.processFailures.test.ts`), so no isolated re-run was needed.

`tsc -p apps/cli/tsconfig.json --noEmit` exits 0; `pnpm typecheck` exits 0 across all seven
workspace projects. The Go suite was not run and no Go file was changed; the known RI-09
poll-byte-budget failure belongs to another task and was not touched.

**T13 residual #1 is closed.** The recipient's one-time prekey is no longer spent by a send the relay
is certain to refuse.

## 6. Residuals

1. **The actionable sentence is not rendered by the CLI.** `main()` writes
   `{ok:false,error:{code}}` and nothing else — the failure envelope has never carried a message, and
   `cli.test.ts` pins "one JSON object" for errors. The sentence therefore reaches programmatic
   consumers of `OutboundMessenger` (and would reach a TUI that read `error.message`), but an
   operator at the terminal today sees only the code. Surfacing it would change the CLI's stdout or
   stderr contract, which is out of this task's scope and pinned by tests I may not edit.
2. **`SENDER_NOT_PUBLISHED` is undocumented.** `specification.md:76–82` carries the table of codes
   reported under their own name at exit 3, and this new code belongs in it (and arguably in
   `runbook.md`). I deliberately did not add the row: existing **test-file comments** cite
   `specification.md:92` and `specification.md:130` by line number, and inserting a table row at
   line 82 would silently invalidate both. Fixing that properly means updating those citations,
   which lives in test files this task must not touch. It is a documentation task, filed here.
3. **`hasPublication()` is presence-only and per-profile-directory.** Two runtime instances sharing
   one profile directory share the publication, which is what keeps `outbound.concurrentSend.test.ts`
   unaffected. A profile whose `cli:publication` row were removed out of band would be refused until
   it published again — correctly, but the guard has no way to distinguish that from a fresh profile.
4. **A profile whose publication the relay REJECTED is still allowed to send**, by design (§2.1). It
   will fail late, at the deposit, under the relay's own `UNAUTHORIZED_MAILBOX_ACCESS` — and it will
   still spend the recipient's one-time prekey on the way. Closing that would require the client to
   record the publication *outcome*, not just the attempt, which is a strictly larger change and
   would risk refusing sends that could have succeeded (a publication whose response was merely
   lost). The guard covers the provable case only.
5. **T13 residuals #2–#6 are untouched and remain open**: `PREKEY_BUNDLE_EXPIRED` has no test of its
   own; `claimReplaced` is undocumented in `runbook.md:106`; claim replacement is bounded per send
   rather than per recipient; replacement still consumes a second one-time prekey; and
   `cli:claim:<identity>` can still hold an id that was never issued.
6. **There is still no CLI command to replenish a consumed bundle.** T12 §7's open questions (a ninth
   command for rotation; an authenticated claim route) are untouched — bundle rotation is a separate
   task, as instructed. This change protects the recipient's single bundle from one specific way of
   losing it; it does not give them a way to get one back.

## Routing audit

`graph_used: no` (not-relevant — every file under change was named in the dispatch and confirmed
through T13/T19); `wiki_used: no` (not-relevant — T12's analysis, T13's report and
`specification.md` are the cited authority for this behaviour); `ctx_used: yes` (`keryx ctx rg` for
every search, `keryx ctx read` for large file reads); `raw_rg_used: no`.
