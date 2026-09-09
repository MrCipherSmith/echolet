import { describe, expect, it } from "vitest";
import type { Intent } from "./intents";
import { decodeKey, mapKey, reduce } from "./tui-shell";
import { PANE_IDS, type OperatorState } from "./state";

/*
 * Flow 004 T10 — the pure layer of the input mode, RED.
 *
 * The measured wall (t35-console-client-design.md §1.2, wall 1): `decodeKey` reduces every raw-mode
 * chunk to ONE lower-cased character (`tui-shell.ts:200-212`), and `mapKey` has no branch that reads
 * `key.sequence`, so no operand can be typed at all. `init`, `contact export` and `send` therefore
 * have no key, and the console is an inspector rather than a client. Wall 2 (the body on argv) fell
 * in `bb17f23`; wall 3 (`doctor` enumerating pinned contacts) has fallen too. This is the third.
 *
 * THE PROPERTY THIS FILE EXISTS FOR (AC7), and the reason every assertion below is made over
 * `state.input.buffer` and NEVER over a frame:
 *
 *   "Text the operator types cannot put a control character or an escape sequence into a frame.
 *    Proven over arbitrary input at the reducer boundary, not by filtering inside the renderer —
 *    the property must belong to the state, not to the renderer's defensiveness."
 *
 * `renderFrame` is deliberately not imported here. A filter added inside the renderer would leave
 * every assertion in this file exactly as red as it is now, which is the whole point: the design
 * (§5 item 4) rejects renderer-side filtering because it would make "no ESC byte in a frame" a
 * property of the renderer rather than of the state the tests assert over.
 *
 * The shape specified is the design's §3.1:
 *
 *   type InputField = "relay-url" | "profile-dir" | "store-key-env" | "export-path"
 *                   | "card-path" | "message" | "contact-name";
 *   interface InputState { field: InputField; buffer: string; renderedAt: number | null; maxBytes: number }
 *   // on OperatorState: readonly input?: InputState;
 *
 * It is deliberately NOT a `Modal`: `state.ts:147-155` argues in this repository that "the trust
 * gate must never have a second door", and composing a message is not a decision about trust.
 * `tui-shell.inputTrustExclusion.test.ts` holds that half.
 *
 * The intent vocabulary specified, all of it new:
 *   { kind: "input-open"; field: InputField }
 *   { kind: "input-insert"; text: string }     // carries key.sequence, filtered by the REDUCER
 *   { kind: "input-backspace" }
 *   { kind: "input-cancel" }
 *   { kind: "input-submit" }
 *
 * The local mirror types below exist so that this file typechecks against the CURRENT tree (`tsc
 * -p apps/cli --noEmit` is a gate; `OperatorState` has no `input` and `Intent` has no input member
 * yet). They are structural mirrors, not a second source of truth: once the fields exist the casts
 * become redundant and the assertions are unchanged.
 */

/** The design's `InputState`, mirrored locally until `state.ts` declares it. */
interface SpecInputState {
  readonly field: string;
  readonly buffer: string;
  readonly renderedAt: number | null;
  readonly maxBytes: number;
}

/** The seven fields the design names (§3.1). Declared here rather than imported so this file loads. */
const SPEC_INPUT_FIELDS = [
  "relay-url",
  "profile-dir",
  "store-key-env",
  "export-path",
  "card-path",
  "message",
  "contact-name",
] as const;

const CONTACT_ID = "nps4faW9mNX62tZs5M0oqAWtn05cWtn9gCw0gM1JHA";
const OWN_ID = "hbRYeNqVnWC74METcY57eDEkV9qNQ6Qzuz6RpsIYQA";

const ESC = String.fromCharCode(27);
const DEL = String.fromCharCode(127);
const CTRL_C = String.fromCharCode(3);

/** Every code point a frame must never be able to carry: C0, DEL and C1. */
const CONTROL_POINTS: readonly string[] = [
  ...Array.from({ length: 32 }, (_unused, code) => String.fromCharCode(code)),
  DEL,
  ...Array.from({ length: 32 }, (_unused, index) => String.fromCharCode(0x80 + index)),
];

/**
 * True for any code point the three ranges of §3.1 name: C0 (U+0000..U+001F), DEL (U+007F) and
 * C1 (U+0080..U+009F).
 *
 * Written as a numeric predicate rather than as a regular expression with literal control bytes,
 * for the same reason `tui-shell.ts:187` builds its own ESC from a character code: a literal
 * control byte in a source file is invisible in review, and searching the pure layer for one has
 * to stay a meaningful check.
 */
function isControlPoint(point: string): boolean {
  const code = point.codePointAt(0) ?? 0;
  return code <= 0x1f || code === 0x7f || (code >= 0x80 && code <= 0x9f);
}

/** True when `text` carries any of them. Every AC7 assertion below is this predicate over state. */
const hasControlCharacter = (text: string): boolean => [...text].some(isControlPoint);

function baseState(overrides: Partial<OperatorState> = {}): OperatorState {
  return {
    profiles: [{
      label: "alice",
      profileDir: "/tmp/echolet-demo/alice",
      relayUrl: "http://127.0.0.1:18099",
      storeKeyEnv: "ECHOLET_E2E_KEY",
      identityId: OWN_ID,
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

/** A state with the input row open. `renderedAt` defaults to a painted frame, per §3.2. */
function composing(input: Partial<SpecInputState> = {}, overrides: Partial<OperatorState> = {}): OperatorState {
  const open: SpecInputState = {
    field: "message",
    buffer: "",
    renderedAt: 1_757_000_000_000,
    maxBytes: 65_536,
    ...input,
  };
  return { ...baseState(overrides), input: open } as unknown as OperatorState;
}

const readInput = (state: OperatorState): SpecInputState | undefined =>
  (state as { readonly input?: SpecInputState }).input;

const bufferOf = (state: OperatorState): string => readInput(state)?.buffer ?? "";

const asIntent = (value: Record<string, unknown>): Intent => value as unknown as Intent;

/** The whole pipeline the operator's fingers actually travel: raw chunk → key → intent → state. */
function typeChunk(state: OperatorState, chunk: string): OperatorState {
  const intent = mapKey(decodeKey(Buffer.from(chunk, "utf8")), state);
  return intent === undefined ? state : reduce(state, intent).state;
}

function typeChunks(state: OperatorState, chunks: readonly string[]): OperatorState {
  return chunks.reduce(typeChunk, state);
}

const intentFor = (state: OperatorState, chunk: string): Intent | undefined =>
  mapKey(decodeKey(Buffer.from(chunk, "utf8")), state);

describe("T10-A: typed text reaches the buffer at all, with its case intact", () => {
  it("accumulates ordinary printable characters in the order they were typed", () => {
    const state = typeChunks(composing(), [..."Hello"]);
    expect(bufferOf(state)).toBe("Hello");
  });

  it("preserves case exactly — the defect decodeKey's toLowerCase() causes today", () => {
    // `decodeKey` lower-cases `name` (tui-shell.ts:211) and keeps the raw chunk on `sequence`.
    // `sequence` is the seam the design names, so an input mode that read `name` would pass the
    // test above and fail this one.
    const state = typeChunks(composing(), [..."MiXeD CaSe SHOUTING quiet"]);
    expect(bufferOf(state)).toBe("MiXeD CaSe SHOUTING quiet");
  });

  it("accepts non-ASCII text, which is what this prototype's own evidence sends", () => {
    // Cyrillic is the project's measured traffic (T34); the accented, CJK and astral cases are here
    // because `codePoints` counts code points, so an implementation that used `.length` or a
    // per-UTF-16-unit filter would split the emoji and fail.
    for (const body of ["Привет, Надя", "café", "日本語", "🙂🙂", "Ω≈ç√"]) {
      expect(bufferOf(typeChunks(composing(), [...body]))).toBe(body);
    }
  });

  it("inserts a whole pasted chunk, not merely its first code point", () => {
    // A paste arrives as ONE raw-mode chunk. `decodeKey` keeps only `[...sequence][0]` on `name`,
    // which is exactly why the console cannot be pasted into today.
    const pasted = "многострочная вставка одним куском";
    expect(bufferOf(typeChunk(composing(), pasted))).toBe(pasted);
  });

  it("maps a printable chunk to an insert intent carrying the sequence, not the name", () => {
    expect(intentFor(composing(), "H")).toEqual({ kind: "input-insert", text: "H" });
    expect(intentFor(composing(), "Ж")).toEqual({ kind: "input-insert", text: "Ж" });
  });

  it("deletes the last code point on backspace (0x7f), and stops at an empty buffer", () => {
    // §1.2 names 0x7f explicitly: it "decodes to a `name` nothing binds" today.
    expect(intentFor(composing({ buffer: "abc" }), DEL)).toEqual({ kind: "input-backspace" });
    expect(bufferOf(typeChunk(composing({ buffer: "abc" }), DEL))).toBe("ab");
    // One code point, not one UTF-16 unit: a backspace that halved an emoji would leave a lone
    // surrogate in the buffer and therefore in a frame.
    expect(bufferOf(typeChunk(composing({ buffer: "a🙂" }), DEL))).toBe("a");
    expect(bufferOf(typeChunk(composing({ buffer: "" }), DEL))).toBe("");
  });

  it("cancels on Escape and discards the buffer, emitting no effect", () => {
    const state = composing({ buffer: "half a message" });
    expect(intentFor(state, ESC)).toEqual({ kind: "input-cancel" });
    const step = reduce(state, asIntent({ kind: "input-cancel" }));
    expect(readInput(step.state)).toBeUndefined();
    expect(step.effects).toEqual([]);
  });
});

describe("T10-B: AC7 — no control character or escape sequence can enter the state", () => {
  it("keeps every C0, DEL and C1 code point out of the buffer, alone and embedded", () => {
    // Exhaustive over the three ranges the design names (§3.1: "nothing in U+0000..U+001F, no
    // U+007F, no U+0080..U+009F"), in both the positions a terminal can deliver one: as a chunk of
    // its own, and inside a paste.
    for (const control of CONTROL_POINTS) {
      const alone = typeChunk(composing(), control);
      expect(hasControlCharacter(bufferOf(alone)), `chunk U+${control.charCodeAt(0).toString(16).padStart(4, "0")} alone`).toBe(false);

      const embedded = typeChunk(composing(), `a${control}b`);
      expect(hasControlCharacter(bufferOf(embedded)), `chunk U+${control.charCodeAt(0).toString(16).padStart(4, "0")} embedded`).toBe(false);
    }
  });

  it("inserts the printable remainder of a paste that carries an escape sequence, and nothing else", () => {
    // The design's exact words (§3.1): "a paste containing an escape sequence inserts its printable
    // remainder and nothing else". The `[31m` tail is printable text and stays; the ESC byte is the
    // only thing removed, because the ESC byte is the only thing that can steer a terminal.
    expect(bufferOf(typeChunk(composing(), `safe${ESC}[31mred`))).toBe("safe[31mred");
    expect(bufferOf(typeChunk(composing(), `A${ESC}[2J${ESC}[HB`))).toBe("A[2J[HB");
  });

  it("treats a chunk that BEGINS with ESC as a key rather than as text", () => {
    // An arrow key is `ESC [ A`. The design refuses to decode arrows (§2.3, "arrows are ESC [ A and
    // decoding them would put an escape-sequence decoder in the input path"), so the requirement is
    // only that nothing of it lands in the buffer.
    for (const arrow of [`${ESC}[A`, `${ESC}[B`, `${ESC}[C`, `${ESC}[D`, `${ESC}OP`]) {
      const state = typeChunk(composing({ buffer: "kept" }), arrow);
      const after = bufferOf(state);
      expect(hasControlCharacter(after), `arrow ${JSON.stringify(arrow)}`).toBe(false);
      expect(after === "kept" || after === "", `arrow ${JSON.stringify(arrow)} left ${JSON.stringify(after)}`).toBe(true);
    }
  });

  it("holds over arbitrary chunks drawn from a mixed alphabet, deterministically", () => {
    // "Proven over arbitrary input" (AC7). A seeded LCG, so a failure is reproducible and the suite
    // has no hidden nondeterminism; the alphabet mixes printable ASCII, Cyrillic, an astral pair
    // and the full control ranges, which is every class a real terminal can deliver.
    const alphabet = [...CONTROL_POINTS, ..."abcXYZ 09-_", ..."Привет", "🙂", ESC, DEL];
    let seed = 20_260_909;
    const next = (): number => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed;
    };

    for (let trial = 0; trial < 400; trial += 1) {
      const length = 1 + (next() % 8);
      let chunk = "";
      for (let at = 0; at < length; at += 1) chunk += alphabet[next() % alphabet.length] ?? "";
      const state = typeChunk(composing({ buffer: "seed" }), chunk);
      expect(hasControlCharacter(bufferOf(state)), `chunk ${JSON.stringify(chunk)}`).toBe(false);
    }
  });

  it("holds across a long sequence of keystrokes, not just one", () => {
    // A filter applied once at open time, or only to the first insert, passes every case above.
    const chunks = [...CONTROL_POINTS.map((control) => `x${control}y`), ..."tail"];
    expect(hasControlCharacter(bufferOf(typeChunks(composing(), chunks)))).toBe(false);
  });
});

describe("T10-C: the byte bound refuses rather than truncates", () => {
  it("refuses an insertion that would exceed maxBytes and leaves the buffer intact", () => {
    // §3.1: "Insertion that would exceed the bound is refused and the row says so, rather than
    // silently truncating a message." A truncating implementation loses the tail of a message the
    // operator believes they sent.
    const state = composing({ buffer: "1234567", maxBytes: 8 });
    expect(bufferOf(typeChunk(state, "ab"))).toBe("1234567");
    expect(bufferOf(typeChunk(state, "a"))).toBe("12345678");
  });

  it("counts UTF-8 bytes, not code points, because that is what the CLI bounds", () => {
    // `outbound.ts:118` re-checks `Buffer.byteLength(plaintext) > 65536`. A console that counted
    // code points would accept a body the CLI then refuses with INVALID_MESSAGE at exit 2.
    const state = composing({ buffer: "é", maxBytes: 4 });
    expect(bufferOf(typeChunk(state, "é"))).toBe("éé");
    expect(bufferOf(typeChunk(composing({ buffer: "éé", maxBytes: 4 }), "é"))).toBe("éé");
    expect(bufferOf(typeChunk(composing({ buffer: "", maxBytes: 3 }), "🙂"))).toBe("");
  });
});

describe("T10-D: while composing, no other binding fires — and the way out still does", () => {
  it("types q rather than quitting", () => {
    // The design's sentence, verbatim (§3.1): "an operator typing 'quit' must not quit."
    expect(intentFor(composing(), "q")).toEqual({ kind: "input-insert", text: "q" });
    const state = typeChunks(composing(), [..."quit"]);
    expect(bufferOf(state)).toBe("quit");
    expect(reduce(composing(), asIntent({ kind: "input-insert", text: "q" })).effects).toEqual([]);
  });

  it("types a pane ordinal rather than switching panes", () => {
    for (let ordinal = 1; ordinal <= PANE_IDS.length; ordinal += 1) {
      const digit = String(ordinal);
      const state = composing();
      expect(intentFor(state, digit)).toEqual({ kind: "input-insert", text: digit });
      const next = typeChunk(state, digit);
      expect(next.pane).toBe(state.pane);
      expect(bufferOf(next)).toBe(digit);
    }
  });

  it("types a command key rather than spawning a child", () => {
    // Every letter `paneKeyIntent` binds today (tui-shell.ts:110-138). While composing, each is
    // text: a message containing the word "period" must not poll, doctor and publish on its way in.
    for (const command of ["p", "d", "r", "h", "i", "c", "t"]) {
      const state = composing();
      expect(intentFor(state, command), `key ${command}`).toEqual({ kind: "input-insert", text: command });
      const step = reduce(state, asIntent({ kind: "input-insert", text: command }));
      expect(step.effects, `key ${command}`).toEqual([]);
      expect(step.state.busy, `key ${command}`).toBe(false);
    }
  });

  it("still quits on ctrl-c — AC8's way out is never taken away", () => {
    // §3.1: "Ctrl-C still quits: a console that cannot be left is worse than a lost draft." AC8
    // requires a way out in EVERY state, and composing is now one of them.
    expect(intentFor(composing({ buffer: "an unsent draft" }), CTRL_C)).toEqual({ kind: "quit" });
    expect(reduce(composing({ buffer: "an unsent draft" }), { kind: "quit" }).effects).toEqual([{ kind: "quit" }]);
  });

  it("does not toggle the help list out from under the compose row", () => {
    const state = composing();
    expect(intentFor(state, "?")).toEqual({ kind: "input-insert", text: "?" });
    expect(typeChunk(state, "?").help).not.toBe(true);
  });
});

describe("T10-E: the submit gate is the trust modal's painted-at gate, reused", () => {
  it("refuses a submit for an input row that was never painted, and keeps the buffer", () => {
    // §3.2, and the same reason as `reduce`'s trust gate (tui-shell.ts:166): below MIN_VIEWPORT the
    // frame is the degraded one, which carries no input row, so an operator there would be
    // submitting a body they cannot see. Insertion is deliberately NOT gated — a keystroke into an
    // invisible buffer is recoverable — only the irreversible half is.
    const state = composing({ buffer: "unseen body", renderedAt: null });
    const before = JSON.stringify(state);
    const step = reduce(state, asIntent({ kind: "input-submit" }));

    expect(step.effects).toEqual([]);
    expect(JSON.stringify(step.state)).toBe(before);
    expect(bufferOf(step.state)).toBe("unseen body");
  });

  it("does something when the input row HAS been painted", () => {
    // The other direction, so the refusal above cannot be satisfied by refusing every submit — the
    // degenerate fix that would leave the console exactly as unusable as it is today. What submit
    // emits for each field is the pane tasks' business; that it is not a no-op is this one's.
    const state = composing({ buffer: "SYNTHETIC_COMPOSED_BODY", renderedAt: 1_757_000_000_000 });
    const step = reduce(state, asIntent({ kind: "input-submit" }));

    const changed = JSON.stringify(step.state) !== JSON.stringify(state);
    expect(changed || step.effects.length > 0, "a painted submit did nothing at all").toBe(true);
  });

  it("maps Enter to a submit while composing", () => {
    for (const chunk of ["\r", "\n"]) {
      expect(intentFor(composing({ buffer: "body" }), chunk), `chunk ${JSON.stringify(chunk)}`)
        .toEqual({ kind: "input-submit" });
    }
  });

  it("never mutates the state it is given, for any input intent", () => {
    const intents = [
      { kind: "input-open", field: "message" },
      { kind: "input-insert", text: "x" },
      { kind: "input-backspace" },
      { kind: "input-cancel" },
      { kind: "input-submit" },
    ];
    for (const intent of intents) {
      const state = composing({ buffer: "held" });
      const before = JSON.stringify(state);
      reduce(state, asIntent(intent));
      expect(JSON.stringify(state), `intent ${intent.kind}`).toBe(before);
    }
  });
});

describe("T10-F: opening the input row", () => {
  it("opens an empty, unpainted buffer and emits no effect", () => {
    const step = reduce(baseState(), asIntent({ kind: "input-open", field: "message" }));
    const input = readInput(step.state);

    expect(step.effects).toEqual([]);
    expect(input).toBeDefined();
    expect(input?.field).toBe("message");
    expect(input?.buffer).toBe("");
    // Unpainted, exactly like `buildTrustModal`'s `renderedAt: null` (modal-host.ts:93): the shell
    // stamps it after the frame carrying the row was written, and never before.
    expect(input?.renderedAt).toBeNull();
  });

  it("gives every field a positive byte bound", () => {
    for (const field of SPEC_INPUT_FIELDS) {
      const input = readInput(reduce(baseState(), asIntent({ kind: "input-open", field })).state);
      expect(input, `field ${field}`).toBeDefined();
      expect(Number.isSafeInteger(input?.maxBytes), `field ${field} maxBytes ${String(input?.maxBytes)}`).toBe(true);
      expect((input?.maxBytes ?? 0) > 0, `field ${field}`).toBe(true);
    }
  });

  it("bounds the message field at the CLI's own plaintext bound", () => {
    // `outbound.ts:22` (zod) and `:118` (`Buffer.byteLength`) both bound plaintext at 65536. The
    // design's Q2 leaves WHERE that number should live undecided — a protocol constant or a leaf
    // module in apps/cli — and this assertion deliberately settles only the VALUE, so either answer
    // to Q2 satisfies it. A console that let the operator compose past the bound would spend a
    // keystroke to earn INVALID_MESSAGE at exit 2.
    const input = readInput(reduce(baseState(), asIntent({ kind: "input-open", field: "message" })).state);
    expect(input?.maxBytes).toBe(65_536);
  });
});

/*
 * Two things this file deliberately does NOT pin, recorded so a later reader does not mistake
 * silence for an oversight:
 *
 * - WHICH KEY OPENS WHICH FIELD. The design binds `w` on the chat pane and `n` on the contacts
 *   pane (§2.2, §2.3), and neither pane exists yet — the pane budget in §3.4 is a separate task.
 *   Every test above opens the row through the `input-open` intent, so this file constrains the
 *   input mode without pre-deciding the pane model.
 * - WHAT SUBMIT EMITS PER FIELD. §2.2 specifies the `message` field completely (a `send` → `history`
 *   sequence), and the run-sequence mechanism is the design's T-5, not this task. The one thing
 *   asserted here is that a painted submit is not a no-op.
 */
