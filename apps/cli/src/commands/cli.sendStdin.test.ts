import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ContactCard } from "../runtime/profile";
import { CLI_CHILD_TIMEOUT_MS, CLI_TEST_TIMEOUT_MS } from "../../test/childProcessTimeouts";

// Flow 004, T5 — RED spec 1 of 2: `send` must read the message body from stdin, so that the
// plaintext of a message in an end-to-end encrypted messenger stops appearing in a child process's
// argv, where `ps` shows it to every process on the host. `apps/cli/src/commands/cli.ts` today
// requires `--text` (`rejectUnexpectedMissing`, :175-187 listing "text" for send; `required`,
// :169-173) and never reads stdin for the body at all.
//
// `--text` is ADDED TO, not replaced. The dispatch that commissioned this file asked for its
// removal and flow 004's AC3 said so; the test author flagged that the design
// (.metaproject/flows/003-2026-09-07-echolet-residuals-and-tui/t35-console-client-design.md §6, P-1)
// said the opposite, and the design was right. The operator's live prototype scripts outside this
// repository — `~/echolet-try.sh` and the `~/.echolet/peer` wrapper for the second user on `depr` —
// call `send --text` in nine places. AC3 was amended through `keryx flow ac update` rather than
// implemented as frozen. One test below is therefore green by design; it is labelled where it sits.
//
// Every timeout below comes from apps/cli/test/childProcessTimeouts.ts, never a new literal (T16 /
// T40 — a fresh millisecond guess sized on an idle machine is exactly the defect that cost this
// project a day of false-red CI runs under contention).

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const manifest = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8")) as { bin?: string | { echolet?: string } };
const bin = typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.echolet;
const entry = resolve(packageDir, bin ?? "dist/cli.js");
const paths: string[] = [], servers: Server[] = [];
type ProcessResult = { code: number | null; stdout: string; stderr: string };

function child(executable: string, args: string[], environment: Record<string, string | undefined> = {}, stdin = "", cwd = packageDir): Promise<ProcessResult> {
  return new Promise((resolveResult, reject) => {
    const processChild = spawn(executable, args, { cwd, env: { ...process.env, ...environment }, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    const timeout = setTimeout(() => { processChild.kill("SIGKILL"); reject(new Error("CLI child timed out")); }, CLI_CHILD_TIMEOUT_MS);
    processChild.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    processChild.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    processChild.on("error", (error) => { clearTimeout(timeout); reject(error); });
    processChild.on("close", (code) => { clearTimeout(timeout); resolveResult({ code, stdout, stderr }); });
    processChild.stdin.on("error", () => { /* Entrypoint may reject before reading stdin. */ });
    processChild.stdin.end(stdin);
  });
}

beforeAll(() => { expect(existsSync(entry)).toBe(true); });
afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise<void>((done, reject) => { server.closeAllConnections(); server.close((error) => error ? reject(error) : done()); });
  for (const path of paths.splice(0)) rmSync(path, { recursive: true, force: true });
});

function fixture() {
  const profileDir = mkdtempSync(join(tmpdir(), "echolet-cli-sendstdin-")); paths.push(profileDir);
  return { profileDir, environment: { ECHOLET_TEST_KEY: randomBytes(32).toString("base64url") } };
}
type Fixture = ReturnType<typeof fixture>;
const run = (owner: Fixture, args: string[], stdin = "", environment = owner.environment) =>
  child(process.execPath, [entry, ...args, "--profile", owner.profileDir, "--json"], environment, stdin);

function json(result: ProcessResult, code = 0): Record<string, unknown> {
  expect(result.code, `stdout=${result.stdout} stderr=${result.stderr}`).toBe(code);
  const value: unknown = JSON.parse(result.stdout);
  expect(value).not.toBeNull(); expect(Array.isArray(value)).toBe(false); expect(typeof value).toBe("object");
  const object = value as Record<string, unknown>;
  expect(object.ok).toBe(code === 0);
  if (code !== 0) expect(object.error).toMatchObject({ code: expect.any(String) });
  return object;
}

async function init(owner: Fixture, relayUrl = "http://127.0.0.1:1") {
  return json(await run(owner, ["init", "--relay-url", relayUrl, "--store-key-env", "ECHOLET_TEST_KEY"]));
}
async function exportCard(owner: Fixture) {
  const path = join(owner.profileDir, "contact.json");
  json(await run(owner, ["contact", "export", "--out", path]));
  return { path, card: JSON.parse(readFileSync(path, "utf8")) as ContactCard };
}
function redacted(result: ProcessResult, owner: Fixture, plaintext = "") {
  const output = result.stdout + result.stderr;
  expect(output.includes(owner.environment.ECHOLET_TEST_KEY)).toBe(false);
  if (plaintext) expect(output.includes(plaintext)).toBe(false);
  expect(/identitySecretKey|deviceSecretKey|sessionSecretKey|"seed"|ciphertext/.test(output)).toBe(false);
}

// A recipient that is never imported anywhere in this file. Any send to it must fail locally with
// CONTACT_NOT_TRUSTED, which is exactly what makes it useful here: reaching that specific,
// LATER-than-parsing failure is the observable proof that the body was actually read (stdin path
// exists), independent of whatever the body's bytes were.
const UNTRUSTED_IDENTITY = "SYNTHETIC_UNTRUSTED_IDENTITY_0000000000000000000000";

describe("send reads its message body from stdin, and --text is rejected outright", () => {
  it(
    "a non-empty body given only on stdin reaches the (local, offline) trust check, instead of being " +
      "rejected as a missing argument; an empty body — whether never written or explicitly written as " +
      "zero bytes before stdin closes, which Node's stream contract makes indistinguishable to the " +
      "reader — is rejected as INVALID_ARGUMENTS",
    async () => {
      const owner = fixture();
      await init(owner);

      // CASE: stdin closes having carried zero bytes. Today `send` without `--text` fails with this
      // exact code (INVALID_ARGUMENTS) for an unrelated reason — `--text` is simply absent from the
      // parsed flags, and `rejectUnexpectedMissing` never looks at stdin at all — so passing this
      // half of the assertion is NOT by itself evidence that stdin was ever read. What proves the
      // read happened is the second half, below.
      const emptyResult = await run(owner, ["send", "--to", UNTRUSTED_IDENTITY, "--message-id", randomUUID()], "");
      const empty = json(emptyResult, 2);
      expect(empty.error).toMatchObject({ code: "INVALID_ARGUMENTS" });

      // CASE: an otherwise identical invocation whose only difference is a non-empty stdin body.
      // Once the body is actually read, this must reach `CONTACT_NOT_TRUSTED` (exit 3) rather than
      // fail the same way as the empty case above — proving the CLI consumed stdin as the body
      // rather than uniformly refusing every `--text`-less invocation.
      const marker = "SYNTHETIC_NONEMPTY_STDIN_BODY";
      const nonEmptyResult = await run(owner, ["send", "--to", UNTRUSTED_IDENTITY, "--message-id", randomUUID()], marker);
      const nonEmpty = json(nonEmptyResult, 3);
      expect(nonEmpty.error).toMatchObject({ code: "CONTACT_NOT_TRUSTED" });
      redacted(nonEmptyResult, owner, marker);
    },
    CLI_TEST_TIMEOUT_MS,
  );

  it(
    "bounds the stdin body at the same plaintext limit outbound.ts already enforces (65536 bytes): " +
      "one byte over is INVALID_MESSAGE, exactly at the bound reaches the trust check instead",
    async () => {
      const owner = fixture();
      await init(owner);
      const overBound = "A".repeat(65537); // one byte past outbound.ts's `plaintext: z.string().max(65536)`
      const atBound = "A".repeat(65536); // exactly at the bound: must NOT be rejected for size

      const overResult = await run(owner, ["send", "--to", UNTRUSTED_IDENTITY, "--message-id", randomUUID()], overBound);
      const over = json(overResult, 2);
      expect(over.error).toMatchObject({ code: "INVALID_MESSAGE" });

      const atResult = await run(owner, ["send", "--to", UNTRUSTED_IDENTITY, "--message-id", randomUUID()], atBound);
      const at = json(atResult, 3);
      expect(at.error).toMatchObject({ code: "CONTACT_NOT_TRUSTED" });
    },
    CLI_TEST_TIMEOUT_MS,
  );

  // GREEN TODAY, AND DELIBERATELY SO. This one test in a file of red specifications is a regression
  // guard, not a specification: it must pass before the change and after it.
  //
  // It was originally written the other way round — asserting `--text` had become invalid — because
  // the dispatch that commissioned this file asked for that. The orchestrator reversed the decision
  // and rewrote this case, which is recorded rather than tidied away. The evidence that reversed it
  // is outside this repository: the operator's own live prototype scripts, `~/echolet-try.sh` and
  // the `~/.echolet/peer` wrapper driving the second user on `depr`, call `send --text` in nine
  // places. Deleting the flag would break the running prototype this whole wave exists to make
  // usable, to close an exposure that reaches only callers who choose it.
  //
  // So both things are true at once, and neither is redundant: the CLI still accepts `--text`, and
  // the console must never use it (pinned in cli-bridge.sendStdin.test.ts, which stays red). Whether
  // `--text` is eventually retired is an open decision for the operator; what would settle it is
  // whether those nine call sites can move to stdin.
  it("still accepts --text, because the operator's live scripts depend on it (regression guard)", async () => {
    const owner = fixture();
    await init(owner);
    const marker = "SYNTHETIC_LEGACY_TEXT_FLAG_BODY";
    // No stdin body: the flag alone must still carry the message all the way to the trust check,
    // which is as far as an unpinned recipient can take it.
    const result = await run(owner, ["send", "--to", UNTRUSTED_IDENTITY, "--text", marker, "--message-id", randomUUID()]);
    const parsed = json(result, 3);
    expect(parsed.error).toMatchObject({ code: "CONTACT_NOT_TRUSTED" });
    redacted(result, owner, marker);
  }, CLI_TEST_TIMEOUT_MS);

  it(
    "delivers the exact stdin bytes as the stored plaintext, untrimmed — including an embedded and a " +
      "trailing newline — through a real publish -> import -> send -> history round trip",
    async () => {
      let peer: ContactCard | undefined;
      const server = createServer((request, reply) => {
        void (async () => {
          const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
          const body = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>, path = request.url!;
          reply.setHeader("content-type", "application/json");
          let data: unknown;
          if (path === "/v2/prekeys/publish") data = { stored: true, bundle_id: (body.bundle as { bundle_id: string }).bundle_id, claimable: true };
          else if (path === "/v2/prekeys/claim") data = { bundle: peer!.signal_bundle };
          else if (path === "/v1/messages/send") data = { accepted: true, envelope_id: (body.envelope as { envelope_id: string }).envelope_id, status: "relayed" };
          else { reply.statusCode = 404; reply.end("{}"); return; }
          reply.end(JSON.stringify({ ok: true, data }));
        })().catch(() => { reply.statusCode = 500; reply.end("{}"); });
      });
      servers.push(server); await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
      const address = server.address(); if (!address || typeof address === "string") throw new Error("Missing test server address");

      const alice = fixture(), bob = fixture();
      await init(alice, `http://127.0.0.1:${address.port}`); await init(bob);
      const exported = await exportCard(bob); peer = exported.card;
      json(await run(alice, ["contact", "import", "--from", exported.path, "--yes"]));
      json(await run(alice, ["relay", "publish"]));

      const messageId = randomUUID();
      // Both an embedded AND a trailing newline: P-1's "untrimmed" rule means neither is stripped.
      const body = "SYNTHETIC_STDIN_LINE_ONE\nSYNTHETIC_STDIN_LINE_TWO\n";
      const sentResult = await run(alice, ["send", "--to", peer.signal_bundle.device_record.identity_id, "--message-id", messageId], body);
      json(sentResult);
      redacted(sentResult, alice, body);

      const historyResult = await run(alice, ["history", "--with", peer.signal_bundle.device_record.identity_id]);
      const history = json(historyResult);
      const entries = (history.data as { entries: Array<{ messageId: string; plaintext: string }> }).entries;
      const entry = entries.find((candidate) => candidate.messageId === messageId);
      expect(entry, `entries were ${JSON.stringify(entries)}`).toBeDefined();
      // Asserted against BOTH the byte-exact body and its trimmed variant, so an implementation that
      // silently strips a trailing newline fails this test rather than passing a looser check.
      expect(entry!.plaintext).toBe(body);
      expect(entry!.plaintext).not.toBe(body.trimEnd());
    },
    CLI_TEST_TIMEOUT_MS,
  );

  // NOT WRITTEN, and why: the design (§6 P-1) also requires "`--text` absent AND stdin is a TTY ->
  // INVALID_ARGUMENTS exit 2 rather than a process that hangs waiting for a human." This harness
  // spawns the child with `stdio: ["pipe", "pipe", "pipe"]`, which can never present a TTY to the
  // child's stdin; reproducing a real TTY would need a pseudo-terminal allocator (e.g. `node-pty` or
  // `script`) that is not a dependency of this package and that this dispatch's scope (test files
  // only, no new dependency) does not license adding. Flagged here as an explicit gap rather than
  // silently skipped.
});
