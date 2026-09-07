# T6 — Implementation: making the 18 RED tests pass with product code only

Flow 003, task T6. Input: `dispatches/003-T5-tests-result.json` (the specification),
`t2-tui-usability-design.md` (the measurements), `acceptance-criteria.md` (AC6–AC9).

**Result: 18 red → 18 green. `apps/cli` 246 passed (246), 0 failed. `pnpm typecheck` exit 0.**
No test file was changed, at all — the seven digests recorded by T5 are reproduced unchanged in
§6. Nothing outside `apps/cli/src/tui/` was touched.

---

## 1. What changed, and why the alternative was rejected

### D-1 — commands are single-flight (AC6)

| File | Change |
|---|---|
| `tui-shell.ts` | `mapKey` splits its profile-dependent bindings into `paneKeyIntent` and gates the RESULT: `if (state.busy && intent?.kind === "run") return undefined`. |
| `tui-shell.ts` | `reduce`'s `"run"` arm returns `{ state, effects: [] }` while `state.busy`. |
| `shell-chrome.ts` | `activityLine` says, while busy, `running… (busy — a command key starts nothing) <last result>`. |

**Why the gate is written over the intent, not over a list of key names.** `p d r h i` is the list
today, and a sixth command key added later would have to remember to join it. Reading the intent the
binding produced means every `run` — present and future — meets the gate; a key that produces a
`select-pane`, a `select-contact`, a `select-profile`, a `quit` or a `toggle-help` is decided above
the gate and stays live, which is the dispatch's requirement that quit, pane switching and the modal
keys keep working. *Rejected:* a `busy` check inside each `case` of the switch — five places to keep
in step, and the sixth is the bug.

**Why the reducer holds the gate too.** For exactly the reason the trust gate lives there: a `run`
arriving from anywhere — a stray keystroke, a resize race, a future scripted mode, a startup
`doctor` effect (U3) — meets one precondition rather than each caller remembering one. `mapKey`
refusing the keystroke keeps the console honest; `reduce` refusing the intent keeps it correct.
*Rejected:* the reducer alone — `mapKey` would then return a `run` that never runs, and the
pure-half test asserts the input model itself refuses.

**Why the operator is told by the STATE and not by the keystroke.** T5's third test renders
`baseState({ busy: true })` — a state with no refused keystroke in it — and requires the frame to
say the console is busy. That is the right shape: the frame the operator is looking at while a child
runs must say a second command would not start, whether or not they have already tried. *Rejected:*
appending a refusal note to `state.activity` on each refused key (the design note's U1 sketch). It
needs a timestamp `reduce` has no clock for, it makes the pane that keeps the last result show a
refusal instead of the result the operator is waiting for, and it says nothing at all on the frame
the test actually renders.

**The exit class is not manufactured, and nothing was added to make that true.** The measured
`RELAY_UNAVAILABLE (exit 4) → PERSISTENCE_FAILURE (exit 5)` corruption was never a mapping bug:
`applyOutcome` and `note()` already report `outcome.code` and `outcome.exitCode` verbatim from
`parseCliOutcome`. The exit 5 came from the second child meeting the encrypted SQLite store as a
concurrent writer. Removing the concurrency removes the fabrication; the process-driven test proves
it by counting the children that were refused by the store (`[]`) behind a causal barrier, not by
reading the paint.

### D-2 — no pane hides rows in silence, and a truncated pane keeps the rows that matter (AC7)

New module **`pane-fit.ts`** (pure, total, deterministic, no imports but `text.ts`). A pane no longer
hands `renderFrame` a flat list to be `.slice(0, bodyRows)`d — a prefix, silently. It hands over
three regions:

- `head` — its own headings and disclosures;
- `rows` — the list, the only region truncation may take rows from;
- `tail` — fixed lines below the list;

plus `keep: "head" | "tail"`, which end of `rows` survives.

`fitPane(regions, limit, width)` then: spends one row on `… N more not shown`, where **N counts LIST
rows, not dropped output lines**; gives the list at least one row whenever it has one and there is
room (a pane reduced to headings and a marker has not been truncated, it has been emptied); and
gives what is left to the fixed regions, `head` before `tail`.

| File | Change |
|---|---|
| `history-pane.ts` | `formatHistoryLines(snapshot, width, limit = Infinity)`. Entries are the list, `keep: "tail"`. The contact header and the "N entries withheld (other contacts)" disclosure are fixed. |
| `mailbox-pane.ts` | `formatMailboxLines(snapshot, width, limit = Infinity)`. Rejections are the list, `keep: "tail"`. |
| `profiles-pane.ts` | `formatProfilesLines(snapshot, width, limit = Infinity)`. The roster is the list, **`keep: "head"`**. `rosterDiscrepancy` moved above the list so it is a fixed line. |
| `shell-chrome.ts` | The rejections pane composes through `fitPane` too (`keep: "tail"`); `paneLines` takes `bodyRows` and passes it down. |

**Why the count is list rows and not output lines.** History with 30 entries at `MIN_VIEWPORT` shows
9 entries and hides 21, but hides 21 *entries* and 22 *lines* (the contact header is not a row of
data). T5's tests derive `hidden` as `supplied − visible` from the frame itself, so a line-based
count would be off by the head — and, more to the point, "how much of this list am I not looking at"
is the number an operator can act on.

**Why the budget goes down into the panes instead of being applied in `renderFrame`.** Which rows a
pane may drop, and from which end, is a fact about that pane. `renderFrame` knows only that it has
`bodyRows`. Keeping the slice in the frame would mean the frame deciding that a roster and a
conversation truncate the same way, which is precisely the defect. *Rejected:* a `paneOffset` field
in state with paging keys (the design note's U5, second half) — that is reachability, a separate
requirement, and it is not what these tests pin. Recorded as a residual in §5.

**Why the contact roster keeps its head while history and rejections keep their tail.** The dispatch
says the roster is deliberately unpinned and forbids inventing an ordering for it, and T5's file
records three reasons. `keep: "head"` is not a new ordering: it is the order the roster already had,
left alone. It also has to be left alone — `c` cycles `state.contacts` from the head, so a pane that
showed the tail would cycle the operator through contacts it is not showing, which is a worse defect
than the one being fixed. The pane still tells the operator it is short and by how much, from both
the D-2 marker and `rosterDiscrepancy`.

**Why `rosterDiscrepancy` moved above the list.** It is the pane's own account of what it cannot
name. As the last line of the pane it was the first thing a tight pane dropped; as a fixed head line
it is among the last. Nothing else about it changed, and it is still asserted at its old value by
`profiles-pane.test.ts`.

### D-3 — every advertised key is visible at the minimum viewport, and there is a key list (AC8)

| File | Change |
|---|---|
| `shell-chrome.ts` | The footer is a ranked list of labels, not one 106-column string. `fitFooter` takes the widest prefix by rank that fits `cols`. `[q] quit` is rank 1 and `[?] help` rank 2, so they are the last to go. |
| `shell-chrome.ts` | `HELP_LINES` — every binding, replacing the pane body when `state.help` is set. |
| `tui-shell.ts` | `mapKey` binds `?` to a new `toggle-help` intent; `reduce` toggles `state.help`. |
| `intents.ts` | `toggle-help` added to `Intent`. |
| `state.ts` | `readonly help?: boolean` — OPTIONAL, so no existing state literal changes shape. |

At 72 columns the footer is now
`[1-5] pane  [p] poll  [d] doctor  [r] publish  [?] help  [q] quit` (65 columns). What it drops,
`?` names.

**`MIN_VIEWPORT` was not moved and the notice was not shortened**, as the dispatch requires; both
were considered and rejected upstream, and 72 is derived from the notice's 62 columns.

**Why the key list replaces the pane body rather than floating over it as a second modal.** It then
inherits the frame's shape, the `UNAUDITED_NOTICE` on row 0 and the escape-free guarantee with no
second layout to audit, and `renderFrame` stays one pass. *Rejected:* a `Modal` union member — that
would put a second door on the surface whose reducer arm the trust gate lives in, and `help` is not
a decision: it takes no exclusive control of the keyboard, so `q`, the pane keys and the command
keys all keep working while it is open.

**Why `help` is optional on `OperatorState`.** A required field would change the shape of every
state literal in the suite, including the seven files this task may not touch. Absent means closed.

### D-4 — the shell paints the terminal it was given (AC8)

| File | Change |
|---|---|
| `tui-shell.ts` | `viewport()` no longer clamps up to `MIN_VIEWPORT`; it reports the terminal's own size. A terminal that reports nothing (a pipe) still falls back to `MIN_VIEWPORT`, which is a default and not a clamp. |
| `shell-chrome.ts` | `isBelowMinViewport(viewport)` (exported) and `tooSmallFrame(state, cols, rows)`: the notice **wrapped** across as many rows as it takes, the actual and required sizes, and how to quit. `wrapToWidth` hard-wraps every line of that frame so the frame that explains a too-small terminal is not itself cut off by it. |
| `tui-shell.ts` | `paint()` records `modal.renderedAt` only when the painted viewport was **not** below the minimum. |

`shell-chrome.ts:30` documented this behaviour since flow 002 and never implemented it; it is
implemented now and the comment updated to say `MIN_VIEWPORT` is not a floor the shell clamps to.

**The `renderedAt` change is the security half of D-4 and is a strengthening, not a side effect.**
The degraded frame carries no modal. Had `paint()` gone on recording `renderedAt` unconditionally,
a trust confirmation would have become answerable on a 40×10 terminal for a modal whose four
identifiers were never on the screen — "the operator saw the identifiers" would have become a claim
about the code again. The reducer's refusal is unchanged; what changed is that the shell no longer
lies to it. The degraded frame says a trust decision is waiting and to resize, so the refusal is
visible rather than looking like a hung console.

**Why not "always paint at least the minimum".** T5's test asserts a 96×28 terminal is still painted
at 96×28 in the same test, precisely so that answer cannot pass for a fix.

### The two small ones

| File | Change |
|---|---|
| `main.ts` | `USAGE` + `wantsHelp(argv)`: `--help` / `-h` prints usage on stdout and returns 0, before `parseOptions` and before the alternate screen. `parseOptions` also recognises the zero-argument flag before reading its successor as a value, which is what produced `--help needs a value`. |
| `profiles-pane.ts` | The module doc comment no longer says the roster holds contacts "observed being **exported or** imported"; it says imported, and says why an export is not one. |
| `state.ts` | The same false claim on `ContactView`'s doc comment, fixed the same way. |

`wantsHelp` scans **positionally** — every other option this binary has takes exactly one value — so
`--label -h` is a label and not a request for help. *Rejected:* `argv.includes("--help")`, which
would turn any value that happened to look like the flag into a usage dump.

`--help` with no `--profile` exits 0; an invocation with neither still exits 2 on
`at least one --profile <dir> is required`, unchanged. That is the documented input/configuration
class and it was not widened.

---

## 2. How `renderFrame` stayed pure and total while the shell learned to paint any viewport

The dispatch asked this explicitly. Four things hold it:

1. **`renderFrame` was already total; only the shell was clamping.** The defect was never in the
   renderer — `renderFrame(state, {cols: 40, rows: 10})` already returned exactly 10 lines of 40 at
   flow 002. It was `runTuiShell.viewport()` raising 40 to 72 before calling it. So the fix is one
   `Math.max` removed at the impure seam plus a defined frame for the range the renderer was
   previously never handed, not a change to the renderer's contract.

2. **The degraded branch is a total function of the same two arguments.** `tooSmallFrame` reads
   `state.modal !== undefined`, `cols` and `rows` and nothing else — no clock, no environment, no
   mutation. `wrapToWidth`'s loop steps by `cols`, and `renderFrame` guarantees `cols >= 1` before
   any of this runs, so it terminates for every input. The result is `.slice(0, rows)`, padded to
   `rows`, and every line through `fitLine(line, cols)` — the same exit path the defined frame uses,
   so "exactly rows × cols in code points" is enforced in one place for both branches.

3. **The truncation decision moved into a pure module, not into the shell.** `fitPane` takes
   `(regions, limit, width)` and returns lines. Its `limit` comes from `viewport.rows` by arithmetic
   `renderFrame` already did. Every number it uses is derived from its arguments; the only inputs
   that vary are the two `renderFrame` is given. It clamps a non-integer, negative or infinite
   `limit` rather than trusting it, so no viewport — hostile or accidental — makes it throw or
   return more lines than asked for.

4. **The new text is text.** No escape byte is constructed anywhere outside `styleFrame` and
   `runTuiShell`; the footer, the marker, the busy line, the key list and the degraded frame are
   plain strings. `shell-chrome.test.ts`'s escape sweep and `tui.keyMaterial.test.ts`'s
   `PRIVATE_KEY_MARKERS` sweep run over all of them unchanged and pass.

The flow 002 properties were re-asserted, not assumed: `shell-chrome.test.ts` (12),
`tui.keyMaterial.test.ts` (9), `modal-host.test.ts` (14) and `tui-shell.test.ts` (14) are green
untouched, and every one of T5's new frame-level tests re-asserts rows × cols, no ESC and
`UNAUDITED_NOTICE` on the very frames it adds requirements to.

---

## 3. Test results

All 18 named by T5, each now green (`vitest run src/tui`: 15 files, 108 tests, 0 failed).

| File | Test | Result |
|---|---|---|
| `tui-shell.singleFlight` | does not turn a command key into a run intent while busy, and keeps quit, panes and the modal live | PASS |
| `tui-shell.singleFlight` | emits no run-cli effect for a run intent that arrives while busy | PASS |
| `tui-shell.singleFlight` | tells the operator that the console is busy rather than dropping the keystroke in silence | PASS |
| `tui-shell.singleFlight` | drives the real shell: five command keystrokes in flight call runCli exactly once | PASS |
| `main.processDriven` | spawns no second child while a command is in flight | PASS |
| `main.processDriven` | reports the exit class the CLI returned, and does not manufacture a persistence failure | PASS |
| `main.processDriven` | prints usage and exits 0 for `--help` | PASS |
| `shell-chrome.overflow` | says how many history entries it is not showing | PASS |
| `shell-chrome.overflow` | says how many contacts of the roster it is not showing | PASS |
| `shell-chrome.overflow` | says how many rejected envelopes it is not showing | PASS |
| `shell-chrome.recency` | keeps the most recent history entries, not the first ten of the conversation | PASS |
| `shell-chrome.recency` | keeps the most recent rejected envelopes, which are the ones not yet acted on | PASS |
| `shell-chrome.recency` | keeps the most recent entries at a taller viewport too | PASS |
| `shell-chrome.legend` | shows the operator how to quit at the minimum viewport | PASS |
| `shell-chrome.legend` | binds a help key | PASS |
| `shell-chrome.legend` | advertises the route to the full key list at the minimum viewport | PASS |
| `tui-shell.smallViewport` | writes no line wider than a 40x10 terminal, and keeps the unaudited notice on the frame | PASS |
| `profiles-pane.rosterClaim` | does not describe the roster as holding exported cards as well as imported ones | PASS |

Whole package: `pnpm --filter @echolet/cli test` → **43 files, 246 passed (246), 0 failed**
(228 pre-existing + 18 new). `pnpm typecheck` (7 workspace projects) → **exit 0**.

Worked examples of the new layout, at `MIN_VIEWPORT`:

```
history, 30 entries              roster, 30 contacts             40x10 terminal
history with CONTACT-01          contacts   30 observed …        UNAUDITED PROTOTYPE — not suitable for s
  22  outbound  HISTORY-22 …       CONTACT-01  DEVICE-01         ensitive communication
  …  (23 … 29)                   … 29 more not shown
  30  outbound  HISTORY-30 …                                     40x10 — this console needs 72x16
… 21 more not shown                                              resize, or press q to quit
```

---

## 4. What was NOT done, on purpose

- No ninth CLI command. `CLI_COMMANDS` and `buildArgv` are byte-identical.
- No mouse support, no colour theme, no persisted preference file. `help` is session state in
  `OperatorState`; the console still writes no file.
- `MIN_VIEWPORT` not moved; `UNAUDITED_NOTICE` not shortened.
- No test weakened, skipped, narrowed or deleted; no `.skip`, no `.only`, no assertion removed.
- Nothing in `apps/relay`, `packages/` or `docs/` touched. The concurrent `apps/relay` work was
  ignored entirely and none of its files were read or changed.
- No relay started. `geekom` and `depr` were not contacted. The `apps/cli` suite stands up its own
  loopback relays; the TUI tests use a fake CLI over a unix socket and touch no store, key, relay,
  plaintext or HTTP body.
- No store key, private key, plaintext or HTTP request body was printed or recorded, here or in any
  command run.

---

## 5. Residuals

1. **A pane whose FIXED lines alone overflow still drops some of them without a count.** The marker
   counts list rows; head and tail are clipped, `head` first. Measured case: the profiles pane at
   72×16 with no observed contacts loses its relay-health line — which is exactly what it did before
   this task, so this is carried forward, not introduced. The health line has its own pane (`5`).
   Fixing it properly means a second counter for chrome, or panes that fold their own separators;
   neither is required by these tests.
2. **The roster is counted but still not reachable.** `… 29 more not shown` tells the operator the
   pane is short; nothing yet lets them page to contact 30. That is U5's other half (a paging key
   plus a `paneOffset` in state) and it has to be decided with U6's rework of the `c` cycle, which
   is why T5 deliberately pinned no ordering for the roster and why none was invented here.
3. **Long fixed lines are still clipped rather than wrapped inside the defined frame.**
   `+30 pinned by doctor but not seen by this session (no CLI command lists contacts)` loses its
   last word at 72 columns. Pre-existing; `wrapToWidth` is used only on the degraded frame, where a
   truncated explanation of truncation would be self-defeating.
4. **`state.activity` still only surfaces its last entry.** A result that completes while the
   operator is reading another pane is kept in state but only the newest is painted. That is U2 (the
   activity pane and `outcome-explainer.ts`), untouched here.
5. **The refusal is stated by the busy frame, not per keystroke.** An operator who presses `d`
   during a poll sees "busy — a command key starts nothing", which was already on the frame before
   they pressed it. It is true and it is visible; it is not a per-keystroke acknowledgement. A
   pure-layer acknowledgement needs a clock the reducer does not have.
6. **`-h` is accepted as an alias for `--help`.** Positional scanning keeps it from swallowing an
   option value, but a future zero-argument option must be added to `HELP_FLAGS`' sibling handling
   in `parseOptions` or it will consume its successor the way `--help` did.
7. **The help list is maintained by hand.** `HELP_LINES` and `FOOTER_KEYS` name what `mapKey` binds,
   and nothing machine-checks the relation in both directions. The design note's U4 asks for exactly
   that relation test; writing it is a test task, and this task may not write tests.

---

## 6. Identity

The seven test files, SHA-256, unchanged from `003-T5-tests-result.json`:

```
f0dfa6b6a232dcab2f9ae737f0b63bda42d35542987ff41ac547bd3d9d22875c  tui-shell.singleFlight.test.ts
f72a5fc61aa4ee3817f6d7fef0beecbce7bc8a7e71d589958f84a843bc0edcc7  main.processDriven.test.ts
0b05771915dc9e11edab67d228813ad63fc664a4a2bfd938201e38f93e9de301  shell-chrome.overflow.test.ts
aad0312c3f2d30a3ecbf44fce04f1c8358359e8083f85a215e30026a82d5bc73  shell-chrome.recency.test.ts
b0608084267caf10e7a2ff6284258c7cd955464a99dd15b1e71ad7c7b499a9e8  shell-chrome.legend.test.ts
af49ba463b1457a35f1fb8dafcac54e8f01129878ddaa07c1c9f46b4e8e5e814  tui-shell.smallViewport.test.ts
610cf9a3d8379ff04753184ceecc2c238b81f0dfa15f10a0da2485c75ae87607  profiles-pane.rosterClaim.test.ts
```

Product files after this task (all under `apps/cli/src/tui/`):

```
814f3253a67099ecf98f8fef9bca5b52e9817c35a5639f7e3c49ef83f851988f  shell-chrome.ts      (modified)
0c5866f08a563c786b9ce74c2262a48ba882a60bc12c8896f4b72d73631b030b  pane-fit.ts          (added)
228d5d426a30a9edcc4a0e27478b2274494846e7b45078e5374e7857e48c6920  history-pane.ts      (modified)
8565a187ad5d4a2ce7d1d3d48755549f85f79716508dd4d169be1f14d92815f1  mailbox-pane.ts      (modified)
2eb67c11c46a4309b0a4b5a28222df2c77ff2b8b1ea8333ff7873e62b7b9935a  profiles-pane.ts     (modified)
69923c2b0dd699267a4633a5e8406c65585702c0a06b9fce058343f697a10bc1  state.ts             (modified)
02d6679d83774a838e9e1419d18bea7e939c55a9791a9f4631730ce678000640  intents.ts           (modified)
cdf4f14a59d973af72f6298a9d43f55fa84dc6055a47f14a602a5af9b831a8e5  main.ts              (modified)
185e8a9fc40c8ff9383c0f0c28f045c9bc4271ac1965564383bde65fb4333fda  tui-shell.ts         (modified)
f8bde1f761eddcfcbdf4343b662b67aea240ec8eb97128905ca1493b90a14a24  cli-bridge.ts        (unchanged)
15fc15e8cb05fb8948c83e0f101a1de2683cf35db3a7fd07856d7d7d578ae3c3  modal-host.ts        (unchanged)
2cb8f24a727a3c9e701ed482aee9033b1f18a7b8c1eced13317e160213b69f26  text.ts              (unchanged)
```

The tree is fully untracked (`git status` shows every path as `??`), so there is no diff to quote:
identity is by SHA-256 above. `cli-bridge.ts`, `modal-host.ts` and `text.ts` are the three TUI
product files this task did not open for writing, and their digests are listed so a reviewer can
confirm `CLI_COMMANDS`, `buildArgv`, the four-identifier completeness check and the width primitives
were not reached.

---

## 7. Routing audit

- `graph_used`: no — not-relevant. The task named its seven test files and their subjects
  exhaustively; every product file involved is a direct import of one of them, read in full.
- `wiki_used`: no — not-relevant. The architecture, the domain rules and the decisions in play were
  supplied in-band by `t2-tui-usability-design.md`, `acceptance-criteria.md` and T5's result JSON,
  which are more specific than the wiki pages for this surface.
- `ctx_used`: yes — `keryx ctx rg` for the T2 heading sweep; command output routed through the
  gdctx hook throughout.
- `raw_rg_used`: yes, once — `grep -n "^#"` over `t2-tui-usability-design.md`, with the
  `# keryx:raw` marker and the reason recorded inline: the compacted `ctx rg` summary elided most of
  the heading list, and exact line numbers were needed to read §7 without loading a 623-line file.
