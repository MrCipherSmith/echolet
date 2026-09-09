import { describe, expect, it } from "vitest";
import { MIN_VIEWPORT, isBelowMinViewport, renderFrame } from "./shell-chrome";
import { PENDING_SETUP, type HistoryEntryView, type OperatorState, type ProfileView, type TrustModal, type Viewport } from "./state";
import { decodeKey, mapKey, reduce } from "./tui-shell";

/**
 * Flow 004, T30 — AC8's SECOND clause, written red.
 *
 * AC8: "Nothing the console can do denies the operator a way out: at any viewport, and in any state
 * including a command in flight and a modal open, the key that quits is either available or the
 * console says why it is not."
 *
 * `tui-shell.wayOut.test.ts` (004-T29) pins the first half — a way out EXISTS everywhere, Ctrl-C in
 * all 22 states at all 10 viewports, proven purely and driven — and says in as many words that it
 * deliberately does not pin the second half. 004-T29-verify then MEASURED the second half over all
 * 220 combinations and found: 140 name a live way out, 62 name none, and 18 NAME A DEAD ONE, with
 * the dead one being the only key named in 13 of those. This file is that measurement turned into a
 * property, and it is red today.
 *
 * ── THE PROPERTY ───────────────────────────────────────────────────────────────────────────────
 *
 * Two clauses, and each kills a different bad repair:
 *
 *   HONEST   Every key a frame names as a way out works in that state. A frame that says "press q
 *            to quit" while `q` is dead is the defect: the operator's evidence becomes "the console
 *            told me which key leaves, I pressed it three times, nothing happened", which reads as a
 *            hung program — and in the sharp case (a trust modal below MIN_VIEWPORT) the same frame
 *            also says a trust decision is waiting, so the console looks alive AND stuck.
 *
 *   NAMED    Every frame with room to name a way out names one that works. Without this clause the
 *            cheapest way to a green file is to delete the advice — a console that names nothing
 *            anywhere is honest and useless, and an operator who cannot find the exit is exactly
 *            what AC8 exists to prevent.
 *
 * The two together mean a repair to the sharp case alone does not turn this file green: the modal
 * frames at and above MIN_VIEWPORT name no way out at all (F-002), the key list names `q` where the
 * compose row or a modal owns the keyboard (F-005), and `overlayModal` truncates the key list's own
 * sentence so that only its dead half survives (F-003). All of those are the same clause of the same
 * criterion and all of them are covered here.
 *
 * ── WHAT THIS FILE DECIDED, AND WHAT IT REFUSED TO DECIDE FOR SOMEONE ELSE ──────────────────────
 *
 * 004-T29's Q-002 asks whether the trust modal's footer should name Ctrl-C, and warns that
 * `modal-host.test.ts:131` pins `TRUST_MODAL_FOOTER` to exactly `["y", "n", "esc"]`, so widening it
 * would be a decision rather than a repair. THAT PIN DOES NOT HAVE TO MOVE, and this file does not
 * touch it. `TRUST_MODAL_FOOTER` is the list of answers to the trust QUESTION, painted inside the
 * modal panel by `renderModal` (modal-host.ts:136). The frame's own last row is a different string
 * built by a different function — `shell-chrome.ts` `footerLine`, whose modal branch returns the
 * hard-coded `"[y] trust  [n] reject  [esc] cancel"` — and `overlayModal` never paints over the last
 * row (the panel is centred and capped at `MODAL_PANEL_MAX_HEIGHT`). So the way out can be named on
 * the frame footer, where a key belongs, without adding a fourth action to the panel that asks a
 * yes-or-no question. The objection recorded against naming it — "the modal is the one surface on
 * which a stray keystroke is dangerous" — does not reach Ctrl-C: it answers the trust question with
 * nothing at all. The child is left at its own `[y/N]` prompt and its default is no.
 *
 * ── WHAT WOULD MAKE IT GREEN ───────────────────────────────────────────────────────────────────
 *
 * One idea, applied in the three places that paint a key name: what a frame advertises is a function
 * of WHO OWNS THE KEYBOARD, which `mapKey` already decides in that order — modal, compose row,
 * panes. `tooSmallFrame` asks only `state.input !== undefined`; `footerLine`'s modal branch names no
 * key at all; `HELP_LINES` is a constant that cannot ask. This file asserts the property and not the
 * wording, so any of those three may be fixed in any way that keeps the frame's advice true.
 */

const CTRL_C = String.fromCharCode(3);
const ESC = String.fromCharCode(27);
const DEL = String.fromCharCode(127);

/** An instant, not a duration: the fixtures need a clock reading and must not read one. */
const OBSERVED_AT_MS = Date.UTC(2026, 8, 9);

/**
 * Every keystroke this console can receive as one chunk — the same alphabet the existence half
 * sweeps, for the same reason: "this key works" must be decided by running it, not by reading
 * `mapKey`.
 */
const ALPHABET: readonly string[] = [
  ...Array.from({ length: 26 }, (_unused, index) => String.fromCharCode(index + 1)),
  ESC,
  DEL,
  "\r",
  "\n",
  ...Array.from({ length: 95 }, (_unused, index) => String.fromCharCode(index + 32)),
];

/** Every key that, in this state, both means "quit" and produces the effect that ends the session. */
function liveQuitKeys(state: OperatorState): ReadonlySet<string> {
  return new Set(ALPHABET.filter((sequence) => {
    const intent = mapKey(decodeKey(sequence), state);
    if (intent?.kind !== "quit") return false;
    return reduce(state, intent).effects.some((effect) => effect.kind === "quit");
  }));
}

/*
 * ── READING A FRAME THE WAY AN OPERATOR READS IT ───────────────────────────────────────────────
 *
 * The frame is plain text, so what it "names" has to be recovered from the text rather than from the
 * renderer — which is the whole point: 004-T29's F-003 was found this way and could not have been
 * found by reading `shell-chrome.ts`, because it is produced by an overlay that has no idea what it
 * is covering.
 *
 * `quit` is the console's own word for leaving, in all three places it paints one: the footer
 * (`[q] quit`), the key list (`q          quit (ctrl-c also quits)`) and the degraded frame
 * ("resize, or press q to quit"). The vocabulary is one constant so that a rewording is a deliberate
 * edit here rather than an accident that empties the measurement — and a repair that renamed the act
 * without updating it would fail the NAMED clause rather than pass silently.
 *
 * `exit` is deliberately NOT in the vocabulary: the activity line paints `(exit 0)` on almost every
 * frame, and counting it would attribute a way out to whatever character happened to sit before a
 * command's exit code.
 */
const QUIT_WORD = /\bquits?\b/gi;

/**
 * A key token, in every shape this console paints one: `[q]`, `[ctrl-c]`, `[esc]`, a bare `ctrl-c`
 * in prose, and a bare single letter ("press q to quit", and the key list's own left column).
 */
const KEY_TOKEN = /\[([^\]]{1,10})\]|(?<![\w-])(ctrl[-+]c|\^c)(?![\w-])|(?<![\w-])([A-Za-z])(?![\w-])/gi;

const NAMED_KEY_SEQUENCES: Readonly<Record<string, string>> = {
  "ctrl-c": CTRL_C,
  "ctrl+c": CTRL_C,
  "^c": CTRL_C,
  esc: ESC,
  escape: ESC,
  enter: "\r",
  return: "\r",
  space: " ",
};

/**
 * The keystroke a printed token stands for, or `undefined` when the token names no single key.
 *
 * `[1-5]` and `[y/N]` name no one key and are not tokens: they must not absorb a nearby "quit" and
 * turn an unattributed advertisement into an attributed one.
 */
function keySequence(token: string): string | undefined {
  const text = token.trim();
  const named = NAMED_KEY_SEQUENCES[text.toLowerCase()];
  if (named !== undefined) return named;
  if ([...text].length !== 1) return undefined;
  // The English article, and the one bare letter that appears in ordinary prose. Excluded only in
  // its bare form: `[a]` would still be a key token, because brackets are how this console prints a
  // binding. No frame today names `a` as a way out either way.
  return text.toLowerCase() === "a" ? undefined : text;
}

interface KeyToken {
  readonly at: number;
  readonly sequence: string;
}

function keyTokens(line: string): readonly KeyToken[] {
  const tokens: KeyToken[] = [];
  for (const match of line.matchAll(KEY_TOKEN)) {
    const token = match[1] ?? match[2] ?? match[3] ?? "";
    const sequence = keySequence(token);
    if (sequence !== undefined) tokens.push({ at: match.index, sequence });
  }
  return tokens;
}

/**
 * One thing a frame says about leaving: the key it attributes the claim to, or `undefined` when it
 * mentions quitting and names no key at all.
 *
 * Attribution is to the nearest token that STARTS BEFORE the word, falling back to the nearest one
 * after it. Preceding wins because that is how every line here reads — `[q] quit`,
 * `q          quit (ctrl-c also quits)`, "press ctrl-c to quit" — and because nearest-by-distance
 * would read the second half of the key list's own sentence back over the first and acquit the dead
 * key it names.
 */
interface Advertisement {
  readonly sequence: string | undefined;
  readonly line: string;
}

function advertisedWaysOut(frame: readonly string[]): readonly Advertisement[] {
  const found: Advertisement[] = [];
  for (const line of frame) {
    const tokens = keyTokens(line);
    for (const word of line.matchAll(QUIT_WORD)) {
      const before = tokens.filter((token) => token.at < word.index).at(-1);
      const after = tokens.find((token) => token.at > word.index);
      found.push({ sequence: (before ?? after)?.sequence, line: line.trimEnd() });
    }
  }
  return found;
}

function printable(sequence: string | undefined): string {
  if (sequence === undefined) return "<no key named>";
  if (sequence === CTRL_C) return "ctrl-c";
  if (sequence === ESC) return "esc";
  return sequence;
}

/*
 * ── THE STATES AND THE TERMINALS ───────────────────────────────────────────────────────────────
 *
 * Grouped by `keyboardOwner`, because that is what decides the answer: `mapKey` hands the keyboard
 * to the modal first, the compose row second and the panes last, and `q` is a way out only under the
 * third. Everything else varies underneath — which pane, whether the key list is open, whether a
 * child is alive — so that a fix made under one branch cannot hide behind another.
 *
 * NO FIXTURE TEXT CONTAINS THE WORD THIS FILE SCANS FOR. An operator's own message body, a contact
 * card's label or a decrypted history entry can contain "quit", and a frame carrying one is
 * indistinguishable from a frame advertising one — the scanner reads the screen exactly as a human
 * does. That ambiguity belongs to the console and not to this measurement, so the fixtures keep the
 * word out of operator-supplied text rather than teaching the scanner where each line came from.
 */

function profile(overrides: Partial<ProfileView> = {}): ProfileView {
  return {
    label: "alice",
    profileDir: "/tmp/echolet-named-way-out/alice",
    relayUrl: "http://127.0.0.1:18099",
    storeKeyEnv: "ECHOLET_NAMED_WAY_OUT_KEY",
    identityId: "hbRYeNqVnWC74METcY57eDEkV9qNQ6Qzuz6RpsIYQA",
    deviceId: "733d80b0-e7e2-5e6c-ba84-0bcd96a373ea",
    contactCount: 1,
    published: true,
    state: "ready",
    storeKeyPresent: true,
    setup: ["ok", "ok", "ok", "ok", "ok", "ok"],
    contactCardPath: "/tmp/echolet-named-way-out/bob-card.json",
    ...overrides,
  };
}

const CONTACT = {
  identityId: "Kx8dq0vY2mN4pR7sT1uW3xZ5aB6cD8eF0gH2iJ4kL6M",
  deviceId: "0f3a1c72-4d5e-4a6b-8c9d-1e2f3a4b5c6d",
  devicePubkey: "AAAAB3NzaC1lZDI1NTE5AAAAIHqk4v2mN4pR7sT1uW3xZ5aB6cD8eF0gH2iJ4kL6",
  signalIdentityKey: "BbQ2wE4rT6yU8iO0pA1sD3fG5hJ7kL9zX2cV4bN6mQ8",
};

function history(count: number): HistoryEntryView[] {
  return Array.from({ length: count }, (_unused, index) => ({
    sequence: index + 1,
    contactIdentityId: CONTACT.identityId,
    messageId: `2f7c1b${String(index).padStart(2, "0")}-5428-4ae6-87da-bcdd8fb42ec5`,
    direction: index % 2 === 0 ? ("outbound" as const) : ("inbound" as const),
    // Long enough to spend continuation rows at MIN_VIEWPORT, which is the layout the conversation
    // pane acquired after this criterion was last swept.
    plaintext: `body ${String(index)} ${"x".repeat(140)}`,
    createdAtMs: OBSERVED_AT_MS + index,
  }));
}

function baseState(overrides: Partial<OperatorState> = {}): OperatorState {
  return {
    profiles: [profile()],
    activeProfile: 0,
    contacts: [CONTACT],
    selectedContactId: CONTACT.identityId,
    mailbox: { outboxPending: null, inboxReceived: 2, more: false, lastPolledAtMs: OBSERVED_AT_MS },
    rejections: [{ envelopeId: "8b1d0c44-1f2e-4a3b-9c8d-7e6f5a4b3c2d", code: "UNKNOWN_SENDER" }],
    history: history(4),
    health: { relayUrl: "http://127.0.0.1:18099", status: "healthy", uptimeMs: null, checkedAtMs: OBSERVED_AT_MS },
    pane: "profiles",
    modal: undefined,
    activity: [{ at: OBSERVED_AT_MS, text: "poll → ok (exit 0)" }],
    busy: false,
    observedAtMs: OBSERVED_AT_MS,
    ...overrides,
  };
}

const MODAL: TrustModal = {
  kind: "trust",
  cardPath: "/tmp/echolet-named-way-out/bob-card.json",
  profileLabel: "alice",
  identifiers: {
    identity_id: CONTACT.identityId,
    device_id: CONTACT.deviceId,
    device_pubkey: CONTACT.devicePubkey,
    signal_identity_key: CONTACT.signalIdentityKey,
  },
  renderedAt: OBSERVED_AT_MS,
};

const STATES: readonly { readonly name: string; readonly state: OperatorState }[] = [
  { name: "fresh start, nothing observed yet", state: baseState({ profiles: [profile({ state: "unknown", setup: PENDING_SETUP, published: false, contactCount: 0 })], contacts: [], selectedContactId: null, history: [], activity: [] }) },
  { name: "registration checklist, store key absent", state: baseState({ profiles: [profile({ state: "absent", setup: PENDING_SETUP, storeKeyPresent: false, published: false, contactCount: 0 })], contacts: [], selectedContactId: null, history: [] }) },
  { name: "profiles pane, registered", state: baseState({ pane: "profiles" }) },
  { name: "mailbox pane", state: baseState({ pane: "mailbox" }) },
  { name: "conversation pane, continuation rows", state: baseState({ pane: "history" }) },
  { name: "rejections pane", state: baseState({ pane: "rejections" }) },
  { name: "health pane", state: baseState({ pane: "health" }) },
  { name: "key list open", state: baseState({ help: true }) },
  { name: "command in flight", state: baseState({ busy: true }) },
  { name: "command in flight, key list open", state: baseState({ busy: true, help: true }) },
  { name: "compose row open, message", state: baseState({ pane: "history", input: { field: "message", buffer: "a half-written message", renderedAt: OBSERVED_AT_MS, maxBytes: 4096 } }) },
  { name: "compose row open, relay url (registration step 1)", state: baseState({ input: { field: "relay-url", buffer: "https://", renderedAt: OBSERVED_AT_MS, maxBytes: 1024 } }) },
  { name: "compose row open, key list open", state: baseState({ pane: "history", help: true, input: { field: "message", buffer: "a half-written message", renderedAt: OBSERVED_AT_MS, maxBytes: 4096 } }) },
  { name: "trust modal open, not yet painted", state: baseState({ busy: true, modal: { ...MODAL, renderedAt: null } }) },
  { name: "trust modal open, painted", state: baseState({ busy: true, modal: MODAL }) },
  { name: "trust modal open, one identifier missing", state: baseState({ busy: true, modal: { ...MODAL, identifiers: { ...MODAL.identifiers, device_pubkey: undefined } } }) },
  { name: "trust modal open, key list open", state: baseState({ busy: true, help: true, modal: MODAL }) },
];

/**
 * Ten terminals: three below `MIN_VIEWPORT` on both axes, one below on each axis alone — the
 * off-by-one boundary in both directions — and five ordinary ones up to a wide terminal.
 */
const VIEWPORTS: readonly Viewport[] = [
  { cols: 1, rows: 1 },
  { cols: 20, rows: 5 },
  { cols: 40, rows: 10 },
  { cols: 71, rows: 16 },
  { cols: 72, rows: 15 },
  { cols: MIN_VIEWPORT.cols, rows: MIN_VIEWPORT.rows },
  { cols: 80, rows: 24 },
  { cols: 96, rows: 28 },
  { cols: 120, rows: 40 },
  { cols: 200, rows: 60 },
];

/**
 * True when this frame has room to name a way out, so that the NAMED clause is an obligation the
 * console can actually meet rather than a demand for text that does not fit.
 *
 * At or above `MIN_VIEWPORT` the footer is always painted: `renderFrame` reserves `TAIL_ROWS` and
 * the modal panel is centred, so the last row is never overlaid. Below it, the witness is a DIFFERENT
 * sentence on the same degraded frame — "…this console needs 72x16" — which `tooSmallFrame` paints
 * immediately above the advice. A frame with room for that sentence has room for one more line, and
 * a frame too small to finish it (1x1, 20x5) is exempt, because a console cannot be asked to name a
 * key on a screen that cannot hold the words.
 *
 * The witness is deliberately not the advice itself: a repair that deleted the advice would then
 * exempt itself from the clause meant to forbid exactly that.
 */
const ROOM_WITNESS = `this console needs ${String(MIN_VIEWPORT.cols)}x${String(MIN_VIEWPORT.rows)}`;

function hasRoomToName(frame: readonly string[], viewport: Viewport): boolean {
  return !isBelowMinViewport(viewport) || frame.join("\n").includes(ROOM_WITNESS);
}

interface Reading {
  readonly at: string;
  readonly advertised: readonly Advertisement[];
  readonly live: ReadonlySet<string>;
  readonly obligated: boolean;
}

function sweep(): readonly Reading[] {
  const readings: Reading[] = [];
  for (const { name, state } of STATES) {
    const live = liveQuitKeys(state);
    for (const viewport of VIEWPORTS) {
      const frame = renderFrame(state, viewport);
      readings.push({
        at: `${name} at ${String(viewport.cols)}x${String(viewport.rows)}`,
        advertised: advertisedWaysOut(frame),
        live,
        obligated: hasRoomToName(frame, viewport),
      });
    }
  }
  return readings;
}

describe("AC8, second clause: the console names a way out, and the one it names works", () => {
  /*
   * ANTI-VACUITY, and it is the first test on purpose.
   *
   * Both clauses below are computed from `advertisedWaysOut`. A scanner that quietly found nothing
   * would make the HONEST clause vacuously green and would fail the NAMED clause everywhere, which
   * is a loud failure rather than a false pass — but a scanner that found the wrong KEY would be
   * quietly wrong in both directions, so the attribution is pinned against the exact shapes this
   * console paints before either clause is asserted.
   *
   * GREEN today, and it must stay green: it is a test of this file's own instrument.
   */
  it("reads, out of a painted line, which key that line offers as the way out", () => {
    const read = (line: string): readonly (string | undefined)[] =>
      advertisedWaysOut([line]).map((advertisement) => advertisement.sequence);

    // The footer, in both of the forms `footerLine` builds.
    expect(read("[1-5] pane  [p] poll  [?] help  [q] quit")).toEqual(["q"]);
    expect(read("[enter] send  [esc] cancel  [ctrl-c] quit")).toEqual([CTRL_C]);
    // The key list, whose one line names two keys and must be read as naming both.
    expect(read("  q          quit (ctrl-c also quits)")).toEqual(["q", CTRL_C]);
    // 004-T29 F-003: `overlayModal` painted a panel over the right-hand half of that same line. What
    // survives names the key that does not work and loses the one that does — which is only visible
    // to something that reads the frame rather than the renderer.
    expect(read("  q          quit (c")).toEqual(["q"]);
    // The degraded frame, in both of the forms `tooSmallFrame` builds.
    expect(read("resize, or press q to quit")).toEqual(["q"]);
    expect(read("resize, or press ctrl-c to quit")).toEqual([CTRL_C]);
    // A claim with no key attached is not a way out, and must not be read as one.
    expect(read("press the documented key to quit")).toEqual([undefined]);
    // And the lines that mention no way out at all contribute nothing — in particular the activity
    // line, whose `(exit 0)` must never be mistaken for an advertisement.
    expect(read("poll → ok (exit 0)")).toEqual([]);
    expect(read("  1-5        select pane")).toEqual([]);
    expect(read("[y] trust  [n] reject  [esc] cancel")).toEqual([]);

    // And against real frames, so that the instrument is known to fire on this console's own output
    // rather than only on strings written in this file.
    const readings = sweep();
    expect(readings.length, "the sweep is empty").toBe(STATES.length * VIEWPORTS.length);
    expect(
      readings.filter((reading) => reading.advertised.length > 0).length,
      "no painted frame named a way out at all — the scanner is blind, and both clauses below are meaningless",
    ).toBeGreaterThan(0);
  });

  /*
   * RED. 18 of 004-T29's 220 combinations name a key that does nothing; the sharp case is a trust
   * modal below `MIN_VIEWPORT`, where the degraded frame says "press q to quit" because
   * `tooSmallFrame` asks whether the COMPOSE ROW is open and never asks about the modal — and `q` is
   * dead whenever the modal owns the keyboard.
   */
  it("never names a key that does not quit in that state", () => {
    const lies = sweep().flatMap((reading) =>
      reading.advertised
        .filter((advertisement) => advertisement.sequence === undefined || !reading.live.has(advertisement.sequence))
        .map((advertisement) =>
          `${reading.at}: the frame offers ${printable(advertisement.sequence)}, which does not quit here `
          + `(live: ${[...reading.live].map(printable).join(", ")}) — ${JSON.stringify(advertisement.line)}`));

    expect(lies, `${String(lies.length)} frame(s) name a way out that does not work:\n${lies.join("\n")}`).toEqual([]);
  });

  /*
   * RED, and the clause that makes a deletion no repair. 62 of the 220 combinations name no way out
   * at all; the ones this clause reaches are the frames with room for one — every frame at or above
   * `MIN_VIEWPORT` with a trust modal open (F-002: the footer names y, n and esc, all three of which
   * answer the trust question and none of which leaves the console), and the degraded frames whose
   * advice line is painted.
   *
   * It is asserted separately from the clause above so that neither can be satisfied by weakening
   * the other: naming nothing fails here, and naming the wrong thing fails there.
   */
  it("names a working way out on every frame that has room for one", () => {
    const silences = sweep()
      .filter((reading) => reading.obligated)
      .filter((reading) => !reading.advertised.some((advertisement) =>
        advertisement.sequence !== undefined && reading.live.has(advertisement.sequence)))
      .map((reading) =>
        `${reading.at}: no working way out is named, and ${[...reading.live].map(printable).join(", ")} would have worked`
        + (reading.advertised.length === 0 ? "" : ` (it does name ${reading.advertised.map((advertisement) => printable(advertisement.sequence)).join(", ")})`));

    expect(silences, `${String(silences.length)} frame(s) leave the operator to guess:\n${silences.join("\n")}`).toEqual([]);
  });
});
