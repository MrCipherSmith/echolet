# Flow 004 wave report — Echolet: the console becomes a client

Date: 2026-09-09. Tree at report time: `826cb9f` (T18–T22 closed; T23 dispatched but still `todo`
in `flow.json`, running concurrently on this machine — no test was run to produce this report).
Working tree carries only the flow's own `flow.json`/`journal.md` in progress from that run.

This report reads six independent-verification records (T7, T12, T18 — mutation-based, run by an
agent other than the one whose work it checked) and the intervening implement/test dispatches
(T5–T6, T8–T9, T10–T11, T13–T14, T15–T17, T20–T22), and cites file:line and commit evidence a
reader can check without trusting this document. Where a row rests only on a dispatch's own report
rather than on an independent verification, that is stated — per this week's lesson that a report
is a claim, not evidence.

---

## Part 1 — Acceptance criteria, one by one

### AC1 — registration completed from inside the console alone

**Verdict: PARTIAL.** Last checked by an independent verification (T18, tree `860005b`, unchanged
through `apps/`/`packages/` at report time).

- Holds: `main.registration.processDriven.test.ts` drives all five console-visible steps (init,
  relay publish, contact export, contact import through the trust modal, confirming doctor) from
  keystrokes, one child at a time, every argv pinned. T18 re-ran it and independently killed five
  mutations against it.
- Does not hold as literally stated: **"against a real driven CLI process"** is satisfied as "a
  real child process," not as "the real CLI" — every driven test in the package spawns a `FAKE_CLI`
  the test itself writes (`main.registration.processDriven.test.ts:101-143`); a routed search over
  `apps/cli/test/e2e` for `tui|console` returns zero matches (T18 F-007). No test anywhere proves
  `apps/cli/dist/cli.js` accepts the argv the console emits.
- Step 0 (creating the store-key environment variable) requires the operator to run a shell command
  outside the console **and restart it** — `withStoreKeyPresence` is computed once at startup
  (`main.ts:262`) and never recomputed (T18 F-006). The pane's own text is honest about the
  restart. AC10's last sentence requires such a step to be **named as a miss against AC1**; the
  implementation instead calls it "by design and permanently" (T18 Q-001). Whether this is a step
  AC1 counts, or a precondition outside its five-step list, is an open question the flow raised for
  the user and did not resolve.

### AC2 — the console shows what the store holds, not an optimistic echo

**Verdict: NOT MET.** Confirmed by all three independent verifications that reached it (T7 n/a,
T12, T18).

- `applyOutcome`'s `send` case increments `outboxPending` itself and never reconciles it against
  the store (`apps/cli/src/tui/tui-shell.ts:768` at the T18-verified tree — the exact clause AC2
  forbids). The neighbouring `inboxReceived` accumulation (`tui-shell.ts:756`) has the identical
  shape.
- The compose-and-send half is real: a keystroke sequence produces exactly one `send` request
  carrying the selected contact and the typed buffer (T12, driven probe).
- **In progress, not landed:** T23 ("RED tests: the outbox count must come from the store...") was
  dispatched to fix exactly this and is still `todo` in `flow.json` at report time — its own agent
  is the one currently measuring the suite on this machine, which is why this report ran no tests
  of its own. Nothing in this criterion's status should be read as reflecting T23's (unknown, not
  yet produced) result.

### AC3 — plaintext body never in argv/env; stdin only; `--text` stays; retirement recorded as open

**Verdict: MET**, on the amended criterion (see below).

- **The amendment is on the record, not asserted here as new context.** Journal, 2026-09-08T23:16:
  the frozen AC3 required removing `--text`; that would have broken nine call sites in the
  operator's own live prototype scripts (`echolet-try.sh`, the `depr` peer wrapper), outside this
  wave's authority. AC3 was updated via `keryx flow ac update` to keep `--text`, require the stdin
  path for the console, and record retirement as an open decision — recorded in
  `acceptance-criteria.md` itself, not just the journal.
- Body-on-stdin: `cli.sendStdin.test.ts` (4 tests, including a publish→import→send→history
  round trip proving byte-exact untrimmed delivery).
- The console's real spawn is the load-bearing check, and it was independently mutation-tested
  twice: T7 (first slice) found it **not met** — the only test asserting argv ran over the pure
  `buildArgv`, and a mutant (M6) that appended `["--text", request.text]` to the real `spawn()` call
  in `main.ts` passed all 117 `src/tui` tests. This was closed in the same slice by T8/T9. T12
  (input-mode slice) re-mutated the real spawn site directly — `main.ts:174` is the one spawn call
  in non-test source — with three separate mutants (argv, environment, non-byte-exact stdin write),
  all killed. T18 re-audited the same site by source read (did not re-mutate) and found it
  unchanged.
- `--text` still works: a regression-guard test passes, and `rg` over `~/echolet-try.sh` and
  `~/.echolet/peer` (outside this repo) reports 9 matches across 2 files, confirming the call-site
  count the amendment cites.
- Documented: `specification.md` and `runbook.md` both carry the argv-exposure note and the
  retirement-is-open-decision statement (T9 fixed two false claims about this note's placement and
  content that T7 had itself gotten wrong in a different direction — see Part 3).
- Residual, not blocking AC3 as amended: an explicitly-supplied-but-empty `--text` used to be a
  refusal and silently became "treated as absent" in the same slice that added stdin; T9 restored
  the refusal (`INVALID_ARGUMENTS`, exit 2) and corrected the two documents that had called the
  change "unchanged from earlier releases."

### AC4 — address book: every pinned correspondent, trust state, four comparison values in full

**Verdict: NOT MET — not built.** No `contacts`/address-book pane exists on the tree at any commit
in this flow. `PANE_IDS` is still `profiles, mailbox, history, rejections, health`
(`apps/cli/src/tui/state.ts`, confirmed by T12 and T18 independently).

- `doctor` has carried the data this pane needs since T9 (`profile.ts:476-479`,
  `contacts: ContactIdentifiers[]`), but nothing in `src/tui` reads `data.contacts` anywhere on the
  tree — this is stated as a measured fact in `t20-address-book-design.md` §1.1, not inferred here.
- A full design exists (`t20-address-book-design.md`, commit `fc5bb8f`) with two buildable branches
  (pane count unchanged vs. two panes removed), pure/driven test list (U-1…U-9, D-1, D-2), and the
  one CLI-adjacent prerequisite it needs (repeatable `--card`/`--name`, sized as "P-4," touching only
  `main.ts`'s composition root). See Part 2 for the branch decision and its new cost.
- No task after T20 has implemented any part of it. AC4 is unmet by absence, not by defect.

### AC5 — every exit class presented accurately; totality over the command × exit-class matrix

**Verdict: NOT MET.** Last checked by T18 (independent verification, tree `860005b`).

- One surface has genuine totality: `profiles-pane.setup.test.ts:255-282` crosses the five
  child-spawning registration steps against all four failure classes (2/3/4/5) — 20 cases, each also
  asserting the pane names no *other* exit number.
- Everywhere else, sampled only: `main.processDriven.test.ts:290` is the sole exit-class assertion
  for `poll`/`send`/`history`/`contact`, and it is one case, not a matrix.
- "Presented with a message that is accurate" is not met even where totality exists: the checklist
  prints the CLI's raw code and the exit number (e.g. `RELAY_UNAVAILABLE (exit 4)`), not words a
  non-technical operator would read as an explanation — a gap the T16 implementer's own report
  names as known and unaddressed.
- **In progress, not landed:** T23 ("...every exit class must be named in words") targets this and
  is still `todo` at report time, for the same reason given under AC2.

### AC6 — flows 002/003 properties re-verified unchanged on the final tree

**Verdict: LIKELY MET as of commit `0d97cbc`, but not independently re-verified since.** Treat this
row as resting on a claim until a fresh mutation pass confirms it — the two agents involved (T21,
which wrote the RED tests, and T22, which wrote the one-line fix) are different from each other,
but neither is the independent "verify" role T7/T12/T18 filled, and no such role has run since.

What the trail actually shows, in order:

1. T12 (independent verification) found AC6 **not met**: the submit path's single-flight guarantee
   was untested and a mutation reached it silently (F-001), and `renderFrame` was not escape-free
   over four external-text routes (F-002).
2. T14 closed both in the same source file (`tui-shell.ts`): one predicate (`paintable`) applied at
   five write sites plus one Ctrl-C-in-modal fix the specification's own test forced (commit
   `94899ef`). Verified there by three self-mutations, each killed, each reverted.
3. T18 (independent verification, next slice) re-checked AC6 on the tree the registration slice
   produced and found it **not met again**, for a *new* reason: the registration slice's own
   `foldSetup` wrote the CLI's `error.code` into `profile.setup` **without** the `paintable()`
   boundary every sibling writer uses, so a hostile exit-code string could put a raw ESC into a
   frame (F-001, reproduced by execution: `tui-shell.ts:713`, `profiles-pane.ts:85`).
4. T21 wrote a RED specification for exactly that gap (`tui-shell.outcomeEscape.test.ts`, 6 of 7
   cases red against the T18 tree) plus regression pins for two behaviours T18 separately found
   unpinned-but-correct (arrow-key decoding, mid-paste submission — T18 F-002/F-003; these were
   test gaps, not live defects, and T21's own mutation runs confirm the current code already
   behaves correctly on both).
5. T22 applied the one-line fix T21's own header recommended
   (`failed: paintable(outcome.code)` at `tui-shell.ts:713`, commit `0d97cbc`) and reported the red
   file going 7/7, the `src/tui` scope 30/30 files and 299/299 tests, `tsc` exit 0, and the full
   package spot-checked three times under heavy load with zero actual test failures (only vitest
   3.0.8's known RPC-timeout report loss, explicitly distinguished from a real failure by grepping
   the raw logs for failure markers).

So: the specific defect T18 blocked AC6 on has a fix with strong, consistent evidence across two
different agents' independent numbers. What is missing is the same independent third pass that
caught this defect and the previous one — nobody has mutated the *current* tree looking for an
eighth boundary the way T7→T12→T18 each found a new one. Given this flow's own pattern (a fresh
route was found unfiltered at every slice so far), report this as **fix landed, re-verification
still owed**, not as a clean MET.

### AC7 — operator-typed control/escape characters cannot reach a frame, at the reducer boundary

**Verdict: MET.** Confirmed independently at T12 and T18 (unchanged surface).

- The filter is applied where the compose buffer becomes state (`tui-shell.ts`, `paintable` on the
  `input-insert` path), not in the renderer. T12: deleting the filter turns 4 assertions red in
  `tui-shell.input.test.ts` and leaves `shell-chrome.input.test.ts` fully green — proof the property
  cannot be satisfied by a renderer-side fix (correcting the implementer's own self-report of 5
  killed cases to the measured 4 — T12 F-006).
- Residual, recorded as a scope decision rather than a defect (T12 F-004, Q2 — unresolved,
  `can_be_resolved_by_agent: false`): the filter refuses C0/DEL/C1 but not the fourteen bidi/format
  code points (U+202E right-to-left override foremost among them); a peer- or self-composed body
  containing one can render the compose preview in an order that is not the order Enter will send.
  AC7's text ("a control character or an escape sequence") is satisfied under the reading the design
  used; whether to widen it is unresolved.

### AC8 — the operator is never denied a way out, at any viewport and in any state

**Verdict: PARTIAL — believed met, full sweep not re-run.** T18's own words: Ctrl-C quits from a
state with the compose row open and from the trust modal open (T14 fixed the modal case,
`mapKey`'s modal branch now binds Ctrl-C ahead of `modalIntent`, forced by a test that could not be
edited — T14 F-001), and the registration harness relies on exactly this. T18 states it "did not
re-run a viewport sweep against a command in flight, so the 'at any viewport, in any state' clause
is carried forward from earlier flows rather than re-measured here." No later task closed that gap.
Separately (T12 F-003, not a denial of AC8's own way out, since Ctrl-C is still available and named
on the same frames): fifteen frames advertise `q` and eight other letters as live commands while the
compose row is open and the key list is also open — misleading rather than trapping.

### AC9 — no test weakened; every fix follows a test that failed for the right reason first

**Verdict: MET.** This is the criterion most thoroughly checked, and the only one all three
independent verifications (T7, T12, T18) confirmed by reproducing history rather than by reading
claims:

- T7: commit ordering (`5835a7a` tests → `b1107d6` one expectation → `bb17f23` source, touching no
  test) confirmed via `git show --stat`.
- T12: reverting only the seven source files of `1b2b2e6` to `1a2c003` reproduced T10's own red
  figure exactly (`28 failed | 28 passed`).
- T18: reverting T17's test-only commit reproduces two independent live regressions
  (`S1_secondChild`, `S2_noStartupChild`), and the commit at which the test first expects the
  behaviour genuinely predates the implementation commit.
- One honest asymmetry recorded rather than hidden: T18 notes T17's test was authored *after* the
  behaviour already existed in the working tree (a reservation-starvation bug it was fixing was
  itself discovered against an already-implemented tree) — the commit ordering is still correct,
  but the authoring order was not blind. T18 records this as disclosed, not as a violation.

### AC10 — a live run against the real relay on the tailnet, with `depr`, both directions

**Verdict: NOT MET — never attempted.** Every independent verification that reached this criterion
(T7, T12, T18) found the same thing: no live-run record exists anywhere in the flow directory, and
a routed search over `apps/cli/test/e2e` returns zero matches for `tui`/`console` (T18 F-007). This
is also the criterion whose absence is why AC1's fake-CLI gap and the store-key-restart question
(above) are still open — AC10's own text is what would force the store-key step to be named as a
miss, and nothing has run to force that naming.

---

## Verdict summary

| AC | Verdict | Basis |
|----|---------|-------|
| AC1 | Partial | T18 (independent) — fake-CLI gap, restart-as-miss unresolved |
| AC2 | Not met | T7/T12/T18 (independent) — optimistic counters unchanged; T23 in flight |
| AC3 | Met (as amended) | T7→T9 fix, T12 + T18 (independent, mutation-tested at the real spawn) |
| AC4 | Not met (not built) | T12/T18 (independent) — no pane exists; design ready (T20) |
| AC5 | Not met | T18 (independent) — one surface total, rest sampled, messages not in words; T23 in flight |
| AC6 | Fix landed, unverified | T18 found not met (independent); T21/T22 fixed it (not yet independently re-checked) |
| AC7 | Met | T12 + T18 (independent, mutation-tested); scope residual on bidi chars (open question) |
| AC8 | Partial | T18 (independent) — modal case fixed and covered; full sweep not re-run |
| AC9 | Met | T7 + T12 + T18 (independent, all reproduced history rather than read claims) |
| AC10 | Not met | T7/T12/T18 (independent) — no record exists anywhere |

---

## Part 2 — What remains, ordered by what it costs someone to hit it

1. **Nobody has ever run the console against the real CLI or the real relay (AC1's fake-CLI gap +
   AC10 in full).** Every driven test — including the ones proving AC1's five-step registration
   flow and AC3's argv cleanliness — substitutes a fake CLI process the test itself writes
   (`FAKE_CLI`, `main.registration.processDriven.test.ts:101-143`). If the real
   `apps/cli/dist/cli.js` does not accept an argv shape the tests assume, or prints trust
   identifiers on stderr in a form `readIdentifiers` does not expect, nobody finds out until an
   operator tries it live. This is the highest-cost gap because it is undiscovered risk sitting
   under every other claim in this report, not a known, bounded defect.

2. **AC2's optimistic counters can tell the operator something happened that the store does not
   confirm, or hide something that did** (`tui-shell.ts:768`, `:756`). This is the literal
   deception AC2 was written to forbid, in the one place a message's fate is reported. T23 is
   dispatched against it but has not landed as of this report.

3. **AC5's exit-class reporting is unproven outside registration, and even there it is not "in
   words."** An operator who hits a failure while sending, polling or importing a contact sees a
   raw code (`RELAY_UNAVAILABLE (exit 4)`) with no totality proof that the console cannot mis-blame
   the command that failed. T23 is also dispatched against this and has not landed.

4. **The address book does not exist yet** (AC4). An operator has no way today to see who is
   pinned, their trust state, or compare the four out-of-band values from inside the console — the
   original request ("write to someone... convenient... address book") is not answerable without
   it. A complete, measured, two-branch design is ready (`t20-address-book-design.md`) and needs
   only the pane-removal decision (below) to start implementation.

5. **The console's header already overflows the minimum supported viewport today, before this
   flow adds anything** (`t20-address-book-design.md` §1.4, measured not asserted: at 72 columns
   with today's five panes and a five-character label, the header is 84 columns wide and `fitLine`
   silently drops pane 5's entire tab). This is a live, present-tense defect independent of the
   address-book decision, and it gets worse under either branch of that decision (§3/§4 of the same
   document measure both). It needs a rank-based header mitigation (mirroring the footer's existing
   `fitFooter`) regardless of which way the pane question is answered.

6. **AC1's step 0 costs every fresh operator a full console restart**, and whether that is a "miss"
   against AC1 or a precondition outside it is unresolved (T18 Q-001). Low cost per occurrence — one
   restart — but it is hit by every registration, every time, and the flow has not classified it.

7. **AC8's full viewport × state cross-product has not been re-run since flow 002/003.** Believed
   intact (the modal case was specifically closed and covered by T14), but "at any viewport, and in
   any state including a command in flight and a modal open" has not been re-measured against the
   compose row and registration checklist this flow added.

8. **Bidi and format-steering characters (U+202E foremost) still reach the compose buffer**
   (T12 F-004/Q2, unresolved, marked as needing a human decision). A peer or the operator's own
   input can make the compose preview render in an order Enter does not send in. Bounded — it never
   reaches an argv or the terminal's control channel, only the compose row's own preview — and left
   open as a scope question, not a defect, by the flow itself.

9. **Lower cost, recorded and effectively closed:** the vacuous escape-assertion in
   `profiles-pane.setup.test.ts:296-319` (T21 F-001, deliberately left in place with a documented
   reason and a pointer to the real test); the startup `doctor`'s outcome cosmetically overwriting
   the registration checklist's step-5 line on a fresh profile (T16 F-003, self-correcting); one
   pre-existing test (`cli.test.ts`'s "keeps doctor/history offline") that still rests on the same
   unsound inference T9 fixed in its sibling file (T9 F-002, not yet renamed).

### Two questions that belong to the operator, not to this report

- **Whether `--text` is retired.** AC3 keeps it deliberately (journal, 2026-09-08T23:16) because
  nine call sites in the operator's own live prototype scripts depend on it. The argv-exposure
  hazard is documented wherever the command is documented. Retirement is recorded as open and
  unresolved by design.
- **Whether the two panes (`health`, `rejections`) are removed** to make room for the address book.
  This changed shape mid-flow: `t20-address-book-design.md` measured that the header *already*
  overflows the 72-column minimum viewport with today's five panes (item 5 above), so the choice is
  no longer "six panes, unchanged, vs. four" — it is "a header that needs fixing either way, made
  worse by 4–9 columns if two panes are dropped (Branch A) or by 19–35 columns if none are (Branch
  B)," with the only mitigation robust to Branch B's overflow costing every inactive pane its name
  in the header. Both branches are fully specified and buildable the moment the operator answers.

---

## Part 3 — What this report found wrong in the flow's own records

Per this week's specific lesson (a report is a claim, not evidence; check it against the tree):

- **T7's own verification finding F-005 was itself wrong**, and T9 (the very next task) caught it:
  F-005 asserted "there is exactly one `--text` invocation in the runbook," reading a `keryx ctx rg`
  summary whose header said 9 matches while displaying 4. There are five invocations, four below the
  note it was criticizing. T9's fix corrected the runbook to enumerate all of them rather than adopt
  F-005's proposed wording, which would have introduced a new false statement. This is the exact
  failure mode this dispatch's own brief warned about (a truncated match list mistaken for a
  complete one) and this report re-checked every count it asserts above against the source files
  and dispatch metrics rather than against a single displayed list.
- **T12 corrected its own subject's self-report**, not the other way around: the T11 implementer
  claimed a mutation turned 5 cases red in `tui-shell.input.test.ts`; T12 re-ran it and measured 4.
  The direction of the claim (the property is real and load-bearing) was unaffected, but the number
  was wrong and is recorded as such in T12 F-006 — an instance of exactly the "one verification
  credited a mutation with a kill it did not produce" pattern named in this report's brief, except
  here it was the *implementer's* self-mutation count that was off, not a verifier's, and the
  independent verifier is who caught it.
- **T16's implementer surfaced, rather than hid, a contradiction between two committed test files**
  (`main.processDriven.test.ts` vs. the new `main.registration.processDriven.test.ts` over whether
  the console may run a command the operator did not press) and left the package red (453/455)
  rather than editing either test to make it pass — T17 then fixed the older test's assertions
  under the owner's answer, changing exactly three lines and reproducing the original failure mode
  from the opposite direction to prove the correction was not a relaxation.
- **No inventory or count in the six independent-verification JSONs was found to contradict the
  tree** when checked against the files and commits they cite (T7's F-001–F-008, T12's F-001–F-007,
  T18's F-001–F-007 line numbers and `git diff`/mutation evidence were spot-checked against the
  commit log above and are consistent with it). The wave's self-correction record — three separate
  tasks (T9, T12, T17) each catching a specific, named error in the task immediately before it — is
  itself evidence the independent-verification discipline this flow adopted was doing real work, not
  performing it.

---

## Routing audit

- `graph_used`: no — not-relevant. Every file and commit needed was named by the flow's own
  dispatch results and the frozen acceptance criteria; the graph predates this session's commits.
- `wiki_used`: no — not-relevant. The questions were "does this dispatch's claim match the tree,"
  settled by reading dispatch JSONs and citing file:line evidence already gathered by prior tasks.
- `ctx_used`: yes — `keryx ctx run` for `git log`/`git status`; `keryx ctx run -- find` for the
  schema lookup. All counts above are quoted from the dispatch JSONs' own `metrics` blocks (which
  those tasks state were themselves read from raw captured logs, not truncated summaries) rather
  than re-derived from a fresh truncated search.
- `raw_rg_used`: no.
- `testing_context_used`: no — not-relevant; no test was written, changed, or run by this task, per
  the hard constraint that T23 is measuring the suite concurrently.
- `memory_used`: no — not-relevant; the flow's own 24 tasks and dispatch results carried the full
  history this report needed.
