import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { deriveMailboxId } from "@echolet/crypto-core";
import type { ContactCard } from "../runtime/profile";

// Review findings F-002 and F-003.
// F-002: the interactive contact-import confirmation must settle on a completed newline
//        terminated line instead of waiting for stdin EOF.
// F-003: a SQLite failure occurring AFTER the profile store opened must classify as
//        PERSISTENCE_FAILURE / exit 5, while typed validation, trust and native decrypt
//        failures must keep exit 3.

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
// A private bundle keeps this suite independent of the shared dist/cli.js build used by
// the other process-level suites, which vitest may run in parallel.
const entry = join(packageDir, "dist", `cli.red-${process.pid}.js`);

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
interface RunOptions {
  environment?: Record<string, string | undefined>;
  stdin?: string;
  /** Leave the parent end of stdin open after writing, exactly like an interactive terminal. */
  keepStdinOpen?: boolean;
  onStderr?: (text: string, child: ChildProcess) => void;
  timeoutMs?: number;
}

function runCli(args: string[], options: RunOptions = {}): Promise<CliRun> {
  return new Promise((done, reject) => {
    const child = spawn(process.execPath, [entry, ...args], {
      cwd: packageDir, env: { ...process.env, ...options.environment }, stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "", stderr = "", timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, options.timeoutMs ?? 8000);
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); options.onStderr?.(stderr, child); });
    child.stdin.on("error", () => { /* the entrypoint may reject before reading stdin */ });
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", (code) => { clearTimeout(timer); done({ code, stdout, stderr, timedOut }); });
    if (options.stdin === undefined) { if (!options.keepStdinOpen) child.stdin.end(); return; }
    if (options.keepStdinOpen) child.stdin.write(options.stdin); else child.stdin.end(options.stdin);
  });
}

function fixture() {
  const profileDir = mkdtempSync(join(tmpdir(), "echolet-cli-red-"));
  paths.push(profileDir);
  return { profileDir, environment: { ECHOLET_TEST_KEY: randomBytes(32).toString("base64url") } };
}
type Fixture = ReturnType<typeof fixture>;

const run = (owner: Fixture, args: string[], options: RunOptions = {}) =>
  runCli([...args, "--profile", owner.profileDir, "--json"], { environment: owner.environment, ...options });

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

type Routes = Record<string, (body: Record<string, unknown>) => unknown>;
async function startRelay(routes: Routes, beforeRespond?: (path: string) => void) {
  const server = createServer((request, reply) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const raw = Buffer.concat(chunks).toString();
      const body = (raw.length ? JSON.parse(raw) : {}) as Record<string, unknown>;
      const path = request.url!;
      reply.setHeader("content-type", "application/json");
      const route = routes[path];
      if (!route) { reply.statusCode = 404; reply.end("{}"); return; }
      const data = route(body);
      beforeRespond?.(path);
      reply.end(JSON.stringify({ ok: true, data }));
    })().catch(() => { reply.statusCode = 500; reply.end("{}"); });
  });
  servers.push(server);
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing relay test address");
  return `http://127.0.0.1:${address.port}`;
}

/**
 * Deterministic persistence fault: a second connection holds BEGIN IMMEDIATE against the same
 * database file. The store opens with busy_timeout=0, so every later BEGIN IMMEDIATE fails at
 * once. Readers are unaffected, so the profile still opens successfully first.
 */
function lockProfileDatabase(owner: Fixture) {
  const db = new DatabaseSync(join(owner.profileDir, "client.sqlite"));
  db.exec("PRAGMA busy_timeout = 0");
  db.exec("BEGIN IMMEDIATE");
  let released = false;
  return {
    release() {
      if (released) return;
      released = true;
      try { db.exec("ROLLBACK"); } finally { db.close(); }
    },
  };
}

const acceptedSend = (body: Record<string, unknown>) => ({
  accepted: true, envelope_id: (body.envelope as { envelope_id: string }).envelope_id, status: "relayed",
});

// Populated inside the typed-failure test before its poll route is exercised.
const undecryptable: Record<string, unknown> = {};

describe("interactive contact-import confirmation (F-002)", () => {
  it("settles on a completed affirmative line without waiting for stdin to close", async () => {
    const alice = fixture(), bob = fixture();
    await init(alice); await init(bob);
    const peer = await exportCard(bob);

    const result = await run(alice, ["contact", "import", "--from", peer.path], { stdin: "yes\n", keepStdinOpen: true });

    expect(outcome(result)).toMatchObject({ timedOut: false, code: 0, errorCode: "ok" });
  }, 40000);

  it("settles on a completed negative line without waiting for stdin to close", async () => {
    const alice = fixture(), bob = fixture();
    await init(alice); await init(bob);
    const peer = await exportCard(bob);

    const result = await run(alice, ["contact", "import", "--from", peer.path], { stdin: "n\n", keepStdinOpen: true });

    expect(outcome(result)).toMatchObject({ timedOut: false, code: 3, errorCode: "CONTACT_NOT_CONFIRMED" });
  }, 40000);

  it("still settles on end of input without a trailing newline", async () => {
    const alice = fixture(), bob = fixture();
    await init(alice); await init(bob);
    const peer = await exportCard(bob);

    const result = await run(alice, ["contact", "import", "--from", peer.path], { stdin: "yes" });

    expect(outcome(result)).toMatchObject({ timedOut: false, code: 0, errorCode: "ok" });
  }, 40000);

  it("still settles on an overlong answer without waiting for stdin to close", async () => {
    const alice = fixture(), bob = fixture();
    await init(alice); await init(bob);
    const peer = await exportCard(bob);

    const result = await run(alice, ["contact", "import", "--from", peer.path], { stdin: "y".repeat(64), keepStdinOpen: true });

    expect(outcome(result)).toMatchObject({ timedOut: false, code: 3, errorCode: "CONTACT_NOT_CONFIRMED" });
  }, 40000);
});

describe("runtime persistence failure classification (F-003)", () => {
  it("classifies the post-send delivery commit failure as PERSISTENCE_FAILURE with exit 5", async () => {
    const alice = fixture(), bob = fixture();
    await init(bob);
    const peer = await exportCard(bob);
    let lock: { release(): void } | undefined;
    const relayUrl = await startRelay({
      "/v2/prekeys/claim": () => ({ bundle: peer.card.signal_bundle }),
      "/v1/messages/send": acceptedSend,
    }, (path) => { if (path === "/v1/messages/send") lock = lockProfileDatabase(alice); });
    await init(alice, relayUrl);
    expect(outcome(await run(alice, ["contact", "import", "--from", peer.path, "--yes"]))).toMatchObject({ code: 0 });

    try {
      const result = await run(alice, ["send", "--to", peer.record.identity_id, "--text", "SYNTHETIC_RED_BODY", "--message-id", randomUUID()]);
      expect(lock).toBeDefined();
      expect(outcome(result)).toMatchObject({ timedOut: false, code: 5, errorCode: "PERSISTENCE_FAILURE" });
    } finally { lock?.release(); }
  }, 40000);

  it("classifies the inbound poll commit failure as PERSISTENCE_FAILURE with exit 5", async () => {
    const alice = fixture();
    let lock: { release(): void } | undefined;
    const relayUrl = await startRelay({
      "/v1/mailbox/challenge": () => ({ challenge_id: randomUUID(), nonce: "red-nonce", expires_at_ms: Date.now() + 60000 }),
      "/v1/mailbox/poll": () => ({ envelopes: [], next_cursor: null }),
    }, (path) => { if (path === "/v1/mailbox/poll") lock = lockProfileDatabase(alice); });
    await init(alice, relayUrl);

    try {
      const result = await run(alice, ["poll"]);
      expect(lock).toBeDefined();
      expect(outcome(result)).toMatchObject({ timedOut: false, code: 5, errorCode: "PERSISTENCE_FAILURE" });
    } finally { lock?.release(); }
  }, 40000);

  it("classifies the contact-import commit failure as PERSISTENCE_FAILURE with exit 5", async () => {
    const alice = fixture(), bob = fixture();
    await init(alice); await init(bob);
    const peer = await exportCard(bob);
    let lock: { release(): void } | undefined;

    try {
      // The printed confirmation prompt is the synchronisation barrier: the profile store is
      // already open and idle, and the import transaction has not started yet.
      const result = await run(alice, ["contact", "import", "--from", peer.path], {
        keepStdinOpen: true,
        onStderr: (text, child) => {
          if (lock || !text.includes("[y/N]")) return;
          lock = lockProfileDatabase(alice);
          child.stdin?.end("yes");
        },
      });
      expect(lock).toBeDefined();
      expect(outcome(result)).toMatchObject({ timedOut: false, code: 5, errorCode: "PERSISTENCE_FAILURE" });
    } finally { lock?.release(); }
  }, 40000);

  it("keeps typed validation, trust and native decrypt failures on exit 3", async () => {
    const alice = fixture(), bob = fixture();
    await init(bob);
    const peer = await exportCard(bob);
    const relayUrl = await startRelay({
      "/v1/mailbox/challenge": () => ({ challenge_id: randomUUID(), nonce: "red-nonce", expires_at_ms: Date.now() + 60000 }),
      "/v1/mailbox/poll": () => ({ envelopes: [undecryptable], next_cursor: null }),
      "/v1/messages/send": acceptedSend,
    });
    await init(alice, relayUrl);
    const local = await exportCard(alice);

    // Typed validation failure: a forged device-record signature.
    const forgedCard = JSON.parse(readFileSync(peer.path, "utf8")) as ContactCard;
    forgedCard.signal_bundle.device_record.signature = Buffer.alloc(64).toString("base64url");
    const forgedPath = join(bob.profileDir, "forged.json");
    writeFileSync(forgedPath, JSON.stringify(forgedCard));
    expect(outcome(await run(alice, ["contact", "import", "--from", forgedPath, "--yes"])))
      .toMatchObject({ code: 3, errorCode: "INVALID_CONTACT_CARD" });

    // Typed trust failure: sending to an identity that was never pinned.
    expect(outcome(await run(alice, ["send", "--to", peer.record.identity_id, "--text", "SYNTHETIC_RED_BODY"])))
      .toMatchObject({ code: 3, errorCode: "CONTACT_NOT_TRUSTED" });

    // Native decrypt failure from a pinned contact.
    expect(outcome(await run(alice, ["contact", "import", "--from", peer.path, "--yes"]))).toMatchObject({ code: 0 });
    const now = Date.now();
    const ciphertext = Buffer.from(JSON.stringify({ version: 1, type: 3, body: "AAAA" })).toString("base64url");
    Object.assign(undecryptable, {
      type: "mailbox_envelope", version: 1, envelope_id: randomUUID(), message_id: randomUUID(),
      sender_identity_id: peer.record.identity_id, sender_device_id: peer.record.device_id,
      recipient_identity_id: local.record.identity_id, recipient_device_id: local.record.device_id,
      recipient_mailbox_id: deriveMailboxId(local.record.identity_id),
      payload_type: "ciphertext_message", ciphertext,
      created_at_ms: now - 1000, expires_at_ms: now + 600000, size_bytes: Buffer.byteLength(ciphertext),
    });
    const polled = outcome(await run(alice, ["poll"]));
    expect(polled).toMatchObject({ code: 3, errorCode: "INBOUND_REJECTED" });
    expect(polled.code).not.toBe(5);
  }, 60000);
});
