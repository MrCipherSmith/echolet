import { describe, expect, it } from "vitest";
import type { CliOutcome } from "./cli-bridge";
import { MIN_VIEWPORT } from "./shell-chrome";
import type { OperatorState, TrustIdentifiers } from "./state";
import { runTuiShell, type TuiIo } from "./tui-shell";

// Flow 003 T27 — V-001: the trust modal's painted-at guard, pinned through the real shell.
//
// The property, and it is flow 002's AC and the security half of flow 003's D-4: a trust
// confirmation must not be answerable for identifiers that were never on the operator's screen.
// Two halves hold it up. The reducer's half refuses `trust-confirm` while `modal.renderedAt` is
// null (`tui-shell.ts:166`), and `tui-shell.test.ts` covers that. The shell's half is the
// condition that decides when the stamp is set: `paint()` records `renderedAt` only when the
// viewport it just painted was NOT below `MIN_VIEWPORT` (`tui-shell.ts:343`), because the degraded
// frame painted below the minimum carries no modal and therefore no identifiers.
//
// MEASURED (flow 003 T25 §3.2, mutation M-A′): deleting `&& !isBelowMinViewport(painted)` from
// `paint()` left all 15 TUI files and 108 tests green. `onTrustIdentifiers` — the one seam through
// which a modal can ever be opened inside a running shell — appeared in no test at all, so the
// stamp and the whole `answer-trust-prompt` path were exercised at no viewport by anything. The
// guard shipped as a comment with no enforcement, and a future edit reinstating the defect would
// have been silent.
//
// This suite drives the REAL `runTuiShell` through that seam, at both sides of the boundary, and
// asserts the two directions together so that neither can be satisfied by a degenerate fix:
//
//   * below the minimum the confirmation is REFUSED, and the frames the shell actually wrote there
//     carry none of the four identifiers — so the refusal is not merely a rule, it matches what
//     was on the screen;
//   * at the minimum the confirmation is ACCEPTED, and every one of the four identifiers is
//     present in the painted frame that preceded the keystroke — so a shell that simply never
//     stamped `renderedAt` could not pass either.
//
// The refusal is asserted at three viewports rather than one, because `isBelowMinViewport` is a
// DISJUNCTION over the two axes (`shell-chrome.ts:48`): 40×10 is short on both, 71×16 is one column
// short, 72×15 is one row short. A guard narrowed to a single axis — the most plausible way this
// condition decays under a later edit — passes a test that only ever looks at 40×10, and fails
// here. 72×16 is the other side of both boundaries, so the four cases bracket the guard exactly.

const ESC = String.fromCharCode(27);
const ANSI = new RegExp(`${ESC}\\[[0-9;?]*[A-Za-z]`, "g");

const CARD_PATH = "/tmp/echolet-demo/bob-card.json";

/**
 * The four identifiers the specification requires a human to check. Public values only: an
 * `identity_id`, a device UUID and two PUBLIC keys, exactly what a contact card carries. Nothing
 * here is or stands in for key material the store holds.
 *
 * They are chosen to be distinctive so that "contains" is a real assertion: none of them is a
 * substring of anything else the console paints, and the fixture state below has an empty contact
 * roster, so the only route by which they can reach a frame is the modal.
 */
const IDENTIFIERS: TrustIdentifiers = {
  identity_id: "TRUSTid7uP2xQ4rL9wZ0bN3mK6vC1sD8fH5jG2aE4t",
  device_id: "9f0c4a11-2b3c-4d5e-8f60-71829a3b4c5d",
  device_pubkey: "TRUSTdevPUBKEY_5rT8yU1iO4pA7sD0fG3hJ6kL9z",
  signal_identity_key: "TRUSTsigPUBKEY_2wE5rT8yU1iO4pA7sD0fG3hJ6k",
};

const IDENTIFIER_VALUES = Object.values(IDENTIFIERS) as readonly string[];

function state(): OperatorState {
  return {
    profiles: [{
      label: "alice",
      profileDir: "/tmp/echolet-demo/alice",
      relayUrl: "http://127.0.0.1:18099",
      storeKeyEnv: "ECHOLET_E2E_KEY",
      identityId: "hbRYeNqVnWC74METcY57eDEkV9qNQ6Qzuz6RpsIYQA",
      deviceId: "733d80b0-e7e2-5e6c-ba84-0bcd96a373ea",
      contactCount: 0,
      published: false,
      contactCardPath: CARD_PATH,
    }],
    activeProfile: 0,
    contacts: [],
    selectedContactId: null,
    mailbox: { outboxPending: 0, inboxReceived: 0, more: false, lastPolledAtMs: null },
    rejections: [],
    history: [],
    health: { relayUrl: "http://127.0.0.1:18099", status: "unknown", uptimeMs: null, checkedAtMs: null },
    pane: "profiles",
    modal: undefined,
    activity: [],
    busy: false,
  };
}

/**
 * Lets every already-queued microtask run.
 *
 * The shell applies its effects from an async IIFE, so `answerTrustPrompt` lands one microtask
 * after the keystroke. This is a drain, not a delay: `setImmediate` fires after the microtask
 * queue is empty, and nothing in this suite is on a timer — there is no clock, no child process
 * and no unsettled promise anywhere in the `TuiIo` below.
 */
const drain = (): Promise<void> => new Promise<void>((resolve) => { setImmediate(resolve); });

interface DrivenShell {
  /** Every answer handed to the CLI's own trust prompt, in order. `[]` means "refused". */
  readonly answers: readonly boolean[];
  /** Every frame the shell wrote, ANSI stripped, split into lines. */
  readonly frames: () => string[][];
  /** Opens a trust modal the way the `contact import` driver does, through `onTrustIdentifiers`. */
  readonly announceIdentifiers: () => void;
  readonly press: (sequence: string) => void;
  readonly finished: Promise<number>;
}

/** Drives the real shell against an injected stdout of exactly the given size. */
function drive(cols: number, rows: number): DrivenShell {
  const answers: boolean[] = [];
  const writes: string[] = [];
  let emit: ((chunk: Buffer) => void) | undefined;
  let announce: ((input: { readonly cardPath: string; readonly profileLabel: string; readonly identifiers: TrustIdentifiers }) => void) | undefined;

  const io: TuiIo = {
    stdout: { write: (chunk: string) => { writes.push(chunk); return true; }, columns: cols, rows },
    stdin: {
      on: (event: string, handler: (chunk: Buffer) => void) => { if (event === "data") emit = handler; return undefined; },
      resume: () => undefined,
      pause: () => undefined,
    },
    now: () => 1_757_000_000_000,
    runCli: () => Promise.resolve<CliOutcome>({ ok: true, code: "ok", exitCode: 0, data: null }),
    answerTrustPrompt: (answer: boolean) => { answers.push(answer); },
    onTrustIdentifiers: (listener) => { announce = listener; },
  };

  const finished = runTuiShell(io, state());

  return {
    answers,
    frames: () => writes
      .map((chunk) => chunk.replace(ANSI, ""))
      .filter((chunk) => chunk.length > 0)
      .map((chunk) => chunk.split("\r\n")),
    announceIdentifiers: () => announce?.({ cardPath: CARD_PATH, profileLabel: "alice", identifiers: IDENTIFIERS }),
    press: (sequence: string) => emit?.(Buffer.from(sequence, "utf8")),
    finished,
  };
}

/**
 * The three ways a viewport can be below the minimum, named by which axis falls short.
 *
 * 40×10 is the viewport flow 003 T2 measured the console breaking at. The other two sit one step
 * outside a single boundary each, so between them they hold both halves of the disjunction.
 */
const BELOW_MINIMUM: readonly (readonly [string, number, number])[] = [
  ["short on both axes", 40, 10],
  ["one column short of the minimum", MIN_VIEWPORT.cols - 1, MIN_VIEWPORT.rows],
  ["one row short of the minimum", MIN_VIEWPORT.cols, MIN_VIEWPORT.rows - 1],
];

describe("V-001: a trust confirmation is answerable only for identifiers the shell actually painted", () => {
  it.each(BELOW_MINIMUM)("refuses the confirmation when the painted viewport was %s, where no identifier is on the frame", async (_name, cols, rows) => {
    const shell = drive(cols, rows);

    shell.announceIdentifiers();

    // The premise of the refusal, asserted rather than assumed: the frames written at this size
    // carry none of the four identifiers, so an operator at this terminal has seen nothing to
    // compare out of band.
    const painted = shell.frames();
    expect(painted.length).toBeGreaterThan(0);
    const everything = painted.map((lines) => lines.join("\n")).join("\n");
    for (const value of IDENTIFIER_VALUES) expect(everything).not.toContain(value);

    // `y` is the modal's confirm key, and it reaches the reducer: the modal is open, so `mapKey`
    // maps it to `trust-confirm`, and all four identifiers are present, so the completeness gate
    // is satisfied. The ONLY thing standing between this keystroke and a recorded trust decision
    // is the shell's refusal to stamp `renderedAt` for a frame that carried no modal.
    shell.press("y");
    await drain();

    expect(shell.answers).toEqual([]);

    // The modal is still open — a refusal is not a dismissal — so the operator can still decline
    // it, and the console can then be left. Both are asserted so that "refused" cannot be a
    // console that has simply gone deaf.
    shell.press(ESC);
    await drain();
    expect(shell.answers).toEqual([false]);

    shell.press("q");
    await shell.finished;
  });

  it.each([
    ["exactly the minimum viewport", MIN_VIEWPORT.cols, MIN_VIEWPORT.rows],
    ["a comfortable viewport", 96, 28],
  ])("accepts the confirmation at %s, with all four identifiers on the painted frame", async (_name, cols, rows) => {
    const shell = drive(cols, rows);

    shell.announceIdentifiers();

    // The other half of the same gate, and the reason the refusals above cannot be passed by
    // breaking the feature: a shell that never stamped `renderedAt`, or one that refused every
    // confirmation, or one that painted the panel with an identifier clipped, fails here.
    const frames = shell.frames();
    const latest = (frames[frames.length - 1] ?? []).join("\n");
    for (const value of IDENTIFIER_VALUES) expect(latest).toContain(value);

    shell.press("y");
    await drain();

    expect(shell.answers).toEqual([true]);

    // The confirmation is answered exactly once and the modal is gone: a second `y` after the
    // decision must reach nothing, or the operator's single check would authorise repeatedly.
    shell.press("y");
    await drain();
    expect(shell.answers).toEqual([true]);

    shell.press("q");
    await shell.finished;
  });
});
