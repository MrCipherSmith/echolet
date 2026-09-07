import { afterAll, beforeAll, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { deriveMailboxId, generateIdentityKeyPair, signUtf8Message } from "@echolet/crypto-core";

/**
 * RED suite for finding T10R3-F-001 — the contact-import re-walk is not crash-safe.
 *
 * The defect
 * ----------
 * `Profile.takeMailboxRewalk()` (apps/cli/src/runtime/profile.ts:174) DELETES the durable re-walk
 * position `cli:mailbox-rewalk` before the walk begins, and `keepMailboxRewalk()` writes it back only
 * after the page loop returns or from the `catch` around it (apps/cli/src/runtime/inbound.ts:145-194).
 * Between those two points the position exists in no durable place at all. A process that ends
 * inside that window — and `inbound.ts:100` itself names "an operator's Ctrl-C" as one of the NORMAL
 * interruptions durable progress must survive — drops the recovery the operator explicitly asked for.
 * The relay-held read mark is already past the envelope the import was performed for, every later
 * poll is cursorless and resumes after it, and the message is unreachable until it expires. Nothing
 * tells the operator anything happened: the polls keep exiting 3 on the last page of poison.
 *
 * Why both directions are pinned here, and why one test would be worse than none
 * ------------------------------------------------------------------------------
 * The delete-first shape is deliberate. The comment on `takeMailboxRewalk` cites finding T6-F-004: a
 * re-walk position that survives its own SUCCESSFUL walk makes every later poll restart at the same
 * place, which reinstates the entire flooding class this flow exists to close, while every unit test
 * still passes. So a suite that pinned only "an interrupted walk must not lose the position" could be
 * satisfied by never clearing the position — a worse defect than the one it fixed.
 *
 * The four tests below therefore pin both properties at once:
 *
 *   1 / 2  an interrupted walk (SIGINT, then SIGKILL) still delivers the message, on a later poll,
 *          with no second `contact import`;
 *   3      the position moves strictly FORWARD across interrupt-and-resume: it is carried at the
 *          place the interrupted walk reached, never rewound to the head and never advanced past
 *          ground that walk had not judged;
 *   4      a re-walk that COMPLETES is not repeated — the polls after it neither restart at the
 *          re-walk's origin nor cost more than O(1) pages. This one passes on the current tree by
 *          design; it is the guard that keeps 1-3 from being "fixed" by never clearing the position.
 *
 * Determinism
 * -----------
 * Nothing here sleeps and hopes. The counting proxy HOLDS the response to a chosen poll page, and
 * the interruption is delivered while the CLI is blocked on exactly that request — so the signal
 * provably lands after the walk consumed the re-walk position and before the walk could write it
 * back. Each test additionally asserts that the interrupted process really was killed by the signal,
 * really had walked the pages it was supposed to, and really had NOT yet reached the message.
 *
 * Leak discipline
 * ---------------
 * The proxy reads each body, extracts envelope identifiers and counters, and discards the bytes. No
 * plaintext, ciphertext, store key, seed or HTTP body is printed. Poison ciphertext is inert
 * synthetic padding.
 *
 * Declared configuration deviation: `ECHOLET_RATE_LIMIT_PER_MINUTE` is raised so the per-IP limiter
 * does not confound a count-of-pages measurement — the same single deviation `flood-closure.test.ts`
 * and T49/T52/T55 declare.
 */

const project = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const suite = mkdtempSync(join(tmpdir(), "echolet-rewalk-crash-e2e-"));
const binary = join(suite, "relay"), cli = join(project, "apps/cli/dist/cli.js");

interface Result { code: number | null; stdout: string; stderr: string }
function command(executable: string, args: string[], env: Record<string, string> = {}, timeoutMs = 20000): Promise<Result> {
  return new Promise((done, reject) => {
    const child = spawn(executable, args, { cwd: project, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("E2E child timeout")); }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", (code) => { clearTimeout(timer); done({ code, stdout, stderr }); });
  });
}
async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((done, reject) => {
    const force = setTimeout(() => child.kill("SIGKILL"), 1500);
    const limit = setTimeout(() => reject(new Error("Relay teardown timeout")), 6000);
    child.once("close", () => { clearTimeout(force); clearTimeout(limit); done(); });
    child.kill("SIGTERM");
  });
}
async function listen(server: Server) {
  await new Promise<void>((done, reject) => {
    const timer = setTimeout(() => reject(new Error("Loopback listen timeout")), 3000);
    server.once("error", (error) => { clearTimeout(timer); reject(error); });
    server.listen(0, "127.0.0.1", () => { clearTimeout(timer); done(); });
  });
  const address = server.address(); if (!address || typeof address === "string") throw new Error("Missing loopback address");
  return address.port;
}
async function close(server: Server) {
  server.closeAllConnections();
  await new Promise<void>((done, reject) => {
    const timer = setTimeout(() => reject(new Error("Proxy teardown timeout")), 3000);
    server.close((error) => { clearTimeout(timer); error ? reject(error) : done(); });
  });
}
async function relayReady(url: string, child: ChildProcess) {
  const end = Date.now() + 10000;
  while (Date.now() < end) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error("Relay exited during startup");
    try { if ((await fetch(`${url}/health`, { signal: AbortSignal.timeout(500) })).ok) return; } catch { /* bounded startup retry */ }
    await delay(50);
  }
  throw new Error("Relay readiness timeout");
}

beforeAll(async () => {
  expect(existsSync(cli), "test/globalSetup.ts builds apps/cli/dist/cli.js once per run; no suite may rebuild it").toBe(true);
  expect((await command("go", ["-C", "apps/relay", "build", "-o", binary, "./cmd/relay"], { GOCACHE: join(project, ".gocache") }, 180000)).code).toBe(0);
}, 240000);
afterAll(() => rmSync(suite, { recursive: true, force: true }));

// ---------------------------------------------------------------------------
// The attacker, minted exactly the way flood-closure.test.ts mints one
// ---------------------------------------------------------------------------

interface Attacker { identityId: string; deviceId: string; deviceSecretKey: string }

/** A self-published sender identity: `POST /v1/device-records/publish` is unauthenticated (T52-F-001). */
async function publishAttacker(relayUrl: string): Promise<Attacker> {
  const identity = generateIdentityKeyPair(), device = generateIdentityKeyPair();
  const deviceId = randomUUID();
  const unsigned = {
    capabilities: { attachments: false, mailbox_poll: true, receipts: true },
    created_at_ms: 1770000000000,
    device_id: deviceId,
    device_pubkey: device.publicKey,
    identity_id: identity.publicKey,
    type: "device_record",
    version: 1,
  };
  const record = { ...unsigned, signature: signUtf8Message(JSON.stringify(unsigned), identity.secretKey) };
  const response = await fetch(`${relayUrl}/v1/device-records/publish`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ device_record: record }), signal: AbortSignal.timeout(10000),
  });
  expect(response.status, "self-publishing a fresh identity must still cost exactly one unauthenticated request (T52-F-001)").toBe(200);
  return { identityId: identity.publicKey, deviceId, deviceSecretKey: device.secretKey };
}

/** An envelope id that carries its own index, so an assertion can talk about positions. */
const poisonEnvelopeId = (index: number) => `00000000-0000-1000-8000-${String(index).padStart(12, "0")}`;
const poisonIndexOf = (envelopeId: string) =>
  /^00000000-0000-1000-8000-\d{12}$/.test(envelopeId) ? Number(envelopeId.slice(-12)) : -1;

interface Recipient { identityId: string; deviceId: string; mailboxId: string }

/** One poison envelope: permanently unacceptable to the recipient, perfectly valid to the relay. */
function poisonEnvelope(attacker: Attacker, recipient: Recipient, index: number, ciphertextBytes: number) {
  const now = Date.now();
  const ciphertext = "A".repeat(ciphertextBytes);
  const envelope = {
    type: "mailbox_envelope" as const, version: 1 as const,
    envelope_id: poisonEnvelopeId(index),
    message_id: randomUUID(),
    sender_identity_id: attacker.identityId,
    sender_device_id: attacker.deviceId,
    recipient_identity_id: recipient.identityId,
    recipient_device_id: recipient.deviceId,
    recipient_mailbox_id: recipient.mailboxId,
    payload_type: "ciphertext_message" as const,
    ciphertext,
    created_at_ms: now - 1000,
    expires_at_ms: now + 24 * 60 * 60 * 1000,
    size_bytes: Buffer.byteLength(ciphertext),
    sender_signature: "",
  };
  const digest = createHash("sha256").update(envelope.ciphertext, "utf8").digest("base64url");
  envelope.sender_signature = signUtf8Message(
    `echolet-mailbox-envelope:v1:${envelope.recipient_mailbox_id}:${envelope.envelope_id}:` +
      `${envelope.sender_identity_id}:${envelope.sender_device_id}:${digest}:` +
      `${String(envelope.created_at_ms)}:${String(envelope.expires_at_ms)}`,
    attacker.deviceSecretKey,
  );
  return envelope;
}

const postEnvelope = async (url: string, envelope: unknown) =>
  (await fetch(`${url}/v1/messages/send`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ envelope }), signal: AbortSignal.timeout(30000),
  })).status;

/**
 * Places `poison` envelopes in the recipient's mailbox, spread across as many self-published
 * identities as the per-sender quota (T54, 16) forces. Attacker traffic bypasses the counting proxy,
 * so the recipient's measured page cost is the recipient's alone.
 *
 * Concurrency stays 1: every assertion in this file talks about the ORDER the relay assigned, and
 * with a server-assigned sequence concurrent stores are ordered by arrival rather than by index.
 */
async function flood(relayUrl: string, recipient: Recipient, poison: number, ciphertextBytes: number, indexOffset = 0) {
  const perIdentity = 16;
  const identities: Attacker[] = [];
  for (let placed = 0; placed < poison; placed += perIdentity) identities.push(await publishAttacker(relayUrl));
  let stored = 0, uploadedBytes = 0;
  for (let index = 0; index < poison; index += 1) {
    const envelope = poisonEnvelope(identities[Math.floor(index / perIdentity)]!, recipient, index + indexOffset, ciphertextBytes);
    uploadedBytes += Buffer.byteLength(JSON.stringify({ envelope }));
    if ((await postEnvelope(relayUrl, envelope)) === 200) stored += 1;
  }
  return { identities: identities.length, stored, uploadedBytes, requests: identities.length + poison };
}

// ---------------------------------------------------------------------------
// The counting proxy, with a deterministic hold on a chosen poll page
// ---------------------------------------------------------------------------

interface Counters {
  polls: number;
  /** Envelope ids of every poll page, in order. Ids only: no body is ever retained. */
  pages: string[][];
}

/** A hold armed on one future poll request: `reached` settles when the CLI is blocked on it. */
interface Hold { at: number; reached: Promise<void>; release: () => void }

function counterProxy(relayUrl: string) {
  const counters: Counters = { polls: 0, pages: [] };
  let hold: { at: number; arrive: () => void; released: Promise<void>; release: () => void; dropped: boolean } | undefined;

  /**
   * Blocks the `after`-th poll request FROM NOW, before it is forwarded upstream, and DROPS it when
   * the test releases the hold.
   *
   * Holding before the upstream fetch is what makes the signal tests deterministic rather than
   * hopeful: when `reached` settles, the CLI has fully received and judged every earlier page and is
   * waiting on this one, so a signal delivered here is provably inside the window between
   * `takeMailboxRewalk` and `keepMailboxRewalk`.
   *
   * Dropping it rather than forwarding it afterwards is what keeps the measurement honest: the held
   * request carries the read position of the pages already judged, and forwarding it once the CLI is
   * dead would let a request nobody is waiting for move server-side state behind the test's back.
   * The process it belonged to no longer exists, so nothing is waiting for the response either.
   */
  function holdPollAfter(after: number, timeoutMs = 120000): Hold {
    const at = counters.polls + after;
    let arrive!: () => void, release!: () => void;
    const arrived = new Promise<void>((done) => { arrive = done; });
    const released = new Promise<void>((done) => { release = done; });
    hold = { at, arrive, released, release, dropped: false };
    const reached = Promise.race([
      arrived,
      delay(timeoutMs).then(() => { throw new Error(`the CLI never reached poll page ${String(at)}; the walk was shorter than this test assumes`); }),
    ]);
    return {
      at,
      reached,
      release: () => { if (hold) { hold.dropped = true; hold.release(); } hold = undefined; },
    };
  }

  const server = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const requestBody = Buffer.concat(chunks), path = request.url!;
      if (path === "/v1/mailbox/poll") {
        counters.polls += 1;
        if (hold && counters.polls === hold.at) {
          const held = hold;
          held.arrive();
          await held.released;
          // The process that made this request has been killed; the request is dropped rather than
          // forwarded, so it can never move relay-side state after the fact.
          if (held.dropped) { response.writeHead(499, { "content-type": "application/json" }); response.end("{}"); return; }
        }
      }
      const upstream = await fetch(relayUrl + path, {
        method: request.method, headers: { "content-type": "application/json" },
        body: request.method === "GET" ? undefined : requestBody, signal: AbortSignal.timeout(60000),
      });
      const bytes = Buffer.from(await upstream.arrayBuffer());
      // Only identifiers and counters are extracted; the bodies themselves are never stored, never
      // logged and never rendered in a failure message.
      if (path === "/v1/mailbox/poll") {
        let ids: string[] = [];
        try {
          const parsed = JSON.parse(bytes.toString("utf8")) as { data?: { envelopes?: Array<{ envelope_id?: unknown }> } };
          ids = (parsed.data?.envelopes ?? []).map((entry) => typeof entry.envelope_id === "string" ? entry.envelope_id : "");
        } catch { /* a non-success poll response contributes an empty page */ }
        counters.pages.push(ids);
      }
      response.writeHead(upstream.status, { "content-type": "application/json" });
      response.end(bytes);
    })().catch(() => { try { response.statusCode = 502; response.end("{}"); } catch { /* the caller was killed mid-request; that is the point of this suite */ } });
  });
  return { counters, server, holdPollAfter };
}

// ---------------------------------------------------------------------------
// One relay + proxy + two real CLI profiles (Bob the recipient, Carol the stranger)
// ---------------------------------------------------------------------------

/** The outcome of one deliberately interrupted `poll`. */
interface Interruption {
  /** Poll requests the relay saw from the interrupted process, including the one it died waiting on. */
  requests: number;
  /** The pages it actually RECEIVED, and therefore fully judged. Envelope ids only. */
  receivedPages: string[][];
  /** The signal that actually terminated it — never null, or the test proved nothing. */
  signalCode: NodeJS.Signals | null;
}

interface World {
  bob: string;
  bobIdentity: string;
  bobRecipient: Recipient;
  relayUrl: string;
  counters: Counters;
  carol: { identityId: string; cardPath: string; send: (text: string) => Promise<void> };
  run: (profile: string, args: string[], expected?: number | null, timeoutMs?: number) => Promise<{ code: number | null; errorCode: string }>;
  historyLength: (profile: string, identity: string) => Promise<number>;
  pollOnce: (timeoutMs?: number) => Promise<number>;
  interruptPollAtPage: (page: number, signal: NodeJS.Signals, timeoutMs?: number) => Promise<Interruption>;
  driveToEndOfMailbox: () => Promise<void>;
}

async function world(label: string, body: (world: World) => Promise<void>) {
  const directory = mkdtempSync(join(suite, `${label}-`));
  const bob = join(directory, "bob"), carolDir = join(directory, "carol"), data = join(directory, "relay-data");
  const keys = new Map([[bob, randomBytes(32).toString("base64url")], [carolDir, randomBytes(32).toString("base64url")]]);
  const markers = [...keys.values()];
  const reserved = createServer(); const relayPort = await listen(reserved); await close(reserved);
  const relayUrl = `http://127.0.0.1:${relayPort}`;
  const relay = spawn(binary, [], {
    cwd: project,
    env: {
      ...process.env, ECHOLET_HTTP_ADDR: `127.0.0.1:${relayPort}`, ECHOLET_DATA_DIR: data,
      // Declared deviation: the per-IP limiter must not confound a count-of-pages measurement.
      ECHOLET_RATE_LIMIT_PER_MINUTE: "1000000",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let relayLog = "";
  relay.stdout.on("data", (chunk: Buffer) => { relayLog += chunk.toString(); });
  relay.stderr.on("data", (chunk: Buffer) => { relayLog += chunk.toString(); });
  const { counters, server: proxy, holdPollAfter } = counterProxy(relayUrl);
  let listening = false;
  try {
    await relayReady(relayUrl, relay);
    const proxyPort = await listen(proxy); listening = true;
    const proxyUrl = `http://127.0.0.1:${proxyPort}`;

    async function runRaw(profile: string, args: string[], timeoutMs = 60000) {
      return command(process.execPath, [cli, ...args, "--profile", profile, "--json"], { ECHOLET_E2E_KEY: keys.get(profile)! }, timeoutMs);
    }
    async function run(profile: string, args: string[], expected: number | null = 0, timeoutMs = 60000) {
      const result = await runRaw(profile, args, timeoutMs);
      const value = JSON.parse(result.stdout) as { ok: boolean; error?: { code: string } };
      const errorCode = /^[A-Z_]+$/.test(value.error?.code ?? "") ? value.error!.code : "none";
      if (expected !== null) expect(result.code, `CLI ${args[0]} exit (${errorCode})`).toBe(expected);
      // Store keys must never reach a diagnostic, a stream or the relay's own log.
      for (const marker of markers) { expect(result.stdout.includes(marker)).toBe(false); expect(result.stderr.includes(marker)).toBe(false); }
      return { code: result.code, errorCode };
    }

    for (const profile of [bob, carolDir]) await run(profile, ["init", "--relay-url", proxyUrl, "--store-key-env", "ECHOLET_E2E_KEY"]);
    const bobCard = join(directory, "bob-card.json"), carolCard = join(directory, "carol-card.json");
    await run(bob, ["contact", "export", "--out", bobCard]);
    await run(carolDir, ["contact", "export", "--out", carolCard]);
    // Carol trusts Bob and publishes, exactly as a real peer does. The ONLY thing missing is Bob's
    // import of Carol's card — the condition the design's R-5 recovery path is about.
    await run(carolDir, ["contact", "import", "--from", bobCard, "--yes"]);
    await run(bob, ["relay", "publish"]); await run(carolDir, ["relay", "publish"]);
    const record = (path: string) => (JSON.parse(readFileSync(path, "utf8")) as { signal_bundle: { device_record: { identity_id: string; device_id: string } } }).signal_bundle.device_record;
    const bobRecord = record(bobCard), carolRecord = record(carolCard);

    async function historyLength(profile: string, identity: string) {
      const result = await command(process.execPath, [cli, "history", "--with", identity, "--profile", profile, "--json"], { ECHOLET_E2E_KEY: keys.get(profile)! }, 60000);
      expect(result.code).toBe(0);
      return ((JSON.parse(result.stdout) as { data: { entries: unknown[] } }).data.entries).length;
    }

    /** One `poll` in a fresh process, whatever it exits. Exit 3 is the expected outcome of a page walk that judged only poison. */
    async function pollOnce(timeoutMs = 180000) {
      return (await run(bob, ["poll"], null, timeoutMs)).code ?? -1;
    }

    /**
     * Walks Bob's mailbox to its END, so the relay-held mark is genuinely past Carol's envelope.
     *
     * "Reached the end" is distinguished from "ran out of patience" the same way `flood-closure`
     * does it: by a poll that walked fewer pages than the client's own `maxPollPagesPerPoll = 16`
     * valve allows.
     */
    async function driveToEndOfMailbox() {
      for (let attempt = 0; attempt < 6; attempt += 1) {
        const marker = counters.pages.length;
        await run(bob, ["poll"], null, 180000);
        if (counters.pages.length - marker < 16) return;
      }
      throw new Error("the pre-import drive never reached the end of the mailbox");
    }

    /**
     * Starts `poll` and delivers `signal` while the CLI is blocked on its `page`-th poll request.
     *
     * The hold is what makes this deterministic: the process is provably past `takeMailboxRewalk`
     * (it has already asked for `page - 1` pages) and provably has not returned from the page loop
     * (it is waiting on a response this proxy is holding), so the signal lands inside the window
     * where the durable re-walk position exists nowhere.
     */
    async function interruptPollAtPage(page: number, signal: NodeJS.Signals, timeoutMs = 180000): Promise<Interruption> {
      const gate = holdPollAfter(page, timeoutMs);
      const start = counters.polls, pagesStart = counters.pages.length;
      const child = spawn(process.execPath, [cli, "poll", "--profile", bob, "--json"], {
        cwd: project, env: { ...process.env, ECHOLET_E2E_KEY: keys.get(bob)! }, stdio: ["ignore", "ignore", "ignore"],
      });
      const settled = new Promise<void>((done) => { child.once("close", () => done()); });
      try {
        await gate.reached;
        child.kill(signal);
        await settled;
      } finally { gate.release(); }
      return {
        requests: counters.polls - start,
        receivedPages: counters.pages.slice(pagesStart).filter((page) => page.length > 0),
        signalCode: child.signalCode,
      };
    }

    await body({
      bob,
      bobIdentity: bobRecord.identity_id,
      bobRecipient: { identityId: bobRecord.identity_id, deviceId: bobRecord.device_id, mailboxId: deriveMailboxId(bobRecord.identity_id) },
      relayUrl, counters, run, historyLength, pollOnce, interruptPollAtPage, driveToEndOfMailbox,
      carol: {
        identityId: carolRecord.identity_id,
        cardPath: carolCard,
        send: async (text: string) => { await run(carolDir, ["send", "--to", bobRecord.identity_id, "--text", text], 0, 60000); },
      },
    });
    for (const marker of markers) expect(relayLog.includes(marker)).toBe(false);
  } finally {
    if (listening) await close(proxy);
    await stop(relay);
  }
}

// ---------------------------------------------------------------------------
// The shared construction
// ---------------------------------------------------------------------------

/**
 * The mailbox every test below builds, and why each number is what it is.
 *
 * `ahead` poison, then Carol's real message, then `behind` poison, all at minimum ciphertext size so
 * the page boundary is the client's configured `poll_batch_size` of 50 rather than the relay's byte
 * budget — which is what keeps the arithmetic below true whatever the ciphertext size regime is.
 *
 *   ahead = 200   four full pages of poison in front of the message, so an interruption can be
 *                 placed strictly between the start of the walk and the message.
 *   behind = 110  more than two full pages after it. The final page of a walk is never marked
 *                 (`inbound.ts` reports page k's position on page k+1's request, and the last page
 *                 has no k+1), so a message sitting in it would be recovered for a reason that has
 *                 nothing to do with the re-walk. Anything above one full page — 50 — removes that;
 *                 110 leaves margin.
 *
 * 311 envelopes at 50 per page is 7 pages, comfortably inside the 16-page valve, so the pre-import
 * drive reaches the end of the mailbox in a single poll and the mark ends at position 300 — past
 * Carol's envelope at 201.
 */
const AHEAD = 200, BEHIND = 110, BEHIND_OFFSET = 100000;

/** Builds the mailbox, drives the mark past Carol's envelope, and imports her card. */
async function primeLateImport(w: World) {
  const aheadCost = await flood(w.relayUrl, w.bobRecipient, AHEAD, 4, 0);
  expect(aheadCost.stored, `all ${String(AHEAD)} poison envelopes ahead of the message must be stored`).toBe(AHEAD);

  const text = `E2E_REWALK_CRASH_${randomUUID()}`;
  await w.carol.send(text);

  // A disjoint envelope-id range: `mailbox_repo.go` keys an envelope on (mailbox_id, envelope_id),
  // so two floods into the same mailbox must not reuse an index.
  const behindCost = await flood(w.relayUrl, w.bobRecipient, BEHIND, 4, BEHIND_OFFSET);
  expect(behindCost.stored).toBe(BEHIND);

  await w.driveToEndOfMailbox();
  expect(await w.historyLength(w.bob, w.carol.identityId), "the message must not be delivered before the card is imported").toBe(0);

  // The supported recovery path: the operator imports the card the message was waiting for.
  await w.run(w.bob, ["contact", "import", "--from", w.carol.cardPath, "--yes"]);
  return { identities: aheadCost.identities + behindCost.identities, envelopes: aheadCost.stored + behindCost.stored, requests: aheadCost.requests + behindCost.requests };
}

/** Polls in fresh processes until the message arrives, or `attempts` are spent. */
async function pollUntilDelivered(w: World, attempts: number) {
  const codes: number[] = [];
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    codes.push(await w.pollOnce());
    if (await w.historyLength(w.bob, w.carol.identityId) > 0) break;
  }
  return codes;
}

// ===========================================================================
// 1 / 2 — an interrupted re-walk must not lose the message
// ===========================================================================

const interruptions = [
  { signal: "SIGINT" as const, why: "the operator's own Ctrl-C, which inbound.ts:100 names as a NORMAL interruption durable progress must survive" },
  { signal: "SIGKILL" as const, why: "an unconditional kill — a supervisor restart, an OOM kill, a crash" },
];

it.each(interruptions)("a $signal during the contact-import re-walk does not lose the message", async ({ signal, why }) => {
  await world(`rewalk-${signal.toLowerCase()}`, async (w) => {
    const attacker = await primeLateImport(w);

    // Interrupt the recovery poll while it is blocked on its THIRD page: two pages of poison have
    // been fully judged, the message (page 5) has not been reached, and the walk cannot have
    // returned. The re-walk position exists in no durable place at this instant.
    const interrupted = await w.interruptPollAtPage(3, signal);
    expect(interrupted.signalCode, `the recovery poll must have been terminated by ${signal}, or this test proved nothing`).toBe(signal);
    expect(interrupted.requests, "the interrupted poll must have been held on its third page").toBe(3);
    expect(interrupted.receivedPages.length, "it must have received and judged the two pages before the one it died waiting on").toBe(2);
    expect(poisonIndexOf(interrupted.receivedPages[0]![0]!), "the recovery poll must have re-walked from the head of the mailbox, which is what `contact import` asked for").toBe(0);
    expect(await w.historyLength(w.bob, w.carol.identityId), "the interrupted poll must NOT have reached the message yet — otherwise the interruption was placed after the recovery, not inside it").toBe(0);

    const codes = await pollUntilDelivered(w, 6);

    expect(
      await w.historyLength(w.bob, w.carol.identityId),
      `after ${String(attacker.identities)} self-published identities placed ${String(attacker.envelopes)} poison envelopes (${String(attacker.requests)} requests, paid once) ` +
        `and the operator ran \`contact import\`, a recovery poll interrupted by ${signal} on its third page left the message UNDELIVERED across ${String(codes.length)} further polls (exit codes ${JSON.stringify(codes)}). ` +
        `${signal} here is ${why}. ` +
        "`Profile.takeMailboxRewalk()` (profile.ts:174) deletes `cli:mailbox-rewalk` BEFORE the walk begins and `keepMailboxRewalk()` writes it back only after the page loop returns or from the catch around it (inbound.ts:145-194), " +
        "so the whole walk is a window in which the position exists nowhere durable. A process that ends inside it drops the recovery silently and permanently: the relay-held mark is already past the envelope, every later poll is cursorless and resumes after it, " +
        "and nothing tells the operator that the import they performed was consumed for nothing (finding T10R3-F-001). " +
        "The position must survive the interruption — written per fully judged page, as `read_through` already is, or flushed some other way — WITHOUT surviving a walk that completes (see the guard below, finding T6-F-004). " +
        "The operator must not have to guess that a second `contact import` is needed",
    ).toBe(1);
  });
}, 900000);

// ===========================================================================
// 3 — the position moves strictly forward, never back to the head
// ===========================================================================

it("carries the re-walk position strictly forward across interrupt-and-resume, never rewinding to the head", async () => {
  await world("rewalk-monotone", async (w) => {
    await primeLateImport(w);

    // The assertion is on the ENVELOPES the resuming walk is offered, never on the mechanism that
    // gets it there. A durable local position and a relay-held re-walk floor both satisfy it; what
    // neither may do is restart at the head, and what neither may do is jump past ground the
    // interrupted walk had not judged — the latter is how the message is lost today, and the former
    // is how a careless fix would loop forever without progressing.
    const interrupted = await w.interruptPollAtPage(3, "SIGINT");
    expect(interrupted.signalCode).toBe("SIGINT");
    expect(interrupted.receivedPages.length, "the interrupted walk must have fully judged the two pages before the one it died waiting on").toBe(2);

    const judged = interrupted.receivedPages.flat().map(poisonIndexOf);
    expect(Math.min(...judged), "the interrupted re-walk must have started at the head of the mailbox").toBe(0);
    const lastJudged = Math.max(...judged);

    /** The first non-empty page one fresh `poll` process was offered. */
    const nextWalkStartsAt = async () => {
      const mark = w.counters.pages.length;
      await w.pollOnce();
      const first = w.counters.pages.slice(mark).find((page) => page.length > 0);
      expect(first, "the resuming poll must have been served at least one page").toBeDefined();
      return poisonIndexOf(first![0]!);
    };

    const resumed = await nextWalkStartsAt();
    expect(
      resumed,
      `the poll that followed a re-walk interrupted after two fully judged pages was offered envelope ${String(resumed)} first. ` +
        "It must be strictly greater than 0: a re-walk that restarts at the head after every interruption never progresses, which is precisely why `cli:mailbox-rewalk` holds a POSITION and not a flag (finding T10-F-001)",
    ).toBeGreaterThan(0);
    expect(
      resumed,
      `the poll that followed a re-walk interrupted mid-flight was offered envelope ${String(resumed)} first, but that re-walk had only judged as far as envelope ${String(lastJudged)}. ` +
        "It skipped everything in between — including the envelope the `contact import` was performed for. The re-walk is UNFINISHED and must resume where it stopped; instead the position was deleted before the walk began (`takeMailboxRewalk`, profile.ts:174) and never written back, " +
        "so the next poll falls through to the relay-held mark, which is already past the message (finding T10R3-F-001). " +
        "Resuming must move the position strictly FORWARD and no further than the ground the walk genuinely covered — advancing past unjudged envelopes is the R-4 hazard the durable mark exists to avoid (design section 4)",
    ).toBeLessThanOrEqual(lastJudged + 1);

    const next = await nextWalkStartsAt();
    expect(
      next,
      `a further poll was offered envelope ${String(next)} first, after the previous one resumed at ${String(resumed)}: the position must never move backwards`,
    ).toBeGreaterThanOrEqual(resumed);
  });
}, 900000);

// ===========================================================================
// 4 — GUARD: a re-walk that COMPLETES is not repeated (finding T6-F-004)
// ===========================================================================

/**
 * This test passes on the current tree, and that is the point.
 *
 * The delete-before-the-walk shape the tests above are RED against was chosen to make exactly this
 * property true: a re-walk position that outlived its own successful walk would restart every
 * subsequent poll at the same place and reinstate the whole flooding class, while every unit test
 * still passed. So the crash-safety fix must not be "never clear the position": this guard fails if
 * it is, and it must stay green.
 */
it("does not repeat a re-walk that completed: later polls resume from the durable mark, not the re-walk's origin", async () => {
  await world("rewalk-completes-once", async (w) => {
    await primeLateImport(w);

    // Drive the re-walk to completion, uninterrupted. It delivers the message on the page it reaches
    // it, then the next polls carry it to the end of the mailbox, at which point it is spent.
    const codes = await pollUntilDelivered(w, 6);
    expect(codes[codes.length - 1], `the uninterrupted re-walk must deliver the message; poll exit codes ${JSON.stringify(codes)}`).toBeDefined();
    expect(await w.historyLength(w.bob, w.carol.identityId), "the uninterrupted re-walk must deliver the message the import was performed for").toBe(1);
    for (let attempt = 0; attempt < 3; attempt += 1) await w.pollOnce();

    // Now measure. Every poll from here on is an ordinary poll of a mailbox whose head is still full
    // of poison the recipient has already judged.
    const measuredFrom = w.counters.pages.length;
    for (let attempt = 0; attempt < 3; attempt += 1) await w.pollOnce();
    const measured = w.counters.pages.slice(measuredFrom);

    const restarted = measured.filter((page) => page.some((id) => poisonIndexOf(id) === 0));
    expect(
      restarted.length,
      `${String(restarted.length)} of the ${String(measured.length)} pages served after the re-walk completed began again at poison index 0. ` +
        "A re-walk position that survives its own SUCCESSFUL walk makes every later poll restart at the re-walk's origin, which reinstates the entire mailbox-flooding class this flow exists to close while every unit test still passes (finding T6-F-004). " +
        "Making the re-walk crash-safe must not be done by never clearing it: it must be cleared exactly when the walk reaches the end of the mailbox, and only then",
    ).toBe(0);
    expect(
      measured.length,
      `three ordinary polls after a completed re-walk cost ${String(measured.length)} pages against a mailbox of ${String(AHEAD + BEHIND + 1)} envelopes (7 pages of real work). ` +
        "They must be O(1): the recipient has already judged this mailbox and the relay holds its read position",
    ).toBeLessThanOrEqual(6);
    expect(await w.historyLength(w.bob, w.carol.identityId), "exactly one message must be in history: nothing duplicated, nothing lost").toBe(1);
  });
}, 900000);
