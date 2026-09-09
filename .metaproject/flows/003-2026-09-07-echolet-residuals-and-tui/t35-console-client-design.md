# T35 — The console as a client: registration, conversations, address book

Date: 2026-09-09. Flow 003. Design only; no source file was changed, no suite and no build was run.

Scope: `apps/cli/src/tui` and the CLI commands it drives. No relay change, no wire change, no
protocol schema change. The prototype stays a computer CLI prototype.

---

## 0. The verdict, in one paragraph

The console is an *inspector* that was built to watch a profile somebody else created. Three walls
stand between it and being a client, and only one of them is in the TUI. The TUI wall is that the
surface has **no text input at all** — `decodeKey` reduces every chunk to one lower-cased character
(`tui-shell.ts:200-212`), so no operand can be typed, which is why `init`, `contact export` and
`send` have no keys. The second wall is `send --text <plaintext>`: the body would enter the local
process table for the life of the child, which is why T2 §7.1 refused a send key and why I refuse
one too — until the body moves to the child's stdin. The third wall is that **nothing enumerates
pinned contacts**: `Profile.listContacts()` exists at `profile.ts:448` and has no entry point, so an
address book built today can name only the contacts imported *in the current session*, which is the
measured Run E defect (T2 §1.3) wearing a new pane. This design takes down all three: an input mode
that is deliberately **not** a modal, one changed input path on `send`, one added field on `doctor`.
No ninth command. The cost is stated in §5 and it is real.

---

## 1. What the tree actually does today

Everything in this section was read at HEAD `c5fde09` plus the working tree. Where a document in
this repository disagrees, the tree is what I believe, and §1.3 lists the disagreements.

> Note on the tree while I worked: at 22:12 UTC `git status` reported `apps/cli/src/tui/cli-bridge.ts`
> modified; forty seconds later the same file was clean again. Another agent is exercising this
> package right now (mutation runs restore what they perturb). Nothing in this design rests on a
> transient working-tree state; every citation below is to committed content.

### 1.1 The eight commands, and which the console can reach

`CLI_COMMANDS` (`cli-bridge.ts:14-23`) is the whole surface and `buildArgv` refuses anything else.
Reachability today, from `paneKeyIntent` (`tui-shell.ts:110-138`):

| Command | Key | Reachable | Why not |
|---|---|---|---|
| `poll` | `p` | yes | |
| `doctor` | `d` | yes | |
| `relay publish` | `r` | yes | |
| `history` | `h` | only with a contact selected | and a contact can only be selected by re-importing a card |
| `contact import` | `i` | only if `--card` was named at startup | one card per profile, fixed at launch |
| `init` | — | **no** | needs three typed operands |
| `contact export` | — | **no** | needs a typed path |
| `send` | — | **no** | needs a typed body, and the body would go on argv |

`CliRequest` already carries the `send` and `init` shapes (`cli-bridge.ts:27-35`) and `buildArgv`
already builds them; `applyOutcome` already has a `send` case (`tui-shell.ts:298-299`) and counts
`send` as relay-touching (`:264`). The plumbing was left in place for exactly this task. What is
missing is the input model, not the bridge.

### 1.2 The three walls, exactly

**Wall 1 — no text.** `decodeKey` returns `{name, ctrl, sequence}` where `name` is
`first.toLowerCase()`. Capitals are destroyed, `0x7f` (backspace) decodes to a `name` nothing binds,
and a multi-byte chunk (a paste, an arrow key's `ESC [ A`) keeps only its first code point. The full
chunk survives on `sequence`, which is the seam an input mode uses.

**Wall 2 — the body on argv.** `buildArgv` emits `["send", "--to", …, "--text", request.text, …]`
(`cli-bridge.ts:88-93`), and `cli.ts` requires `--text` (`rejectUnexpectedMissing`, `:175-187`) and
demands a non-empty value (`required`, `:169-173`). On this platform another process owned by the
same user can read that argv for the life of the child. The runbook incurs that once per typed
command; a console invites it once per message.

**Wall 3 — no enumeration.** `doctor` returns `diagnostics()` → `summary()` +
`{storage, runtime}` (`profile.ts:452-461`), i.e. `profile_id`, `identity_id`, `device_id`,
`contact_count`. The identities behind that count are in the store under `cli:contact:<identity_id>`
and `listContacts()` reads them (`profile.ts:448-450`) — for the outbound send path only
(`outbound.ts:126`). Nothing prints them. The console's roster is therefore populated in exactly one
place: `observeContact`, after an import confirmed through the modal *in this session*
(`tui-shell.ts:361-367`).

### 1.3 Where a document and the tree disagree — believe the tree

1. **`PAUSED.md` and `t25-verification-report.md` say the trust-modal viewport guard is pinned by
   nothing and that `onTrustIdentifiers` "appears in no test".** That is now false.
   `apps/cli/src/tui/tui-shell.trustViewport.test.ts` is committed and drives the real
   `runTuiShell` through `onTrustIdentifiers` at 40×10, 71×16, 72×15 and 72×16, asserting both
   directions of the guard. The property is enforced. Anything in this wave that plans to "add the
   missing trust-viewport test" should read that file first.
2. **specification.md §Contact contract says a contact card contains "an optional local display
   name".** `Profile.exportContact()` builds `{type, version, signal_bundle}` and nothing else
   (`profile.ts:302-304`). The schema accepts `display_name` (`:76`) and `importContact` reads only
   the four identifiers (`:428-431`), so a `display_name` that arrived would be discarded. **No card
   this tree can produce carries a name, and no name this tree imports is stored.** Every naming
   decision in §2.3 follows from that.
3. **`profiles-pane.ts:13-19` says `doctor` "reports `contact_count` and nothing else"** — true, and
   it is the reason it gives for the partial roster. §6 P-2 removes the reason rather than the pane.
4. **The plaintext bound is a second literal.** `outbound.ts:22` bounds `plaintext` at 65536 in the
   zod schema and `:118` re-checks `Buffer.byteLength(...) > 65536` — a second literal for one
   quantity, in the same package whose `profile.ts:30-38` argues at length that "a second literal
   for one quantity is how two numbers drift apart". The console must not mint a third. See Q2.
5. **Six configuration failures share one code.** `ConfigurationError` has a fixed
   `code = "INVALID_CONFIGURATION"` (`config.ts:4-6`) and `writeResult` emits only
   `{ok:false, error:{code}}` (`cli.ts:391-393`), discarding the constructor message. A missing
   store key, a malformed store key, a relay URL with a path, a relay URL with credentials, plain
   HTTP to a non-loopback host, and an unparseable `config.json` are one code at exit 2 to any
   caller. This is the single largest constraint on registration UX, and §4.2 says what the console
   does about it without changing the code.
6. **`OutboundError` carries an actionable sentence that never reaches the console.**
   `SENDER_NOT_PUBLISHED`'s message says "run `relay publish` for this profile, then send again"
   (`outbound.ts:152-157`) and `writeResult` drops it. The console needs its own explanation table
   (§4.1); it must not assume the CLI will tell the operator anything but a code.
7. **A contact card expires in seven days.** `exportSignedSignalBundleV2` sets
   `expires = created + 7 days` (`wire.ts:40`) and `importVerifiedSignalBundleV2` refuses
   `now >= expires_at_ms` (`:82`), which `cli.ts:317-320` converts into
   `INVALID_CONTACT_CARD` at **exit 3**. An operator handed a stale card is told their card is
   invalid, not that it is old. Re-export is therefore routine — and `contact export` writes with
   `flag: "wx"` (`cli.ts:302`), so re-exporting over the same path is `PERSISTENCE_FAILURE`
   **exit 5**, which T34 §"Things that failed" recorded from the live system.
8. **Two of the five panes are already duplicates.** `formatProfilesLines` appends `healthLine` in
   its tail (`profiles-pane.ts:116`), so the `health` pane repeats the profiles pane's last line;
   `formatMailboxLines` already renders the rejection list (`mailbox-pane.ts:56-61`), so the
   `rejections` pane repeats the mailbox pane. Folding them frees two ordinals without losing a
   value, which is how §3.4 pays for two new panes.

---

## 2. The three areas

### 2.1 Registration — a checklist that lives on the profile pane

**What it is.** Not a wizard pane and not an overlay: the profile pane (ordinal 1) renders a
**setup checklist** when the active profile is not yet `ready`, and the existing detail rows when it
is. That costs no ordinal and puts the steps where an operator already looks for "what is this
profile".

**The five steps, and the exact invocation each drives.**

| # | Step | Invocation | Completed when |
|---|---|---|---|
| 0 | store key present | *none — no child is spawned* | `Object.hasOwn(env, profile.storeKeyEnv)` at startup |
| 1 | create the profile | `init --relay-url <url> --store-key-env <VAR> --profile <dir> --json` | exit 0; the result carries `identity_id`, `device_id`, `profile_id` |
| 2 | publish to the relay | `relay publish --profile <dir> --json` | exit 0 |
| 3 | export your card | `contact export --out <path> --profile <dir> --json` | exit 0 |
| 4 | import their card | `contact import --from <path> --profile <dir> --json` | exit 0, through the trust modal |
| 5 | confirm | `doctor --profile <dir> --json` | exit 0 with a non-zero `contact_count` |

Order matters and the checklist enforces it by keying, not by disabling: step 2 before step 4 is
fine, but **step 2 must precede any send** (`send` presupposes publication —
specification.md §CLI surface; `outbound.ts:152` refuses locally before spending a peer's prekey),
and step 3's card is only useful for seven days (§1.3 item 7).

**Step 0 is the hard boundary and the design does not blur it.** The 32-byte store key must exist in
this console's environment before step 1, and the console may neither generate it, read it, nor
write it anywhere. `main.ts`'s standing claim — "There is no code path from a variable name to its
value" — is preserved literally: presence is tested with `Object.hasOwn(process.env, name)`, which
cannot produce the value, **never** `process.env[name] !== undefined`, which reads it into a
comparison. When step 0 is unmet the pane prints the shell command the operator must run themselves,
which contains no key:

```
step 0  store key      ECHOLET_KEY is not set in this console's environment
                       run this in your shell, then restart the console:
                         export ECHOLET_KEY="$(head -c 32 /dev/urandom | base64 | tr '+/' '-_' | tr -d '=')"
```

Rejected: having the console generate the key and hand it to `init`. It would put 32 secret bytes in
this process's memory, in a frame or in an argv — all three forbidden by AC5 and by the dispatch.
Rejected: having the console write a key file. T2 invariant 9 ("the console writes no file") exists
so that no reviewer has to prove a console-written file holds no key material.

**State.** Three new fields, all derived from observed outcomes and nothing else:

```ts
type ProfileState = "unknown" | "absent" | "ready";
interface ProfileView {                    // added to the existing shape
  readonly state: ProfileState;            // "unknown" until something is observed
  readonly storeKeyPresent: boolean;       // Object.hasOwn at startup; never the value
  readonly setup: readonly StepOutcome[];  // per step: "pending" | "ok" | { failed: code, exitCode }
}
```

`state` becomes `"absent"` when any command for this profile returns exit 2 `INVALID_CONFIGURATION`,
and `"ready"` when `init` or `doctor` returns an `identity_id`. `applyOutcome`'s `doctor` case
already folds `identity_id`/`device_id`/`contact_count` (`tui-shell.ts:272-280`); `init` returns the
identical `summary()` shape, so the same case serves both — one line, no new parser.

**A startup `doctor`.** The console runs exactly one command it was not asked for: a `doctor` for the
active profile at startup. Without it the console begins knowing neither its own identity nor
whether the profile exists (`"(run doctor)"` in `main.ts:118-119`), which is T2 §1.3's measured
complaint. It is read-only, touches no relay, creates no trust, and is subject to the same
single-flight rule as everything else. Cost and rejected alternative are in §5, item 6.

**Advancing is manual.** The checklist highlights the next incomplete step; `Enter` on the profile
pane starts it. Nothing auto-runs after a success. Rejected: chaining steps 1→2→3 automatically.
Two of the three need an operand the operator has to supply anyway (relay URL, export path), and a
console that silently ran three commands from one keystroke makes "which of the three failed" a
question the operator has to reconstruct from the activity log rather than see on the checklist.

**Operands come from the input row (§3.1), pre-filled with an honest default:**

- relay URL — no default; validated before it becomes argv (§6 P-3);
- profile dir — defaults to the `--profile` given at launch, which is where it must be;
- store-key variable name — defaults to the launch `--store-key-env`;
- export path — defaults to `<profileDir>/card-<UTC instant>.json`, the instant from `io.now`, so a
  second export never meets `wx`. Rejected: adding `contact export --force`. A fresh filename costs
  nothing and never destroys a card a peer may still be importing.

### 2.2 Conversations — the chat pane, and the send path

**What it is.** Ordinal 3, replacing `history`. It renders the durable history for the one selected
contact and nothing else — the existing guarantee, unchanged: `buildHistorySnapshot` drops the
plaintext of every entry belonging to another contact and reports how many it withheld
(`history-pane.ts:25-43`), and with nothing selected it holds no plaintext at all. Only the line
format changes, from the debugging shape to the correspondence shape the operator's own wrapper
already prints (T34):

```
chat with  Nadia  (mL_Hg-NSPVUAvL8FnbFgw84kzb6KPNPQ-jYXJWU6XBI)
  you  →  2026-09-08 19:38:25Z  round trip at 19:38:25
  them ←  2026-09-08 19:38:37Z  answering the 19:38:25 round trip
  … 12 more not shown
3 entries withheld (other contacts)
```

`messageId` moves off the line and onto a per-entry detail toggle: it is what an operator compares
across two machines (runbook §9) but it is 36 columns of a 72-column frame and it is not what they
read a conversation for. `sequence` stays, because the two sides' sequences are the other half of
that comparison. The list keeps its **tail** (`keep: "tail"`, unchanged) — an operator opens a
conversation to see what just arrived.

**Send, end to end.**

1. `w` on the chat pane, with a contact selected and `state.busy` false, opens the input row bound to
   the `message` field. If no contact is selected, `w` is unbound and the footer does not advertise
   it — the existing "a key that would build an incomplete request returns `undefined`" rule.
2. The operator types. The buffer is bounded by **UTF-8 byte length**, not code points, against the
   same number `outbound.ts` enforces (see Q2); the row shows `1 402 / 65 536 bytes` once past half.
3. `Enter` submits — but only if the input row was actually painted (§3.2). `Esc` cancels and the
   buffer is discarded.
4. `reduce` emits one effect: a **run sequence** of two requests,
   `send --to <identityId> --message-id <uuid> --profile <dir> --json` followed by
   `history --with <identityId> --profile <dir> --json`. The body is **not** in the argv; it rides on
   the send request object and reaches the child on its stdin (§6 P-1).
5. On `send` exit 0 the sequence continues to `history`, whose result replaces `state.history`, so
   the message the operator just sent appears on the pane as the *store* holds it — with the store's
   own sequence and timestamp, not two fields the console invented. `send`'s result is
   `{messageId, envelopeId, status:"delivered"}` (`outbound.ts:35`): it carries neither.
6. On a `send` failure the sequence stops, the `history` child is never spawned, the buffer is
   **restored** with its message id intact, and the failure line names what to do (§4.1).

**The message id is generated once per body and reused across retries.** A retry of the same body
with the same id is the idempotent path the outbox is built for (`sendOwned` returns the stored
receipt, `outbound.ts:124-125`); the same id with a *changed* body is `MESSAGE_ID_CONFLICT` at exit 3
(`:266`). So the console mints a new id the moment the buffer is edited after a failure, and keeps
the old one if the operator retries unchanged. The id comes through a new `TuiIo.newMessageId` seam,
the way `now` already does, so the pure layer stays pure.

**How the in-flight send meets the single-flight rule.** It does not evade it. `state.busy` is set by
`reduce` when the sequence starts and cleared by the shell when the **last** request in the sequence
has settled, so at no instant are two children alive. What changes is the unit: `busy` stops meaning
"one keystroke, one child" and starts meaning "one operator action, one sequence, one child at a
time". Every existing guarantee that rests on `busy` survives verbatim — `mapKey` still refuses a
`run` intent while busy (`tui-shell.ts:105`), `reduce` still refuses one (`:159`), and the activity
line still says so on every frame (`shell-chrome.ts:138-142`). Two rules bound the new unit:

- **A sequence is at most two requests**, and the second never starts a sequence of its own. Stated
  as an invariant and tested, so "chaining" cannot grow into a scheduler.
- **A sequence stops at the first non-zero exit.** The abandoned requests are named in the activity
  line (`history skipped — send failed`), because a step that silently did not run is
  indistinguishable from a step that ran and found nothing.

Exactly two sequences exist:

| Trigger | Sequence | Why the second request |
|---|---|---|
| submit a message | `send` → `history --with <to>` | otherwise the pane shows a conversation missing the message just sent, which reads as a failed send |
| `s` (sync) on the chat pane | `poll` → `history --with <selected>` | this is the operator's own `read` verb (T34): "collect, then show" |

Rejected: an optimistic local echo of the sent message. `send` returns no sequence and no timestamp,
so the console would have to invent both, and a pane that mixes invented rows with store rows is
exactly the "plausible list that is silently wrong" the roster comment refuses.
Rejected: chaining inside the impure shell. It would be invisible to `reduce` and therefore
untestable as a value.

### 2.3 The address book — the contacts pane

**What it is.** Ordinal 2. One list, three provenances, and the distinction between them is the
pane's whole point, because **importing a card is the only thing that creates trust**
(specification.md §Contact contract; `profile.ts:423-446` is the only writer of `cli:contact:`).

```
contacts for alice                            doctor: 2 pinned · this session: 1 imported
  ● Nadia            mL_Hg-NSPVUAvL8FnbFgw84kzb6KPNPQ-jYXJWU6XBI   pinned
  ● (unnamed)        N164884qQpTeQBT3RJMcv5B4BqFlymvO4cOG4l5LW04   pinned
  ○ Bob              t3Ge9wV0kQ2sT…                                not pinned — card, expires 2026-09-14 08:12Z
  ○ (unreadable)     ~/cards/old.json                              not pinned — this file is not a contact card
  ✗ Kim              9pQ2…                                          not pinned — card EXPIRED 2026-09-02 — ask for a fresh one
selected: Nadia — press [enter] to open the chat, [i] to import, [n] to name
```

**Three provenances, merged by `identity_id`:**

1. **Pinned** — from `doctor`'s new `contacts` array (§6 P-2). Authoritative: these are the rows in
   the encrypted store. A `contact_count` that exceeds the array would be a bug in the CLI, not a
   discrepancy the pane papers over; the pane asserts equality and says so if it fails.
2. **Observed this session** — the existing `observeContact` path, kept, because it puts a contact on
   the list the instant an import succeeds, before the next `doctor`. It is merged into, never
   alongside, the pinned rows.
3. **Card candidates** — contact cards named at startup (`--card`, repeatable now, with an optional
   `--name`), parsed in `main.ts`, the composition root. A card is a public artifact: the console
   already reads the *identifiers* a child prints (`readIdentifiers`, `main.ts:134-154`), and a card
   on disk carries the same four plus two public timestamps. **Nothing but those six values enters
   the state** — never the bundle, never the signatures, never the file's text.

**A candidate is never a contact.** It has no trust, it is drawn with `○`, it is sorted below the
pinned rows, and the only action it offers is `i` — which runs `contact import --from <path>`
without `--yes`, exactly as today, so the child prints its own identifiers and the modal opens on
**the child's** values. The address book must never pre-fill that modal from what it parsed: if the
file changed between listing and import, the child's identifiers are the true ones, and a modal
seeded from the console's older parse would show the operator something the CLI is not about to
trust. This is the "the trust modal cannot confirm what was never painted" property extended one
step further back — what is painted must also be what the child is asking about.

**The four comparison values.** `TRUST_IDENTIFIER_FIELDS` (`modal-host.ts:18-23`) are shown in full,
one per line, for the **selected** entry — pinned or candidate — in a detail region below the list,
using the modal's existing rule that an identifier is never elided (`modal-host.ts:115-124`: a modal
that elided the middle of a base64url key "would look correct and verify nothing"). Same rule, same
reason, second surface. This is where an operator compares out of band *before* they decide, and it
is deliberately not a confirmation surface: it has no `y`.

**Expiry, shown before the misleading error.** A candidate carries `created_at_ms`/`expires_at_ms`
from the card. The pane compares them against `state.observedAtMs` — a clock reading folded into
state at startup and after every settled command, never read inside `renderFrame`, so the renderer
stays a deterministic function of its two arguments. An expired candidate is marked `✗ EXPIRED` and
its `i` action is still offered (the operator may have a reason) but the pane says what will happen:
`import will fail with INVALID_CONTACT_CARD (exit 3) — the card is past its seven-day window`.
Without this, the live system's answer to a nine-day-old card is "invalid contact card", which sends
the operator looking for a forgery.

**Names.** No card this tree produces carries a `display_name` and no import stores one (§1.3 item
2), so a name is **local and the pane says so**. Two sources:

- `--name <label>` following a `--card` or a `--contact <identity-id>` at launch. This is where
  durable names belong: the operator already has a launcher script (`~/.echolet/peer`), and a name
  in that script survives restarts without the console writing a file.
- `n` on a selected entry, via the input row. Marked `(this session)` and gone on exit.

Rejected: a names file. T2 invariant 9 again — and a file mapping identities to human names is
precisely the metadata this prototype should not start persisting outside the encrypted store.
Rejected: teaching `contact export` to emit `display_name` and `importContact` to store it. It is a
change to what trust records hold, and a name chosen by the *sender* displayed next to a pin is a
phishing surface: the one place a human decides who they are talking to must show only values they
compared themselves.

**Selection replaces the `c` cycle.** `j`/`k` move the selection, `Enter` opens the chat pane with
that contact selected. `c` is retired: it cycled `state.contacts`, which on a fresh session was
empty, which is why an operator with fifteen decrypted messages had no key sequence that could
select a contact. Letter keys rather than arrows, deliberately: arrows are `ESC [ A` and decoding
them would put an escape-sequence decoder in the input path of a program whose security argument
rests on the pure layer emitting no escape bytes (T2 §8).

---

## 3. The mechanisms

### 3.1 An input mode that is not a modal

```ts
type InputField = "relay-url" | "profile-dir" | "store-key-env" | "export-path"
                | "card-path" | "message" | "contact-name";

interface InputState {
  readonly field: InputField;
  readonly buffer: string;      // never contains a control character
  readonly renderedAt: number | null;
  readonly maxBytes: number;
}
// on OperatorState:
readonly input?: InputState;
```

**It is a field, not a `Modal`, and that is the load-bearing decision.** `state.ts:147-155` explains
why `help` is a boolean rather than a second `Modal`: "the key list is not a decision … the trust
gate must never have a second door." Composing a message is not a decision about trust either. Making
`Modal` a union would force every `modal !== undefined` site to re-narrow, and the reducer's trust
gate (`tui-shell.ts:161-170`) is one of them. `modalIntent` stays trust-only
(`modal-host.ts:152-160`) and `mapKey`'s modal branch stays exactly as written.

**Key routing, in order** (`mapKey`):

1. `state.modal !== undefined` → the trust modal, unchanged, exclusive.
2. `state.input !== undefined` → `inputKey(key, state)`, which returns only
   `input-insert | input-backspace | input-cancel | input-submit`. **No command key, no pane
   ordinal, no `q` fires while composing** — an operator typing "quit" must not quit.
   Ctrl-C still quits: a console that cannot be left is worse than a lost draft.
3. everything else, as today, including the D-1 busy gate.

**What may enter the buffer.** `input-insert` carries `key.sequence`, and the reducer keeps only the
code points that are **not** control characters — nothing in `U+0000..U+001F`, no `U+007F`, no
`U+0080..U+009F`. This is not cosmetic: the buffer is painted into a frame, and `renderFrame`'s
"contains no ESC byte" property is asserted over the whole frame. Filtering at the boundary means a
paste containing an escape sequence inserts its printable remainder and nothing else, and no later
renderer change can reintroduce the byte. A chunk that begins with `ESC` is treated as a key, not as
text, so `Esc` still cancels.

**Bounds.** `maxBytes` per field: `message` at the CLI's own plaintext bound (Q2), paths and URLs at
1024, names at 128 (`cardSchema`'s own `display_name` bound). Insertion that would exceed the bound
is refused and the row says so, rather than silently truncating a message.

### 3.2 The submit gate, borrowed verbatim from the trust modal

`InputState.renderedAt` is set by `paint()` under the same condition that sets the modal's — after a
frame that was **not** below `MIN_VIEWPORT` was written — and `reduce` refuses `input-submit` while
it is null. The reason is identical: below 72×16 `renderFrame` paints the degraded frame
(`shell-chrome.ts:223-235`), which carries no input row, so an operator in a 40×10 window would be
submitting a body they cannot see. The degraded frame gains one line for the same reason it already
gains one for a waiting trust decision: `a message is being composed — resize to see and send it`.

Insertion is *not* gated — a keystroke that lands in an invisible buffer is recoverable — only
submission is. This is the one place the design deliberately splits the gate, and it splits it in
the direction of refusing the irreversible half.

### 3.3 Run sequences

```ts
type Intent = … | { readonly kind: "run"; readonly requests: readonly CliRequest[] };
type Effect = … | { readonly kind: "run-cli-sequence"; readonly requests: readonly CliRequest[] };
```

`reduce`'s `run` case is unchanged in spirit: refuse while busy, otherwise set `busy` and emit one
effect. The shell runs the requests in order, stops at the first non-zero exit, folds each outcome
through `applyOutcome`, and clears `busy` once, after the last one settles. A single-request sequence
is the existing behaviour and every current binding produces one.

This does change `Intent.run`'s shape, which `tui-shell.singleFlight.test.ts` and
`tui-shell.test.ts` assert against. That is a deliberate, visible edit to existing tests rather than
a parallel mechanism that leaves the old one looking authoritative.

### 3.4 The pane budget stays at five

The header already truncates at 72 columns with five panes (T2 §4). Seven would be worse. Two of the
five are duplicates (§1.3 item 8), so:

| Ordinal | Pane | Contents |
|---|---|---|
| 1 | `profile` | the setup checklist *or* the existing detail rows, plus the health line it already carries |
| 2 | `contacts` | the address book |
| 3 | `chat` | the conversation and the compose row |
| 4 | `mailbox` | counts, plus the rejection list it already renders |
| 5 | `activity` | the last 64 outcomes with their exit classes — `state.activity` already holds them and nothing renders more than the newest |

Nothing is lost: the health line and the rejection list keep the exact renderers they have today.

**What "counts" means on the mailbox pane (flow 004 T26, AC2).** A count is a figure some command
result carried, verbatim, or it is the absence of one — never arithmetic, never accumulation across
results, and never an initial zero standing in for a report nobody made. The console holds no store
key and cannot read `cli:outbox:*` itself, so what a command reported is the only honest source
there is. That makes the two rows different, and the pane says which is which rather than printing
two numbers that look alike:

- **inbox** is `poll`'s own `received` (`runtime/inbound.ts:27`) — the envelopes accepted and
  committed *by that poll*. It is shown as that poll's figure and never summed with an earlier one,
  because per-poll deltas added together drift from the store the first time a result does not
  arrive and nothing ever brings them back. A result that reports no figure reports nothing, so the
  last poll's figure stands: an unreadable child does not erase what a readable one said.
- **outbox** is empty, and the row says so in words. No command in the frozen eight reports a
  pending count — `doctor`'s `diagnostics()` returns `profile_id`, `identity_id`, `device_id`,
  `contact_count`, `contacts`, `storage` and `runtime`, and no outbox figure. The row is kept rather
  than dropped so that the missing report is visible; an operator who cannot see that the console
  has no view of its own outbox will assume it has one. What used to stand here was
  `outboxPending + 1` on a *successful* send, which did not merely guess: a delivered message leaves
  the pending set (`runtime/outbound.ts:289`, `:294`), so the figure moved the opposite way from the
  store, and nothing decremented it.

Adding a pending count to `doctor`'s result would give the row something true to show. That is a
change to a CLI command's output and belongs to a task about the CLI, not to the console.

**The footer becomes pane-aware.** Global keys (`1-5`, `p`, `d`, `r`, `t`, `?`, `q`) stay bound
everywhere; list and compose keys (`j`, `k`, `Enter`, `w`, `s`, `i`, `n`) are bound per pane. The
footer's rank-fitting (`shell-chrome.ts:109-123`) is unchanged; it just gets a shorter list. The
honesty rule — "a footer that advertised an unbound key would be a lie" (`:125`) — becomes a
relation over panes and is tested as one (§7 T-11). The header drops the word `echolet` before it
truncates a tab label, because the tab strip is the navigation and the product name is not.

### 3.5 New `TuiIo` seams

```ts
readonly newMessageId: () => string;   // uuid; keeps reduce pure
// writeChildStdin is NOT new API: main.ts already owns the child's stdin for the trust prompt.
```

`onTrustIdentifiers` stays optional and unchanged. `answerTrustPrompt` stays the only thing written
to a child's stdin *for `contact import`*; the send body is written for `send` and for nothing else,
and `main.ts`'s existing comment ("Nothing but the trust answer is ever written to a child's stdin")
becomes a two-case statement rather than a one-case one.

---

## 4. Failure behaviour: every exit class, on every screen

### 4.1 The explanation table

A new pure module, `failure-text.ts`, exporting one total function
`explain(command, code, exitCode) -> {command, code, exitCode, sentence, action}`. Total, because the
CLI can return a code this table has never seen (`UNREADABLE_CLI_OUTPUT`, or a code added later) and
the console must then say the code and the class rather than nothing. Keyed on **all three**, because
`INVALID_CONTACT_CARD` is returned at exit 2 for a file that would not parse (`cli.ts:217-226`) and
at exit 3 for a card that parsed and failed validation, expiry included (`:317-320`) — one code, two
different things to do about it.

**As built (flow 004 T26).** Three of the five fields are the three arguments, echoed: they are
values a caller compares and a surface composes, and losing the CLI's own code would take away the
string an operator quotes when they report a problem. The two strings are text a frame will carry, so
the code is made paintable on its way into them and the echoed `code` field is left verbatim —
`parseCliOutcome` keeps `error.code` exactly as the child printed it, which means it can carry an
escape sequence, and this module composes new prose out of one. The module writes no `(exit N)` of
its own and names no surface: the activity line composes `${command} → ${code} (exit ${N})` as it
always has and adds the sentence and the action beside it. Two consequences worth stating, because
neither is free: the code appears twice on a wide terminal, once as the value and once inside the
sentence that explains it; and at `MIN_VIEWPORT` the activity line is one 72-column row, so the words
are what gets clipped and the code and the number are what survive. That is the right way round, and
it is why the words are an addition beside the code rather than a replacement for it.

| Class | Codes seen from this tree | What the console says, and does |
|---|---|---|
| **2 — input/configuration** | `INVALID_ARGUMENTS`, `INVALID_CONFIGURATION`, `INVALID_CONTACT_CARD`, `INVALID_MESSAGE_ID`, `INVALID_MESSAGE` | The command was wrong, not the world. State stays put; the input row **reopens** with the rejected value so it can be corrected rather than retyped. `INVALID_CONFIGURATION` sets the profile to `"absent"` and jumps to the checklist. |
| **3 — trust/protocol** | `TRUST_REJECTED`, `CONTACT_NOT_CONFIRMED`, `INVALID_CONTACT_CARD`, `PROTOCOL_REJECTED`, `PREKEY_BUNDLE_UNAVAILABLE`, `UNAUTHORIZED_MAILBOX_ACCESS`, `SENDER_QUOTA_EXCEEDED`, `CONTACT_NOT_TRUSTED`, `SENDER_NOT_PUBLISHED`, `CONTACT_PIN_MISMATCH`, `PREKEY_BUNDLE_EXPIRED`, `MESSAGE_ID_CONFLICT`, `OUTBOUND_REJECTED`, `PROFILE_REJECTED`, `INBOUND_REJECTED`, `CHALLENGE_EXPIRED` | Never flattened into one sentence — the CLI went to some trouble to keep three of them distinguishable (`cli.ts:24-58`) and the console is where that pays off. No trust state changes. `CONTACT_PIN_MISMATCH` is the one that raises an alarm and says so; the others say what to do. |
| **4 — relay/network** | `RELAY_UNAVAILABLE` | `health.status` → `"unreachable"` (already: `tui-shell.ts:262`). "Retrying is safe." A composed message is kept with its message id, because the byte-identical retry is the designed path. |
| **5 — persistence** | `PERSISTENCE_FAILURE` | "Do not retry blindly." On `contact export` it adds the one cause that is not a disk problem: the file already exists (`wx`). It never claims certainty — exit 5 is also a real storage failure. |
| **bridge** | `UNREADABLE_CLI_OUTPUT` | The child's stdout was not one JSON envelope. Names the command and the exit code it did return, and says the console is showing nothing about it — which is honest, and is what `parseCliOutcome` already guarantees by never throwing. |

**Two corrections to the class-3 row, measured while building the table (flow 004 T26, following
004-T23-tests F-002).** `INVALID_RELAY_RESPONSE` was listed here and cannot reach the console under
its own name: `classify` (`commands/cli.ts:472`) reads `error.remoteCode`, not `error.code`, and
`transport/relayClient.ts:38` raises it as a LOCAL verdict with no remote code, so it is flattened to
`PROTOCOL_REJECTED` before an envelope is ever written. An entry for it would explain a string the
CLI cannot return, so it is gone. `INBOUND_REJECTED` (`runtime/inbound.ts:84`) and `CHALLENGE_EXPIRED`
(`:107`) were missing and do reach the console: both are on the authentication path, and both abort
the poll rather than being isolated into its `rejected` array. The per-envelope verdicts —
`INVALID_ENVELOPE` and the rest — are deliberately still absent from every row: `inbound.ts:242`
isolates them into `poll`'s `rejected` array instead of raising them, so they are painted by the
rejection list and are not an exit class at all.

The specific sentences the operator needs most, all of which the CLI itself cannot deliver (§1.3
item 6):

- `UNAUTHORIZED_MAILBOX_ACCESS` / `SENDER_NOT_PUBLISHED` → "this profile has never published; run
  step 2 (`r`), then send again." Points at the checklist step, not at a paragraph.
- `PREKEY_BUNDLE_UNAVAILABLE` → "**their** side has no claimable prekey bundle: they have not
  published, their pool is drained, or their bundles expired. Ask them to run `relay publish`. This
  is not a trust failure and nothing is wrong with your profile." The exit code is 3, and every
  instinct an operator has about exit 3 is wrong here.
- `SENDER_QUOTA_EXCEEDED` → "they have not polled in a while and your unacked allowance in their
  mailbox is full. It clears when they poll or when the envelopes expire. Temporary."
- `CONTACT_NOT_TRUSTED` → "you have not imported their card. Contacts pane, `i`."
- `MESSAGE_ID_CONFLICT` → "this message id was already used for different text. The console will
  mint a new one." (And it does.)
- `CONTACT_PIN_MISMATCH` → "the bundle the relay served does not match what you pinned. Stop.
  Do not re-import from a card you received the same way."

### 4.2 What registration does with one code for six causes

`INVALID_CONFIGURATION` at exit 2 cannot be decomposed by the console. Two mitigations, neither of
which invents information:

1. **Refuse before spawning.** The relay URL is validated against the *same* predicate `config.ts`
   uses (§6 P-3), and the store-key variable name against the same `/^[A-Z][A-Z0-9_]*$/`. A value
   the CLI would reject never becomes an argv, so the operator gets a specific message instead of
   the shared code.
2. **Report what is checkable locally.** When a command returns `INVALID_CONFIGURATION` and step 0
   is unmet, the checklist says so first: "the store key variable `<NAME>` is not set in this
   console's environment — that alone produces this error." When step 0 *is* met, it lists the
   remaining causes without ranking them. Rejected: guessing. Rejected: giving `ConfigurationError`
   distinct codes, which is a change to the failure vocabulary of every command and belongs to a
   task about the CLI's error model, not to this one.

### 4.3 Failures inside a sequence

The first non-zero exit stops the sequence, the activity line names both the failure and the
abandoned request, and `busy` clears once. A `send` that fails never runs `history`; a `poll` that
fails never runs `history`. A `poll` that *succeeds* with rejections still exits 0 (specification.md
§`poll` result) and the sequence continues — the rejections are data, not a failure.

---

## 5. What this design costs, and what was rejected instead

Every item names a property from the task description or from T2's global invariants.

**1. "One command in flight at a time" changes unit.** It becomes "one operator action, one sequence,
one child at a time". Two children can result from one keystroke, strictly sequentially, never
overlapping. *Rejected:* no chaining at all — the chat pane would then show a conversation missing
the message just sent, which an operator reads as a failed send; and an optimistic local echo, which
would force the console to invent the `sequence` and `createdAtMs` the store owns, because `send`
returns neither.

**2. The frozen eight-command surface keeps eight commands, but two change interface.** `send` gains
a stdin body path; `doctor` gains a `contacts` array. No ninth command. *Rejected:* `contact list`
as a ninth command — retired by an explicit flow decision, and this console must never be the reason
one is added. *Rejected:* reading the encrypted store from the console — it would need the 32-byte
key, which AC5 forbids outright. *Rejected:* keeping the session-observed roster — the address book
would be empty on every fresh session, which is the measured Run E defect with a new pane over it.

**3. `renderFrame`'s exactness stays code-point exactness, and operators now type.** A message
containing a combining mark or an East Asian wide character will occupy one *code point* and more
than one *column*, so the frame will be exactly `rows × cols` code points and visually ragged. This
was already true of history plaintext; composing makes it reachable on purpose. *Rejected:* a
`wcwidth` table — T2 §8 refuses the dependency and the bug class, and the project's own evidence is
Cyrillic, which code points handle correctly.

**4. Operator-controlled bytes enter a frame for the first time by design.** The mitigation is a
filter at the boundary (§3.1), not a rule in the renderer, so no later renderer change can
reintroduce an escape byte. *Rejected:* filtering in `renderFrame` — that would make the "no ESC"
property a property of the renderer's defensiveness rather than of the state, and the state is what
the tests assert over.

**5. One body row is spent on the input row while composing.** At `MIN_VIEWPORT` that is 10 body rows
instead of 11. The notice, header, rule, activity line and footer are untouched. *Rejected:* a
compose overlay — it would give the trust gate a second door, which `state.ts:147-155` argues
against in this exact repository.

**6. The console runs one command the operator did not press** (the startup `doctor`). *Rejected:*
starting with `identityId: "(run doctor)"` and an empty roster, which is the current behaviour and
is the reason an operator cannot find their own identity or any contact without pressing keys whose
purpose is not visible.

**7. Two panes disappear** (`rejections`, `health`) and `c` is retired. Muscle memory breaks.
*Rejected:* seven panes — the header already truncates at five in 72 columns, and truncating the
navigation is worse than renumbering it once. Nothing is lost: both panes' renderers already run
inside the panes that absorb them.

**8. `doctor`'s output grows to enumerate who this profile trusts.** All four values are public and
the trust modal already paints them, but a `doctor` output pasted into a bug report now names the
operator's correspondents. *Rejected:* a flag to opt in — the CLI's flags are per-command allowlists
and a flag whose default hides data the console needs would just make the console always pass it.

**Explicitly not cost:** the unaudited-prototype notice (row 0 on every frame, including the degraded
one and every new pane — the new panes are pane *bodies*, they do not touch the chrome); key material
in a frame or an argv (no new field can hold a key; `storeKeyEnv` stays a name; `Object.hasOwn`
cannot produce a value; the message body leaves argv rather than entering it); and the trust modal's
painted-at gate (unchanged, and §2.3 extends its spirit by refusing to seed a modal from anything but
the child).

---

## 6. Prerequisites in the CLI

All three are inside this dispatch's scope ("the CLI commands it drives"). None is a relay, wire or
schema change. Each is small, and each is stated as a behaviour so a test can be written first.

**P-1 — `send` reads its body from stdin when `--text` is absent.**
`--text` keeps working exactly as today, so every existing script and test is untouched. When
`--text` is absent, the body is the bytes read from stdin to EOF, decoded UTF-8, **untrimmed**
(Q3). Guards: empty → `INVALID_ARGUMENTS` exit 2; over the plaintext bound → `INVALID_MESSAGE`
exit 2 (which is what `outbound.ts:118` already produces); `--text` absent **and** stdin is a TTY →
`INVALID_ARGUMENTS` exit 2 rather than a process that hangs waiting for a human. `rejectUnexpectedMissing`
stops listing `text` for `send` and the emptiness check moves into the body reader.
*Rejected:* `--text-file <path>` — the console would have to write a plaintext file, breaking "the
console writes no file" and putting a message on disk outside the encrypted store.

**P-2 — `doctor` reports the pinned contacts.**
`diagnostics()` gains `contacts: ContactIdentifiers[]` from the already-existing
`listContacts()` (`profile.ts:448`), in the same sorted order, carrying exactly the four fields
`contactSchema` holds. Additive: `contact_count` stays, and a consumer reading only the old fields
is unaffected. The only in-tree consumers of `doctor`'s JSON are the TUI (`tui-shell.ts:272-280`)
and one test fixture (`main.processDriven.test.ts:278`) — see Q1.

**P-3 — one relay-URL rule, in one place.**
`parseClientConfig` refuses non-origin URLs, credentials, and non-loopback plain HTTP
(`config.ts:40-52`), and its own comment records what happened the last time that rule lived in two
places. The console needs the same predicate to validate a typed URL before it becomes argv, so the
rule moves into a leaf module beside `transport/loopback.ts` and both import it. No behaviour change
on either side.

---

## 7. The tests, in the order they would be written

Test-first: each is red before the code exists. **Pure-layer** means value comparisons over
`mapKey` / `reduce` / `renderFrame` / a pane builder, with no process, no terminal, no store and no
relay. **Driven** means a real child process.

| # | Test | Layer | What it pins |
|---|---|---|---|
| T-1 | `cli-bridge.sendBody.test.ts` | pure | `buildArgv({command:"send",…})` emits no `--text` and no token containing the body, for bodies including one that looks like a flag. Written first because everything in §2.2 rests on it. |
| T-2 | `tui-shell.input.test.ts` | pure | Insert, backspace, cancel, submit; no `U+0000..U+001F`, `U+007F` or `U+0080..U+009F` can enter the buffer from any chunk; the byte bound refuses rather than truncates; command keys, pane ordinals and `q` are inert while composing; Ctrl-C still quits. |
| T-3 | `shell-chrome.input.test.ts` | pure | With the input row open the frame is exactly `rows × cols` code points, contains no ESC byte and carries `UNAUDITED_NOTICE`, at 72×16, 120×40 and below the minimum; the degraded frame names the pending compose. |
| T-4 | `tui-shell.inputTrustExclusion.test.ts` | pure | Input cannot open while `busy`; a trust modal therefore never displaces an open input; while a modal is open no key reaches the input; `reduce` emits `answer-trust-prompt{answer:true}` only for a `kind:"trust"` modal. |
| T-5 | `tui-shell.sequence.test.ts` | pure | A sequence sets `busy` once and clears it once, runs in order, stops at the first non-zero exit, never exceeds two requests, and a second request never starts a sequence. |
| T-6 | `tui-shell.messageId.test.ts` | pure | One id per composed body; the same id on an unchanged retry; a new id after an edit; the id comes from the injected seam, never from the clock. |
| T-7 | `contacts-pane.test.ts` | pure | The three-provenance merge; a candidate never counts as pinned; pinned and unpinned render distinctly; the four identifiers appear in full for the selected entry at every supported width; an expired card is marked and names the exit-3 code it will produce; an unreadable card is listed, not dropped. |
| T-8 | `profiles-pane.setup.test.ts` | pure | Step states derive only from observed outcomes; step 0 is decided by presence, and rendering is identical whether the variable's value is present or absent from the environment (the `tui.keyMaterial.test.ts` "does not read the environment while rendering" pattern). |
| T-9 | `failure-text.test.ts` | pure | `explain` is total; every code reachable from `cli.ts`'s `classify` has an entry; `INVALID_CONTACT_CARD` at exit 2 and at exit 3 produce different text; an unknown code still names the code and the class. |
| T-10 | `tui.keyMaterial.test.ts` *(extended)* | pure | The exhaustive sweep covers the two new panes, the checklist and the input row; the `InputField` union contains no field whose value could be key material; a real 32-byte store key in the environment reaches no frame and no argv on any new path. |
| T-11 | `shell-chrome.footerHonesty.test.ts` | pure | Per pane: every key the footer or help list names maps to an intent on that pane, and every key `mapKey` binds on that pane appears in the help list. A relation, not a fixture. |
| T-12 | `cli.sendStdin.test.ts` | driven (CLI child; no relay) | Exact bytes arrive as the body; empty → exit 2; oversize → exit 2 `INVALID_MESSAGE`; `--text` absent with a TTY stdin → exit 2 rather than a hang; `--text` still works unchanged. |
| T-13 | `cli.doctorContacts.test.ts` | driven (CLI child on a real profile; no relay) | `doctor --json` lists exactly the imported contacts' four identifiers, in `listContacts` order, and `contact_count` equals the array's length. |
| T-14 | `main.processDriven.compose.test.ts` | driven (real console + fake CLI) | Composing and submitting spawns exactly one child; the body appears on that child's **stdin** and in **no announced argv**; the `history` child starts only after the first child has exited; a failing send spawns no second child and preserves the buffer. Extends the existing control-socket harness, which already announces every child's argv. |
| T-15 | `main.processDriven.registration.test.ts` | driven (real console + fake CLI) | The checklist drives `init` → `relay publish` → `contact export` in that order, one child at a time, only on operator keystrokes; a failure at any step leaves the later steps unrun and the step marked with its code and class; exit 5 on export names the existing-file cause without claiming certainty. |
| T-16 | `main.processDriven.contactImport.test.ts` | driven (real console + fake CLI) | An import started from the address book still opens the modal from the **child's** printed identifiers; a card whose file changed after listing yields a modal showing the child's values, not the parsed ones; `--yes` appears in no argv. |

T-1 through T-11 are eleven pure files; T-12 and T-13 drive the CLI; T-14 through T-16 drive the
real console binary. The pure half can be written and made red before any prerequisite in §6 exists;
T-12 and T-13 are the red tests *for* P-1 and P-2.

Not proposed, because it already exists: a test that opens a trust modal through the real shell and
pins the viewport guard. `tui-shell.trustViewport.test.ts` does exactly that at four viewports
(§1.3 item 1), notwithstanding what `PAUSED.md` says.

---

## 8. Open questions, and the evidence that settles each

**Q1 — Does adding `contacts` to `doctor`'s result reopen the frozen-surface decision, and does it
break a consumer?**
*Evidence that settles it:* an enumeration of every consumer of `doctor`'s JSON. In-tree there are
two (`tui-shell.ts:272-280` reads three named fields; `main.processDriven.test.ts:278` builds a
fixture with only `contact_count`), and both are additive-safe. Out of tree there are the operator's
own wrappers — `~/.echolet/echolet`, `~/.echolet/peer` and `/home/ubuntu/.echolet-peer/echolet` on
`depr` (T34) — which this repository does not contain. Reading those three scripts settles it
completely. The *policy* half (is a new field on a frozen command's result a surface change?) is the
flow owner's, not mine.

**Q2 — Where does the plaintext byte bound live so the console and the CLI cannot disagree?**
Today it is the literal `65536`, twice, in `outbound.ts` (:22 and :118), while
`LIMITS.MAX_MESSAGE_BYTES = 262144` bounds the *envelope* — a different quantity. The console needs
the plaintext number. Options: (a) a `MAX_PLAINTEXT_BYTES` in `packages/protocol/src/constants/limits.ts`,
following the "one protocol constant governs message size on both sides of the wire" precedent
(commit `5235a6d`) and the `PREKEY_MIN_COUNT` precedent of a client-only constant living there;
(b) a leaf module in `apps/cli` imported by both. *Evidence that settles it:* whether
`src/tui` may import `@echolet/protocol` without breaking `dist/tui.js` — the bundle is built with
`external: ["@signalapp/libsignal-client"]` only (`main.processDriven.test.ts:110-120`), so protocol
and zod would be inlined. A single build of `dist/tui.js` with that import present, and its size,
answers it. **I could not run it: this dispatch forbids builds.** I lean (a).

**Q3 — Does a stdin body get its trailing newline stripped?**
`--text "hi"` sends exactly `hi`. `printf 'hi\n' | send` would send `hi\n` under the untrimmed rule
proposed in P-1, so the same message typed two ways produces two different ciphertexts and two
different history entries. Stripping exactly one trailing newline fixes the common shell case and
silently alters a message that legitimately ends in one. *Evidence that settles it:* what the
operator's own wrappers do — `~/.echolet/peer write "…"` uses `--text` today, so nothing in the live
system depends on either answer yet, and the decision is free right now and expensive later. My
recommendation: **no stripping**, and the console never appends a newline, so what the operator sees
in the compose row is byte-for-byte what is sent.

**Q4 — Should `contact export` gain `--force`, or is a fresh filename enough?**
Cards expire every seven days (§1.3 item 7), so re-export is routine, and `wx` turns the second
export into exit 5. The design uses a timestamped default path and needs no CLI change. *Evidence
that settles it:* whether any live wrapper script re-exports to a **fixed** path — `~/.echolet/peer`
and the `depr` wrapper both keep fixed card files (`peer-card.json`, `owner-card.json`), so if those
scripts re-export, they hit exit 5 today and `--force` would be earning its keep. Reading those
scripts settles it.

**Q5 — Is `state.observedAtMs` the right way to age a contact card, or should expiry be computed
once at parse time?**
`renderFrame` must not read a clock. Folding a clock reading into state keeps it pure but makes many
frames differ in one field, which every frame-equality assertion in the suite then has to account
for. *Evidence that settles it:* how many existing assertions compare whole frames for equality
rather than for containment — a count over `apps/cli/src/tui/*.test.ts`. If the count is large, the
cheaper design is to store a precomputed `expired: boolean` refreshed at the same moments, which
keeps frames stable between commands.

**Q6 — Should the sync sequence (`poll` → `history`) exist at all, or should the operator press two
keys?**
It is the operator's own `read` verb, and it doubles the number of children one keystroke can
produce. *Evidence that settles it:* whether an operator using the console for ten minutes ever
wants `poll` without `history` — observable from one recorded session against the live relay, which
this dispatch cannot run. If the answer is no, `p` on the chat pane could simply *be* the sequence.

**Q7 — What happens to a composed message when the operator switches profile with `t`?**
The buffer belongs to a `(profile, contact)` pair and switching profiles makes its recipient
meaningless. Discarding it silently loses work; keeping it risks sending it from the wrong identity.
*Evidence that settles it:* none needed from the tree — this is a product decision. I propose `t` is
inert while composing (input mode swallows it, per §3.1), which makes the question unreachable
rather than answered. Recorded here because "unreachable" is a decision too.

---

## 9. What I recommend against

- **Making the compose surface a `Modal`.** It is the single change that would put a second door on
  the trust gate.
- **A scrollable, unbounded transcript.** `history` returns whole conversations and the pane keeps
  its tail with a truncation marker (`pane-fit.ts`). Bounded in-state paging is testable as a pure
  function; a scrollback is not, and the console owns the alternate screen anyway.
- **Auto-polling on a timer.** It would spawn children the operator did not ask for, against the
  single-flight rule, and it would make every failure arrive unattended. The sync key is enough.
- **Any use of `--yes` on `contact import`, for any convenience.** It moves the trust decision out of
  the child and into the console.
- **A "notes" or "alias" file.** See §2.3; names come from argv or die with the session.
- **Widening `MIN_VIEWPORT` to make room for the input row.** The notice's 62 columns is what set 72
  (`shell-chrome.ts:30-39`); trading an acceptance criterion for a text field is not a trade.

---

## 10. Routing audit

`graph_used: no` — not-relevant. The surface is one directory of eighteen files plus four runtime
modules, all named by the dispatch's `files_to_read` and reachable from them by direct import; a
graph query would have returned the list I already had. Rebuilding the graph was also inadvisable
while another agent is measuring this machine.
`wiki_used: yes` — `wiki/index.md` was read first. It holds sixteen generated draft pages
(project map, quality map, testing map, per-directory component stubs) and no architecture, domain,
business-rule or decision page, so it answered nothing about this surface. Recorded as consulted and
empty rather than skipped.
`ctx_used: yes` — `keryx ctx run`, `keryx ctx read` and `keryx ctx diff` for every command,
long file and diff.
`raw_rg_used: no` — every search went through `keryx ctx rg`.
`memory_used: no` — not-relevant for a design over current code; the flow's own `PAUSED.md`,
`t2-tui-usability-design.md` and `t34-second-user-report.md` carried the history this task needed,
and one of them was measured stale (§1.3 item 1).
`tests_run: none` and `build_run: none`, per the dispatch's absolute constraint.
