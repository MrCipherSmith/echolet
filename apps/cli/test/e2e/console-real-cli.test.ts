import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { CLI_CHILD_TIMEOUT_MS, E2E_TEST_TIMEOUT_MS, CLI_TEST_TIMEOUT_MS } from "../childProcessTimeouts";

/**
 * Flow 004, T25 — AC1's last clause and AC10's first, against the SHIPPED binaries and a REAL relay.
 *
 * Every other driven test of the console spawns a fake CLI the test itself writes
 * (`FAKE_CLI`, `src/tui/main.registration.processDriven.test.ts:114-156`). That proves the console
 * drives *a* child process correctly; it cannot prove `apps/cli/dist/cli.js` accepts the argv the
 * console emits, that the real `contact import` prints its four identifiers in a shape
 * `readIdentifiers` (`src/tui/main.ts:160-180`) recognises, that the real `send` reads a body the
 * console writes to its stdin, or that anything the console does reaches a relay. 004-T24's wave
 * report names that as the highest-cost open gap in the flow ("undiscovered risk sitting under every
 * other claim"). This file closes it by removing the fake:
 *
 *   - `dist/tui.js`  — the shipped console, built by `test/globalSetup.ts`, driven by keystrokes on
 *                      a pipe, exactly as `main.registration.processDriven.test.ts` drives its own
 *                      esbuild of `main.ts`.
 *   - `dist/cli.js`  — the shipped CLI, handed to the console with `--cli` and spawned by the
 *                      console's own `spawn()`. Nothing here stubs it.
 *   - `apps/relay`   — the real relay binary, brought up on a free loopback port exactly as
 *                      `two-process.test.ts` and `relay-tls.test.ts` bring it up.
 *
 * The peer is a second REAL profile driven with the real CLI directly, which is what lets the
 * assertion "the message arrived" be made by READING IT ON THE OTHER SIDE rather than by believing
 * the console's own report of its own send.
 *
 * ── WHAT THIS FILE DOES NOT COVER, AND WHY ─────────────────────────────────────────────────────
 *
 * AC10 asks for a live run "on the tailnet, with the second user on `depr`". A test harness has no
 * tailnet and no second operator; it has a loopback relay and a second profile on this machine. So
 * this covers AC10's PROTOCOL half (registration, a message sent, a message received, both
 * directions, against the real relay binary) and not its DEPLOYMENT half. The remaining half is
 * recorded as an AC10 miss in 004-T25-verify-result.json rather than papered over here.
 *
 * The console is also driven over a PIPE rather than a pty, so `io.stdout.columns` is undefined and
 * the frame falls back to `MIN_VIEWPORT` (`tui-shell.ts:809-812`). That is the same fallback every
 * other driven test in this package uses, and it is a real code path — but it is not a real terminal,
 * and no assertion here should be read as one.
 *
 * ── TIMEOUTS ───────────────────────────────────────────────────────────────────────────────────
 *
 * Every one comes from `apps/cli/test/childProcessTimeouts.ts`. Flow 003 T16/T40: a fresh
 * millisecond guess sized on an idle machine is the defect that already cost this project a day of
 * false-red runs under contention. `relay publish` alone was measured at ~20s under load there, and
 * this test runs two of them plus a full registration.
 */

const project = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const suite = mkdtempSync(join(tmpdir(), "echolet-console-e2e-"));
const relayBinary = join(suite, "relay");
const cli = join(project, "apps/cli/dist/cli.js");
const tui = join(project, "apps/cli/dist/tui.js");

/** Alice's store key lives here, in the console's own environment, named by `--store-key-env`. */
const ALICE_KEY_ENV = "ECHOLET_CONSOLE_E2E_KEY";
/** Bob's, in the environment of the CLI children this test spawns directly. */
const BOB_KEY_ENV = "ECHOLET_PEER_E2E_KEY";

const ENTER = "\r";
/** AC8's way out, and the one key that quits from every state. */
const CTRL_C = String.fromCharCode(3);

interface Result { code: number | null; stdout: string; stderr: string }

function command(executable: string, args: string[], env: Record<string, string> = {}, timeoutMs = CLI_CHILD_TIMEOUT_MS): Promise<Result> {
  return new Promise((done, reject) => {
    const child = spawn(executable, args, { cwd: project, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("E2E child timeout")); }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", (code) => { clearTimeout(timer); done({ code, stdout, stderr }); });
  });
}

async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((done, reject) => {
    const force = setTimeout(() => child.kill("SIGKILL"), 1500);
    const limit = setTimeout(() => reject(new Error("Relay teardown timeout")), 4000);
    child.once("close", () => { clearTimeout(force); clearTimeout(limit); done(); });
    child.kill("SIGTERM");
  });
}

async function listen(server: Server) {
  await new Promise<void>((done, reject) => {
    const timer = setTimeout(() => reject(new Error("Loopback listen timeout")), 3000);
    server.once("error", (error) => { clearTimeout(timer); reject(error); });
    server.listen(0, "127.0.0.1", () => { clearTimeout(timer); done(); });
  });
  const address = server.address(); if (!address || typeof address === "string") throw new Error("Missing loopback address");
  return address.port;
}

async function close(server: Server) {
  server.closeAllConnections();
  await new Promise<void>((done, reject) => {
    const timer = setTimeout(() => reject(new Error("Reservation teardown timeout")), 3000);
    server.close((error) => { clearTimeout(timer); error ? reject(error) : done(); });
  });
}

async function relayReady(url: string, child: ChildProcess) {
  const end = Date.now() + 10000;
  while (Date.now() < end) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error("Relay exited during startup");
    try { if ((await fetch(`${url}/health`, { signal: AbortSignal.timeout(500) })).ok) return; } catch { /* bounded startup retry */ }
    await delay(50);
  }
  throw new Error("Relay readiness timeout");
}

/** Every file under `directory` must be free of every marker. Inherited from `two-process.test.ts`. */
function scan(directory: string, markers: string[]) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) scan(path, markers);
    else if (entry.isFile()) {
      const bytes = readFileSync(path);
      for (const marker of markers) expect(bytes.includes(Buffer.from(marker))).toBe(false);
    }
  }
}

beforeAll(async () => {
  // Both bundles are built once by the vitest globalSetup (apps/cli/test/globalSetup.ts). Rebuilding
  // either here would race the command suite, which spawns the same binaries.
  expect(existsSync(cli), "dist/cli.js was not built by globalSetup").toBe(true);
  expect(existsSync(tui), "dist/tui.js was not built by globalSetup").toBe(true);
  expect((await command("go", ["-C", "apps/relay", "build", "-o", relayBinary, "./cmd/relay"], { GOCACHE: join(project, ".gocache") }, CLI_TEST_TIMEOUT_MS)).code).toBe(0);
}, E2E_TEST_TIMEOUT_MS);

afterAll(() => rmSync(suite, { recursive: true, force: true }));

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

interface Waiter {
  readonly ready: () => boolean;
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
  readonly what: string;
}

/**
 * The console, running as the shipped binary over pipes.
 *
 * Every wait is on an EVENT — a substring of a painted frame, or the process exiting — and nothing
 * sleeps. The console's exit is the barrier behind which the transcript is complete.
 */
function startConsole(options: {
  readonly profileDir: string;
  readonly storeKey: string;
  readonly cardPath: string;
}) {
  const chunks: Buffer[] = [];
  const waiters: Waiter[] = [];
  let exited = false;

  const painted = (): string => Buffer.concat(chunks).toString("utf8");

  const settle = (): void => {
    for (let index = waiters.length - 1; index >= 0; index -= 1) {
      const waiter = waiters[index];
      if (waiter === undefined) continue;
      if (waiter.ready()) {
        waiters.splice(index, 1);
        clearTimeout(waiter.timer);
        waiter.resolve();
      } else if (exited) {
        waiters.splice(index, 1);
        clearTimeout(waiter.timer);
        waiter.reject(new Error(`the console exited while waiting for ${waiter.what}`));
      }
    }
  };

  const wait = (what: string, ready: () => boolean): Promise<void> => new Promise<void>((done, fail) => {
    if (ready()) { done(); return; }
    const timer = setTimeout(() => {
      const at = waiters.findIndex((candidate) => candidate.timer === timer);
      if (at !== -1) waiters.splice(at, 1);
      fail(new Error(`timed out waiting for ${what}`));
    }, CLI_CHILD_TIMEOUT_MS);
    waiters.push({ ready, resolve: done, reject: fail, timer, what });
  });

  const child: ChildProcess = spawn(process.execPath, [
    tui,
    "--profile", options.profileDir,
    "--label", "alice",
    // Deliberately NO `--relay-url`: the operator types it into the console, which is what makes
    // this a registration done from inside the console (t35 §2.1).
    "--store-key-env", ALICE_KEY_ENV,
    "--card", options.cardPath,
    "--cli", cli,
  ], {
    cwd: project,
    env: { ...process.env, [ALICE_KEY_ENV]: options.storeKey },
    stdio: ["pipe", "pipe", "pipe"],
  });

  let consoleStderr = "";
  child.stdout?.on("data", (chunk: Buffer) => { chunks.push(chunk); settle(); });
  child.stderr?.on("data", (chunk: Buffer) => { consoleStderr += chunk.toString("utf8"); });
  child.stdin?.on("error", () => { /* the console may exit while a keystroke is in flight */ });

  const closed = new Promise<number | null>((done) => {
    child.once("close", (code) => { exited = true; settle(); done(code); });
  });

  cleanups.push(async () => {
    if (!exited) { child.kill("SIGKILL"); await closed; }
  });

  return {
    painted,
    stderr: () => consoleStderr,
    mark: () => painted().length,
    press: (keys: string) => { child.stdin?.write(keys); },
    awaitFrame: (needle: string, since = 0) =>
      wait(`a frame containing ${JSON.stringify(needle)}`, () => painted().slice(since).includes(needle)),
    /** The activity line's head, which is stable whatever prose `explain` appends beside it. */
    awaitOutcome: (cmd: string, code: string, exitCode: number) => {
      const line = `${cmd} → ${code} (exit ${String(exitCode)})`;
      return wait(`the activity line ${JSON.stringify(line)}`, () => painted().includes(line));
    },
    quit: () => { child.stdin?.write(CTRL_C); return closed; },
  };
}

type HistoryEntry = { messageId: string; direction: string; plaintext: string; sequence: number };

it("drives the shipped console over the shipped CLI against a real relay: registration, send, receive", async () => {
  const directory = mkdtempSync(join(suite, "run-"));
  const alice = join(directory, "alice"), bob = join(directory, "bob"), data = join(directory, "relay-data");
  const aliceKey = randomBytes(32).toString("base64url"), bobKey = randomBytes(32).toString("base64url");
  /*
   * SHORT ON PURPOSE, and the reason is a MEASURED defect this test found rather than a convenience.
   *
   * `formatHistoryLines` (history-pane.ts:41) paints one entry as
   * `  <sequence>  <direction>  <messageId>  <plaintext>`, and `messageId` is a 36-character UUID.
   * At `MIN_VIEWPORT` — which is what a console driven over a pipe gets, and what an 80-column
   * terminal is barely above — the prefix costs 53 columns for an `outbound` row and 52 for an
   * `inbound` one, leaving 19 and 20 columns for the BODY. Measured on this very run at 72 columns:
   *
   *   "  1  outbound  37ffccdc-5428-4ae6-87da-bcdd8fb42ec5  CONSOLE_E2E_OUT_ea2"
   *   "  2  inbound  cb926153-a958-4419-96af-346282953f1d  CONSOLE_E2E_IN_b9cf4"
   *
   * — both bodies cut mid-token, with no way to widen the column from inside the console. So a
   * 51-character marker would make this test fail for a reason that is not the round trip, and a
   * test that asserted the truncated prefix would enshrine the defect. The markers are therefore
   * sized to FIT, the round trip is asserted on them, and the full-fidelity assertion is made
   * against the STORE (`aliceHistory`, below) where no pane can elide it. The elision itself is
   * recorded as a finding in `004-T25-verify-result.json`, not pinned here.
   */
  const fromConsole = `EOUT_${randomBytes(6).toString("hex")}`;
  const reply = `EIN_${randomBytes(6).toString("hex")}`;
  const markers = [fromConsole, reply, aliceKey, bobKey];

  const reserved = createServer(); const relayPort = await listen(reserved); await close(reserved);
  const relayUrl = `http://127.0.0.1:${relayPort}`;
  const relay = spawn(relayBinary, [], {
    cwd: project,
    env: { ...process.env, ECHOLET_HTTP_ADDR: `127.0.0.1:${relayPort}`, ECHOLET_DATA_DIR: data, ECHOLET_RATE_LIMIT_PER_MINUTE: "1000" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let relayLog = "";
  relay.stdout.on("data", (chunk: Buffer) => { relayLog += chunk.toString(); });
  relay.stderr.on("data", (chunk: Buffer) => { relayLog += chunk.toString(); });

  try {
    await relayReady(relayUrl, relay);

    /** One real CLI invocation for the PEER. Alice's commands are spawned by the console itself. */
    async function peer(args: string[], expected = 0, showsPlaintext = false): Promise<Record<string, unknown>> {
      const result = await command(process.execPath, [cli, ...args, "--profile", bob, "--json"], { [BOB_KEY_ENV]: bobKey });
      const value = JSON.parse(result.stdout) as { ok: boolean; data: Record<string, unknown>; error?: { code: string } };
      const safeCode = /^[A-Z_]+$/.test(value.error?.code ?? "") ? value.error!.code : "none";
      expect(result.code, `peer ${args[0]} exit (${safeCode})`).toBe(expected);
      for (const marker of markers) {
        expect(result.stderr.includes(marker)).toBe(false);
        if (!showsPlaintext) expect(result.stdout.includes(marker)).toBe(false);
      }
      expect(value.ok).toBe(expected === 0);
      return value.data;
    }

    // ── the peer, made ready before the console starts, so its card is on disk to be imported ────
    await peer(["init", "--relay-url", relayUrl, "--store-key-env", BOB_KEY_ENV]);
    const bobCard = join(directory, "bob-card.json");
    await peer(["contact", "export", "--out", bobCard]);
    await peer(["relay", "publish"]);
    const bobIdentity = JSON.parse(readFileSync(bobCard, "utf8")).signal_bundle.device_record.identity_id as string;
    const bobDevice = JSON.parse(readFileSync(bobCard, "utf8")).signal_bundle.device_record.device_id as string;
    const bobSignalKey = JSON.parse(readFileSync(bobCard, "utf8")).signal_bundle.signal_identity_key as string;

    // ── AC1, from inside the console alone, against the real CLI ─────────────────────────────────
    const operator = startConsole({ profileDir: alice, storeKey: aliceKey, cardPath: bobCard });
    await operator.awaitFrame("UNAUDITED");

    // The startup `doctor` against a profile that does not exist yet. The real CLI's answer —
    // INVALID_CONFIGURATION at exit 2 — is what puts the checklist on the pane, and it is the first
    // fact in this file that no fake supplied.
    await operator.awaitOutcome("doctor", "INVALID_CONFIGURATION", 2);
    await operator.awaitFrame("step 1");
    expect(
      operator.painted().includes(`export ${ALICE_KEY_ENV}=`),
      "the console did not see the store key it was given: step 0 told the operator to create one that already exists",
    ).toBe(false);

    // STEP 1 — the identity. The relay URL has no default and is typed here.
    operator.press(ENTER);
    await operator.awaitFrame("relay-url ▸");
    operator.press(relayUrl);
    await operator.awaitFrame(relayUrl);
    operator.press(ENTER);
    await operator.awaitOutcome("init", "ok", 0);

    // STEP 2 — the publication pool. Real libsignal, a real pool, a real relay.
    operator.press(ENTER);
    await operator.awaitOutcome("relay publish", "ok", 0);

    // STEP 3 — alice's own card, to the path the console generates and the operator accepts.
    operator.press(ENTER);
    await operator.awaitFrame("export-path ▸");
    operator.press(ENTER);
    await operator.awaitOutcome("contact export", "ok", 0);
    const exported = readdirSync(alice).filter((name) => name.startsWith("card-") && name.endsWith(".json"));
    expect(exported, "the console's generated export path did not produce exactly one card on disk").toHaveLength(1);
    const aliceCard = join(alice, exported[0]!);

    // STEP 4 — the peer's card, through the trust modal and the CHILD's own prompt. The four
    // identifiers on the modal are the ones the REAL `contact import` printed on its stderr, parsed
    // by the real `readIdentifiers`, and they are compared against the card on disk.
    operator.press(ENTER);
    await operator.awaitFrame("card-path ▸");
    operator.press(ENTER);
    await operator.awaitFrame(bobIdentity);
    await operator.awaitFrame(bobDevice);
    await operator.awaitFrame(bobSignalKey);
    operator.press("y");
    await operator.awaitOutcome("contact import", "ok", 0);

    // STEP 5 — the confirmation. `doctor` completes the step only with a non-zero contact_count, so
    // this asserts the import reached the real encrypted store rather than only the screen.
    operator.press(ENTER);
    await operator.awaitOutcome("doctor", "ok", 0);
    const aliceIdentity = JSON.parse(readFileSync(aliceCard, "utf8")).signal_bundle.device_record.identity_id as string;
    await operator.awaitFrame(aliceIdentity);

    // ── the peer pins alice, so the message the console sends can be decrypted and read ──────────
    await peer(["contact", "import", "--from", aliceCard, "--yes"]);

    // ── AC2/AC10 outbound: composed and sent from the console, body on the child's stdin ─────────
    operator.press("3");                       // the conversation pane, where [w] is bound
    operator.press("c");                       // select the contact the trust modal produced
    operator.press("w");
    await operator.awaitFrame("message ▸");
    operator.press(fromConsole);
    await operator.awaitFrame(fromConsole);
    operator.press(ENTER);
    await operator.awaitOutcome("send", "ok", 0);

    // ── read it on the OTHER SIDE, with the real CLI, out of the real store ──────────────────────
    await peer(["poll"]);
    const bobHistory = (await peer(["history", "--with", aliceIdentity], 0, true)).entries as HistoryEntry[];
    expect(bobHistory, "the peer's store holds exactly the one message the console sent").toHaveLength(1);
    expect(bobHistory[0]!.direction).toBe("inbound");
    expect(
      bobHistory[0]!.plaintext === fromConsole,
      "the body the operator typed into the console is not the body the peer decrypted",
    ).toBe(true);

    // ── AC10 inbound: the other direction, read INSIDE the console ───────────────────────────────
    await peer(["send", "--to", aliceIdentity, "--text", reply]);
    const beforePoll = operator.mark();
    operator.press("p");
    await operator.awaitOutcome("poll", "ok", 0);
    operator.press("h");
    await operator.awaitOutcome("history", "ok", 0);
    await operator.awaitFrame(reply, beforePoll);
    // …and what the console painted is what the store holds, not an echo of the poll: the same two
    // messages, in the same order, read back through the CLI.
    const aliceHistory = (await (async () => {
      const result = await command(process.execPath, [cli, "history", "--with", bobIdentity, "--profile", alice, "--json"], { [ALICE_KEY_ENV]: aliceKey });
      expect(result.code).toBe(0);
      return (JSON.parse(result.stdout) as { data: { entries: HistoryEntry[] } }).data;
    })()).entries;
    expect(aliceHistory.map((entry) => entry.plaintext)).toEqual([fromConsole, reply]);

    // ── AC8: Ctrl-C leaves, and the transcript is complete behind the exit ───────────────────────
    expect(await operator.quit()).toBe(0);

    const transcript = operator.painted();
    expect(transcript.includes(aliceKey), "the store key reached a painted frame").toBe(false);
    for (const marker of markers) expect(operator.stderr().includes(marker), "a secret or a plaintext reached the console's stderr").toBe(false);
    // The registration checklist really did complete: five steps, from inside the console.
    for (const outcome of [
      "init → ok (exit 0)",
      "relay publish → ok (exit 0)",
      "contact export → ok (exit 0)",
      "contact import → ok (exit 0)",
      "send → ok (exit 0)",
    ]) expect(transcript, `${outcome} is absent from the console's own transcript`).toContain(outcome);

    for (const marker of markers) expect(relayLog.includes(marker)).toBe(false);
    await stop(relay);
    scan(data, markers);
  } finally {
    await stop(relay);
  }
}, E2E_TEST_TIMEOUT_MS);
