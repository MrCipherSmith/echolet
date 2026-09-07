import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import type { ContactCard } from "../runtime/profile";

// RED test for T53 / finding T52-F-001, at the operator's own boundary: the exit code and the one
// machine-readable error code the CLI prints.
//
// T54 gives /v1/messages/send a per-sender unacked-envelope quota. A sender at quota is declined
// with a bounded 4xx and the relay's own code, SENDER_QUOTA_EXCEEDED. That condition is temporary,
// clears when the recipient acknowledges or the envelopes expire, and is nothing like a trust or
// protocol violation - but today the CLI would report it as a bare PROTOCOL_REJECTED, because
// `remoteCodes` (relayClient.ts) and `reportedRelayCodes` (cli.ts) are both allowlists and neither
// carries the code. That is the identical flattening R2-L-002 fixed for PREKEY_BUNDLE_UNAVAILABLE
// and T50-F-002 fixed for UNAUTHORIZED_MAILBOX_ACCESS, and it must be fixed the same way, not by
// renaming the generic code.
//
// The documented 0/2/3/4/5 exit-code contract is unchanged: this stays a non-retryable relay
// rejection on exit 3, and a retryable one stays exit 4.
//
// Only exit codes and error codes are read out of the child process. The message body marker and
// the store key are asserted absent from all output, never printed.

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
// A private bundle keeps this suite independent of the shared dist/cli.js build used by the other
// process-level suites, which vitest may run in parallel.
const entry = join(packageDir, "dist", `cli.t53-quota-${process.pid}.js`);

const paths: string[] = [];
const servers: Server[] = [];

beforeAll(async () => {
  await build({
    entryPoints: [join(packageDir, "src/commands/cli.ts")],
    outfile: entry,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22.13",
    external: ["@signalapp/libsignal-client"],
    legalComments: "none",
    sourcemap: false,
    banner: { js: 'import { createRequire } from "node:module";\nconst require = createRequire(import.meta.url);' },
  });
}, 60000);

afterAll(() => rmSync(entry, { force: true }));

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise<void>((done, reject) => { server.closeAllConnections(); server.close((error) => error ? reject(error) : done()); });
  }
  for (const path of paths.splice(0)) rmSync(path, { recursive: true, force: true });
});

interface CliRun { code: number | null; stdout: string; stderr: string; timedOut: boolean }

function runCli(args: string[], environment: Record<string, string | undefined>): Promise<CliRun> {
  return new Promise((done, reject) => {
    const child = spawn(process.execPath, [entry, ...args], {
      cwd: packageDir, env: { ...process.env, ...environment }, stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "", stderr = "", timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, 15000);
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.stdin.on("error", () => { /* the entrypoint may reject before reading stdin */ });
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", (code) => { clearTimeout(timer); done({ code, stdout, stderr, timedOut }); });
    child.stdin.end();
  });
}

function fixture() {
  const profileDir = mkdtempSync(join(tmpdir(), "echolet-cli-quota-"));
  paths.push(profileDir);
  return { profileDir, environment: { ECHOLET_TEST_KEY: randomBytes(32).toString("base64url") } };
}
type Fixture = ReturnType<typeof fixture>;

const run = (owner: Fixture, args: string[]) =>
  runCli([...args, "--profile", owner.profileDir, "--json"], owner.environment);

/** Reads the single JSON result line without ever echoing stdout into the failure message. */
function outcome(result: CliRun): { code: number | null; errorCode: string; timedOut: boolean } {
  let errorCode = "none";
  try {
    const value = JSON.parse(result.stdout) as { ok?: boolean; error?: { code?: unknown } };
    if (typeof value.error?.code === "string" && /^[A-Z_]+$/.test(value.error.code)) errorCode = value.error.code;
    else if (value.ok === true) errorCode = "ok";
  } catch { errorCode = result.stdout.length === 0 ? "no-output" : "unparsable"; }
  return { code: result.code, errorCode, timedOut: result.timedOut };
}

/** Boolean assertions only: never render a store key or a message body into failure output. */
function redacted(result: CliRun, owner: Fixture, plaintext = "") {
  const output = result.stdout + result.stderr;
  expect(output.includes(owner.environment.ECHOLET_TEST_KEY)).toBe(false);
  if (plaintext) expect(output.includes(plaintext)).toBe(false);
}

async function init(owner: Fixture, relayUrl = "http://127.0.0.1:1") {
  expect(outcome(await run(owner, ["init", "--relay-url", relayUrl, "--store-key-env", "ECHOLET_TEST_KEY"])))
    .toMatchObject({ code: 0, errorCode: "ok" });
}

async function exportCard(owner: Fixture) {
  const path = join(owner.profileDir, "contact.json");
  expect(outcome(await run(owner, ["contact", "export", "--out", path]))).toMatchObject({ code: 0 });
  const card = JSON.parse(readFileSync(path, "utf8")) as ContactCard;
  return { path, card, record: card.signal_bundle.device_record };
}

interface Reply { status: number; body: unknown }
type Routes = Record<string, (body: Record<string, unknown>) => Reply>;
const accepted = (data: unknown): Reply => ({ status: 200, body: { ok: true, data } });
/** Mirrors the relay's own error envelope: `writeJSONError(w, status, code, code)`. */
const rejected = (status: number, code: string): Reply => ({ status, body: { ok: false, error: { code, message: code } } });

async function startRelay(routes: Routes) {
  const server = createServer((request, reply) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const raw = Buffer.concat(chunks).toString();
      const body = (raw.length ? JSON.parse(raw) : {}) as Record<string, unknown>;
      const route = routes[request.url!];
      reply.setHeader("content-type", "application/json");
      if (!route) { reply.statusCode = 404; reply.end("{}"); return; }
      const answer = route(body);
      reply.statusCode = answer.status;
      reply.end(JSON.stringify(answer.body));
    })().catch(() => { reply.statusCode = 500; reply.end("{}"); });
  });
  servers.push(server);
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing relay test address");
  return `http://127.0.0.1:${address.port}`;
}

const marker = "SYNTHETIC_T53_BODY";

describe("the CLI names a per-sender mailbox quota instead of flattening it (T52-F-001)", () => {
  it("reports SENDER_QUOTA_EXCEEDED on exit 3 and never under the code used for a genuine protocol rejection", async () => {
    const alice = fixture(), bob = fixture();
    await init(bob);
    const peer = await exportCard(bob);

    // The relay declines this sender's next envelope because its unacked allowance in bob's mailbox
    // is full. The bundle claim succeeds and matches alice's pin, so `send` genuinely reaches
    // /v1/messages/send - the route the quota lives on.
    let sendReply: Reply = rejected(403, "SENDER_QUOTA_EXCEEDED");
    const relayUrl = await startRelay({
      "/v2/prekeys/claim": () => accepted({ bundle: peer.card.signal_bundle }),
      // Alice's own publication. `send` presupposes `relay publish` (T19), and the quota this test
      // is about lives on /v1/messages/send - a route the send has to actually reach.
      "/v2/prekeys/publish": (body) =>
        accepted({ stored: true, bundle_id: (body.bundle as { bundle_id: string }).bundle_id, claimable: true }),
      "/v1/messages/send": () => sendReply,
    });
    await init(alice, relayUrl);
    expect(outcome(await run(alice, ["contact", "import", "--from", peer.path, "--yes"]))).toMatchObject({ code: 0 });
    expect(outcome(await run(alice, ["relay", "publish"]))).toMatchObject({ code: 0, errorCode: "ok" });

    const quotaRun = await run(alice, ["send", "--to", peer.record.identity_id, "--text", marker]);
    const quota = outcome(quotaRun);

    // Still a non-retryable relay rejection on the documented exit code: the 0/2/3/4/5 contract is
    // untouched by naming the condition.
    expect(quota).toMatchObject({ timedOut: false, code: 3 });
    expect(
      quota.errorCode,
      "a temporary per-sender mailbox quota, which only the recipient can clear, must not be reported as a trust/protocol rejection",
    ).not.toBe("PROTOCOL_REJECTED");
    expect(quota.errorCode).toBe("SENDER_QUOTA_EXCEEDED");
    redacted(quotaRun, alice, marker);

    // A genuine relay-side violation on the very same route keeps reporting as one, so the two can
    // never share a code and renaming the generic code satisfies nothing.
    sendReply = rejected(403, "INVALID_SIGNATURE");
    const violationRun = await run(alice, ["send", "--to", peer.record.identity_id, "--text", marker]);
    const violation = outcome(violationRun);
    expect(violation).toMatchObject({ timedOut: false, code: 3 });
    expect(violation.errorCode).not.toBe(quota.errorCode);
    expect(violation.errorCode).not.toMatch(/QUOTA/);
    redacted(violationRun, alice, marker);

    // And a genuinely retryable relay failure still exits 4, unchanged. This is also why the quota
    // must not be answered with 429: a retryable status is classified before `remoteCode` is ever
    // consulted, so the diagnosis would be discarded and the sender would retry a condition it
    // cannot clear.
    sendReply = rejected(429, "RATE_LIMITED");
    const retryable = outcome(await run(alice, ["send", "--to", peer.record.identity_id, "--text", marker]));
    expect(retryable).toMatchObject({ timedOut: false, code: 4, errorCode: "RELAY_UNAVAILABLE" });
  }, 60000);
});
