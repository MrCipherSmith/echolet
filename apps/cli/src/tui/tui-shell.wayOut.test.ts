import { describe, expect, it } from "vitest";
import type { CliOutcome } from "./cli-bridge";
import { MIN_VIEWPORT } from "./shell-chrome";
import { PENDING_SETUP, type HistoryEntryView, type OperatorState, type ProfileView, type TrustModal, type Viewport } from "./state";
import { decodeKey, mapKey, reduce, runTuiShell, type TuiIo } from "./tui-shell";

/**
 * Flow 004, T29 — AC8, re-measured over the states the console has TODAY.
 *
 * AC8: "Nothing the console can do denies the operator a way out: at any viewport, and in any state
 * including a command in flight and a modal open, the key that quits is either available or the
 * console says why it is not."
 *
 * It was last swept in flow 002/003, before the input mode, the registration checklist, the compose
 * row, the history pane's continuation layout and its withholding filter existed — 004-T18 said so
 * in as many words ("did not re-run a viewport sweep against a command in flight, so the 'at any
 * viewport, in any state' clause is carried forward from earlier flows rather than re-measured
 * here"), and 004-T24's wave report carried it forward as item 7 of what remains. The console has
 * since acquired states that sweep never saw. This file measures the criterion over the states that
 * exist now, and it does so twice over, because the two halves fail differently:
 *
 *   1. `mapKey`/`reduce` — WHICH keys quit, per state. A pure enumeration over the console's whole
 *      input alphabet, so "some key quits" is a measurement rather than a spot check.
 *   2. `runTuiShell` — whether pressing that key actually ENDS the session, driven through the real
 *      loop with an injected terminal, at ten viewports including two that are below the minimum on
 *      one axis each and one that is below it on both. A shell that accepted the intent and kept
 *      running would satisfy (1) and still trap the operator.
 *
 * ── WHAT THIS FILE PINS, AND WHAT IT DELIBERATELY DOES NOT ─────────────────────────────────────
 *
 * It pins that a way out EXISTS in every state at every viewport. It does not pin that the frame
 * NAMES it: with a modal open `q` is dead (`mapKey`'s modal branch binds only Ctrl-C, y, n and Esc)
 * and no frame carrying a modal says so — below `MIN_VIEWPORT` the degraded frame goes further and
 * offers `q` by name (`shell-chrome.ts` `tooSmallFrame`, whose `composing` branch asks about the
 * compose row and not about the modal). That is recorded as a finding in 004-T29-verify-result.json
 * rather than asserted here in either direction: asserting the current text would enshrine it, and
 * asserting the corrected text would land a red test with no implementer behind it.
 */

const CTRL_C = String.fromCharCode(3);
const ESC = String.fromCharCode(27);
const DEL = String.fromCharCode(127);
const ANSI = new RegExp(`${ESC}\\[[0-9;?]*[A-Za-z]`, "g");

/**
 * Every keystroke this console can receive as one chunk: the 26 control keys, Escape, Backspace,
 * both newline forms, and all 95 printable ASCII characters.
 *
 * Enumerated rather than sampled, because the claim is "there is a way out", and a claim about the
 * existence of a key is only as good as the set it was searched over.
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
function quitKeys(state: OperatorState): string[] {
  return ALPHABET.filter((sequence) => {
    const intent = mapKey(decodeKey(sequence), state);
    if (intent?.kind !== "quit") return false;
    return reduce(state, intent).effects.some((effect) => effect.kind === "quit");
  });
}

function profile(overrides: Partial<ProfileView> = {}): ProfileView {
  return {
    label: "alice",
    profileDir: "/tmp/echolet-wayout/alice",
    relayUrl: "http://127.0.0.1:18099",
    storeKeyEnv: "ECHOLET_WAYOUT_KEY",
    identityId: "hbRYeNqVnWC74METcY57eDEkV9qNQ6Qzuz6RpsIYQA",
    deviceId: "733d80b0-e7e2-5e6c-ba84-0bcd96a373ea",
    contactCount: 1,
    published: true,
    state: "ready",
    storeKeyPresent: true,
    setup: ["ok", "ok", "ok", "ok", "ok", "ok"],
    contactCardPath: "/tmp/echolet-wayout/bob-card.json",
    ...overrides,
  };
}

const CONTACT = {
  identityId: "Kx8dq0vY2mN4pR7sT1uW3xZ5aB6cD8eF0gH2iJ4kL6M",
  deviceId: "0f3a1c72-4d5e-4a6b-8c9d-1e2f3a4b5c6d",
  devicePubkey: "AAAAB3NzaC1lZDI1NTE5AAAAIHqk4v2mN4pR7sT1uW3xZ5aB6cD8eF0gH2iJ4kL6",
  signalIdentityKey: "BbQ2wE4rT6yU8iO0pA1sD3fG5hJ7kL9zX2cV4bN6mQ8",
};

function history(count: number, contactIdentityId: string): HistoryEntryView[] {
  return Array.from({ length: count }, (_unused, index) => ({
    sequence: index + 1,
    contactIdentityId,
    messageId: `2f7c1b${String(index).padStart(2, "0")}-5428-4ae6-87da-bcdd8fb42ec5`,
    direction: index % 2 === 0 ? ("outbound" as const) : ("inbound" as const),
    // Long enough to spend more than one continuation row at MIN_VIEWPORT, which is the layout the
    // history pane acquired after this criterion was last swept.
    plaintext: `body ${String(index)} ${"x".repeat(140)}`,
    createdAtMs: 1_757_000_000_000 + index,
  }));
}

function baseState(overrides: Partial<OperatorState> = {}): OperatorState {
  return {
    profiles: [profile()],
    activeProfile: 0,
    contacts: [CONTACT],
    selectedContactId: CONTACT.identityId,
    mailbox: { outboxPending: null, inboxReceived: 2, more: false, lastPolledAtMs: 1_757_000_000_000 },
    rejections: [{ envelopeId: "8b1d0c44-1f2e-4a3b-9c8d-7e6f5a4b3c2d", code: "UNKNOWN_SENDER" }],
    history: history(4, CONTACT.identityId),
    health: { relayUrl: "http://127.0.0.1:18099", status: "healthy", uptimeMs: null, checkedAtMs: 1_757_000_000_000 },
    pane: "profiles",
    modal: undefined,
    activity: [{ at: 1_757_000_000_000, text: "poll → ok (exit 0)" }],
    busy: false,
    observedAtMs: 1_757_000_000_000,
    ...overrides,
  };
}

const MODAL: TrustModal = {
  kind: "trust",
  cardPath: "/tmp/echolet-wayout/bob-card.json",
  profileLabel: "alice",
  identifiers: {
    identity_id: CONTACT.identityId,
    device_id: CONTACT.deviceId,
    device_pubkey: CONTACT.devicePubkey,
    signal_identity_key: CONTACT.signalIdentityKey,
  },
  renderedAt: null,
};

/**
 * The states the console can be in today, each named for the surface that produced it.
 *
 * `keyboardOwner` is what decides the answer, and it is the reason the list is grouped this way:
 * `mapKey` hands the keyboard to the modal first, to the compose row second, and to the panes last.
 * Everything else here — which pane, whether the key list is open, whether a checklist is showing,
 * how many rows the conversation spends — varies underneath those three branches, and this list
 * crosses them so that a binding added under one branch cannot hide behind another.
 */
const STATES: readonly { readonly name: string; readonly keyboardOwner: "panes" | "compose" | "modal"; readonly state: OperatorState }[] = [
  { name: "fresh start, nothing observed yet", keyboardOwner: "panes", state: baseState({ profiles: [profile({ state: "unknown", setup: PENDING_SETUP, published: false, contactCount: 0 })], contacts: [], selectedContactId: null, history: [], activity: [] }) },
  { name: "registration checklist, store key absent", keyboardOwner: "panes", state: baseState({ profiles: [profile({ state: "absent", setup: PENDING_SETUP, storeKeyPresent: false, published: false, contactCount: 0 })], contacts: [], selectedContactId: null, history: [] }) },
  { name: "registration checklist, half done, one step failed", keyboardOwner: "panes", state: baseState({ profiles: [profile({ state: "ready", setup: ["ok", "ok", { failed: "RELAY_UNAVAILABLE", exitCode: 4 }, "pending", "pending", "pending"], published: false })] }) },
  { name: "profiles pane, registered", keyboardOwner: "panes", state: baseState({ pane: "profiles" }) },
  { name: "mailbox pane", keyboardOwner: "panes", state: baseState({ pane: "mailbox" }) },
  { name: "conversation pane, continuation rows", keyboardOwner: "panes", state: baseState({ pane: "history" }) },
  { name: "conversation pane, entries withheld by the filter", keyboardOwner: "panes", state: baseState({ pane: "history", history: [...history(2, CONTACT.identityId), ...history(3, "someone-else")] }) },
  { name: "conversation pane, no contact selected", keyboardOwner: "panes", state: baseState({ pane: "history", selectedContactId: null }) },
  { name: "rejections pane", keyboardOwner: "panes", state: baseState({ pane: "rejections" }) },
  { name: "health pane", keyboardOwner: "panes", state: baseState({ pane: "health" }) },
  { name: "key list open", keyboardOwner: "panes", state: baseState({ help: true }) },
  { name: "command in flight", keyboardOwner: "panes", state: baseState({ busy: true }) },
  { name: "command in flight, key list open", keyboardOwner: "panes", state: baseState({ busy: true, help: true }) },
  { name: "compose row open, message", keyboardOwner: "compose", state: baseState({ pane: "history", input: { field: "message", buffer: "a half-written message", renderedAt: 1_757_000_000_000, maxBytes: 4096 } }) },
  { name: "compose row open, unpainted", keyboardOwner: "compose", state: baseState({ pane: "history", input: { field: "message", buffer: "", renderedAt: null, maxBytes: 4096 } }) },
  { name: "compose row open, relay url (registration step 1)", keyboardOwner: "compose", state: baseState({ input: { field: "relay-url", buffer: "https://", renderedAt: 1_757_000_000_000, maxBytes: 1024 } }) },
  { name: "compose row open, card path (registration step 4)", keyboardOwner: "compose", state: baseState({ input: { field: "card-path", buffer: "/tmp/echolet-wayout/bob-card.json", renderedAt: 1_757_000_000_000, maxBytes: 1024 } }) },
  { name: "compose row open, key list open", keyboardOwner: "compose", state: baseState({ pane: "history", help: true, input: { field: "message", buffer: "quit", renderedAt: 1_757_000_000_000, maxBytes: 4096 } }) },
  { name: "trust modal open, not yet painted", keyboardOwner: "modal", state: baseState({ busy: true, modal: MODAL }) },
  { name: "trust modal open, painted", keyboardOwner: "modal", state: baseState({ busy: true, modal: { ...MODAL, renderedAt: 1_757_000_000_000 } }) },
  { name: "trust modal open, one identifier missing", keyboardOwner: "modal", state: baseState({ busy: true, modal: { ...MODAL, identifiers: { ...MODAL.identifiers, device_pubkey: undefined }, renderedAt: 1_757_000_000_000 } }) },
  { name: "trust modal open, key list open", keyboardOwner: "modal", state: baseState({ busy: true, help: true, modal: { ...MODAL, renderedAt: 1_757_000_000_000 } }) },
];

/**
 * Ten terminals. Three are below `MIN_VIEWPORT` on both axes, two on exactly one axis each — the
 * off-by-one boundary in both directions — and the rest are ordinary terminals up to a wide one.
 * 1x1 is included because `renderFrame` clamps to at least one row and one column, and a criterion
 * about "any viewport" that skipped the degenerate one would be a criterion about the usual ones.
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
 * Drives the real shell at one viewport, in one state, and presses one key.
 *
 * `runCli` never settles, so a state that starts a command stays in flight for the whole run: the
 * "command in flight" case is a command that is genuinely still running when the key is pressed,
 * not a `busy` flag set by hand. The returned promise is the shell's own — it resolves only when
 * the shell decides the session is over, which is the fact this file is measuring.
 */
function drive(state: OperatorState, viewport: Viewport, key: string): { readonly finished: Promise<number>; readonly frames: () => string[][] } {
  const writes: string[] = [];
  let emit: ((chunk: Buffer) => void) | undefined;
  let raw: boolean | undefined;
  const io: TuiIo = {
    stdout: { write: (chunk: string) => { writes.push(chunk); return true; }, columns: viewport.cols, rows: viewport.rows },
    stdin: {
      setRawMode: (mode: boolean) => { raw = mode; return undefined; },
      on: (event: string, handler: (chunk: Buffer) => void) => { if (event === "data") emit = handler; return undefined; },
      resume: () => undefined,
      pause: () => undefined,
    },
    now: () => 1_757_000_000_000,
    // Never settles: whatever this state has in flight is still in flight when the key arrives.
    runCli: () => new Promise<CliOutcome>(() => undefined),
    answerTrustPrompt: () => undefined,
  };

  const finished = runTuiShell(io, state).then((code) => {
    // Leaving means giving the terminal back: raw mode off, and the alternate screen exited.
    expect(raw).toBe(false);
    expect(writes.join("")).toContain(`${ESC}[?1049l`);
    return code;
  });
  emit?.(Buffer.from(key, "utf8"));
  return {
    finished,
    frames: () => writes.map((chunk) => chunk.replace(ANSI, "")).filter((chunk) => chunk.length > 0).map((chunk) => chunk.split("\r\n")),
  };
}

describe("AC8: the operator always has a way out, over the states this console has today", () => {
  it("binds a quitting key in every state, and names exactly which keys those are", () => {
    for (const { name, keyboardOwner, state } of STATES) {
      const keys = quitKeys(state);
      // The criterion itself: something quits. Asserted first and on its own, so a change to the
      // exact set below never silently weakens this into "the set is what it is".
      expect(keys.length, `${name}: no key quits`).toBeGreaterThan(0);
      expect(keys, `${name}: Ctrl-C must quit`).toContain(CTRL_C);

      /*
       * And exactly which keys, which is where the criterion's second clause lives.
       *
       * While the modal or the compose row owns the keyboard, `q` is NOT a way out: the modal binds
       * y/n/esc and Ctrl-C only, and inside the compose row `q` is text — an operator typing the
       * word "quit" into a message must not quit. Both are deliberate and are argued at
       * `tui-shell.ts` `mapKey`. Pinned here as a measurement: whether the frames covering these
       * states SAY so is a separate question, and 004-T29 records where they do not.
       *
       * `Q` quits wherever `q` does, because `decodeKey` lower-cases the name — a way out that a
       * held shift key could defeat would not be one.
       */
      expect([...keys].sort(), `${name}: the quitting keys changed`).toEqual(
        keyboardOwner === "panes" ? [CTRL_C, "Q", "q"].sort() : [CTRL_C],
      );
    }
  });

  it("leaves, through the real shell, from every state at every viewport", async () => {
    for (const { name, keyboardOwner, state } of STATES) {
      for (const viewport of VIEWPORTS) {
        const at = `${name} at ${String(viewport.cols)}x${String(viewport.rows)}`;
        // The one key that is a way out in every state. A test that pressed `q` where `q` is bound
        // and Ctrl-C where it is not would be measuring its own choice of key.
        const session = drive(state, viewport, CTRL_C);
        expect(await session.finished, `${at}: the shell did not exit 0`).toBe(0);

        // It painted before it left, at the size it was given, and the frames it painted are the
        // shape the viewport asked for — so "it quit" is not "it never rendered this state".
        const frames = session.frames();
        expect(frames.length, `${at}: nothing was painted`).toBeGreaterThan(0);
        for (const lines of frames) {
          expect(lines.length, `${at}: wrong row count`).toBeLessThanOrEqual(viewport.rows);
          for (const line of lines) expect([...line].length, `${at}: wrong column count`).toBeLessThanOrEqual(viewport.cols);
        }
      }

      // And where `q` is a way out, it is one at every viewport too: the viewport is not an input to
      // `mapKey` at all, and this is what pins that it never becomes one.
      if (keyboardOwner !== "panes") continue;
      for (const viewport of VIEWPORTS) {
        expect(await drive(state, viewport, "q").finished, `${name} at ${String(viewport.cols)}x${String(viewport.rows)}: q did not quit`).toBe(0);
      }
    }
  }, 60_000);

  it("leaves while a command is genuinely still running", async () => {
    // `state: "unknown"` is what makes the shell run the startup `doctor` itself, and `runCli` in
    // `drive` never settles — so this child is still running when the key is pressed. The frame says
    // so before the key arrives, which is what makes "in flight" a measurement rather than a claim.
    const state = baseState({ profiles: [profile({ state: "unknown", setup: PENDING_SETUP, published: false, contactCount: 0 })], contacts: [], selectedContactId: null, history: [], activity: [] });
    for (const viewport of [VIEWPORTS[2]!, VIEWPORTS[5]!, VIEWPORTS[9]!]) {
      const session = drive(state, viewport, CTRL_C);
      expect(await session.finished).toBe(0);
      const painted = session.frames().flat().join("\n");
      if (viewport.cols >= MIN_VIEWPORT.cols) {
        expect(painted, `${String(viewport.cols)}x${String(viewport.rows)}: no command was in flight`).toContain("running…");
      }
    }
  }, 30_000);
});
