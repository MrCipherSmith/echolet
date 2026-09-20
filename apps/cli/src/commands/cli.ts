import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { ConfigurationError, parseClientConfig, type ClientConfig } from "../runtime/config";
import { InboundError, openInboundMessenger } from "../runtime/inbound";
import { MAX_PLAINTEXT_BYTES, OutboundError, openOutboundMessenger } from "../runtime/outbound";
import { openProfile, PersistenceError, ProfileError, type ContactIdentifiers, type Profile } from "../runtime/profile";
import { RelayClient, RelayError } from "../transport/relayClient";

type ExitCode = 2 | 3 | 4 | 5;

class CliFailure extends Error {
  constructor(readonly code: string, readonly exitCode: ExitCode) {
    super(code);
    this.name = "CliFailure";
  }
}

const inputFailure = (code = "INVALID_ARGUMENTS"): CliFailure => new CliFailure(code, 2);
const trustFailure = (code = "TRUST_REJECTED"): CliFailure => new CliFailure(code, 3);
const persistenceFailure = (): CliFailure => new CliFailure("PERSISTENCE_FAILURE", 5);

/**
 * Non-retryable relay conditions the operator must be able to tell apart from a trust/protocol
 * rejection, reported under the relay's own code so one name means one thing on both sides of the
 * wire. Everything else the relay refuses stays `PROTOCOL_REJECTED`: a bundle conflict, a rejected
 * signature or a refused envelope really is a protocol rejection, and the failure vocabulary should
 * grow only where flattening actively misleads.
 *
 * `PREKEY_BUNDLE_UNAVAILABLE` is that case. The relay reports it whenever its availability scan
 * finds no unexpired, unclaimed bundle matching the selector (`ClaimSignalV2`,
 * storage/repository/signal_prekey_bundle_v2.go), which covers four conditions and not only the
 * first: every member of the recipient's published pool has been claimed (each bundle serves exactly
 * one first-contact sender, so an exhausted recipient is one whose whole pool is gone), the
 * recipient never published at all, every published bundle is outside its validity window, or the
 * requested `device_id` selector matches no available bundle. None of the four is a trust violation,
 * and all four were previously indistinguishable from a forged signature. The exit code stays 3, as
 * documented in specification.md.
 *
 * `UNAUTHORIZED_MAILBOX_ACCESS` is the second. Since T50 (finding T49-F-001) `/v1/messages/send`
 * authenticates the sender against an already-published, root-signed device record, so `send` now
 * presupposes `relay publish`; a profile that has only run `init` and `contact import` is refused
 * under that code. Like the prekey case it is an ordinary, operator-fixable precondition rather
 * than a trust violation, and flattening it into `PROTOCOL_REJECTED` names nothing the operator
 * can act on. The same code answers a mailbox poll or ack from a device the relay does not hold a
 * binding for, which is the same condition seen from the other side. The exit code stays 3.
 *
 * `SENDER_QUOTA_EXCEEDED` is the third. Since T54 (finding T52-F-001) `/v1/messages/send` bounds how
 * many unacknowledged envelopes one sender identity may hold in one recipient's mailbox, so a send
 * to a peer who has not polled in a long while is declined once that allowance is full. The
 * condition is temporary and belongs to the recipient, not to the sender: it clears as the recipient
 * acknowledges the backlog or as the envelopes expire. Nothing about it is a trust violation, and
 * flattening it into `PROTOCOL_REJECTED` would tell the operator their peer rejected them when in
 * fact their peer is simply behind. The exit code stays 3 — the relay answers 403, not 429, so the
 * condition is never mistaken for a retryable relay outage on exit 4.
 */
const reportedRelayCodes: ReadonlySet<string> = new Set(["PREKEY_BUNDLE_UNAVAILABLE", "UNAUTHORIZED_MAILBOX_ACCESS", "SENDER_QUOTA_EXCEEDED"]);

const cliOptions = {
  profile: { type: "string" },
  json: { type: "boolean" },
  "relay-url": { type: "string" },
  "store-key-env": { type: "string" },
  out: { type: "string" },
  from: { type: "string" },
  yes: { type: "boolean" },
  to: { type: "string" },
  text: { type: "string" },
  "message-id": { type: "string" },
  with: { type: "string" },
} as const;

type CliValues = {
  profile?: string;
  json?: boolean;
  "relay-url"?: string;
  "store-key-env"?: string;
  out?: string;
  from?: string;
  yes?: boolean;
  to?: string;
  text?: string;
  "message-id"?: string;
  with?: string;
};

const commandOptions: Readonly<Record<string, readonly string[]>> = {
  init: ["profile", "json", "relay-url", "store-key-env"],
  "contact export": ["profile", "json", "out"],
  "contact import": ["profile", "json", "from", "yes"],
  "relay publish": ["profile", "json"],
  send: ["profile", "json", "to", "text", "message-id"],
  poll: ["profile", "json"],
  history: ["profile", "json", "with"],
  doctor: ["profile", "json"],
};

const stringOptions: ReadonlySet<string> = new Set(
  Object.entries(cliOptions).filter(([, option]) => option.type === "string").map(([name]) => name),
);

const optionSeparator = "--";

/**
 * Rewrites `--option value` into `--option=value` for declared string options.
 *
 * Node's `parseArgs` in strict mode refuses the space-separated form whenever the value begins
 * with `-`, but accepts exactly the same value written inline. Identity ids are base64url, an
 * alphabet that contains `-`, so about one identity in sixty-four could not be addressed at all;
 * a message body beginning with `-` was refused for the same reason.
 *
 * What the rewrite deliberately DOES change: a declared string option now takes the next
 * argument as its value even when that argument itself looks like an option. `send --text --json`
 * used to be refused with ERR_PARSE_ARGS_INVALID_OPTION_VALUE (INVALID_ARGUMENTS, exit 2); it now
 * sends the literal body `--json`, and `--json` is not set. That is the standard GNU/`getopt`
 * rule - an option's operand is the next argument, whatever it looks like - and it is the point
 * of the rewrite, because `-`-leading identity ids and message bodies must be addressable at all.
 * Write `--text=--json`, or place the flag before the value-taking option, when the leading `--`
 * is meant as a flag.
 *
 * Outside that one class the rewrite is narrow, so the rest of what `parseArgs` and
 * `parseCommand` reject today keeps reaching them unchanged:
 * - only names declared as `type: "string"` are rewritten, so `--json`/`--yes` never swallow an
 *   operand and an unknown flag still raises ERR_PARSE_ARGS_UNKNOWN_OPTION;
 * - an argument already carrying `=` is passed through, so the inline form is never re-wrapped;
 * - an option with nothing after it, or with only the `--` separator after it, is passed through
 *   so that `parseArgs` still reports the missing value;
 * - the `--` separator and everything after it is copied verbatim, keeping operands operands.
 *
 * Repetition is not this function's concern: `parseArgs` emits one option token per occurrence
 * in either form, so `parseCommand`'s duplicate check is unaffected.
 */
function inlineStringOptionValues(args: readonly string[]): string[] {
  const rewritten: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] as string;
    if (arg === optionSeparator) { rewritten.push(...args.slice(index)); break; }
    const value = args[index + 1];
    const isRewritable = arg.startsWith("--") && !arg.includes("=")
      && stringOptions.has(arg.slice(2)) && value !== undefined && value !== optionSeparator;
    if (!isRewritable) { rewritten.push(arg); continue; }
    rewritten.push(`${arg}=${value}`);
    index += 1;
  }
  return rewritten;
}

function parseCommand(rawArgs: string[]): { command: string; values: CliValues } {
  const args = inlineStringOptionValues(rawArgs);
  const parsed = (() => {
    try { return parseArgs({ args, allowPositionals: true, strict: true, options: cliOptions, tokens: true }); }
    catch { throw inputFailure(); }
  })();
  const command = parsed.positionals.join(" ");
  const allowed = commandOptions[command];
  if (!allowed) throw inputFailure();
  const seen = new Set<string>();
  for (const token of parsed.tokens) {
    if (token.kind !== "option") continue;
    if (seen.has(token.name) || !allowed.includes(token.name)) throw inputFailure();
    seen.add(token.name);
  }
  const values: CliValues = parsed.values;
  if (typeof values.profile !== "string" || values.profile.trim() === "") throw inputFailure();
  return { command, values };
}

function required(values: CliValues, key: keyof CliValues): string {
  const value = values[key];
  if (typeof value !== "string" || value.length === 0) throw inputFailure();
  return value;
}

function rejectUnexpectedMissing(command: string, values: CliValues): void {
  const requiredByCommand: Readonly<Record<string, readonly (keyof CliValues)[]>> = {
    init: ["relay-url", "store-key-env"],
    "contact export": ["out"],
    "contact import": ["from"],
    "relay publish": [],
    // `text` is deliberately absent: `send`'s body may arrive on stdin instead of in argv, so a
    // missing `--text` is not by itself a missing argument. What this list can no longer express is
    // the difference between absent and supplied-but-empty, and that difference is the whole rule —
    // so BOTH emptiness rules now live in `resolveSendBody`, the only place that knows about both
    // sources: an explicitly supplied empty `--text` is refused there, and so is an empty stdin
    // body. `required` is not weaker here, it is inapplicable; it cannot see which source was used.
    send: ["to"],
    poll: [],
    history: ["with"],
    doctor: [],
  };
  for (const key of requiredByCommand[command] ?? []) required(values, key);
}

/**
 * Reads a message body from stdin to EOF, bounded, and returns it UTF-8 decoded and UNTRIMMED.
 *
 * Untrimmed is a decision, not an oversight. A trailing newline is what a heredoc, a `printf` and an
 * editor all add, and stripping it would make the same message typed two ways produce two different
 * ciphertexts under two different content hashes — so the bytes the operator supplied are the bytes
 * that get encrypted.
 *
 * The bound is enforced while reading rather than after it, so an oversized body is refused without
 * ever being fully held in memory, and it is `MAX_PLAINTEXT_BYTES` — the same value the messenger
 * refuses on — rather than a second opinion about how large a message may be. Over the bound is
 * `INVALID_MESSAGE`, which is the code `outbound.ts` already produces for exactly this condition;
 * reporting the parser's `INVALID_ARGUMENTS` instead would tell the operator their command was
 * malformed when in fact their message was too big.
 */
async function readStdinBody(): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    total += buffer.byteLength;
    if (total > MAX_PLAINTEXT_BYTES) throw inputFailure("INVALID_MESSAGE");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Decides what `send` will encrypt, from the two places a body may come from.
 *
 * stdin exists as a source because argv does not stay private: on Unix a process's arguments are
 * readable by anything running as the same user for as long as the child lives, so `--text` hands
 * the plaintext of an end-to-end encrypted message to the local process table. The operator console
 * therefore writes the body to the child's stdin and puts nothing on argv.
 *
 * `--text` nevertheless STAYS ACCEPTED. The operator's live prototype scripts outside this
 * repository call it in nine places, and removing it would break the running prototype in order to
 * close an exposure that reaches only callers who choose it. Whether those nine call sites can move
 * to stdin is an open question for the operator; until it is answered, both doors are open and only
 * the console is required to use the safer one.
 *
 * Supplying BOTH is resolved by precedence: `--text` wins and stdin is not read. Refusing the
 * ambiguity was specified first and reverted — see the comment in the body, which explains why the
 * refusal cannot be implemented without making some callers hang.
 *
 * `--text` is SUPPLIED whenever the parser saw it, empty value included; `undefined` is the only
 * absence. A supplied but empty `--text` is `INVALID_ARGUMENTS`, not a fall-through to stdin — see
 * the comment in the body. So "stdin is not read when `--text` is supplied" holds for every
 * supplied value, including the empty one, and the refusal decides on `values.text` alone.
 *
 * A TTY on stdin with no `--text` is refused rather than waited on, so a mistyped command reports a
 * missing body instead of hanging with no prompt while it looks like it is working.
 */
async function resolveSendBody(values: CliValues): Promise<string> {
  const flagBody = values.text;
  // `--text` wins outright, and stdin is NOT read when it is supplied. This looks like a weaker
  // rule than refusing the ambiguity, and it was: the orchestrator asked for the refusal, and the
  // refusal is unimplementable without a hang. Detecting "both sources supplied" means reading
  // stdin to EOF even when `--text` was given, and a caller whose stdin is an inherited pipe that
  // nobody closes — a service, a `docker exec` without a TTY, the wrapper driving the second user
  // on `depr` — would then wait forever instead of sending. A silent precedence is a worse failure
  // than a loud one only while both are survivable; a hang is not. The design (t35 §6 P-1) said
  // `--text` wins, and it was right.
  if (typeof flagBody === "string") {
    // Supplied and empty is refused, and refused HERE, before stdin is touched. Treating it as
    // "absent" and falling through to stdin was a live defect: `--text "$*"` is the ordinary shell
    // shape and the shape of the operator's own wrapper, so calling that wrapper with no message
    // turned an immediate exit 2 into a read of stdin — a hang, in any context without a TTY and
    // without a writer that closes. The presence test is `typeof`, never `length`, and the emptiness
    // test never reads stdin, so this restores the pre-flow-004 refusal without reopening the hang
    // the precedence rule above exists to avoid.
    if (flagBody.length === 0) throw inputFailure();
    return flagBody;
  }
  // With no `--text`, a terminal has nothing to give: refuse rather than wait for a human who was
  // never told to type.
  if (process.stdin.isTTY === true) throw inputFailure();
  const stdinBody = await readStdinBody();
  if (stdinBody.length === 0) throw inputFailure();
  return stdinBody;
}

async function loadConfig(profileDir: string): Promise<ClientConfig> {
  try {
    const raw = await readFile(join(resolve(profileDir), "config.json"), "utf8");
    return parseClientConfig(JSON.parse(raw));
  } catch (error) {
    if (error instanceof ConfigurationError) throw error;
    throw inputFailure("INVALID_CONFIGURATION");
  }
}

async function openExistingProfile(profileDir: string): Promise<Profile> {
  await loadConfig(profileDir);
  try {
    return await openProfile({ profileDir, environment: process.env });
  } catch (error) {
    if (error instanceof ConfigurationError) throw error;
    throw persistenceFailure();
  }
}

function relayFor(config: ClientConfig): RelayClient {
  try {
    return new RelayClient({ baseUrl: config.relay_url, timeoutMs: config.request_timeout_ms });
  } catch {
    throw inputFailure("INVALID_CONFIGURATION");
  }
}

async function readContactFile(path: string): Promise<unknown> {
  try {
    const raw = await readFile(path, "utf8");
    if (Buffer.byteLength(raw) > 1024 * 1024) throw inputFailure("INVALID_CONTACT_CARD");
    return JSON.parse(raw) as unknown;
  } catch (error) {
    if (error instanceof CliFailure) throw error;
    throw inputFailure("INVALID_CONTACT_CARD");
  }
}

const affirmative = (answer: string): boolean => /^(?:y|yes)$/i.test(answer.trim());
const answerLimit = 16;

/**
 * Read one bounded answer line. The prompt settles on the terminating newline, on end of input
 * without one, or on an overlong answer; it never waits for the terminal to close stdin, and it
 * releases stdin afterwards so the process is free to exit.
 */
function readConfirmation(): Promise<boolean> {
  process.stderr.write("Trust these contact identifiers? [y/N] ");
  return new Promise<boolean>((settled) => {
    const input = process.stdin;
    let answer = "";
    let done = false;
    const release = (value: boolean): void => {
      if (done) return;
      done = true;
      input.off("data", onData);
      input.off("end", onEnd);
      input.off("error", onEnd);
      input.pause();
      const releasable: { unref?: () => unknown } = input;
      if (typeof releasable.unref === "function") releasable.unref();
      settled(value);
    };
    const onData = (chunk: Buffer | string): void => {
      answer += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
      const end = answer.search(/[\r\n]/);
      if (end >= 0) release(affirmative(answer.slice(0, end)));
      else if (answer.length > answerLimit) release(false);
    };
    const onEnd = (): void => release(answer.length > answerLimit ? false : affirmative(answer));
    input.on("data", onData);
    input.on("end", onEnd);
    input.on("error", onEnd);
    input.resume();
  });
}

function printIdentifiers(identifiers: Readonly<ContactIdentifiers>): void {
  process.stderr.write(`${JSON.stringify({
    identity_id: identifiers.identity_id,
    device_id: identifiers.device_id,
    device_pubkey: identifiers.device_pubkey,
    signal_identity_key: identifiers.signal_identity_key,
  })}\n`);
}

async function execute(command: string, values: CliValues): Promise<unknown> {
  const profileDir = required(values, "profile");
  switch (command) {
    case "init": {
      const config = parseClientConfig({
        profile_version: 1,
        profile_id: randomUUID(),
        relay_url: required(values, "relay-url"),
        database_path: "client.sqlite",
        store_key_env: required(values, "store-key-env"),
        request_timeout_ms: 5_000,
        poll_batch_size: 50,
      });
      let profile: Profile;
      try {
        profile = await openProfile({ profileDir, config, environment: process.env, initialize: true });
      } catch (error) {
        if (error instanceof ConfigurationError) throw error;
        throw persistenceFailure();
      }
      try { return await profile.summary(); } finally { await profile.close(); }
    }
    case "contact export": {
      const profile = await openExistingProfile(profileDir);
      try {
        const card = await profile.exportContact();
        try { await writeFile(required(values, "out"), `${JSON.stringify(card)}\n`, { flag: "wx", mode: 0o600 }); }
        catch { throw persistenceFailure(); }
        return { exported: true };
      } finally { await profile.close(); }
    }
    case "contact import": {
      const card = await readContactFile(required(values, "from"));
      const profile = await openExistingProfile(profileDir);
      try {
        let imported: boolean;
        try {
          imported = await profile.importContact(card, { confirm: async (identifiers) => {
            printIdentifiers(identifiers);
            return values.yes === true || readConfirmation();
          } });
        } catch (error) {
          // A local storage failure is not a trust decision about the contact card.
          if (error instanceof PersistenceError) throw persistenceFailure();
          throw trustFailure("INVALID_CONTACT_CARD");
        }
        if (!imported) throw trustFailure("CONTACT_NOT_CONFIRMED");
        // Importing a card is the exact event that changes the verdict for an envelope already
        // refused as CONTACT_NOT_TRUSTED. Since the recipient's read position is durable, such an
        // envelope is passed ONCE rather than re-offered on every poll (T5 design §4, R-5), so the
        // next walk has to start at the head of the mailbox again.
        //
        // The request is recorded LOCALLY and nothing is sent: `contact import` is an offline trust
        // operation and must stay one, or importing a card starts failing whenever the relay is
        // unreachable (finding T6-F-004). The next `poll` consumes it exactly once.
        await profile.requestMailboxRewalk();
        return { trusted: true };
      } finally { await profile.close(); }
    }
    case "relay publish": {
      const config = await loadConfig(profileDir);
      let messenger;
      try { messenger = await openOutboundMessenger({ profileDir, environment: process.env, relay: relayFor(config) }); }
      catch (error) { if (error instanceof ConfigurationError) throw error; throw persistenceFailure(); }
      try { return await messenger.publish(); } finally { await messenger.close(); }
    }
    case "send": {
      const messageId = values["message-id"] ?? randomUUID();
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(messageId)) throw inputFailure("INVALID_MESSAGE_ID");
      const config = await loadConfig(profileDir);
      let messenger;
      try { messenger = await openOutboundMessenger({ profileDir, environment: process.env, relay: relayFor(config) }); }
      catch (error) { if (error instanceof ConfigurationError) throw error; throw persistenceFailure(); }
      try {
        return await messenger.send({ recipientIdentityId: required(values, "to"), messageId, plaintext: required(values, "text") });
      } finally { await messenger.close(); }
    }
    case "poll": {
      const config = await loadConfig(profileDir);
      let messenger;
      try { messenger = await openInboundMessenger({ profileDir, environment: process.env, relay: relayFor(config) }); }
      catch (error) { if (error instanceof ConfigurationError) throw error; throw persistenceFailure(); }
      try { return await messenger.poll(); } finally { await messenger.close(); }
    }
    case "history": {
      const config = await loadConfig(profileDir);
      let messenger;
      try { messenger = await openInboundMessenger({ profileDir, environment: process.env, relay: relayFor(config) }); }
      catch (error) { if (error instanceof ConfigurationError) throw error; throw persistenceFailure(); }
      try { return { entries: await messenger.history({ contactIdentityId: required(values, "with") }) }; }
      finally { await messenger.close(); }
    }
    case "doctor": {
      const profile = await openExistingProfile(profileDir);
      try { return await profile.diagnostics(); } finally { await profile.close(); }
    }
    default:
      throw inputFailure();
  }
}

function classify(error: unknown): CliFailure {
  if (error instanceof CliFailure) return error;
  if (error instanceof PersistenceError) return persistenceFailure();
  if (error instanceof ConfigurationError) return inputFailure(error.code);
  if (error instanceof RelayError) {
    if (error.retryable) return new CliFailure("RELAY_UNAVAILABLE", 4);
    const remote = error.remoteCode;
    return trustFailure(remote !== undefined && reportedRelayCodes.has(remote) ? remote : "PROTOCOL_REJECTED");
  }
  if (error instanceof OutboundError) return error.code === "INVALID_MESSAGE" ? inputFailure(error.code) : trustFailure(error.code);
  if (error instanceof InboundError || error instanceof ProfileError) return trustFailure(error.code);
  return persistenceFailure();
}

function writeResult(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

async function main(): Promise<number> {
  const rawArgs = process.argv.slice(2);

  // --- LAYERED DISPATCHER (High-level operator commands) ---
  const first = rawArgs[0];
  if (!first || first === "--help" || first === "-h" || first === "help") {
    const { printHelp } = await import("../operator/banner.js");
    printHelp();
    return 0;
  }

  if (first === "station") {
    const { handleStationCommand } = await import("../operator/station.js");
    await handleStationCommand(rawArgs.slice(1));
    return 0;
  }

  if (first === "repeater") {
    const { handleRepeaterCommand } = await import("../operator/repeater.js");
    await handleRepeaterCommand(rawArgs.slice(1));
    return 0;
  }

  if (first === "profile") {
    const { handleProfileCommand } = await import("../operator/profile.js");
    await handleProfileCommand(rawArgs.slice(1));
    return 0;
  }

  if (first === "contact" && rawArgs[1] !== "export" && rawArgs[1] !== "import") {
    const { handleContactCommand } = await import("../operator/contact.js");
    await handleContactCommand(rawArgs.slice(1));
    return 0;
  }

  if (first === "radio" || first === "tui") {
    const { dirname, resolve } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const { spawn } = await import("node:child_process");
    const here = dirname(fileURLToPath(import.meta.url));
    const tuiScript = resolve(here, "tui.js");
    const child = spawn(process.execPath, [tuiScript, ...rawArgs.slice(1)], { stdio: "inherit" });
    await new Promise((res) => child.on("exit", res));
    return 0;
  }
  // --- END LAYERED DISPATCHER (Falls through to strict protocol parser) ---

  try {
    const parsed = parseCommand(rawArgs);
    rejectUnexpectedMissing(parsed.command, parsed.values);
    // Resolved HERE rather than inside `execute` so that a missing or oversized body is still an
    // argument failure reported before the profile is opened — the ordering
    // `rejectUnexpectedMissing` used to give `--text` when it was the only source.
    if (parsed.command === "send") parsed.values.text = await resolveSendBody(parsed.values);
    writeResult({ ok: true, data: await execute(parsed.command, parsed.values) });
    return 0;
  } catch (error) {
    const failure = classify(error);
    writeResult({ ok: false, error: { code: failure.code } });
    return failure.exitCode;
  }
}

void main().then((code) => { process.exitCode = code; }, () => {
  writeResult({ ok: false, error: { code: "PERSISTENCE_FAILURE" } });
  process.exitCode = 5;
});
