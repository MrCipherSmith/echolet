import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { LIMITS } from "@echolet/protocol";
import { importVerifiedSignalBundleV2 } from "@echolet/session-node";
import { openProfile, type ContactCard } from "../runtime/profile";

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
    const timeout = setTimeout(() => { processChild.kill("SIGKILL"); reject(new Error("CLI child timed out")); }, 15000);
    processChild.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    processChild.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    processChild.on("error", (error) => { clearTimeout(timeout); reject(error); });
    processChild.on("close", (code) => { clearTimeout(timeout); resolveResult({ code, stdout, stderr }); });
    processChild.stdin.on("error", () => { /* Entrypoint may reject before reading stdin. */ });
    processChild.stdin.end(stdin);
  });
}
// The binary is built once by the vitest globalSetup (test/globalSetup.ts). This suite must not
// rebuild it: the two-process E2E suite spawns the same dist/cli.js concurrently.
beforeAll(() => { expect(existsSync(entry)).toBe(true); });
afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise<void>((done, reject) => { server.closeAllConnections(); server.close((error) => error ? reject(error) : done()); });
  for (const path of paths.splice(0)) rmSync(path, { recursive: true, force: true });
});
function fixture() {
  const profileDir = mkdtempSync(join(tmpdir(), "echolet-cli-process-")); paths.push(profileDir);
  return { profileDir, environment: { ECHOLET_TEST_KEY: randomBytes(32).toString("base64url") } };
}
type Fixture = ReturnType<typeof fixture>;
const run = (owner: Fixture, args: string[], stdin = "", environment = owner.environment) => child(process.execPath, [entry, ...args, "--profile", owner.profileDir, "--json"], environment, stdin);
function json(result: ProcessResult, code = 0): Record<string, unknown> {
  expect(result.code).toBe(code);
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
  // Boolean assertions deliberately avoid rendering secret values on failure.
  expect(output.includes(owner.environment.ECHOLET_TEST_KEY)).toBe(false);
  if (plaintext) expect(output.includes(plaintext)).toBe(false);
  expect(/identitySecretKey|deviceSecretKey|sessionSecretKey|"seed"|ciphertext/.test(output)).toBe(false);
}

describe("Echolet command line process contract", () => {
  it("exposes a runnable bin and initializes independent profiles without allowing replacement", async () => {
    expect(typeof bin).toBe("string"); expect(existsSync(entry)).toBe(true);
    const alice = fixture(), bob = fixture();
    await Promise.all([init(alice), init(bob)]);
    const a = await exportCard(alice), b = await exportCard(bob);
    expect(a.card.signal_bundle.device_record.identity_id).not.toBe(b.card.signal_bundle.device_record.identity_id);
    const db = readFileSync(join(alice.profileDir, "client.sqlite")), config = readFileSync(join(alice.profileDir, "config.json"));
    json(await run(alice, ["init", "--relay-url", "http://127.0.0.1:1", "--store-key-env", "ECHOLET_TEST_KEY"]), 2);
    expect(readFileSync(join(alice.profileDir, "client.sqlite"))).toEqual(db);
    expect(readFileSync(join(alice.profileDir, "config.json"))).toEqual(config);
  }, 30000);

  it("rejects unknown flags and missing values for every documented command with exit 2 and one JSON object", async () => {
    const owner = fixture();
    for (const command of [["init"], ["contact", "export"], ["contact", "import"], ["relay", "publish"], ["send"], ["poll"], ["history"], ["doctor"]]) {
      json(await run(owner, [...command, "--unknown-flag"]), 2);
      const missing = await child(process.execPath, [entry, ...command, "--json", "--profile"], owner.environment);
      json(missing, 2);
    }
  }, 30000);

  it("exports verified contacts offline, requires explicit confirmation, and rejects forged imports even with --yes", async () => {
    const alice = fixture(), bob = fixture(); await init(alice); await init(bob);
    const { path, card } = await exportCard(bob), record = card.signal_bundle.device_record;
    expect(() => importVerifiedSignalBundleV2(card.signal_bundle, { identityId: record.identity_id, deviceId: record.device_id })).not.toThrow();
    json(await run(alice, ["contact", "import", "--from", path]), 3);
    const declined = await run(alice, ["contact", "import", "--from", path], "no\n"); json(declined, 3);
    const profile = await openProfile({ profileDir: alice.profileDir, environment: alice.environment });
    try { expect(await profile.listContacts()).toEqual([]); } finally { await profile.close(); }
    const accepted = await run(alice, ["contact", "import", "--from", path, "--yes"]); json(accepted); redacted(accepted, alice);
    const pinned = await openProfile({ profileDir: alice.profileDir, environment: alice.environment });
    try { expect(await pinned.listContacts()).toEqual([expect.objectContaining({ identity_id: record.identity_id, device_id: record.device_id, device_pubkey: record.device_pubkey, signal_identity_key: card.signal_bundle.signal_identity_key })]); } finally { await pinned.close(); }
    card.signal_bundle.device_record.signature = Buffer.alloc(64).toString("base64url");
    const forged = join(bob.profileDir, "forged.json"); writeFileSync(forged, JSON.stringify(card));
    json(await run(alice, ["contact", "import", "--from", forged, "--yes"]), 3);
  }, 30000);

  it("keeps doctor/history offline and maps invalid keys to input or persistence failures without leaking them", async () => {
    const owner = fixture(); await init(owner); const { card } = await exportCard(owner);
    const doctor = await run(owner, ["doctor"]); json(doctor); redacted(doctor, owner);
    const history = await run(owner, ["history", "--with", card.signal_bundle.device_record.identity_id]); json(history); redacted(history, owner);
    const missing = await child(process.execPath, [entry, "doctor", "--profile", owner.profileDir, "--json"], { ECHOLET_TEST_KEY: undefined }); json(missing, 2);
    const wrong = await run(owner, ["doctor"], "", { ECHOLET_TEST_KEY: randomBytes(32).toString("base64url") }); json(wrong, 5); redacted(wrong, owner);
    writeFileSync(join(owner.profileDir, "client.sqlite"), "invalid database");
    const corrupt = await run(owner, ["doctor"]); json(corrupt, 5); redacted(corrupt, owner);
  }, 30000);

  it("routes publish/send/poll through HTTP and exposes plaintext only through explicitly requested history", async () => {
    const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
    let peer: ContactCard | undefined, mode: "normal" | "unavailable" | "malformed" = "normal";
    const marker = "SYNTHETIC_PROCESS_PLAINTEXT";
    const server = createServer((request, reply) => {
      void (async () => {
        const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const body = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>, path = request.url!;
        requests.push({ path, body }); reply.setHeader("content-type", "application/json");
        if (mode === "unavailable") { reply.statusCode = 503; reply.end(JSON.stringify({ ok: false, error: { code: "INTERNAL_ERROR", message: marker } })); return; }
        if (mode === "malformed") { reply.end(JSON.stringify({ ok: true, data: { unexpected: marker } })); return; }
        let data: unknown;
        // Alice publishes her own fresh bundle and nobody claims it in this scenario, so the
        // stored bundle stays available: the relay's publish response reports `claimable: true`.
        if (path === "/v2/prekeys/publish") data = { stored: true, bundle_id: (body.bundle as { bundle_id: string }).bundle_id, claimable: true };
        else if (path === "/v2/prekeys/claim") data = { bundle: peer!.signal_bundle };
        else if (path === "/v1/messages/send") data = { accepted: true, envelope_id: (body.envelope as { envelope_id: string }).envelope_id, status: "relayed" };
        else if (path === "/v1/mailbox/challenge") data = { challenge_id: randomUUID(), nonce: "process-nonce", expires_at_ms: Date.now() + 60000 };
        else if (path === "/v1/mailbox/poll") data = { envelopes: [], next_cursor: null };
        else { reply.statusCode = 404; reply.end("{}"); return; }
        reply.end(JSON.stringify({ ok: true, data }));
      })().catch(() => { reply.statusCode = 500; reply.end("{}"); });
    });
    servers.push(server); await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const address = server.address(); if (!address || typeof address === "string") throw new Error("Missing test server address");
    const alice = fixture(), bob = fixture(); await init(alice, `http://127.0.0.1:${address.port}`); await init(bob);
    const exported = await exportCard(bob); peer = exported.card;
    json(await run(alice, ["contact", "import", "--from", exported.path, "--yes"]));
    for (const args of [["relay", "publish"], ["send", "--to", peer.signal_bundle.device_record.identity_id, "--text", marker], ["poll"]]) {
      const result = await run(alice, args); json(result); redacted(result, alice, marker);
    }
    // Flow 003 / T26: `relay publish` now tops up a pool of LIMITS.PREKEY_MIN_COUNT independently
    // signed bundles rather than submitting a single one, so alice's very first publish (empty
    // profile) mints and publishes all of them before the claim-and-deposit tail. The tail itself -
    // exactly one claim, one send, one challenge, one poll - is unchanged and stays pinned exactly.
    expect(requests.map(({ path }) => path)).toEqual([...Array(LIMITS.PREKEY_MIN_COUNT).fill("/v2/prekeys/publish"), "/v2/prekeys/claim", "/v1/messages/send", "/v1/mailbox/challenge", "/v1/mailbox/poll"]);
    expect(JSON.stringify(requests).includes(marker)).toBe(false);
    const history = await run(alice, ["history", "--with", peer.signal_bundle.device_record.identity_id]); json(history);
    expect(history.stdout.includes(marker)).toBe(true); expect(history.stderr.includes(marker)).toBe(false);
    mode = "unavailable"; const unavailable = await run(alice, ["relay", "publish"]); json(unavailable, 4); redacted(unavailable, alice, marker);
    mode = "malformed"; const malformed = await run(alice, ["poll"]); json(malformed, 3); redacted(malformed, alice, marker);
  }, 30000);

  it("maps untrusted sends to exit 3 and unavailable relay connections to exit 4 with redacted diagnostics", async () => {
    const owner = fixture(), peer = fixture(); await init(owner); await init(peer);
    const exported = await exportCard(peer), marker = "SYNTHETIC_REJECTED_TEXT";
    const untrusted = await run(owner, ["send", "--to", exported.card.signal_bundle.device_record.identity_id, "--text", marker]);
    json(untrusted, 3); redacted(untrusted, owner, marker);
    const unavailable = await run(owner, ["relay", "publish"]); json(unavailable, 4); redacted(unavailable, owner);
  }, 30000);

  // Flow 003 / T26 group C — what the operator is TOLD once `relay publish` means "bring my
  // published pool back up to N".
  //
  // `claimable` changes meaning from "the bundle I published can be claimed" to "at least one pool
  // member can serve a first-contact sender", which is the only question the operator is actually
  // asking. The per-member truth moves into `pool`, and `pool.target` is read from the protocol's
  // own `LIMITS.PREKEY_MIN_COUNT` rather than a second literal minted for the same quantity.
  //
  // The command surface is FROZEN at eight commands and `relay publish` gains no option: N is a
  // client constant agreed in advance, never negotiated on the wire and never an operator knob
  // (the relay is the adversary-adjacent component). The enumeration above must keep passing
  // verbatim; this adds to it rather than relaxing it.
  it("reports the restored publication pool and adds no option to the frozen relay publish command", async () => {
    const publishes: string[] = [];
    const server = createServer((request, reply) => {
      void (async () => {
        const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const body = JSON.parse(Buffer.concat(chunks).toString()) as { bundle?: { bundle_id: string } };
        reply.setHeader("content-type", "application/json");
        if (request.url !== "/v2/prekeys/publish" || !body.bundle) { reply.statusCode = 404; reply.end("{}"); return; }
        // Every member here is freshly stored and unclaimed, so the relay answers claimable: true
        // for each — one bundle per request, which is also the only shape that fits the relay's
        // 64 KiB request cap at N = 20.
        publishes.push(body.bundle.bundle_id);
        reply.end(JSON.stringify({ ok: true, data: { stored: true, bundle_id: body.bundle.bundle_id, claimable: true } }));
      })().catch(() => { reply.statusCode = 500; reply.end("{}"); });
    });
    servers.push(server); await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const address = server.address(); if (!address || typeof address === "string") throw new Error("Missing test server address");
    const owner = fixture(); await init(owner, `http://127.0.0.1:${address.port}`);

    const published = json(await run(owner, ["relay", "publish"]));
    redacted(await run(owner, ["doctor"]), owner);
    const data = published.data as { stored?: unknown; bundleId?: unknown; claimable?: unknown; pool?: Record<string, unknown> };
    expect(
      data.pool,
      "`relay publish` must report {target, claimable, minted}: the operator's only recovery path has to say what it actually restored",
    ).toBeDefined();
    expect(Object.keys(data).sort()).toEqual(["bundleId", "claimable", "pool", "stored"]);
    expect(Object.keys(data.pool!).sort()).toEqual(["claimable", "minted", "target"]);
    expect(data.pool!.target).toBe(LIMITS.PREKEY_MIN_COUNT);
    expect(publishes).toHaveLength(LIMITS.PREKEY_MIN_COUNT);
    expect(new Set(publishes).size).toBe(LIMITS.PREKEY_MIN_COUNT);
    expect(data.pool!.claimable).toBe(LIMITS.PREKEY_MIN_COUNT);
    expect(data.pool!.minted).toBe(LIMITS.PREKEY_MIN_COUNT);
    expect(data.stored).toBe(true);
    // `claimable` is true exactly when some member can serve a first-contact sender.
    expect(data.claimable).toBe((data.pool!.claimable as number) > 0);
    expect(typeof data.bundleId).toBe("string");

    // No ninth command, and no new option on this one.
    for (const rejected of [["relay", "publish", "--to", "x"], ["relay", "publish", "--out", "x"], ["relay", "pool"]]) {
      json(await run(owner, rejected), 2);
    }
  }, 60000);
});
