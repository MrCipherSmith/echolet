import { describe, expect, it } from "vitest";
import type { CliOutcome, CliRequest } from "./cli-bridge";
import { MIN_VIEWPORT, UNAUDITED_NOTICE, renderFrame } from "./shell-chrome";
import { PANE_IDS, type KeyEvent, type OperatorState, type TrustModal } from "./state";
import { mapKey, reduce, runTuiShell, type TuiIo } from "./tui-shell";

// Flow 003 T5 — D-1: commands must be single-flight.
//
// MEASURED (flow 003 T2 §3.1, Run C): `mapKey` never reads `state.busy`, so `p p p d` at 5 ms
// intervals spawned four children against one encrypted SQLite store and produced
// `doctor → PERSISTENCE_FAILURE (exit 5)`, `poll → PERSISTENCE_FAILURE (exit 5)` and finally
// `poll → ok (exit 0)`. Run B turned a `RELAY_UNAVAILABLE (exit 4)` — the class the CLI actually
// returns for a stopped relay — into `PERSISTENCE_FAILURE (exit 5)`. The console exists to surface
// the typed exit-code contract; key-mashing must not manufacture the most alarming class out of
// the most benign one.
//
// These are the PURE half of the pin: the input model and the reducer. The process-level half —
// which is where the property actually lives, because an in-process test can pass while the
// shipped console still spawns overlapping children — is `main.processDriven.test.ts`.
//
// `state.busy` already exists and is already set correctly by `reduce`; it is read today only to
// prefix the activity line with "running… ". This suite makes it a gate.

const CONTACT_ID = "nps4faW9mNX62tZs5M0oqAWtn05cWtn9gCw0gM1JHA";
const PROFILE_ID = "hbRYeNqVnWC74METcY57eDEkV9qNQ6Qzuz6RpsIYQA";

const COMPLETE_MODAL: TrustModal = {
  kind: "trust",
  cardPath: "/tmp/echolet-demo/bob-card.json",
  profileLabel: "alice",
  identifiers: {
    identity_id: CONTACT_ID,
    device_id: "733d80b0-e7e2-5e6c-ba84-0bcd96a373ea",
    device_pubkey: "npsPUBKEY_aW9mNX62tZs5M0oqAWtn05cWtn9gCw0gM",
    signal_identity_key: "BQdNjP6tbN00N3eS6DNpmKpMDFDeDa4MFuUO1QWt8i",
  },
  renderedAt: 1_757_000_000_000,
};

function baseState(overrides: Partial<OperatorState> = {}): OperatorState {
  return {
    profiles: [{
      label: "alice",
      profileDir: "/tmp/echolet-demo/alice",
      relayUrl: "http://127.0.0.1:18099",
      storeKeyEnv: "ECHOLET_E2E_KEY",
      identityId: PROFILE_ID,
      deviceId: "733d80b0-e7e2-5e6c-ba84-0bcd96a373ea",
      contactCount: 1,
      published: true,
      contactCardPath: "/tmp/echolet-demo/bob-card.json",
    }],
    activeProfile: 0,
    contacts: [{
      identityId: CONTACT_ID,
      deviceId: "9f0c4a11-2b3c-4d5e-8f60-71829a3b4c5d",
      devicePubkey: "npsPUBKEY_aW9mNX62tZs5M0oqAWtn05cWtn9gCw0gM",
      signalIdentityKey: "BQdNjP6tbN00N3eS6DNpmKpMDFDeDa4MFuUO1QWt8i",
    }],
    selectedContactId: CONTACT_ID,
    mailbox: { outboxPending: 0, inboxReceived: 0, more: true, lastPolledAtMs: 1_757_000_000_000 },
    rejections: [],
    history: [],
    health: { relayUrl: "http://127.0.0.1:18099", status: "healthy", uptimeMs: null, checkedAtMs: 1_757_000_000_000 },
    pane: "mailbox",
    modal: undefined,
    activity: [{ at: 1_757_000_000_000, text: "poll → ok (exit 0)" }],
    busy: false,
    ...overrides,
  };
}

const key = (name: string, overrides: Partial<KeyEvent> = {}): KeyEvent => ({ name, ctrl: false, sequence: name, ...overrides });

/** Every key that builds a `run` intent on the state above. */
const COMMAND_KEYS = ["p", "d", "r", "h", "i"] as const;

/**
 * Any of the natural phrasings for "your keystroke started nothing because a command is running".
 * The alternation is deliberately generous — the pin is that the operator is TOLD, not that a
 * particular sentence was written. None of these match anything the console paints today; the busy
 * frame currently says only "running… <the previous result>", which reports the command that IS
 * running and says nothing about the one that was dropped.
 */
const REFUSAL = /\b(busy|refused|refuses|refusing|ignored|already running|in flight|one at a time|please wait)\b/i;

describe("D-1: a command key pressed while a command is in flight starts no second command", () => {
  it("does not turn a command key into a run intent while busy, and keeps quit, panes and the modal live", () => {
    const busy = baseState({ busy: true });

    for (const name of COMMAND_KEYS) {
      // The intent may be absent, or it may be some future "refused" intent. What it must never be
      // is a `run`: that is the intent that spawns a second child against the same store.
      expect(mapKey(key(name), busy)?.kind).not.toBe("run");
    }

    // An operator must always be able to leave, change pane, and answer the trust modal — a console
    // that goes deaf while a child runs is indistinguishable from a hung one.
    expect(mapKey(key("q"), busy)).toEqual({ kind: "quit" });
    expect(mapKey(key("c", { ctrl: true }), busy)).toEqual({ kind: "quit" });
    PANE_IDS.forEach((pane, index) => {
      expect(mapKey(key(String(index + 1)), busy)).toEqual({ kind: "select-pane", pane });
    });
    expect(mapKey(key("y"), baseState({ busy: true, modal: COMPLETE_MODAL }))).toEqual({ kind: "trust-confirm" });
    expect(mapKey(key("escape"), baseState({ busy: true, modal: COMPLETE_MODAL }))).toEqual({ kind: "trust-cancel" });

    // The same keys must still work when nothing is in flight, or the gate has simply broken them.
    for (const name of COMMAND_KEYS) {
      expect(mapKey(key(name), baseState())?.kind).toBe("run");
    }
  });

  it("emits no run-cli effect for a run intent that arrives while busy", () => {
    // The deep gate, held in the reducer for the same reason the trust gate is: a `run` arriving
    // from anywhere — a stray keystroke, a future scripted mode, a startup effect — meets it.
    const request: CliRequest = { command: "poll", profileDir: "/tmp/echolet-demo/alice" };
    const step = reduce(baseState({ busy: true }), { kind: "run", request });

    expect(step.effects.filter((effect) => effect.kind === "run-cli")).toEqual([]);

    // Still true of an idle console, so the gate is a gate and not a removal.
    const idle = reduce(baseState(), { kind: "run", request });
    expect(idle.effects).toEqual([{ kind: "run-cli", request }]);
    expect(idle.state.busy).toBe(true);
  });

  it("tells the operator that the console is busy rather than dropping the keystroke in silence", () => {
    // Measured (T2 §4): an unbound or ignored key paints nothing at all, which is indistinguishable
    // from a hung console. The frame the operator is looking at while a child runs must say that a
    // second command would not be started.
    const frame = renderFrame(baseState({ busy: true }), MIN_VIEWPORT);

    // The invariants this must not break, asserted on the very frame the pin adds text to.
    expect(frame.length).toBe(MIN_VIEWPORT.rows);
    for (const line of frame) {
      expect([...line].length).toBe(MIN_VIEWPORT.cols);
      expect(line.includes(String.fromCharCode(27))).toBe(false);
    }
    expect(frame.join("\n")).toContain(UNAUDITED_NOTICE);

    expect(frame.join("\n")).toMatch(REFUSAL);
  });

  it("drives the real shell: five command keystrokes in flight call runCli exactly once", async () => {
    // No clock and no timer: `runCli` returns a promise that never settles, so the console is still
    // busy for every keystroke after the first, and each keystroke is delivered synchronously.
    const calls: CliRequest[] = [];
    let emit: ((chunk: Buffer) => void) | undefined;
    const io: TuiIo = {
      stdout: { write: () => true, columns: 72, rows: 16 },
      stdin: {
        on: (event: string, handler: (chunk: Buffer) => void) => { if (event === "data") emit = handler; return undefined; },
        resume: () => undefined,
        pause: () => undefined,
      },
      now: () => 1_757_000_000_000,
      runCli: (request: CliRequest) => { calls.push(request); return new Promise<CliOutcome>(() => undefined); },
      answerTrustPrompt: () => undefined,
    };

    const finished = runTuiShell(io, baseState());
    for (let index = 0; index < 5; index += 1) emit?.(Buffer.from("p", "utf8"));

    expect(calls.length).toBe(1);

    emit?.(Buffer.from("q", "utf8"));
    await finished;
  });
});
