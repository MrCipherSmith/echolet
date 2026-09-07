# T39 — Implementation report: dash-leading CLI option values (F-013, blocker)

Run: 001 · Dispatch: `001-T39-implement` · Phase: GREEN
Date: 2026-09-06

## The defect

`parseCommand` in `apps/cli/src/commands/cli.ts` passed `process.argv.slice(2)` straight to Node's
`parseArgs` with `strict: true`. In that mode `parseArgs` raises
`ERR_PARSE_ARGS_INVALID_OPTION_VALUE` for the space-separated form `--opt <value>` whenever
`<value>` begins with `-`, and cli.ts mapped every parser throw to `INVALID_ARGUMENTS` / exit 2.

`identity_id` is `encodeBase64Url(publicKey)` and `-` is in the base64url alphabet, so roughly one
identity in 64 begins with `-` and could not be used with `--to`, `--with` or `--from` at all. A
message body beginning with `-` was refused by `--text` for the same reason. That is what made the
workspace suite intermittently red: an identity-dependent product defect, not a flaky test.

## The change

One production file changed: `apps/cli/src/commands/cli.ts`.

Added `inlineStringOptionValues(args)`, applied to the raw argv before `parseArgs`. It rewrites
`--<declared string option> <value>` into the inline `--<option>=<value>` form. `parseArgs` in
strict mode *accepts* the inline form for a dash-leading value (`--to=-AbC` yields `-AbC`,
`--text=--profile` yields `--profile`) while still refusing unknown options, so the fix is a
pre-parse normalization rather than a relaxation of the parser.

Supporting additions: `stringOptions`, a `ReadonlySet` derived from `cliOptions` itself (so the set
cannot drift from the option table), and the `optionSeparator` constant.

`strict: true` is unchanged. `allowPositionals`, the `commandOptions` allow-list, the duplicate
check over `parsed.tokens`, `rejectUnexpectedMissing`, `classify` and the exit-code contract
(0/2/3/4/5) are all untouched. Nothing else in the repository was modified: `apps/relay`,
`packages/**`, `apps/cli/vitest.config.ts` and `apps/cli/test/globalSetup.ts` are as T33–T36 left
them, and no test file was edited, skipped or deleted.

## Why validation strength is preserved

The rewrite is deliberately narrow. Every rejection path that existed before still reaches the same
rejecting code with the same argv shape:

| Input class | Why it still fails closed |
|---|---|
| Unknown flag (`--unknown-flag`, `--unknown-flag -value`) | The name is not in `stringOptions`, so nothing is rewritten and nothing is consumed. `parseArgs` still raises `ERR_PARSE_ARGS_UNKNOWN_OPTION` → exit 2. A dash-leading argument left standing on its own (`-value`) is likewise still refused as an unknown short option. |
| Missing value at end of argv (`… --text`, `… --with`, `… --profile`) | With no following argument there is nothing to inline, so the option is passed through verbatim and `parseArgs` still reports the missing value → exit 2. This is the trap the dispatch warned about: `parseArgs` raises the *same* error class for a dash value and for an absent value, so the normalizer must not invent one. It never does — it only ever joins an argument that actually exists. |
| Repeated option (`--to a --to b`, including a dash-leading repeat) | `parseArgs` emits one `option` token per occurrence in either the inline or the separated form, so `parseCommand`'s `seen` set sees both occurrences exactly as before → exit 2. |
| Option not allowed for the command (`poll --to …`, `doctor --text …`) | The `commandOptions` allow-list check runs on token names, after parsing, and is untouched → exit 2. |
| Unknown command (`bogus`) and stray positional (`send extra …`) | Positional handling is untouched; the joined positionals still fail to match a known command → exit 2. |

The fix therefore cannot be obtained by `strict: false` and is not equivalent to it: disabling
strict parsing would have silenced the first, third and fourth rows above.

## Edge cases

- **`--` separator.** The scan stops at the first bare `--`; that argument and everything after it
  is copied verbatim, so operands stay operands. A bare trailing `--` remains a no-op (exit 0,
  positionals unchanged), and any operand after `--` still becomes a positional that no command
  matches → exit 2. An option immediately followed by `--` is *not* treated as having `--` for a
  value: it is passed through unchanged, leaving the existing parser behaviour for that shape
  exactly as it was.
- **Boolean options.** `--json` and `--yes` are excluded by construction, because `stringOptions`
  is filtered on `type === "string"`. A boolean flag can therefore never swallow the argument that
  follows it — which is what keeps `doctor --json --profile` a missing-value error rather than a
  profile silently named `--profile`.
- **Already-inline options.** An argument containing `=` is passed through, so `--to=-AbC` is never
  re-wrapped into `--to=-AbC=<next>` and the following argument is not consumed.
- **Values containing `=`.** Only the first `=` is inserted by the rewrite and `parseArgs` splits on
  the first `=`, so a value such as `foo=bar` survives intact.
- **Flag-shaped values.** `--text --profile` now yields the literal body `--profile`; the separate,
  genuine `--profile` occurrence elsewhere in argv is still parsed as an option, so the duplicate
  and required-profile checks are unaffected.
- **Non-dash values.** The rewrite is applied uniformly rather than only when the value starts with
  `-`, so there is a single code path and no behavioural fork; the inline and separated forms are
  equivalent for `parseArgs` in every other respect, and `parseCommand` reads only `token.name`.

## Verification

All commands run through `keryx ctx run` (bounded output; raw logs under
`.metaproject/data/gdctx/raw/`).

| Check | Result |
|---|---|
| `npx vitest run src/commands/cli.dashOptionValues.test.ts` (before the change) | 10 failed, 6 passed (16) — RED confirmed |
| `npx vitest run src/commands/cli.dashOptionValues.test.ts` (after) | 16 passed (16), unmodified |
| `pnpm test` (workspace, 7 projects) | all green — apps/cli 13 files / 69 tests, including `test/e2e/two-process.test.ts` 3/3 |
| `pnpm typecheck` | pass (7 projects) |
| `pnpm lint` | no package declares a `lint` script (nothing to run) |

No plaintext body, ciphertext, store key, private key material or HTTP request body was written to
any log or report; rejected argument values are not echoed into diagnostics — the failure path still
emits only `{"ok":false,"error":{"code":…}}`.

## Notes for the verifier

- Nothing was committed: the repository is on an unborn `main` with an untracked baseline.
- The only edit is `apps/cli/src/commands/cli.ts`; the test file carries no modification.
- Acceptance of this work belongs to the independent verifier, not to this worker.
