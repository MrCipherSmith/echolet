import { describe, expect, it } from "vitest";
import type { CliOutcome, CliRequest } from "./cli-bridge";
import type { InputState, OperatorState } from "./state";
import { applyOutcome, decodeKey, mapKey, reduce } from "./tui-shell";

/*
 * Flow 004 T13 — AC6's escape-free clause, closed at the boundary text arrives through. RED.
 *
 * WHAT WAS MEASURED (004-T12-verify, F-002). Flow 002 established `renderFrame` as pure, total,
 * deterministic, exactly rows × cols and escape-free, and `shell-chrome.test.ts:124` is where the
 * last of those lives — "puts no escape sequence in any rendered frame". Read what that assertion
 * ranges over: five panes × four viewports of ONE hand-written fixture, every string in which the
 * test itself typed. It proves the console's own chrome contains no escape byte. It proves nothing
 * at all about text the console did not write.
 *
 * Flow 004 then closed the operator-typed route at the reducer, and its commit message said "no
 * escape sequence reaches a frame is now a property of the state". That is true of the COMPOSE
 * BUFFER and of nothing else. The verifier drove an ESC byte into a frame by four other routes, and
 * this file names a fifth and a sixth that its enumeration did not list:
 *
 *   1. an inbound message's `plaintext`       — `readHistoryEntries`, tui-shell.ts:386
 *   2. a rejection's `envelopeId` / `code`    — `readRejections`, tui-shell.ts:374
 *   3. the CLI's error `code`                 — `note()`, tui-shell.ts:533   (driven; sibling file)
 *   4. a trust-modal identifier               — `readIdentifiers`, main.ts:134 (driven)
 *   5. `doctor`'s `identity_id`/`device_id`   — `applyOutcome`, tui-shell.ts:429-431
 *   6. the contact ROSTER built from a confirmed modal — `observeContact`, tui-shell.ts:521 (driven)
 *
 * Route 5 is the one the verifier's enumeration excluded, on the ground that "ProfileView's
 * label/relayUrl/profileDir come from the operator's own argv". They do; `identityId` and `deviceId`
 * do not — `applyOutcome` overwrites both from the child's JSON on every `doctor`. Route 6 shares
 * route 4's source but has a different sink and a different lifetime: an identifier lands in
 * `state.contacts` when the operator confirms, and is painted on the profiles pane long after the
 * modal is gone.
 *
 * Route 1 is what makes this a security defect rather than a tidiness defect. The plaintext of an
 * inbound message is chosen by whoever is at the other end of the conversation. They send a body
 * containing `ESC ] 0 ; … BEL`, the operator presses `h`, and `styleFrame` — the console's one
 * module allowed to emit ANSI — hands a stranger's escape sequence to the terminal.
 *
 * WHERE THE PROPERTY BELONGS, AND WHY IT IS NOT THE SAME ANSWER AS AC7'S.
 *
 * For the compose buffer the answer was `reduce`, because `reduce` is the SOLE WRITER of
 * `input.buffer` — a routed search finds exactly three assignments to it, and all three are inside
 * the reducer. That is the whole content of the argument: filter where the field is written, and
 * "no escape byte in a frame" becomes a property of every reachable state rather than of the
 * renderer's defensiveness (t35 §5 item 4).
 *
 * Inbound text arrives by a different road and `reduce` never touches it, so "put it in the
 * reducer" does not transfer. The PRINCIPLE does, and it gives the same answer one layer out:
 * filter in each function that is the sole writer of an external-origin field —
 * `readHistoryEntries`, `readRejections`, `applyOutcome`'s `doctor` case, `note`, the shell's trust
 * listener, `observeContact`. Every one of those is already a NARROWING function: it reads the
 * fields it wants by name and drops the rest, precisely so that "whatever else a relay or sender put
 * on this object stays off the operator's screen and out of the state" (tui-shell.ts:380). Filtering
 * the BYTES there is the same act as filtering the FIELDS there, at the same place, for the same
 * reason.
 *
 * The renderer is the wrong answer for the reason it was wrong for AC7, and for one more:
 * `renderFrame` is not the only reader of these fields. History feeds a pane, the `c` cycle and
 * whatever reads it next; a renderer that defended itself would leave the STATE free to hold an
 * escape sequence and would need re-auditing every time a second reader appeared. So this file
 * asserts over the STATE and deliberately does not import `renderFrame` — exactly as
 * `tui-shell.input.test.ts` does, and for the identical reason: a filter added inside the renderer
 * leaves every assertion below exactly as red as it is now.
 *
 * The three shell-internal routes (3, 4, 6) have no pure seam and are held in
 * `tui-shell.externalTextViewport.test.ts`, against what the shell actually wrote to the terminal.
 */

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
const NUL = String.fromCharCode(0);
const DEL = String.fromCharCode(127);
/** The 8-bit CSI introducer. A C1 byte is a control sequence on its own, with no ESC in front. */
const CSI_C1 = String.fromCharCode(0x9b);

/**
 * True for C0 (U+0000..U+001F), DEL (U+007F) and C1 (U+0080..U+009F).
 *
 * A numeric predicate rather than a regular expression over literal control bytes, for the reason
 * `tui-shell.ts:339` builds its own ESC from a character code: a literal control byte in a source
 * file is invisible in review. Deliberately redefined here rather than imported — a test that asked
 * the implementation for its own definition of "control character" would be satisfied by whatever
 * definition the implementation chose, including an empty one.
 */
function isControlPoint(point: string): boolean {
  const code = point.codePointAt(0) ?? 0;
  return code <= 0x1f || code === 0x7f || (code >= 0x80 && code <= 0x9f);
}

/**
 * The code points that steer a terminal's DISPLAY without being control characters (F-004).
 *
 * None of these is an escape sequence and none can start one, so AC7 as frozen does not name them.
 * They are here because the property AC6 and AC7 are both reaching for is that a frame cannot be
 * made to say something other than what the state holds, and each of these makes exactly that
 * possible:
 *
 * - THE BIDI CONTROLS (U+200E, U+200F, U+202A..U+202E, U+2066..U+2069) reorder the rest of the line.
 *   `formatHistoryLines` (history-pane.ts:41) paints one line per message as
 *   `sequence  direction  messageId  plaintext`, so an override inside a peer's plaintext reorders
 *   the fields painted BEFORE it: a correspondent can make their own inbound message render with
 *   `outbound` where the operator reads the direction. In the trust modal the damage is more direct
 *   still — an identifier that renders in an order it was not written in cannot be compared out of
 *   band, which is the one thing the modal exists to let a human do. And on the compose row it
 *   defeats the painted-at gate itself: `renderedAt` records that the operator SAW the body, and an
 *   override makes what they saw differ from what Enter sends.
 * - THE SEPARATORS (U+2028, U+2029) are line terminators some terminals honour. A frame is a promise
 *   of exactly `rows` lines of exactly `cols` columns; `renderFrame` counts them as one column each,
 *   so the promise holds in the value and breaks on the screen — which is the one place it was made.
 * - U+FEFF is zero-width, so it can sit inside a base64url identifier and make two different
 *   identifiers paint identically.
 *
 * DELIBERATELY ABSENT — the verifier's open Q2 answered narrowly rather than broadly: U+200B ZERO
 * WIDTH SPACE and U+00AD SOFT HYPHEN are invisible but steer nothing. They reorder no text,
 * terminate no line, and are legitimate in real prose, so this file asserts nothing about them in
 * either direction and the choice stays the user's. U+200D ZERO WIDTH JOINER is absent for a
 * stronger reason: it is load-bearing inside emoji sequences, and refusing it would corrupt ordinary
 * message bodies. The positive assertion at the end of T13-E holds that line.
 */
const DISPLAY_STEERING_CODES: readonly (readonly [number, string])[] = [
  [0x200e, "LEFT-TO-RIGHT MARK"],
  [0x200f, "RIGHT-TO-LEFT MARK"],
  [0x202a, "LEFT-TO-RIGHT EMBEDDING"],
  [0x202b, "RIGHT-TO-LEFT EMBEDDING"],
  [0x202c, "POP DIRECTIONAL FORMATTING"],
  [0x202d, "LEFT-TO-RIGHT OVERRIDE"],
  [0x202e, "RIGHT-TO-LEFT OVERRIDE (Trojan Source)"],
  [0x2066, "LEFT-TO-RIGHT ISOLATE"],
  [0x2067, "RIGHT-TO-LEFT ISOLATE"],
  [0x2068, "FIRST STRONG ISOLATE"],
  [0x2069, "POP DIRECTIONAL ISOLATE"],
  [0x2028, "LINE SEPARATOR"],
  [0x2029, "PARAGRAPH SEPARATOR"],
  [0xfeff, "ZERO WIDTH NO-BREAK SPACE (BOM)"],
];

/**
 * Built from code points rather than written as literals, for the reason `isControlPoint` is a
 * numeric predicate: every one of these is invisible, and an invisible literal in a source file is
 * a character no reviewer can see and no diff can show.
 */
const DISPLAY_STEERING_POINTS: readonly string[] = DISPLAY_STEERING_CODES.map(([code]) => String.fromCodePoint(code));
const DISPLAY_STEERING = new Set(DISPLAY_STEERING_POINTS);

/** The Trojan-Source override, named once so the assertions that use it read as English. */
const RTL_OVERRIDE = String.fromCodePoint(0x202e);

/** The two classes together: everything a frame must not be able to carry, whatever wrote it. */
const forbidden = (text: string): string[] =>
  [...text].filter((point) => isControlPoint(point) || DISPLAY_STEERING.has(point));

const nameOf = (point: string): string =>
  `U+${(point.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0")}`;

/**
 * Every escape sequence below is one a real terminal acts on, and none of them is a sequence the
 * console itself ever writes — `styleFrame` emits only SGR 0, 1 and 2, and `runTuiShell` only the
 * alternate-screen, cursor and home/clear pairs. Keeping the two vocabularies disjoint is what lets
 * the sibling driven file assert over raw terminal writes without having to guess whose ESC is whose.
 */
const HOSTILE_SEQUENCES: readonly (readonly [string, string])[] = [
  ["ESC c, a full terminal reset", `${ESC}c`],
  ["an OSC window-title set", `${ESC}]0;PWNED BY A CORRESPONDENT${BEL}`],
  ["an SGR colour change", `${ESC}[31;41m`],
  ["a scrollback erase", `${ESC}[3J`],
  ["an 8-bit CSI with no ESC in front", `${CSI_C1}3J`],
  ["a bare NUL and a bare DEL", `${NUL}${DEL}`],
];

/** One payload carrying every hostile class at once, with printable text on both sides of each. */
const EVERYTHING = `${HOSTILE_SEQUENCES.map(([, sequence]) => `x${sequence}y`).join("-")}${
  DISPLAY_STEERING_POINTS.map((point) => `a${point}b`).join("-")}`;

/**
 * Recognisable, printable, and on BOTH sides of the hostile bytes.
 *
 * A message is not discarded for containing a byte the console will not paint: an inbound body the
 * operator never sees is a worse outcome than a body with two characters missing, and a console that
 * dropped the entry would also hide the fact that a correspondent tried this at all. So every
 * assertion below pairs "the forbidden code points are gone" with "the message is still there",
 * which refuses the two degenerate fixes — dropping the entry, and replacing it with a placeholder.
 */
const KEPT_HEAD = "SYNTHETIC_BODY_HEAD";
const KEPT_TAIL = "SYNTHETIC_BODY_TAIL";
const hostile = (sequence: string): string => `${KEPT_HEAD}${sequence}${KEPT_TAIL}`;

const CONTACT_ID = "nps4faW9mNX62tZs5M0oqAWtn05cWtn9gCw0gM1JHA";
const PROFILE_DIR = "/tmp/echolet-demo/alice";
const AT_MS = 1_757_000_000_000;

function baseState(overrides: Partial<OperatorState> = {}): OperatorState {
  return {
    profiles: [{
      label: "alice",
      profileDir: PROFILE_DIR,
      relayUrl: "http://127.0.0.1:18099",
      storeKeyEnv: "ECHOLET_E2E_KEY",
      identityId: "hbRYeNqVnWC74METcY57eDEkV9qNQ6Qzuz6RpsIYQA",
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
    pane: "history",
    modal: undefined,
    activity: [],
    busy: false,
    ...overrides,
  };
}

const ok = (data: unknown): CliOutcome => ({ ok: true, code: "ok", exitCode: 0, data });

const HISTORY: CliRequest = { command: "history", profileDir: PROFILE_DIR, contactIdentityId: CONTACT_ID };
const POLL: CliRequest = { command: "poll", profileDir: PROFILE_DIR };
const DOCTOR: CliRequest = { command: "doctor", profileDir: PROFILE_DIR };

/**
 * Every string anywhere in a value, however deeply nested, with the path that reaches it.
 *
 * The enumeration is structural rather than a list of field names, deliberately: a route into the
 * state that neither the verifier nor this file thought of is still caught, and a field added by a
 * later task is covered on the day it is added rather than on the day someone remembers to extend a
 * list. It is the same instinct `readRejections` states at tui-shell.ts:380 — read by name, never
 * spread — applied to the assertion instead of to the reader.
 */
function everyString(value: unknown, path = "state"): (readonly [string, string])[] {
  if (typeof value === "string") return [[path, value]];
  if (Array.isArray(value)) return value.flatMap((entry, index) => everyString(entry, `${path}[${String(index)}]`));
  if (typeof value === "object" && value !== null) {
    return Object.entries(value as Record<string, unknown>)
      .flatMap(([key, entry]) => everyString(entry, `${path}.${key}`));
  }
  return [];
}

/** The whole property, over a whole state: nothing anywhere in it can steer a terminal. */
function expectStateIsPaintable(state: OperatorState): void {
  for (const [path, text] of everyString(state)) {
    expect(forbidden(text).map(nameOf), `${path} = ${JSON.stringify(text)}`).toEqual([]);
  }
}

describe("T13-C: an inbound message's plaintext cannot put an escape sequence into the state", () => {
  it.each(HOSTILE_SEQUENCES)("drops %s from a decrypted body, and keeps the message", (_name, sequence) => {
    // Route 1, and the reason this task ran at this hour: `plaintext` is the decrypted body of a
    // message a CORRESPONDENT wrote. `readHistoryEntries` (tui-shell.ts:391) accepts it on a bare
    // `typeof … === "string"` check and `formatHistoryLines` paints it verbatim.
    const state = applyOutcome(baseState(), HISTORY, ok({
      entries: [{
        sequence: 1,
        contactIdentityId: CONTACT_ID,
        messageId: "4ba942f0-0000-4000-8000-000000000001",
        direction: "inbound",
        plaintext: hostile(sequence),
        createdAtMs: AT_MS,
      }],
    }), AT_MS);

    const entry = state.history[0];
    expect(entry, "the entry was dropped; a body the operator never sees is the worse failure").toBeDefined();
    expect(forbidden(entry?.plaintext ?? "").map(nameOf)).toEqual([]);
    // …and the message is still a message.
    expect(entry?.plaintext).toContain(KEPT_HEAD);
    expect(entry?.plaintext).toContain(KEPT_TAIL);
  });

  it("holds for every identifier the same entry carries, not only for the body", () => {
    // `messageId` and `contactIdentityId` are relay- and CLI-supplied and are painted on the SAME
    // line as the body (history-pane.ts:41), so a filter applied to `plaintext` alone would leave
    // that line exactly as steerable as it is today.
    const state = applyOutcome(baseState(), HISTORY, ok({
      entries: [{
        sequence: 2,
        contactIdentityId: hostile(`${ESC}[3J`),
        messageId: hostile(`${ESC}]0;t${BEL}`),
        direction: "outbound",
        plaintext: hostile(EVERYTHING),
        createdAtMs: AT_MS,
      }],
    }), AT_MS);

    expectStateIsPaintable(state);
  });

  it("holds over every entry of a batch, not merely the first", () => {
    // A filter applied to `entries[0]`, or applied once at the boundary of the array rather than to
    // each element, passes the two cases above.
    const entries = HOSTILE_SEQUENCES.map(([, sequence], index) => ({
      sequence: index,
      contactIdentityId: CONTACT_ID,
      messageId: `4ba942f0-0000-4000-8000-00000000000${String(index)}`,
      direction: index % 2 === 0 ? "inbound" : "outbound",
      plaintext: hostile(sequence),
      createdAtMs: AT_MS,
    }));

    const state = applyOutcome(baseState(), HISTORY, ok({ entries }), AT_MS);
    expect(state.history.length).toBe(entries.length);
    expectStateIsPaintable(state);
  });
});

describe("T13-D: a rejection and a doctor result cannot either", () => {
  it("cleans a rejection's envelopeId and code, which the relay supplies", () => {
    // Route 2. `formatRejectionLine` (mailbox-pane.ts:72) already refuses to widen past these two
    // fields, on the stated ground that a rejected envelope is by definition one an untrusted or
    // hostile sender put in the mailbox. The same argument applies to the BYTES of those two fields.
    const state = applyOutcome(baseState(), POLL, ok({
      received: 1,
      more: false,
      rejected: [
        { envelopeId: hostile(`${ESC}[3J`), code: hostile(`${CSI_C1}3J`) },
        { envelopeId: "94a6f678-0000-4000-8000-000000000002", code: hostile(EVERYTHING) },
      ],
    }), AT_MS);

    expect(state.rejections.length).toBe(2);
    expectStateIsPaintable(state);
    expect(state.rejections[0]?.envelopeId).toContain(KEPT_HEAD);
  });

  it("cleans the identity and device ids doctor reports — the route the enumeration missed", () => {
    // Route 5. `ProfileView.label`, `.relayUrl` and `.profileDir` come from the operator's own argv
    // and are outside this class; `identityId` and `deviceId` do NOT — `applyOutcome`
    // (tui-shell.ts:429-431) overwrites both from the child's JSON on every `doctor`, and
    // `formatProfilesLines` paints them as the `identity` and `device` rows.
    const state = applyOutcome(baseState(), DOCTOR, ok({
      identity_id: hostile(`${ESC}]0;doctor${BEL}`),
      device_id: hostile(RTL_OVERRIDE),
      contact_count: 3,
    }), AT_MS);

    expectStateIsPaintable(state);
    expect(state.profiles[0]?.identityId).toContain(KEPT_HEAD);
    expect(state.profiles[0]?.contactCount).toBe(3);
  });

  it("leaves a benign result byte-for-byte unchanged, so the filter is a filter and not a rewrite", () => {
    // The control case. Without it every assertion above is satisfiable by a function that returns
    // the empty string, and the console would be exactly as useless as it is unsteerable. Cyrillic
    // is this prototype's own measured traffic (T34); the emoji, accented and CJK text are here
    // because a filter written over UTF-16 units rather than code points would split the astral pair.
    const clean = {
      entries: [{
        sequence: 7,
        contactIdentityId: CONTACT_ID,
        messageId: "4ba942f0-0000-4000-8000-000000000007",
        direction: "inbound",
        plaintext: "Привет, Надя. Это первое сообщение \u{1F642} café 日本語",
        createdAtMs: AT_MS,
      }],
    };
    const state = applyOutcome(baseState(), HISTORY, ok(clean), AT_MS);

    expect(state.history[0]?.plaintext).toBe(clean.entries[0]?.plaintext);
    expect(state.history[0]?.messageId).toBe(clean.entries[0]?.messageId);
  });

  it("does not mutate the outcome it was handed", () => {
    // `applyOutcome` is documented as pure. A filter implemented by writing back through the parsed
    // JSON would satisfy every assertion above and quietly break that.
    const data = {
      entries: [{
        sequence: 1,
        contactIdentityId: CONTACT_ID,
        messageId: "4ba942f0-0000-4000-8000-000000000001",
        direction: "inbound",
        plaintext: hostile(EVERYTHING),
        createdAtMs: AT_MS,
      }],
    };
    const before = JSON.stringify(data);
    applyOutcome(baseState(), HISTORY, ok(data), AT_MS);
    expect(JSON.stringify(data)).toBe(before);
  });
});

/*
 * T13-E answers the verifier's Q2 in the `bidi-only` direction, for the compose buffer.
 *
 * It is a separate block, deliberately last, so it can be removed as a unit if the user answers Q2
 * differently — nothing above depends on it. The reason it is here at all, rather than being left to
 * inbound text alone: what the operator composes becomes a CORRESPONDENT's inbound plaintext on the
 * other side of the relay. A console that refuses to paint a stranger's right-to-left override and
 * cheerfully sends one exports the hazard it declines to import, and the two boundaries would then
 * need two different predicates — one more thing to keep in agreement than a security property
 * should have.
 */
describe("T13-E: the compose buffer refuses the same display-steering points", () => {
  const composing = (buffer: string): OperatorState => {
    const open: InputState = { field: "message", buffer, renderedAt: AT_MS, maxBytes: 65_536 };
    return { ...baseState(), input: open };
  };

  /** The whole pipeline the operator's fingers travel: raw chunk → key → intent → state. */
  const typeChunk = (state: OperatorState, chunk: string): OperatorState => {
    const intent = mapKey(decodeKey(Buffer.from(chunk, "utf8")), state);
    return intent === undefined ? state : reduce(state, intent).state;
  };

  it.each(DISPLAY_STEERING_CODES.map(([code, name]) => [`${nameOf(String.fromCodePoint(code))} ${name}`, String.fromCodePoint(code)] as const))(
    "keeps %s out of the buffer, alone and embedded",
    (_name, point) => {
      expect(forbidden(typeChunk(composing(""), point).input?.buffer ?? "").map(nameOf)).toEqual([]);
      // The printable remainder stays, exactly as it does for an escape sequence (T10-B).
      expect(typeChunk(composing(""), `a${point}b`).input?.buffer).toBe("ab");
    },
  );

  it("still accepts the invisible characters this specification deliberately does not name", () => {
    // U+200D ZWJ is load-bearing inside emoji sequences — refusing it would corrupt ordinary bodies
    // — and U+200B and U+00AD steer nothing, so Q2's narrow answer leaves all three alone. This
    // assertion exists so that a fix reaching for "every format character" is caught here rather
    // than in somebody's message a year from now.
    const woman = "\u{1F469}";
    const laptop = "\u{1F4BB}";
    const zwj = String.fromCodePoint(0x200d);
    expect(typeChunk(composing(""), `${woman}${zwj}${laptop}`).input?.buffer).toBe(`${woman}${zwj}${laptop}`);
  });
});
