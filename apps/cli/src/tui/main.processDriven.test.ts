import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { CLI_TEST_TIMEOUT_MS } from "../../test/childProcessTimeouts";
import { UNAUDITED_NOTICE } from "./shell-chrome";

// Flow 003 T5 — D-1, at the level the defect actually lives on: real child processes.
//
// MEASURED (flow 003 T2 §3.1). `mapKey` never reads `state.busy`, so every keystroke spawns another
// `dist/cli.js` against the same encrypted SQLite store:
//
//   Run C, `p p p d` at 5 ms intervals   →  doctor → PERSISTENCE_FAILURE (exit 5)
//                                           poll   → PERSISTENCE_FAILURE (exit 5)
//                                           poll   → ok (exit 0)          ← all that survives
//
//   Run B, relay stopped, `p` then `r`   →  relay publish → PERSISTENCE_FAILURE (exit 5)
//   control, same relay, no console      →  relay publish → RELAY_UNAVAILABLE   exit 4
//
// So the console turns a retryable exit 4 into a stop-and-investigate exit 5. The typed exit-code
// contract — 0 success, 2 input/configuration, 3 trust/protocol, 4 temporary relay/network,
// 5 local persistence — is the thing this console exists to surface, and it corrupts it.
//
// This suite drives the REAL console binary over a real pipe with real children, because an
// in-process test can pass while the shipped console still spawns overlapping children. The pure
// half of the pin lives in `tui-shell.singleFlight.test.ts`.
//
// ── How a NON-event is made deterministic ────────────────────────────────────────────────────
//
// "No second child was spawned" cannot be waited for. It is settled here by a causal barrier
// rather than by a timer: a Node process cannot exit while a child it spawned is still running, so
// the console's own exit happens-after the exit — and therefore after the FIRST ACT — of every
// child it ever spawned, and each child's first act is to announce its argv on a control socket.
// Once the console process has closed, the announcement list is COMPLETE, and counting it is exact.
//
// The control plane answers every announcement the test has not reserved with PERSISTENCE_FAILURE
// / exit 5 — which is what the encrypted SQLite store was measured to do to a second concurrent
// writer — so no child is ever left hanging and the barrier above always closes. Every wait in this
// file is on an event: a socket announcement, a substring of a painted frame, or a process exit.
// Nothing sleeps, and no store, key, relay, plaintext or HTTP body is involved at any point.
//
// ── The one child the operator did not press ─────────────────────────────────────────────────
//
// Flow 004 T16 added the startup `doctor` this console runs on its way in (t35 §2.1, §5 item 6), so
// that it does not begin with an unknown profile and an empty roster. It is a child like any other:
// it goes through `reduce`, sets `busy`, and is subject to the same single-flight rule. So it is
// RESERVED like any other — by the same counter, before the console is spawned, since a reservation
// made after `spawn` returns would race that child to the socket. Reserving it is what keeps the
// "no child was refused as a second concurrent writer" claim below meaning exactly what it meant:
// were the console to run this child concurrently with anything, or to run a second unasked-for
// one, that child would find the counter at zero and appear in the refused list. Each test releases
// it — with the class the CLI itself returns for a profile directory that does not exist — and
// waits for its outcome before pressing the first key, so that the console is idle and every
// announcement below is ordered by an await rather than by hope.

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
// A private bundle, for the reason `cli.processFailures.test.ts` keeps one: vitest may run this
// file in parallel with suites that spawn the shared `dist/tui.js`.
const entry = join(packageDir, "dist", `tui.red-${String(process.pid)}.js`);

const PERSISTENCE_ENVELOPE = JSON.stringify({ ok: false, error: { code: "PERSISTENCE_FAILURE" } });
const RELAY_UNAVAILABLE_ENVELOPE = JSON.stringify({ ok: false, error: { code: "RELAY_UNAVAILABLE" } });
// What the CLI returns for the profile directory this harness names and never creates. Deliberately
// not `ok`: the startup outcome must not satisfy a frame wait a later, pressed command owns.
const INVALID_CONFIGURATION_ENVELOPE = JSON.stringify({ ok: false, error: { code: "INVALID_CONFIGURATION" } });
const STARTUP_OUTCOME = "doctor → INVALID_CONFIGURATION (exit 2)";
const WAIT_MS = 20_000;

/**
 * The fake CLI. It never touches a store, a relay or a key: it reports its argv on the control
 * socket as its first act and then does exactly what the socket tells it to.
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

interface Announcement {
  readonly command: string;
  readonly socket: Socket;
  /** True when the test had reserved this child; false when the control plane refused it. */
  readonly held: boolean;
  released: boolean;
}

interface Waiter {
  readonly ready: () => boolean;
  readonly resolve: () => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

interface Harness {
  readonly announcements: readonly Announcement[];
  readonly painted: () => string;
  /** Reserve the next child to announce, instead of refusing it as a second concurrent writer. */
  reserveNextChild(): void;
  press(key: string): void;
  awaitFrame(needle: string): Promise<void>;
  awaitReservedChild(command: string): Promise<Announcement>;
  release(announcement: Announcement, stdout: string, exit: number): void;
  runCliDirectly(args: readonly string[]): Promise<{ readonly code: number | null; readonly stdout: string }>;
  quit(): Promise<number | null>;
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
}, 60_000);

afterAll(() => { rmSync(entry, { force: true }); });

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function startConsole(): Promise<Harness> {
  const workDir = mkdtempSync(join(tmpdir(), "echolet-tui-red-"));
  const fakeCli = join(workDir, "fake-cli.mjs");
  writeFileSync(fakeCli, FAKE_CLI, "utf8");
  // Short, and outside the work directory: a unix socket path has a ~104-byte limit.
  const socketPath = join(tmpdir(), `etui-${String(process.pid)}-${String(Date.now() % 1_000_000)}.sock`);

  const announcements: Announcement[] = [];
  const waiters: Waiter[] = [];
  const chunks: Buffer[] = [];
  // One reservation is standing before the console is spawned: the startup `doctor`. Same counter,
  // same `held` path, same release — see the header. Nothing else is reserved in advance.
  let reserved = 1;

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
    }, WAIT_MS);
    waiters.push({ ready, resolve: done, timer });
  });

  const server: Server = createServer((socket) => {
    let buffer = "";
    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      const parsed = JSON.parse(buffer.slice(0, newline)) as { readonly command?: unknown };
      buffer = buffer.slice(newline + 1);

      const held = reserved > 0;
      if (held) reserved -= 1;
      announcements.push({
        command: typeof parsed.command === "string" ? parsed.command : "",
        socket,
        held,
        released: false,
      });
      // An unreserved child is a second concurrent writer, and this is what the encrypted SQLite
      // store does to one. Answering it immediately also guarantees it terminates, which is what
      // lets the console's own exit close the barrier this suite counts behind.
      if (!held) socket.write(`${JSON.stringify({ stdout: PERSISTENCE_ENVELOPE, exit: 5 })}\n`);
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
    "--store-key-env", "ECHOLET_TUI_RED_KEY",
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
    child.once("close", (code) => { exited = true; settle(); done(code); });
  });

  cleanups.push(async () => {
    if (!exited) { child.kill("SIGKILL"); await closed; }
    for (const announcement of announcements) announcement.socket.destroy();
    await new Promise<void>((done) => { server.close(() => { done(); }); });
    rmSync(socketPath, { force: true });
    rmSync(workDir, { recursive: true, force: true });
  });

  return {
    announcements,
    painted,
    reserveNextChild: () => { reserved += 1; },
    press: (key: string) => { child.stdin?.write(key); },
    awaitFrame: (needle: string) => wait(`a frame containing ${JSON.stringify(needle)}`, () => painted().includes(needle)),
    awaitReservedChild: async (command: string) => {
      const match = (): Announcement | undefined =>
        announcements.find((entry) => entry.command === command && entry.held && !entry.released);
      await wait(`a reserved ${command} child`, () => match() !== undefined);
      const found = match();
      if (found === undefined) throw new Error(`no reserved ${command} child`);
      return found;
    },
    release: (announcement: Announcement, stdout: string, exit: number) => {
      announcement.released = true;
      announcement.socket.write(`${JSON.stringify({ stdout, exit })}\n`);
    },
    runCliDirectly: (args: readonly string[]) => new Promise((done, fail) => {
      const direct = spawn(process.execPath, [fakeCli, ...args], {
        env: { ...process.env, ECHOLET_FAKE_SOCKET: socketPath },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let out = "";
      direct.stdout.on("data", (chunk: Buffer) => { out += chunk.toString("utf8"); });
      direct.once("error", fail);
      direct.once("close", (code) => { done({ code, stdout: out }); });
    }),
    // Resolves only once the console process has CLOSED — which, because a parent cannot exit while
    // a child it spawned is alive, is after every child it spawned has announced itself.
    quit: () => { child.stdin?.write("q"); return closed; },
  };
}

describe("D-1: the console runs one command at a time, over real child processes", () => {
  it("spawns no second child while a command is in flight", async () => {
    const operator = await startConsole();
    await operator.awaitFrame(UNAUDITED_NOTICE);

    // The startup child, reserved before the spawn and settled before the first keystroke.
    operator.release(await operator.awaitReservedChild("doctor"), INVALID_CONFIGURATION_ENVELOPE, 2);
    await operator.awaitFrame(STARTUP_OUTCOME);

    operator.reserveNextChild();
    operator.press("p");
    const poll = await operator.awaitReservedChild("poll");

    // The measured key-mash, while the poll is genuinely still running. One key is enough and is
    // unambiguous: a pipe may coalesce two keystrokes into one chunk, and `decodeKey` reads only
    // the first code point of a chunk.
    operator.press("d");

    operator.release(poll, JSON.stringify({ ok: true, data: { received: 0, more: false } }), 0);
    await operator.awaitFrame("poll → ok (exit 0)");

    // Idle again: a command key must still work. The pin is single-flight, not a console that has
    // stopped running commands.
    operator.reserveNextChild();
    operator.press("d");
    const doctor = await operator.awaitReservedChild("doctor");
    operator.release(doctor, JSON.stringify({ ok: true, data: { contact_count: 0 } }), 0);
    await operator.awaitFrame("doctor → ok (exit 0)");

    await operator.quit();

    // Counted behind the barrier: the console has closed, so nothing it spawned is still on its way.
    // A refused child is exactly one that met the store as a second concurrent writer.
    expect(operator.announcements.filter((entry) => !entry.held).map((entry) => entry.command)).toEqual([]);
    expect(operator.announcements.map((entry) => entry.command)).toEqual(["doctor", "poll", "doctor"]);
    expect(operator.painted()).not.toContain("PERSISTENCE_FAILURE");
  }, 90_000);

  it("reports the exit class the CLI returned, and does not manufacture a persistence failure", async () => {
    const operator = await startConsole();
    await operator.awaitFrame(UNAUDITED_NOTICE);

    // The startup child, reserved before the spawn and settled before anything else announces, so
    // the control run below is still the second child on the socket and not a racer with the first.
    operator.release(await operator.awaitReservedChild("doctor"), INVALID_CONFIGURATION_ENVELOPE, 2);
    await operator.awaitFrame(STARTUP_OUTCOME);

    // The control: what `relay publish` reports on its own against a relay that is not answering.
    // Exit 4 — temporary relay/network, retry — is the class the console must not upgrade.
    operator.reserveNextChild();
    const control = operator.runCliDirectly(["relay", "publish", "--profile", "/tmp/echolet-demo/alice", "--json"]);
    operator.release(await operator.awaitReservedChild("relay publish"), RELAY_UNAVAILABLE_ENVELOPE, 4);
    const controlResult = await control;
    expect(controlResult.code).toBe(4);
    expect(controlResult.stdout).toContain("RELAY_UNAVAILABLE");

    operator.reserveNextChild();
    operator.press("p");
    const poll = await operator.awaitReservedChild("poll");

    // The measured Run B: `relay publish` pressed while a poll is in flight.
    operator.press("r");

    operator.release(poll, JSON.stringify({ ok: true, data: { received: 0, more: false } }), 0);
    await operator.awaitFrame("poll → ok (exit 0)");

    operator.reserveNextChild();
    operator.press("r");
    operator.release(await operator.awaitReservedChild("relay publish"), RELAY_UNAVAILABLE_ENVELOPE, 4);
    await operator.awaitFrame("relay publish → RELAY_UNAVAILABLE (exit 4)");

    await operator.quit();

    // The exact form of the claim, settled behind the barrier rather than by paint timing: NO child
    // the console spawned met the store as a second concurrent writer, so no command could report a
    // class other than the one the CLI returned. A result that arrives after the operator has quit
    // is noted and never painted, so the painted assertions below cannot carry this on their own.
    expect(operator.announcements.filter((entry) => !entry.held).map((entry) => entry.command)).toEqual([]);
    expect(operator.announcements.map((entry) => entry.command)).toEqual(["doctor", "relay publish", "poll", "relay publish"]);

    const reported = [...operator.painted().matchAll(/relay publish → ([A-Z_]+) \(exit (\d+)\)/g)]
      .map((match) => `${String(match[1])} exit ${String(match[2])}`);
    expect([...new Set(reported)]).toEqual(["RELAY_UNAVAILABLE exit 4"]);
    expect(operator.painted()).not.toContain("PERSISTENCE_FAILURE");
  }, 90_000);
});

/*
 * Flow 004 T23 — AC2, against real child processes.
 *
 * AC2 says "what the console shows afterwards is what the store holds — not an optimistic local
 * echo. Demonstrated against a real driven process." The pure and shell-driven halves of that
 * property are `tui-shell.storeTruth.test.ts`; this is the half the criterion's last sentence
 * asks for, and it is here rather than in a harness of its own because this file already owns one
 * that drives the shipped console binary over real children.
 *
 * Two counts, one defect each, both measured twice by the flow's own verifications:
 *
 *   004-T12-verify  AC2 partial   `applyOutcome`'s send case increments `outboxPending` locally
 *                                 and never reconciles it — "exactly the optimistic echo the
 *                                 criterion forbids"
 *   004-T18-verify  AC2 not_met   unchanged at tui-shell.ts:768, and `inboxReceived` accumulates
 *                                 poll deltas the same way at tui-shell.ts:756
 *
 * `poll` reports `received`, which `runtime/inbound.ts:27` defines as "envelopes accepted and
 * committed BY THIS POLL". It is a per-poll figure, not a store total. Two polls — three
 * envelopes, then none — and the honest report of the second is `0`. No command in the frozen
 * eight reports an outbox figure at all (`profile.ts:476-479` is the whole of what `doctor`
 * returns), so the outbox row may report none.
 */

/** `${ESC}[H${ESC}[2J`, the prefix `paint()` writes before every frame (tui-shell.ts:548). */
const FRAME_HOME = `${String.fromCharCode(27)}[H${String.fromCharCode(27)}[2J`;
/** Distinctive, so waiting for it proves the SECOND poll's frame is the one being read. */
const SECOND_POLL_REJECTION = "94a6f678-0000-4000-8000-0000000023a2";

/** The last frame written, with the SGR runs `styleFrame` added stripped back out. */
function lastFrame(painted: string): string {
  const frame = painted.split(FRAME_HOME).at(-1) ?? "";
  return frame
    .split(`${String.fromCharCode(27)}[`)
    .map((part, index) => (index === 0 ? part : part.replace(/^[0-9;?]*[a-zA-Z]/, "")))
    .join("");
}

/** One mailbox-pane row's value, out of a painted frame. */
function mailboxRow(frame: string, label: "outbox" | "inbox"): string {
  const line = frame.split("\r\n").find((row) => row.trimStart().startsWith(label));
  return (line ?? `<no ${label} row was painted>`).trimStart().slice(label.length).trim();
}

describe("T23 — AC2 over real children: the mailbox reports what a command said, and nothing else", () => {
  it("shows the figure the LAST poll returned, and no figure no command ever returned", async () => {
    const operator = await startConsole();
    await operator.awaitFrame(UNAUDITED_NOTICE);

    // The startup child, reserved before the spawn and settled before the first keystroke.
    operator.release(await operator.awaitReservedChild("doctor"), INVALID_CONFIGURATION_ENVELOPE, 2);
    await operator.awaitFrame(STARTUP_OUTCOME);

    // The mailbox pane, which is where the two counts are painted (mailbox-pane.ts:33-34).
    operator.press("2");
    await operator.awaitFrame("outbox");

    // First poll: three envelopes arrive. `more: true` is unique to this reply, so waiting for it
    // proves this poll's frame was painted before the second one is started.
    operator.reserveNextChild();
    operator.press("p");
    operator.release(
      await operator.awaitReservedChild("poll"),
      JSON.stringify({ ok: true, data: { received: 3, more: true, rejected: [] } }),
      0,
    );
    await operator.awaitFrame("yes — poll again");
    expect(mailboxRow(lastFrame(operator.painted()), "inbox"), "the console dropped the figure the poll reported").toContain("3");

    // Second poll: none arrive. The rejection is carried only so that waiting for its envelope id
    // is an event proving THIS poll's frame is the one read below.
    operator.reserveNextChild();
    operator.press("p");
    operator.release(
      await operator.awaitReservedChild("poll"),
      JSON.stringify({ ok: true, data: { received: 0, more: false, rejected: [{ envelopeId: SECOND_POLL_REJECTION, code: "SENDER_NOT_TRUSTED" }] } }),
      0,
    );
    await operator.awaitFrame(SECOND_POLL_REJECTION);

    const frame = lastFrame(operator.painted());
    const inbox = mailboxRow(frame, "inbox");
    const outbox = mailboxRow(frame, "outbox");

    await operator.quit();

    // Every child was one this test reserved, so no result below came from a refused second writer.
    expect(operator.announcements.filter((entry) => !entry.held).map((entry) => entry.command)).toEqual([]);
    expect(operator.announcements.map((entry) => entry.command)).toEqual(["doctor", "poll", "poll"]);

    // RED. The last poll reported nothing received; the console shows the running total it keeps
    // itself, which is a number no command returned and the store never held.
    expect(inbox, "the console added one poll's figure to the next and showed the sum").toContain("0");
    expect(inbox, "the console is still showing the previous poll's figure").not.toContain("3");

    // RED. No command in the frozen eight reports an outbox figure, so the console has none to
    // show — and `0 pending` is a claim about an encrypted store this process cannot open.
    expect(/[0-9]/.test(outbox), `the console painted an outbox figure no command reported — ${JSON.stringify(outbox)}`).toBe(false);
    for (const sentinel of ["null", "undefined", "NaN"]) {
      expect(outbox.includes(sentinel), `the outbox row leaked the sentinel ${sentinel} — ${JSON.stringify(outbox)}`).toBe(false);
    }
  }, CLI_TEST_TIMEOUT_MS);
});

describe("the console explains itself when asked", () => {
  it("prints usage and exits 0 for --help", async () => {
    // Measured (flow 003 T2 §4): `echolet-tui --help` prints "--help needs a value" and exits 2,
    // because the option parser reads the next argv entry as a value before recognising the flag.
    const result = await new Promise<{ code: number | null; output: string }>((done, fail) => {
      const child = spawn(process.execPath, [entry, "--help"], { cwd: packageDir, stdio: ["ignore", "pipe", "pipe"] });
      let output = "";
      child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString("utf8"); });
      child.stderr.on("data", (chunk: Buffer) => { output += chunk.toString("utf8"); });
      child.once("error", fail);
      child.once("close", (code) => { done({ code, output }); });
    });

    expect(result.code).toBe(0);
    expect(result.output).toContain("--profile");
    // Usage must not drag the terminal into the alternate screen on its way out.
    expect(result.output.includes(`${String.fromCharCode(27)}[?1049h`)).toBe(false);
  }, 30_000);
});
