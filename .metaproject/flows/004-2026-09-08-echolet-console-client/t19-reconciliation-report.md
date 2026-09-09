# T19 — reconcile every document with the console the tree now has

Flow 004, T19, 2026-09-09, HEAD `860005b`. Documents only: no source file, no test file, no test
suite, no build was run. Every claim below was checked by reading source, not by re-running
anything, and every count below comes from a raw `keryx ctx rg`/`keryx ctx run` log, not from a
truncated summary line.

## What changed in the tree tonight (verified by reading source)

- `apps/cli/src/commands/cli.ts:210-274` (`readStdinBody`, `resolveSendBody`) — `send` reads its
  body from stdin when `--text` is absent; `--text` still works; supplying both makes `--text` win
  and stdin is never read; `--text ""` (explicitly empty) is `INVALID_ARGUMENTS`/exit 2 before stdin
  is touched.
- `apps/cli/src/runtime/profile.ts:476-479` (`Profile.diagnostics`) — `doctor` additionally returns
  `contacts` (the pinned correspondents' four public identifiers, sorted), additive to
  `contact_count`; stays offline (local encrypted store only, no relay call).
- `apps/cli/src/tui/tui-shell.ts:184-207` (`paneKeyIntent`, case `"w"`) and `:154-162`
  (`inputKey`) — `w` on the history/conversation pane (ordinal 3) opens a compose row when a
  contact is selected, nothing is busy, and the profile has published; `Enter` submits, `Escape`
  cancels; while composing, `q` is ordinary text and Ctrl-C is the only way out
  (`inputKey`, tui-shell.ts:155).
- `apps/cli/src/tui/state.ts:56` (`SETUP_STEPS = 6`) and `tui-shell.ts:241-263`
  (`setupStepIntent`) — a six-entry registration checklist on the profiles pane (step 0: store-key
  presence, gating everything; steps 1-5: init, publish, export, import, doctor, one per `Enter`).
  The console also runs one un-asked-for `doctor` at startup (confirmed independently by
  `004-T17-tests-result.json`, which reconciled `main.processDriven.test.ts` to this behaviour).
- `apps/cli/src/tui/tui-shell.ts:418-472` (`steersTheDisplay`, `paintable`) — control characters
  (C0 U+0000-U+001F, DEL U+007F, C1 U+0080-U+009F) and 14 named display-steering code points
  (U+200E, U+200F, U+202A-U+202E, U+2066-U+2069, U+2028, U+2029, U+FEFF) are filtered from
  everything that reaches a frame from outside the process, including the compose buffer itself.
- `apps/cli/src/tui/tui-shell.ts:78-97` (`mapKey`, modal branch) — Ctrl-C quits while the trust
  modal is open, alongside the existing trust-confirm/trust-cancel keys.
- Pane set is unchanged: `apps/cli/src/tui/state.ts:25` still lists exactly
  `["profiles", "mailbox", "history", "rejections", "health"]`. Renaming `history` to a conversation
  pane and adding a separate address-book pane is a proposed, not-yet-implemented design
  (flow 004 T20), not something in the tree yet.

## Documents checked

Per the dispatch's instructions, checked first: `docs/requirements/echolet-cli-prototype/`
(`specification.md`, `README.md`, `prd.md`, `runbook.md`, `deployment-runbook.md`,
`metrics-and-validation.md`, `implementation-plan.md`) and `docs/STATUS_CURRENT.md`; then searched
the rest of `docs/`, the project's Metaproject wiki, and `apps/cli` for any document describing the
console's keys, panes, or command surface. Full match counts below come from the raw `rg` log each
`keryx ctx rg` summary points at, not from the (truncated) displayed list.

- **`docs/requirements/echolet-cli-prototype/specification.md`** — already correct, no change
  needed. Its `send`/`stdin` section (lines 76-90) and `doctor` section (lines 92-94) already
  describe exactly the stdin/`--text` precedence and the `contacts` array read from the current
  tree, down to the same edge cases (`--text ""` refusal, TTY-with-no-`--text` refusal). This
  document was evidently reconciled earlier in flow 004 (T5/T6 landed the two CLI prerequisites
  first); it does not describe the console's keys/panes/checklist at all, so nothing there
  contradicts the newer TUI changes either — there is simply nothing to correct.
- **`docs/requirements/echolet-cli-prototype/README.md`, `prd.md`, `runbook.md`,
  `deployment-runbook.md`, `metrics-and-validation.md`, `implementation-plan.md`** — none of these
  discuss `send`/`doctor`'s exact shape or the console's keys, panes, or checklist (checked with
  `keryx ctx rg` for `TUI|pane|compose|checklist|Escape|Ctrl-C|registration|trust modal|contacts|doctor|--text|stdin`
  against each file; the only hits were unrelated prose — e.g. "sends" inside `docker-compose`, or
  the flood-class/TLS/cleanup-service items already reconciled by earlier flow work). No changes.
- **`docs/STATUS_CURRENT.md`** — changed. Added a new dated delta (flow 004, T19, HEAD `860005b`)
  naming all six items above, following the file's own base-plus-deltas convention (same shape as
  the existing T28/T40 deltas): the pin (`4346e2b`) is untouched, no existing sentence was rewritten
  or deleted, and the header's list of dated deltas now also names T19. The base's one relevant
  sentence — "Операторская TUI... профили, очереди, история, отказы и здоровье relay" — is not
  contradicted by tonight's tree: the pane set really is unchanged, so nothing there needed
  correcting, only the net-new capabilities needed recording.
- **Rest of `docs/`** (`API-11`, `PROTOCOL-07`, `STORY-04`, `TEST-16`, `TRACE-25`, and the other
  numbered planning docs, plus `docs/README.md`) — searched for the same terms; the only hits were
  historical M1-M3 milestone checklists from early planning, unrelated to the current console. No
  changes.
- **Metaproject wiki** (`.metaproject/wiki/`) — searched; only component stub/draft pages exist,
  none describing TUI keys or panes. No changes.
- **`apps/cli`** — no markdown files exist under it (checked with `find`).

## Where tree and document disagreed and I could not tell which was right

None found. Every discrepancy located was resolvable by reading source: in each case the tree was
unambiguous and the affected document (only `STATUS_CURRENT.md`) simply predated the change rather
than asserting something different from it.

## Left alone, and why

- **`.metaproject/flows/003-2026-09-07-echolet-residuals-and-tui/t35-console-client-design.md`**
  (the pre-implementation design for tonight's console work) — read in full for the registration
  checklist and `send`/stdin sections. Its heading at line 134 says "The five steps", while its own
  table on the next line lists six rows (0 through 5) and the shipped code's `SETUP_STEPS` constant
  is `6` — the header's count and the table's content are in tension, though the table itself is not
  wrong. I left this alone rather than editing it: this is a dated, point-in-time design record
  inside a flow package (the kind of document this repository's own convention treats as historical,
  the way T28's delta above treats the base it corrects as frozen rather than live), not a
  maintained specification the dispatch named or that a user reads for current status. Flagging it
  here rather than silently leaving it, per the instruction to name what was deliberately left
  alone.
- **`docs/OPS-23_LOCAL_ENV_VARS.md` and the `deploy/relay/*` files** modified earlier tonight (per
  the session's starting `git status`) — these belong to a different, already-closed piece of work
  (flow 003 T28's removal of `ECHOLET_CLEANUP_INTERVAL_SECONDS`), unrelated to the six console
  changes this dispatch was asked to reconcile. Not touched.
- **`docs/requirements/echolet-cli-prototype/schemas/`** — not a prose document describing the
  console; not in scope.

## Procedure note

No test suite and no build were run, per the hard constraint (a concurrent dispatch, T18, is
measuring the suite on this machine and a second load would corrupt that measurement). Every fact
above was verified by reading the actual implementation files listed, not by running them, and every
`rg` match count quoted above was taken from the raw log a `keryx ctx rg` summary pointed at.

## Routing audit

- `graph_used`: no — not-relevant; every file in question was named either by the dispatch or found
  through `keryx ctx rg`, and the graph predates this session's commits regardless.
- `wiki_used`: yes — checked `.metaproject/wiki/` for any page describing the console; found only
  draft component stubs, no contradiction.
- `ctx_used`: yes — `keryx ctx read` for every file read, `keryx ctx rg` for every search, `keryx ctx run`
  for every shell command (`find`, `git log`, `git status`, `git diff --stat`, `git merge-base`).
- `raw_rg_used`: no.
- `testing_context_used`: no — not-relevant; no test was written, changed, or run.
- `memory_used`: no — not-relevant; the flow's own dispatch results (T5-T17) carried the history
  this task needed.
