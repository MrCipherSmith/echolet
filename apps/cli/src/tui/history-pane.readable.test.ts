import { describe, expect, it } from "vitest";
import { MIN_VIEWPORT, renderFrame } from "./shell-chrome";
import type { HistoryEntryView, OperatorState, ProfileView, Viewport } from "./state";

/*
 * Flow 004 T27 — the conversation row. RED.
 *
 * ── THE DEFECT, AS MEASURED ────────────────────────────────────────────────────────────────────
 *
 * 004-T25-verify F-001, measured on a live run of the shipped `dist/tui.js` against the shipped
 * `dist/cli.js` and the real relay binary. A message arrived, was decrypted, was committed to the
 * store — and could not be read. The captured frame:
 *
 *   `  1  outbound  37ffccdc-5428-4ae6-87da-bcdd8fb42ec5  CONSOLE_E2E_OUT_ea2`
 *   `  2  inbound  cb926153-a958-4419-96af-346282953f1d  CONSOLE_E2E_IN_b9cf4`
 *
 * Each row is exactly 72 code points, so every width assertion in this package passes; the two real
 * bodies were 51 and 50 characters and the CLI read both back in full from both stores in the same
 * run. The loss is the pane's alone. The verifier found it by waiting 45 seconds for a body that had
 * already arrived.
 *
 * The arithmetic, from `buildHistorySnapshot` (history-pane.ts:41) and the two-column indent
 * `formatHistoryLines` adds (:63) — `  ${sequence}  ${direction}  ${messageId}  ${plaintext}`:
 *
 *   prefix   2 + 1 + 2 + 8 + 2 + 36 + 2 = 53 columns for an `outbound` row
 *            2 + 1 + 2 + 7 + 2 + 36 + 2 = 52 columns for an `inbound` row
 *   body     72 - 53 = 19  and  72 - 52 = 20  at MIN_VIEWPORT (shell-chrome.ts:39)
 *            80 - 53 = 27  and  80 - 52 = 28  at a traditional 80-column terminal
 *
 * MIN_VIEWPORT is not an exotic width. It is what `runTuiShell` falls back to when stdout reports no
 * size at all (tui-shell.ts:810) — every piped or harness-driven session — and it is one column
 * below the 80-column terminal an operator most likely has.
 *
 * ── WHAT EARNS THE COLUMNS, AND WHY ────────────────────────────────────────────────────────────
 *
 * The row is FOR reading a conversation. The message id is not what a person reads a conversation
 * for, and it cannot simply be deleted either: `runtime/inbound.ts:267` keys the inbox by it,
 * `runtime/outbound.ts:284` retries by it (which is what makes an exact retry byte-identical), the
 * threat model requires deduplication by it (THREAT-08 §272-273), and the runbook's §9 comparison —
 * the same message appearing as `outbound` on one screen and `inbound` on another — is performed on
 * it. So the id keeps a place on the row; what it does not keep is 36 of 72 columns.
 *
 * The rule this file pins, stated as a property rather than as a layout, because three repairs are
 * open (004-T25-verify Q-001: drop the id, shorten it, or give the body its own row) and this
 * dispatch writes tests rather than choosing between them:
 *
 *   AT ANY SUPPORTED WIDTH, THE MESSAGE BODY GETS AT LEAST HALF THE ROW.
 *
 * Half, because the metadata on this row exists to DESCRIBE the message, and describing a thing may
 * not cost more than the thing described. It is 36 columns at 72 against today's 19-20, 40 at 80
 * against today's 27-28, and it scales with the terminal instead of being a second magic number.
 * Every one of Q-001's three repairs satisfies it; shortening the id to more than about twenty
 * characters does not, which is the second thing this dispatch asked for — a layout that merely
 * truncates the id differently still fails if it still cannot show a message.
 *
 * A RESIDUAL, NAMED RATHER THAN DECIDED: the two real bodies the verifier measured were 50 and 51
 * characters, and at 72 columns an 8-character id prefix leaves 48. So Q-001's `short-id` satisfies
 * this file and still cannot show THAT message whole at the minimum viewport, while `drop-id` (58
 * columns) and `continuation` (a body row of its own) can. That is the user's call, it is Q-001, and
 * this file deliberately does not pre-empt it — it pins the floor all three clear.
 *
 * ── WHICH CASES ARE RED, AND WHICH ARE THE PAIRS THAT KILL A DEGENERATE FIX ────────────────────
 *
 * RED on this tree:
 *   "shows a received message in full at the minimum viewport"    — 36 columns wanted, 20 available
 *   "gives the body at least half the row at every width"         — red at 72 and at 80; the 120 and
 *                                                                   203 legs pass today and are the
 *                                                                   pair below
 *   "says so when a body is longer than the pane can hold"        — today the body is clipped by
 *                                                                   `clipLine` with no marker at all
 *
 * PASSES TODAY, and each is a pair that kills a repair which would satisfy the red cases the wrong
 * way:
 *   "keeps the message id recoverable"        — kills `drop-id`-shaped repairs and any repair that
 *                                               replaces the id with a constant
 *   "keeps the direction and the sequence"    — kills a repair that buys columns by dropping the two
 *                                               fields the §9 comparison also reads
 *   the 120 and 203 legs of the width sweep   — kill a repair that hard-caps the body at a constant
 *                                               instead of spending the row it has
 *
 * Nothing here spawns a process, reads a clock or touches a store: `buildHistorySnapshot`,
 * `formatHistoryLines` and `renderFrame` are pure. It therefore takes no timeout from
 * `apps/cli/test/childProcessTimeouts.ts` — it has none to take, and no millisecond literal appears
 * in it.
 */

const ALICE = "hbRYeNqVnWC74METcY57eDEkV9qNQ6Qzuz6RpsIYQA";
const RELAY_URL = "http://127.0.0.1:18317";

/** UUIDv4, the way `randomUUID()` mints one in `commands/cli.ts:431`. 36 columns on the row. */
const OUTBOUND_ID = "37ffccdc-5428-4ae6-87da-bcdd8fb42ec5";
const INBOUND_ID = "cb926153-a958-4419-96af-346282953f1d";

/**
 * The widths this file pins, and why each one is here.
 *
 * `MIN_VIEWPORT` is both the narrowest supported terminal and the size every piped session gets;
 * 80x24 is the terminal an operator most likely has; the last two are the wide legs, which pass
 * today and exist to kill a repair that caps the body rather than spending the row.
 */
const VIEWPORTS: readonly Viewport[] = [
  MIN_VIEWPORT,
  { cols: 80, rows: 24 },
  { cols: 120, rows: 40 },
  { cols: 203, rows: 61 },
];

/**
 * The columns the body must get at a given width: half the row, rounded down.
 *
 * Stated as a function of the width rather than as four numbers, so a viewport added later inherits
 * the rule instead of inheriting a table nobody updated.
 */
function bodyBudget(cols: number): number {
  return Math.floor(cols / 2);
}

/**
 * A body of exactly `length` characters with no short internal repeat, so that finding it in a frame
 * cannot be an accident of two unrelated rows sitting next to each other.
 *
 * Every character is printable ASCII and survives `paintable`, which matters: this file is about
 * layout, and a body that the escape filter shortened would make a width failure look like a filter
 * failure.
 */
const ALPHABET = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

function bodyOf(length: number): string {
  let text = "";
  for (let at = 0; at < length; at += 1) text += ALPHABET[(at * 7 + Math.floor(at / ALPHABET.length)) % ALPHABET.length] ?? "x";
  return text;
}

function entry(overrides: Partial<HistoryEntryView> = {}): HistoryEntryView {
  return {
    sequence: 1,
    contactIdentityId: ALICE,
    messageId: INBOUND_ID,
    direction: "inbound",
    plaintext: bodyOf(bodyBudget(MIN_VIEWPORT.cols)),
    createdAtMs: 1_757_000_000_001,
    ...overrides,
  };
}

const PROFILE: ProfileView = {
  label: "alice",
  profileDir: "/tmp/echolet-demo/alice",
  relayUrl: RELAY_URL,
  storeKeyEnv: "ECHOLET_TUI_REG_KEY",
  identityId: "hbRYeNqVnWC74METcY57eDEkV9qNQ6Qzuz6RpsIYQA",
  deviceId: "733d80b0-e7e2-5e6c-ba84-0bcd96a373ea",
  contactCount: 1,
  published: true,
};

/** The console with a conversation open: the pane, and the explicit selection it requires. */
function conversation(entries: readonly HistoryEntryView[]): OperatorState {
  return {
    profiles: [PROFILE],
    activeProfile: 0,
    contacts: [],
    selectedContactId: ALICE,
    mailbox: { outboxPending: null, inboxReceived: 1, more: false, lastPolledAtMs: 1_757_000_000_000 },
    rejections: [],
    history: entries,
    health: { relayUrl: RELAY_URL, status: "healthy", uptimeMs: null, checkedAtMs: 1_757_000_000_000 },
    pane: "history",
    modal: undefined,
    activity: [],
    busy: false,
    observedAtMs: 1_757_000_000_000,
  };
}

/**
 * What the operator can read off the frame, in the two shapes a repair could take.
 *
 * `flat` is the frame with each row's padding removed — a body that fits on one row is found here.
 * `reflowed` strips every row's indentation and joins with nothing, so a body a repair WRAPPED onto
 * continuation rows is found too. The disjunction is deliberate: this file pins that the operator
 * can read the message, not which of Q-001's three layouts delivers it.
 */
function readable(frame: readonly string[]): { flat: string; reflowed: string } {
  return {
    flat: frame.map((line) => line.replace(/\s+$/u, "")).join("\n"),
    reflowed: frame.map((line) => line.trim()).join(""),
  };
}

function shows(frame: readonly string[], text: string): boolean {
  const { flat, reflowed } = readable(frame);
  return flat.includes(text) || reflowed.includes(text);
}

/** True when SOME contiguous `length`-character window of `body` survived onto the frame. */
function showsAWindowOf(frame: readonly string[], body: string, length: number): boolean {
  const { flat, reflowed } = readable(frame);
  for (let at = 0; at + length <= body.length; at += 1) {
    const window = body.slice(at, at + length);
    if (flat.includes(window) || reflowed.includes(window)) return true;
  }
  return false;
}

/** How much of `body` the frame actually shows, so a failure names a number instead of a boolean. */
function longestVisiblePrefix(frame: readonly string[], body: string): number {
  let best = 0;
  for (let length = 1; length <= body.length; length += 1) {
    if (!showsAWindowOf(frame, body, length)) break;
    best = length;
  }
  return best;
}

describe("the conversation pane exists to be read", () => {
  it("shows a received message in full at the minimum viewport", () => {
    // The defect, at the width the verifier measured it at. A body of exactly half the row — 36 of
    // 72 columns — against the 20 the current layout leaves for an `inbound` row.
    const body = bodyOf(bodyBudget(MIN_VIEWPORT.cols));
    const frame = renderFrame(conversation([entry({ plaintext: body })]), MIN_VIEWPORT);

    expect(frame).toHaveLength(MIN_VIEWPORT.rows);
    for (const line of frame) expect([...line]).toHaveLength(MIN_VIEWPORT.cols);

    expect(
      shows(frame, body),
      `the console's only surface for reading a message showed ${String(longestVisiblePrefix(frame, body))} of ${String(body.length)} characters at ${String(MIN_VIEWPORT.cols)}x${String(MIN_VIEWPORT.rows)} — the message arrived, was decrypted and was committed, and the operator cannot read it`,
    ).toBe(true);
  });

  it("gives the body at least half the row at every supported width", () => {
    /*
     * The same property over four widths, and the whole §9 conversation shape rather than one entry:
     * the same message read as `outbound` on one screen and `inbound` on the other.
     *
     * RED at 72 and at 80. The 120 and 203 legs pass on this tree, and they are the pair: a repair
     * that answered the two narrow legs by capping the body at a constant would satisfy them and
     * fail here, where the row has columns to spend and the message is longer.
     */
    for (const viewport of VIEWPORTS) {
      const wanted = bodyBudget(viewport.cols);
      const sent = bodyOf(wanted);
      const received = bodyOf(wanted + 1).slice(1);
      const frame = renderFrame(
        conversation([
          entry({ sequence: 1, messageId: OUTBOUND_ID, direction: "outbound", plaintext: sent }),
          entry({ sequence: 2, messageId: INBOUND_ID, direction: "inbound", plaintext: received }),
        ]),
        viewport,
      );

      for (const [role, body] of [["outbound", sent], ["inbound", received]] as const) {
        expect(
          shows(frame, body),
          `at ${String(viewport.cols)}x${String(viewport.rows)} the ${role} row showed ${String(longestVisiblePrefix(frame, body))} of the ${String(wanted)} columns the body is owed`,
        ).toBe(true);
      }
    }
  });

  it("says so when a body is longer than the pane can hold, instead of stopping mid-message", () => {
    /*
     * Flow 003 AC7, restated on this pane: "The console never hides data without saying so." The
     * pane has 11 body rows at MIN_VIEWPORT, so a 5000-character body cannot be shown whole at any
     * layout — 11 x 72 is 792 columns. What must not happen is what happens today: `clipLine` cuts
     * the row at 72 and the frame gives the operator no sign that anything was cut.
     *
     * The marker is U+2026, which is the character this codebase already spends a row on for exactly
     * this purpose (`truncationMarker`, pane-fit.ts:49). RED twice over: the frame carries no U+2026
     * at all today, and it shows 20 characters where half the row is owed.
     */
    const body = bodyOf(5_000);
    const frame = renderFrame(conversation([entry({ plaintext: body })]), MIN_VIEWPORT);

    expect(
      frame.join("\n").includes("…"),
      "a message body was cut off and the frame said nothing about it — the operator cannot tell a short message from a truncated one",
    ).toBe(true);

    expect(
      showsAWindowOf(frame, body, bodyBudget(MIN_VIEWPORT.cols)),
      `an over-long body was reduced to ${String(longestVisiblePrefix(frame, body))} characters, below the ${String(bodyBudget(MIN_VIEWPORT.cols))} the row owes it`,
    ).toBe(true);
  });
});

describe("what the body's columns may not be bought with", () => {
  it("keeps the message id recoverable", () => {
    /*
     * PASSES TODAY. The pair that kills a repair which recovers the columns by deleting the id, or
     * by replacing it with a constant.
     *
     * Eight characters, not thirty-six: `randomUUID()` mints a UUIDv4 (commands/cli.ts:431), so the
     * first eight hex characters are 32 bits of randomness and distinguish every message in a
     * conversation. That is enough for the runbook's §9 side-by-side comparison and for naming a
     * message in a bug report; the whole id stays available from `history --with` where an exact
     * value is needed. This asserts the FLOOR — a repair that keeps all 36 columns of it and gives
     * the body its own row passes here and passes above.
     */
    const frame = renderFrame(
      conversation([
        entry({ sequence: 1, messageId: OUTBOUND_ID, direction: "outbound", plaintext: bodyOf(bodyBudget(MIN_VIEWPORT.cols)) }),
        entry({ sequence: 2, messageId: INBOUND_ID, direction: "inbound", plaintext: bodyOf(bodyBudget(MIN_VIEWPORT.cols)) }),
      ]),
      MIN_VIEWPORT,
    );

    for (const id of [OUTBOUND_ID, INBOUND_ID]) {
      expect(
        shows(frame, id.slice(0, 8)),
        `the row no longer carries any part of ${id} — the conversation can no longer be compared against the other side, and a retry can no longer be named`,
      ).toBe(true);
    }

    // Two different messages must still look different, or the id has been replaced by a decoration.
    expect(OUTBOUND_ID.slice(0, 8)).not.toEqual(INBOUND_ID.slice(0, 8));
  });

  it("keeps the direction and the sequence on the row", () => {
    // PASSES TODAY. The other pair: the §9 comparison reads the direction and the sequence beside
    // the id, so a repair that bought the body's columns from those two would trade one unreadable
    // pane for another.
    const frame = renderFrame(
      conversation([
        entry({ sequence: 7, messageId: OUTBOUND_ID, direction: "outbound", plaintext: bodyOf(bodyBudget(MIN_VIEWPORT.cols)) }),
        entry({ sequence: 8, messageId: INBOUND_ID, direction: "inbound", plaintext: bodyOf(bodyBudget(MIN_VIEWPORT.cols)) }),
      ]),
      MIN_VIEWPORT,
    );
    const painted = readable(frame).flat;

    expect(painted).toContain("outbound");
    expect(painted).toContain("inbound");
    expect(painted).toContain("7");
    expect(painted).toContain("8");
  });
});
