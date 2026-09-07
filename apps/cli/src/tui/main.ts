import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildArgv, parseCliOutcome, type CliOutcome, type CliRequest } from "./cli-bridge";
import { createInitialState, type ProfileView, type TrustIdentifiers } from "./state";
import { runTuiShell, type TuiIo } from "./tui-shell";

/**
 * The composition root of the operator console (flow 002 T9).
 *
 * This file wires `TuiIo` and calls `runTuiShell`. It holds no decisions: every question about what
 * to render, what a keystroke means, and whether trust may be recorded is answered by the pure
 * modules beside it. Keeping the wiring here is what lets `src/tui` contain exactly one function
 * that touches a process, a terminal or a clock.
 *
 * **The store key is never read here.** It reaches the child the way the runbook passes it — in the
 * inherited environment, named by `--store-key-env` — so this file passes `process.env` through
 * untouched and never looks inside it. There is no code path from a variable name to its value.
 *
 * Usage:
 *
 * ```sh
 * node apps/cli/dist/tui.js \
 *   --profile "$D/alice" --label alice --relay-url "$URL" --store-key-env ECHOLET_E2E_KEY \
 *     --card "$D/bob-card.json" \
 *   --profile "$D/bob"   --label bob   --relay-url "$URL" --store-key-env ECHOLET_E2E_KEY \
 *     --card "$D/alice-card.json"
 * ```
 *
 * Each profile's own store key must already be in the environment under the name it was given.
 * Two profiles sharing one variable name is exactly the runbook's two-shell-helper arrangement.
 */

const HERE = dirname(fileURLToPath(import.meta.url));

interface Options {
  readonly profiles: readonly ProfileView[];
  readonly cliPath: string;
}

/** Splits argv into one `ProfileView` per `--profile`. No option here can carry a key value. */
function parseOptions(argv: readonly string[]): Options {
  const profiles: ProfileView[] = [];
  let cliPath = resolve(HERE, "cli.js");

  const assign = (key: string, value: string): void => {
    const current = profiles.at(-1);
    if (current === undefined) throw new Error(`${key} must follow a --profile`);
    const patched: Record<string, unknown> = { ...current };
    if (key === "--label") patched.label = value;
    else if (key === "--relay-url") patched.relayUrl = value;
    else if (key === "--store-key-env") patched.storeKeyEnv = value;
    else if (key === "--card") patched.contactCardPath = resolve(value);
    else throw new Error(`unknown option ${key}`);
    profiles[profiles.length - 1] = patched as unknown as ProfileView;
  };

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index] ?? "";
    const value = argv[index + 1];
    if (value === undefined) throw new Error(`${flag} needs a value`);
    index += 1;
    if (flag === "--profile") {
      profiles.push({
        label: `profile-${profiles.length + 1}`,
        profileDir: resolve(value),
        relayUrl: "",
        storeKeyEnv: "",
        identityId: "(run doctor)",
        deviceId: "(run doctor)",
        contactCount: 0,
        published: false,
      });
    } else if (flag === "--cli") {
      cliPath = resolve(value);
    } else {
      assign(flag, value);
    }
  }

  if (profiles.length === 0) throw new Error("at least one --profile <dir> is required");
  return { profiles, cliPath };
}

/** The four identifiers `contact import` prints on stderr while it waits at its own prompt. */
function readIdentifiers(text: string): TrustIdentifiers | undefined {
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (typeof parsed !== "object" || parsed === null) continue;
      const record = parsed as Record<string, unknown>;
      if (typeof record.identity_id !== "string") continue;
      return {
        identity_id: record.identity_id,
        device_id: typeof record.device_id === "string" ? record.device_id : undefined,
        device_pubkey: typeof record.device_pubkey === "string" ? record.device_pubkey : undefined,
        signal_identity_key: typeof record.signal_identity_key === "string" ? record.signal_identity_key : undefined,
      };
    } catch {
      continue;
    }
  }
  return undefined;
}

async function main(): Promise<number> {
  const options = parseOptions(process.argv.slice(2));

  type TrustListener = (input: { readonly cardPath: string; readonly profileLabel: string; readonly identifiers: TrustIdentifiers }) => void;
  let trustListener: TrustListener | undefined;
  /** The child currently waiting at `Trust these contact identifiers? [y/N]`, if any. */
  let awaitingTrust: { write(chunk: string): unknown } | undefined;

  const runCli = (request: CliRequest): Promise<CliOutcome> =>
    new Promise<CliOutcome>((settle) => {
      // The environment is inherited wholesale and never inspected: that is how the 32-byte store
      // key reaches the child without this process ever holding it.
      const child = spawn(process.execPath, [options.cliPath, ...buildArgv(request)], {
        env: process.env,
        stdio: ["pipe", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";
      let announced = false;
      child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
        if (announced || request.command !== "contact import") return;
        const identifiers = readIdentifiers(stderr);
        if (identifiers === undefined) return;
        announced = true;
        awaitingTrust = child.stdin;
        const profile = options.profiles.find((candidate) => candidate.profileDir === request.profileDir);
        trustListener?.({ cardPath: request.from, profileLabel: profile?.label ?? request.profileDir, identifiers });
      });

      const done = (exitCode: number): void => {
        awaitingTrust = undefined;
        settle(parseCliOutcome(stdout, exitCode));
      };
      child.on("error", () => { done(5); });
      child.on("close", (code) => { done(code ?? 1); });

      // Nothing but the trust answer is ever written to a child's stdin.
      if (request.command !== "contact import") child.stdin.end();
    });

  const io: TuiIo = {
    stdout: process.stdout,
    stdin: process.stdin,
    now: () => Date.now(),
    runCli,
    answerTrustPrompt: (answer) => { awaitingTrust?.write(answer ? "y\n" : "n\n"); },
    onTrustIdentifiers: (listener) => { trustListener = listener; },
  };

  return runTuiShell(io, createInitialState({ profiles: options.profiles }));
}

main().then(
  (code) => { process.exitCode = code; },
  (error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  },
);
