import { describe, expect, it } from "vitest";
import type { Intent } from "./intents";
import { decodeKey, mapKey, reduce } from "./tui-shell";
import type { OperatorState, TrustModal } from "./state";

/*
 * Flow 004 T10 — the trust gate keeps its single door. RED.
 *
 * `state.ts:147-155` records why `help` is a boolean rather than a second `Modal`:
 *
 *   "the key list is not a decision: it takes no exclusive control of the keyboard and the trust
 *    gate must never have a second door."
 *
 * Composing a message is not a decision about trust either, so t35 §3.1 makes the input row a FIELD
 * on `OperatorState` and not a `Modal` — the design calls this "the load-bearing decision", because
 * making `Modal` a union would force every `modal !== undefined` site to re-narrow, and the
 * reducer's trust gate (`tui-shell.ts:161-170`) is one of them.
 *
 * The property that has to hold once the field exists, in both orders:
 *
 *   1. modal first: while a trust modal is open, nothing opens the input row and no key reaches it;
 *   2. input first: the input row cannot be open when a modal arrives — the only thing that opens a
 *      modal is the `contact import` handshake (`tui-shell.ts:398-404`), which runs while a child is
 *      alive, and t35's T-4 states the rule directly as "input cannot open while `busy`".
 *
 * Together they make the coexisting state unreachable rather than merely handled, which is the
 * stronger of the two and the one the design asks for. The last describe block asserts it as an
 * invariant over the whole intent vocabulary, so a binding added later cannot slip past it — the
 * same shape as the D-1 gate, which is written over the INTENT rather than over a list of key names
 * for exactly that reason (`tui-shell.ts:99-104`).
 */

const CONTACT_ID = "nps4faW9mNX62tZs5M0oqAWtn05cWtn9gCw0gM1JHA";

/** The design's `InputState` (§3.1), mirrored locally until `state.ts` declares it. */
interface SpecInputState {
  readonly field: string;
  readonly buffer: string;
  readonly renderedAt: number | null;
  readonly maxBytes: number;
}

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

const OPEN_INPUT: SpecInputState = {
  field: "message",
  buffer: "a draft that must not become a trust decision",
  renderedAt: 1_757_000_000_000,
  maxBytes: 65_536,
};

function baseState(overrides: Partial<OperatorState> = {}): OperatorState {
  return {
    profiles: [{
      label: "alice",
      profileDir: "/tmp/echolet-demo/alice",
      relayUrl: "http://127.0.0.1:18099",
      storeKeyEnv: "ECHOLET_E2E_KEY",
      identityId: "hbRYeNqVnWC74METcY57eDEkV9qNQ6Qzuz6RpsIYQA",
      deviceId: "733d80b0-e7e2-5e6c-ba84-0bcd96a373ea",
      contactCount: 1,
      published: true,
      contactCardPath: "/tmp/echolet-demo/bob-card.json",
    }],
    activeProfile: 0,
    contacts: [],
    selectedContactId: CONTACT_ID,
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

const withInput = (state: OperatorState, input: SpecInputState = OPEN_INPUT): OperatorState =>
  ({ ...state, input } as unknown as OperatorState);

const readInput = (state: OperatorState): SpecInputState | undefined =>
  (state as { readonly input?: SpecInputState }).input;

const asIntent = (value: Record<string, unknown>): Intent => value as unknown as Intent;

const intentFor = (state: OperatorState, chunk: string): Intent | undefined =>
  mapKey(decodeKey(Buffer.from(chunk, "utf8")), state);

/** Every intent the surface has, plus the five the input mode adds. */
const EVERY_INTENT: readonly Record<string, unknown>[] = [
  { kind: "select-pane", pane: "history" },
  { kind: "select-profile", index: 0 },
  { kind: "select-contact", identityId: CONTACT_ID },
  { kind: "run", request: { command: "poll", profileDir: "/tmp/echolet-demo/alice" } },
  { kind: "toggle-help" },
  { kind: "trust-confirm" },
  { kind: "trust-cancel" },
  { kind: "quit" },
  { kind: "input-open", field: "message" },
  { kind: "input-open", field: "relay-url" },
  { kind: "input-insert", text: "x" },
  { kind: "input-backspace" },
  { kind: "input-cancel" },
  { kind: "input-submit" },
];

describe("T10-K: order one — a trust modal is open, and nothing composes behind it", () => {
  it("refuses to open the input row while a modal is open", () => {
    // The refusal is in the REDUCER, not only in `mapKey`, for the same reason the trust gate is
    // (tui-shell.ts:155-158): an intent arriving from anywhere — a stray keystroke, a resize race,
    // a future scripted mode, a startup effect — must meet the same precondition.
    const state = baseState({ modal: COMPLETE_MODAL });
    const step = reduce(state, asIntent({ kind: "input-open", field: "message" }));

    expect(readInput(step.state)).toBeUndefined();
    expect(step.state.modal).toBeDefined();
    expect(step.effects).toEqual([]);
  });

  it("routes every key to the modal, never to an input row", () => {
    // `mapKey`'s modal branch stays exactly as written (§3.1, routing order 1). Even in the state
    // this suite exists to make unreachable — both open at once — the modal wins.
    const state = withInput(baseState({ modal: COMPLETE_MODAL }));
    for (const chunk of ["a", "Z", "3", "q", "?", "p", " ", "Ж"]) {
      const intent = intentFor(state, chunk);
      const kind = intent === undefined ? "undefined" : intent.kind;
      expect(String(kind).startsWith("input-"), `key ${JSON.stringify(chunk)} produced ${String(kind)}`).toBe(false);
    }
    expect(intentFor(state, "y")).toEqual({ kind: "trust-confirm" });
    expect(intentFor(state, "n")).toEqual({ kind: "trust-cancel" });
  });

  it("lets no keystroke reach an open buffer while a modal is up", () => {
    const state = withInput(baseState({ modal: COMPLETE_MODAL }));
    const step = reduce(state, asIntent({ kind: "input-insert", text: "leaked" }));
    expect(readInput(step.state)?.buffer ?? "").toBe(OPEN_INPUT.buffer);
  });
});

describe("T10-L: order two — the operator is composing, and a trust modal cannot displace it", () => {
  it("refuses to open the input row while a command is in flight", () => {
    // t35 T-4, stated as the mechanism: a trust modal can only be opened by the `contact import`
    // handshake, which only runs while a child is alive, which is exactly when `busy` is set. If
    // the input row cannot open while busy, a modal can never arrive on top of one.
    const step = reduce(baseState({ busy: true }), asIntent({ kind: "input-open", field: "message" }));
    expect(readInput(step.state)).toBeUndefined();
    expect(step.effects).toEqual([]);
  });

  it("still opens the input row when nothing is in flight and no modal is up", () => {
    // So the two refusals above cannot be satisfied by refusing to open the row at all.
    const step = reduce(baseState(), asIntent({ kind: "input-open", field: "message" }));
    expect(readInput(step.state)).toBeDefined();
  });
});

describe("T10-M: the two can never be open at once, whatever intent arrives", () => {
  it("never produces a state with both a modal and an input row", () => {
    const states: readonly (readonly [string, OperatorState])[] = [
      ["idle", baseState()],
      ["busy", baseState({ busy: true })],
      ["modal open", baseState({ modal: COMPLETE_MODAL })],
      ["modal open and busy", baseState({ modal: COMPLETE_MODAL, busy: true })],
      ["composing", withInput(baseState())],
      ["composing, unpainted", withInput(baseState(), { ...OPEN_INPUT, renderedAt: null })],
    ];

    for (const [label, state] of states) {
      for (const intent of EVERY_INTENT) {
        const next = reduce(state, asIntent(intent)).state;
        const both = next.modal !== undefined && readInput(next) !== undefined;
        expect(both, `${label} + ${String(intent.kind)} left both doors open`).toBe(false);
      }
    }
  });

  it("emits a trust confirmation only from a trust modal, never from a submit", () => {
    // The single door, restated as an assertion about effects: `answer-trust-prompt{answer:true}`
    // has exactly one origin, and the input mode adds no second one.
    for (const state of [baseState(), withInput(baseState()), baseState({ modal: COMPLETE_MODAL })]) {
      for (const intent of EVERY_INTENT.filter((entry) => entry.kind !== "trust-confirm")) {
        const effects = reduce(state, asIntent(intent)).effects;
        const confirms = effects.some((effect) => effect.kind === "answer-trust-prompt" && effect.answer === true);
        expect(confirms, `${String(intent.kind)} emitted a trust confirmation`).toBe(false);
      }
    }
    // And the one origin still works, unchanged by any of the above.
    expect(reduce(baseState({ modal: COMPLETE_MODAL }), { kind: "trust-confirm" }).effects)
      .toEqual([{ kind: "answer-trust-prompt", answer: true }]);
  });

  it("keeps the modal's own gates intact when an input row exists in the same state", () => {
    // The design's reason for refusing a `Modal` union is that a union would force every
    // `modal !== undefined` site to re-narrow. If a future edit made it one anyway, these two
    // refusals are where the damage would show first.
    const unpainted = withInput(baseState({ modal: { ...COMPLETE_MODAL, renderedAt: null } }));
    expect(reduce(unpainted, { kind: "trust-confirm" }).effects).toEqual([]);

    const identifiers = { ...COMPLETE_MODAL.identifiers } as unknown as Record<string, unknown>;
    delete identifiers.device_pubkey;
    const incomplete = withInput(baseState({
      modal: { ...COMPLETE_MODAL, identifiers: identifiers as TrustModal["identifiers"] },
    }));
    expect(reduce(incomplete, { kind: "trust-confirm" }).effects).toEqual([]);
  });
});

/*
 * Decided here, because the design left it open:
 *
 * §3.1 gives the routing order and T-4 gives the busy rule, but neither says what should happen if
 * a modal somehow arrived while the row was open. This file does not answer that question — it
 * makes it unreachable, by pinning the two refusals (`input-open` is refused while a modal is open
 * AND while busy) and then asserting the coexistence invariant over the whole intent vocabulary.
 * That is the same move §8 Q7 makes for "what happens to a composed message when the operator
 * switches profile": unreachable is a decision too.
 */
