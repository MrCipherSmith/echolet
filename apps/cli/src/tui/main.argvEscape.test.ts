import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { CLI_CHILD_TIMEOUT_MS, CLI_TEST_TIMEOUT_MS } from "../../test/childProcessTimeouts";
import { MIN_VIEWPORT, renderFrame, UNAUDITED_NOTICE } from "./shell-chrome";
import { PENDING_SETUP, type OperatorState, type ProfileView, type Viewport } from "./state";

/*
 * Flow 004 T27 — the eighth route into a frame, and a walk that does not need a ninth to be named
 * first. RED.
 *
 * ── THE DEFECT, AS MEASURED ────────────────────────────────────────────────────────────────────
 *
 * 004-T25-verify F-002, measured against the shipped `dist/tui.js` rather than reasoned about:
 * launched with `--label 'A<ESC>[2JB'` and `--relay-url 'http://127.0.0.1:1<ESC>[2J9999'`, the
 * console painted 4 frames and emitted 12 `ESC[2J` sequences. Each paint legitimately writes exactly
 * one `ESC[H` and one `ESC[2J` (tui-shell.ts:816), so 8 screen-clears arrived from argv — two per
 * frame, one per flag. The console exited 0 with empty stderr: nothing refused the input.
 *
 * Seven boundaries in this console filter what enters the state through `paintable`
 * (tui-shell.ts:371, :427, :561, :589, :657, :718-719, :845) and every one of them is pinned by a
 * mutation the same verification killed. `parseOptions` (main.ts:88-137) applies none: a routed
 * search for `paintable` returns zero matches in `main.ts` and zero in `state.ts`. `--label`,
 * `--relay-url`, `--card`, `--profile` and `--store-key-env` are written verbatim into `ProfileView`
 * and reach:
 *
 *   --label           the header, on EVERY frame (shell-chrome.ts:67)
 *   --relay-url       the health line, on the checklist and on the profiles pane (profiles-pane.ts:142-150)
 *   --card            `card: ${modal.cardPath}` INSIDE THE TRUST MODAL (modal-host.ts:120), and
 *                     prefilled into the compose row at step 4 (tui-shell.ts:296)
 *   --profile         prefilled into the compose row at step 3, and the `directory` row afterwards
 *   --store-key-env   the step-0 recipe, when the key is not set (profiles-pane.ts:122-124)
 *
 * `--card` is the sharp one and it is not the operator's own string: it is a FILENAME CHOSEN BY
 * WHOEVER SENT THE CARD, painted inside the one screen on this surface whose entire purpose is
 * careful comparison. The console's own compose row filters that same path when the operator types
 * it (`input-insert`, tui-shell.ts:371); the launch flag does not. And the runbook launches the
 * console from wrapper scripts where `--label` and `--relay-url` come from shell variables rather
 * than from a human typing them.
 *
 * ── WHY THIS FILE DRIVES A PROCESS ─────────────────────────────────────────────────────────────
 *
 * `parseOptions` is not exported and `main.ts` runs `main()` on import, so there is no in-process
 * way to reach this boundary. The measurement is therefore reproduced the way the verifier made it:
 * the real bundle, real argv, real children, real keystrokes, and the console's own bytes on a pipe.
 * Over a pipe `io.stdout.columns` is undefined and every frame is `MIN_VIEWPORT` (tui-shell.ts:810),
 * which is what makes the frame arithmetic below exact.
 *
 * ── WHY A FIX IN THE RENDERER DOES NOT PASS ────────────────────────────────────────────────────
 *
 * A frame assertion alone can be satisfied at the wrong boundary — by filtering in `shell-chrome.ts`
 * — which is the arrangement tui-shell.ts:832-833 argues against and which
 * `tui-shell.outcomeEscape.test.ts` refuses in its own header ("a test that can be passed at the
 * wrong boundary is worse than a vacuous one"). So the last case in the first block pins the
 * codebase's own stated design in the other direction: `renderFrame` FILTERS NOTHING (t35 §5 item 4,
 * restated at shell-chrome.ts:174-176). A repair applied in the renderer turns that case red, and
 * the only place that passes both is `parseOptions`.
 *
 * ── WHICH CASES ARE RED, AND WHICH ARE THE PAIRS ───────────────────────────────────────────────
 *
 * RED on this tree:
 *   "--label cannot clear the operator's screen"                — 2 injected clears per frame
 *   "--relay-url cannot clear the operator's screen"            — the same, from the health line
 *   "--card cannot steer the trust modal"                       — the sharp one
 *   "--store-key-env cannot steer the step-0 recipe"            — the fifth field, unmeasured before
 *   "the whole painted stream is frames and the console's own four sequences"   — the walk
 *
 * PASSES TODAY, and each is a pair that kills a repair which would close the hole the wrong way:
 *   "keeps the printable remainder of a hostile flag"   — kills a repair that REJECTS the argv or
 *                                                         replaces it with a placeholder; `paintable`
 *                                                         is documented as "A FILTER, not a rejection
 *                                                         and not a placeholder" (text.ts:99-105).
 *                                                         RED today for `--label` (the bytes are
 *                                                         still there, unfiltered), so it is stated
 *                                                         as the FIX's shape rather than as a guard.
 *   "renderFrame filters nothing"                       — kills a repair applied in the renderer
 *
 * Every timeout comes from `apps/cli/test/childProcessTimeouts.ts`. Flow 003 T16/T40: a fresh
 * millisecond guess sized on an idle machine is the defect that already cost this project a day of
 * false-red runs under contention.
 */

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
/** Private to this process, for the reason `main.processDriven.test.ts` keeps one. */
const entry = join(packageDir, "dist", `tui.argv-${String(process.pid)}.js`);

const ESC = String.fromCharCode(27);
/** U+009B: a control sequence introducer that IS a single code point, with no ESC in front of it. */
const C1_CSI = String.fromCharCode(0x9b);
/** U+202E RIGHT-TO-LEFT OVERRIDE: reorders the rest of the painted line. */
const RTL_OVERRIDE = String.fromCharCode(0x202e);

/** The four sequences the console itself writes, and the only ones its output may contain. */
const ALTERNATE_SCREEN_ON = `${ESC}[?1049h${ESC}[?25l`;
const ALTERNATE_SCREEN_OFF = `${ESC}[?25h${ESC}[?1049l`;
/** `paint()` writes exactly one of these before each frame (tui-shell.ts:492, :816). */
const HOME = `${ESC}[H${ESC}[2J`;
/** The three SGR runs `styleFrame` adds around whole lines (shell-chrome.ts:384-386). */
const SGR = [`${ESC}[1m`, `${ESC}[2m`, `${ESC}[0m`] as const;
/** The sequence the verifier counted: a screen clear. It is legitimate only as part of `HOME`. */
const CLEAR_SCREEN = `${ESC}[2J`;

const ENTER = "\r";
/** AC8's way out, and the one key that quits from every state — a row open or a modal up. */
const CTRL_C = String.fromCharCode(3);

const KEY_ENV = "ECHOLET_TUI_ARGV_KEY";
const PEER_IDENTITY = "nps4faW9mNX62tZs5M0oqAWtn05cWtn9gCw0gM1JHA";

const ok = (data: unknown): string => JSON.stringify({ ok: true, data });
const failure = (code: string): string => JSON.stringify({ ok: false, error: { code } });

/**
 * The verifier's own payload: it clears the screen and leaves the row exactly `cols` code points, so
 * every width assertion in the package keeps passing while the terminal obeys it.
 */
const clears = (head: string, tail: string): string => `${head}${CLEAR_SCREEN}${tail}`;
/** The printable remainder a FILTER leaves behind, which is what the fix must still paint. */
const filtered = (head: string, tail: string): string => `${head}[2J${tail}`;

/** Hostile in both halves of the predicate, for values whose remainder no case reads back. */
const hostile = (label: string): string => `${label}${ESC}[2J${C1_CSI}${RTL_OVERRIDE}`;

/**
 * The predicate `text.ts` calls `steersTheDisplay`, restated rather than imported.
 *
 * A SECOND copy on purpose, for the reason `tui-shell.outcomeEscape.test.ts:80-88` records: a test
 * that imported the module's own predicate would agree with the implementation by construction and
 * would still pass if both were widened to permit an escape byte. Numeric rather than a regular
 * expression with literal bytes — an invisible literal in a source file is a character no reviewer
 * can see and no diff can show.
 */
function steers(point: string): boolean {
  const code = point.codePointAt(0) ?? 0;
  if (code <= 0x1f || code === 0x7f || (code >= 0x80 && code <= 0x9f)) return true;
  if (code === 0x200e || code === 0x200f) return true;
  if (code >= 0x202a && code <= 0x202e) return true;
  if (code >= 0x2066 && code <= 0x2069) return true;
  return code === 0x2028 || code === 0x2029 || code === 0xfeff;
}

function steeringPoints(text: string): string[] {
  return [...text].filter(steers).map((point) => `U+${(point.codePointAt(0) ?? 0).toString(16).padStart(4, "0").toUpperCase()}`);
}

function occurrences(haystack: string, needle: string): number {
  let count = 0;
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + needle.length)) count += 1;
  return count;
}

/**
 * The verifier's measurement, as a function: screen clears the console did not write itself.
 *
 * Every `paint()` writes `ESC[H` immediately followed by `ESC[2J`, so the number of legitimate
 * clears is exactly the number of `HOME` prefixes. Any surplus arrived from somewhere else. This is
 * a COUNT rather than a pattern match because an injected `ESC[2J` is byte-identical to a
 * legitimate one — the two are told apart only by how many of each there are.
 */
function injectedClearScreens(painted: string): number {
  return occurrences(painted, CLEAR_SCREEN) - occurrences(painted, HOME);
}

/**
 * ── THE WALK: EVERYTHING THE CONSOLE WRITES, PARSED RATHER THAN SAMPLED ────────────────────────
 *
 * Seven boundaries were closed one at a time, and an eighth was found each time someone looked
 * somewhere new. This function is the shape of test that does not need a ninth to be thought of
 * first, and it is possible because the console's output has a CLOSED VOCABULARY: everything it
 * writes to the operator's terminal is either one of its own four control sequences — alternate
 * screen on, alternate screen off, `HOME`, and the three SGR runs `styleFrame` adds — or a frame row
 * that is exactly `cols` printable code points. `renderFrame`'s contract is that literally: "Exactly
 * `viewport.rows` lines, each exactly `viewport.cols` columns, containing no ESC byte"
 * (shell-chrome.ts:319-321).
 *
 * So the whole stream is PARSED against that grammar rather than searched for known-bad fields. It
 * enumerates no field, no flag and no channel: a byte that reaches a frame from a route nobody has
 * thought of violates the grammar exactly as one from a known route does.
 *
 * WHAT IT COVERS: every code point the console paints, from any source, in every frame the driving
 * session actually causes to be painted — including sources that do not exist yet.
 *
 * WHAT IT CANNOT: (1) a pane, modal or state the driving session never paints — coverage is the
 * drive's, not the grammar's, which is why the walk below visits all five panes, the modal, the
 * compose row, the help list and the checklist rather than one screen; (2) stderr and the exit path,
 * which are not frames; (3) a route that makes a frame LIE without steering a display — a
 * mislabelled direction is a defect this grammar cannot see; (4) the console's own vocabulary
 * growing: a fifth sequence added to `paint()` must be added here too, and until it is this reports
 * it, which is the failure mode this file prefers.
 */
function frameStreamViolations(painted: string, viewport: Viewport): string[] {
  const problems: string[] = [];

  if (!painted.startsWith(ALTERNATE_SCREEN_ON)) {
    problems.push("the stream did not open with the alternate-screen sequence");
    return problems;
  }
  let body = painted.slice(ALTERNATE_SCREEN_ON.length);
  if (body.endsWith(ALTERNATE_SCREEN_OFF)) body = body.slice(0, body.length - ALTERNATE_SCREEN_OFF.length);
  else problems.push("the stream did not close with the alternate-screen sequence — the console did not leave cleanly");

  const chunks = body.split(HOME);
  const preamble = chunks.shift() ?? "";
  if (preamble !== "") problems.push(`${String(preamble.length)} bytes were written before the first frame`);
  if (chunks.length === 0) problems.push("the console painted no frame at all");

  chunks.forEach((chunk, index) => {
    const rows = chunk.split("\r\n");
    if (rows.length !== viewport.rows) {
      problems.push(`frame ${String(index)} had ${String(rows.length)} rows, not ${String(viewport.rows)} — something in it was read as a frame boundary`);
    }
    rows.forEach((row, at) => {
      let plain = row;
      for (const run of SGR) plain = plain.split(run).join("");
      const found = steeringPoints(plain);
      if (found.length > 0) {
        problems.push(`frame ${String(index)} row ${String(at)} carried ${found.join(", ")} — a display-steering point reached a painted row`);
      }
      if ([...plain].length !== viewport.cols) {
        problems.push(`frame ${String(index)} row ${String(at)} was ${String([...plain].length)} code points, not ${String(viewport.cols)}`);
      }
    });
  });

  return problems;
}

/**
 * The fake CLI. It touches no store, no relay and no key.
 *
 * It answers from a plan on disk, keyed by command, and counts its own previous invocations through
 * a log file so that the two `doctor` calls — the startup one and step 5's — can answer differently.
 * A new process each time is what makes the log necessary; single-flight is what makes it exact.
 *
 * `contact import` is the one command whose stdin `main.ts` deliberately leaves open, so that reply
 * waits for the operator's answer to the child's own prompt before it finishes.
 */
const FAKE_CLI = [
  'import { appendFileSync, readFileSync } from "node:fs";',
  "",
  "const argv = process.argv.slice(2);",
  'const flag = argv.findIndex((token) => token.startsWith("--"));',
  'const command = argv.slice(0, flag === -1 ? argv.length : flag).join(" ");',
  "",
  "const log = process.env.ECHOLET_FAKE_LOG;",
  'const before = readFileSync(log, "utf8").split("\\n").filter((line) => line === command).length;',
  'appendFileSync(log, command + "\\n");',
  "",
  'const plan = JSON.parse(readFileSync(process.env.ECHOLET_FAKE_PLAN, "utf8"));',
  'const replies = plan[command] ?? [{ stdout: JSON.stringify({ ok: false, error: { code: "INVALID_CONFIGURATION" } }), exit: 2 }];',
  "const reply = replies[Math.min(before, replies.length - 1)];",
  "",
  'if (typeof reply.stderr === "string") process.stderr.write(reply.stderr);',
  "const finish = () => {",
  "  process.stdout.write(reply.stdout);",
  "  process.exitCode = reply.exit;",
  "  process.stdin.destroy();",
  "};",
  "if (reply.expectStdin === true) {",
  '  let seen = "";',
  '  process.stdin.on("data", (chunk) => { seen += chunk.toString("utf8"); if (seen.includes("\\n")) finish(); });',
  "} else finish();",
].join("\n");

interface Reply {
  readonly stdout: string;
  readonly exit: number;
  readonly stderr?: string;
  readonly expectStdin?: boolean;
}

type Plan = Readonly<Record<string, readonly Reply[]>>;

interface Launch {
  readonly label?: string;
  readonly relayUrl?: string;
  readonly cardPath?: string;
  readonly profileDir?: string;
  readonly storeKeyEnv?: string;
  /** Step 0's precondition. Absent puts the store-key recipe — and its variable's NAME — on screen. */
  readonly storeKeyInEnvironment?: boolean;
  readonly plan?: Plan;
}

interface Harness {
  readonly painted: () => string;
  /** The current end of the painted output, so a later wait looks only at what came after it. */
  mark(): number;
  press(keys: string): void;
  awaitFrame(needle: string, since?: number): Promise<void>;
  quit(): Promise<number | null>;
}

interface Waiter {
  readonly ready: () => boolean;
  readonly resolve: () => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

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
}, CLI_TEST_TIMEOUT_MS);

afterAll(() => { rmSync(entry, { force: true }); });

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function startConsole(launch: Launch): Promise<Harness> {
  const workDir = mkdtempSync(join(tmpdir(), "echolet-tui-argv-"));
  const fakeCli = join(workDir, "fake-cli.mjs");
  const planPath = join(workDir, "plan.json");
  const logPath = join(workDir, "invocations.log");

  writeFileSync(fakeCli, FAKE_CLI, "utf8");
  writeFileSync(planPath, JSON.stringify(launch.plan ?? {}), "utf8");
  writeFileSync(logPath, "", "utf8");

  const chunks: Buffer[] = [];
  const waiters: Waiter[] = [];
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

  const storeKeyEnv = launch.storeKeyEnv ?? KEY_ENV;
  const environment: Record<string, string | undefined> = {
    ...process.env,
    ECHOLET_FAKE_PLAN: planPath,
    ECHOLET_FAKE_LOG: logPath,
  };
  // The value is never asserted on and never painted; only its PRESENCE decides step 0.
  if (launch.storeKeyInEnvironment === true) environment[storeKeyEnv] = "not-a-real-key";
  else delete environment[storeKeyEnv];

  const argv = [
    entry,
    "--profile", launch.profileDir ?? join(workDir, "alice"),
    "--label", launch.label ?? "alice",
    "--relay-url", launch.relayUrl ?? "http://127.0.0.1:18317",
    "--store-key-env", storeKeyEnv,
    ...(launch.cardPath === undefined ? [] : ["--card", launch.cardPath]),
    "--cli", fakeCli,
  ];

  const child: ChildProcess = spawn(process.execPath, argv, {
    cwd: packageDir,
    env: environment,
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdout?.on("data", (chunk: Buffer) => { chunks.push(chunk); settle(); });
  child.stdin?.on("error", () => { /* the console may exit while a keystroke is in flight */ });

  let exited = false;
  const closed = new Promise<number | null>((done) => {
    child.once("close", (code) => { exited = true; settle(); done(code); });
  });

  cleanups.push(async () => {
    if (!exited) { child.kill("SIGKILL"); await closed; }
    rmSync(workDir, { recursive: true, force: true });
  });

  return {
    painted,
    mark: () => painted().length,
    /*
     * One write per keystroke, and the caller waits between them wherever the answer matters.
     *
     * A pipe may coalesce two writes into one chunk. With no compose row open that is harmless —
     * `splitKeystrokes` takes the chunk apart (tui-shell.ts:985) — but while a row IS open the chunk
     * is inserted WHOLE as text, so an unawaited `press(ESC)` after a paste becomes part of the
     * paste, the row never closes, and every key after it is silently typed into a message.
     */
    press: (keys: string) => { child.stdin?.write(keys); },
    awaitFrame: (needle: string, since = 0) =>
      wait(`a frame containing ${JSON.stringify(needle)}`, () => painted().slice(since).includes(needle)),
    // Ctrl-C rather than `q`: it is the one binding that survives an open compose row and an open
    // modal, so quitting never depends on which state the console happens to be in (AC8).
    quit: () => { child.stdin?.write(CTRL_C); return closed; },
  };
}

/** The startup `doctor` reporting a profile that is not there, which is what opens the checklist. */
const ABSENT: Plan = { doctor: [{ stdout: failure("INVALID_CONFIGURATION"), exit: 2 }] };
const STARTUP_OUTCOME = "doctor → INVALID_CONFIGURATION (exit 2)";

/** The four identifiers `contact import` prints on stderr while it waits at its own prompt. */
const peerLine = (identity: string): string => `${JSON.stringify({
  identity_id: identity,
  device_id: "9f0c4a11-2b3c-4d5e-8f60-71829a3b4c5d",
  device_pubkey: "npsPUBKEY_aW9mNX62tZs5M0oqAWtn05cWtn9gCw0gM",
  signal_identity_key: "BQdNjP6tbN00N3eS6DNpmKpMDFDeDa4MFuUO1QWt8i",
})}\n`;

describe("the eighth route: argv reaches a painted frame without passing a boundary", () => {
  it("does not let --label clear the operator's screen", async () => {
    // The measurement, reproduced: the label is painted in the header on EVERY frame, so one flag
    // buys one screen-clear per paint for as long as the session lasts.
    const operator = await startConsole({ label: clears("A", "B"), plan: ABSENT });
    await operator.awaitFrame(UNAUDITED_NOTICE);
    await operator.awaitFrame(STARTUP_OUTCOME);
    await operator.quit();

    const painted = operator.painted();
    expect(
      injectedClearScreens(painted),
      `--label put screen-clear sequences into the console's output that no paint wrote: ${String(occurrences(painted, CLEAR_SCREEN))} clears over ${String(occurrences(painted, HOME))} paints`,
    ).toBe(0);
  }, CLI_TEST_TIMEOUT_MS);

  it("does not let --relay-url clear the operator's screen", async () => {
    // The health line carries it on the checklist frame and on the profiles pane afterwards
    // (profiles-pane.ts:150). In the runbook's wrapper scripts this value is a shell variable.
    const operator = await startConsole({ relayUrl: clears("http://127.0.0.1:1", "9999"), plan: ABSENT });
    await operator.awaitFrame(UNAUDITED_NOTICE);
    await operator.awaitFrame(STARTUP_OUTCOME);
    await operator.quit();

    const painted = operator.painted();
    expect(injectedClearScreens(painted), "--relay-url reached the health line unfiltered").toBe(0);
  }, CLI_TEST_TIMEOUT_MS);

  it("does not let --card steer the trust modal", async () => {
    /*
     * The sharp one. `--card` is a filename chosen by whoever sent the card, and `renderModal`
     * paints it as `card: ${modal.cardPath}` on the line directly above four identifiers a human is
     * being asked to compare out of band — the one screen on this surface whose entire purpose is
     * careful reading. `main.ts:224` passes `request.from` to the trust listener, and `[i]` builds
     * that request straight out of `profile.contactCardPath` (tui-shell.ts:182-184).
     *
     * The identifiers beside it ARE filtered (`paintableIdentifiers`, tui-shell.ts:427), which is
     * what makes this an unguarded neighbour rather than an unguarded screen.
     */
    const cardPath = `/tmp/c${ESC}[2Jb.json`;
    const operator = await startConsole({
      cardPath,
      plan: {
        doctor: [{ stdout: failure("INVALID_CONFIGURATION"), exit: 2 }],
        "contact import": [{ stdout: ok({ pinned: true }), exit: 0, stderr: peerLine(PEER_IDENTITY), expectStdin: true }],
      },
    });
    await operator.awaitFrame(UNAUDITED_NOTICE);
    await operator.awaitFrame(STARTUP_OUTCOME);

    operator.press("i");
    await operator.awaitFrame("Trust these contact identifiers?");
    const withModal = operator.painted();

    operator.press("y");
    await operator.awaitFrame("contact import → ok (exit 0)");
    await operator.quit();

    expect(
      injectedClearScreens(withModal),
      "a correspondent's chosen filename cleared the operator's screen from inside the trust modal",
    ).toBe(0);
    expect(injectedClearScreens(operator.painted())).toBe(0);
  }, CLI_TEST_TIMEOUT_MS);

  it("does not let --store-key-env steer the step-0 recipe", async () => {
    // The fifth field, and the one no verification measured. With the key absent the checklist
    // NAMES the variable and prints a shell line for the operator to run (profiles-pane.ts:122-124),
    // so the flag's bytes are painted twice on the frame an operator is being asked to act on.
    const operator = await startConsole({
      storeKeyEnv: `ECHOLET_${ESC}[2J_KEY`,
      storeKeyInEnvironment: false,
      plan: ABSENT,
    });
    await operator.awaitFrame(UNAUDITED_NOTICE);
    // The needle stops short of "environment": at 72 columns the step-0 line is clipped mid-sentence,
    // which is F-007's header overflow showing up one row lower and is not this file's business.
    await operator.awaitFrame("is not set in this console");
    await operator.quit();

    expect(injectedClearScreens(operator.painted()), "--store-key-env reached the step-0 recipe unfiltered").toBe(0);
  }, CLI_TEST_TIMEOUT_MS);

  it("keeps the printable remainder of a hostile flag, rather than rejecting or blanking it", async () => {
    /*
     * The pair that constrains the FIX. `paintable` is documented as "A FILTER, not a rejection and
     * not a placeholder" (text.ts:99-105), and a console that refused to start, or that painted
     * `<invalid>` where the operator's own label went, would satisfy every case above and take away
     * the one string that tells two profiles apart.
     *
     * RED today for a second reason as well as the first: the header currently holds `A`, an ESC,
     * and `[2JB` — so the filtered form `A[2JB` is absent from the output. Only a filter produces it.
     */
    const operator = await startConsole({ label: clears("A", "B"), plan: ABSENT });
    await operator.awaitFrame(UNAUDITED_NOTICE);
    await operator.awaitFrame(STARTUP_OUTCOME);
    await operator.quit();

    expect(
      operator.painted(),
      "the hostile label was discarded or replaced rather than filtered — the operator can no longer tell which profile they are looking at",
    ).toContain(filtered("A", "B"));
  }, CLI_TEST_TIMEOUT_MS);

  it("renderFrame filters nothing, so the repair cannot be made in the renderer", () => {
    /*
     * PASSES TODAY, and it is here to force the repair to the boundary rather than into the reader.
     *
     * `shell-chrome.ts:174-176` states this as a design decision — "It filters nothing… making the
     * renderer defensive here would move AC7's property off the state, which is the one thing t35 §5
     * item 4 says it must not be" — and tui-shell.ts:832-833 gives the reason: filtering at the one
     * place text becomes state means a second reader added later inherits the guarantee instead of
     * needing its own audit. A repair applied in `shell-chrome.ts` turns this case red while turning
     * the four above green, and only a filter in `parseOptions` passes all five.
     *
     * If the project ever decides the renderer SHOULD filter, this is the case to revisit — and
     * deleting it would then be a deliberate reversal of a recorded decision rather than a
     * convenience.
     */
    const label = clears("A", "B");
    const profile: ProfileView = {
      label,
      profileDir: "/tmp/echolet-demo/alice",
      relayUrl: "http://127.0.0.1:18317",
      storeKeyEnv: KEY_ENV,
      identityId: "(run doctor)",
      deviceId: "(run doctor)",
      contactCount: 0,
      published: false,
      state: "absent",
      storeKeyPresent: true,
      setup: PENDING_SETUP,
    };
    const state: OperatorState = {
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
    };

    expect(
      renderFrame(state, MIN_VIEWPORT).join("\n"),
      "renderFrame has started filtering its input — the escape-free property has moved off the state and onto the renderer's defensiveness",
    ).toContain(label);
  });
});

describe("the ninth route: a walk over everything the console paints", () => {
  it("writes nothing but its own four sequences and frames of exactly rows by cols", async () => {
    /*
     * The generic test, and the answer to "would anything catch a ninth route without someone
     * thinking of it first". It enumerates no field: it parses the console's ENTIRE output against
     * the closed grammar `frameStreamViolations` documents, so a byte that reaches a frame from any
     * source at all — a flag, a child's stdout, a child's stderr, a keystroke, a route added next
     * month — is a violation of the same rule.
     *
     * What the grammar cannot give is coverage of screens nobody paints, so the drive below is the
     * other half of the test and is deliberately exhaustive rather than illustrative: the checklist,
     * both compose rows (each prefilled from argv by `initialBuffer`, which no boundary guards), the
     * trust modal, all five panes, the help list, and a settled result from every command the
     * console can run. EVERY external string it can be handed is hostile at once — five argv flags,
     * two children's stdout, one child's stderr, and the operator's own keystrokes.
     *
     * RED on this tree for the reason the first block measures. It stays as the standing guard
     * afterwards: it is the case that would have been red for `--label` before anyone looked at
     * `parseOptions`.
     */
    const identity = hostile(PEER_IDENTITY);
    // Short, so the tail-showing compose row (shell-chrome.ts:177-187) still holds the hostile part.
    const profileDir = `/tmp/e${ESC}[2Ja`;
    const cardPath = `/tmp/c${ESC}[2Jb.json`;

    const operator = await startConsole({
      label: clears("A", "B"),
      relayUrl: clears("http://127.0.0.1:1", "9999"),
      profileDir,
      cardPath,
      storeKeyInEnvironment: true,
      plan: {
        doctor: [
          { stdout: failure("INVALID_CONFIGURATION"), exit: 2 },
          { stdout: ok({ identity_id: hostile("ID"), device_id: hostile("DEV"), contact_count: 1 }), exit: 0 },
        ],
        init: [{ stdout: ok({ identity_id: hostile("ID"), device_id: hostile("DEV"), profile_id: "0d1f4a2b" }), exit: 0 }],
        "relay publish": [{ stdout: ok({ published: true }), exit: 0 }],
        "contact export": [{ stdout: ok({ path: "/tmp/card.json" }), exit: 0 }],
        "contact import": [{ stdout: ok({ pinned: true }), exit: 0, stderr: peerLine(identity), expectStdin: true }],
        poll: [{
          stdout: ok({
            received: 1,
            more: false,
            rejected: [{ envelopeId: hostile("env"), code: hostile("SENDER_NOT_TRUSTED") }],
          }),
          exit: 0,
        }],
        history: [{
          stdout: ok({
            entries: [{
              sequence: 1,
              contactIdentityId: identity,
              messageId: hostile("mid"),
              direction: "inbound",
              plaintext: hostile("body"),
              createdAtMs: 1_757_000_000_001,
            }],
          }),
          exit: 0,
        }],
      },
    });

    await operator.awaitFrame(UNAUDITED_NOTICE);
    await operator.awaitFrame(STARTUP_OUTCOME);
    await operator.awaitFrame("step 1");

    // STEP 1 — the relay URL is already on the profile (from argv), so this runs `init` directly.
    operator.press(ENTER);
    await operator.awaitFrame("init → ok (exit 0)");

    // STEP 2 — the publication pool.
    operator.press(ENTER);
    await operator.awaitFrame("relay publish → ok (exit 0)");

    // STEP 3 — the compose row opens PREFILLED from `profile.profileDir`, which came from argv.
    operator.press(ENTER);
    await operator.awaitFrame("export-path ▸");
    operator.press(ENTER);
    await operator.awaitFrame("contact export → ok (exit 0)");

    // STEP 4 — the compose row opens PREFILLED from `profile.contactCardPath`, likewise from argv,
    // and submitting it puts that same path inside the trust modal.
    operator.press(ENTER);
    await operator.awaitFrame("card-path ▸");
    operator.press(ENTER);
    await operator.awaitFrame("Trust these contact identifiers?");
    operator.press("y");
    await operator.awaitFrame("contact import → ok (exit 0)");

    // STEP 5 — `doctor` with a non-zero contact_count closes the checklist, after which the profiles
    // pane paints the detail rows: label, relay, store-key-env, identity, device and directory.
    operator.press(ENTER);
    await operator.awaitFrame("doctor → ok (exit 0)");
    await operator.awaitFrame("store-key-env");

    // A poll, so the mailbox and rejection panes carry a hostile envelope id and code.
    operator.press("p");
    await operator.awaitFrame("poll → ok (exit 0)");

    // The conversation: select the contact the modal produced, open the pane, fetch the history.
    operator.press("c");
    operator.press("3");
    operator.press("h");
    await operator.awaitFrame("history → ok (exit 0)");

    /*
     * The compose row the operator types into, with a hostile paste. Two things are load-bearing:
     * the chunk must not BEGIN with ESC, because `inputKey` reads such a chunk as a key rather than
     * as text (tui-shell.ts:157); and every press here is awaited, because while a row is open a
     * coalesced chunk is inserted whole and an unawaited cancel would be typed instead of obeyed.
     */
    operator.press("w");
    await operator.awaitFrame("message ▸");

    const beforePaste = operator.mark();
    operator.press(`Z${ESC}[2JY${C1_CSI}${RTL_OVERRIDE}`);
    await operator.awaitFrame("Z[2JY", beforePaste);

    const beforeCancel = operator.mark();
    operator.press(ESC);
    // The global footer is back, which is how a closed compose row is visible (shell-chrome.ts:126).
    await operator.awaitFrame("[1-5] pane", beforeCancel);

    // Every remaining pane, then the key list. Each is awaited on a line only that pane paints,
    // because the header's own tabs are clipped at 72 columns (004-T25-verify F-007).
    for (const [key, needle] of [["2", "outbox"], ["4", "rejected by the last poll"], ["5", "status  "], ["1", "store-key-env"]] as const) {
      const before = operator.mark();
      operator.press(key);
      await operator.awaitFrame(needle, before);
    }

    const beforeHelp = operator.mark();
    operator.press("?");
    await operator.awaitFrame("key bindings", beforeHelp);

    await operator.quit();

    // Over a pipe `io.stdout.columns` is undefined, so every frame in this run is MIN_VIEWPORT.
    const problems = frameStreamViolations(operator.painted(), MIN_VIEWPORT);
    // Reported by SHAPE rather than one line per frame: the same row of forty consecutive frames is
    // one defect, and a list that repeated it forty times would bury a second defect underneath it.
    const shapes = [...new Set(problems.map((problem) => problem.replace(/^frame \d+ /u, "")))];
    expect(
      shapes,
      `${String(problems.length)} violations of the console's own output grammar across ${String(occurrences(operator.painted(), HOME))} painted frames`,
    ).toEqual([]);
  }, CLI_TEST_TIMEOUT_MS);
});
