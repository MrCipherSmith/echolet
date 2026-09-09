import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { CLI_CHILD_TIMEOUT_MS, CLI_TEST_TIMEOUT_MS } from "../../test/childProcessTimeouts";
import type { CliOutcome, CliRequest } from "./cli-bridge";
import { UNAUDITED_NOTICE } from "./shell-chrome";
import { type OperatorState, type ProfileView } from "./state";
import { runTuiShell, type TuiIo } from "./tui-shell";

/**
 * Flow 004, T30 — what Ctrl-C owes an operator when a command is still running. Written red.
 *
 * ── WHAT WAS MEASURED ──────────────────────────────────────────────────────────────────────────
 *
 * 004-T29-verify F-004, against the shipped `dist/tui.js` driving the shipped `dist/cli.js` at the
 * operator's own relay: Ctrl-C pressed while a real six-second `relay publish` was in flight
 * returned the TERMINAL in 0 ms — raw mode off, alternate screen exited — and the PROCESS exited
 * 5972 ms later, when the child finished. `main.ts` sets `process.exitCode` and returns; Node cannot
 * exit while a spawned child is alive, and nothing kills the child. There is no SIGINT or SIGTERM
 * handler anywhere in `apps/cli/src` (zero matches over 91 files, taken from the raw log).
 *
 * So the operator gets their own screen back, empty, with no prompt and nothing painted, for as long
 * as the child runs — `relay publish` was measured at ~20 s under contention by flow 003 T16 — while
 * a process they believe is gone still holds a child writing to their encrypted store. Worse, the
 * console then writes a SECOND alternate-screen restore when that child finally settles, because the
 * pending `apply` reaches `if (running) paint(); else finish();` long after `finish()` already ran.
 *
 * ── WHAT THIS FILE SPECIFIES, AND WHY IT IS THAT AND NOT THE OTHER THING ────────────────────────
 *
 * There are two honest answers and this file picks one deliberately.
 *
 * NOT CHOSEN — kill the child. The child is the only process holding the store key; it is midway
 * through an encrypted-SQLite transaction and, for `relay publish`, midway through minting and
 * publishing a prekey pool a peer may already be fetching from. `PERSISTENCE_FAILURE` at exit 5 is
 * what this project has measured a store doing to a writer that was interrupted, and turning the
 * operator's escape key into a source of that class would be the console manufacturing its most
 * alarming failure out of its most ordinary act. An operator can always escalate to their own
 * terminal's signal; the console must not do it FOR them, silently, as the meaning of `q`.
 *
 * CHOSEN — let it finish, and say so, on the screen the operator gets back. Three obligations:
 *
 *   1. The terminal is given back AT ONCE — raw mode off, alternate screen exited — which is what
 *      the console already does and what AC8 requires of it.
 *   2. It then says, in one line on the operator's REAL screen, that a command is still running and
 *      which one. That line is the whole repair: everything else about today's behaviour is
 *      defensible, and the only thing wrong is that it happens in silence.
 *   3. The process does not close before that child does. Today that holds only by accident — Node
 *      cannot exit while a child it spawned is alive — and nothing in the tree says it must, so a
 *      later `process.exit(code)` would orphan a writer mid-transaction and nothing would notice.
 *
 * The line has to come AFTER the alternate screen is restored. Written before it, it is painted on
 * the alternate screen and vanishes with it — which is the same non-event as printing nothing.
 *
 * Naming the command is part of the obligation, not decoration: "doctor" is a fifth of a second and
 * touches no relay, `relay publish` is twenty and writes to the store. An operator deciding whether
 * to reach for their own kill needs to know which of those they are waiting on.
 *
 * ── WHAT THIS FILE DELIBERATELY DOES NOT SPECIFY, HAVING TRIED IT AND MEASURED THE COST ─────────
 *
 * `runTuiShell` must NOT be made to await the in-flight child before it resolves. That was the first
 * shape of this file, and it is wrong: `tui-shell.wayOut.test.ts` and `tui-shell.singleFlight.test.ts`
 * both drive the shell with a `runCli` that NEVER SETTLES and require the session to end anyway —
 * which is AC8 itself. A shell that waited for its child before reporting the session over would
 * trap the operator inside a hung CLI, turning the way out into a way out only if the child felt
 * like it. (Measured: the experiment turned three tests in those two files into timeouts.)
 *
 * So the waiting belongs where it already is — the process, held by its own child — and what is owed
 * is the LINE that explains it plus a pin that the process keeps doing it.
 *
 * ── ONE CONSTRAINT ON HOW THE LINE IS WRITTEN ──────────────────────────────────────────────────
 *
 * `tui-shell.wayOut.test.ts`'s `frames()` helper treats EVERY non-empty chunk written to stdout as a
 * painted frame and asserts its shape against the viewport, so it will read this line as a frame
 * too. A line clipped to the terminal's own width and written without a trailing newline satisfies
 * that helper at every viewport it sweeps, including 1x1. Anything wider, or ending in `\r\n`, makes
 * that file red — and this file's author may not edit it to make room, so it is recorded here as the
 * shape the repair has to take. (Sizing the line to the terminal is what the rest of this console
 * does with every line it writes, so this is a constraint that agrees with the design.)
 *
 * ── WHAT IS OUT OF SCOPE, STATED RATHER THAN QUIETLY OMITTED ────────────────────────────────────
 *
 * Escalation — a SECOND Ctrl-C at a real terminal signalling the process group — is not pinned here
 * and cannot be: these harnesses drive the console over a pipe, and a pipe generates no SIGINT.
 * 004-T25 F-005 already names a pty harness as a separate slice, and F-004's escalation claim is
 * explicitly an inference from tty semantics rather than a measurement. Nothing in this file assumes
 * it either way.
 */

/*
 * ══ PART ONE: the shell, in process ════════════════════════════════════════════════════════════
 *
 * `runTuiShell` is the layer that KNOWS a command is in flight — `busy` is its own state and the
 * `run-cli` effect is its own await — and it is the only layer that does. `main.ts` holds the child
 * but has no idea a key was pressed; the operator holds the keyboard but has no idea a child exists.
 * So the sentence is owed here, and these two tests pin that it is said and that it is not said
 * when it would be false.
 */

/** An instant, not a duration. */
const OBSERVED_AT_MS = Date.UTC(2026, 8, 9);

const CTRL_C = String.fromCharCode(3);
const ESC = String.fromCharCode(27);
const ALTERNATE_SCREEN_OFF = `${ESC}[?25h${ESC}[?1049l`;

/**
 * The words that make a pause explicable. Any of them will do — this file pins that the console
 * says a command is still running, not how it phrases it — and the command's own name must appear
 * beside them.
 */
const WAITING_WORDS = ["still running", "still finishing", "not finished", "waiting", "in flight"];

function saysSomethingIsStillRunning(text: string, command: string): boolean {
  const lowered = text.toLowerCase();
  return lowered.includes(command) && WAITING_WORDS.some((word) => lowered.includes(word));
}

/**
 * Drains every pending microtask.
 *
 * `setImmediate` runs in the check phase, after the microtask queue is empty, so awaiting one is an
 * ORDERING fact rather than a delay: whatever the shell was going to do without waiting for anything
 * has happened by the time this resolves. No duration is involved, and nothing here sleeps.
 */
const flush = (): Promise<void> => new Promise<void>((done) => { setImmediate(done); });

interface Harness {
  readonly io: TuiIo;
  readonly writes: string[];
  readonly requests: CliRequest[];
  press(key: string): void;
  /** Settles the child the console is waiting on, as the CLI would. */
  settleChild(outcome: CliOutcome): void;
}

function inProcessHarness(): Harness {
  const writes: string[] = [];
  const requests: CliRequest[] = [];
  let emit: ((chunk: Buffer) => void) | undefined;
  let settle: ((outcome: CliOutcome) => void) | undefined;

  const io: TuiIo = {
    stdout: { write: (chunk: string) => { writes.push(chunk); return true; }, columns: 120, rows: 40 },
    stdin: {
      setRawMode: () => undefined,
      on: (event: string, handler: (chunk: Buffer) => void) => { if (event === "data") emit = handler; return undefined; },
      resume: () => undefined,
      pause: () => undefined,
    },
    now: () => OBSERVED_AT_MS,
    runCli: (request: CliRequest) => {
      requests.push(request);
      return new Promise<CliOutcome>((done) => { settle = done; });
    },
    answerTrustPrompt: () => undefined,
  };

  return {
    io,
    writes,
    requests,
    press: (key: string) => { emit?.(Buffer.from(key, "utf8")); },
    settleChild: (outcome: CliOutcome) => { settle?.(outcome); },
  };
}

function readyState(): OperatorState {
  const profile: ProfileView = {
    label: "alice",
    profileDir: "/tmp/echolet-quit-in-flight/alice",
    relayUrl: "http://127.0.0.1:18099",
    storeKeyEnv: "ECHOLET_QUIT_IN_FLIGHT_KEY",
    identityId: "hbRYeNqVnWC74METcY57eDEkV9qNQ6Qzuz6RpsIYQA",
    deviceId: "733d80b0-e7e2-5e6c-ba84-0bcd96a373ea",
    contactCount: 1,
    published: true,
    // `"ready"` on purpose: the startup `doctor` must NOT run, so the only child in this test is the
    // one the operator pressed for and the assertions are about that one.
    state: "ready",
    storeKeyPresent: true,
    setup: ["ok", "ok", "ok", "ok", "ok", "ok"],
  };
  return {
    profiles: [profile],
    activeProfile: 0,
    contacts: [],
    selectedContactId: null,
    mailbox: { outboxPending: null, inboxReceived: null, more: false, lastPolledAtMs: null },
    rejections: [],
    history: [],
    health: { relayUrl: profile.relayUrl, status: "unknown", uptimeMs: null, checkedAtMs: null },
    pane: "profiles",
    modal: undefined,
    activity: [],
    busy: false,
    observedAtMs: OBSERVED_AT_MS,
  };
}

const PUBLISH_OK: CliOutcome = { ok: true, code: "ok", exitCode: 0, data: {} };

describe("Ctrl-C with a command in flight: the console does not say it is gone while it is not", () => {
  /*
   * RED. The terminal comes back in 0 ms and nothing is written after it, so an operator watching
   * their own screen has no evidence that anything is still happening — and no name for what they
   * would be killing if they reached for their own signal.
   *
   * The needle is looked for AFTER the FIRST alternate-screen restore, deliberately: text written
   * before it is painted on a screen that is about to be thrown away, and today a SECOND restore is
   * written later still, when the forgotten child settles and the pending `apply` reaches
   * `if (running) paint(); else finish();` — escape sequences arriving at a terminal the console
   * announced it had given back six seconds earlier.
   */
  it("says, on the screen it gives back, that a command is still running and which one", async () => {
    const operator = inProcessHarness();
    const finished = runTuiShell(operator.io, readyState());

    operator.press("r");
    await flush();
    expect(operator.requests.map((request) => request.command), "the keystroke started no command").toEqual(["relay publish"]);

    operator.press(CTRL_C);
    await flush();

    const painted = operator.writes.join("");
    const restoredAt = painted.indexOf(ALTERNATE_SCREEN_OFF);
    expect(restoredAt, "the console never gave the terminal back").toBeGreaterThanOrEqual(0);

    const afterwards = painted.slice(restoredAt + ALTERNATE_SCREEN_OFF.length);
    expect(
      saysSomethingIsStillRunning(afterwards, "relay publish"),
      "nothing on the operator's own screen says a command is still running: "
      + `${JSON.stringify(afterwards)} — expected the command's name and one of ${WAITING_WORDS.join(" / ")}`,
    ).toBe(true);

    operator.settleChild(PUBLISH_OK);
    expect(await finished).toBe(0);
  });

  /*
   * GREEN today, and it is the pair for the two above: it kills the degenerate repair that satisfies
   * them by always waiting and always warning. A console that announced a command whenever it left
   * would be crying wolf on the one line an operator is now being asked to read, and one that
   * awaited something that was never started would hang on every ordinary quit.
   */
  it("says nothing of the kind, and leaves at once, when nothing is running", async () => {
    const operator = inProcessHarness();
    const finished = runTuiShell(operator.io, readyState());

    operator.press(CTRL_C);
    expect(await finished).toBe(0);

    expect(operator.requests, "an ordinary quit started a command").toEqual([]);
    const painted = operator.writes.join("");
    const afterwards = painted.slice(painted.indexOf(ALTERNATE_SCREEN_OFF) + ALTERNATE_SCREEN_OFF.length);
    for (const word of WAITING_WORDS) {
      expect(afterwards.toLowerCase().includes(word), `the console claimed to be ${word} with nothing in flight`).toBe(false);
    }
  });
});

/*
 * ══ PART TWO: the shipped composition root, over a real child process ══════════════════════════
 *
 * The half no in-process test can show. `main.ts` owns the `spawn`, and it is the process — not the
 * shell — that an operator watches for. This drives the real console binary over a real pipe with a
 * real child held open, and pins the same two facts at the level the defect was measured on: the
 * line reaches the operator's own stdout after the alternate screen is restored, and the process
 * does not close while the child it spawned is still alive.
 */

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
/** A private bundle: vitest may run this file beside suites that spawn the shared `dist/tui.js`. */
const entry = join(packageDir, "dist", `tui.quit-in-flight-${String(process.pid)}.js`);

const INVALID_CONFIGURATION_ENVELOPE = JSON.stringify({ ok: false, error: { code: "INVALID_CONFIGURATION" } });
const STARTUP_OUTCOME = "doctor → INVALID_CONFIGURATION (exit 2)";
/** The command this test holds open. Distinctive on the frame and the slowest one the CLI has. */
const HELD_COMMAND = "relay publish";

/**
 * The fake CLI: it announces its command on a control socket as its first act and then does exactly
 * what the socket tells it. It touches no store, no key and no relay — the only thing this test
 * needs from a child is that it is a real process which is genuinely still alive.
 */
const FAKE_CLI = [
  'import { connect } from "node:net";',
  "",
  "const argv = process.argv.slice(2);",
  'const flag = argv.findIndex((token) => token.startsWith("--"));',
  'const command = argv.slice(0, flag === -1 ? argv.length : flag).join(" ");',
  "",
  "const socket = connect(process.env.ECHOLET_FAKE_SOCKET);",
  'socket.on("error", () => { process.exitCode = 5; });',
  'socket.on("connect", () => { socket.write(JSON.stringify({ command }) + "\\n"); });',
  'let buffer = "";',
  'socket.on("data", (chunk) => {',
  '  buffer += chunk.toString("utf8");',
  '  const newline = buffer.indexOf("\\n");',
  "  if (newline === -1) return;",
  "  const reply = JSON.parse(buffer.slice(0, newline));",
  "  process.exitCode = reply.exit;",
  "  socket.end();",
  "  process.stdout.write(reply.stdout);",
  "});",
].join("\n");

const cleanups: Array<() => Promise<void> | void> = [];

beforeAll(async () => {
  await build({
    entryPoints: [join(packageDir, "src/tui/main.ts")],
    outfile: entry,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22.13",
    external: ["@signalapp/libsignal-client"],
    legalComments: "none",
    sourcemap: false,
    banner: { js: 'import { createRequire } from "node:module";\nconst require = createRequire(import.meta.url);' },
  });
}, CLI_CHILD_TIMEOUT_MS);

afterAll(() => { rmSync(entry, { force: true }); });

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

interface Console {
  readonly order: readonly string[];
  readonly painted: () => string;
  readonly hasClosed: () => boolean;
  press(key: string): void;
  awaitOutput(what: string, ready: (painted: string) => boolean): Promise<void>;
  awaitChild(command: string): Promise<void>;
  /** Lets the held child finish, as the CLI finishing its work would. */
  releaseChild(): void;
  closed(): Promise<number | null>;
}

async function startConsole(): Promise<Console> {
  const workDir = mkdtempSync(join(tmpdir(), "echolet-quit-in-flight-"));
  const fakeCli = join(workDir, "fake-cli.mjs");
  writeFileSync(fakeCli, FAKE_CLI, "utf8");
  // Short, and outside the work directory: a unix socket path has a ~104-byte limit.
  const socketPath = join(tmpdir(), `eqif-${String(process.pid)}-${String(Date.now() % 1_000_000)}.sock`);

  const announced: string[] = [];
  const order: string[] = [];
  const chunks: Buffer[] = [];
  const sockets: Socket[] = [];
  let held: Socket | undefined;

  const waiters: Array<{ ready: () => boolean; resolve: () => void; timer: ReturnType<typeof setTimeout> }> = [];
  const painted = (): string => Buffer.concat(chunks).toString("utf8");

  const settle = (): void => {
    for (let index = waiters.length - 1; index >= 0; index -= 1) {
      const waiter = waiters[index];
      if (waiter === undefined || !waiter.ready()) continue;
      waiters.splice(index, 1);
      clearTimeout(waiter.timer);
      waiter.resolve();
    }
  };

  const wait = (what: string, ready: () => boolean): Promise<void> => new Promise<void>((done, fail) => {
    if (ready()) { done(); return; }
    const timer = setTimeout(() => {
      const at = waiters.findIndex((candidate) => candidate.timer === timer);
      if (at !== -1) waiters.splice(at, 1);
      fail(new Error(`timed out waiting for ${what}`));
    }, CLI_CHILD_TIMEOUT_MS);
    waiters.push({ ready, resolve: done, timer });
  });

  const server: Server = createServer((socket) => {
    sockets.push(socket);
    let buffer = "";
    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      const parsed = JSON.parse(buffer.slice(0, newline)) as { readonly command?: unknown };
      buffer = buffer.slice(newline + 1);
      const command = typeof parsed.command === "string" ? parsed.command : "";
      announced.push(command);
      // Every child answers at once EXCEPT the one this test holds open, which stays alive — a real
      // process, genuinely still running — until `releaseChild`. That is the whole apparatus: no
      // timer decides when the child finishes, this test does.
      if (command === HELD_COMMAND) held = socket;
      else socket.write(`${JSON.stringify({ stdout: INVALID_CONFIGURATION_ENVELOPE, exit: 2 })}\n`);
      settle();
    });
  });

  await new Promise<void>((done, fail) => {
    server.once("error", fail);
    server.listen(socketPath, () => { done(); });
  });

  const child: ChildProcess = spawn(process.execPath, [
    entry,
    "--profile", join(workDir, "alice"),
    "--label", "alice",
    "--relay-url", "http://127.0.0.1:18317",
    "--store-key-env", "ECHOLET_QUIT_IN_FLIGHT_KEY",
    "--cli", fakeCli,
  ], {
    cwd: packageDir,
    env: { ...process.env, ECHOLET_FAKE_SOCKET: socketPath },
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdout?.on("data", (chunk: Buffer) => { chunks.push(chunk); settle(); });
  child.stdin?.on("error", () => { /* the console may exit while a keystroke is in flight */ });

  let exited = false;
  const closed = new Promise<number | null>((done) => {
    child.once("close", (code) => {
      exited = true;
      order.push("the console process closed");
      settle();
      done(code);
    });
  });

  cleanups.push(async () => {
    if (!exited) { child.kill("SIGKILL"); await closed; }
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((done) => { server.close(() => { done(); }); });
    rmSync(socketPath, { force: true });
    rmSync(workDir, { recursive: true, force: true });
  });

  return {
    order,
    painted,
    hasClosed: () => exited,
    press: (key: string) => { child.stdin?.write(key); },
    awaitOutput: (what: string, ready: (text: string) => boolean) => wait(what, () => ready(painted())),
    awaitChild: (command: string) => wait(`a ${command} child`, () => announced.includes(command)),
    releaseChild: () => {
      order.push("the child finished");
      held?.write(`${JSON.stringify({ stdout: JSON.stringify({ ok: true, data: {} }), exit: 0 })}\n`);
    },
    closed: () => closed,
  };
}

describe("the shipped console, interrupted while a real child is still running", () => {
  it("hands the terminal back, says what it is waiting for, and exits when the child does", async () => {
    const operator = await startConsole();
    await operator.awaitOutput("the first frame", (text) => text.includes(UNAUDITED_NOTICE));
    // The one child the operator did not press. Settled before anything else, so that the child held
    // open below is unambiguously the one this test is about.
    await operator.awaitOutput(`a frame containing ${JSON.stringify(STARTUP_OUTCOME)}`, (text) => text.includes(STARTUP_OUTCOME));

    // A real child process, genuinely still running: it is alive and has not been answered.
    operator.press("r");
    await operator.awaitChild(HELD_COMMAND);
    await operator.awaitOutput("a frame saying a command is in flight", (text) => text.includes("running…"));

    operator.press(CTRL_C);

    // RED. Today the console writes the alternate-screen restore and then nothing at all until the
    // forgotten child settles — at which point it writes a SECOND restore. An operator sees their own
    // screen come back, empty, with no prompt, and no way to tell a finished program from a stuck one.
    await operator.awaitOutput(
      `the terminal restore followed by a line naming ${HELD_COMMAND} as still running`,
      (text) => {
        const restoredAt = text.indexOf(ALTERNATE_SCREEN_OFF);
        return restoredAt >= 0
          && saysSomethingIsStillRunning(text.slice(restoredAt + ALTERNATE_SCREEN_OFF.length), HELD_COMMAND);
      },
    );

    // The claim has to be true when it is made. The console said it is waiting for this child, and
    // this child has not been answered yet, so the process must still be here.
    expect(operator.hasClosed(), "the console said it was waiting for a command and had already exited").toBe(false);

    operator.releaseChild();
    expect(await operator.closed()).toBe(0);

    // Ordered by events, not by clocks: the process may not outlive its usefulness, and it may not
    // predecease the child it is holding either. A repair that killed the child instead of waiting
    // for it lands "the console process closed" first and fails here.
    expect(operator.order).toEqual(["the child finished", "the console process closed"]);
  }, CLI_TEST_TIMEOUT_MS);
});
