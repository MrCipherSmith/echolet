import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { CLI_CHILD_TIMEOUT_MS, CLI_TEST_TIMEOUT_MS } from "../../test/childProcessTimeouts";
import { UNAUDITED_NOTICE } from "./shell-chrome";

/**
 * Flow 004, T15 — AC1, against a real driven process.
 *
 *   "A person completes registration from inside the console alone, without typing a CLI command in
 *    another terminal: an identity is created, the publication pool is published, their own card is
 *    exported, a peer's card is imported and pinned, and the result is confirmed. Demonstrated
 *    against a real driven CLI process, not only the pure layer."
 *
 * The pure layer is pinned next door (`profiles-pane.setup.test.ts`, `tui-shell.registration.test.ts`).
 * This file drives the SHIPPED console binary — the real `main()`, the real `parseOptions`, the real
 * `buildArgv`, the real `spawn()`, the real trust handshake over a child's stderr and stdin — with
 * real keystrokes on a real pipe, and counts the real children it spawned.
 *
 * ── HOW A NON-EVENT IS MADE DETERMINISTIC ──────────────────────────────────────────────────────
 *
 * Inherited from `main.processDriven.test.ts`, whose reasoning still holds: a Node process cannot
 * exit while a child it spawned is alive, so the console's own exit happens-after the FIRST ACT of
 * every child it ever spawned, and each child's first act is to announce its argv on a control
 * socket. Once the console has closed, the announcement list is COMPLETE and counting it is exact.
 * Every wait in this file is on an event — a socket announcement, a substring of a painted frame, a
 * process exit — and nothing sleeps.
 *
 * Single-flight is settled by the announcements themselves rather than by timing: the test releases
 * each child only when it is ready to press the next key, so a child announced while an earlier one
 * is still unreleased is exactly a second command in flight, and is recorded as such.
 *
 * Every timeout comes from `apps/cli/test/childProcessTimeouts.ts`. Flow 003 T16/T40: a fresh
 * millisecond guess sized on an idle machine is the defect that already cost this project a day of
 * false-red runs under contention.
 *
 * ── STEP 0: HOW AN IMPLEMENTATION THAT READS THE VALUE IS DETECTED ─────────────────────────────
 *
 * The design is explicit that the store key's presence is tested with `Object.hasOwn(process.env,
 * name)`, which cannot produce the value, and NEVER `process.env[name] !== undefined`, which reads
 * it into a comparison. Both spellings return the same boolean and paint the same frame, so no pure
 * test can tell them apart. This one can: the console is started under a preload (`--import`) that
 * replaces its `process.env` with a Proxy whose `get` trap records the frame that asked.
 *
 * `Object.hasOwn` triggers the `getOwnPropertyDescriptor` trap and never `get`; `env[name]`,
 * `{ ...env }`, `Object.entries(env)`, a destructure and `JSON.stringify(env)` all trigger `get`.
 * (`Object.defineProperty(process.env, name, { get })` is not available — Node refuses an accessor
 * descriptor on `process.env` — which is why the whole object is replaced instead.)
 *
 * A `get` trap alone leaves a NINTH spelling open, and it was measured open (004-T18-verify, F-005):
 * `Object.getOwnPropertyDescriptor(process.env, name)?.value` yields the 32 bytes with the `get`
 * trap never firing. No trap can DETECT that one — `Object.hasOwn` and `Object.getOwnPropertyDescriptor`
 * run the same internal method, and the trap's result has its `value` read by the specification's own
 * `ToPropertyDescriptor` in both cases, so the two are indistinguishable from inside. So the probe
 * removes the difference instead of detecting it: its `getOwnPropertyDescriptor` trap returns a
 * descriptor that CONFIRMS PRESENCE AND CARRIES NO VALUE. `Object.hasOwn` still answers true,
 * `Object.keys`/spread/`JSON.stringify` still see an enumerable property and still take the value
 * through `get` where it is recorded, and the child still inherits the real bytes — while a caller
 * that wanted the value through the descriptor gets `undefined`, computes `storeKeyPresent === false`
 * and paints the "create a key" recipe, which the first case below asserts is absent.
 * `describe("the environment probe…")` at the foot of this file pins all nine spellings directly.
 *
 * ONE read of the value is legitimate and unavoidable: Node's own `normalizeSpawnArguments` copies
 * the inherited environment into each child, which is how the key reaches the CLI. That read is
 * told apart by its IMMEDIATE CALLER FRAME — `node:child_process` — and every other caller is the
 * console reaching for the value itself. Both directions are asserted:
 *
 *   with the key present  — every recorded read comes from `node:child_process`, and there is at
 *                           least one, which proves the probe was armed rather than absent;
 *   with the key absent   — there are no recorded reads at all, because a missing property is not
 *                           copied into a child's environment, so any read is the console's.
 */

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
/** Private to this process, for the reason `main.processDriven.test.ts` keeps one. */
const entry = join(packageDir, "dist", `tui.registration-${String(process.pid)}.js`);

/** Short, so the compose row shows it in full at the 72-column fallback viewport. */
const KEY_ENV = "ECHOLET_TUI_REG_KEY";
const RELAY_URL = "http://127.0.0.1:18317";
const OWN_IDENTITY = "hbRYeNqVnWC74METcY57eDEkV9qNQ6Qzuz6RpsIYQA";
const OWN_DEVICE = "733d80b0-e7e2-5e6c-ba84-0bcd96a373ea";
const PEER = {
  identity_id: "nps4faW9mNX62tZs5M0oqAWtn05cWtn9gCw0gM1JHA",
  device_id: "9f0c4a11-2b3c-4d5e-8f60-71829a3b4c5d",
  device_pubkey: "npsPUBKEY_aW9mNX62tZs5M0oqAWtn05cWtn9gCw0gM",
  signal_identity_key: "BQdNjP6tbN00N3eS6DNpmKpMDFDeDa4MFuUO1QWt8i",
} as const;

const ENTER = "\r";
/** AC8's way out, and the one key that quits from every state — including with a row open. */
const CTRL_C = String.fromCharCode(3);

const ok = (data: unknown): string => JSON.stringify({ ok: true, data });
const failure = (code: string): string => JSON.stringify({ ok: false, error: { code } });

/** A 32-byte key is 43 base64url characters; nothing legitimate on this surface is that long. */
const KEY_SHAPED = /[A-Za-z0-9_-]{32,}/;

/**
 * The fake CLI. It touches no store, no relay and no key: it announces the argv it was given as its
 * first act, then does exactly what the control socket tells it to — including waiting at the trust
 * prompt for an answer on stdin, which is the only way step 4 can be driven end to end.
 *
 * It also reports whether the store key's variable is PRESENT in its own environment (never its
 * value), because the console must keep the key reaching the CLI while never reading it itself.
 */
const FAKE_CLI = [
  'import { connect } from "node:net";',
  "",
  "const argv = process.argv.slice(2);",
  'const flag = argv.findIndex((token) => token.startsWith("--"));',
  'const command = argv.slice(0, flag === -1 ? argv.length : flag).join(" ");',
  "",
  "let stdinSeen = \"\";",
  'process.stdin.on("data", (chunk) => { stdinSeen += chunk.toString("utf8"); });',
  "",
  "const socket = connect(process.env.ECHOLET_FAKE_SOCKET);",
  'socket.on("error", () => { process.exitCode = 5; });',
  'socket.on("connect", () => {',
  "  socket.write(JSON.stringify({",
  "    command,",
  "    argv,",
  "    storeKeyReached: Object.hasOwn(process.env, process.env.ECHOLET_PROBE_NAME),",
  '  }) + "\\n");',
  "});",
  "",
  'let buffer = "";',
  'socket.on("data", (chunk) => {',
  '  buffer += chunk.toString("utf8");',
  '  const newline = buffer.indexOf("\\n");',
  "  if (newline === -1) return;",
  "  const reply = JSON.parse(buffer.slice(0, newline));",
  "  buffer = buffer.slice(newline + 1);",
  '  if (typeof reply.stderr === "string") process.stderr.write(reply.stderr);',
  "  const finish = () => {",
  '    socket.end(JSON.stringify({ stdin: stdinSeen }) + "\\n");',
  // `contact import` is the one command whose stdin `main.ts` deliberately leaves OPEN, so a
  // merely paused stream still holds this child in its own event loop. Destroying it is what lets
  // the child exit, which is what lets the console report the outcome at all.
  "    process.stdin.destroy();",
  "    process.stdout.write(reply.stdout);",
  "    process.exitCode = reply.exit;",
  "  };",
  "  if (reply.expectStdin !== true) { finish(); return; }",
  '  const check = () => { if (stdinSeen.includes("\\n")) finish(); };',
  '  process.stdin.on("data", check);',
  "  check();",
  "});",
].join("\n");

/**
 * The hostile environment. Installed with `--import`, so it runs before the console's first line.
 *
 * `backing` is a plain copy, so the console and its children behave exactly as they would without
 * it — the store key still reaches every child through the inherited environment. The only
 * difference is that reading the key's VALUE is now observable, and the frame that did it is named.
 */
const ENV_PROBE = [
  'import { writeFileSync } from "node:fs";',
  "",
  "const name = process.env.ECHOLET_PROBE_NAME;",
  "const out = process.env.ECHOLET_PROBE_OUT;",
  "const backing = { ...process.env };",
  "const reads = [];",
  "const descriptorFrames = [];",
  "let trapped = 0;",
  "let descriptors = 0;",
  "",
  "process.env = new Proxy(backing, {",
  "  get(target, property, receiver) {",
  "    trapped += 1;",
  "    if (property === name) {",
  // Line 0 is "Error", line 1 is this trap, line 2 is whoever asked for the value.
  '      const lines = (new Error("read").stack ?? "").split("\\n");',
  '      reads.push((lines[2] ?? "").trim());',
  "    }",
  "    return Reflect.get(target, property, receiver);",
  "  },",
  // The ninth spelling, closed by CONSTRUCTION rather than by detection (004-T18-verify, F-005).
  //
  // `Object.getOwnPropertyDescriptor(process.env, name)?.value` yields the 32 bytes with the `get`
  // trap never firing, so a probe carrying only `get` passes it. No trap can tell what a caller
  // will DO with a descriptor — `Object.hasOwn` and `Object.getOwnPropertyDescriptor` both run the
  // same internal method, and `ToPropertyDescriptor` reads `value` off the trap's result either way
  // — so this does not try to detect the difference. It removes it: the descriptor this trap
  // returns CONFIRMS PRESENCE AND CARRIES NO VALUE.
  //
  // That is exactly the distinction the hole needs. A descriptor request that only wants to know
  // whether the property is there is answered truthfully — `Object.hasOwn` still returns true, and
  // `Object.keys`/spread/`JSON.stringify` still see an enumerable property — while a request that
  // wanted the VALUE gets `undefined`, and an implementation spelled that way computes
  // `storeKeyPresent === false` and prints the "create a key" recipe for a key that already exists.
  // The case above asserts that the recipe is absent, which turns the ninth spelling from an
  // undetected read into a named failure.
  //
  // The value itself is untouched on the [[Get]] path, so the key still reaches every child exactly
  // as the runbook passes it: `normalizeSpawnArguments` reads it through `get`, where it is recorded
  // and attributed to `node:child_process` as before. The rewrite is legal because `backing`'s
  // properties are writable and configurable, so a proxy may report a different value for them.
  "  getOwnPropertyDescriptor(target, property) {",
  "    const descriptor = Reflect.getOwnPropertyDescriptor(target, property);",
  "    if (property !== name || descriptor === undefined) return descriptor;",
  "    descriptors += 1;",
  '    const lines = (new Error("descriptor").stack ?? "").split("\\n");',
  '    descriptorFrames.push((lines[2] ?? "").trim());',
  "    return { ...descriptor, value: undefined };",
  "  },",
  "});",
  "",
  'process.on("exit", () => { writeFileSync(out, JSON.stringify({ reads, trapped, descriptors, descriptorFrames })); });',
].join("\n");

/** What `ENV_PROBE` writes on exit: every read of the key's value, and every descriptor request. */
interface ProbeReport {
  /** The calling frame of every read that went through the `get` trap for the probed name. */
  readonly reads: readonly string[];
  /** Every `get` the proxy saw, for any property. Non-zero proves the probe was installed. */
  readonly trapped: number;
  /** How many descriptor requests the probed name received. Non-zero proves that trap is armed. */
  readonly descriptors: number;
  readonly descriptorFrames: readonly string[];
}

interface Announcement {
  readonly command: string;
  readonly argv: readonly string[];
  readonly storeKeyReached: boolean;
  readonly socket: Socket;
  /** True when this child was spawned while an earlier one had not yet been answered. */
  readonly concurrent: boolean;
  released: boolean;
  /** What the console wrote to this child's stdin, once the child has reported it. */
  stdin: string | null;
}

interface Reply {
  readonly stdout: string;
  readonly exit: number;
  readonly stderr?: string;
  readonly expectStdin?: boolean;
}

interface Waiter {
  readonly ready: () => boolean;
  readonly resolve: () => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

interface Harness {
  readonly announcements: readonly Announcement[];
  readonly forced: readonly string[];
  readonly storeKey: string;
  readonly profileDir: string;
  readonly cardPath: string;
  readonly painted: () => string;
  /** The current end of the painted output, so a later wait can look only at what came after it. */
  mark(): number;
  press(keys: string): void;
  awaitFrame(needle: string, since?: number): Promise<void>;
  awaitOutcome(command: string, code: string, exitCode: number): Promise<void>;
  awaitChild(command: string): Promise<Announcement>;
  awaitStdin(announcement: Announcement): Promise<string>;
  release(announcement: Announcement, reply: Reply): void;
  probe(): ProbeReport;
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
}, CLI_TEST_TIMEOUT_MS);

afterAll(() => { rmSync(entry, { force: true }); });

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function startConsole(options: { readonly storeKeyInEnvironment: boolean }): Promise<Harness> {
  const workDir = mkdtempSync(join(tmpdir(), "echolet-tui-reg-"));
  const fakeCli = join(workDir, "fake-cli.mjs");
  const envProbe = join(workDir, "env-probe.mjs");
  const probePath = join(workDir, "env-reads.json");
  const profileDir = join(workDir, "alice");
  // Short and outside the work directory, so the compose row shows it whole at 72 columns.
  const cardPath = join(tmpdir(), `ecard-${String(process.pid)}.json`);
  // A unix socket path has a ~104-byte limit.
  const socketPath = join(tmpdir(), `ereg-${String(process.pid)}-${String(Date.now() % 1_000_000)}.sock`);

  writeFileSync(fakeCli, FAKE_CLI, "utf8");
  writeFileSync(envProbe, ENV_PROBE, "utf8");
  // A public artefact, and the fake CLI never reads it: it exists so the path the operator types
  // names a real file, the way it does on the live system.
  writeFileSync(cardPath, JSON.stringify({ type: "echolet.contact-card", version: 2 }), "utf8");

  const storeKey = randomBytes(32).toString("base64url");
  const announcements: Announcement[] = [];
  const forced: string[] = [];
  const waiters: Waiter[] = [];
  const chunks: Buffer[] = [];

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
    let buffer = "";
    let mine: Announcement | undefined;
    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline === -1) break;
        const parsed = JSON.parse(buffer.slice(0, newline)) as Record<string, unknown>;
        buffer = buffer.slice(newline + 1);
        if (mine === undefined) {
          mine = {
            command: typeof parsed.command === "string" ? parsed.command : "",
            argv: Array.isArray(parsed.argv) ? parsed.argv.map((token) => String(token)) : [],
            storeKeyReached: parsed.storeKeyReached === true,
            socket,
            // The single-flight fact, recorded at the one instant it is decidable.
            concurrent: announcements.some((earlier) => !earlier.released),
            released: false,
            stdin: null,
          };
          announcements.push(mine);
        } else {
          mine.stdin = typeof parsed.stdin === "string" ? parsed.stdin : "";
        }
        settle();
      }
    });
  });

  await new Promise<void>((done, fail) => {
    server.once("error", fail);
    server.listen(socketPath, () => { done(); });
  });

  const environment: Record<string, string | undefined> = {
    ...process.env,
    ECHOLET_FAKE_SOCKET: socketPath,
    ECHOLET_PROBE_NAME: KEY_ENV,
    ECHOLET_PROBE_OUT: probePath,
  };
  // Step 0's precondition, present or absent — the whole difference between the two scenarios.
  if (options.storeKeyInEnvironment) environment[KEY_ENV] = storeKey;
  else delete environment[KEY_ENV];

  const child: ChildProcess = spawn(process.execPath, [
    "--import", pathToFileURL(envProbe).href,
    entry,
    "--profile", profileDir,
    "--label", "alice",
    // Deliberately NO `--relay-url`: t35 §2.1 gives the relay URL no default, so the operator has
    // to type it, which is what makes this a registration done from inside the console.
    "--store-key-env", KEY_ENV,
    "--cli", fakeCli,
  ], {
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
    for (const announcement of announcements) announcement.socket.destroy();
    await new Promise<void>((done) => { server.close(() => { done(); }); });
    rmSync(socketPath, { force: true });
    rmSync(cardPath, { force: true });
    rmSync(workDir, { recursive: true, force: true });
  });

  const release = (announcement: Announcement, reply: Reply): void => {
    announcement.released = true;
    announcement.socket.write(`${JSON.stringify(reply)}\n`);
  };

  return {
    announcements,
    forced,
    storeKey,
    profileDir,
    cardPath,
    painted,
    mark: () => painted().length,
    press: (keys: string) => { child.stdin?.write(keys); },
    awaitFrame: (needle: string, since = 0) =>
      wait(`a frame containing ${JSON.stringify(needle)}`, () => painted().slice(since).includes(needle)),
    awaitOutcome: (command: string, code: string, exitCode: number) => {
      const line = `${command} → ${code} (exit ${String(exitCode)})`;
      return wait(`the activity line ${JSON.stringify(line)}`, () => painted().includes(line));
    },
    awaitChild: async (command: string) => {
      const match = (): Announcement | undefined => announcements.find((entry) => entry.command === command && !entry.released);
      await wait(`the console to spawn ${command}`, () => match() !== undefined);
      const found = match();
      if (found === undefined) throw new Error(`no ${command} child`);
      return found;
    },
    awaitStdin: async (announcement: Announcement) => {
      await wait(`${announcement.command} to report its stdin`, () => announcement.stdin !== null);
      return announcement.stdin ?? "";
    },
    release,
    probe: () => JSON.parse(readFileSync(probePath, "utf8")) as ProbeReport,
    // Nothing is left hanging: a child the test never answered would keep the console alive and
    // turn a wrong result into a timeout, so any such child is answered here and NAMED, and the
    // tests assert that the list is empty.
    quit: () => {
      for (const announcement of announcements) {
        if (announcement.released) continue;
        forced.push(announcement.command);
        release(announcement, { stdout: failure("PERSISTENCE_FAILURE"), exit: 5 });
      }
      // Ctrl-C rather than `q`: it is the one binding that survives an open compose row and an open
      // modal, so quitting never depends on which state the console happens to be in (AC8).
      child.stdin?.write(CTRL_C);
      return closed;
    },
  };
}

/** The four identifiers `contact import` prints on stderr while it waits at its own prompt. */
const IDENTIFIER_LINE = `${JSON.stringify(PEER)}\n`;

describe("AC1: registration is completed from inside the console alone", () => {
  it(
    "drives init → relay publish → contact export → contact import → doctor from keystrokes, one child at a time",
    async () => {
      const operator = await startConsole({ storeKeyInEnvironment: true });
      await operator.awaitFrame(UNAUDITED_NOTICE);

      // t35 §2.1's one unasked-for command: a startup `doctor`, so the console does not begin
      // knowing neither its own identity nor whether the profile exists. Here it reports the
      // profile is not there, which is what puts the checklist on the pane.
      const startup = await operator.awaitChild("doctor");
      operator.release(startup, { stdout: failure("INVALID_CONFIGURATION"), exit: 2 });
      await operator.awaitOutcome("doctor", "INVALID_CONFIGURATION", 2);
      await operator.awaitFrame("step 1");

      /*
       * Step 0 is SATISFIED, and the pane has to say so on the first frame that carries the
       * checklist. This is the named half of the descriptor hole (004-T18-verify, F-005): the probe
       * now answers a descriptor request for the key with a value-less descriptor, so an
       * implementation that spelled presence as `Object.getOwnPropertyDescriptor(env, name)?.value`
       * computes `false` and prints the "create a key" recipe for a key that is already there. That
       * fails HERE, in milliseconds, naming what went wrong — rather than 45 seconds later as a
       * timeout waiting for an `init` child the checklist would never start.
       */
      expect(
        operator.painted().includes(`export ${KEY_ENV}=`),
        "the console did not see the store key it was given: step 0 told the operator to create one that already exists",
      ).toBe(false);

      // STEP 1 — the identity. The relay URL has no default and is typed here; the profile
      // directory and the store-key variable name are the ones this console was launched with.
      operator.press(ENTER);
      await operator.awaitFrame("relay-url ▸");
      operator.press(RELAY_URL);
      await operator.awaitFrame(RELAY_URL);
      operator.press(ENTER);
      const init = await operator.awaitChild("init");
      operator.release(init, { stdout: ok({ identity_id: OWN_IDENTITY, device_id: OWN_DEVICE, profile_id: "0d1f4a2b" }), exit: 0 });
      await operator.awaitOutcome("init", "ok", 0);

      // STEP 2 — the publication pool.
      operator.press(ENTER);
      const publish = await operator.awaitChild("relay publish");
      operator.release(publish, { stdout: ok({ published: true }), exit: 0 });
      await operator.awaitOutcome("relay publish", "ok", 0);

      // STEP 3 — their own card, to a path the console offers and the operator accepts.
      operator.press(ENTER);
      await operator.awaitFrame("export-path ▸");
      operator.press(ENTER);
      const exported = await operator.awaitChild("contact export");
      operator.release(exported, { stdout: ok({}), exit: 0 });
      await operator.awaitOutcome("contact export", "ok", 0);

      // STEP 4 — the peer's card, through the trust modal and the CHILD's own prompt.
      operator.press(ENTER);
      await operator.awaitFrame("card-path ▸");
      operator.press(operator.cardPath);
      await operator.awaitFrame(basename(operator.cardPath));
      operator.press(ENTER);
      const imported = await operator.awaitChild("contact import");
      operator.release(imported, { stderr: IDENTIFIER_LINE, expectStdin: true, stdout: ok({}), exit: 0 });
      // The modal opens on the identifiers the CHILD printed, and it shows them in full.
      await operator.awaitFrame(PEER.device_pubkey);
      await operator.awaitFrame(PEER.signal_identity_key);
      operator.press("y");
      await operator.awaitOutcome("contact import", "ok", 0);
      expect(await operator.awaitStdin(imported), "the operator's answer goes to the child's own prompt").toBe("y\n");

      // STEP 5 — the confirmation, and the pane turns into the ordinary detail rows.
      operator.press(ENTER);
      const confirm = await operator.awaitChild("doctor");
      operator.release(confirm, { stdout: ok({ identity_id: OWN_IDENTITY, device_id: OWN_DEVICE, contact_count: 1 }), exit: 0 });
      await operator.awaitOutcome("doctor", "ok", 0);
      await operator.awaitFrame(OWN_IDENTITY);

      await operator.quit();

      // ── counted behind the barrier: the console has closed, so nothing is still on its way ────
      const commands = operator.announcements.map((entry) => entry.command);
      expect(commands, "AC1: the five registration commands, in order, and the startup doctor")
        .toEqual(["doctor", "init", "relay publish", "contact export", "contact import", "doctor"]);
      expect(operator.forced, "a child the console spawned was never answered by the checklist").toEqual([]);
      expect(
        operator.announcements.filter((entry) => entry.concurrent).map((entry) => entry.command),
        "a second command was in flight while another was running",
      ).toEqual([]);

      // ── the argv of every child, exactly as t35 §2.1 tabulates it ────────────────────────────
      const argvOf = (command: string): readonly string[] =>
        operator.announcements.find((entry) => entry.command === command)?.argv ?? [];

      expect(argvOf("init")).toEqual([
        "init", "--relay-url", RELAY_URL, "--store-key-env", KEY_ENV, "--profile", operator.profileDir, "--json",
      ]);
      expect(argvOf("relay publish")).toEqual(["relay", "publish", "--profile", operator.profileDir, "--json"]);
      expect(argvOf("contact import")).toEqual([
        "contact", "import", "--from", operator.cardPath, "--profile", operator.profileDir, "--json",
      ]);
      expect(operator.announcements.at(-1)?.argv).toEqual(["doctor", "--profile", operator.profileDir, "--json"]);

      // The export path is generated, so its instant is not pinned — only its shape, which is what
      // keeps a second export from meeting `contact export`'s `flag: "wx"` and exit 5.
      const exportArgv = argvOf("contact export");
      expect(exportArgv.slice(0, 3)).toEqual(["contact", "export", "--out"]);
      expect(exportArgv[3]).toMatch(new RegExp(`^${operator.profileDir}/card-[^/]+\\.json$`));
      expect(exportArgv.slice(4)).toEqual(["--profile", operator.profileDir, "--json"]);

      for (const announcement of operator.announcements) {
        expect(announcement.argv, "`--yes` moves the trust decision out of the child").not.toContain("--yes");
        // AC5/AC6, over REAL argvs rather than over `buildArgv`'s return value.
        for (const token of announcement.argv) expect(token.includes(operator.storeKey)).toBe(false);
        // …while the key still reaches the CLI the way the runbook passes it. Without this, the
        // assertion above is satisfied by a console that broke the feature to close the hazard.
        expect(announcement.storeKeyReached, `${announcement.command} did not inherit the store key`).toBe(true);
      }
      expect(operator.painted().includes(operator.storeKey), "the store key reached a painted frame").toBe(false);

      // ── step 0: the console never read the value, it only noticed the name ───────────────────
      const probe = operator.probe();
      expect(probe.trapped, "the environment probe was not installed; the assertion below proves nothing").toBeGreaterThan(0);
      expect(
        probe.reads.filter((frame) => !frame.includes("node:child_process")),
        "the console read the store key's VALUE — the design requires Object.hasOwn(process.env, name), never process.env[name]",
      ).toEqual([]);
      expect(probe.reads.length, "the key never reached a child, so the probe cannot have been watching").toBeGreaterThan(0);
      // The descriptor trap is the ninth spelling's boundary; if it never fired, the assertion
      // above about `export …=` is proving something else.
      expect(probe.descriptors, "the descriptor trap never fired, so the descriptor path is unwatched").toBeGreaterThan(0);
    },
    CLI_TEST_TIMEOUT_MS,
  );

  it(
    "refuses to start step 1 when the store key is not in its environment, and prints the command the operator runs instead",
    async () => {
      // The pair for the case above: there, Enter spawns `init`; here, the same key spawns nothing
      // at all. An implementation that binds Enter unconditionally fails here; one that never binds
      // it fails there.
      const operator = await startConsole({ storeKeyInEnvironment: false });
      await operator.awaitFrame(UNAUDITED_NOTICE);

      const startup = await operator.awaitChild("doctor");
      operator.release(startup, { stdout: failure("INVALID_CONFIGURATION"), exit: 2 });
      await operator.awaitOutcome("doctor", "INVALID_CONFIGURATION", 2);

      await operator.awaitFrame("step 0");
      await operator.awaitFrame(`export ${KEY_ENV}=`);

      // Enter, then a key with a visible effect. The console reads its stdin in order, so a painted
      // key list proves the Enter before it was processed — and if the Enter had wrongly opened an
      // operand row, `?` would have been text and this wait would time out saying so.
      const at = operator.mark();
      operator.press(ENTER);
      operator.press("?");
      await operator.awaitFrame("key bindings", at);

      await operator.quit();

      expect(
        operator.announcements.map((entry) => entry.command),
        "the console spawned a command with no store key in its environment",
      ).toEqual(["doctor"]);
      expect(operator.forced).toEqual([]);

      // The command the operator is told to run carries no key: the console neither generates the
      // 32 bytes nor writes them anywhere. This is the rejected design, refused by a test.
      for (const line of operator.painted().split("\n")) {
        if (!line.includes("export ")) continue;
        expect(KEY_SHAPED.test(line), "a key-shaped literal is on the line the operator is told to run").toBe(false);
      }
      expect(operator.painted().includes(operator.storeKey)).toBe(false);

      // With the variable absent, `normalizeSpawnArguments` never reads it either — a missing
      // property is not copied into a child's environment. So the permitted read is gone and ANY
      // recorded read is the console reaching for the value, which is the sharpest form this
      // detector takes.
      const probe = operator.probe();
      expect(probe.trapped, "the environment probe was not installed; the assertion below proves nothing").toBeGreaterThan(0);
      expect(
        probe.reads,
        "the console read the store key variable's value to decide whether it is set; presence is `Object.hasOwn`, which cannot",
      ).toEqual([]);
    },
    CLI_TEST_TIMEOUT_MS,
  );

  it(
    "leaves the steps after a failed one unrun, and shows the code and exit class the CLI returned",
    async () => {
      const operator = await startConsole({ storeKeyInEnvironment: true });
      await operator.awaitFrame(UNAUDITED_NOTICE);

      const startup = await operator.awaitChild("doctor");
      operator.release(startup, { stdout: failure("INVALID_CONFIGURATION"), exit: 2 });
      await operator.awaitOutcome("doctor", "INVALID_CONFIGURATION", 2);

      operator.press(ENTER);
      await operator.awaitFrame("relay-url ▸");
      operator.press(RELAY_URL);
      await operator.awaitFrame(RELAY_URL);
      operator.press(ENTER);
      operator.release(await operator.awaitChild("init"), { stdout: ok({ identity_id: OWN_IDENTITY, device_id: OWN_DEVICE }), exit: 0 });
      await operator.awaitOutcome("init", "ok", 0);

      operator.press(ENTER);
      operator.release(await operator.awaitChild("relay publish"), { stdout: ok({}), exit: 0 });
      await operator.awaitOutcome("relay publish", "ok", 0);

      // The failure T34 recorded from the live system: `contact export` writes with `flag: "wx"`,
      // so exporting over a path that already exists is PERSISTENCE_FAILURE at exit 5.
      operator.press(ENTER);
      await operator.awaitFrame("export-path ▸");
      operator.press(ENTER);
      operator.release(await operator.awaitChild("contact export"), { stdout: failure("PERSISTENCE_FAILURE"), exit: 5 });
      await operator.awaitOutcome("contact export", "PERSISTENCE_FAILURE", 5);

      // The next keystroke must retry step 3, not walk past it into step 4.
      const at = operator.mark();
      operator.press(ENTER);
      await operator.awaitFrame("export-path ▸", at);
      operator.press(ENTER);
      const retry = await operator.awaitChild("contact export");
      operator.release(retry, { stdout: failure("PERSISTENCE_FAILURE"), exit: 5 });
      await operator.awaitOutcome("contact export", "PERSISTENCE_FAILURE", 5);

      await operator.quit();

      expect(operator.announcements.map((entry) => entry.command), "a failed step let the checklist advance past it")
        .toEqual(["doctor", "init", "relay publish", "contact export", "contact export"]);
      expect(operator.forced).toEqual([]);
      expect(operator.announcements.filter((entry) => entry.concurrent)).toEqual([]);

      const painted = operator.painted();
      expect(painted).toContain("PERSISTENCE_FAILURE");
      expect(painted).toContain("exit 5");
      // t35 §4.1: on `contact export`, exit 5 has one cause that is not a disk problem, and naming
      // it is the difference between a console that helps and one that says "do not retry blindly".
      expect(painted, "t35 §4.1: exit 5 on contact export names the existing-file cause").toContain("already exists");
    },
    CLI_TEST_TIMEOUT_MS,
  );
});

/**
 * Every way a program can ask `process.env` about one variable, run against `ENV_PROBE` itself.
 *
 * The two cases above assert what the CONSOLE does. This one asserts what the DETECTOR can see, and
 * it exists because 004-T18-verify found the detector's boundary by mutation: five forbidden
 * spellings were each killed, and a sixth — the property descriptor — passed with the 32 bytes in
 * hand. A probe whose reach is only known by mutating the thing it watches is a probe whose reach
 * nobody will re-check after the next edit.
 *
 * It runs the SHIPPED probe text rather than a copy of it: `ENV_PROBE` is written to a file and
 * preloaded with `--import`, exactly as `startConsole` preloads it, and a small script then performs
 * each spelling in turn and reports, for each, whether it OBTAINED the value and what it ANSWERED
 * about presence. The secret is never printed: every reported field is a boolean, the discipline
 * `tui.keyMaterial.test.ts` established.
 */
const SPELLINGS = [
  'import { spawnSync } from "node:child_process";',
  'import { writeFileSync } from "node:fs";',
  "",
  "const name = process.env.ECHOLET_PROBE_NAME;",
  // A second variable carrying the same bytes, so the comparisons below can say "did this spelling
  // obtain the value" without reading the probed name for the comparison itself.
  "const mirror = process.env.ECHOLET_PROBE_MIRROR;",
  "const out = process.env.ECHOLET_SPELLING_OUT;",
  "",
  "const answers = {};",
  "const obtained = {};",
  "",
  "answers.hasOwn = Object.hasOwn(process.env, name);",
  "",
  "answers.comparison = process.env[name] !== undefined;",
  "obtained.comparison = process.env[name] === mirror;",
  "",
  "answers.spread = { ...process.env }[name] !== undefined;",
  "obtained.spread = { ...process.env }[name] === mirror;",
  "",
  "answers.entries = Object.entries(process.env).some(([key]) => key === name);",
  "obtained.entries = Object.fromEntries(Object.entries(process.env))[name] === mirror;",
  "",
  "const { [name]: destructured } = process.env;",
  "answers.destructure = destructured !== undefined;",
  "obtained.destructure = destructured === mirror;",
  "",
  "const serialised = JSON.parse(JSON.stringify(process.env));",
  "answers.serialise = serialised[name] !== undefined;",
  "obtained.serialise = serialised[name] === mirror;",
  "",
  "const descriptor = Object.getOwnPropertyDescriptor(process.env, name);",
  "answers.descriptor = descriptor?.value !== undefined;",
  "obtained.descriptor = descriptor?.value === mirror;",
  "",
  "answers.names = Object.getOwnPropertyNames(process.env).includes(name);",
  "",
  // The feature, not only the hazard: the key must still reach a child through the inherited
  // environment. A probe that closed the descriptor path by breaking `spawn` would be useless.
  'const child = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.env[process.env.ECHOLET_PROBE_NAME] === process.env.ECHOLET_PROBE_MIRROR))"], { env: process.env, encoding: "utf8" });',
  "",
  'writeFileSync(out, JSON.stringify({ answers, obtained, childSawTheValue: child.stdout === "true" }));',
].join("\n");

interface SpellingReport {
  readonly answers: Readonly<Record<string, boolean>>;
  readonly obtained: Readonly<Record<string, boolean>>;
  readonly childSawTheValue: boolean;
}

describe("the environment probe reaches every spelling of a read, including the descriptor", () => {
  it(
    "records every value read through [[Get]] and yields no value through the property descriptor",
    async () => {
      const workDir = mkdtempSync(join(tmpdir(), "echolet-probe-reach-"));
      cleanups.push(() => { rmSync(workDir, { recursive: true, force: true }); });

      const envProbe = join(workDir, "env-probe.mjs");
      const spellings = join(workDir, "spellings.mjs");
      const probePath = join(workDir, "env-reads.json");
      const spellingPath = join(workDir, "spellings.json");

      writeFileSync(envProbe, ENV_PROBE, "utf8");
      writeFileSync(spellings, SPELLINGS, "utf8");

      const secret = randomBytes(32).toString("base64url");
      const child = spawn(process.execPath, ["--import", pathToFileURL(envProbe).href, spellings], {
        cwd: workDir,
        env: {
          ...process.env,
          [KEY_ENV]: secret,
          ECHOLET_PROBE_NAME: KEY_ENV,
          ECHOLET_PROBE_OUT: probePath,
          ECHOLET_PROBE_MIRROR: secret,
          ECHOLET_SPELLING_OUT: spellingPath,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stderr = "";
      child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
      const exitCode = await new Promise<number | null>((done) => { child.once("close", (code) => { done(code); }); });
      expect(exitCode, `the spelling probe failed: ${stderr}`).toBe(0);

      const report = JSON.parse(readFileSync(spellingPath, "utf8")) as SpellingReport;
      const probe = JSON.parse(readFileSync(probePath, "utf8")) as ProbeReport;

      // The permitted spelling, unchanged: presence is answered truthfully and nothing is read.
      expect(report.answers.hasOwn, "Object.hasOwn stopped answering presence — the design's own spelling is broken").toBe(true);
      expect(report.answers.names, "Object.getOwnPropertyNames stopped answering presence").toBe(true);

      // The five forbidden spellings: each really does obtain the value — which is why each has to
      // be recorded — and each was recorded with a frame that is not Node's own child-process code.
      for (const spelling of ["comparison", "spread", "entries", "destructure", "serialise"]) {
        expect(report.obtained[spelling], `${spelling} did not obtain the value, so recording it proves nothing`).toBe(true);
      }
      expect(
        probe.reads.filter((frame) => !frame.includes("node:child_process")).length,
        "the probe recorded fewer reads than the number of forbidden spellings that obtained the value",
      ).toBeGreaterThanOrEqual(5);

      // The ninth spelling, and the whole point of this case. It obtains NOTHING, and it answers
      // `false` about presence — so an implementation written that way is not merely unrecorded, it
      // visibly refuses to start step 1 and the driven case above fails by name.
      expect(report.obtained.descriptor, "the property descriptor still yields the store key's VALUE — F-005 is open").toBe(false);
      expect(report.answers.descriptor, "the descriptor path still answers presence, so a value-read through it stays silent").toBe(false);
      expect(probe.descriptors, "the descriptor trap never fired").toBeGreaterThan(0);

      // …and none of it at the cost of the feature: the child still inherits the real bytes.
      expect(report.childSawTheValue, "closing the descriptor path stopped the key reaching a child").toBe(true);
    },
    CLI_TEST_TIMEOUT_MS,
  );
});
