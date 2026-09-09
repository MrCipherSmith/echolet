import { describe, expect, it } from "vitest";
import { CLI_COMMANDS, type CliCommand, type CliOutcome, type CliRequest } from "./cli-bridge";
import type { OperatorState, ProfileView, StepOutcome } from "./state";
import { runTuiShell, type TuiIo } from "./tui-shell";

/*
 * Flow 004 T23 — AC5, on the console's own surfaces, over the whole command × exit-class matrix.
 *
 * `failure-text.test.ts` specifies the pure module. This file is the other half: that the console
 * actually SHOWS it, for every command the operator can start and every class the CLI can return,
 * and that it shows nothing else.
 *
 * ── Why the matrix is walked through the real shell ─────────────────────────────────────────
 *
 * The two surfaces that name an exit class are `tui-shell.ts:866` (the activity line, on every
 * frame, for all eight commands) and `profiles-pane.ts:85` (the registration checklist, for the
 * five child-spawning steps). 004-T18-verify measured that the checklist half is already total —
 * `profiles-pane.setup.test.ts:255-282`, five steps × four classes — and that the other three
 * commands "are covered by one sampled case". Rather than adding a second pane-level fixture, this
 * file drives the REAL `runTuiShell` through the REAL stdin `"data"` handler and reads the frame
 * that was actually painted, which is the only place both surfaces meet.
 *
 * Totality is proven the same way it is in `failure-text.test.ts`: the loop is over
 * `CLI_COMMANDS` × the four classes, the visited cells are collected in a set, and the set's size
 * is asserted to be the product. Nothing here is a hand-written 32-row fixture; a ninth command
 * would change the product and fail the count.
 *
 * ── Which cases are red today, and which are the pair ───────────────────────────────────────
 *
 * PIN (passes on this tree): the code and the exact class survive to a frame, and no other class
 * appears. That property is true today — the activity line is `${command} → ${code} (exit N)` —
 * and it is pinned here because it is half of AC5 and nothing covers it over the matrix. It would
 * pass vacuously on its own, so each PIN sits beside the RED that a console satisfying only the
 * PIN cannot pass.
 *
 * RED (fails on this tree): the frame also carries the explanation in words. `explain` is imported
 * DYNAMICALLY, inside the case, so this file's PINs run and report against the current tree
 * instead of the whole file failing to load while `failure-text.ts` does not exist.
 *
 * Shell-driven and pure: `runCli` and `now` are injected, there is no terminal, no process, no
 * store and no relay. This file therefore takes no timeout from
 * `apps/cli/test/childProcessTimeouts.ts` — it has none to take, and no millisecond literal
 * appears in it.
 */

const CLASSES = [2, 3, 4, 5] as const;
type FailureClass = (typeof CLASSES)[number];

/** One code the CLI demonstrably returns at each class (provenance in `failure-text.test.ts`). */
const REPRESENTATIVE: Readonly<Record<FailureClass, string>> = {
  2: "INVALID_CONFIGURATION",
  3: "PREKEY_BUNDLE_UNAVAILABLE",
  4: "RELAY_UNAVAILABLE",
  5: "PERSISTENCE_FAILURE",
};

const CR = String.fromCharCode(13);
const CTRL_C = String.fromCharCode(3);
const ESC = String.fromCharCode(27);
/** `${ESC}[H${ESC}[2J`, the prefix `paint()` writes before every frame (tui-shell.ts:548). */
const HOME = `${ESC}[H${ESC}[2J`;

const CONTACT_ID = "nps4faW9mNX62tZs5M0oqAWtn05cWtn9gCw0gM1JHA";
const CARD_PATH = "/tmp/echolet-demo/peer-card.json";
const PAINTED_AT = 1_757_000_000_000;

/**
 * Wide enough that a sentence has somewhere to go.
 *
 * At `MIN_VIEWPORT` (72×16) the activity line is one clipped row and the pane body is eleven, so a
 * console that had to choose would be choosing between the code and the words. AC5 is about what
 * the console says, not about what fits in the smallest window it supports, so the matrix is
 * measured at a terminal an operator plausibly has — and the code-and-class half is measured at
 * the minimum as well, in the last case of this file.
 */
const WIDE = { cols: 203, rows: 61 };

/**
 * A profile with no registration checklist and `state` deliberately absent.
 *
 * Absent rather than `"unknown"` so the startup `doctor` (`tui-shell.ts:926-936`) does not run and
 * every request counted below is one this file's keystrokes caused.
 */
const PLAIN_PROFILE: ProfileView = {
  label: "alice",
  profileDir: "/tmp/echolet-demo/alice",
  relayUrl: "http://127.0.0.1:18099",
  storeKeyEnv: "ECHOLET_E2E_KEY",
  identityId: "hbRYeNqVnWC74METcY57eDEkV9qNQ6Qzuz6RpsIYQA",
  deviceId: "733d80b0-e7e2-5e6c-ba84-0bcd96a373ea",
  contactCount: 1,
  published: true,
  contactCardPath: CARD_PATH,
};

/** The same profile with a checklist, so `Enter` on the profiles pane starts a registration step. */
function inSetup(setup: readonly StepOutcome[]): ProfileView {
  return { ...PLAIN_PROFILE, state: "ready", storeKeyPresent: true, setup };
}

const PENDING: readonly StepOutcome[] = ["pending", "pending", "pending", "pending", "pending", "pending"];
/** Steps 1 and 2 done, so `Enter` reaches step 3, `contact export`. */
const THROUGH_STEP_2: readonly StepOutcome[] = ["pending", "ok", "ok", "pending", "pending", "pending"];

function stateWith(profile: ProfileView, pane: OperatorState["pane"]): OperatorState {
  return {
    profiles: [profile],
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
    health: { relayUrl: profile.relayUrl, status: "unknown", uptimeMs: null, checkedAtMs: null },
    pane,
    modal: undefined,
    activity: [],
    busy: false,
  };
}

interface DrivenShell {
  readonly requests: readonly CliRequest[];
  readonly lastFrame: () => string;
  readonly press: (sequence: string) => void;
  readonly settle: (outcome: CliOutcome) => void;
  readonly finished: Promise<number>;
}

function drive(state: OperatorState, viewport: { cols: number; rows: number }): DrivenShell {
  const requests: CliRequest[] = [];
  const writes: string[] = [];
  const pending: Array<(outcome: CliOutcome) => void> = [];
  let emit: ((chunk: Buffer) => void) | undefined;

  const io: TuiIo = {
    stdout: { write: (chunk: string) => { writes.push(chunk); return true; }, columns: viewport.cols, rows: viewport.rows },
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
    lastFrame: () => {
      const painted = writes.filter((chunk) => chunk.startsWith(HOME)).at(-1) ?? "";
      // `styleFrame` writes SGR runs around parts of a row; the row TEXT is what the operator reads.
      return painted
        .split(`${ESC}[`)
        .map((part, index) => (index === 0 ? part : part.replace(/^[0-9;?]*[a-zA-Z]/, "")))
        .join("");
    },
    press: (sequence: string) => emit?.(Buffer.from(sequence, "utf8")),
    settle: (outcome: CliOutcome) => { pending.shift()?.(outcome); },
    finished,
  };
}

const drain = (): Promise<void> => new Promise<void>((resolve) => { setImmediate(resolve); });

/**
 * How each of the eight frozen commands is reached from the keyboard.
 *
 * Every entry is the state the operator would be in and the keys they would press — not a
 * synthesised `run` intent — because AC5 is about what the console shows the operator after a
 * command THEY started, and a synthesised request would skip the preconditions that decide which
 * pane the failure is painted on.
 */
const STARTERS: Readonly<Record<CliCommand, { readonly state: () => OperatorState; readonly keys: readonly string[] }>> = {
  poll: { state: () => stateWith(PLAIN_PROFILE, "mailbox"), keys: ["p"] },
  doctor: { state: () => stateWith(PLAIN_PROFILE, "profiles"), keys: ["d"] },
  "relay publish": { state: () => stateWith(PLAIN_PROFILE, "profiles"), keys: ["r"] },
  history: { state: () => stateWith(PLAIN_PROFILE, "history"), keys: ["h"] },
  "contact import": { state: () => stateWith(PLAIN_PROFILE, "profiles"), keys: ["i"] },
  // `w` opens the compose row on the conversation pane; the body then travels on the request
  // object and never in an argv (cli-bridge.ts:93-104).
  send: { state: () => stateWith(PLAIN_PROFILE, "history"), keys: ["w", "hello", CR] },
  // `Enter` on the profiles pane starts the next incomplete step: step 1 with nothing done…
  init: { state: () => stateWith(inSetup(PENDING), "profiles"), keys: [CR] },
  // …and step 3 with steps 1 and 2 done, which opens the export-path row before it runs.
  "contact export": { state: () => stateWith(inSetup(THROUGH_STEP_2), "profiles"), keys: [CR, CR] },
};

/** Starts `command` from the keyboard and returns the shell with that one request in flight. */
async function started(command: CliCommand, viewport = WIDE): Promise<DrivenShell> {
  const starter = STARTERS[command];
  const shell = drive(starter.state(), viewport);
  await drain();
  for (const key of starter.keys) {
    shell.press(key);
    await drain();
  }
  expect(
    shell.requests.map((request) => request.command),
    `the keystrokes for ${command} did not start exactly that command`,
  ).toEqual([command]);
  return shell;
}

const failure = (code: string, exitCode: number): CliOutcome => ({ ok: false, code, exitCode, data: null });

/** `exit N` as a whole number, so `exit 2` does not match inside a longer figure. */
const namesClass = (frame: string, exitCode: number): boolean => new RegExp(`exit ${String(exitCode)}(?![0-9])`).test(frame);

describe("T23-AC5-F: over the whole command × exit-class matrix, the console reports what the CLI returned", () => {
  it("PIN — carries the CLI's own code and exactly the class it returned, and no other class", async () => {
    const covered = new Set<string>();

    for (const command of CLI_COMMANDS) {
      for (const exitCode of CLASSES) {
        const code = REPRESENTATIVE[exitCode];
        const shell = await started(command);

        shell.settle(failure(code, exitCode));
        await drain();
        const frame = shell.lastFrame();

        expect(frame, `${command} at exit ${String(exitCode)}: the CLI's own code is not on the frame`).toContain(code);
        expect(
          namesClass(frame, exitCode),
          `${command} at exit ${String(exitCode)}: the class the CLI returned is not on the frame`,
        ).toBe(true);
        for (const other of CLASSES) {
          if (other === exitCode) continue;
          expect(
            namesClass(frame, other),
            `${command} at exit ${String(exitCode)}: the frame also reports exit ${String(other)}, a class the CLI did not return`,
          ).toBe(false);
        }

        covered.add(`${command} ${String(exitCode)}`);
        shell.press(CTRL_C);
        await shell.finished;
      }
    }

    expect(covered.size, "a cell of the command × exit-class matrix was skipped").toBe(CLI_COMMANDS.length * CLASSES.length);
    expect(covered.size).toBe(32);
  });

  it("RED — carries the explanation in words as well, for every cell of the same matrix", async () => {
    /*
     * The obligation AC5 adds to the one above: "presented with a MESSAGE that is accurate for the
     * command that produced it". `bd10b1d`'s own commit message lists the gap — "exit classes are
     * shown as the CLI's code and number rather than in words" — and 004-T18-verify quotes it.
     *
     * Imported here rather than at the top of the file so that the PIN above still runs and
     * reports while `failure-text.ts` does not exist. On the current tree this case fails at the
     * import; once the module exists it fails on the first cell whose sentence is not painted.
     */
    const { explain } = await import("./failure-text");
    const silent: string[] = [];

    for (const command of CLI_COMMANDS) {
      for (const exitCode of CLASSES) {
        const code = REPRESENTATIVE[exitCode];
        const shell = await started(command);

        shell.settle(failure(code, exitCode));
        await drain();
        const frame = shell.lastFrame();
        const text = explain(command, code, exitCode);

        if (!frame.includes(text.sentence)) silent.push(`${command} / ${code} (exit ${String(exitCode)})`);

        shell.press(CTRL_C);
        await shell.finished;
      }
    }

    expect(
      silent,
      "these cells were shown to the operator as a code and a number, with the sentence that explains them painted nowhere",
    ).toEqual([]);
  });

  it("PIN — names no exit class at all when the command succeeded", async () => {
    // The pair for the two above, and the property they cannot carry: a console that painted a
    // class on every frame would satisfy the code-and-class PIN and would tell the operator a
    // successful poll failed.
    for (const command of CLI_COMMANDS) {
      const shell = await started(command);

      shell.settle({ ok: true, code: "ok", exitCode: 0, data: {} });
      await drain();
      const frame = shell.lastFrame();

      for (const other of CLASSES) {
        expect(
          namesClass(frame, other),
          `${command} succeeded and the console reported exit ${String(other)} anyway`,
        ).toBe(false);
      }

      shell.press(CTRL_C);
      await shell.finished;
    }
  });

  it("PIN — keeps the code and the class at the minimum viewport, where the sentence may not fit", async () => {
    // The floor. `MIN_VIEWPORT` is 72×16 (shell-chrome.ts:39) and the activity line is one clipped
    // row there, so the words may have nowhere to go — but the code and the number an operator
    // quotes in a bug report must survive at every size the console claims to support.
    for (const exitCode of CLASSES) {
      const code = REPRESENTATIVE[exitCode];
      const shell = await started("poll", { cols: 72, rows: 16 });

      shell.settle(failure(code, exitCode));
      await drain();
      const frame = shell.lastFrame();

      expect(frame, `poll at exit ${String(exitCode)}: the code did not survive the minimum viewport`).toContain(code);
      expect(namesClass(frame, exitCode), `poll at exit ${String(exitCode)}: the class did not survive the minimum viewport`).toBe(true);

      shell.press(CTRL_C);
      await shell.finished;
    }
  });
});
