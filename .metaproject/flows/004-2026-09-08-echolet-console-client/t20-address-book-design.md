# T20 — The address book: the contacts pane, and the branch the operator still holds

Date: 2026-09-09. Flow 004. Design only. No source file was changed, no test file was changed, no
suite and no build was run — another agent (T18) is measuring the suite on this tree right now.

Scope: the `contacts` pane this flow's description holds open as an operator decision, plus the one
question that reaches into conversations — how a contact selected here opens one. Registration
(T15–T17), the compose surface (T10–T14) and the two CLI prerequisites `send` reads its body from
stdin and `doctor` enumerates pinned contacts (T5–T9) are **already implemented on this tree**; this
design does not redo them, it reads what they actually built and designs the one piece that is
still a description in a document (`t35-console-client-design.md` §2.3, flow 003) and not a pane.

---

## 0. The verdict, in one paragraph

`doctor` has enumerated pinned contacts since T9 (`profile.ts:476-479`), and nothing on this tree
reads the field it added: `applyOutcome`'s `doctor`/`init` case (`tui-shell.ts:735-749`) still folds
only `identity_id`, `device_id` and `contact_count`, and `PANE_IDS` (`state.ts:25`) still names the
same five panes flow 002 shipped — `profiles, mailbox, history, rejections, health` — with no
`contacts` pane at all. Both branches below add one: ordinal 2, built the same way every other pane
is (`buildContactsSnapshot` + `formatContactsLines`, a value in and a value out), merging three
provenances by `identity_id` — doctor's pinned array, this session's own imports, and the contact
cards named at launch — and showing the four out-of-band identifiers in full for whichever row is
selected, never elided, the same rule `modal-host.ts` already enforces for the trust modal. What the
branches disagree about is arithmetic, not design: `headerLine` (`shell-chrome.ts:64-68`) has no
truncation of its own, only the frame's blanket `fitLine`, and it **already** overflows 72 columns
with today's five panes and a five-character label — measured below, not asserted. Branch A's five
panes overflow it too, by less. Branch B's six overflow it by nearly twice as much, and every
mitigation that closes the gap trades away exactly the thing a sixth named pane was for. That
measurement is §4; the operator's answer starts one of the two ordinal tables in §3–§4 rather than a
redesign.

---

## 1. What the tree actually does today

Read at HEAD plus the working tree. Every citation is to committed content; where flow 003's design
note and the code it describes have since diverged, §1 says so and the code is what this design
believes.

### 1.1 `doctor` already reports pinned contacts; nothing consumes it

`Profile.diagnostics()` (`profile.ts:476-479`) is additive over `summary()`:

```ts
async diagnostics() {
  const contacts = await this.listContacts();
  return { ...await this.summary(), contact_count: contacts.length, contacts, storage: "encrypted", runtime: "node-reference" };
}
```

`contacts` is `ContactIdentifiers[]` — exactly `contactSchema`'s four fields
(`identity_id, device_id, device_pubkey, signal_identity_key`; `profile.ts:79-82`), in
`listContacts()`'s order, which is `tx.keys("cli:contact:").sort()` (`profile.ts:448-450`): sorted by
key, i.e. lexicographically by `identity_id`. `cli.doctorContacts.test.ts` pins this contract driven
against a real CLI process. `applyOutcome`'s `"init" | "doctor"` case (`tui-shell.ts:735-749`) reads
`data.identity_id`, `data.device_id` and `data.contact_count` from the same object and **never reads
`data.contacts`**. The field has existed on every `doctor` result since T9 and has had no reader in
`src/tui` since. This design's whole job is to give it one.

### 1.2 A stale comment, in the module this design changes most

`profiles-pane.ts`'s header comment (`:6-19`) still says "the frozen eight-command CLI surface has
no command that lists pinned contacts: `doctor` reports `contact_count` and nothing else, and
`Profile.listContacts()` has no entry point" — true when flow 003 T2 wrote it, false since T9. The
`rosterDiscrepancy` mechanism it built on that premise (`:183-186`, `unseen = contactCount -
contacts.length`) computes a number the console no longer has to guess at: doctor's own array *is*
the authoritative list, not a count to reconcile a partial one against. `profiles-pane.rosterClaim
.test.ts` pins a narrower, still-true claim — that the roster does not also hold exported cards — and
nothing here disturbs it. But the wider premise the module's header comment states is the first
place this design's implementation has to correct a document against the tree, and it is inside
`src/tui`, not outside it.

### 1.3 The five panes today, and the pane the roster actually lives on

```ts
export const PANE_IDS = ["profiles", "mailbox", "history", "rejections", "health"] as const;
```

There is no `contacts` pane and no `chat` pane; `history` is still `history`, and it is where a
contact's conversation is read and where `w` opens the compose row today
(`tui-shell.ts:184-207`, gated on `state.pane !== "history"`). The roster that exists — session-
observed imports only — is painted on the **profiles** pane (`profiles-pane.ts:219-224`), appended
after the six detail rows, not on a pane of its own. `formatMailboxLines` already renders the
rejection list in its tail (`mailbox-pane.ts:54-61`) and `formatProfilesLines` already appends the
health line in its tail (`profiles-pane.ts:225`, `tail: ["", snapshot.healthLine]`) — flow 003 T2's
claim that `health` and `rejections` duplicate their neighbours is, measured against the tree today,
still true.

### 1.4 The header already overflows 72 columns with the five panes that exist now

`headerLine` (`shell-chrome.ts:64-68`) builds one string with no truncation of its own; the frame
clips it to `cols` afterward with plain `fitLine` (`padOrClip`), which drops trailing characters
silently and pads nothing back. Measured by evaluating the exact function against `MIN_VIEWPORT.cols
= 72`:

| Config (label `"alice"`, 5 chars) | Full width | Overflow past 72 | What `fitLine` drops |
|---|---|---|---|
| **today**, 5 panes | 84 cols | **12** | `s  5 health` — pane 5's entire tab, and pane 4's trailing `s` |
| empty label (`""`) | 79 cols | **7** | still loses pane 5's tab whole |

So the header is truncated **today**, before this design adds anything: at `MIN_VIEWPORT` an operator
cannot read that pane 5 is called `health` from the header at all, only that keys `1`–`4` exist. This
is not a consequence of adding a contacts pane; it is the tree's present behaviour, and it is the
baseline both branches are measured against in §3–§4.

### 1.5 "Card candidate" is a provenance this design has to build, not one that exists

`main.ts`'s `--card` is singular per profile (`parseOptions`, `:99`: `patched.contactCardPath =
resolve(value)`, an overwrite, not a push), and `ProfileView.contactCardPath` is one optional string
(`state.ts:101`). Nothing in `main.ts` reads a card file's *content* — the console only ever learns
the four identifiers of a card being imported from the **child's own stderr**, mid-handshake
(`readIdentifiers`, `main.ts:160-180`), the way `contact import` already prints them. flow 003's
design note describes repeatable `--card`, an optional `--name`, and a console that parses the file
itself to list it as a candidate before import (t35 §2.3). None of that is built. It is buildable —
§2.10 below shows exactly what a card holds and how little of it the console needs to read — but it
is new scope this design must size honestly rather than assume shipped.

### 1.6 What a card holds, read with no key at all

`cardSchema` (`profile.ts:74-78`): `{ type, version, display_name?, signal_bundle }`, where
`signal_bundle` matches `SignalPreKeyBundleV2Schema`
(`packages/protocol/src/types/signalPreKeyBundleV2.ts:32,48-49`) and carries, in the clear, on disk:
`bundle_id`, `created_at_ms`, `expires_at_ms`, `signal_identity_key`, and a `device_record` holding
`identity_id`, `device_id`, `device_pubkey`. Every one of the four out-of-band identifiers plus both
expiry timestamps is a plaintext field of a JSON file a stranger wrote, readable with `JSON.parse`
and no store key — exactly the six public values flow 003 named. `exportContact()`
(`profile.ts:302-304`) builds `{ type, version, signal_bundle }` and nothing else: **no card this
tree produces carries `display_name`**, so a name shown next to a candidate can only be local. This
is still true; §2.7 depends on it.

### 1.7 The mechanisms this design reuses already exist, unwired

- `select-contact` is a live `Intent` (`intents.ts:16`) and reducer case
  (`tui-shell.ts:311-312`) — today driven only by the `c` key's cycle through
  `state.contacts` (`tui-shell.ts:222-225`). The wiring this design needs is a second producer of the
  same intent, not a new one.
- `ContactView` (`state.ts:109-115`) already carries an optional `displayName`, unread by every
  current pane. The naming half of this design (§2.7) needs no new field.
- `InputField` already includes `"contact-name"` with its own byte bound
  (`inputMaxBytes`, `state.ts:230-244`, `NAME_MAX_BYTES = 128`) and no key opens it yet. The naming
  mechanism's data plumbing is built; only the `n` key and its precondition are missing.
- `j` and `k` are unbound. Every other letter this design would want is taken: `p d r h i c t w q ?`
  and `return`; `s` is also unbound.
- The footer (`FOOTER_KEYS`, `shell-chrome.ts:85-96`) is a single global list with no per-pane
  filtering — `footerLine` calls `fitFooter` unconditionally on it. flow 003's proposal that the
  footer become pane-aware (t35 §3.4) has not been built either; this design does not require it, but
  notes where it would help (§2.8).

### 1.8 `MAX_PLAINTEXT_BYTES`, resolved since flow 003 wrote its Q2

`apps/cli/src/limits.ts` exists — a leaf module, `MAX_PLAINTEXT_BYTES = 65536` — and `state.ts:13`
already imports it for the compose row's byte bound. flow 003 §8 Q2 is answered on this tree: option
(b), a leaf module inside `apps/cli`, not a `packages/protocol` constant. Nothing in this design
needs a second answer to a question the tree has already settled.

---

## 2. What both branches share

Everything below is one contract. Branch A and Branch B differ only in the pane's ordinal and in
what shares the header with it (§3, §4).

### 2.1 Three provenances, merged by `identity_id`, one list

1. **Pinned** — `doctor`'s `contacts` array, folded into a new state field (§2.9), authoritative:
   these are rows in the encrypted store, confirmed by the CLI's own read of it. A `contact_count`
   that disagreed with the array's length would be a CLI defect, not a discrepancy this pane
   reconciles (§1.2) — it no longer needs to, because it now has the array itself.
2. **Observed this session** — the existing `observeContact` path (`tui-shell.ts:854-860`), kept
   unchanged: it puts a contact on the list the instant an import succeeds, before the next `doctor`
   confirms it. Merged INTO the pinned rows by `identity_id`, never listed a second time beside them —
   an import already creates the trust record synchronously (`profile.ts:434-445`); the console's last
   `doctor` snapshot simply has not caught up yet, and the merge is what makes that catching-up
   invisible to the operator instead of a second, unpinned-looking row for a contact that is in fact
   already pinned.
3. **Card candidates** — cards named at launch, parsed once by the composition root (§2.10). A
   candidate is never a contact: no trust exists until `contact import` runs and the operator answers
   the child's own prompt. Sorted below every pinned row, in launch order.

### 2.2 What each row shows, and the order

```
contacts for alice                         2 pinned · 1 candidate
  ● Nadia            mL_Hg-NSPVUAvL8FnbFgw84…   pinned
  ● (unnamed)         N164884qQpTeQBT3RJMcv5B…   pinned
  ○ Bob (this session) t3Ge9wV0kQ2sT…             card, expires 2026-09-14 08:12Z
  ✗ Kim (this session) 9pQ2…                      card EXPIRED 2026-09-02 — import will fail (exit 3)

selected: Nadia
  identity_id:          mL_Hg-NSPVUAvL8FnbFgw84kzb6KPNPQ-jYXJWU6XBI
  device_id:            9f0c4a11-2b3c-4d5e-8f60-71829a3b4c5d
  device_pubkey:        npsPUBKEY_aW9mNX62tZs5M0oqAWtn05cWtn9gCw0gM
  signal_identity_key:  BQdNjP6tbN00N3eS6DNpmKpMDFDeDa4MFuUO1QWt8i
[j/k] move  [enter] open chat  [i] import  [n] name
```

Order: pinned rows first, in `doctor`'s own order (stable across renders — it does not reshuffle as
names are added locally); then candidates, in the order they were named at launch. Within a row: the
provenance marker, the name (a local label if one exists, `(unnamed)` if the row is pinned or
observed with none, or a candidate's own file-derived hint), the identity id **elided to fit the row**
(list rows are not the surface AC4 requires in full — the **detail block** below is, and it is
never elided, at any width the pane is visible at all: see §2.4), and a one-line status.

### 2.3 Three provenances, three marks, one expiry state

| Mark | Meaning | Can it be selected for a conversation? | The only action offered |
|---|---|---|---|
| `●` | pinned (from `doctor`, or observed this session and not yet reconciled) | yes | `n` to name it locally |
| `○` | card candidate, unexpired | no — it has no trust yet | `i` to import it |
| `✗` | card candidate, **expired** | no | `i` — still offered; the operator may have a reason, but the status line says plainly what pressing it will do: `import will fail with INVALID_CONTACT_CARD (exit 3) — the card is past its seven-day window`, per `wire.ts:40,82` and `cli.ts:317-320` |

`✗` is a candidate whose `signal_bundle.expires_at_ms` (read at launch, §1.6) is at or before
`state.observedAtMs` — the same clock reading already folded into state at startup and after every
settled command (`tui-shell.ts:788,868`; `renderFrame` and `reduce` still read no clock of their
own). An unreadable file (not JSON, or JSON that fails `cardSchema`) is listed too, marked `?`, named
by its path, with the status `this file is not a contact card` — a candidate the console cannot parse
is not silently dropped, the same "say what is not shown" rule `pane-fit.ts` already documents for
truncated lists.

### 2.4 The four identifiers, in full, for the selected row — and at which viewports

`TRUST_IDENTIFIER_FIELDS` (`modal-host.ts:18-23`) are the same four fields, shown for whichever row
is selected — pinned, observed or candidate — in a **detail block** beneath the list, one `field:
value` pair per line. `modal-host.ts:105-113` already states the rule this reuses verbatim: "a modal
that elided the middle of a base64url key would look correct and verify nothing." Same rule, second
surface, same reason.

One line per field (not the modal's two-line `field:` / `  value` layout) is a deliberate difference,
not an inconsistency: the modal is a fixed panel bounded by `MODAL_PANEL_MIN_WIDTH = 56`
(`modal-host.ts:40`), where a label and a 43-column base64url value together would not fit one line at
the panel's floor. The contacts pane spans the **whole frame width**, whose floor is
`MIN_VIEWPORT.cols = 72` — `"signal_identity_key:  "` (22 columns) plus a 43-column value is 65
columns, which fits with room to spare. Verified, not assumed: at 72×16 the pane's body is 11 rows
(`HEAD_ROWS=3` + `TAIL_ROWS=2` subtracted from 16), or 10 while a compose row is open elsewhere on
screen (`shell-chrome.ts:340-346` — the compose row is chat-pane state, never open together with a
selection on this pane, but the row budget is a property of the frame, not the pane). A status line
plus four identifier lines is 5 fixed lines; at 11 body rows that leaves **6** for the scrollable
list before a truncation marker takes one of them (§2.6); at 10, **5**.

**The detail block is drawn whenever a row is selected, at every viewport at or above
`MIN_VIEWPORT`.** Below it the frame is the degraded one (`tooSmallFrame`, `shell-chrome.ts:283-302`),
which carries no pane body at all — the same floor the trust modal and the compose row already
answer to. There is no narrower floor specific to this pane: the arithmetic above is the proof that
72 columns is already enough for the identifiers in full, so this design adds no new viewport gate,
only reads the one the frame already enforces.

### 2.5 Selecting a contact for a conversation

`j`/`k` move a highlight over the merged list (a new, pane-local cursor — see §2.9); `Enter` on a
**pinned** row emits `select-contact` (the existing intent, `tui-shell.ts:311-312`) with that row's
`identity_id`, and switches `state.pane` to the conversation pane in the same step. `Enter` on a
**candidate** row does nothing: a candidate has no trust and therefore no history to open, and a
key that would build an incomplete request must return `undefined` rather than open an empty
conversation — the rule every other key on this surface already follows
(`paneKeyIntent`'s own comment, `tui-shell.ts:166-167`). The candidate's only action is `i`.

This is the point where §2.2 of flow 003's design (conversations) and this design meet, and it is the
only piece of it this document depends on: `history`'s pane (today `history`, ordinal 3 in both
branches below) already reads `state.selectedContactId` (`history-pane.ts:25-43`) and already gates
`w` on a contact being selected there (`tui-shell.ts:205-207`). Nothing about the conversation pane's
own rendering, its send path, or its message-id rules changes here; this design only adds the second
way `selectedContactId` gets set.

### 2.6 More contacts than rows

The list is the truncatable region and the detail block plus heading are the fixed ones — exactly
`pane-fit.ts`'s `head`/`rows`/`tail` split, reused rather than reinvented. `keep: "head"` for the same
reason `profiles-pane.ts` already gives it (`pane-fit.ts:19-22`, quoted verbatim): **the roster is a
selection surface whose order must agree with what the cursor walks**, and pinned-first order is what
an operator scanning for "who do I already trust" wants at the top. A pane too short for the whole
list shows its head, `truncationMarker(hidden)` ("`… N more not shown`"), and stops — never a silent
prefix. The cursor can still move past what is visible: `j`/`k` are not bounded by `bodyRows`, only by
the merged list's length, so an operator can walk to a hidden entry and the pane scrolls to keep the
cursor's row in the visible window, the same "the list keeps the row the next keystroke lands on"
principle the compose row already states for its own tail (`composeLine`,
`shell-chrome.ts:164-171`).

### 2.7 Names are local, and the pane says so

No card this tree produces carries `display_name` and no import stores one (§1.6); a name shown here
is **local and marked as such**. Two sources, both already possible on this tree:

- `--name <label>` at launch, attached to a `--card` (§2.10). Durable across restarts because it lives
  in the operator's own launcher script, never written by the console.
- `n` on the highlighted row opens the existing `contact-name` input field
  (`inputMaxBytes`, `state.ts:234-236`; `NAME_MAX_BYTES = 128`, `cardSchema`'s own `display_name`
  bound). Submitting sets `ContactView.displayName` for a pinned/observed row — the field already
  exists (§1.7) — or a candidate's local label. Marked `(this session)` and gone at exit; no file is
  written, so T2 invariant 9 ("the console writes no file") is not touched.

Rejected, for the same reason flow 003 rejected it: a names file, or teaching `contact export` /
`importContact` to carry `display_name`. A name chosen by the *sender* and displayed next to a pin is
a phishing surface — the one place a human decides who they are talking to must show only values they
compared themselves.

### 2.8 Which existing keys change meaning

| Key | Before | After |
|---|---|---|
| `c` | Cycles `state.contacts` from the head, globally bound (`tui-shell.ts:222-225`) — on a fresh session `state.contacts` is empty, so an operator with a full store of pinned contacts has no working key sequence to reach one (the measured defect this whole design answers). | **Retired.** `j`/`k` + `Enter` on the contacts pane replace it; the footer's `[c] contact` label (rank 9, `shell-chrome.ts:92`) is removed, freeing one rank. |
| `i` | Global: imports `profile.contactCardPath`, the one card named at launch, from any pane (`tui-shell.ts:178-183`). | **Pane-scoped.** Bound on the contacts pane only, and only while a **candidate** row is highlighted; it imports that candidate's path. With `--card` made repeatable (§2.10) the global form stops meaning anything (there is no longer one card), so this narrowing is required, not optional. |
| `return` (`Enter`) | Bound on the profiles pane only, starts the next setup step (`tui-shell.ts:208-221`). | **Unchanged on the profiles pane.** Gains a second meaning on the contacts pane: open the highlighted pinned/observed row's conversation (§2.5). `paneKeyIntent`'s `"return"` case branches on `state.pane`, same shape it already has for the profiles-only check. |
| `j`, `k` | Unbound. | Move the contacts-pane cursor (§2.9). Bound nowhere else. |
| `n` | Unbound (the field it opens already exists, §1.7). | Opens `contact-name` for the highlighted row, contacts pane only. |

Not changed: `1`–`5`/`1`–`6` (pane ordinals, §3–§4), `p d r h t w q ? return` on the profiles/history
panes, and every trust-modal and compose-row binding.

### 2.9 The mechanism, concretely

```ts
// state.ts — additive
export interface OperatorState {
  // …unchanged fields…
  /** `doctor`'s own array, folded verbatim (minus filtering — see below). Authoritative. */
  readonly pinnedContacts: readonly ContactIdentifiers[];
  /** Cursor over the CONTACTS PANE's merged, displayed list. Clamped at render and on every move. */
  readonly contactsCursor: number;
}

// ProfileView — repeatable cards, replacing the singular `contactCardPath`
interface ContactCandidate {
  readonly path: string;
  readonly name?: string;          // from `--name`, local only
  readonly identifiers?: TrustIdentifiers;   // absent when the file did not parse
  readonly createdAtMs?: number;
  readonly expiresAtMs?: number;
  readonly readable: boolean;
}
interface ProfileView {
  // …unchanged fields, `contactCardPath` REMOVED…
  readonly contactCandidates: readonly ContactCandidate[];
}
```

`applyOutcome`'s `"init" | "doctor"` case gains one line, narrowed the same way
`readRejections`/`readHistoryEntries` already narrow an untrusted child's JSON — by name, never by
spread, each of the four fields run through `paintable` (`tui-shell.ts:471-473`) at the boundary,
exactly where every other inbound string already is:

```ts
pinnedContacts: Array.isArray(data.contacts) ? data.contacts.flatMap(readContactIdentifiers) : next.pinnedContacts,
```

`buildContactsSnapshot({ pinned: state.pinnedContacts, observed: state.contacts, candidates:
profile.contactCandidates, selected: state.contactsCursor, nowMs: state.observedAtMs })` is a new pure
function beside `buildProfilesSnapshot`/`buildMailboxSnapshot`, in a new `contacts-pane.ts`, doing the
merge in §2.1 and nothing else; `formatContactsLines(snapshot, width, limit)` lays it out through
`fitPane` exactly as §2.2–§2.6 describe. Both are value functions: every assertion about this pane is
a value comparison, the same discipline every existing pane test already uses.

### 2.10 The one CLI-adjacent prerequisite this needs, and its size

Repeatable `--card <path> [--name <label>]` per profile, in `main.ts`'s composition root only — no
relay change, no wire change, no protocol schema change, and no change to any of the eight frozen
commands. `parseOptions` (`main.ts:88-137`) already assigns to `profiles.at(-1)`; the change is
`patched.contactCandidates = [...(current.contactCandidates ?? []), { path, name }]` instead of an
overwrite, plus a `readFileSync` + `JSON.parse` + `cardSchema`-shaped light validation (identical in
spirit to `readIdentifiers`'s own stderr-parsing pattern, `main.ts:160-180`, just reading a file
instead of a pipe) to fill in `identifiers`/`createdAtMs`/`expiresAtMs`/`readable`. This is read-only,
touches no store, needs no key, and runs once at startup — the same moment `withStoreKeyPresence`
already runs (`main.ts:152-157`). Call it **P-4**, in the numbering flow 003's own prerequisites used
(P-1 stdin body, P-2 doctor's contacts, P-3 the shared relay-URL predicate — all three already
shipped on this tree, §1.1/§1.8). Sized honestly: it is the smallest of the four, and it is the one
piece of this design that touches a file outside `src/tui`.

---

## 3. Branch A — the two panes are removed

| Ordinal | Pane | Contents |
|---|---|---|
| 1 | `profiles` | unchanged: detail rows or the setup checklist |
| 2 | `contacts` | this design, in full |
| 3 | `chat` (was `history`) | unchanged rendering; `w`/`h` keys unchanged in meaning |
| 4 | `mailbox` | unchanged, already carries the rejection list in its tail (§1.3) |
| 5 | `activity`\* | *optional, not required by this design — see note* |

\* flow 003's design proposed a fifth pane surfacing `state.activity` as a scrollable list; today it
is a chrome line (`activityLine`, `shell-chrome.ts:196-200`), not a pane, and nothing in this design
or in T5–T17's implementation needs it to become one. If the operator answers "remove `health` and
`rejections`" without also wanting a new `activity` pane, ordinal 5 is simply free — reserved, not
spent. The header measurement below assumes it is spent, which is the more expensive of the two
readings and therefore the honest one to measure.

**Header, measured** (`echolet operator · <label> ·` + five tabs, `profiles/contacts/chat/mailbox
/activity`):

| Label | Full width | Overflow past 72 |
|---|---|---|
| `""` (empty) | 76 | **4** |
| `"a"` | 77 | 5 |
| `"alice"` | 81 | **9** |
| `"bob-tailscale-01"` | 92 | 20 |

Still over budget at every label length, including empty — the five-pane header was already
over budget before this design (§1.4, 7 columns short with today's five panes and an empty label);
shortening `history`→`chat` and adding `contacts` costs 2 more columns than it saves. **This is not
solved by pane count alone**; §5's shared mitigation (a rank-based header, mirroring `fitFooter`) is
still needed under Branch A. What Branch A buys is that the gap closing needs is small — 4 to 9
columns for a plausible label, not 19 to 35 — and the cheapest single mitigation (drop `echolet `
from the prefix, 8 columns) already covers the empty-label and one-character cases outright and
brings the five-character case to 1 column over, which the digit-only-when-inactive fallback (§5)
closes with room to spare.

**Cost, honestly:** two panes disappear and `c` is retired (§2.8). Muscle memory built on today's
five ordinals breaks — `4` used to be `rejections`, now it is `mailbox`; `5` used to be `health`, now
it is (at most) `activity`. Nothing is lost in substance: `health`'s line and `rejections`'s list keep
the exact renderers they have today, folded into panes that already carry them (§1.3).

---

## 4. Branch B — nothing is removed

| Ordinal | Pane | Contents |
|---|---|---|
| 1 | `profiles` | unchanged |
| 2 | `contacts` | this design, in full |
| 3 | `mailbox` | unchanged |
| 4 | `history` | unchanged |
| 5 | `rejections` | unchanged |
| 6 | `health` | unchanged |

**Header, measured** (`echolet operator · <label> ·` + six tabs):

| Label | Full width | Overflow past 72 | What plain `fitLine` drops |
|---|---|---|---|
| `""` (empty) | 91 | **19** | tabs 5 and 6 (`rejections`, `health`) entirely, tab 4 partly |
| `"alice"` (5 chars) | 96 | **24** | tabs 5 and 6 entirely, whole |
| `"bob-tailscale-01"` (16 chars) | 107 | **35** | tabs 4, 5 and 6 |

At **every** label length, including empty, two whole pane tabs vanish from the header with no
indication that a sixth pane exists at all — not even the bare digit, because `fitLine` clips the
finished string and does not know a tab boundary from a label boundary. An operator who has not
memorized that `6` is `health` cannot discover it from the screen.

**Mitigations considered, each measured, at label `"alice"`:**

| Mitigation | Resulting width | Fits 72? | What it costs |
|---|---|---|---|
| (baseline) `echolet operator · ` prefix, full pane names | 96 | no | — |
| drop `echolet ` from the prefix | 88 | no | 8 columns, not enough alone |
| drop `echolet` and `operator`, bare `· ` separator | 79 | no | still 7 over |
| + 4-letter abbreviated pane names (`prof cnct mail hist reje heal`) | 66 | **yes**, 6 to spare | pane names become guessable rather than readable, and the margin is only 6 columns — a label past roughly 11 characters (`bob-tailscale-01` is 16) overflows again; profile labels are operator-chosen free text with **no length bound** anywhere in `main.ts`, so this is not robust, only usually sufficient |
| + digits-only for every pane but the active one (`operator · alice · [2 contacts] 1 3 4 5 6`) | 45 | **yes**, 27 to spare | robust to any label up to ~27 characters, but every pane's **name** disappears from the header except the one the operator is already on — the header stops being a navigational aid for the other five panes, which is exactly what a sixth named pane was supposed to give them |

**The conclusion, stated plainly:** six full pane names cannot be shown in the header at
`MIN_VIEWPORT` (72 columns) for any profile label longer than a handful of characters, and the one
mitigation robust enough to guarantee it at any label length — digits-only for inactive tabs — gives
up per-pane labels for five of the six panes, which is the specific thing keeping all six panes was
for. This is a real, load-bearing cost, not a preference: the header's fixed three-row chrome budget
(`HEAD_ROWS = 3`, `shell-chrome.ts:60`) and `MIN_VIEWPORT.cols = 72`
(chosen so `UNAUDITED_NOTICE` itself fits unclipped, `shell-chrome.ts:30-38`) are both acceptance
criteria this design does not touch, so the header's width is not a free variable — it is exactly 72
columns at the floor this console is required to support. Branch B is tenable as "the console still
functions" — every key still works, `?` still names every binding — and untenable as "an operator can
read, at a glance, in the narrowest supported terminal, which of six panes they are looking at and
what the other five are called." Which of those two readings of "tenable" the operator wants is
exactly the question this design cannot answer for them.

**Cost, honestly:** the two panes are kept, `c`'s retirement (§2.8) still costs a key, and the header
is measurably worse than either Branch A or today at every label length. Nothing else about this
design changes under Branch B — the contacts pane's contract (§2) is identical either way.

---

## 5. What this must not cost, re-proved

Every item names a hard constraint from the dispatch, and what in this design keeps it true.

- **`renderFrame` stays pure, total, deterministic, escape-free, exactly rows by cols.** The contacts
  pane is a `build…Snapshot` + `format…Lines` pair like every existing pane — no new reader of a
  clock (`nowMs` is `state.observedAtMs`, already folded in outside the pure layer, §2.3) and no new
  escape byte: `formatContactsLines` returns plain text through `fitPane`/`clipLine`, the same
  primitives every pane already uses.
- **No key material in any frame or child argv.** A card candidate's identifiers are read from the
  same six public fields `contact import` already prints on stderr (§1.6); nothing under
  `signal_bundle`'s private half, and nothing of the file's raw text, ever reaches `ContactCandidate`.
  `buildArgv`'s `contact import` case (`cli-bridge.ts:86-90`) is unchanged — it still takes one
  `--from <path>`, now the highlighted candidate's path rather than the one path a profile used to
  carry.
- **The unaudited-prototype notice on every frame.** Row 0, chrome, untouched by a pane body change.
- **One command in flight at a time.** Selecting a candidate and pressing `i` still emits exactly one
  `run` intent through the existing D-1 gate (`tui-shell.ts:137`); nothing about navigating the list
  (`j`/`k`) or opening a conversation (`Enter`) spawns a child at all — those are `select-*` intents,
  already effect-free (`tui-shell.ts:303-312`).
- **The trust modal's single door.** The contacts pane has no `y`/`n` binding and offers no
  confirmation of its own — `i` starts the same `contact import` handshake that already opens the
  modal from the child's own printed identifiers (`main.ts:216-225`), never from what this pane
  parsed. If a candidate's file changed between listing and import, the modal still shows what the
  child is asking about, not this pane's older parse — the same principle §2.3 of flow 003 already
  states and this design does not weaken.
- **Control and display-steering characters filtered out of everything arriving from outside the
  process.** A card is written by a stranger. Every string this design reads from one —
  `identity_id`, `device_id`, `device_pubkey`, `signal_identity_key`, and a `--name` typed by the
  operator through the existing `contact-name` input field — passes through `paintable`
  (`tui-shell.ts:471-473`) at the point it enters state, the same predicate and the same boundary
  every other inbound string already goes through, not a new one written for this pane.

---

## 6. The tests, in the order they would be written

**Pure** — value comparisons over a pane builder, `mapKey`/`reduce`, no process, no terminal, no
store, no relay. **Driven** — a real child process or the real console binary.

| # | Test | Layer | What it pins |
|---|---|---|---|
| U-1 | `contacts-pane.merge.test.ts` | pure | The three-provenance merge by `identity_id`: pinned always wins the mark over an observed duplicate; a candidate never counts as pinned even if its identifiers happen to match one; sort order is pinned-first-in-doctor-order, then candidates in launch order. |
| U-2 | `contacts-pane.expiry.test.ts` | pure | A candidate at or past `expires_at_ms` (relative to `state.observedAtMs`, never a clock read inside the function) is marked `✗`; one strictly before it is `○`; an unreadable file is marked `?` and named by path, never dropped. |
| U-3 | `contacts-pane.identifiers.test.ts` | pure | The four identifiers render in full, one `field: value` line each, for the selected row, at 72, 80 and 120 columns; never elided; absent for no selection. |
| U-4 | `contacts-pane.overflow.test.ts` | pure | More rows than fit: the marker names the hidden count; the head (pinned rows) survives before the tail; the cursor can move to a hidden row and the visible window follows it. |
| U-5 | `tui-shell.contactsCursor.test.ts` | pure | `j`/`k` move and clamp the cursor against the CURRENT merged list length; `Enter` on a pinned/observed row emits `select-contact` and switches pane; `Enter` on a candidate emits nothing; `i` is bound only while a candidate is highlighted. |
| U-6 | `tui-shell.pinnedFold.test.ts` | pure | `applyOutcome`'s `doctor`/`init` case folds `data.contacts` into `state.pinnedContacts`, filtered through `paintable` field by field; a malformed entry (missing a field, wrong type) is dropped rather than crashing the fold; `contact_count` and `pinnedContacts.length` are asserted never to be read as if they must agree — the array is now the authority, not a count to reconcile. |
| U-7 | `tui-shell.cKeyRetired.test.ts` | pure | `c` maps to `undefined` everywhere; the footer never advertises `[c] contact`; the help list (`?`) names `j`/`k`/`n` on the contacts pane instead. |
| U-8 | `shell-chrome.header.test.ts` | pure | Whichever header mitigation (§5's shared prerequisite) ships: the active pane's tab is never elided; at `MIN_VIEWPORT` with a representative label, the chosen mitigation keeps the header within 72 columns; the frame stays exactly rows-by-cols and escape-free with the new pane selected. |
| U-9 | `tui.keyMaterial.test.ts` *(extended)* | pure | The exhaustive sweep (`tui-shell.ts` §doc) covers the `contacts` pane and `ProfileView.contactCandidates`; a real 32-byte store key in the environment reaches no frame and no argv through any new field; `PRIVATE_KEY_MARKERS` never matches a rendered candidate detail. |
| D-1 | `main.repeatableCard.processDriven.test.ts` | driven (real console binary) | Two `--card`/`--name` pairs on one profile produce two candidates at startup, both listed, neither imported; a card whose `expires_at_ms` is in the past is marked expired without spawning a child; `i` on the highlighted candidate spawns exactly one `contact import --from <that candidate's path>` and no other candidate's path appears in its argv. |
| D-2 | `main.doctorContactsFold.processDriven.test.ts` | driven (real console + real profile with pinned contacts from a prior session) | Starting the console against a profile that already has pinned contacts in its store shows them on the contacts pane after the startup `doctor` (`askWhatIsThere`, `tui-shell.ts:926-936`) resolves, with **no operator keystroke** — this is the fix for the measured defect (flow 003 T2 §1.3, "Run E") that motivated this whole design. |

U-1 through U-7 are the pane's own value contract and can be written and made red before P-4 (§2.10)
exists, against a hand-built `ProfileView.contactCandidates` fixture. U-8 is the header mitigation,
shared with whichever branch ships. D-1 is the red test *for* P-4. D-2 is the test that proves the
point of the whole design: an address book that is not empty on a fresh session.

---

## 7. Open questions, and the evidence that would settle each

**Q1 — Branch A or Branch B.** Not mine to decide, and the dispatch says so explicitly. §3 and §4 are
each buildable as written the moment the operator answers. *Evidence already gathered:* the measured
header cost (§4) and the measured muscle-memory cost of retiring two ordinals (§3) are both in this
document; nothing further needs reading to decide between them.

**Q2 — Does `ProfileView.contactCardPath` (singular) have any other reader that P-4 would break?**
*Evidence that settles it:* an enumeration of every reference to `contactCardPath` in `src/tui`. I
found two: `paneKeyIntent`'s `i` case (`tui-shell.ts:181-183`, replaced by the pane-scoped form in
§2.8) and `initialBuffer`'s `"card-path"` default (`tui-shell.ts:294-295`, which pre-fills the
manual-import input row from it — this default would need to read the highlighted candidate's path
instead, or fall back to empty when the contacts pane is not the active one). A full-repository
search (not run here, to keep this design read-only) would confirm nothing outside `src/tui`
references the field.

**Q3 — Should a candidate's local `--name` collide-check against an already-pinned contact's local
name?** Two candidates, or a candidate and a pinned contact, could be given the same local label by
two different `--name` flags or two `n` keystrokes, and nothing here disambiguates them beyond the
identity id shown alongside. *Evidence that would settle it:* whether the operator's own launcher
scripts (`~/.echolet/peer` and similar, per flow 003 §8 Q4) ever run two profiles with contacts that
share a chosen label — outside this repository, so unreadable here. My recommendation: no collision
check. The identity id is always shown beside the name (§2.2), so a duplicate label is visible and
resolvable by the operator, and refusing a name because another row already has it would be a rule
about local, session-only text carrying more authority than the encrypted store carries about trust.

**Q4 — Does the contacts pane need its own `MIN_VIEWPORT`-style floor, narrower or wider than 72×16?**
§2.4 shows the identifiers fit at 72 columns with 5–6 body rows to spare for the list. *Evidence that
would settle it beyond the arithmetic already shown:* none needed — the arithmetic is exact and the
frame's row/column budget is fixed by existing acceptance criteria this design does not reopen.

**Q5 — Is `activity` (Branch A, ordinal 5) in scope for this dispatch at all?** §3 measures it as
spent because that is the more expensive reading, but nothing here requires building it. *Evidence
that would settle it:* the operator's answer to Q1, and, separately, whether `state.activity`'s
existing chrome-line rendering (`activityLine`, `shell-chrome.ts:196-200`) is judged sufficient on its
own. Recorded here so Branch A's header measurement is not mistaken for a commitment to build a
sixth thing.

---

## 8. What I recommend against

- **Reading the encrypted store from the console to build this pane directly.** It would need the
  32-byte key, which AC5 forbids outright; `doctor`'s `contacts` array exists precisely so the console
  never has to.
- **A `contact list` ninth command.** `doctor`'s additive field already gives the console everything
  a listing command would, without reopening the frozen eight-command surface.
- **Pre-filling the trust modal from a candidate's parsed identifiers.** The modal must show what the
  **child** is asking about; a candidate's older parse could disagree with the file's current bytes,
  and a modal seeded from the console's own read would be verifying the console's memory instead of
  the stranger's card.
- **A names file, or `display_name` on the wire.** §2.7; unchanged from flow 003's own reasoning and
  still correct against this tree.
- **Deciding Branch A vs. Branch B in this document.** That is the one thing the dispatch is explicit
  is not mine, or the reviewer's, to settle by writing a design confidently enough that it reads as
  already decided.

---

## 9. Routing audit

`graph_used: no` — not-relevant. The surface is one directory (`apps/cli/src/tui`) plus four runtime
files named by the dispatch and reachable from them by direct import; a graph query would have
returned the file list this design already had from reading `t35-console-client-design.md` and flow
004's own journal.
`wiki_used: yes` — `wiki/index.md` checked first; it holds generated draft pages and no architecture,
domain or decision page for this surface, consistent with flow 003 T35's own finding. Recorded as
consulted and empty rather than skipped.
`ctx_used: yes` — `keryx ctx run`, `keryx ctx read` and `keryx ctx rg` for every file, search and
long read in this design; the header-width arithmetic in §1.4/§3/§4 was computed with a standalone
Node script reproducing `headerLine`/`padOrClip` exactly as written in `shell-chrome.ts` and `text.ts`
— not a test run, not a build, a pure arithmetic check of already-committed functions.
`raw_rg_used: no` — every search went through `keryx ctx rg`.
`memory_used: no` — not-relevant for a design over current code; flow 003's own design note and flow
004's `flow.json`/`journal.md`/`description.md`/`acceptance-criteria.md` carried the history this task
needed.
`tests_run: none`, `build_run: none` — per the dispatch's absolute constraint. No source file and no
test file was changed.
