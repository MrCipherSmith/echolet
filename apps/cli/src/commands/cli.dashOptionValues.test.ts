import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ContactCard } from "../runtime/profile";
import { CLI_CHILD_TIMEOUT_MS, CLI_TEST_TIMEOUT_MS } from "../../test/childProcessTimeouts";

// Review finding F-013 (blocker).
//
// `parseCommand` calls Node's `parseArgs` with `strict: true`, which raises
// ERR_PARSE_ARGS_INVALID_OPTION_VALUE for ANY option value whose first character is `-`;
// cli.ts maps that to INVALID_ARGUMENTS / exit 2. `identity_id` is the base64url encoding of a
// public key and `-` belongs to the base64url alphabet, so roughly one identity in 64 begins
// with `-` and cannot be messaged, exported against, or looked up in history at all.
//
// This suite pins the intended behaviour for the WHOLE class rather than a sample: every
// string-valued option on the documented command surface is enumerated with a FIXED literal
// value that begins with `-`. Nothing here depends on a randomly generated identity happening
// to start with `-`, which is what made the defect look like an intermittent test flake.
//
// The complete set of string-valued options declared by `cliOptions` in cli.ts is:
//   --profile, --relay-url, --store-key-env, --out, --from, --to, --text, --message-id, --with
// (`--json` and `--yes` are boolean and take no value.)
//
// The suite also guards against over-correction: the fix must not be obtained by disabling
// strict parsing. Unknown flags, missing option values and repeated options must keep failing
// closed with INVALID_ARGUMENTS / exit 2, and the one-JSON-object-on-stdout contract plus
// redacted stderr must survive everywhere.

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const manifest = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8")) as { bin?: string | { echolet?: string } };
const bin = typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.echolet;
const entry = resolve(packageDir, bin ?? "dist/cli.js");

const paths: string[] = [];
const servers: Server[] = [];

// The binary is built once by the vitest globalSetup (test/globalSetup.ts). This suite must not
// rebuild it: the other process-level suites spawn the same dist/cli.js concurrently.
beforeAll(() => { expect(existsSync(entry)).toBe(true); });

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise<void>((done, reject) => { server.closeAllConnections(); server.close((error) => error ? reject(error) : done()); });
  }
  for (const path of paths.splice(0)) rmSync(path, { recursive: true, force: true });
});

interface ProcessResult { code: number | null; stdout: string; stderr: string; timedOut: boolean }

function child(args: string[], options: { environment?: Record<string, string | undefined>; cwd?: string } = {}): Promise<ProcessResult> {
  return new Promise((done, reject) => {
    const processChild = spawn(process.execPath, [entry, ...args], {
      cwd: options.cwd ?? packageDir,
      env: { ...process.env, ...options.environment },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "", stderr = "", timedOut = false;
    const timer = setTimeout(() => { timedOut = true; processChild.kill("SIGKILL"); }, CLI_CHILD_TIMEOUT_MS);
    processChild.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    processChild.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    processChild.stdin.on("error", () => { /* the entrypoint may reject before reading stdin */ });
    processChild.once("error", (error) => { clearTimeout(timer); reject(error); });
    processChild.once("close", (code) => { clearTimeout(timer); done({ code, stdout, stderr, timedOut }); });
    processChild.stdin.end();
  });
}

function fixture() {
  const profileDir = mkdtempSync(join(tmpdir(), "echolet-cli-dash-"));
  paths.push(profileDir);
  return { profileDir, environment: { ECHOLET_TEST_KEY: randomBytes(32).toString("base64url") } };
}
type Fixture = ReturnType<typeof fixture>;

const run = (owner: Fixture, args: string[], options: { environment?: Record<string, string | undefined>; cwd?: string } = {}) =>
  child([...args, "--profile", owner.profileDir, "--json"], { environment: { ...owner.environment, ...options.environment }, cwd: options.cwd });

/**
 * Reads the single JSON result line without ever echoing stdout into a failure message, and
 * enforces the process contract that exactly one JSON object is written to stdout.
 */
function outcome(result: ProcessResult): { code: number | null; errorCode: string; timedOut: boolean } {
  expect(result.timedOut).toBe(false);
  expect(result.stdout.trimEnd().split("\n").length).toBe(1);
  let errorCode = "none";
  try {
    const value = JSON.parse(result.stdout) as { ok?: boolean; error?: { code?: unknown } };
    expect(value).not.toBeNull();
    expect(Array.isArray(value)).toBe(false);
    if (typeof value.error?.code === "string" && /^[A-Z_]+$/.test(value.error.code)) errorCode = value.error.code;
    else if (value.ok === true) errorCode = "ok";
  } catch { errorCode = result.stdout.length === 0 ? "no-output" : "unparsable"; }
  return { code: result.code, errorCode, timedOut: result.timedOut };
}

/** Boolean assertions deliberately avoid rendering secret values on failure. */
function redacted(result: ProcessResult, owner: Fixture, plaintext = "") {
  const output = result.stdout + result.stderr;
  expect(output.includes(owner.environment.ECHOLET_TEST_KEY)).toBe(false);
  if (plaintext) expect(output.includes(plaintext)).toBe(false);
  expect(/identitySecretKey|deviceSecretKey|sessionSecretKey|"seed"|ciphertext/.test(output)).toBe(false);
}

async function init(owner: Fixture, relayUrl = "http://127.0.0.1:1") {
  expect(outcome(await run(owner, ["init", "--relay-url", relayUrl, "--store-key-env", "ECHOLET_TEST_KEY"])))
    .toMatchObject({ code: 0, errorCode: "ok" });
}

async function exportCard(owner: Fixture) {
  const path = join(owner.profileDir, "contact.json");
  expect(outcome(await run(owner, ["contact", "export", "--out", path]))).toMatchObject({ code: 0, errorCode: "ok" });
  const card = JSON.parse(readFileSync(path, "utf8")) as ContactCard;
  return { path, card, record: card.signal_bundle.device_record };
}

type Routes = Record<string, (body: Record<string, unknown>) => unknown>;
async function startRelay(routes: Routes) {
  const server = createServer((request, reply) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const raw = Buffer.concat(chunks).toString();
      const body = (raw.length ? JSON.parse(raw) : {}) as Record<string, unknown>;
      reply.setHeader("content-type", "application/json");
      const route = routes[request.url!];
      if (!route) { reply.statusCode = 404; reply.end("{}"); return; }
      reply.end(JSON.stringify({ ok: true, data: route(body) }));
    })().catch(() => { reply.statusCode = 500; reply.end("{}"); });
  });
  servers.push(server);
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing relay test address");
  return `http://127.0.0.1:${address.port}`;
}

/**
 * Fixed literals. Each begins with `-`, exactly like a base64url identity whose first encoded
 * character happens to be `-`. None of them is randomly generated.
 */
const dash = {
  profile: "-dash-profile",
  relayUrl: "-http://127.0.0.1:1",
  storeKeyEnv: "-DASH_STORE_KEY",
  out: "-dash-contact-card.json",
  from: "-dash-contact-card.json",
  to: "-DashRecipientIdentity000000000000000000000A",
  text: "-SYNTHETIC_DASH_TEXT",
  textLookingLikeFlag: "--profile",
  messageId: "-not-a-uuid",
  with: "-DashContactIdentity0000000000000000000000A",
} as const;

describe("string-valued CLI options accept a value beginning with '-' (F-013)", () => {
  it("accepts a --profile value that begins with '-'", async () => {
    const owner = fixture();
    const parent = mkdtempSync(join(tmpdir(), "echolet-cli-dash-parent-"));
    paths.push(parent);
    mkdirSync(join(parent, dash.profile));

    const result = await child(
      ["init", "--relay-url", "http://127.0.0.1:1", "--store-key-env", "ECHOLET_TEST_KEY", "--profile", dash.profile, "--json"],
      { environment: owner.environment, cwd: parent },
    );

    expect(outcome(result)).toMatchObject({ code: 0, errorCode: "ok" });
    redacted(result, owner);
  }, CLI_TEST_TIMEOUT_MS);

  it("accepts a --relay-url value that begins with '-' and rejects it as configuration, not as arguments", async () => {
    const owner = fixture();

    // No syntactically valid URL can begin with '-', so the intended contract is that the
    // argument parser hands the value through and the configuration validator is what refuses it.
    const result = await run(owner, ["init", "--relay-url", dash.relayUrl, "--store-key-env", "ECHOLET_TEST_KEY"]);

    expect(outcome(result)).toMatchObject({ code: 2, errorCode: "INVALID_CONFIGURATION" });
  }, CLI_TEST_TIMEOUT_MS);

  it("accepts a --store-key-env value that begins with '-' and rejects it as configuration, not as arguments", async () => {
    const owner = fixture();

    // `store_key_env` must match /^[A-Z][A-Z0-9_]*$/, so the value is legitimately invalid
    // configuration. The point is that the refusal comes from the config schema, not from
    // argument parsing: the environment variable is present and holds a valid key.
    const result = await run(owner, ["init", "--relay-url", "http://127.0.0.1:1", "--store-key-env", dash.storeKeyEnv], {
      environment: { [dash.storeKeyEnv]: randomBytes(32).toString("base64url") },
    });

    expect(outcome(result)).toMatchObject({ code: 2, errorCode: "INVALID_CONFIGURATION" });
  }, CLI_TEST_TIMEOUT_MS);

  it("accepts an --out value that begins with '-'", async () => {
    const owner = fixture();
    await init(owner);

    const result = await run(owner, ["contact", "export", "--out", dash.out], { cwd: owner.profileDir });

    expect(outcome(result)).toMatchObject({ code: 0, errorCode: "ok" });
    expect(existsSync(join(owner.profileDir, dash.out))).toBe(true);
    redacted(result, owner);
  }, CLI_TEST_TIMEOUT_MS);

  it("accepts a --from value that begins with '-'", async () => {
    const alice = fixture(), bob = fixture();
    await init(alice); await init(bob);
    const peer = await exportCard(bob);
    copyFileSync(peer.path, join(alice.profileDir, dash.from));

    const result = await run(alice, ["contact", "import", "--from", dash.from, "--yes"], { cwd: alice.profileDir });

    expect(outcome(result)).toMatchObject({ code: 0, errorCode: "ok" });
    redacted(result, alice);
  }, CLI_TEST_TIMEOUT_MS);

  it("accepts a --to value that begins with '-' and carries it verbatim into the trust layer", async () => {
    const owner = fixture();
    await init(owner);

    const dashed = await run(owner, ["send", "--to", dash.to, "--text", "SYNTHETIC_DASH_PROBE"]);
    // The identical run with the leading '-' removed is the control: a dash-leading recipient
    // must be treated exactly like any other untrusted recipient, never as a parse error.
    const control = await run(owner, ["send", "--to", dash.to.slice(1), "--text", "SYNTHETIC_DASH_PROBE"]);

    expect(outcome(dashed)).toMatchObject({ code: 3, errorCode: "CONTACT_NOT_TRUSTED" });
    expect(outcome(dashed)).toEqual(outcome(control));
    redacted(dashed, owner, "SYNTHETIC_DASH_PROBE");
  }, CLI_TEST_TIMEOUT_MS);

  it("accepts a --text value that begins with '-'", async () => {
    const owner = fixture(), peer = fixture();
    await init(owner); await init(peer);
    const contact = await exportCard(peer);

    // Trust, not argument parsing, is what stops this send: the dash-leading body reached the
    // messenger intact.
    const result = await run(owner, ["send", "--to", contact.record.identity_id, "--text", dash.text]);

    expect(outcome(result)).toMatchObject({ code: 3, errorCode: "CONTACT_NOT_TRUSTED" });
    redacted(result, owner, dash.text);
  }, CLI_TEST_TIMEOUT_MS);

  it("accepts a --message-id value that begins with '-' and rejects it as an invalid message id", async () => {
    const owner = fixture();
    await init(owner);

    // A dash-leading message id is legitimately invalid, but it must be the message-id validator
    // that says so — INVALID_MESSAGE_ID, not the parser's INVALID_ARGUMENTS.
    const result = await run(owner, ["send", "--to", dash.to, "--text", "SYNTHETIC_DASH_PROBE", "--message-id", dash.messageId]);

    expect(outcome(result)).toMatchObject({ code: 2, errorCode: "INVALID_MESSAGE_ID" });
  }, CLI_TEST_TIMEOUT_MS);

  it("accepts a --with value that begins with '-'", async () => {
    const owner = fixture();
    await init(owner);

    const result = await run(owner, ["history", "--with", dash.with]);

    expect(outcome(result)).toMatchObject({ code: 0, errorCode: "ok" });
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, data: { entries: [] } });
    redacted(result, owner);
  }, CLI_TEST_TIMEOUT_MS);
});

describe("a --text value beginning with '-' is message content, never an option (F-013)", () => {
  it("delivers dash-leading bodies, including one spelled exactly like a known flag", async () => {
    let peerCard: ContactCard | undefined;
    const relayUrl = await startRelay({
      // Alice's own first publication; her bundle is never claimed here, so it stays claimable.
      "/v2/prekeys/publish": (body) => ({ stored: true, bundle_id: (body.bundle as { bundle_id: string }).bundle_id, claimable: true }),
      "/v2/prekeys/claim": () => ({ bundle: peerCard!.signal_bundle }),
      "/v1/messages/send": (body) => ({ accepted: true, envelope_id: (body.envelope as { envelope_id: string }).envelope_id, status: "relayed" }),
    });
    const alice = fixture(), bob = fixture();
    await init(alice, relayUrl); await init(bob);
    const peer = await exportCard(bob);
    peerCard = peer.card;
    expect(outcome(await run(alice, ["contact", "import", "--from", peer.path, "--yes"]))).toMatchObject({ code: 0, errorCode: "ok" });
    expect(outcome(await run(alice, ["relay", "publish"]))).toMatchObject({ code: 0, errorCode: "ok" });

    const dashLeading = await run(alice, ["send", "--to", peer.record.identity_id, "--text", dash.text]);
    const flagShaped = await run(alice, ["send", "--to", peer.record.identity_id, "--text", dash.textLookingLikeFlag]);

    expect(outcome(dashLeading)).toMatchObject({ code: 0, errorCode: "ok" });
    expect(outcome(flagShaped)).toMatchObject({ code: 0, errorCode: "ok" });
    redacted(dashLeading, alice, dash.text);
    redacted(flagShaped, alice, dash.textLookingLikeFlag);

    // Only history is allowed to reveal plaintext, and it must show both bodies unchanged —
    // proof that neither value was reinterpreted as an option or silently rewritten.
    const history = await run(alice, ["history", "--with", peer.record.identity_id]);
    expect(outcome(history)).toMatchObject({ code: 0, errorCode: "ok" });
    expect(history.stdout.includes(dash.text)).toBe(true);
    expect(history.stdout.includes(dash.textLookingLikeFlag)).toBe(true);
    expect(history.stderr.includes(dash.text)).toBe(false);
  }, CLI_TEST_TIMEOUT_MS);
});

describe("genuinely invalid input still fails closed with exit 2 (F-013 over-correction guard)", () => {
  it("still rejects an unknown flag, with or without a dash-leading value", async () => {
    const owner = fixture();
    await init(owner);

    for (const args of [["doctor", "--unknown-flag"], ["doctor", "--unknown-flag", "-value"], ["send", "--to", dash.to, "--unknown-flag", "-value"]]) {
      const result = await run(owner, args);
      expect(outcome(result)).toMatchObject({ code: 2, errorCode: "INVALID_ARGUMENTS" });
    }
  }, CLI_TEST_TIMEOUT_MS);

  it("still rejects an option whose value is missing at the end of the argument list", async () => {
    const owner = fixture();
    await init(owner);

    for (const args of [
      ["send", "--to", dash.to, "--profile", owner.profileDir, "--json", "--text"],
      ["history", "--profile", owner.profileDir, "--json", "--with"],
      ["doctor", "--json", "--profile"],
    ]) {
      const result = await child(args, { environment: owner.environment });
      expect(outcome(result)).toMatchObject({ code: 2, errorCode: "INVALID_ARGUMENTS" });
    }
  }, CLI_TEST_TIMEOUT_MS);

  it("still rejects a repeated option, including when the repeat carries a dash-leading value", async () => {
    const owner = fixture();
    await init(owner);

    for (const args of [
      ["send", "--to", "AbCdEf", "--to", "GhIjKl", "--text", "SYNTHETIC_DASH_PROBE"],
      ["send", "--to", "AbCdEf", "--to", dash.to, "--text", "SYNTHETIC_DASH_PROBE"],
      ["history", "--with", dash.with, "--with", dash.with],
    ]) {
      const result = await run(owner, args);
      expect(outcome(result)).toMatchObject({ code: 2, errorCode: "INVALID_ARGUMENTS" });
    }
  }, CLI_TEST_TIMEOUT_MS);

  it("still rejects an option that the command does not accept and an unknown command", async () => {
    const owner = fixture();
    await init(owner);

    for (const args of [["poll", "--to", dash.to], ["doctor", "--text", dash.text], ["bogus"], ["send", "extra", "--to", dash.to, "--text", "x"]]) {
      const result = await run(owner, args);
      expect(outcome(result)).toMatchObject({ code: 2, errorCode: "INVALID_ARGUMENTS" });
    }
  }, CLI_TEST_TIMEOUT_MS);
});

/**
 * Repair for the T38 MC10 gap.
 *
 * Mutating `cli.ts:107` `strict: true` -> `strict: false` left all sixteen tests above green, and
 * the whole apps/cli suite green: every guard they assert is independently enforced by
 * `parseCommand` itself - unknown flags and command/option mismatches by the token loop at
 * cli.ts:114-118, repeats by the same loop's `seen` set, missing values by `required()`, operands
 * after `--` by the `commandOptions[command]` lookup. Adding more tests of the same shape would
 * not have helped.
 *
 * The one rejection `parseCommand` does NOT re-implement is an inline value on a BOOLEAN option:
 * strict `parseArgs` raises ERR_PARSE_ARGS_INVALID_OPTION_VALUE for `--json=value`, while the
 * non-strict parser stores the string and every downstream check accepts it. That is the seam
 * these tests use, so removing `strict: true` now fails.
 */
describe("strict parsing is load-bearing, not incidental (F-013 over-correction guard, MC10)", () => {
  it("rejects an inline value on --json instead of running the command", async () => {
    const owner = fixture();
    await init(owner);
    const exported = join(owner.profileDir, "mc10-contact.json");

    const doctor = await child(["doctor", "--profile", owner.profileDir, "--json=please"], { environment: owner.environment });
    expect(outcome(doctor)).toMatchObject({ code: 2, errorCode: "INVALID_ARGUMENTS" });

    const exportRun = await child(["contact", "export", "--profile", owner.profileDir, "--out", exported, "--json=1"], { environment: owner.environment });
    expect(outcome(exportRun)).toMatchObject({ code: 2, errorCode: "INVALID_ARGUMENTS" });
    // The refusal happened before anything ran: a non-strict parser would have written the card.
    expect(existsSync(exported)).toBe(false);

    // Control: the same commands with `--json` spelled correctly still succeed, so this guard
    // cannot be satisfied by refusing valid input.
    expect(outcome(await child(["doctor", "--profile", owner.profileDir, "--json"], { environment: owner.environment })))
      .toMatchObject({ code: 0, errorCode: "ok" });
    expect(outcome(await child(["contact", "export", "--profile", owner.profileDir, "--out", exported, "--json"], { environment: owner.environment })))
      .toMatchObject({ code: 0, errorCode: "ok" });
    expect(existsSync(exported)).toBe(true);
    redacted(exportRun, owner);
  }, CLI_TEST_TIMEOUT_MS);

  it("rejects an inline value on --yes instead of falling through to the interactive prompt", async () => {
    const alice = fixture(), bob = fixture();
    await init(alice); await init(bob);
    const peer = await exportCard(bob);

    const result = await child(["contact", "import", "--profile", alice.profileDir, "--from", peer.path, "--json", "--yes=maybe"], { environment: alice.environment });

    // Without strict parsing `--yes` becomes the string "maybe", which is not `true`, so the
    // import falls through to the confirmation prompt and exits 3 CONTACT_NOT_CONFIRMED - a
    // different contract, silently reached from input the CLI is supposed to refuse.
    expect(outcome(result)).toMatchObject({ code: 2, errorCode: "INVALID_ARGUMENTS" });
    redacted(result, alice);
  }, CLI_TEST_TIMEOUT_MS);
});

describe("end-of-options separator (F-013)", () => {
  it("treats a bare trailing '--' as a no-op", async () => {
    const owner = fixture();
    await init(owner);

    const result = await child(["doctor", "--profile", owner.profileDir, "--json", "--"], { environment: owner.environment });

    expect(outcome(result)).toMatchObject({ code: 0, errorCode: "ok" });
    redacted(result, owner);
  }, CLI_TEST_TIMEOUT_MS);

  it("fails closed on any operand after '--', because no command takes positional operands", async () => {
    const owner = fixture();
    await init(owner);

    for (const args of [
      ["doctor", "--profile", owner.profileDir, "--json", "--", "extra"],
      ["doctor", "--profile", owner.profileDir, "--json", "--", "--json"],
      ["send", "--to", dash.to, "--text", "x", "--profile", owner.profileDir, "--json", "--", "--to", "other"],
    ]) {
      const result = await child(args, { environment: owner.environment });
      expect(outcome(result)).toMatchObject({ code: 2, errorCode: "INVALID_ARGUMENTS" });
    }
  }, CLI_TEST_TIMEOUT_MS);
});
