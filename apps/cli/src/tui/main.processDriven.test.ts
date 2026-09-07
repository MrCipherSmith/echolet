import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
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

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
// A private bundle, for the reason `cli.processFailures.test.ts` keeps one: vitest may run this
// file in parallel with suites that spawn the shared `dist/tui.js`.
const entry = join(packageDir, "dist", `tui.red-${String(process.pid)}.js`);

const PERSISTENCE_ENVELOPE = JSON.stringify({ ok: false, error: { code: "PERSISTENCE_FAILURE" } });
const RELAY_UNAVAILABLE_ENVELOPE = JSON.stringify({ ok: false, error: { code: "RELAY_UNAVAILABLE" } });
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
  let reserved = 0;

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
    expect(operator.announcements.map((entry) => entry.command)).toEqual(["poll", "doctor"]);
    expect(operator.painted()).not.toContain("PERSISTENCE_FAILURE");
  }, 90_000);

  it("reports the exit class the CLI returned, and does not manufacture a persistence failure", async () => {
    const operator = await startConsole();
    await operator.awaitFrame(UNAUDITED_NOTICE);

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
    expect(operator.announcements.map((entry) => entry.command)).toEqual(["relay publish", "poll", "relay publish"]);

    const reported = [...operator.painted().matchAll(/relay publish → ([A-Z_]+) \(exit (\d+)\)/g)]
      .map((match) => `${String(match[1])} exit ${String(match[2])}`);
    expect([...new Set(reported)]).toEqual(["RELAY_UNAVAILABLE exit 4"]);
    expect(operator.painted()).not.toContain("PERSISTENCE_FAILURE");
  }, 90_000);
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
