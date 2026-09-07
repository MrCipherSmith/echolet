# T9 — Operator TUI: design note and RED test contract

Flow 002, task T9, attempt 1. Written before any implementation exists. It fixes
the module split, the render contract and the input model that the RED tests in
`apps/cli/src/tui/*.test.ts` pin, so the implementer has one contract to satisfy
rather than a description to interpret.

Scope of this note: design + RED tests only. No behaviour is implemented here.

---

## 1. Why a TUI, and why that is the safer choice

The user chose a terminal UI over the browser console the plan originally
described (plan.md wave 2, item 5). The choice must not be re-litigated by the
implementer, and the reason has to survive into the code, because it is a
security property and not a preference:

> **AC5** — the operator surface "never receives, stores or transmits a store key
> or private key material. This is demonstrated by evidence, not asserted."

A browser console satisfies AC5 only by discipline: it needs an HTTP server on
the operator's machine, that server has an origin, that origin has a port, and
every one of those is a place a store key could reach by accident — a query
string, a log line, a `fetch` body, a page the operator left open. The TUI has
none of them. There is no server, no origin and no port; the process's only
outputs are the terminal it already owns and the argument vectors it hands to
`node dist/cli.js`. AC5 stops being a rule to obey and becomes a shape the
program has, which is why the tests can pin it as an invariant over *every*
rendered frame and *every* argv rather than over a sampled request.

The `description.md` rationale for rejecting a server-side-keys web client
therefore holds a fortiori, and is not weakened by the change of surface.

## 2. What was actually taken from the reference — and one correction

The reference is `/home/altsay/keryx/src/tui` on `geekom`, read over SSH and not
modified. 77 files, 38 colocated `*.test.ts`.

**Correction to the dispatch premise.** The dispatch states the reference has
"no UI dependency whatsoever — only Node builtins". That is not what the source
says. `shell-chrome.ts` carries this in its own header:

> "`@opentui/core` is an OPTIONAL dependency (ADR-0005): it is referenced here
> ONLY structurally, through `typeof import(...)`, and the renderer plus the
> module object arrive as parameters. There is no top-level import of it."

and declares its renderable types as `type OpenTui = typeof import("@opentui/core")`,
`type Renderer = Awaited<ReturnType<OpenTui["createCliRenderer"]>>`. A grep for
external imports returns only `node:` builtins precisely *because* the coupling
is type-only and enforced by a static regex guard — not because the dependency is
absent. `modal-host.test.ts` loads the real package through a `try`/`catch`
`loadOpenTui()` and skips when it is missing.

This matters, because the property that makes the reference testable line by line
is **not** "no dependency". It is **no static coupling to a renderer**: state to
lines is pure, and every terminal effect arrives through an injected parameter.
That is the property worth copying, and it is the one this design copies.

Adopted from the reference, with the file it comes from:

| Taken | From | Why |
|---|---|---|
| snapshot / format / present split — `buildXSnapshot(source)` pure, `formatXText(snapshot)` pure, `presentX(openModal, …)` asserted only as a call shape | `session-info.ts` + `session-info.test.ts` | The two pure halves carry every assertion; the impure half is one injected function, so no test needs a terminal. |
| injected function type instead of an imported module (`export type OpenModalFn = (…) => ModalHandle \| undefined`) | `session-info.ts:84` | Inverts the dependency at a named seam a test can substitute. |
| a single `modal-host` owning every confirmation, with exported *pure geometry* (`resolveModalPanelSize`, `modalBodyRows`, `resolveModalInnerWidth`, `formatModalFooter`) | `modal-host.ts` | Geometry is where a hand-rolled renderer actually breaks; exporting it makes the breakage a unit test instead of a screenshot. |
| module names and roles: `tui-shell` (shell), `shell-chrome` (frames), `modal-host` (confirmations), pluggable inspector panes | reference directory listing | The journal names these; keeping them keeps the two trees comparable. |
| explicit fields over an inheritance hierarchy ("D-A1 — the closure's coupling is data, not behaviour") | `shell-chrome.ts` header | Same reason: data is assertable, an override is not. |

**Diverged from the reference, with reasons:**

1. **No UI package at all, optional or otherwise.** The dispatch forbids one and
   the workspace has no place for it: `apps/cli` bundles through esbuild to a
   single `dist/cli.js` with only `@signalapp/libsignal-client` external. Rendering
   is hand-rolled ANSI on the alternate screen with raw-mode stdin. The
   testability the reference gets from dependency inversion is obtained here from
   the *absence* of the dependency plus the same inversion at the I/O edge.
2. **Plain text in the pure layer; colour applied at the very edge.** The
   reference's pure formatters return text and OpenTUI paints it. With no
   renderer, that separation has to be explicit: `renderFrame()` returns plain
   lines that contain no ESC byte, and a separate `styleFrame(frame, theme)` step
   adds ANSI. Every assertion in this task's tests is on the plain frame, so an
   escape-sequence change can never silently rewrite a security assertion. A test
   pins the no-ESC rule directly.
3. **`bun:test` → `vitest`.** The reference is a Bun project; `apps/cli` runs
   vitest 3.0.8 with colocated `*.test.ts`, which is what these tests use.
4. **No `theme.ts` persistence.** The reference persists a theme id to disk. An
   operator console for an unaudited prototype does not need a preference file,
   and every file the TUI writes is a file a reviewer has to prove holds no key
   material. Nothing is persisted.

## 3. Module split

All under `apps/cli/src/tui/`, colocated tests, matching the app's existing
convention (`src/runtime/*.ts` beside `*.test.ts`).

```
apps/cli/src/tui/
  state.ts            types + createInitialState              PURE
  cli-bridge.ts       CliRequest -> argv, stdout -> outcome    PURE
  shell-chrome.ts     renderFrame(state, viewport) -> Frame    PURE
  modal-host.ts       trust modal build/render/key-intent      PURE
  profiles-pane.ts    profiles, relay URL, contacts, health    PURE
  mailbox-pane.ts     outbox/inbox counts, rejections          PURE
  history-pane.ts     history for the selected contact         PURE
  tui-shell.ts        mapKey + reduce (PURE) · runTuiShell (IMPURE)
```

Exactly one module is impure, and only one function inside it. `runTuiShell` owns
the alternate screen, raw mode, the child process and the clock; it receives all
four as parameters (`TuiIo`) so no test ever needs a TTY. Everything else is a
function from data to data.

`state.ts` is the seam that makes AC5 structural rather than procedural:

```ts
export interface ProfileView {
  readonly label: string;
  readonly profileDir: string;
  readonly relayUrl: string;
  readonly storeKeyEnv: string;   // the VARIABLE NAME. Never the value.
  …
}
```

There is no field anywhere in `OperatorState` that can hold key material. The
store key reaches the child the same way the runbook passes it today — through
the inherited environment, named by `--store-key-env` — so the TUI never reads
it, never renders it and never writes it into an argv.

## 4. Render contract

```ts
export interface Viewport { readonly cols: number; readonly rows: number }
export type Frame = readonly string[];

export function renderFrame(state: OperatorState, viewport: Viewport): Frame;
```

Pinned by `shell-chrome.test.ts`:

- **Total.** Defined for every state and every viewport at or above
  `MIN_VIEWPORT` (60x16); it never throws and never returns a partial frame.
- **Exact shape.** `frame.length === viewport.rows`, and every line's printable
  width is exactly `viewport.cols`. A short line is padded, a long one is
  truncated. This is what a hand-rolled renderer has to get right and what a
  virtual DOM would hide.
- **Deterministic.** Same `(state, viewport)` gives a `toEqual`-identical frame.
  No clock, no randomness, no environment read inside the render path.
- **Plain.** No line contains ``. Colour is `styleFrame`'s job.
- **Notice-bearing.** Every frame, on every pane, with any modal open, contains
  `UNAUDITED_NOTICE` (AC6).
- **Composed, not monolithic.** `renderFrame` lays out the pane lines produced by
  the pane modules; each pane is independently testable as
  `build…Snapshot` + `format…Lines(snapshot, width)`.

Panes are the reference's "pluggable inspector panes":
`profiles | mailbox | history | rejections | health`.

## 5. Input model

```ts
export function mapKey(key: KeyEvent, state: OperatorState): Intent | undefined;
export function reduce(state: OperatorState, intent: Intent): Step;  // { state, effects }
```

Both pure. `Effect` is a *description* (`{ kind: "run-cli", request: CliRequest }`),
never a call. `runTuiShell` is the only thing that executes an effect, and it does
so through injected `TuiIo`. A test drives the whole interaction model —
keystroke to intent to state to effect — with no process and no terminal.

This is where the trust gate lives, and why it is a gate rather than a habit:

> `reduce` returns the state unchanged, and emits no effect, for a
> `trust-confirm` intent unless `state.modal` is a trust modal whose
> `identifiers` carry all four of `identity_id`, `device_id`, `device_pubkey`
> and `signal_identity_key`, **and** whose `renderedAt` is set — i.e. the modal
> has actually been painted.

The specification (§Contact contract) requires `contact import` to show those
exact four identifiers before trust is recorded, and `contact import` is the only
operation that creates Echolet trust — ciphertext arriving later never creates or
replaces it. A TUI that put a "yes" button in front of that would break the
product's security model, so the four identifiers are a precondition encoded in
the reducer and asserted in `modal-host.test.ts` and `tui-shell.test.ts`, not a
layout convention that a later redesign could quietly drop.

Confirmation is also *not* delegated to `--yes`. The TUI drives
`contact import --from <file>` without `--yes` and answers the CLI's own
`Trust these contact identifiers? [y/N]` prompt on the child's stdin only after
the operator confirmed in the modal. Both trust checks then hold, and the CLI's
own guard is never bypassed.

## 6. Driving the CLI

`cli-bridge.ts` builds argv for exactly the eight frozen commands
(specification.md §CLI surface). Pinned by `cli-bridge.test.ts`:

- `buildArgv` accepts only the frozen surface; a ninth command is a type error
  and, at runtime, a refusal. The prototype's frozen-surface decision is a
  documented constraint, not an oversight, and the TUI must not become the place
  a ninth command sneaks in.
- Every request carries `--profile <dir> --json`, so the TUI parses one JSON
  object per invocation, exactly as the runbook does.
- `parseCliOutcome(stdout, exitCode)` maps to the documented exit codes
  (0 ok, 2 input/config, 3 trust/protocol, 4 relay/network, 5 persistence) and
  keeps the relay's own three reported codes (`PREKEY_BUNDLE_UNAVAILABLE`,
  `UNAUTHORIZED_MAILBOX_ACCESS`, `SENDER_QUOTA_EXCEEDED`) distinguishable rather
  than flattening them — the CLI went to some trouble to keep them apart.

### The contact-roster problem, stated rather than papered over

AC5 requires the surface to show "pinned contacts". **The frozen CLI surface has
no command that lists them.** `doctor` returns `contact_count` and nothing else;
`Profile.listContacts()` exists in the runtime but has no entry point, exactly
like `rotateBundle()` and `retryPending()`.

Three options and the choice:

1. Add `contact list`. Rejected: it is the ninth command the specification
   explicitly froze the surface against, and this task is not the place to
   reopen that decision.
2. Read the encrypted store directly from the TUI. Rejected outright: it would
   require the TUI to hold the 32-byte store key, which is the one thing AC5
   forbids. This option is the reason the roster problem is worth writing down —
   the obvious fix is the unsafe one.
3. **Chosen:** the TUI keeps an in-memory roster of the contacts *it observed*
   — every card it exported and every card it imported through the trust modal,
   whose four identifiers it already had to display — and cross-checks the count
   against `doctor`'s `contact_count`. When they disagree the pane says so
   explicitly (`+2 not seen by this session`) rather than showing a plausible
   list that is silently short.

Option 3 is honest about being partial, which a status pane for an unaudited
prototype has to be. `profiles-pane.test.ts` pins the discrepancy line.

### One exposure this design inherits and does not fix

`send` takes its body as `--text <plaintext>`, so the message plaintext appears in the child's
argument vector and is visible in the process table to any local user for the life of that
process. That is the existing CLI contract — the runbook drives it exactly this way — and the TUI
inherits it rather than creating it. It is out of scope for T9, whose security assertions are about
**key material**, and closing it would require a ninth entry point or a change to `send`'s
interface. It is recorded here so that the AC5 evidence is not read as saying more than it proves:
no store key or private key reaches an argv; message plaintext does, exactly as before.

## 7. What the RED tests pin

| Test file | Pins | Criterion |
|---|---|---|
| `shell-chrome.test.ts` | frame shape, purity, no ESC, notice on every pane and modal | AC6 |
| `tui.keyMaterial.test.ts` | no store key or private key in any frame **or** any argv | AC5 |
| `modal-host.test.ts` | all four identifiers rendered before any confirm is possible | spec §Contact contract |
| `tui-shell.test.ts` | key→intent→state→effect; the trust gate in the reducer | spec §Contact contract |
| `history-pane.test.ts` | plaintext only for the explicitly selected contact | runbook §9 |
| `mailbox-pane.test.ts` | rejections render only `{envelopeId, code}` | spec §`poll` result |
| `profiles-pane.test.ts` | profiles, relay URL, contacts, health, roster discrepancy | AC5 |
| `cli-bridge.test.ts` | the eight frozen commands and nothing else | spec §CLI surface |

## 8. Note on the forward-declared modules

The eight `src/tui/*.ts` files are committed alongside the tests as **declaration
stubs**: exported types, exported contract constants, and function bodies that
`throw new Error("NOT_IMPLEMENTED: …")`. No behaviour.

They exist for one reason: `apps/cli/tsconfig.json` includes `src/**/*`, so a
test importing a module that does not exist turns `pnpm typecheck` red across the
project and reports it as a compile error rather than as a failing expectation.
With the stubs, every test fails on the thrown `NOT_IMPLEMENTED` — a real RED
that names the missing function — while typecheck stays green, and the
implementer receives the contract as signatures rather than as prose.

## 9. What this design does not do

- It does not close AC5 by itself. AC5 requires evidence; these tests are the
  evidence for the rendering and argv halves. The remaining half — that the
  running process holds no key material — belongs to T10's verification on a real
  relay.
- It does not make the prototype audited, or safe for sensitive communication.
  `UNAUDITED_NOTICE` says so on the surface, which is the whole of AC6 and none
  of AC8.
- It does not add a ninth CLI command, and it is not permitted to become the
  reason one is added.
