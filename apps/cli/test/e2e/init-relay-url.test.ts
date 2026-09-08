import { expect, it } from "vitest";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CLI_CHILD_TIMEOUT_MS, E2E_TEST_TIMEOUT_MS } from "../childProcessTimeouts";

/**
 * RED suite for flow 002 / T10-F-003 — `echolet init` must refuse a relay URL that every later
 * command refuses, and it must refuse it as a CONFIGURATION error.
 *
 * What T10 measured
 * -----------------
 * `init --relay-url https://relay.example.com/path` exits **0** today: `parseClientConfig`
 * (`apps/cli/src/runtime/config.ts:20-29`) checks the scheme, the credentials and the fragment but
 * never the path or the query. `RelayClient`'s constructor
 * (`apps/cli/src/transport/relayClient.ts:76`) does check them — `url.search`, `url.pathname !== "/"`
 * — so the profile is written to disk and then every relay command on it exits **5
 * PERSISTENCE_FAILURE**: a code that points the operator at their disk for a mistake that is on
 * their command line. Nothing is wrong with the store. Nothing a retry, a remount or a restore can
 * fix. The operator is sent to look in the wrong place, and the profile they were told was created
 * is unusable.
 *
 * That is exactly the failure class the T8 TLS work argues elsewhere must be loud, immediate and
 * named correctly, so it is pinned here as a test rather than recorded as a residual.
 *
 * Why the real binary
 * -------------------
 * Finding T47-TP-001 caught a fixture-only proof that passed while the defect survived, and T10
 * caught a one-page flood hiding a seventeen-page defect. The property under test here is what the
 * SHIPPED `init` accepts and what exit code the SHIPPED process returns, so every invocation below
 * spawns the real `apps/cli/dist/cli.js` (built once by `test/globalSetup.ts`; no suite may rebuild
 * it) and reads its real exit code and its real `--json` envelope. No module is imported from the
 * source tree and no `RelayClient` is mocked.
 *
 * Leak discipline
 * ---------------
 * Store keys are freshly generated per invocation and are asserted absent from both streams. No
 * plaintext, ciphertext, key material or HTTP body is printed by any assertion here.
 *
 * Offline by construction
 * -----------------------
 * No relay is started and no name is resolved: every rejected URL must be refused before a single
 * byte leaves the process, and the one reachability control below points at a closed loopback port.
 */

const project = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const cli = join(project, "apps/cli/dist/cli.js");

interface Result { code: number | null; stdout: string; stderr: string }
function command(args: string[], env: Record<string, string> = {}, timeoutMs = CLI_CHILD_TIMEOUT_MS): Promise<Result> {
  return new Promise((done, reject) => {
    const child = spawn(process.execPath, [cli, ...args], { cwd: project, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("init E2E child timeout")); }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", (code) => { clearTimeout(timer); done({ code, stdout, stderr }); });
  });
}

/** The typed code out of the `--json` envelope, or "none". Never the message, never a body. */
function errorCode(result: Result): string {
  try {
    const value = JSON.parse(result.stdout) as { ok?: boolean; error?: { code?: unknown } };
    const code = typeof value.error?.code === "string" ? value.error.code : "none";
    return /^[A-Z_]+$/.test(code) ? code : "none";
  } catch { return "unparseable"; }
}

/**
 * Relay URLs `RelayClient` refuses at construction and `init` must therefore refuse too.
 *
 * The property is not "a path is ugly": it is that `init` and `RelayClient` must agree on what a
 * relay URL is, so that a profile `init` reports as created is a profile the rest of the CLI can
 * use. Every entry here is a URL the transport already refuses.
 */
const contradictory = [
  // T10-F-003 verbatim: the URL the verifier ran, which exits 0 and then exits 5 forever.
  { label: "a path", url: "https://relay.example.com/path" },
  { label: "a path with a trailing slash", url: "https://relay.example.com/path/" },
  { label: "a nested path", url: "https://relay.example.com/echolet/v1/" },
  // `relayClient.ts:76` refuses `url.search` in the same expression as the path.
  { label: "a query string", url: "https://relay.example.com/?token=abc" },
  // The same contradiction on the loopback HTTP path `config.ts` otherwise allows.
  { label: "a path on a loopback relay", url: "http://127.0.0.1:8081/path" },
] as const;

/** Relay URLs both layers accept. These are guards: they must keep exiting 0. */
const agreed = [
  { label: "a bare HTTPS origin", url: "https://relay.example.com" },
  { label: "an HTTPS origin with the root path", url: "https://relay.example.com/" },
  { label: "a loopback HTTP origin", url: "http://127.0.0.1:8081/" },
] as const;

it.each(contradictory)("RED: `init` refuses a relay URL carrying $label as a configuration error, not as a persistence failure", async ({ url }) => {
  const directory = mkdtempSync(join(tmpdir(), "echolet-init-relay-url-"));
  const profile = join(directory, "profile");
  const storeKey = randomBytes(32).toString("base64url");
  try {
    const result = await command(["init", "--relay-url", url, "--store-key-env", "ECHOLET_E2E_KEY", "--profile", profile, "--json"], { ECHOLET_E2E_KEY: storeKey });
    expect(result.stdout.includes(storeKey), "the store key must never reach stdout").toBe(false);
    expect(result.stderr.includes(storeKey), "the store key must never reach stderr").toBe(false);

    expect(
      result.code,
      `init exited ${String(result.code)} (${errorCode(result)}) on a relay URL the transport refuses to construct a client for. ` +
        "It must exit 2. `RelayClient` (relayClient.ts:76) refuses this URL, so accepting it here writes a profile no relay command can ever use, " +
        "and the operator learns that only when `relay publish` exits 5 PERSISTENCE_FAILURE — a local-storage code for a mistake on the command line. " +
        "`parseClientConfig` (config.ts:20-29) must apply the same rule the transport applies (T10-F-003)",
    ).toBe(2);
    expect(
      errorCode(result),
      "the refusal must be reported as INVALID_CONFIGURATION. PERSISTENCE_FAILURE sends the operator to their disk for a configuration error, " +
        "which is exactly the class of misdirected failure the TLS design argues must be loud and unmissable",
    ).toBe("INVALID_CONFIGURATION");

    // A refused configuration must not leave a half-created profile behind for the operator to
    // discover later: `init` either produced a usable profile or produced nothing.
    expect(existsSync(join(profile, "config.json")), "a refused init must not write a profile").toBe(false);
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, E2E_TEST_TIMEOUT_MS);

it.each(agreed)("guard: `init` still accepts $label", async ({ url }) => {
  const directory = mkdtempSync(join(tmpdir(), "echolet-init-relay-url-ok-"));
  const profile = join(directory, "profile");
  const storeKey = randomBytes(32).toString("base64url");
  try {
    const result = await command(["init", "--relay-url", url, "--store-key-env", "ECHOLET_E2E_KEY", "--profile", profile, "--json"], { ECHOLET_E2E_KEY: storeKey });
    expect(result.code, `init exited ${String(result.code)} (${errorCode(result)}) on a relay URL the transport accepts; tightening init must not narrow what a valid relay URL is`).toBe(0);
    expect(result.stdout.includes(storeKey)).toBe(false);
    expect(result.stderr.includes(storeKey)).toBe(false);
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, E2E_TEST_TIMEOUT_MS);

/**
 * The complement of the RED above, and the reason its exit code matters: exit 5 must mean the
 * store. A profile whose relay URL both layers agree on, pointed at a port with nothing behind it,
 * must fail as a relay condition — never as PERSISTENCE_FAILURE.
 *
 * Port 1 is used deliberately: it is privileged, nothing binds it in a test environment, and the
 * connection is refused locally, so this assertion neither resolves a name nor leaves the host.
 */
it("guard: an unreachable relay is not reported as a local persistence failure", async () => {
  const directory = mkdtempSync(join(tmpdir(), "echolet-init-relay-url-unreachable-"));
  const profile = join(directory, "profile");
  const storeKey = randomBytes(32).toString("base64url");
  try {
    const init = await command(["init", "--relay-url", "http://127.0.0.1:1/", "--store-key-env", "ECHOLET_E2E_KEY", "--profile", profile, "--json"], { ECHOLET_E2E_KEY: storeKey });
    expect(init.code, `init exited ${String(init.code)} (${errorCode(init)})`).toBe(0);

    const publish = await command(["relay", "publish", "--profile", profile, "--json"], { ECHOLET_E2E_KEY: storeKey });
    expect(
      publish.code,
      `relay publish against an unreachable relay exited ${String(publish.code)} (${errorCode(publish)}). ` +
        "Exit 5 PERSISTENCE_FAILURE must be reserved for the local store; a relay that cannot be reached is a relay condition",
    ).not.toBe(5);
    expect(errorCode(publish)).not.toBe("PERSISTENCE_FAILURE");
    expect(publish.stdout.includes(storeKey)).toBe(false);
    expect(publish.stderr.includes(storeKey)).toBe(false);
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, E2E_TEST_TIMEOUT_MS);
