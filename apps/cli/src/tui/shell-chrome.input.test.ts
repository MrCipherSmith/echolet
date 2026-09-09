import { describe, expect, it } from "vitest";
import { MIN_VIEWPORT, UNAUDITED_NOTICE, renderFrame } from "./shell-chrome";
import { codePoints } from "./text";
import type { OperatorState, Viewport } from "./state";

/*
 * Flow 004 T10 — the frame, while the operator is typing into it. RED.
 *
 * Operator-controlled bytes enter a frame here for the first time by design (t35 §5 item 4), so
 * every property flows 002 and 003 paid for has to be re-proved with the input row open. AC6 lists
 * them: `renderFrame` stays pure, total, deterministic, escape-free and exactly rows by cols; the
 * unaudited-prototype notice appears on every frame.
 *
 * What makes this file RED rather than vacuous: `renderFrame` today has no `input` branch at all,
 * so the exactness assertions alone would pass on a state whose `input` field it simply ignores —
 * a green test for a feature that does not exist. Three assertions therefore require the row to be
 * on the screen: the buffer is painted at every supported viewport, the degraded frame names the
 * pending compose, and the way out is named while `q` is inert.
 *
 * What this file does NOT do is filter anything. AC7's property belongs to the state
 * (`tui-shell.input.test.ts`), and t35 §5 item 4 rejects renderer-side filtering explicitly: it
 * would make "no ESC byte in a frame" a property of the renderer's defensiveness rather than of the
 * state. So the escape-free assertion here is over frames built from buffers that are ALREADY
 * clean, and it can never be the thing that keeps a control byte off the screen.
 */

const ESC = String.fromCharCode(27);

const CONTACT_ID = "nps4faW9mNX62tZs5M0oqAWtn05cWtn9gCw0gM1JHA";

/** The design's `InputState` (§3.1), mirrored locally until `state.ts` declares it. */
interface SpecInputState {
  readonly field: string;
  readonly buffer: string;
  readonly renderedAt: number | null;
  readonly maxBytes: number;
}

/** Short, and distinctive enough that `toContain` is a real assertion at any width. */
const MARKER = "SYNTHETIC_COMPOSE_MARKER";

/**
 * A body longer than the widest pane this console supports, in three scripts.
 *
 * "With a body longer than the pane is wide" is the case that breaks a renderer which concatenates
 * instead of clipping: 203 columns is the widest viewport the existing key-material sweep uses, and
 * this is comfortably past it.
 */
const LONG_BODY = [
  "".padEnd(120, "abcdefghij"),
  "".padEnd(120, "Привет-Надя-"),
  "🙂".repeat(40),
  "日本語のテキスト".repeat(12),
].join(" ");

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
    activity: [{ at: 1_757_000_000_000, text: "poll → ok (exit 0)" }],
    busy: false,
    ...overrides,
  };
}

function composing(buffer: string, input: Partial<SpecInputState> = {}, overrides: Partial<OperatorState> = {}): OperatorState {
  const open: SpecInputState = {
    field: "message",
    buffer,
    renderedAt: 1_757_000_000_000,
    maxBytes: 65_536,
    ...input,
  };
  return { ...baseState(overrides), input: open } as unknown as OperatorState;
}

/** At or above `MIN_VIEWPORT`, where the defined frame — and therefore the input row — is painted. */
const SUPPORTED: readonly Viewport[] = [
  { cols: MIN_VIEWPORT.cols, rows: MIN_VIEWPORT.rows },
  { cols: 96, rows: 28 },
  { cols: 120, rows: 40 },
  { cols: 203, rows: 61 },
];

/**
 * Below it, where `renderFrame` paints the degraded frame.
 *
 * `isBelowMinViewport` is a DISJUNCTION over the two axes (`shell-chrome.ts:48`), so one case per
 * axis plus the both-axes case brackets it exactly — the same three the trust-viewport suite uses.
 */
const DEGRADED: readonly Viewport[] = [
  { cols: 40, rows: 10 },
  { cols: MIN_VIEWPORT.cols - 1, rows: MIN_VIEWPORT.rows },
  { cols: MIN_VIEWPORT.cols, rows: MIN_VIEWPORT.rows - 1 },
];

/** Every input state a frame can be asked to paint, including the two boundary buffers. */
const BUFFERS: readonly (readonly [string, string])[] = [
  ["an empty buffer, just opened", ""],
  ["a short marker", MARKER],
  ["a body longer than any supported pane is wide", LONG_BODY],
  ["a single astral code point", "🙂"],
  ["a body that looks like a flag", "--json --profile /etc/passwd"],
];

describe("T10-G: AC6 — the frame is exactly rows by cols while composing", () => {
  it.each([...SUPPORTED, ...DEGRADED])("is exactly rows by cols at $cols x $rows, for every buffer", (viewport) => {
    for (const [label, buffer] of BUFFERS) {
      const frame = renderFrame(composing(buffer), viewport);
      expect(frame.length, `${label}: row count`).toBe(viewport.rows);
      frame.forEach((line, row) => {
        expect(codePoints(line).length, `${label}: row ${String(row)} width`).toBe(viewport.cols);
      });
    }
  });

  it("emits no line wider than the viewport, which is AC8's guarantee unchanged", () => {
    for (const viewport of [...SUPPORTED, ...DEGRADED]) {
      for (const [label, buffer] of BUFFERS) {
        for (const line of renderFrame(composing(buffer), viewport)) {
          expect(codePoints(line).length <= viewport.cols, `${label} at ${String(viewport.cols)}`).toBe(true);
        }
      }
    }
  });

  it("stays total at hostile viewports with the input row open", () => {
    // `renderFrame` is total at ANY viewport (shell-chrome.ts:260-268) and composing must not make
    // it conditional. Fractional and non-positive sizes are what a resizing terminal really reports.
    const hostile: readonly Viewport[] = [
      { cols: 0, rows: 0 },
      { cols: 1, rows: 1 },
      { cols: -5, rows: 3 },
      { cols: 72.7, rows: 16.2 },
      { cols: 5, rows: 200 },
      { cols: 400, rows: 2 },
    ];
    for (const viewport of hostile) {
      for (const [, buffer] of BUFFERS) {
        expect(() => renderFrame(composing(buffer), viewport)).not.toThrow();
      }
    }
  });

  it("is deterministic and does not mutate the state it is given", () => {
    for (const viewport of [...SUPPORTED, ...DEGRADED]) {
      const state = composing(LONG_BODY);
      const before = JSON.stringify(state);
      const first = renderFrame(state, viewport);
      const second = renderFrame(state, viewport);
      expect(second).toEqual(first);
      expect(JSON.stringify(state)).toBe(before);
    }
  });
});

describe("T10-H: AC6 — the notice and the escape-free guarantee survive every input state", () => {
  it("carries UNAUDITED_NOTICE on every frame, at every viewport, for every buffer", () => {
    for (const viewport of [...SUPPORTED, ...DEGRADED]) {
      for (const [label, buffer] of BUFFERS) {
        // Joined without a separator because below the minimum the notice is WRAPPED rather than
        // truncated (shell-chrome.ts:223-235), which is how it survives a 40-column window.
        const painted = renderFrame(composing(buffer), viewport).join("");
        expect(painted.includes(UNAUDITED_NOTICE), `${label} at ${String(viewport.cols)}x${String(viewport.rows)}`).toBe(true);
      }
    }
  });

  it("keeps the notice on row 0 where the input row cannot displace it", () => {
    // §5 item 5: the input row spends a BODY row. The notice, header, rule, activity line and
    // footer are untouched, so an operator composing a message still sees the warning first.
    for (const viewport of SUPPORTED) {
      for (const [label, buffer] of BUFFERS) {
        expect(renderFrame(composing(buffer), viewport)[0], `${label}`).toContain(UNAUDITED_NOTICE);
      }
    }
  });

  it("contains no ESC byte anywhere", () => {
    for (const viewport of [...SUPPORTED, ...DEGRADED]) {
      for (const [label, buffer] of BUFFERS) {
        expect(renderFrame(composing(buffer), viewport).join("\n").includes(ESC), `${label}`).toBe(false);
      }
    }
  });
});

describe("T10-I: the operator can see what they are about to send", () => {
  it("paints the buffer at every supported viewport", () => {
    // The premise of the whole painted-at gate (§3.2): submission is refused below the minimum
    // BECAUSE the row is not on the screen there. That refusal only means anything if the row IS on
    // the screen above it.
    for (const viewport of SUPPORTED) {
      const painted = renderFrame(composing(MARKER), viewport).join("\n");
      expect(painted, `at ${String(viewport.cols)}x${String(viewport.rows)}`).toContain(MARKER);
    }
  });

  it("names the pending compose on the degraded frame instead of painting the body", () => {
    // §3.2: "The degraded frame gains one line for the same reason it already gains one for a
    // waiting trust decision" — the existing precedent is `shell-chrome.ts:233`. Saying so is the
    // difference between a refusal and a console that appears to have stopped responding.
    for (const viewport of DEGRADED) {
      const frame = renderFrame(composing(MARKER), viewport);
      const painted = frame.join(" ");
      expect(painted, `at ${String(viewport.cols)}x${String(viewport.rows)}`).toMatch(/compos/i);
      expect(painted, `at ${String(viewport.cols)}x${String(viewport.rows)}`).toMatch(/resize/i);
    }
  });

  it("says nothing about composing when nothing is being composed", () => {
    // So the assertion above cannot be satisfied by a line the degraded frame always carries.
    for (const viewport of DEGRADED) {
      expect(renderFrame(baseState(), viewport).join(" ")).not.toMatch(/compos/i);
    }
  });
});

describe("T10-J: AC8 — the way out is named while the key that used to quit is inert", () => {
  it("names ctrl-c on every frame while composing, at every viewport", () => {
    // AC8: "at any viewport, and in any state ... the key that quits is either available or the
    // console says why it is not." While composing, `q` is TEXT (§3.1, and pinned in
    // tui-shell.input.test.ts), so a footer still advertising "[q] quit" would be the exact lie
    // `shell-chrome.ts:125` refuses — "a footer that advertised an unbound key would be a lie".
    // Ctrl-C is the binding that survives, so it is the one the frame must name.
    for (const viewport of [...SUPPORTED, ...DEGRADED]) {
      const painted = renderFrame(composing(MARKER), viewport).join(" ");
      expect(painted, `at ${String(viewport.cols)}x${String(viewport.rows)}`).toMatch(/ctrl-c/i);
    }
  });
});

/*
 * Decided here, because the design left it open:
 *
 * - The degraded frame's existing "resize, or press q to quit" line (shell-chrome.ts:229) is a lie
 *   while composing, because §3.1 makes `q` text. The design says the degraded frame gains a
 *   compose line but does not say what happens to the quit line. This file requires only that
 *   ctrl-c be named in EVERY composing frame — which the implementer can satisfy either by
 *   replacing the quit line while composing or by adding ctrl-c beside it — and does not pin the
 *   wording of either. A `/ctrl-c/i` match is the weakest assertion that still refuses the lie.
 * - Whether the input row shows a byte counter (§2.2 item 2: "1 402 / 65 536 bytes once past half")
 *   is not pinned. It is presentation, and pinning it would freeze a layout this task has no
 *   measurement for.
 */
