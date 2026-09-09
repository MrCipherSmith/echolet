import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CLI_CHILD_TIMEOUT_MS, CLI_TEST_TIMEOUT_MS } from "../../test/childProcessTimeouts";

// Flow 004, T8 — a LIVE defect, not a hypothetical (verification 004-T7, F-004 / F-008).
//
// `resolveSendBody` (cli.ts:240-257) treats `--text` as present only when it is a NON-EMPTY string:
//
//     const hasFlagBody = typeof flagBody === "string" && flagBody.length > 0;
//
// so `--text ""` is silently reclassified as "absent" and the body is read from stdin instead.
// Before flow 004's first slice, `rejectUnexpectedMissing` listed "text" for send and `required`
// refused a zero-length value, so `--text ""` was INVALID_ARGUMENTS, exit 2. The change's own commit
// message calls this row "Unchanged from earlier releases"; it is not.
//
// WHY IT MATTERS TODAY. `--text "$*"` is the ordinary shell shape and it is the shape of the
// operator's own wrapper outside this repository, `~/.echolet/peer`. Called with no message, `$*`
// expands to the empty string, and what used to be an immediate exit 2 is now a read of stdin — in
// any non-interactive context (a service, `docker exec` without a TTY, a wrapper invoked from
// another script) a HANG with no timeout and no diagnostic, instead of a failure.
//
// WHAT THIS FILE SPECIFIES. `--text` supplied but empty is INVALID_ARGUMENTS, exit 2, and stdin is
// NOT READ AT ALL. The second half is the load-bearing one, and a test that only asserted exit 2
// would pass an implementation that drained stdin first and refused afterwards — which is exactly
// the implementation that hangs. So it is proven CAUSALLY, not by inspection: the child is given a
// stdin pipe that is never closed. Any read to EOF blocks forever; only a refusal that never touches
// stdin can exit. The verifier measured this same asymmetry against the built CLI (F-007: without
// `--text`, an unclosed stdin pipe never exited within 20s and had to be SIGKILLed; with `--text`,
// the identical invocation exited in well under a second).
//
// The two hanging cases are in separate `it()` blocks deliberately: while they are RED each one
// spends a full `CLI_CHILD_TIMEOUT_MS` at the watchdog, and two of them in one test would exceed the
// enclosing `CLI_TEST_TIMEOUT_MS` and surface as vitest's generic per-test timeout instead of this
// file's own, specific "still running" message.
//
// Every timeout comes from apps/cli/test/childProcessTimeouts.ts, never a new literal.

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const manifest = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8")) as { bin?: string | { echolet?: string } };
const bin = typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.echolet;
const entry = resolve(packageDir, bin ?? "dist/cli.js");
const paths: string[] = [];

type ProcessResult = { code: number | null; stdout: string; stderr: string; timedOut: boolean };

/**
 * Spawns the CLI with a stdin pipe THIS PROCESS NEVER CLOSES.
 *
 * That open pipe is the whole instrument. A child that reads its body from stdin reads to EOF, and
 * EOF never comes, so it cannot exit; a child that refuses before touching stdin exits immediately.
 * `timedOut` therefore distinguishes "stdin was read" from "stdin was not read" without any
 * inspection of the implementation.
 */
function childWithOpenStdin(args: string[], environment: Record<string, string | undefined>, prewrite = ""): Promise<ProcessResult> {
  return new Promise((resolveResult, reject) => {
    const processChild = spawn(process.execPath, [entry, ...args], {
      cwd: packageDir,
      env: { ...process.env, ...environment },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "", stderr = "", timedOut = false;
    const timeout = setTimeout(() => { timedOut = true; processChild.kill("SIGKILL"); }, CLI_CHILD_TIMEOUT_MS);
    processChild.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    processChild.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    processChild.on("error", (error) => { clearTimeout(timeout); reject(error); });
    processChild.on("close", (code) => { clearTimeout(timeout); resolveResult({ code, stdout, stderr, timedOut }); });
    processChild.stdin.on("error", () => { /* The child may exit before draining; EPIPE is expected here. */ });
    // Written but NOT ended. A "drain stdin, then decide" implementation would consume these bytes
    // and still block waiting for an EOF that never arrives.
    if (prewrite.length > 0) processChild.stdin.write(prewrite);
  });
}

/** The ordinary, closed-stdin spawner, for the fixture commands that need one. */
function child(args: string[], environment: Record<string, string | undefined>, stdin = ""): Promise<ProcessResult> {
  return new Promise((resolveResult, reject) => {
    const processChild = spawn(process.execPath, [entry, ...args], {
      cwd: packageDir,
      env: { ...process.env, ...environment },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "", stderr = "";
    const timeout = setTimeout(() => { processChild.kill("SIGKILL"); reject(new Error("CLI child timed out")); }, CLI_CHILD_TIMEOUT_MS);
    processChild.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    processChild.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    processChild.on("error", (error) => { clearTimeout(timeout); reject(error); });
    processChild.on("close", (code) => { clearTimeout(timeout); resolveResult({ code, stdout, stderr, timedOut: false }); });
    processChild.stdin.on("error", () => { /* Entrypoint may reject before reading stdin. */ });
    processChild.stdin.end(stdin);
  });
}

beforeAll(() => { expect(existsSync(entry)).toBe(true); });
afterEach(() => { for (const path of paths.splice(0)) rmSync(path, { recursive: true, force: true }); });

function fixture() {
  const profileDir = mkdtempSync(join(tmpdir(), "echolet-cli-emptytext-")); paths.push(profileDir);
  return { profileDir, environment: { ECHOLET_TEST_KEY: randomBytes(32).toString("base64url") } };
}
type Fixture = ReturnType<typeof fixture>;

/** An initialised profile, so a refusal below can only be about the argument and never about configuration. */
async function init(owner: Fixture): Promise<void> {
  const result = await child(
    ["init", "--relay-url", "http://127.0.0.1:1", "--store-key-env", "ECHOLET_TEST_KEY", "--profile", owner.profileDir, "--json"],
    owner.environment,
  );
  expect(result.code, `init failed: stdout=${result.stdout} stderr=${result.stderr}`).toBe(0);
}

/** Never imported anywhere in this file, so a body that IS accepted stops at the local trust check. */
const UNTRUSTED_IDENTITY = "SYNTHETIC_UNTRUSTED_IDENTITY_0000000000000000000000";

const sendArgs = (owner: Fixture, text: string): string[] => [
  "send", "--to", UNTRUSTED_IDENTITY, "--text", text, "--message-id", randomUUID(),
  "--profile", owner.profileDir, "--json",
];

function refused(result: ProcessResult): void {
  expect(
    result.timedOut,
    "the CLI was still running when the watchdog fired: an explicitly supplied `--text` was refused only AFTER stdin had been read, " +
      "which is the hang `--text \"$*\"` produces in `~/.echolet/peer` when it is called with no message",
  ).toBe(false);
  expect(result.code, `stdout=${result.stdout} stderr=${result.stderr}`).toBe(2);
  const parsed = JSON.parse(result.stdout) as { ok?: unknown; error?: unknown };
  expect(parsed.ok).toBe(false);
  expect(parsed.error).toMatchObject({ code: "INVALID_ARGUMENTS" });
}

describe("`send --text \"\"` is refused as INVALID_ARGUMENTS without reading stdin", () => {
  it(
    "refuses an explicitly supplied empty --text with exit 2, while stdin is an open pipe that is never closed",
    async () => {
      const owner = fixture();
      await init(owner);
      refused(await childWithOpenStdin(sendArgs(owner, ""), owner.environment));
    },
    CLI_TEST_TIMEOUT_MS,
  );

  it(
    "refuses it identically when a body IS waiting on that unclosed stdin — an empty --text is not " +
      "rescued by stdin, and stdin is not drained before the refusal",
    async () => {
      const owner = fixture();
      await init(owner);
      // If the refusal came only after a read, these bytes would be consumed and the process would
      // then block on the EOF that never arrives — `timedOut`, not exit 2.
      refused(await childWithOpenStdin(sendArgs(owner, ""), owner.environment, "SYNTHETIC_STDIN_BODY_THAT_MUST_NOT_RESCUE_AN_EMPTY_FLAG"));
    },
    CLI_TEST_TIMEOUT_MS,
  );

  // The control for the two cases above, and green today. It proves the instrument reports a real
  // exit rather than reporting "did not hang" for a process that could never have hung: with a
  // NON-EMPTY `--text`, the same never-closed stdin pipe still lets the CLI run to the local trust
  // check. So `timedOut === false` above is a fact about `--text ""` and not about the harness.
  it(
    "control: a non-empty --text still completes against the same never-closed stdin pipe",
    async () => {
      const owner = fixture();
      await init(owner);
      const result = await childWithOpenStdin(sendArgs(owner, "SYNTHETIC_NONEMPTY_FLAG_BODY"), owner.environment);
      expect(result.timedOut).toBe(false);
      expect(result.code, `stdout=${result.stdout} stderr=${result.stderr}`).toBe(3);
      expect((JSON.parse(result.stdout) as { error?: unknown }).error).toMatchObject({ code: "CONTACT_NOT_TRUSTED" });
    },
    CLI_TEST_TIMEOUT_MS,
  );
});
