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
import { CLI_CHILD_TIMEOUT_MS, CLI_TEST_TIMEOUT_MS } from "../../test/childProcessTimeouts";

// T44-001, second flattening. `classify()` collapses every non-retryable RelayError to one code
// without consulting `remoteCode` or `httpStatus`, so an ordinary exhausted recipient prekey
// (relay `404 PREKEY_BUNDLE_UNAVAILABLE`, an expected and recoverable condition) is reported to the
// operator exactly like a genuine trust/protocol violation such as a relay-side `400
// INVALID_SIGNATURE`. Both currently exit 3 as PROTOCOL_REJECTED.
//
// These tests pin both sides. The exhausted case must name the prekey condition, the genuine
// violations must keep reporting as trust/protocol rejections, and the two must never share one
// code - so renaming the generic code satisfies nothing.

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
// A private bundle keeps this suite independent of the shared dist/cli.js build used by the other
// process-level suites, which vitest may run in parallel.
const entry = join(packageDir, "dist", `cli.t45-codes-${process.pid}.js`);

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
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, CLI_CHILD_TIMEOUT_MS);
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.stdin.on("error", () => { /* the entrypoint may reject before reading stdin */ });
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", (code) => { clearTimeout(timer); done({ code, stdout, stderr, timedOut }); });
    child.stdin.end();
  });
}

function fixture() {
  const profileDir = mkdtempSync(join(tmpdir(), "echolet-cli-codes-"));
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

const marker = "SYNTHETIC_T45_BODY";

describe("relay failure reporting distinguishes an exhausted prekey from a protocol rejection (T44-001)", () => {
  it("names the exhausted recipient prekey and never reports it under the code used for a relay signature rejection", async () => {
    const alice = fixture(), bob = fixture();
    await init(bob);
    const peer = await exportCard(bob);
    // Alice's own publication succeeds first and is only then made to fail. `send` presupposes
    // `relay publish` (T19), so alice has to have published for her send to reach the claim at all -
    // and the genuine protocol violation this test contrasts against is still raised on exactly the
    // same non-retryable 4xx path, from the same profile, a moment later.
    let publishReply: (body: Record<string, unknown>) => Reply = (body) =>
      accepted({ stored: true, bundle_id: (body.bundle as { bundle_id: string }).bundle_id, claimable: true });
    const relayUrl = await startRelay({
      // Exactly what the relay returns once the recipient's single published bundle is consumed
      // (specification.md:92, confirmed at the wire by the T44 probe).
      "/v2/prekeys/claim": () => rejected(404, "PREKEY_BUNDLE_UNAVAILABLE"),
      "/v2/prekeys/publish": (body) => publishReply(body),
    });
    await init(alice, relayUrl);
    expect(outcome(await run(alice, ["contact", "import", "--from", peer.path, "--yes"]))).toMatchObject({ code: 0 });
    expect(outcome(await run(alice, ["relay", "publish"]))).toMatchObject({ code: 0, errorCode: "ok" });

    const exhaustedRun = await run(alice, ["send", "--to", peer.record.identity_id, "--text", marker]);
    // A genuine protocol violation on the same non-retryable 4xx path.
    publishReply = () => rejected(400, "INVALID_SIGNATURE");
    const violationRun = await run(alice, ["relay", "publish"]);
    const exhausted = outcome(exhaustedRun), violation = outcome(violationRun);

    // Both remain non-retryable failures on the documented exit code.
    expect(exhausted).toMatchObject({ timedOut: false, code: 3 });
    expect(violation).toMatchObject({ timedOut: false, code: 3 });
    // An ordinary, recoverable exhausted prekey must not be reported as a protocol rejection.
    expect(exhausted.errorCode).not.toBe("PROTOCOL_REJECTED");
    expect(exhausted.errorCode).toMatch(/PREKEY/);
    // A genuine relay-side signature rejection must not be reported as a prekey condition ...
    expect(violation.errorCode).not.toMatch(/PREKEY/);
    // ... and the two conditions must never share one code, so renaming the generic code is no fix.
    expect(violation.errorCode).not.toBe(exhausted.errorCode);

    redacted(exhaustedRun, alice, marker);
    redacted(violationRun, alice, marker);
  }, CLI_TEST_TIMEOUT_MS);

  it("keeps trust rejections, other protocol rejections and retryable relay failures on their documented exit codes", async () => {
    const alice = fixture(), bob = fixture(), stranger = fixture();
    await init(bob); await init(stranger);
    const peer = await exportCard(bob), other = await exportCard(stranger);
    let publishReply: Reply = rejected(409, "BUNDLE_ID_CONFLICT");
    const relayUrl = await startRelay({
      "/v2/prekeys/publish": () => publishReply,
      // A bundle that does not match the pinned contact: a trust decision, not a transport code.
      "/v2/prekeys/claim": () => accepted({ bundle: other.card.signal_bundle }),
    });
    await init(alice, relayUrl);

    // Trust rejection raised before any relay call.
    const untrusted = outcome(await run(alice, ["send", "--to", peer.record.identity_id, "--text", marker]));
    expect(untrusted).toMatchObject({ timedOut: false, code: 3, errorCode: "CONTACT_NOT_TRUSTED" });

    // Another genuine non-retryable protocol rejection stays a trust/protocol rejection.
    const conflict = outcome(await run(alice, ["relay", "publish"]));
    expect(conflict).toMatchObject({ timedOut: false, code: 3 });
    expect(conflict.errorCode).not.toMatch(/PREKEY/);

    // A retryable relay failure keeps exit 4; it must not be reclassified by the fix.
    publishReply = rejected(503, "INTERNAL_ERROR");
    const unavailable = outcome(await run(alice, ["relay", "publish"]));
    expect(unavailable).toMatchObject({ timedOut: false, code: 4, errorCode: "RELAY_UNAVAILABLE" });

    // A claimed bundle that contradicts the pin stays a trust rejection, never a prekey condition.
    expect(outcome(await run(alice, ["contact", "import", "--from", peer.path, "--yes"]))).toMatchObject({ code: 0 });
    const mismatchRun = await run(alice, ["send", "--to", peer.record.identity_id, "--text", marker]);
    const mismatch = outcome(mismatchRun);
    expect(mismatch).toMatchObject({ timedOut: false, code: 3, errorCode: "CONTACT_PIN_MISMATCH" });
    redacted(mismatchRun, alice, marker);
  }, CLI_TEST_TIMEOUT_MS);
});
