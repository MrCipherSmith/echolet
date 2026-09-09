import { describe, expect, it } from "vitest";
import type { CliOutcome, CliRequest } from "./cli-bridge";
import type { OperatorState } from "./state";
import { runTuiShell, type TuiIo } from "./tui-shell";

/*
 * Flow 004 T21 — the three decisions inside the keystroke fix, pinned one at a time.
 *
 * MEASURED (004-T18-verify, F-002/F-003/F-004). `bd10b1d` split one raw chunk into the keystrokes it
 * carries, because a pipe delivers `Enter` and `?` typed back to back as the single chunk `"\r?"`
 * and the decoder read that as Ctrl-M, losing BOTH keys with no frame painted — a console that
 * looks hung. The fix states three separable properties, and the verifier mutated each one on its
 * own against the whole `src/tui` suite:
 *
 *   K2  split the ESC sequence too   `return [...chunk]`                    SURVIVED, 284/284, exit 0
 *   K3  split while composing        unconditional `splitKeystrokes(text)`  SURVIVED, 284/284, exit 0
 *   K1  do not split at all          `return [chunk]`                       killed — by a 45s TIMEOUT
 *                                                                           inside a test named for
 *                                                                           the store key (F-004)
 *
 * Two of the three properties are therefore load-bearing and unpinned, and the third reports as a
 * timeout in a test about something else. This file gives each of them a named home:
 *
 *   K2 — under it, `ESC [ D` becomes three keystrokes ending in `D`, which `decodeKey` lower-cases
 *        to `d`: A LEFT ARROW SPAWNS `doctor` against the encrypted store. `ESC [ C` reaches the
 *        contact binding the same way.
 *   K3 — under it, a paste is no longer one insertion, so a body carrying a carriage return SUBMITS
 *        THE DRAFT MID-PASTE: the operator sends half a message and types the rest into whatever
 *        state follows.
 *   K1 — under it, two keys pressed together are both lost. Pinned here as a 4-millisecond
 *        assertion rather than as the 45-second wait that is its only cover today.
 *
 * NONE of these is red on the current tree: the code is correct and this file is the missing test.
 * Each case is written so that it fails against exactly one of the three mutations and passes on
 * the tree as it stands, and each is paired with a case that a console broken in the opposite
 * direction — one that spawns nothing, submits nothing, or never opens the help list — cannot pass.
 *
 * It spawns nothing and reads no clock: `runCli` and `now` are injected, there is no terminal, no
 * store and no relay. It therefore takes no timeout from `apps/cli/test/childProcessTimeouts.ts` —
 * it has none to take, and no millisecond literal appears anywhere in it.
 */

const ESC = String.fromCharCode(27);
const CR = String.fromCharCode(13);
const CTRL_C = String.fromCharCode(3);

/** The four arrow keys as a terminal actually sends them: `ESC [ A..D`, one chunk each. */
const ARROW_LEFT = `${ESC}[D`;
const ARROW_RIGHT = `${ESC}[C`;
const ARROW_UP = `${ESC}[A`;
const ARROW_DOWN = `${ESC}[B`;

const CONTACT_ID = "nps4faW9mNX62tZs5M0oqAWtn05cWtn9gCw0gM1JHA";
const OTHER_CONTACT_ID = "Yb2QeNqVnWC74METcY57eDEkV9qNQ6Qzuz6RpsIYQA";

/** A painted frame's timestamp. Any non-null value satisfies the painted-at gates; this one is fixed. */
const PAINTED_AT = 1_757_000_000_000;

/**
 * A console that can send: a published profile, a selected contact, the conversation pane, no child
 * alive. `state` is deliberately ABSENT rather than `"unknown"`, so the startup `doctor` does not
 * run and every request counted below is one this test's keystrokes caused.
 */
function baseState(overrides: Partial<OperatorState> = {}): OperatorState {
  return {
    profiles: [{
      label: "alice",
      profileDir: "/tmp/echolet-demo/alice",
      relayUrl: "http://127.0.0.1:18099",
      storeKeyEnv: "ECHOLET_E2E_KEY",
      identityId: "hbRYeNqVnWC74METcY57eDEkV9qNQ6Qzuz6RpsIYQA",
      deviceId: "733d80b0-e7e2-5e6c-ba84-0bcd96a373ea",
      contactCount: 2,
      published: true,
    }],
    activeProfile: 0,
    contacts: [
      { identityId: CONTACT_ID, deviceId: "9f0c4a11-2b3c-4d5e-8f60-71829a3b4c5d", devicePubkey: "npsPUBKEY_aW9mNX62tZs5M0oqAWtn05cWtn9gCw0gM", signalIdentityKey: "BQdNjP6tbN00N3eS6DNpmKpMDFDeDa4MFuUO1QWt8i" },
      { identityId: OTHER_CONTACT_ID, deviceId: "1a2b3c4d-5e6f-4a5b-8c9d-0e1f2a3b4c5d", devicePubkey: "npsPUBKEY_OTHERaW9mNX62tZs5M0oqAWtn05cWtn", signalIdentityKey: "BQotherjP6tbN00N3eS6DNpmKpMDFDeDa4MFuUO1Q" },
    ],
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

/** Lets every already-queued microtask run. A drain, not a delay: nothing here is on a timer. */
const drain = (): Promise<void> => new Promise<void>((resolve) => { setImmediate(resolve); });

interface DrivenShell {
  /** Every request the shell actually asked to run, in order. */
  readonly requests: readonly CliRequest[];
  /** Every chunk the shell wrote to the terminal, in order. A keystroke it refuses paints nothing. */
  readonly writes: readonly string[];
  readonly press: (sequence: string) => void;
  readonly finished: Promise<number>;
}

/**
 * The real `runTuiShell`, driven through the real `stdin` `"data"` handler.
 *
 * The handler is where `splitKeystrokes` is CALLED and where the compose-row guard lives, which is
 * why every case here goes through the shell rather than through `reduce`: the existing paste test
 * (`tui-shell.input.test.ts:188`) drives the reducer directly and therefore cannot reach the branch
 * F-003 names. `runCli` never settles, so a child stays alive exactly as long as the test wants.
 */
function drive(state: OperatorState): DrivenShell {
  const requests: CliRequest[] = [];
  const writes: string[] = [];
  let emit: ((chunk: Buffer) => void) | undefined;

  const io: TuiIo = {
    stdout: { write: (chunk: string) => { writes.push(chunk); return true; }, columns: 96, rows: 28 },
    stdin: {
      on: (event: string, handler: (chunk: Buffer) => void) => { if (event === "data") emit = handler; return undefined; },
      resume: () => undefined,
      pause: () => undefined,
    },
    now: () => PAINTED_AT,
    runCli: (request: CliRequest) => {
      requests.push(request);
      return new Promise<CliOutcome>(() => { /* held alive, deliberately */ });
    },
    answerTrustPrompt: () => undefined,
  };

  const finished = runTuiShell(io, state);
  // One chunk, exactly as a terminal delivers it. `Buffer.from` is what `main.ts` hands the handler.
  return { requests, writes, press: (sequence: string) => emit?.(Buffer.from(sequence, "utf8")), finished };
}

describe("T21-A: an escape sequence is one keystroke, so an arrow key starts nothing", () => {
  it("spawns no child and repaints nothing when an arrow key is pressed", async () => {
    const shell = drive(baseState());
    await drain();

    for (const arrow of [ARROW_LEFT, ARROW_RIGHT, ARROW_UP, ARROW_DOWN]) {
      const paintsBefore = shell.writes.length;
      shell.press(arrow);
      await drain();

      // The sharp one is the LEFT arrow: `ESC [ D` split into three keystrokes ends in `D`, which
      // `decodeKey` lower-cases to `d` — the `doctor` binding — so an arrow key spawns a child
      // against the encrypted store. The RIGHT arrow ends in `C` and reaches the contact binding,
      // which changes the selection and therefore repaints; up and down end in unbound letters and
      // are here for totality over the four keys a terminal actually sends.
      expect(
        shell.requests.map((request) => request.command),
        `an arrow key started a command: ${JSON.stringify(arrow)} was decoded as more than one keystroke`,
      ).toEqual([]);
      expect(
        shell.writes.length - paintsBefore,
        `an arrow key changed the screen: ${JSON.stringify(arrow)} was decoded as more than one keystroke`,
      ).toBe(0);
    }

    shell.press(CTRL_C);
    await shell.finished;
  });

  it("still starts a command when the operator presses that letter themselves", async () => {
    // The pair, and the reason the refusal above cannot be passed by breaking the console: a shell
    // that ignored every keystroke would satisfy every assertion in the case above.
    const shell = drive(baseState());
    await drain();

    shell.press("d");
    await drain();

    expect(shell.requests.map((request) => request.command)).toEqual(["doctor"]);

    shell.press(CTRL_C);
    await shell.finished;
  });

  it("treats a bare Escape as a cancel and not as the head of a sequence", async () => {
    // The other half of the ESC branch: `ESC` alone is a keystroke of its own — it cancels an open
    // compose row — and a lone `ESC` outside one is a no-op rather than the start of anything.
    const shell = drive(baseState());
    await drain();

    shell.press("w");
    await drain();
    expect(shell.writes.at(-1) ?? "", "the compose row did not open").toContain("message ▸");

    shell.press(ESC);
    await drain();
    expect(shell.writes.at(-1) ?? "", "Escape did not close the compose row").not.toContain("message ▸");
    expect(shell.requests).toEqual([]);

    shell.press(CTRL_C);
    await shell.finished;
  });
});

describe("T21-B: while the compose row is open a chunk is TEXT, so a paste is one insertion", () => {
  it("does not submit a draft part-way through a paste that carries a carriage return", async () => {
    const shell = drive(baseState());
    await drain();

    shell.press("w");
    await drain();
    expect(shell.writes.at(-1) ?? "", "the compose row did not open").toContain("message ▸");

    // ONE chunk, the way a terminal delivers a paste. The carriage return inside it is a character
    // of the pasted body — a line break in the text the operator copied — and not a decision.
    shell.press(`hello${CR}world`);
    await drain();

    expect(
      shell.requests.map((request) => request.command),
      "a paste containing a carriage return submitted the draft mid-paste: the operator sent half a message they never finished writing",
    ).toEqual([]);
    // The whole paste is in the buffer, minus the control point the boundary filters. Under the
    // mutation the tail is typed into whatever state follows the send instead.
    expect(shell.writes.at(-1) ?? "", "the tail of the paste did not reach the buffer").toContain("helloworld");

    shell.press(CTRL_C);
    await shell.finished;
  });

  it("still sends when the operator presses Enter on its own", async () => {
    // The pair. A console that never submitted would pass the case above and would be a console the
    // operator cannot send from.
    const shell = drive(baseState());
    await drain();

    shell.press("w");
    await drain();
    shell.press("hello");
    await drain();
    shell.press(CR);
    await drain();

    expect(shell.requests.map((request) => request.command)).toEqual(["send"]);
    const sent = shell.requests[0];
    expect(sent !== undefined && sent.command === "send" ? sent.text : "").toBe("hello");

    shell.press(CTRL_C);
    await shell.finished;
  });
});

describe("T21-C: two keys pressed together are two keystrokes, both of them the operator's", () => {
  it("acts on the second key of a chunk the terminal coalesced", async () => {
    /*
     * The measured defect `bd10b1d` fixed, as a named assertion rather than as a wait.
     *
     * `Enter` and `?` typed back to back arrive as the single chunk `"\r?"`, and the decoder read
     * that as Ctrl-M: BOTH keystrokes vanished and no frame was painted. Its only cover today is
     * `main.registration.processDriven.test.ts:553`, a test named for the store key, which reports
     * the regression as `timed out waiting for a frame containing "key bindings"` after 45 seconds.
     *
     * The pane is `history`, where `Enter` is bound to nothing, so this measures the SECOND key
     * surviving and not a step being started.
     */
    const shell = drive(baseState());
    await drain();

    expect(shell.writes.at(-1) ?? "", "the help list was already open, so the assertion below would prove nothing")
      .not.toContain("key bindings");

    shell.press(`${CR}?`);
    await drain();

    expect(
      shell.writes.at(-1) ?? "",
      "the '?' after a coalesced Enter was lost: one chunk carrying two keystrokes was decoded as one",
    ).toContain("key bindings");

    shell.press(CTRL_C);
    await shell.finished;
  });

  it("refuses the second command of a burst, because single-flight is decided synchronously", async () => {
    // Splitting a burst must not become a way past D-1. `reduce` sets `busy` synchronously, so the
    // second key of `"pd"` meets a console that is already running one command — the same refusal a
    // second keystroke a second later would meet.
    const shell = drive(baseState());
    await drain();

    shell.press("pd");
    await drain();

    expect(
      shell.requests.map((request) => request.command),
      "a coalesced burst spawned two children against the same encrypted store",
    ).toEqual(["poll"]);

    shell.press(CTRL_C);
    await shell.finished;
  });
});
