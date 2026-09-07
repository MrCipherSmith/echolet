/**
 * Builds the argument vectors the TUI hands to `apps/cli/dist/cli.js`, and parses what comes back.
 *
 * Two contracts live here and nowhere else:
 *
 * 1. **The CLI surface stays frozen at eight commands.** specification.md §CLI surface records that
 *    no ninth command was added during remediation, which is why bundle rotation and pending-send
 *    retry have no entry point. An operator console is exactly the place a ninth command would
 *    creep in, so `CLI_COMMANDS` is the whole surface and `buildArgv` refuses anything else.
 * 2. **No argv may carry key material.** The store key travels in the inherited environment, named
 *    by `--store-key-env`; `buildArgv` is given the variable NAME and never its value. AC5.
 */

export const CLI_COMMANDS = [
  "init",
  "contact export",
  "contact import",
  "relay publish",
  "send",
  "poll",
  "history",
  "doctor",
] as const;

export type CliCommand = (typeof CLI_COMMANDS)[number];

export type CliRequest =
  | { readonly command: "init"; readonly profileDir: string; readonly relayUrl: string; readonly storeKeyEnv: string }
  | { readonly command: "contact export"; readonly profileDir: string; readonly out: string }
  | { readonly command: "contact import"; readonly profileDir: string; readonly from: string }
  | { readonly command: "relay publish"; readonly profileDir: string }
  | { readonly command: "send"; readonly profileDir: string; readonly to: string; readonly text: string; readonly messageId?: string }
  | { readonly command: "poll"; readonly profileDir: string }
  | { readonly command: "history"; readonly profileDir: string; readonly contactIdentityId: string }
  | { readonly command: "doctor"; readonly profileDir: string };

/**
 * One CLI invocation's result.
 *
 * `code` is `"ok"` on success and otherwise the CLI's typed error code, kept verbatim: the three
 * relay refusals the CLI reports under the relay's own name (`PREKEY_BUNDLE_UNAVAILABLE`,
 * `UNAUTHORIZED_MAILBOX_ACCESS`, `SENDER_QUOTA_EXCEEDED`) must stay distinguishable on the
 * operator's surface, since the CLI went to some trouble not to flatten them.
 */
export interface CliOutcome {
  readonly ok: boolean;
  readonly code: string;
  readonly exitCode: number;
  readonly data: unknown;
}

/**
 * The exit codes documented in specification.md §CLI surface:
 * 0 success, 2 input/configuration, 3 trust/protocol, 4 temporary relay/network, 5 persistence.
 */
export const EXIT_CODES = { success: 0, input: 2, trust: 3, relay: 4, persistence: 5 } as const;

/** Reported when the child's stdout is not one readable JSON envelope. */
export const UNREADABLE_CLI_OUTPUT = "UNREADABLE_CLI_OUTPUT";

/**
 * The argument vector for one frozen command.
 *
 * Two invariants, both of which are tested rather than conventional:
 *
 * - **Nothing outside `CLI_COMMANDS` is buildable.** The union makes a ninth command a type error;
 *   this refusal is the runtime half, and it names the command it refused so that a caller which
 *   reached here through a cast learns what it asked for.
 * - **No token carries key material.** The only key-related token any command emits is
 *   `--store-key-env` followed by the environment variable NAME, which is what the runbook passes.
 *   Values are handed through verbatim and never quoted or escaped: `identity_id` is base64url, so
 *   roughly one identity in sixty-four begins with `-`, and the CLI already rewrites `--opt value`
 *   into `--opt=value` itself for exactly that reason. Pre-mangling here would undo that fix.
 */
export function buildArgv(request: CliRequest): string[] {
  switch (request.command) {
    case "init":
      return ["init", "--relay-url", request.relayUrl, "--store-key-env", request.storeKeyEnv, "--profile", request.profileDir, "--json"];
    case "contact export":
      return ["contact", "export", "--out", request.out, "--profile", request.profileDir, "--json"];
    case "contact import":
      // Deliberately without `--yes`. The modal shows the four identifiers and the operator answers
      // the child's own `Trust these contact identifiers? [y/N]` prompt afterwards, so the CLI's
      // guard and the TUI's guard both hold. `--yes` would leave the decision resting on the TUI.
      return ["contact", "import", "--from", request.from, "--profile", request.profileDir, "--json"];
    case "relay publish":
      return ["relay", "publish", "--profile", request.profileDir, "--json"];
    case "send":
      return [
        "send", "--to", request.to, "--text", request.text,
        ...(request.messageId === undefined ? [] : ["--message-id", request.messageId]),
        "--profile", request.profileDir, "--json",
      ];
    case "poll":
      return ["poll", "--profile", request.profileDir, "--json"];
    case "history":
      return ["history", "--with", request.contactIdentityId, "--profile", request.profileDir, "--json"];
    case "doctor":
      return ["doctor", "--profile", request.profileDir, "--json"];
    default: {
      const refused = (request as { readonly command?: unknown }).command;
      throw new Error(`refused: ${String(refused)} is outside the frozen eight-command CLI surface`);
    }
  }
}

/**
 * Reads one JSON envelope from the child's stdout.
 *
 * Never throws. A console that crashed on a malformed line would lose the whole session's state
 * along with the message, which is strictly worse than reporting that the line was unreadable.
 * Typed failure codes are kept verbatim — in particular the three refusals the CLI reports under
 * the relay's own name, which it went to some trouble not to flatten into `PROTOCOL_REJECTED`.
 */
export function parseCliOutcome(stdout: string, exitCode: number): CliOutcome {
  const unreadable: CliOutcome = { ok: false, code: UNREADABLE_CLI_OUTPUT, exitCode, data: null };

  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout) as unknown;
  } catch {
    return unreadable;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return unreadable;

  const envelope = parsed as { readonly ok?: unknown; readonly data?: unknown; readonly error?: unknown };
  if (envelope.ok === true) return { ok: true, code: "ok", exitCode, data: envelope.data ?? null };

  const error = typeof envelope.error === "object" && envelope.error !== null
    ? (envelope.error as { readonly code?: unknown })
    : {};
  const code = typeof error.code === "string" && error.code.length > 0 ? error.code : UNREADABLE_CLI_OUTPUT;
  return { ok: false, code, exitCode, data: envelope.data ?? null };
}
