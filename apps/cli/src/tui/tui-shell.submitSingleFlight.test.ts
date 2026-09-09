import { describe, expect, it } from "vitest";
import type { CliOutcome, CliRequest } from "./cli-bridge";
import type { InputState, OperatorState } from "./state";
import { reduce, runTuiShell, type Intent, type TuiIo } from "./tui-shell";

/*
 * Flow 004 T13 — D-1 on the SUBMIT path. RED.
 *
 * MEASURED (004-T12-verify, F-001): deleting `busy: true` from `reduce`'s `input-submit` case
 * (`tui-shell.ts:289`) leaves all 174 tests under `src/tui` green — 22 files, vitest exit 0. The
 * one-command-in-flight gate that flow 003 built for `run` was never given to the path flow 004
 * added, so it decays silently, in exactly the way flow 003 T25 measured the paint gate decaying.
 *
 * It is reachable, not theoretical. The verifier's probe pressed Enter and then `p` while the send
 * child was still alive and the mutant issued `['send', 'poll']` where the correct tree issues
 * `['send']`: two children against ONE encrypted SQLite store. That is the precise mechanism flow
 * 003 T2 §3.1 Run C recorded — `p p p d` produced two `PERSISTENCE_FAILURE (exit 5)` results and one
 * success, so the console manufactured its most alarming exit class out of key-mashing. A `send` is
 * a worse case than a `poll`, because the second writer meets the store while the first is
 * committing an outbox row, and the operator's own message is what is at stake.
 *
 * The current tree is CORRECT. This file is a missing test, not a live defect: it fails only against
 * the mutant, which is why it is written as three independent pins rather than one — the reducer's
 * own postcondition, the deep refusal `mapKey` cannot reach, and the behaviour through the real
 * shell. `tui-shell.singleFlight.test.ts` holds the same three for `run`; this holds them for
 * `input-submit`, which is the member of that class it does not cover.
 *
 * It spawns nothing: `runCli` is an injected function, there is no terminal, no clock, no store and
 * no relay. It therefore takes no timeout from `test/childProcessTimeouts.ts` — it has none to take,
 * and no millisecond literal appears anywhere in it.
 */

const CONTACT_ID = "nps4faW9mNX62tZs5M0oqAWtn05cWtn9gCw0gM1JHA";
const CTRL_C = String.fromCharCode(3);

/** Distinctive, and a message body rather than key material: exactly what a submit may carry. */
const BODY = "SYNTHETIC_SINGLE_FLIGHT_BODY";

/** A painted frame's timestamp. Any non-null value satisfies §3.2's gate; this one is fixed. */
const PAINTED_AT = 1_757_000_000_000;

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
    pane: "history",
    modal: undefined,
    activity: [],
    busy: false,
    ...overrides,
  };
}

/** A state with the compose row open and already painted, so the §3.2 submit gate is satisfied. */
function composing(input: Partial<InputState> = {}, overrides: Partial<OperatorState> = {}): OperatorState {
  const open: InputState = { field: "message", buffer: BODY, renderedAt: PAINTED_AT, maxBytes: 65_536, ...input };
  return { ...baseState(overrides), input: open };
}

const SUBMIT: Intent = { kind: "input-submit" };

/**
 * Lets every already-queued microtask run.
 *
 * Copied in shape from `tui-shell.inputViewport.test.ts`: the shell applies its effects from an
 * async IIFE, so an effect lands one microtask after the keystroke. This is a drain, not a delay —
 * nothing in this suite is on a timer.
 */
const drain = (): Promise<void> => new Promise<void>((resolve) => { setImmediate(resolve); });

interface DrivenShell {
  /** Every request the shell actually asked to run, in order. */
  readonly requests: readonly CliRequest[];
  readonly press: (sequence: string) => void;
  /** Settles the child that is currently in flight, the way a real one exits. */
  readonly settle: (outcome: CliOutcome) => void;
  readonly finished: Promise<number>;
}

/**
 * The real `runTuiShell`, at a viewport that paints the compose row, with the child held ALIVE.
 *
 * `runCli` returns a promise this test settles by hand, so "while the send is in flight" is a state
 * the test controls exactly rather than a race it hopes for. No timer, no clock, no process.
 */
function drive(state: OperatorState): DrivenShell {
  const requests: CliRequest[] = [];
  const pending: ((outcome: CliOutcome) => void)[] = [];
  let emit: ((chunk: Buffer) => void) | undefined;

  const io: TuiIo = {
    stdout: { write: () => true, columns: 96, rows: 28 },
    stdin: {
      on: (event: string, handler: (chunk: Buffer) => void) => { if (event === "data") emit = handler; return undefined; },
      resume: () => undefined,
      pause: () => undefined,
    },
    now: () => PAINTED_AT,
    runCli: (request: CliRequest) => {
      requests.push(request);
      return new Promise<CliOutcome>((resolve) => { pending.push(resolve); });
    },
    answerTrustPrompt: () => undefined,
  };

  const finished = runTuiShell(io, state);

  return {
    requests,
    press: (sequence: string) => emit?.(Buffer.from(sequence, "utf8")),
    settle: (outcome: CliOutcome) => { pending.shift()?.(outcome); },
    finished,
  };
}

describe("T13-A: a submit puts the console in flight, the way a command key does", () => {
  it("sets busy on the state it returns, so the same gate `run` sets is set here too", () => {
    // The surviving mutation, killed directly: `tui-shell.ts:289` returning
    // `{ ...state, input: undefined }` instead of `{ ...state, input: undefined, busy: true }`
    // passes every other test in `src/tui`.
    const step = reduce(composing(), SUBMIT);

    expect(step.effects.filter((effect) => effect.kind === "run-cli").length).toBe(1);
    expect(step.state.busy).toBe(true);
    // The row closes on submit, so nothing can be typed into a message that is already being sent.
    expect((step.state as { readonly input?: unknown }).input).toBeUndefined();
  });

  it("refuses a submit that arrives while a child is already alive, and keeps the draft", () => {
    // The deep half, held in the reducer for the reason `run`'s deep half at `tui-shell.ts:212` is:
    // a submit arriving from anywhere — a stray keystroke, a resize race, a future scripted mode —
    // meets the same precondition. `mapKey` cannot reach this state today, because nothing opens the
    // row while `busy`; that is why deleting `|| state.busy` from `tui-shell.ts:279` is invisible to
    // every other test, and why the pin belongs on the reducer rather than on a keystroke.
    const busy = composing({}, { busy: true });
    const before = JSON.stringify(busy);
    const step = reduce(busy, SUBMIT);

    expect(step.effects).toEqual([]);
    // A refusal, not a correction: the draft survives, exactly as it does below MIN_VIEWPORT.
    expect(JSON.stringify(step.state)).toBe(before);
  });
});

describe("T13-B: driven — one command at a time, across the submit", () => {
  it("starts no second child when a command key is pressed while the send is in flight", async () => {
    const shell = drive(composing({ renderedAt: null }));

    // Enter submits. `renderedAt` is null in the initial state and is stamped by the shell's first
    // paint, so this exercises the real gate rather than a pre-satisfied one.
    shell.press("\r");
    await drain();
    expect(shell.requests.map((request) => request.command)).toEqual(["send"]);

    // …and now the hazard. Each of these is a `run` against the SAME encrypted store while the send
    // child is still alive. The keystrokes are delivered synchronously, the way a terminal delivers
    // key-mashing, and the send is deliberately still unsettled.
    for (const command of ["p", "d", "r"]) shell.press(command);
    await drain();

    expect(
      shell.requests.map((request) => request.command),
      "a second child was spawned against the same encrypted store while the send was in flight",
    ).toEqual(["send"]);

    shell.press(CTRL_C);
    await shell.finished;
  });

  it("accepts the next command once the send has finished, so the gate is a gate and not a wall", async () => {
    // The other direction, and the reason the refusal above cannot be passed by breaking the
    // console: a shell that set `busy` and never cleared it would satisfy every assertion in the
    // test above and leave the operator with a console that answers no command key ever again.
    const shell = drive(composing({ renderedAt: null }));

    shell.press("\r");
    await drain();
    shell.settle({ ok: true, code: "ok", exitCode: 0, data: null });
    await drain();
    await drain();

    shell.press("p");
    await drain();

    expect(shell.requests.map((request) => request.command)).toEqual(["send", "poll"]);

    shell.press(CTRL_C);
    await shell.finished;
  });
});

/*
 * Not pinned here, and why:
 *
 * - WHAT THE FRAME SAYS WHILE THE SEND IS IN FLIGHT. `activityLine` (shell-chrome.ts:177) already
 *   prefixes every busy frame with "running… (busy — a command key starts nothing)", and
 *   `tui-shell.singleFlight.test.ts` pins that text against the same `state.busy` this file sets.
 *   Repeating it here would pin one sentence twice and nothing new once.
 * - WHETHER A SECOND ENTER RESENDS. The row closes on submit, so a second Enter has no buffer to
 *   send; the duplicate-send question proper needs the message-id seam (design T-6) and is recorded
 *   as unpinned in `tui-shell.inputViewport.test.ts`.
 */
