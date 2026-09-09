import { describe, expect, it } from "vitest";
import type { CliOutcome, CliRequest } from "./cli-bridge";
import { MIN_VIEWPORT } from "./shell-chrome";
import type { OperatorState } from "./state";
import { runTuiShell, type TuiIo } from "./tui-shell";

/*
 * Flow 004 T10 — the submit gate, driven through the REAL shell. RED.
 *
 * This is the lesson `tui-shell.trustViewport.test.ts` was written to record, applied one surface
 * further. The reducer's half of the trust gate — refuse while `renderedAt` is null — was covered
 * by `tui-shell.test.ts`, and the SHELL's half — stamp `renderedAt` only after a frame that was not
 * below `MIN_VIEWPORT` (`tui-shell.ts:343`) — was covered by nothing, so flow 003 T25's mutation
 * M-A′ deleted `&& !isBelowMinViewport(painted)` and left every TUI file green.
 *
 * §3.2 reuses that gate verbatim for the input row rather than inventing a second rule, so the same
 * two halves exist and the same half is the one a mutation can delete silently.
 * `tui-shell.input.test.ts` holds the reducer half; this file holds the shell half, at both sides of
 * the boundary, so that neither can be satisfied by a degenerate fix:
 *
 *   * below the minimum, pressing Enter runs NO command, and the frames the shell actually wrote
 *     there carry none of the body — so the refusal matches what was on the screen;
 *   * at the minimum, pressing Enter DOES run the send, carrying the composed body — so a shell
 *     that never stamped `renderedAt`, or one that refused every submit, fails here.
 *
 * It spawns nothing: `runCli` is an injected function, there is no terminal, no clock, no store and
 * no relay, so this file is as cheap as the pure ones and takes no timeout from
 * `test/childProcessTimeouts.ts` — it has none to take.
 *
 * The input row is handed to `runTuiShell` in its INITIAL state rather than opened by a keystroke,
 * because which key opens which field belongs to the pane tasks (§2.2 binds `w` on a chat pane that
 * does not exist yet). What is under test is the gate, not the binding.
 */

const ESC = String.fromCharCode(27);
const CTRL_C = String.fromCharCode(3);
const ANSI = new RegExp(`${ESC}\\[[0-9;?]*[A-Za-z]`, "g");

const CONTACT_ID = "nps4faW9mNX62tZs5M0oqAWtn05cWtn9gCw0gM1JHA";

/**
 * Distinctive, so `toContain` and `not.toContain` are both real assertions: this string is not a
 * substring of anything else the console paints, and it is not key material — it is a message body,
 * which is precisely the thing the operator is entitled to see before sending.
 */
const BODY = "SYNTHETIC_COMPOSED_BODY_ONE_TWO_THREE";

/** The design's `InputState` (§3.1), mirrored locally until `state.ts` declares it. */
interface SpecInputState {
  readonly field: string;
  readonly buffer: string;
  readonly renderedAt: number | null;
  readonly maxBytes: number;
}

function composingState(): OperatorState {
  const input: SpecInputState = { field: "message", buffer: BODY, renderedAt: null, maxBytes: 65_536 };
  const state: OperatorState = {
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
    activity: [],
    busy: false,
  };
  return { ...state, input } as unknown as OperatorState;
}

/**
 * Lets every already-queued microtask run.
 *
 * Copied in shape from `tui-shell.trustViewport.test.ts`: the shell applies its effects from an
 * async IIFE, so an effect lands one microtask after the keystroke. This is a drain, not a delay —
 * nothing in this suite is on a timer, and no millisecond value appears anywhere in it.
 */
const drain = (): Promise<void> => new Promise<void>((resolve) => { setImmediate(resolve); });

interface DrivenShell {
  /** Every request the shell actually asked to run, in order. */
  readonly requests: readonly CliRequest[];
  /** Every frame the shell wrote, ANSI stripped, split into lines. */
  readonly frames: () => string[][];
  readonly press: (sequence: string) => void;
  readonly finished: Promise<number>;
}

function drive(cols: number, rows: number): DrivenShell {
  const requests: CliRequest[] = [];
  const writes: string[] = [];
  let emit: ((chunk: Buffer) => void) | undefined;

  const io: TuiIo = {
    stdout: { write: (chunk: string) => { writes.push(chunk); return true; }, columns: cols, rows },
    stdin: {
      on: (event: string, handler: (chunk: Buffer) => void) => { if (event === "data") emit = handler; return undefined; },
      resume: () => undefined,
      pause: () => undefined,
    },
    now: () => 1_757_000_000_000,
    runCli: (request: CliRequest) => {
      requests.push(request);
      return Promise.resolve<CliOutcome>({ ok: true, code: "ok", exitCode: 0, data: null });
    },
    answerTrustPrompt: () => undefined,
  };

  const finished = runTuiShell(io, composingState());

  return {
    requests,
    frames: () => writes
      .map((chunk) => chunk.replace(ANSI, ""))
      .filter((chunk) => chunk.length > 0)
      .map((chunk) => chunk.split("\r\n")),
    press: (sequence: string) => emit?.(Buffer.from(sequence, "utf8")),
    finished,
  };
}

/** The three ways a viewport falls below the minimum — the disjunction bracketed on both axes. */
const BELOW_MINIMUM: readonly (readonly [string, number, number])[] = [
  ["short on both axes", 40, 10],
  ["one column short of the minimum", MIN_VIEWPORT.cols - 1, MIN_VIEWPORT.rows],
  ["one row short of the minimum", MIN_VIEWPORT.cols, MIN_VIEWPORT.rows - 1],
];

describe("T10-N: a composed message is submittable only from a viewport that painted it", () => {
  it.each(BELOW_MINIMUM)("runs nothing when the painted viewport was %s, where the body is not on the frame", async (_name, cols, rows) => {
    const shell = drive(cols, rows);

    // The premise of the refusal, asserted rather than assumed: at this size the frame is the
    // degraded one, which carries no input row, so the operator can see nothing of what Enter
    // would send. §3.2 — "an operator in a 40×10 window would be submitting a body they cannot
    // see."
    const painted = shell.frames();
    expect(painted.length).toBeGreaterThan(0);
    const everything = painted.map((lines) => lines.join("\n")).join("\n");
    expect(everything).not.toContain(BODY);

    // …and the console says so, rather than appearing to have stopped responding — the same
    // courtesy `shell-chrome.ts:233` already extends to a waiting trust decision. Without this the
    // refusal above would be indistinguishable from a console that ignored the keystroke, and this
    // half of the test would pass on today's tree, where the input row does not exist at all.
    expect(everything).toMatch(/compos/i);

    shell.press("\r");
    await drain();

    expect(shell.requests).toEqual([]);

    // A refusal is not a dead end: the draft is still there and the console can still be left.
    // Ctrl-C rather than `q`, because `q` is text while composing (§3.1).
    shell.press(CTRL_C);
    await shell.finished;
  });

  it.each([
    ["exactly the minimum viewport", MIN_VIEWPORT.cols, MIN_VIEWPORT.rows],
    ["a comfortable viewport", 96, 28],
  ])("submits the composed body at %s, where the operator can see it", async (_name, cols, rows) => {
    const shell = drive(cols, rows);

    // The other half of the same gate, and the reason the refusals above cannot be passed by
    // breaking the feature: a shell that never stamps `renderedAt`, or a reducer that refuses every
    // submit, fails here — and so does a console that still cannot be typed into at all.
    const frames = shell.frames();
    expect((frames[frames.length - 1] ?? []).join("\n")).toContain(BODY);

    shell.press("\r");
    await drain();
    await drain();

    const first = shell.requests[0];
    expect(first?.command, `requests were ${JSON.stringify(shell.requests)}`).toBe("send");
    if (first?.command !== "send") throw new Error("unreachable: the assertion above has already failed");
    expect(first.to).toBe(CONTACT_ID);
    // The body travels on the request object, which `main.ts` writes to the child's STDIN;
    // `buildArgv` puts it in no token (`cli-bridge.ts:93-104`, pinned by
    // `cli-bridge.sendStdin.test.ts`). What is asserted here is only that what the operator typed
    // is what the request carries — byte for byte, with no newline appended (§8 Q3).
    expect(first.text).toBe(BODY);

    shell.press(CTRL_C);
    await shell.finished;
  });
});

/*
 * Not pinned here, and why:
 *
 * - Whether a SECOND Enter after a successful submit sends again. §2.2 item 6 restores the buffer
 *   only on failure, and §2.2's message-id rule ("the same id on an unchanged retry") makes a
 *   duplicate idempotent at the CLI, so a duplicate is not a hazard of the same size as the trust
 *   modal's double-`y`. It needs the message-id seam (design T-6) to state properly.
 * - Whether the submit emits a `send` → `history` SEQUENCE. §2.2 says it does and §3.3 gives the
 *   mechanism, but run sequences are the design's T-5, not this task. The assertion above reads
 *   `requests[0]` only, so a single request and a two-request sequence both satisfy it.
 */
