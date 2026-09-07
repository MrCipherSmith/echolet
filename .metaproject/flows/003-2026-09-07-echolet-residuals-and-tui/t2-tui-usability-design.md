# T2 — Operator TUI: usability assessment and design

Flow 003, task T2. Assessment and design only. **No source file and no test file was
changed.** Everything below is either MEASURED — by building the console and driving it
against a relay I started myself on `127.0.0.1:18317` — or INFERRED from reading the
source, and each claim says which.

Tree: HEAD `4346e2b`, working tree clean apart from this flow directory. Node v26.5.0.
The relay was built from `apps/relay` into my scratchpad and stopped at the end of the
session; the relays on `geekom` and `depr` were not contacted. Two demo store keys were
generated straight into the environment and never printed; no key, plaintext body,
private key or HTTP request body appears in this document or in any recorded artefact —
every base64url run longer than 40 characters was redacted before it reached my screen.

---

## 0. The one-sentence verdict

The console is a **launcher for five of the eight CLI commands with a very good trust
modal attached**. It is not yet an operator console, because it does not tell the
operator what happened, it hides what it fetched, it cannot be learned from its own
surface, and — the only outright defect — it manufactures spurious `exit 5`
(*local persistence failed, stop and investigate*) out of ordinary key-mashing, and then
hides those failures behind the next success.

---

## 1. What an operator can actually do today, end to end

### 1.1 Measured: the full happy path does work

Run A (27 frames, exit 0), one profile, real relay, real `dist/cli.js` children:

```
d → doctor → ok (exit 0)
p → poll   → CONTACT_NOT_TRUSTED (exit 3)      # Bob's envelope, Alice has not imported him
i → trust modal, four identifiers in full
y → contact import → confirmed by operator → ok (exit 0)
p → poll   → ok (exit 0)                        # the message arrives
c → select the contact the session just imported
h → history → ok (exit 0)                       # plaintext, for that contact only
1..5 → all five panes render live data
q → exits, alternate screen restored
```

That is a real, working end-to-end operator session with no shell drop, and the trust
modal is genuinely good: all four identifiers, in full, with their field names, the
notice on the same frame, and the reducer's three refusals behind it. Nothing in this
document asks for that to be weakened.

### 1.2 Measured: which of the eight commands are reachable

`cli-bridge.ts` can build argv for all eight. `mapKey` binds five.

| Command | Key | Reachable | Gate |
|---|---|---|---|
| `poll` | `p` | yes | — |
| `doctor` | `d` | yes | — |
| `relay publish` | `r` | yes | — |
| `contact import` | `i` | yes | only if `--card` was named at startup |
| `history` | `h` | yes | only if a contact is selected, and see §1.3 |
| `init` | — | **no** | no binding exists |
| `contact export` | — | **no** | no binding exists |
| `send` | — | **no** | deliberately omitted (T9 report §4) |

Consequences, measured:

- **A new operator cannot start.** Run H: pointed at a directory that had never been
  `init`-ed, every command answers `INVALID_CONFIGURATION (exit 2)` and there is no key
  that would fix it. The console can only be used on a profile the shell already created.
- **The console cannot produce a contact card**, so half of the runbook's §4 (both sides
  export, both sides import) can only ever be done in the shell. `contact export` costs
  one key and one line; its absence is an oversight rather than a decision — the
  `profiles-pane.ts` header even claims the roster lists "the contacts it observed being
  **exported** or imported", and no code path adds an exported card to the roster.
- **The console cannot send.** That one *is* a decision, and I agree with it: see §7.1.

### 1.3 Measured: the history pane is unreachable in a fresh session

This is the largest functional gap and it is invisible from the code.

`selectedContactId` can only be set by `c`, which cycles `state.contacts`. `state.contacts`
is populated in exactly one place — `observeContact`, after a **successful `contact
import` confirmed through the modal in this session**. So on a profile that already
trusts everyone it needs to:

> Run E — 15 messages waiting, `p` polls them all (`inbox 15 received`), then `c` does
> nothing and `h` does nothing. The history pane says *"no contact selected — history is
> shown only on an explicit request"* and there is **no key sequence that can select a
> contact**. The operator has 15 decrypted messages in their store and no way to read one.

The only workaround, measured in Run F, is to press `i` and **re-import the contact card
you already trust**, walking through the trust modal again, purely to get the identity id
into the session roster. That is worse than a missing feature: it trains the operator to
click through the one irreversible security decision on the surface as a navigation step.

Also measured: on a fresh session the profiles pane says `contacts 0 observed this
session` with **no discrepancy line at all**, because `contactCount` is 0 until `doctor`
runs, and nothing runs `doctor` at startup. The console begins by knowing nothing about
its own profile — including its own identity and device id, which read `(run doctor)` —
and does not go and find out.

---

## 2. Does it refresh?

**No.** Measured: `runTuiShell` subscribes to exactly one event — `stdin` `"data"`
(probe, injected `TuiIo`) — and a search of `apps/cli/src/tui` for
`setInterval|setTimeout|SIGWINCH|SIGINT|SIGTERM|process.on|resize` returns three comment
matches and zero code matches. Every repaint is caused by a keystroke or by a child
process completing.

- Arriving messages are invisible until a human presses `p`. `more: yes — poll again` is
  rendered, correctly, but nobody acts on it.
- Relay health only changes when `poll`, `send` or `relay publish` runs. A relay that
  died two minutes ago still reads `healthy (checked 19:30:38Z)`. The timestamp is the
  only hint, and it is not compared to anything.

**While a child runs**, measured: the frame repaints once, immediately, with the busy
prefix — `running… poll → ok (exit 0)` — showing the *previous* result with a "running…"
in front of it. Then nothing until the child exits. The display is otherwise frozen, and
critically **the keyboard is not**: see §3.1.

---

## 3. How failures are surfaced

The activity line does carry the code and the numeric exit code, e.g.
`poll → RELAY_UNAVAILABLE (exit 4)`. That is better than I expected and better than a
generic "error". But it is the whole of it, and it has three defects, two of them serious.

### 3.1 MEASURED DEFECT — the console fabricates `exit 5`

`mapKey` never reads `state.busy` (probe: `mapKey` returns a `run` intent for `p` on a
state with `busy: true`). Every keystroke spawns another child immediately, against the
same encrypted SQLite store.

Run C — `p`, `p`, `p`, `d` at 5 ms intervals:

```
doctor → PERSISTENCE_FAILURE (exit 5)
poll   → PERSISTENCE_FAILURE (exit 5)
poll   → ok (exit 0)          ← the only line still on screen when the dust settles
```

Run B — relay stopped, `p` then `r` 2.5 s apart, poll still in flight:

```
relay publish → PERSISTENCE_FAILURE (exit 5)
poll          → RELAY_UNAVAILABLE (exit 4)
```

and the control, measured directly against the same stopped relay with no console
involved:

```
$ node dist/cli.js relay publish --profile ./demo/alice --json
{"ok":false,"error":{"code":"RELAY_UNAVAILABLE"}}   exit=4
```

So the console turned a **retryable exit 4** into a **stop-and-investigate exit 5**. The
typed exit-code contract is the thing this console exists to surface, and the console
corrupts it. `state.busy` already exists; it is used for a text prefix and for nothing else.

### 3.2 MEASURED DEFECT — completed results scroll away with nothing behind them

`note()` keeps the last 64 activity lines in state. `activityLine()` renders
`state.activity.at(-1)`. Sixty-three results are held and never shown. In Run C the two
exit-5 failures were unrecoverable from the screen one second after they happened.

### 3.3 The exit class drives exactly one behaviour

`applyOutcome` uses `outcome.exitCode` in one place: `=== 4` sets relay health to
`unreachable`. Measured working — with the relay down the health pane read
`relay http://127.0.0.1:18317 unreachable (checked …)` and `status unreachable`, and
returned to `healthy` afterwards. That derivation is sound and should be kept.

Everything else is undifferentiated. Exit 2, 3, 4 and 5 render as the same grey text in
the same place. Nothing says which are retryable, which need a human decision, and which
mean *stop*. Three examples the console gets factually right and pragmatically wrong:

- `poll → CONTACT_NOT_TRUSTED (exit 3)` actually means *"a sender you have not imported
  wrote to you; import their card and poll again"*. The console shows a code.
- `doctor → INVALID_CONFIGURATION (exit 2)` on a fresh directory means *"this profile has
  never been initialised, and I cannot initialise it"*.
- `poll → RELAY_UNAVAILABLE (exit 4)` means *"press `p` again in a moment"* and there is
  no retry affordance and no indication that retrying is the right move.

### 3.4 Read from source — the rejections pane is nearly always empty

`apps/cli/src/runtime/inbound.ts:221`: `if (received === 0 && firstRejection) throw
firstRejection;`. A poll that accepted nothing and rejected something **raises** rather
than returning, so `rejected[]` reaches the console only when at least one message was
*also* accepted in the same poll. Measured consistent with that: in Run A the mailbox
held exactly one envelope from an untrusted sender and the console showed
`exit 3` with an empty rejections pane. One of the five panes is, in the common case,
dead — while the pane an operator would actually live in (what happened, and when) does
not exist.

---

## 4. Input handling

| Question | Answer | How established |
|---|---|---|
| What keys work? | `1`–`5` panes, `p d r h i c t q`, Ctrl-C; in a modal `y n esc`. Nothing else. | measured (probe over `mapKey`) |
| Is there help? | **No.** `?` is unbound. `echolet-tui --help` prints `--help needs a value` and exits 2. | measured |
| Is the legend discoverable? | **Not at the supported width.** The footer is 106 columns wide; `MIN_VIEWPORT` is 72. At 72 the operator sees `[1-5] pane [p] poll [d] doctor [r] publish [h] history [i] import` and **cannot see `[c] contact`, `[t] profile` or `[q] quit`.** The pane strip is 83 columns, so `5 health` is invisible below 84. | measured (probe: widths 83 and 106 exactly) |
| Can the operator get out of a modal? | Yes — `n` or `Esc`, and an incomplete modal is still cancellable. Correct. | measured + source |
| Terminal resize | **Not handled at all.** `TuiIo.stdout` has only `write`/`columns`/`rows`; there is no seam a resize could arrive through, and the shell subscribes to no stdout event. The viewport is re-read on each paint, so a resized terminal is only re-laid-out at the *next keystroke*. | measured (probe) |
| Very small terminal | `viewport()` clamps to `MIN_VIEWPORT`, so on a 40×10 terminal the shell writes **16 lines of 72 columns** into a 40-column window. Measured through the real `runTuiShell` with an injected 40×10 stdout. The terminal then wraps each line to two rows (inferred, standard behaviour) — about 32 visual rows in a 10-row window, so the notice on row 0 scrolls out of sight. `shell-chrome.ts:30` documents the opposite behaviour ("the shell shows the notice and a resize hint instead"); that behaviour was never implemented. | measured + inferred |
| `SIGINT` | In a TTY raw mode is on, so Ctrl-C arrives as byte 3 and `decodeKey` maps it to `quit` — clean. But there is **no** `SIGINT`/`SIGTERM`/`SIGHUP`/`uncaughtException` handler anywhere, so any exit that does not pass through `finish()` (a `SIGTERM`, a closed terminal, an unhandled rejection in the effect loop) leaves the terminal in the alternate screen with the cursor hidden and raw mode on. | source; the raw-mode path is inferred (my harness has no TTY) |
| Exit latency | 6–85 ms idle; ~900 ms while a poll is in flight, because the shell waits for the child. Acceptable. One anomalous run refused to exit for >10 s and did not reproduce in four later runs; unexplained, recorded rather than hidden. | measured |

Unbound keys are silently ignored — `c` with an empty roster, `h` with nothing selected,
`t` with one profile all return `undefined` and paint nothing. The gating is *correct*
(better an unbound key than an argv with a missing operand) but it is indistinguishable
from a hung console.

---

## 5. The trust decision

This is the strongest part of the surface, and it is genuinely well built. Measured on a
real card at 72 columns: all four identifiers present, each on its own line, each
**complete** (43, 36, 43 and 44 characters), field names shown, footer shown, the
unaudited notice on the same frame, the panel clamped never to start above row 1. The
reducer's three refusals — a trust modal, all four identifiers non-empty, and
`renderedAt` set only after the frame was written — are the right design and are pinned
by tests I would not touch. A malformed card opens no modal at all and reports
`INVALID_CONTACT_CARD (exit 2)`; a stray `y` afterwards does nothing (measured, Run I).

What is missing for a person actually comparing against another channel:

1. **Which card is this?** Measured: the `card:` line is clipped at 58 characters at 72
   columns and at **70 characters even at 120 columns and above**, because
   `MODAL_PANEL_MAX_WIDTH` is 80. My demo path was 74 characters and the filename —
   the only part that identifies the counterparty — was the part cut off. An operator
   running two imports back to back cannot tell from the modal which one they are
   confirming.
2. **Is this new, or a change?** The modal says nothing about whether this identity is
   already pinned. `contact import` fails closed on a changed device or Signal key, but
   the operator meets that as an exit code afterwards rather than as context beforehand.
   Even the session's own knowledge — "you imported this identity 40 seconds ago" — is
   available in `state.contacts` and unused.
3. **It is not readable aloud.** Forty-three unbroken base64url characters is the format
   that is hardest to compare over a phone call, which is the channel the specification
   has in mind. Grouping into blocks of four or five, *in addition to* the verbatim line,
   costs nothing and roughly halves the error rate of a human comparison.

The last point carries a hard constraint for whoever implements it, stated here so it is
not discovered by a red test: `modal-host.test.ts` asserts
`painted.includes(COMPLETE[field])` — the **verbatim** value must remain on the frame. A
grouped rendering must be an *additional* line, explicitly labelled as a reading aid, and
must never replace the verbatim one.

---

## 6. What in the architecture makes each gap easy or hard

The load-bearing property is real and it is the reason this assessment could be done at
all: `renderFrame(state, viewport) -> Frame` is pure, total and deterministic, and
`mapKey`/`reduce` are pure with `Effect` as a description rather than a call. I drove the
real `runTuiShell` at an arbitrary viewport with an injected `TuiIo` and measured exact
frames without a TTY, a process or a relay. **Every proposal below preserves that, and
each says how it stays testable.**

The architecture makes things easy or hard along one axis: *is the missing information
already in the state, or does it need a new seam?*

| Gap | Cost | Why |
|---|---|---|
| Serialising commands (§3.1) | trivial | `state.busy` already exists and is already correct; only `mapKey`/`reduce` need to read it. Pure. |
| Showing more than one result (§3.2) | trivial | `state.activity` already holds 64 entries. A new pure pane renders them. |
| Explaining an exit code (§3.3) | small | A pure function of `(request, outcome)`. No new state, no seam. |
| Help overlay, footer honesty (§4) | small | Pure. The best test is a *relation*: every key the help names maps to an intent, and every key `mapKey` binds appears in the help. |
| Overflow markers and paging (§7.4) | small | An offset field in state; `renderFrame` stays a pure function of it. |
| Small-terminal correctness (§4) | small | `renderFrame` already honours **any** viewport — I rendered 40×10 correctly. The bug is the clamp in `runTuiShell.viewport()`, one line, plus a too-small frame in `shell-chrome`. |
| Contact selection (§1.3) | medium | Needs data the console does not have. See §7.6 — a contact card is public, so cards named at startup can be parsed in `main.ts` (the composition root) and land in state as data. No key material, no new CLI command. |
| Live refresh (§2) | medium | Needs a new `TuiIo` seam for a timer. The clock stays outside the pure layer, exactly as `now` already does. |
| Resize (§4) | medium | Needs a new optional `TuiIo` seam (`onResize`). `TuiIo.stdout` is deliberately a narrow shape; widening it is the honest change. |
| Sending a message | **blocked on the CLI** | `send` takes its body as `--text <plaintext>`, so the body enters the process table. See §7.1. |
| Listing pinned contacts | **blocked on the CLI** | No command enumerates them, and reading the store would need the 32-byte key the console must never hold. |

---

## 7. The plan, ranked by what an operator feels first

Every item names: the property it adds, how it is tested, blast radius, and what it must
not break. This project is test-first: each lands as RED tests written by one agent and
implementation by another.

### Global invariants — no item may break any of these

1. No field in `OperatorState` can hold key material; `ProfileView.storeKeyEnv` stays the
   variable **name**. (`tui.keyMaterial.test.ts`)
2. `buildArgv` stays confined to the eight frozen commands and can never carry a key
   value. No ninth CLI command, and the console never becomes the reason one is added.
3. `UNAUDITED_NOTICE` is on **every** frame — every pane, the trust modal, and every new
   overlay or degraded frame this plan introduces.
4. `renderFrame` stays pure, total, deterministic, exactly `rows × cols` in code points,
   and contains no ESC byte. Colour stays in `styleFrame`.
5. `reduce` refuses `trust-confirm` unless the modal is a trust modal, all four
   identifiers are present and non-empty, and `renderedAt` is set.
6. The trust modal renders the four identifiers **verbatim and in full**.
7. `contact import` is driven **without `--yes`**; the child's own `[y/N]` prompt is
   answered only after the modal was confirmed.
8. `history` renders plaintext only for the explicitly selected contact; rejections render
   exactly `{envelopeId, code}`; `PRIVATE_KEY_MARKERS` (including the literal word
   `ciphertext`) never appears on a frame.
9. The console writes no file.

---

### U1 — One command at a time  · *blocker*

**Property.** At most one child process is in flight. A command key pressed while one is
running is refused, visibly, and no second child is spawned.

**Why first.** It is the only thing measured to be *wrong* rather than missing (§3.1). It
fabricates `exit 5` from ordinary key-mashing and, worse, corrupts a `RELAY_UNAVAILABLE`
into a `PERSISTENCE_FAILURE` — the console lies about the one contract it exists to
surface.

**Tests (RED first).**
- `mapKey` returns `undefined` for every command key (`p d r h i` and `e`, once bound) on
  a state with `busy: true`, and still returns pane/quit/modal intents.
- `reduce` emits no `run-cli` effect for a `run` intent while `busy` is true, and returns
  the state with a refusal note appended to `activity` (pure — no clock: the note's `at`
  comes from the existing state, or the note is rendered without a timestamp).
- `runTuiShell` with a `runCli` that never settles, driven with five `p` keystrokes,
  calls `runCli` exactly once.
- A frame in the busy state contains the refusal, so the operator is told rather than
  ignored.

**Blast radius.** `mapKey`, `reduce`, one line in `shell-chrome.activityLine`. No new
module, no new seam.

**Must not break.** The existing `tui-shell.test.ts` cases construct `busy: false` states
and stay green. Quit and modal keys must remain live while busy — an operator must always
be able to leave.

---

### U2 — Say what happened, in the right class, and keep it  · *blocker*

**Property.** (a) Every completed command is visible in a pane that keeps at least the
last 32 results, with its code, exit code and class. (b) Each failure is rendered with
its **class** and the **next action**, derived from the documented contract:
2 = configuration, the console cannot fix it; 3 = trust/protocol, a human decision;
4 = temporary relay/network, retry; 5 = local persistence, stop and investigate.

**Why second.** §3.2 and §3.3. A console whose errors all look the same is worse than the
shell, because the shell at least shows the code — and here two `exit 5`s vanished behind
one `ok` inside a second.

**Design.** A new pure module `outcome-explainer.ts`:
`explainOutcome(request, outcome) -> { class: "ok"|"input"|"trust"|"relay"|"persistence",
line: string, remedy: string | null }`, a total function with a default arm, so an
unrecognised code still gets its exit class. Special-case the three the CLI went to
trouble to keep distinct (`PREKEY_BUNDLE_UNAVAILABLE`, `UNAUTHORIZED_MAILBOX_ACCESS`,
`SENDER_QUOTA_EXCEEDED`) and the one measured most often in practice: `poll` +
`CONTACT_NOT_TRUSTED` → *"an unimported sender wrote to you — import their card, then
poll again"*. Then a sixth pane, `activity`, rendering `state.activity` newest-first.

**Tests.** A table test over every `(command, code, exitCode)` triple the CLI can emit —
enumerated from `apps/cli/src/commands/cli.ts` `classify()` and the failure constructors —
asserting the class matches the documented exit code for all of them and that no arm
returns an empty line. Pane tests are value comparisons over `state.activity`. A frame
test asserts a `PERSISTENCE_FAILURE` and a `RELAY_UNAVAILABLE` render distinguishably.

**Blast radius.** One new pure module + one new pane + `PANE_IDS` grows to six.

**Must not break.** Invariant 3 and 4. The remedy strings must never contain a code the
console cannot act on, and must never contain the word `ciphertext` (invariant 8). See
§7.10 for my opinion that `rejections` and `health` should give up their ordinals to make
room rather than the strip growing wider.

---

### U3 — The console finds out about itself  · *high*

**Property.** On startup, and on every profile switch, the console runs `doctor` for the
active profile without being asked. Identity, device and `contact_count` are populated
before the first keystroke; the roster-discrepancy line is therefore truthful from frame
one instead of after a keystroke nobody knows to press.

**Why.** Measured §1.3: the console starts by rendering `(run doctor)` for its own
identity and `contacts 0 observed this session` with no discrepancy line, on a profile
that trusts someone. A console that starts by knowing nothing about its own profile
starts wrong.

**Tests.** `runTuiShell` with a fake `runCli` issues exactly one `doctor` for the active
profile before any keystroke, and exactly one more on `select-profile`. No `doctor` is
issued while a modal is open, and the startup `doctor` respects U1's single-flight rule.

**Blast radius.** `runTuiShell` startup path, and a `reduce`-visible startup intent so the
decision stays in the pure layer.

**Must not break.** The first painted frame must still carry the notice (it will — the
paint happens before the effect). The startup `doctor` must not race the `--card` modal.

---

### U4 — Make it learnable, and stop lying by truncation  · *high*

**Property.** (a) A `?` key opens a help overlay listing **every** binding, and the
overlay carries the notice. (b) The footer never advertises a key it cannot fit: at any
width it ends with `[?] help`, and what it drops is what is least needed, not the tail.
(c) The console never writes a line wider than the terminal reports: below
`MIN_VIEWPORT` it paints a dedicated too-small frame — at the terminal's *actual* size —
carrying the notice (wrapped across two lines if it must be) and the required dimensions.
(d) `--help` on the binary prints usage and exits 0.

**Why.** Measured §4: at exactly the width the console falls back to, the quit key is
invisible. On a 40-column terminal the layout is destroyed and the notice scrolls away —
and the source already *documents* the behaviour that was never implemented.

**Tests.**
- A **relation** test, which is the valuable one: for every key name in the help overlay,
  `mapKey` returns an intent in some state; and for every key `mapKey` binds, the overlay
  names it. This makes the footer's original promise ("a footer that advertised an unbound
  key would be a lie") machine-checked in both directions.
- `renderFrame` at 40×10 and 20×5 returns exactly `rows × cols`, contains no ESC, and
  contains `UNAUDITED_NOTICE` (concatenated across lines if wrapped).
- `runTuiShell` with an injected 40×10 stdout writes no line wider than 40.
- Help overlay frames satisfy every shape assertion the modal frames already satisfy.

**Blast radius.** `shell-chrome` (footer, too-small frame), `modal-host` or a sibling for
the overlay, one line in `runTuiShell.viewport()`, `main.ts` usage text.

**Must not break.** Invariant 3 — this is the one item that touches the notice's layout,
so its tests must assert the notice at every viewport in the existing matrix *and* at the
new sub-minimum ones. `MIN_VIEWPORT` itself should not move: 72 is derived from the
notice's 62 columns and that reasoning is sound.

---

### U5 — Nothing is hidden without saying so, and everything is reachable  · *high*

**Property.** No pane ever drops a row silently. When rows do not fit, the frame says how
many are hidden, and a paging key reaches them. History and activity are ordered
**newest-first**.

**Why.** Measured §9 of the runs: 30 history entries, 10 rendered, 20 dropped, no marker;
16 entries live, 11 rendered. And it keeps the *oldest* — precisely backwards. The same
silent slice applies to the contact roster and the rejections list. A display that hides
without saying so is a correctness bug, not a comfort feature.

**Tests.** Pure: for `n` entries and `r` body rows, the frame contains a marker naming
`n - r`; with an offset the tail entry is present and the head entry is not; the offset
is clamped so no state produces an empty pane or an out-of-range read; ordering is
asserted explicitly.

**Blast radius.** A `paneOffset` field in state, `renderFrame` layout, the three list
panes, two keys.

**Must not break.** Invariant 4 (the offset is state, so purity is preserved) and the
history pane's rule that no plaintext for an unselected contact is ever built into the
snapshot.

---

### U6 — Reach a contact without re-affirming trust  · *high*

**Property.** The operator can select any contact whose card was named at startup, and
run `history` against it, in a fresh session, without pressing `i`.

**Why.** Measured §1.3, and it is the gap with a security consequence: today's only route
to the history pane is to walk through the trust modal for a contact you already trust.

**Design.** A contact card holds the four **public** identifiers — that is exactly why the
console may read one with no key — so `main.ts`, the composition root, parses every
`--card` at startup into a `knownCards` list carrying `identity_id` and the path, and the
profiles pane lists them, clearly labelled **"cards known to this console — not evidence
of trust"**. Selection cycles the union of observed contacts and known cards. `i` remains
the only path that records trust, and the modal is unchanged.

Also in this item, because it is one line and closes the same hole from the other side:
bind `contact export` (`e`), and fix the `profiles-pane.ts` header, which currently claims
the roster contains exported cards when no code path puts one there.

**Tests.** Pure: `mapKey` `c` cycles observed contacts and known cards; the profiles pane
distinguishes the two categories in its rendered text; selecting a known card sets
`selectedContactId` and emits **no** effect; a card-derived selection never adds an entry
to `state.contacts` (i.e. never claims trust). Card parsing is a pure function of file
text, tested as a value comparison; the read itself lives in `main.ts`.

**Blast radius.** `state.ts` (one new list), `main.ts` (parsing), `profiles-pane`, `mapKey`.

**Must not break.** Invariants 1 and 6. The roster's honesty is the point of
`profiles-pane`: a known card must never be rendered as a pinned contact, and the
`doctor` discrepancy line must keep counting against **observed contacts**, not against
known cards.

---

### U7 — Make it live  · *medium*

**Property.** With auto-poll enabled, arriving messages appear without a keystroke. The
interval and the next poll time are on the surface; a key toggles it; it never fires
while a command is in flight or while a modal is open.

**Why.** §2. This is what separates a console from a command launcher — but it ranks below
everything above it, because an operator who presses `p` does get their mail, whereas an
operator who mashes keys today gets a fabricated `exit 5`.

**Design.** One new optional `TuiIo` seam:
`readonly setTimer?: (ms: number, fire: () => void) => () => void`. The clock stays
outside the pure layer, exactly as `now` already does. The tick becomes an ordinary
intent; `reduce` decides whether it produces a `run-cli` effect.

**Tests.** `reduce` on a `tick` intent emits a `poll` effect when idle, and **no** effect
when `busy` or when `state.modal !== undefined` — that second case is the security-adjacent
one and deserves its own named test: a child spawned while the operator is reading the
trust modal would repaint over the decision they are making. `runTuiShell` with a fake
timer asserts N ticks produce N polls, and that the timer is cancelled on quit.

**Blast radius.** `TuiIo`, `intents`, `reduce`, `main.ts`, footer/help text.

**Must not break.** Invariant 5 in spirit as well as letter: the modal must remain the
exclusive owner of the surface while it is open.

---

### U8 — Make the trust decision comparable  · *medium*

**Property.** The modal shows (a) the card path in full — wrapped across lines rather than
clipped, (b) each identifier verbatim **and** a grouped reading aid beneath it, and (c)
whether this identity is already in the session roster.

**Why.** §5. The identifiers are already right; what is missing is everything that makes a
human comparison actually succeed. Measured: the path is clipped at 70 characters even on
a wide terminal, and the filename is what gets cut.

**Tests.** The verbatim value is still `includes`-present at every viewport (this is the
existing assertion and must stay green — the grouped line is *additional*); the full card
path appears across the panel's lines when wrapped; the "already known to this session"
marker appears only when the identity is in `state.contacts`; every existing panel-geometry
assertion still holds.

**Blast radius.** `modal-host` rendering only. No change to `trustModalIsComplete`, to the
reducer's gate, or to the key contract.

**Must not break.** Invariants 5 and 6, and the panel-geometry tests. This item is
deliberately last among the console-only items **because** the modal is the part that
currently works; a redesign here has the highest cost of being wrong.

---

### U9 — CLI prerequisite: take the message body off argv, then compose  · *decision needed*

The console cannot send, and I would **not** add a send key while `send` takes its body as
`--text <plaintext>`: the body is visible in the local process table for the life of the
child, and a console that invites an operator to type messages all day multiplies an
exposure the runbook incurs once per command. The fix belongs to the CLI — `--text-file`,
or reading the body from stdin when `--text` is absent — and it is a change to a frozen
command's interface, not a ninth command. Only after that should the console grow a
compose modal.

Until then the console should **say on its own surface that it does not send**, in the
help overlay, rather than leaving the operator hunting for a compose key.

### U10 — CLI prerequisite: a way to enumerate pinned contacts  · *decision needed*

The session-scoped roster is a workaround for a CLI-surface gap, and U6 is a better
workaround, not a fix. `Profile.listContacts()` exists with no entry point. The honest
options are a ninth command (`contact list`) or `doctor` returning contact identity ids
alongside `contact_count`; the second reopens no frozen decision and would let the console
list what the profile actually trusts, with no key material and no new surface. I think
that is the right answer, but it changes a documented CLI result shape and belongs to the
flow owner, not to a TUI task.

---

## 8. What I recommend NOT doing

- **Mouse support.** The whole surface is eight keys. Mouse tracking means SGR sequences,
  which puts an escape-sequence *decoder* in the input path of a program whose entire
  security argument rests on the pure layer emitting no escape bytes. It would also break
  terminal text selection — which is exactly how an operator copies a 43-character
  identifier out of the trust modal to compare it. Net negative.
- **Colour themes or any persisted preference.** T9 rejected a theme file and was right:
  every file the console writes is a file a reviewer must prove holds no key material. At
  most, one semantic colour per failure class, applied in `styleFrame` and nowhere else,
  so no security assertion is ever made against a styled frame.
- **A terminal scrollback buffer.** The console owns the alternate screen, so scrollback
  is not available anyway. What is needed is bounded, in-state paging of panes (U5), which
  is testable as a pure function; a scrollback is neither.
- **Grapheme-cluster / East Asian display-width handling.** Code points are honest for the
  Cyrillic the project's own evidence sends. Buying a `wcwidth` table adds a dependency and
  a whole class of width bugs to a surface whose exact-width property is load-bearing.
- **Widening `MIN_VIEWPORT` or shortening the notice to make the footer fit.** The notice's
  62 columns is the constraint that set 72; changing it to win layout space would trade an
  acceptance criterion for chrome.
- **Adding a ninth CLI command from inside the console**, for any reason, including U10.
  If the surface is to change, it changes in the CLI with its own decision.
- **A general "run any command" prompt.** It would be the shell with extra steps, and it
  would put arbitrary operator text into an argv.

## 9. Two opinions about the current design

1. **The pane set is wrong.** `rejections` is empty in the common case by construction
   (§3.4) and `health` is two lines that belong on the profiles pane. Meanwhile the pane an
   operator would live in — what has happened, in order, with exit classes — does not
   exist. I would fold `health` into `profiles`, fold `rejections` into `mailbox` (where its
   counts already live), and spend the freed ordinals on `activity`. This keeps the strip
   at five and avoids growing the header past the width where it already truncates.
2. **`state.busy` is a display flag where it should be a gate.** The state model got this
   right and the input model ignored it. That single omission produced the only measured
   defect in this assessment.

## 10. Routing audit

- `graph_used`: **no** — *not-relevant*. The subject is 19 files in one named directory,
  enumerated by the dispatch; a dependency graph adds nothing over reading them, and the
  graph predates this session's untracked flow directory in any case.
- `wiki_used`: **yes** — `wiki/index.md` consulted; it holds 16 generated draft pages and
  **no** page covering the CLI, the TUI or the operator workflow, so the design and
  implementation notes in `flows/002-.../` were the authority instead.
- `ctx_used`: **yes** — every command and file read routed through `keryx ctx run` /
  `keryx ctx read`.
- `raw_rg_used`: **no** — all searches through `keryx ctx rg`.
