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

/**
 * What `--help` prints.
 *
 * MEASURED (flow 003 T2 §4): `echolet-tui --help` answered "--help needs a value" and exited 2,
 * because the option loop reads the next argv entry as a value before it recognises a flag. A
 * console that cannot explain its own invocation is one an operator has to read the source of, so
 * this is usage on stdout and exit 0 — and it never touches the alternate screen on the way out.
 *
 * No option here can carry a key value, and the text says where the key does travel.
 */
const USAGE = [
  "echolet operator console — an UNAUDITED PROTOTYPE, not for sensitive communication.",
  "",
  "usage: echolet-tui --profile <dir> [options] [--profile <dir> [options] …]",
  "",
  "  --profile <dir>        a profile directory; repeat for more than one profile",
  "  --label <name>         what to call the preceding profile on screen",
  "  --relay-url <url>      the relay the preceding profile is configured against",
  "  --store-key-env <var>  the NAME of the environment variable holding that profile's",
  "                         32-byte store key. The value is never read here: it reaches",
  "                         the CLI through the inherited environment.",
  "  --card <path>          a contact card the preceding profile may import with [i]",
  "  --cli <path>           the CLI bundle to drive (default: cli.js beside this file)",
  "  --help                 print this and exit",
  "",
  "Keys: [1-5] pane  [p] poll  [d] doctor  [r] publish  [h] history  [i] import",
  "      [c] contact  [t] profile  [?] help  [q] quit",
].join("\n");

const HELP_FLAGS = new Set(["--help", "-h"]);

/**
 * True when argv asks for usage, read POSITIONALLY so that a value which happens to look like the
 * flag — `--label -h` — is a label and not a request for help.
 */
function wantsHelp(argv: readonly string[]): boolean {
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] ?? "";
    if (HELP_FLAGS.has(token)) return true;
    // Every other option this binary has takes exactly one value; skip it.
    index += 1;
  }
  return false;
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
    // A zero-argument flag must be recognised BEFORE its successor is read as a value, or
    // `--help` on its own is reported as a missing operand — which is what it did.
    if (HELP_FLAGS.has(flag)) continue;
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
  const argv = process.argv.slice(2);
  if (wantsHelp(argv)) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }

  const options = parseOptions(argv);

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

      // A child that exits before its stdin is drained makes the write fail with EPIPE, and an
      // unhandled 'error' on the stream would take the whole console down with it. That was
      // survivable while stdin only ever carried a two-byte trust answer; a message body is large
      // enough to still be in flight when a child refuses early, so the failure is absorbed here
      // and the child's own exit code is what gets reported.
      child.stdin.on("error", () => { /* The outcome is settled by 'close'/'error' on the child. */ });

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

      // Exactly two things are ever written to a child's stdin, and this is both of them.
      //
      // `contact import` is left open so the operator's answer to the child's own
      // `Trust these contact identifiers? [y/N]` prompt can be written when it arrives.
      //
      // `send` is handed the message body and then closed immediately, because the CLI reads the
      // body to EOF: this is why the body is not on argv, where `ps` would show the plaintext of an
      // end-to-end encrypted message to every process this user owns. It is written and never
      // logged. `--text` is not passed alongside it, and that matters: the CLI resolves `--text`
      // first and does not read stdin at all when it is present, so a body sent both ways would be
      // silently ignored here rather than refused.
      //
      // Every other command still gets an empty, immediately closed stdin.
      if (request.command === "send") child.stdin.end(request.text, "utf8");
      else if (request.command !== "contact import") child.stdin.end();
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
