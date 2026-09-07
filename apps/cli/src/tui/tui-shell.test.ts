import { describe, expect, it } from "vitest";
import { mapKey, reduce } from "./tui-shell";
import type { Intent } from "./intents";
import { PANE_IDS, type KeyEvent, type OperatorState, type PaneId, type TrustModal } from "./state";

// Flow 002 T9 — the input model, and the trust gate.
//
// `mapKey` and `reduce` are pure, and an `Effect` is a DESCRIPTION rather than a call, so this
// suite drives the whole interaction model — keystroke to intent to state to effect — with no
// process and no terminal.
//
// The gate is the reason the reducer exists at all. Putting it in the modal's key handler would
// guard the keyboard; putting it here guards the DECISION, so a confirmation arriving from
// anywhere — a stray keystroke, a resize race, some future scripted mode — meets the same
// precondition: the open modal is a trust modal, all four identifiers are present, and the modal
// has actually been painted.

const CONTACT_ID = "nps4faW9mNX62tZs5M0oqAWtn05cWtn9gCw0gM1JHA";
const OTHER_ID = "hbRYeNqVnWC74METcY57eDEkV9qNQ6Qzuz6RpsIYQA";

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
      identityId: OTHER_ID,
      deviceId: "733d80b0-e7e2-5e6c-ba84-0bcd96a373ea",
      contactCount: 1,
      published: true,
    }],
    activeProfile: 0,
    contacts: [{
      identityId: CONTACT_ID,
      deviceId: "9f0c4a11-2b3c-4d5e-8f60-71829a3b4c5d",
      devicePubkey: "npsPUBKEY_aW9mNX62tZs5M0oqAWtn05cWtn9gCw0gM",
      signalIdentityKey: "BQdNjP6tbN00N3eS6DNpmKpMDFDeDa4MFuUO1QWt8i",
    }],
    selectedContactId: null,
    mailbox: { outboxPending: 0, inboxReceived: 0, more: false, lastPolledAtMs: null },
    rejections: [],
    history: [],
    health: { relayUrl: "http://127.0.0.1:18099", status: "unknown", uptimeMs: null, checkedAtMs: null },
    pane: "profiles",
    modal: undefined,
    activity: [],
    busy: false,
    ...overrides,
  };
}

const key = (name: string, overrides: Partial<KeyEvent> = {}): KeyEvent => ({ name, ctrl: false, sequence: name, ...overrides });

describe("mapKey turns a keystroke into an intent", () => {
  it("selects each pane by its ordinal", () => {
    const state = baseState();
    PANE_IDS.forEach((pane: PaneId, index: number) => {
      expect(mapKey(key(String(index + 1)), state)).toEqual({ kind: "select-pane", pane });
    });
  });

  it("quits on q and on ctrl-c", () => {
    const state = baseState();
    expect(mapKey(key("q"), state)).toEqual({ kind: "quit" });
    expect(mapKey(key("c", { ctrl: true }), state)).toEqual({ kind: "quit" });
  });

  it("returns undefined for a key it does not bind", () => {
    const state = baseState();
    for (const event of [key("f7"), key("~"), key("9"), key("0")]) {
      expect(mapKey(event, state)).toBeUndefined();
    }
  });

  it("gives an open modal exclusive control of the keyboard", () => {
    // While the trust modal is up, a pane key must not switch panes behind it. An operator who
    // pressed "3" and got the history pane would not know whether the import is still pending.
    const state = baseState({ modal: COMPLETE_MODAL });
    expect(mapKey(key("3"), state)).toBeUndefined();
    expect(mapKey(key("y"), state)).toEqual({ kind: "trust-confirm" });
    expect(mapKey(key("n"), state)).toEqual({ kind: "trust-cancel" });
    expect(mapKey(key("escape"), state)).toEqual({ kind: "trust-cancel" });
  });
});

describe("the trust gate lives in the reducer", () => {
  it("confirms only when the modal is complete and has been painted", () => {
    const step = reduce(baseState({ modal: COMPLETE_MODAL }), { kind: "trust-confirm" });
    expect(step.effects).toEqual([{ kind: "answer-trust-prompt", answer: true }]);
    expect(step.state.modal).toBeUndefined();
  });

  it("refuses a confirmation when any of the four identifiers is missing", () => {
    for (const field of ["identity_id", "device_id", "device_pubkey", "signal_identity_key"]) {
      const identifiers = { ...COMPLETE_MODAL.identifiers } as unknown as Record<string, unknown>;
      delete identifiers[field];
      const state = baseState({ modal: { ...COMPLETE_MODAL, identifiers: identifiers as TrustModal["identifiers"] } });

      const step = reduce(state, { kind: "trust-confirm" });

      expect(step.effects).toEqual([]);
      expect(step.state.modal).toBeDefined();
    }
  });

  it("refuses a confirmation for a modal that has never been painted", () => {
    // `renderedAt` is set by the shell after the frame carrying the modal was written. Without it,
    // "the four identifiers were shown before trust was recorded" is a claim about code rather
    // than about what the operator saw.
    const step = reduce(baseState({ modal: { ...COMPLETE_MODAL, renderedAt: null } }), { kind: "trust-confirm" });
    expect(step.effects).toEqual([]);
    expect(step.state.modal).toBeDefined();
  });

  it("refuses a confirmation when no modal is open at all", () => {
    const step = reduce(baseState(), { kind: "trust-confirm" });
    expect(step.effects).toEqual([]);
  });

  it("cancels without recording trust", () => {
    const step = reduce(baseState({ modal: COMPLETE_MODAL }), { kind: "trust-cancel" });
    expect(step.effects).toEqual([{ kind: "answer-trust-prompt", answer: false }]);
    expect(step.state.modal).toBeUndefined();
  });

  it("cancels an incomplete modal, so a malformed card is not a dead end", () => {
    const identifiers = { ...COMPLETE_MODAL.identifiers } as unknown as Record<string, unknown>;
    delete identifiers.device_pubkey;
    const step = reduce(baseState({ modal: { ...COMPLETE_MODAL, identifiers: identifiers as TrustModal["identifiers"] } }), { kind: "trust-cancel" });
    expect(step.effects).toEqual([{ kind: "answer-trust-prompt", answer: false }]);
    expect(step.state.modal).toBeUndefined();
  });
});

describe("reduce describes work rather than doing it", () => {
  it("turns a run intent into a run-cli effect carrying the same request", () => {
    const request = { command: "poll", profileDir: "/tmp/echolet-demo/alice" } as const;
    const step = reduce(baseState(), { kind: "run", request });
    expect(step.effects).toEqual([{ kind: "run-cli", request }]);
  });

  it("selects a pane and a contact without emitting any effect", () => {
    for (const pane of PANE_IDS) {
      const step = reduce(baseState(), { kind: "select-pane", pane });
      expect(step.state.pane).toBe(pane);
      expect(step.effects).toEqual([]);
    }
    const selected = reduce(baseState(), { kind: "select-contact", identityId: CONTACT_ID });
    expect(selected.state.selectedContactId).toBe(CONTACT_ID);
    expect(selected.effects).toEqual([]);
  });

  it("emits quit for the quit intent", () => {
    expect(reduce(baseState(), { kind: "quit" }).effects).toEqual([{ kind: "quit" }]);
  });

  it("never mutates the state it is given", () => {
    const intents: Intent[] = [
      { kind: "select-pane", pane: "history" },
      { kind: "select-contact", identityId: CONTACT_ID },
      { kind: "run", request: { command: "poll", profileDir: "/tmp/echolet-demo/alice" } },
      { kind: "trust-confirm" },
      { kind: "trust-cancel" },
      { kind: "quit" },
    ];
    for (const intent of intents) {
      const state = baseState({ modal: COMPLETE_MODAL });
      const before = JSON.stringify(state);
      reduce(state, intent);
      expect(JSON.stringify(state)).toBe(before);
    }
  });
});
