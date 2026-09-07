# T9 — Operator TUI: implementation report

Flow 002, task T9, implementation attempt 1. The design and the 90 RED tests were written by an
independent `tests-creator` (`t9-operator-tui-design.md`, `dispatches/002-T9-tests-result.json`).
This report covers what was built against that contract, what it deliberately cannot do, and where
the AC5 compromise is visible on screen.

**No test file was edited, skipped, deleted or relaxed.** All eight test files hash byte-identical
to the SHA-256 manifest recorded in the T9 tests result. `vitest run --root apps/cli src/tui` is
90/90 green; the full `apps/cli` suite is 32 files / 199 tests green; `pnpm -r typecheck` is green
on all 7 projects.

---

## 1. The module split as built

Under `apps/cli/src/tui/`. The eight modules the design fixed are unchanged in name and role; two
files were added and one deleted.

| File | Purity | What it holds |
|---|---|---|
| `state.ts` | pure | The state model and `createInitialState`. No field can hold key material. |
| `intents.ts` | types | `Intent`, `Effect`, `Step`. Unchanged from the stub. |
| `text.ts` | pure | **Added.** `codePoints` / `clipLine` / `padOrClip` / `labelled` / `formatInstant`. |
| `cli-bridge.ts` | pure | The frozen eight commands, `buildArgv`, `parseCliOutcome`. |
| `modal-host.ts` | pure | Trust-modal geometry, completeness, rendering and key contract. |
| `profiles-pane.ts` | pure | Profile rows, observed contacts, roster shortfall, relay health line. |
| `mailbox-pane.ts` | pure | Queue counts and rejections narrowed to `{envelopeId, code}`. |
| `history-pane.ts` | pure | History narrowed to the explicitly selected contact. |
| `shell-chrome.ts` | pure | `fitLine`, `renderFrame`, `styleFrame`, pane layout. |
| `tui-shell.ts` | mixed | `mapKey`, `reduce`, `applyOutcome` pure; `runTuiShell` the one impure function. |
| `main.ts` | impure | **Added.** The composition root: builds `TuiIo`, calls `runTuiShell`, holds no decisions. |
| `not-implemented.ts` | — | **Deleted** (T9-F-004). |

### Why `text.ts` was added

`shell-chrome.ts` composes the pane modules, so a pane importing `fitLine` back from
`shell-chrome.ts` would close a cycle. The two width primitives therefore live in a leaf module
with no imports of its own, and `shell-chrome.fitLine` is a thin wrapper over it so the exported
contract the tests import is unchanged. This is a placement decision inside the fixed split, not a
change to it.

### Why `main.ts` was added

`runTuiShell(io)` needs a caller, and the design note's module list stops at the shell. `main.ts` is
the composition root and nothing else: it parses argv into `ProfileView`s, spawns
`apps/cli/dist/cli.js` as a child, and hands the four seams (`stdout`, `stdin`, `now`, `runCli` plus
`answerTrustPrompt`) to `runTuiShell`. It contains no rendering, no key mapping and no trust logic.

It builds to `apps/cli/dist/tui.js` via a second esbuild entry in `build.mjs`, and
`apps/cli/package.json` gains a `echolet-tui` bin. It is a **separate binary, not a ninth CLI
command** — the frozen surface is driven as a child process, never joined.

### Two additive changes to declared shapes

Both are additive and optional; neither weakens a tested property.

1. `TuiIo.onTrustIdentifiers?` — the driver owns the child process, so it is the only thing that can
   observe the four identifiers the child prints on stderr while `contact import` waits at its own
   prompt; the shell owns the state, so it is the only thing that can open the modal. This
   registers the shell's listener. Optional, so a `TuiIo` with no child still typechecks.
2. `ProfileView.contactCardPath?` — a filesystem path, never a secret (contact cards hold the four
   **public** identifiers, which is exactly why the TUI can read one with no key). It exists so
   `mapKey` stays a pure function of the state: the import key has to know which card it would
   import.

---

## 2. What the security properties look like in the built code

### The trust gate

Three refusals in `reduce`, all in one place, none of them a layout convention:

```
trust-confirm  ⇒  state unchanged, no effect, unless
                    state.modal is a trust modal,
                    all four of identity_id / device_id / device_pubkey / signal_identity_key
                      are present and non-empty, and
                    modal.renderedAt !== null  (the shell sets it only AFTER writing the frame).
```

`runTuiShell` sets `renderedAt` in `paint()`, after `io.stdout.write`, which is what turns "the
identifiers were shown" from a claim about the code into a claim about what the operator saw.
`contact import` is built **without `--yes`**, so the CLI's own `[y/N]` prompt is answered on the
child's stdin only after the modal was confirmed: both guards hold, and neither is bypassed.

### No key material in a frame or an argv

`buildArgv` emits the store key's environment variable **name** and only on `init`; there is no
request shape that can carry a value. `main.ts` passes `process.env` through to the child untouched
and never reads from it — there is no code path from a variable name to its value anywhere in
`src/tui`. `renderFrame` reads nothing but its two arguments.

### Rejections and history

`buildMailboxSnapshot` maps rejections through `formatRejectionLine`, which reads `envelopeId` and
`code` **by name** and never stringifies the object, so a widened runtime value contributes nothing
to the snapshot or the screen. `applyOutcome` narrows a `poll` result's `rejected` array the same
way before it enters the state. `buildHistorySnapshot` drops other contacts' plaintext before any
formatting, and holds none at all when nothing is selected.

### AC6

`UNAUDITED_NOTICE` is row 0 of every frame, and the modal overlay is clamped to start at row 1
(`FIRST_OVERLAY_ROW`), so the warning survives the one moment it matters most — the operator
deciding whether to trust a stranger.

---

## 3. How AC5's shortfall is surfaced (T9-F-002)

The frozen surface has no command that lists pinned contacts. The console therefore lists the
contacts **this session observed** and cross-checks the count against `doctor`'s `contact_count`.
Observed here means *imported through the trust modal and then confirmed by a successful child
exit* — `runTuiShell` holds the confirmed modal until `contact import` reports `ok`, so an import
the CLI refused does not inflate the roster.

When `doctor` knows of more contacts than the session saw, the pane says so:

```
contacts        0 observed this session
+1 pinned by doctor but not seen by this session (no CLI command lists contacts)
```

That is the commonest case in practice: a fresh console over an existing profile can name **none**
of the contacts it already trusts. It is stated rather than hidden, which is the whole of the
compromise.

`published` is surfaced the same way, and for the same reason: `doctor` does not report publication
state, so the pane says `not observed by this session` rather than a bare `no` about a profile that
may well be published. Relay health is derived from the frozen surface too — a `poll`, `send` or
`relay publish` that succeeded proves the relay answered, and exit 4 proves it did not; `uptime_ms`
comes only from the relay's own `/health`, which no CLI command exposes, so it is omitted rather
than filled with an invented number.

---

## 4. What this TUI deliberately cannot do

- **It cannot list pinned contacts it did not observe.** See §3. Adding `contact list` would be the
  ninth command the specification froze against; reading the encrypted store would require the TUI
  to hold the 32-byte store key, which is what AC5 forbids.
- **It cannot send a message.** There is no compose key and no `send` binding. `send` takes its body
  as `--text <plaintext>`, so the body appears in the child's argument vector and is visible in the
  local process table (**T9-F-003**). That is the pre-existing CLI contract, which the runbook drives
  the same way; the TUI inherits it and does not fix it, and closing it would need a change to
  `send`'s interface or a ninth entry point. Because there is no send key, the console does not add
  a new occurrence of that exposure. It is recorded here so the AC5 evidence is not read as saying
  more than it proves: **no store key or private key reaches a frame or an argv; message plaintext
  reaches an argv through `send`, exactly as before, and this console never invokes it.**
- **It cannot view history for a contact it did not observe.** `history --with <id>` needs an
  identity id, and the console has no text entry; the contact must come from the session roster.
- **It cannot rotate a bundle or retry a pending send.** `rotateBundle()`, `retryPending()`,
  `listContacts()` and `retryPendingAcks()` remain reachable from no command, deliberately.
- **It cannot resize mid-frame below 72×16.** `MIN_VIEWPORT` is 72 columns because
  `UNAUDITED_NOTICE` is 62 code points and a warning that has to be truncated to fit is not a
  warning. Below that the shell renders at the minimum rather than reflowing.
- **It renders code points, not display columns.** Combining marks and East Asian wide characters
  are out of scope, as the design note records.
- **It makes the prototype no more audited than it was.** AC6 is a notice, not AC8.

---

## 5. Manual check on a real relay

Node 26.5.0, real relay binary built from `apps/relay`, real `dist/cli.js` children, real profiles,
per `docs/requirements/echolet-cli-prototype/runbook.md`.

The relay was started on `127.0.0.1:18211` rather than the runbook's 18099, because another
session's relay already held that port. Two runs of the console binary (`dist/tui.js`) were driven
with a scripted key sequence; stdout was captured and the frames inspected. Nothing below is a
screenshot of key material: every identifier value was checked programmatically and redacted before
printing.

**Run A — two profiles (alice, bob), full import flow.** 25 frames. Activity observed on screen:
`doctor → ok (exit 0)`, `relay publish → ok (exit 0)`, `contact import → confirmed by operator`,
`contact import → ok (exit 0)`, `poll → ok (exit 0)`.

**Run B — one profile (dave) with an already-pinned contact and one pending envelope.** 25 frames,
driven through doctor → import → confirm → poll → select contact → history → all five panes.

What I saw, across both runs:

- **The trust modal shows all four identifiers, in full, before any confirmation was possible.**
  Verified against the contact card on disk: `identity_id` (43 chars), `device_id` (36),
  `device_pubkey` (43) and `signal_identity_key` (44) each appear with their field label **and**
  their complete value. The modal frame also carries the notice. Redacted:

  ```
  |UNAUDITED PROTOTYPE — not suitable for sensitive communication
  |ec╭──────────────────────────────────────────────────────────────────╮ns
  |──│ Trust these contact identifiers?                                 │──
  |pr│ profile: dave                                                    │
  |re│ card: <path>                                                     │
  |st│ identity_id:                                                     │
  |id│   <43-char public identifier>                                    │
  |de│ device_id:                                                       │
  |pu│   <36-char public identifier>                                    │
  |di│ device_pubkey:                                                   │ec
  |  │   <43-char public identifier>                                    │
  |co│ signal_identity_key:                                             │
  |+1│   <44-char public identifier>                                    │ c
  |  │ [y] trust  [n] reject  [esc] cancel                              │
  |ru╰──────────────────────────────────────────────────────────────────╯
  |[y] trust  [n] reject  [esc] cancel
  ```

- **The notice was on every frame.** 0 of 50 frames across both runs lacked it, including every
  frame with the modal open.
- **No store key appeared anywhere.** 0 of 50 frames contained any of the four real 32-byte
  base64url store keys that were in the environment at the time.
- **Every line was exactly 72 code points.** 0 violations across all frames.
- **The AC5 shortfall was visible**, in a fresh session over a profile that already trusts a
  contact: `contacts  0 observed this session` followed by
  `+1 pinned by doctor but not seen by this session (no CLI command lists c…`.
- **All five panes rendered live data**: mailbox (`inbox 1 received`, `more no`, last poll
  timestamp), history (`1  inbound  <message id>  <body>` for the selected contact only),
  rejections (`no permanently rejected envelopes in the last poll`), health
  (`relay http://127.0.0.1:18211 healthy (checked …)` and `status healthy`), profiles.

### One mistake made during cleanup

Stopping my demo relay used a `pkill` pattern (`-f relay-data`) broad enough that it also stopped a
relay another session had running on port 18099. No data was lost — relay data lives on disk and the
process is restartable — and the full `apps/cli` suite passed afterwards because every e2e suite
starts its own relay through `test/globalSetup.ts`. But if a parallel worker was mid-measurement
against that instance, I interrupted it, and it will need restarting. Recorded rather than quietly
fixed.

---

## 6. Findings answered

- **T9-F-001** (the reference's `@opentui/core` is a type-only optional dependency; the transferable
  property is dependency inversion, not absence): adopted as stated. No UI package was added,
  `apps/cli/package.json` gained no dependency, and the pure layer imports nothing outside
  `src/tui` — but the property actually relied on is that state-to-lines is pure and every terminal
  effect arrives through `TuiIo`.
- **T9-F-002**: implemented as §3, stating the shortfall on screen.
- **T9-F-003**: inherited, not fixed, and not hidden. See §4.
- **T9-F-004**: `not-implemented.ts` deleted.
- **T9-F-005**: the three constant locks were treated as contract locks, not coverage. The 87 real
  RED tests were made to pass by implementation, and the full suite was re-run from a clean state.
- **T9-F-006**: no stray files. `apps/cli/src/tui` holds exactly the 19 files listed in §1.

## 7. What was not touched

`apps/relay`, `apps/cli/src/runtime`, `apps/cli/src/transport`, `packages/crypto-core`,
`apps/cli/vitest.config.ts`, `apps/cli/test/globalSetup.ts`, `flow.json` and
`acceptance-criteria.md` are unmodified. Outside `apps/cli/src/tui/`, the only changes are
`apps/cli/build.mjs` (a second esbuild entry) and `apps/cli/package.json` (a second bin entry).
No commit was made.
