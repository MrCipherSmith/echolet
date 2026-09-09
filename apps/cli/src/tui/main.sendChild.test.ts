import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { afterEach, describe, expect, it } from "vitest";
import { CLI_CHILD_TIMEOUT_MS, CLI_TEST_TIMEOUT_MS } from "../../test/childProcessTimeouts";

// Flow 004, T8 — the assertion AC3 asks for and the tree does not have: "a test asserts the
// complete argv of every spawned child and fails if a body appears anywhere in it."
//
// WHY THIS FILE EXISTS (verification 004-T7, F-001 / F-002, both blockers). Every argv assertion in
// this package runs over the PURE `buildArgv` in `cli-bridge.ts`. Nothing looks at what `main.ts`
// actually hands to `spawn()`. The verifier appended
//
//     ...(request.command === "send" ? ["--text", request.text] : [])
//
// to the real `spawn()` argument list at `main.ts:174`, OUTSIDE `buildArgv`, and 17 files / 117
// tests passed. The same run also survived `child.stdin.end()` in place of
// `child.stdin.end(request.text, "utf8")` at `main.ts:221` — the console could send an empty
// message forever and nothing would notice. Both mutations are killed here, by the same child.
//
// A regression of the first kind is silent at runtime as well as in the suite: the CLI resolves
// `--text` first and never reads stdin when it is present, so a spawned argv carrying `--text` still
// SENDS CORRECTLY while publishing the plaintext of an end-to-end encrypted message to `ps` for the
// life of the child. The test is the only possible detector.
//
// ── Why the shell is substituted, and nothing else ───────────────────────────────────────────────
//
// The console cannot yet issue a `send`: `mapKey`/`paneKeyIntent` (tui-shell.ts:110-138) bind
// p/d/r/h/i/c/t and no compose surface exists, so no keystroke reaches `main.ts`'s send path. A
// keystroke-driven send — the shape `main.processDriven.test.ts` uses for poll/doctor/publish — is
// therefore impossible today WITHOUT A SOURCE CHANGE, and this dispatch writes tests only.
//
// So the substitution is made at the one seam that already exists: `main.ts` imports `runTuiShell`
// and hands it a `TuiIo` whose `runCli` is the function under test. An esbuild `onResolve` plugin
// points `./tui-shell` at a stub that calls `io.runCli(<one send request>)` once. EVERYTHING ELSE IS
// THE SHIPPED CODE: the real `main()`, the real `parseOptions`, the real `buildArgv`, the real
// `spawn()` at :174 with the real inherited environment, and the real `child.stdin.end(...)` at :221.
// A real child process really is spawned, and it reports the argv, the stdin bytes and the
// environment it was actually given. Only the decision of WHEN to send is stubbed, because that
// decision is the part of the console that has not been built.
//
// The body never travels in this test's environment either — it is written to a file the stub reads
// — so `environmentHits` below is a real assertion about AC3's second clause ("never appears in the
// argv OR ENVIRONMENT of any child") and not an artefact of how the test passes its fixture.
//
// Every timeout comes from apps/cli/test/childProcessTimeouts.ts, never a new literal (flow 003
// T16 / T40: a fresh millisecond guess sized on an idle machine is the defect that already cost this
// project a day of false-red runs under contention).

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** A body that is option-shaped, multi-line and untrimmed: the three things that break naive argv handling. */
const BODY_MARKER = "SYNTHETIC_CONSOLE_PLAINTEXT_MARKER";
const BODY = `--json ${BODY_MARKER} first line\nsecond line\n`;
const PEER_IDENTITY = "SYNTHETIC_PEER_IDENTITY_0000000000000000000000";

/**
 * The child. It is not a CLI: it records the three things AC3 is about — the argv it was invoked
 * with, the bytes it was given on stdin, and the NAMES (never the values) of environment variables
 * carrying the body — and then answers one JSON envelope so the console's `runCli` settles.
 */
const RECORDING_CLI = [
  'import { readFileSync, writeFileSync } from "node:fs";',
  "",
  'const marker = readFileSync(process.env.ECHOLET_MARKER_PATH, "utf8");',
  "const chunks = [];",
  'process.stdin.on("data", (chunk) => { chunks.push(chunk); });',
  'process.stdin.on("end", () => {',
  "  const environmentHits = Object.entries(process.env)",
  '    .filter(([, value]) => typeof value === "string" && value.includes(marker))',
  "    .map(([name]) => name)",
  "    .sort();",
  "  writeFileSync(process.env.ECHOLET_CHILD_RECORD_PATH, JSON.stringify({",
  "    argv: process.argv.slice(2),",
  '    stdin: Buffer.concat(chunks).toString("utf8"),',
  "    environmentHits,",
  "  }));",
  '  process.stdout.write(JSON.stringify({ ok: true, data: {} }));',
  "});",
].join("\n");

/**
 * The stub shell. It is the ONLY substitution: it issues exactly one request through the real
 * `TuiIo.runCli` that `main.ts` built, and records the outcome so the test can prove the send path
 * ran to completion rather than being skipped.
 */
const ONE_SEND_SHELL = [
  'import { readFileSync, writeFileSync } from "node:fs";',
  "",
  "export async function runTuiShell(io) {",
  '  const request = JSON.parse(readFileSync(process.env.ECHOLET_SEND_REQUEST_PATH, "utf8"));',
  "  const outcome = await io.runCli(request);",
  "  writeFileSync(process.env.ECHOLET_SEND_OUTCOME_PATH, JSON.stringify(outcome));",
  "  return 0;",
  "}",
].join("\n");

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });

interface ChildRecord {
  readonly argv: readonly string[];
  readonly stdin: string;
  readonly environmentHits: readonly string[];
}

describe("the console's real spawned child never sees a message body on argv, and always sees it on stdin", () => {
  it(
    "spawns `send` with the exact argv `buildArgv` specifies — no token carrying the plaintext, no " +
      "environment variable carrying it — and writes the body, byte for byte and untrimmed, to that " +
      "child's stdin",
    async () => {
      const workDir = mkdtempSync(join(tmpdir(), "echolet-tui-sendchild-"));
      // The bundle lives under dist/ (like main.processDriven.test.ts's) so module resolution
      // behaves the way it does for the shipped binary, and is private to this process so a
      // concurrently running suite never observes a partially written file.
      const entry = join(packageDir, "dist", `tui.sendchild-${String(process.pid)}.js`);
      cleanups.push(() => { rmSync(entry, { force: true }); });
      cleanups.push(() => { rmSync(workDir, { recursive: true, force: true }); });

      const recordingCli = join(workDir, "recording-cli.mjs");
      const shellStub = join(workDir, "one-send-shell.mjs");
      const markerPath = join(workDir, "marker.txt");
      const requestPath = join(workDir, "request.json");
      const outcomePath = join(workDir, "outcome.json");
      const recordPath = join(workDir, "record.json");
      const profileDir = join(workDir, "alice");
      const messageId = randomUUID();

      writeFileSync(recordingCli, RECORDING_CLI, "utf8");
      writeFileSync(shellStub, ONE_SEND_SHELL, "utf8");
      writeFileSync(markerPath, BODY_MARKER, "utf8");
      writeFileSync(
        requestPath,
        JSON.stringify({ command: "send", profileDir, to: PEER_IDENTITY, text: BODY, messageId }),
        "utf8",
      );

      await build({
        entryPoints: [join(packageDir, "src/tui/main.ts")],
        outfile: entry,
        bundle: true,
        platform: "node",
        format: "esm",
        target: "node22.13",
        legalComments: "none",
        sourcemap: false,
        plugins: [{
          name: "one-send-shell",
          setup(builder) {
            // Only `main.ts` imports `./tui-shell`; `cli-bridge.ts` and `state.ts` — the modules
            // that decide the argv — are bundled exactly as shipped.
            builder.onResolve({ filter: /^\.\/tui-shell$/ }, () => ({ path: shellStub }));
          },
        }],
      });

      const consoleProcess: ChildProcess = spawn(
        process.execPath,
        [entry, "--profile", profileDir, "--label", "alice", "--cli", recordingCli],
        {
          cwd: packageDir,
          env: {
            ...process.env,
            ECHOLET_MARKER_PATH: markerPath,
            ECHOLET_SEND_REQUEST_PATH: requestPath,
            ECHOLET_SEND_OUTCOME_PATH: outcomePath,
            ECHOLET_CHILD_RECORD_PATH: recordPath,
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );

      let timedOut = false;
      let output = "";
      consoleProcess.stdout?.on("data", (chunk: Buffer) => { output += chunk.toString("utf8"); });
      consoleProcess.stderr?.on("data", (chunk: Buffer) => { output += chunk.toString("utf8"); });
      const watchdog = setTimeout(() => { timedOut = true; consoleProcess.kill("SIGKILL"); }, CLI_CHILD_TIMEOUT_MS);
      const code = await new Promise<number | null>((done, fail) => {
        consoleProcess.once("error", fail);
        consoleProcess.once("close", (exitCode) => { clearTimeout(watchdog); done(exitCode); });
      });

      expect(timedOut, `the console did not finish its one send; it printed ${JSON.stringify(output)}`).toBe(false);
      expect(code, `the console exited ${String(code)} printing ${JSON.stringify(output)}`).toBe(0);

      // The send actually ran: without this, every assertion below could be vacuously satisfied by a
      // console that spawned nothing at all.
      const outcome = JSON.parse(readFileSync(outcomePath, "utf8")) as { readonly ok?: unknown; readonly exitCode?: unknown };
      expect(outcome.ok).toBe(true);
      expect(outcome.exitCode).toBe(0);

      const record = JSON.parse(readFileSync(recordPath, "utf8")) as ChildRecord;

      // AC3, clause 1, over a REAL spawned child rather than over `buildArgv`'s return value: the
      // complete argument vector, pinned exactly. An implementation that appends the body anywhere —
      // inside `buildArgv` or, as mutation M6 did, in `main.ts`'s `spawn()` call after it — fails
      // here whatever token it hides the body behind.
      expect(record.argv).toEqual([
        "send", "--to", PEER_IDENTITY, "--message-id", messageId, "--profile", profileDir, "--json",
      ]);
      // Said again the way the criterion is worded, so the failure names the hazard rather than an
      // array mismatch: no token may contain any of the plaintext, however it is spelled or split.
      expect(
        record.argv.filter((token) => token.includes(BODY_MARKER)),
        "the plaintext of an end-to-end encrypted message reached a child's argv, where `ps` shows it to every process this user owns",
      ).toEqual([]);
      // AC3, same clause, second half: nor may it reach the child's environment, which `main.ts`
      // passes through wholesale.
      expect(
        record.environmentHits,
        "the plaintext reached the spawned child's environment",
      ).toEqual([]);

      // F-002: the console's whole functional point, and until now covered by nothing. Byte-exact
      // and untrimmed — the embedded and trailing newlines are asserted by being part of `BODY`,
      // which is what `readStdinBody`'s untrimmed contract means at the console boundary.
      expect(record.stdin).toBe(BODY);
      expect(record.stdin).not.toBe(BODY.trimEnd());
    },
    CLI_TEST_TIMEOUT_MS,
  );
});
