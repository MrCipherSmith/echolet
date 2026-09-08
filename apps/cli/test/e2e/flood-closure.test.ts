import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { deriveMailboxId, generateIdentityKeyPair, signUtf8Message } from "@echolet/crypto-core";
import { CLI_CHILD_TIMEOUT_MS } from "../childProcessTimeouts";

/**
 * RED suite for flow 002 / T5 — closing the mailbox-flooding class against the REAL relay binary.
 *
 * Why this suite exists at all, and why it may never be replaced by fixtures
 * -------------------------------------------------------------------------
 * Finding T47-TP-001 caught a fixture-only proof: a mocked `RelayClient` that modelled a relay
 * resuming at the undelivered set turned a client-only change green while the real binary stayed
 * wedged. The T5 design therefore states the governing rule for this wave literally:
 *
 *     No test in this wave may assert closure through a mocked `RelayClient`. Client-side unit
 *     tests may pin walk logic; the closure claim rests only on the real-binary suite.
 *
 * Every assertion below therefore runs against `apps/relay/cmd/relay` built from this tree and the
 * real `apps/cli/dist/cli.js` (built once by `test/globalSetup.ts`; no suite may rebuild it), with
 * a counting loopback proxy between them. The attacker is a genuine ed25519 identity, self-published
 * through the unauthenticated `POST /v1/device-records/publish` for the cost of one request
 * (T52-F-001, still open), and every poison envelope carries a signature that verifies against that
 * record — exactly what T48/T52/T55 measured.
 *
 * What is pinned, mapped to the design's RED strategy (t5-flood-closure-design.md §8)
 * ----------------------------------------------------------------------------------
 *   RED-1  order is the relay's, not the sender's (finding T5-F-001)
 *   RED-2  closure at the T55-measured cost: 4 self-published identities + 49 max-size poison
 *   RED-3  closure at 50 identities / 800 poison, and at a volume no constant page cap can cover
 *   RED-4  monotone durable progress across an INTERRUPTED poll — the property no fixture can fake,
 *          because it is an assertion about relay state surviving a process kill
 *   RED-5  every flood assertion carries BYTES and REQUEST COUNTS beside the exit code, so an
 *          implementation that "delivers by re-downloading everything forever" fails on the
 *          counters instead of passing on the boolean (design §4, R-1)
 *   RED-6  the late-`contact import` recovery path (design §4, R-5), at a flood DEEPER than the
 *          client's own page valve — the shape T10-F-001 measured, where the recovery path the
 *          design added is itself truncated and the message is lost permanently
 *   RED-7  the read position must not answer a question about the mailbox before the asker is
 *          authenticated (T10-F-002)
 *
 * Leak discipline
 * ---------------
 * The proxy never retains a request or response body: it reads each body, extracts only envelope
 * identifiers, counters and booleans, and discards the bytes. No plaintext, ciphertext, store key,
 * signing seed or HTTP body is printed by any assertion or diagnostic in this file. Poison
 * ciphertext is inert synthetic padding.
 *
 * Declared configuration deviation
 * --------------------------------
 * `ECHOLET_RATE_LIMIT_PER_MINUTE` is raised so the per-IP limiter does not confound a
 * count-of-envelopes measurement. This is the same single deviation T49 / T52 / T55 declared. The
 * cost at the shipped default of 120/min is arithmetic the design already states (§2: 60 pages and
 * 180 max-size envelopes per minute) and is deliberately NOT re-measured here.
 */

const project = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const suite = mkdtempSync(join(tmpdir(), "echolet-flood-closure-e2e-"));
const binary = join(suite, "relay"), cli = join(project, "apps/cli/dist/cli.js");

interface Result { code: number | null; stdout: string; stderr: string }
function command(executable: string, args: string[], env: Record<string, string> = {}, timeoutMs = CLI_CHILD_TIMEOUT_MS): Promise<Result> {
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
  expect(existsSync(cli)).toBe(true);
  expect((await command("go", ["-C", "apps/relay", "build", "-o", binary, "./cmd/relay"], { GOCACHE: join(project, ".gocache") }, 180000)).code).toBe(0);
}, 240000);
afterAll(() => rmSync(suite, { recursive: true, force: true }));

// ---------------------------------------------------------------------------
// The attacker, minted exactly the way T52 showed one is minted
// ---------------------------------------------------------------------------

/**
 * A self-published sender identity. `POST /v1/device-records/publish` is unauthenticated
 * (T52-F-001), so this costs one HTTP request and no credential of any kind.
 *
 * The record is assembled with every key already in sorted order, at every level, so
 * `JSON.stringify` reproduces byte for byte what the relay's own recursive canonical encoder
 * (`cryptoutil.MarshalCanonicalJSONWithoutSignature`) produces. The transcript is therefore pinned
 * by this test rather than borrowed from the implementation, which is the same rule
 * `two-process.test.ts` follows for the sender transcript.
 */
interface Attacker { identityId: string; deviceId: string; deviceSecretKey: string }

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

/**
 * A head-sorting envelope id.
 *
 * `mailbox_repo.go:429` keys every stored envelope on "mailbox:<mailbox_id>:<envelope_id>" and every
 * selection is a Badger prefix scan in byte order, so the SENDER chooses its place in the victim's
 * queue. `validation/validate.go:134` admits `00000000-0000-1000-8000-…`, and the T5 probe found
 * 0 of 200 000 random v4 UUIDs sorting below that prefix. The index is recoverable from the id,
 * which is what lets the assertions below talk about positions instead of opaque strings.
 */
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
 * identities as the per-sender quota (T54, 16) forces. Attacker traffic deliberately bypasses the
 * counting proxy so the recipient's measured cost is the RECIPIENT's alone.
 *
 * `concurrency` only shortens the harness's own wall clock; it never changes what is stored. It
 * stays 1 wherever an assertion talks about the ORDER the relay assigns, because with a
 * server-assigned sequence, concurrent stores are ordered by arrival rather than by index.
 *
 * `indexOffset` shifts the envelope_id range this call mints. `mailbox_repo.go:429` keys an envelope
 * on `(mailbox_id, envelope_id)`, so two floods into the SAME mailbox must not reuse an index or the
 * second store addresses the first store's key. A test that places poison both AHEAD OF and BEHIND a
 * legitimate envelope therefore calls this twice with disjoint ranges.
 *
 * Returns the attacker's own cost, which is the number AC2 asks to be stated.
 */
async function flood(relayUrl: string, recipient: Recipient, poison: number, ciphertextBytes: number, concurrency = 1, indexOffset = 0) {
  const perIdentity = 16;
  const identities: Attacker[] = [];
  for (let placed = 0; placed < poison; placed += perIdentity) identities.push(await publishAttacker(relayUrl));
  const work = Array.from({ length: poison }, (_, index) => ({ attacker: identities[Math.floor(index / perIdentity)]!, index: index + indexOffset }));
  let stored = 0, refused = 0, uploadedBytes = 0, next = 0;
  const worker = async () => {
    for (;;) {
      const item = work[next]; if (!item) return; next += 1;
      const envelope = poisonEnvelope(item.attacker, recipient, item.index, ciphertextBytes);
      uploadedBytes += Buffer.byteLength(JSON.stringify({ envelope }));
      (await postEnvelope(relayUrl, envelope)) === 200 ? (stored += 1) : (refused += 1);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));
  return { identities: identities.length, stored, refused, uploadedBytes, requests: identities.length + poison };
}

// ---------------------------------------------------------------------------
// The counting proxy: bytes and requests, never bodies
// ---------------------------------------------------------------------------

interface Counters {
  requests: number; polls: number; acks: number; challenges: number;
  upBytes: number; downBytes: number;
  /** Envelope ids of every poll page, in order. Ids only: no body is ever retained. */
  pages: string[][];
  /** Whether each poll request carried an explicit `cursor`. */
  cursored: boolean[];
  /**
   * The `cursor` each poll request carried, verbatim, and `null` when it carried none.
   *
   * The boolean above answers "was this walk resumed from a client-held position"; this answers
   * "WHICH position", which is the only way to ask whether a presented position is one the relay
   * ever issued to this client for a page it actually received. A token is an opaque server-issued
   * value here: it is only ever compared for EQUALITY against the `next_cursor` values recorded
   * below, never parsed, ordered or arithmetically related to anything.
   */
  pollCursors: Array<string | null>;
  /** The `next_cursor` each poll response reported: a token when the page was cut short, `null` at the end of the mailbox. */
  pollNextCursors: Array<string | null>;
  /** Whether each ack request carried a `read_through`, and its value when it did. */
  ackReadThrough: Array<string | null>;
  ackedIds: string[];
  statuses: number[];
}

function counterProxy(relayUrl: string) {
  const counters: Counters = {
    requests: 0, polls: 0, acks: 0, challenges: 0, upBytes: 0, downBytes: 0,
    pages: [], cursored: [], pollCursors: [], pollNextCursors: [], ackReadThrough: [], ackedIds: [], statuses: [],
  };
  const server = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const requestBody = Buffer.concat(chunks), path = request.url!;
      const upstream = await fetch(relayUrl + path, {
        method: request.method, headers: { "content-type": "application/json" },
        body: request.method === "GET" ? undefined : requestBody, signal: AbortSignal.timeout(60000),
      });
      const bytes = Buffer.from(await upstream.arrayBuffer());
      counters.requests += 1;
      counters.upBytes += requestBody.length;
      counters.downBytes += bytes.length;
      counters.statuses.push(upstream.status);
      // Only identifiers, flags and lengths are extracted. The bodies themselves are never stored,
      // never logged and never rendered in a failure message.
      if (path === "/v1/mailbox/challenge") counters.challenges += 1;
      if (path === "/v1/mailbox/poll") {
        counters.polls += 1;
        let cursor: string | null = null;
        try {
          const requested = (JSON.parse(requestBody.toString("utf8")) as { cursor?: unknown }).cursor;
          cursor = typeof requested === "string" ? requested : null;
        } catch { /* bounded */ }
        counters.cursored.push(cursor !== null);
        counters.pollCursors.push(cursor);
        let ids: string[] = [];
        let nextCursor: string | null = null;
        try {
          const parsed = JSON.parse(bytes.toString("utf8")) as { data?: { envelopes?: Array<{ envelope_id?: unknown }>; next_cursor?: unknown } };
          ids = (parsed.data?.envelopes ?? []).map((entry) => typeof entry.envelope_id === "string" ? entry.envelope_id : "");
          nextCursor = typeof parsed.data?.next_cursor === "string" ? parsed.data.next_cursor : null;
        } catch { /* a non-success poll response contributes an empty page */ }
        counters.pages.push(ids);
        counters.pollNextCursors.push(nextCursor);
      }
      if (path === "/v1/mailbox/ack") {
        counters.acks += 1;
        try {
          const parsed = JSON.parse(requestBody.toString("utf8")) as { envelope_ids?: unknown; read_through?: unknown };
          counters.ackReadThrough.push(parsed.read_through === undefined || parsed.read_through === null ? null : String(parsed.read_through));
          if (Array.isArray(parsed.envelope_ids)) for (const id of parsed.envelope_ids) if (typeof id === "string") counters.ackedIds.push(id);
        } catch { counters.ackReadThrough.push(null); }
      }
      response.writeHead(upstream.status, { "content-type": "application/json" });
      response.end(bytes);
    })().catch(() => { response.statusCode = 502; response.end("{}"); });
  });
  return { counters, server };
}

const snapshotCounters = (counters: Counters) => ({
  requests: counters.requests, polls: counters.polls, acks: counters.acks,
  upBytes: counters.upBytes, downBytes: counters.downBytes, pages: counters.pages.length,
});
type Snapshot = ReturnType<typeof snapshotCounters>;
const since = (before: Snapshot, after: Snapshot): Snapshot => ({
  requests: after.requests - before.requests, polls: after.polls - before.polls,
  acks: after.acks - before.acks, upBytes: after.upBytes - before.upBytes,
  downBytes: after.downBytes - before.downBytes, pages: after.pages - before.pages,
});

// ---------------------------------------------------------------------------
// One relay + proxy + two real CLI profiles
// ---------------------------------------------------------------------------

interface World {
  alice: string; bob: string; aliceIdentity: string; bobIdentity: string;
  bobRecipient: Recipient; relayUrl: string; proxyUrl: string; counters: Counters; markers: string[];
  run: (profile: string, args: string[], expected?: number | null, timeoutMs?: number) => Promise<{ code: number | null; errorCode: string; data: Record<string, unknown> }>;
  historyLength: (profile: string, identity: string) => Promise<number>;
  poll: (profile: string, maxPolls: number, timeoutMs?: number) => Promise<number[]>;
  killPollAfterPages: (profile: string, pages: number, timeoutMs?: number) => Promise<void>;
}

async function world(label: string, body: (world: World) => Promise<void>) {
  const directory = mkdtempSync(join(suite, `${label}-`));
  const alice = join(directory, "alice"), bob = join(directory, "bob"), data = join(directory, "relay-data");
  const keys = new Map([[alice, randomBytes(32).toString("base64url")], [bob, randomBytes(32).toString("base64url")]]);
  const markers = [...keys.values()];
  const reserved = createServer(); const relayPort = await listen(reserved); await close(reserved);
  const relayUrl = `http://127.0.0.1:${relayPort}`;
  const relay = spawn(binary, [], {
    cwd: project,
    env: {
      ...process.env, ECHOLET_HTTP_ADDR: `127.0.0.1:${relayPort}`, ECHOLET_DATA_DIR: data,
      // Declared deviation: the per-IP limiter must not confound a count-of-envelopes measurement.
      ECHOLET_RATE_LIMIT_PER_MINUTE: "1000000",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let relayLog = "";
  relay.stdout.on("data", (chunk: Buffer) => { relayLog += chunk.toString(); });
  relay.stderr.on("data", (chunk: Buffer) => { relayLog += chunk.toString(); });
  const { counters, server: proxy } = counterProxy(relayUrl);
  let listening = false;
  try {
    await relayReady(relayUrl, relay);
    const proxyPort = await listen(proxy); listening = true;
    const proxyUrl = `http://127.0.0.1:${proxyPort}`;

    async function runRaw(profile: string, args: string[], timeoutMs = CLI_CHILD_TIMEOUT_MS) {
      return command(process.execPath, [cli, ...args, "--profile", profile, "--json"], { ECHOLET_E2E_KEY: keys.get(profile)! }, timeoutMs);
    }
    async function run(profile: string, args: string[], expected: number | null = 0, timeoutMs = CLI_CHILD_TIMEOUT_MS) {
      const result = await runRaw(profile, args, timeoutMs);
      const value = JSON.parse(result.stdout) as { ok: boolean; data?: Record<string, unknown>; error?: { code: string } };
      const errorCode = /^[A-Z_]+$/.test(value.error?.code ?? "") ? value.error!.code : "none";
      if (expected !== null) expect(result.code, `CLI ${args[0]} exit (${errorCode})`).toBe(expected);
      // Store keys must never reach a diagnostic, a stream or the relay's own log.
      for (const marker of markers) { expect(result.stdout.includes(marker)).toBe(false); expect(result.stderr.includes(marker)).toBe(false); }
      return { code: result.code, errorCode, data: value.data ?? {} };
    }
    for (const profile of [alice, bob]) await run(profile, ["init", "--relay-url", proxyUrl, "--store-key-env", "ECHOLET_E2E_KEY"]);
    const aliceCard = join(directory, "alice-card.json"), bobCard = join(directory, "bob-card.json");
    await run(alice, ["contact", "export", "--out", aliceCard]); await run(bob, ["contact", "export", "--out", bobCard]);
    const record = (path: string) => (JSON.parse(readFileSync(path, "utf8")) as { signal_bundle: { device_record: { identity_id: string; device_id: string } } }).signal_bundle.device_record;
    const aliceRecord = record(aliceCard), bobRecord = record(bobCard);
    await run(alice, ["contact", "import", "--from", bobCard, "--yes"]);
    await run(bob, ["contact", "import", "--from", aliceCard, "--yes"]);
    await run(alice, ["relay", "publish"]); await run(bob, ["relay", "publish"]);

    async function historyLength(profile: string, identity: string) {
      const result = await command(process.execPath, [cli, "history", "--with", identity, "--profile", profile, "--json"], { ECHOLET_E2E_KEY: keys.get(profile)! });
      expect(result.code).toBe(0);
      return ((JSON.parse(result.stdout) as { data: { entries: unknown[] } }).data.entries).length;
    }

    /**
     * Drives `poll` as an operator with a flooded mailbox would: repeatedly, in fresh processes.
     *
     * Exit 3 is the expected INTERMEDIATE outcome of a page walk that judged only poison — F-012
     * requires the typed rejection to be re-raised and nothing acknowledged. Exit 0 is delivery.
     * Any other exit (4 RELAY_UNAVAILABLE, 5 PERSISTENCE_FAILURE) stops the drive and is reported,
     * because degrading the operator-visible failure is itself a regression the design names (§2).
     */
    async function poll(profile: string, maxPolls: number, timeoutMs = 120000) {
      const codes: number[] = [];
      for (let attempt = 0; attempt < maxPolls; attempt += 1) {
        const result = await runRaw(profile, ["poll"], timeoutMs);
        codes.push(result.code ?? -1);
        for (const marker of markers) { expect(result.stdout.includes(marker)).toBe(false); expect(result.stderr.includes(marker)).toBe(false); }
        if (result.code !== 3) break;
      }
      return codes;
    }

    /** Starts `poll` and SIGKILLs it once the relay has served `pages` poll requests. */
    async function killPollAfterPages(profile: string, pages: number, timeoutMs = 120000) {
      const target = counters.polls + pages;
      const child = spawn(process.execPath, [cli, "poll", "--profile", profile, "--json"], {
        cwd: project, env: { ...process.env, ECHOLET_E2E_KEY: keys.get(profile)! }, stdio: ["ignore", "ignore", "ignore"],
      });
      const deadline = Date.now() + timeoutMs;
      try {
        while (counters.polls < target && child.exitCode === null && child.signalCode === null && Date.now() < deadline) await delay(10);
      } finally { child.kill("SIGKILL"); }
      await new Promise<void>((done) => { child.once("close", () => done()); });
      expect(counters.polls, "the interrupted poll must have walked at least one page before it was killed").toBeGreaterThanOrEqual(target);
    }

    await body({
      alice, bob, aliceIdentity: aliceRecord.identity_id, bobIdentity: bobRecord.identity_id,
      bobRecipient: { identityId: bobRecord.identity_id, deviceId: bobRecord.device_id, mailboxId: deriveMailboxId(bobRecord.identity_id) },
      relayUrl, proxyUrl, counters, markers, run, historyLength, poll, killPollAfterPages,
    });
    for (const marker of markers) expect(relayLog.includes(marker)).toBe(false);
  } finally {
    if (listening) await close(proxy);
    await stop(relay);
  }
}

// ===========================================================================
// RED-1 — the relay chooses the order, not the sender
// ===========================================================================

it("RED-1: a self-published sender cannot buy a head position with a 00000000-… envelope_id", async () => {
  await world("red1-order", async (w) => {
    // Alice's message is stored FIRST and carries a random v4 envelope_id.
    const text = `E2E_FLOOD_ORDER_${randomUUID()}`;
    await w.run(w.alice, ["send", "--to", w.bobIdentity, "--text", text]);

    // The attacker then stores poison whose envelope_id sorts ahead of every random v4 UUID.
    // Finding T5-F-001: `validate.go:134` accepts ~10^28 such ids and the T5 probe found 0 of
    // 200 000 random v4 UUIDs below them, so today the LATER envelope is served FIRST.
    const attacker = await publishAttacker(w.relayUrl);
    for (let index = 0; index < 3; index += 1) {
      expect(await postEnvelope(w.relayUrl, poisonEnvelope(attacker, w.bobRecipient, index, 4))).toBe(200);
    }

    await w.poll(w.bob, 3);
    const firstPage = w.counters.pages.find((page) => page.length > 0);
    expect(firstPage, "the first poll page must not be empty").toBeDefined();
    expect(
      poisonIndexOf(firstPage![0]!),
      "the first envelope of the first poll page is attacker-chosen poison: selection order is keyed on the SENDER-supplied envelope_id (mailbox_repo.go:429-431), so an envelope stored LATER is served FIRST. " +
        "Selection order must be assigned by the relay in store order, so a sender cannot place itself ahead of an envelope that is already stored",
    ).toBe(-1);
  });
}, 240000);

// ===========================================================================
// RED-2 / RED-3 / RED-5 — closure at the recorded cost, at 10x and beyond any constant cap,
// measured in bytes and requests rather than asserted as a boolean
// ===========================================================================

/**
 * The three volumes the design's residual R-1 names, with the ciphertext regime each one exercises.
 *
 * `maxPolls` is `ceil(pages / 16) + 1`, where 16 is `maxPollPagesPerPoll` (inbound.ts:71) kept as a
 * LIVENESS VALVE: one `poll` still returns in bounded time, and hitting the valve costs one more
 * `poll` invocation instead of a lost message, because the recipient's read position is durable.
 * A walk that restarts at the head cannot satisfy this bound at any of the three volumes.
 */
const volumes = [
  // T55's exact measurement: "boundary_49poison { poison: 49, identities: 4, poll1_exit: 3, delivered: false, wedged: true }".
  { label: "4 identities x 49 maximum-size poison (the T55-measured wedge)", poison: 49, ciphertext: 262144, concurrency: 4, maxPolls: 4, timeoutMs: 300000 },
  // T55's count-bounded figure: 50 identities + 800 POSTs.
  { label: "50 identities x 800 minimum-size poison", poison: 800, ciphertext: 4, concurrency: 8, maxPolls: 4, timeoutMs: 420000 },
  // Design §4 R-1's extreme volume, and the case a merely larger constant page cap cannot pass:
  // 8000 envelopes at the client's configured batch of 50 is 160 pages.
  //
  // This case is deliberately expensive and it is the relay that makes it so: `SenderOccupancy`
  // scans the whole mailbox prefix on every send (mailbox_repo.go:183-209), so filling a mailbox of
  // N costs O(N^2) decodes. Measured on this tree at 8 000 poison: ~272 s of harness wall clock with
  // sequential sends, ~77 s at concurrency 8. That cost is a property of the relay under a flood,
  // not of the harness, and it is recorded here rather than hidden by shrinking the volume the
  // design asked for. It is also the single most expensive test in the `apps/cli` suite - budget for
  // it when reading a full `pnpm test` duration.
  { label: "500 identities x 8000 minimum-size poison (beyond any constant page cap)", poison: 8000, ciphertext: 4, concurrency: 8, maxPolls: 14, timeoutMs: 900000 },
] as const;

describe.each(volumes)("closure and cost at $label", ({ poison, ciphertext, concurrency, maxPolls, timeoutMs }) => {
  it("delivers the message queued behind the flood, and the SECOND delivery costs O(1)", async () => {
    await world(`flood-${String(poison)}`, async (w) => {
      const attackerCost = await flood(w.relayUrl, w.bobRecipient, poison, ciphertext, concurrency);
      expect(attackerCost.stored, `all ${String(poison)} poison envelopes must be accepted by the relay: the per-sender quota bounds one sender, not total mailbox occupancy (T55-F-001), so a flood spread across ${String(attackerCost.identities)} self-published identities still lands in full`).toBe(poison);

      const text = `E2E_FLOOD_DELIVERY_${randomUUID()}`;
      await w.run(w.alice, ["send", "--to", w.bobIdentity, "--text", text]);

      const beforeFirst = snapshotCounters(w.counters);
      const codes = await w.poll(w.bob, maxPolls, timeoutMs);
      const firstDelivery = since(beforeFirst, snapshotCounters(w.counters));

      expect(
        codes[codes.length - 1],
        `poll exit codes ${JSON.stringify(codes)} after ${String(attackerCost.identities)} self-published identities placed ${String(poison)} poison envelopes. ` +
          `The last poll must exit 0 and deliver the legitimate message. Exit 3 on every attempt is the T52-F-001 wedge, unchanged: the client's bounded walk restarts at the head of the mailbox on every poll (mailbox_repo.go:325-326, inbound.ts:105), so the recipient never accumulates progress and the message expires behind the poison`,
      ).toBe(0);
      expect(codes.length, `delivery took ${String(codes.length)} poll invocations, want at most ${String(maxPolls)}: with a durable read position the walk resumes where it stopped, so the number of polls is ceil(pages / maxPollPagesPerPoll) + 1 and not unbounded`).toBeLessThanOrEqual(maxPolls);
      expect(await w.historyLength(w.bob, w.aliceIdentity), "exactly one message must be in history: nothing duplicated, nothing lost").toBe(1);

      // RED-5 — the counters, not the boolean. The recipient pays for the flood ONCE. Anything
      // that "delivers" by re-downloading the mailbox on every poll passes the exit code above and
      // must fail here.
      const poisonBytes = attackerCost.uploadedBytes;
      expect(
        firstDelivery.downBytes,
        `the first walk downloaded ${String(firstDelivery.downBytes)} bytes over ${String(firstDelivery.polls)} poll pages against ${String(poisonBytes)} bytes of poison the attacker uploaded once. ` +
          "The amplification ratio must be about 1:1 (design §4, R-1): the recipient downloads each poison envelope once, not once per poll",
      ).toBeLessThan(poisonBytes * 2);

      // R-1's decisive measurement: the SECOND delivered message. A larger constant page cap can
      // brute-force the first delivery; nothing but durable recipient progress can make the second
      // one cheap, because the poison is still sitting at the head of the mailbox.
      const secondText = `E2E_FLOOD_SECOND_${randomUUID()}`;
      await w.run(w.alice, ["send", "--to", w.bobIdentity, "--text", secondText]);
      const beforeSecond = snapshotCounters(w.counters);
      const secondCodes = await w.poll(w.bob, maxPolls, timeoutMs);
      const secondDelivery = since(beforeSecond, snapshotCounters(w.counters));

      expect(secondCodes[secondCodes.length - 1], `second-message poll exit codes ${JSON.stringify(secondCodes)}, want a final 0`).toBe(0);
      expect(await w.historyLength(w.bob, w.aliceIdentity)).toBe(2);
      expect(
        secondDelivery.polls,
        `the second delivered message cost ${String(secondDelivery.polls)} poll pages and ${String(secondDelivery.downBytes)} bytes, against ${String(firstDelivery.polls)} pages and ${String(firstDelivery.downBytes)} bytes for the first. ` +
          "The second poll must be O(1): the recipient has already judged the poison, and a read position that survives the process is the only thing that can make this cheap. " +
          "If this is still O(N) the mark is not working and the change is a bigger constant wearing a hat (design §4, R-1)",
      ).toBeLessThanOrEqual(3);
      expect(secondDelivery.downBytes, "the second delivered message must not re-download the flood").toBeLessThan(Math.max(poisonBytes / 10, 256 * 1024));
    });
  }, timeoutMs);
});

// ===========================================================================
// RED-4 — monotone durable progress across an interrupted poll
// ===========================================================================

it("RED-4: an interrupted poll resumes after the pages it already judged, and the total walk stays O(N)", async () => {
  await world("red4-progress", async (w) => {
    const poison = 800;
    const attackerCost = await flood(w.relayUrl, w.bobRecipient, poison, 4);
    expect(attackerCost.stored).toBe(poison);
    const text = `E2E_FLOOD_RESUME_${randomUUID()}`;
    await w.run(w.alice, ["send", "--to", w.bobIdentity, "--text", text]);

    // Process 1: killed after four pages. Whatever it judged is judged; the point of the mark is
    // that a process which never returned still left the recipient further along than it started.
    const firstProcessStart = w.counters.pages.length;
    await w.killPollAfterPages(w.bob, 4, 180000);
    const firstProcessPages = w.counters.pages.slice(firstProcessStart).filter((page) => page.length > 0);
    expect(firstProcessPages.length, "the interrupted process must have received at least two pages").toBeGreaterThanOrEqual(2);
    const lastJudged = firstProcessPages[firstProcessPages.length - 2]!;
    const lastJudgedIndex = poisonIndexOf(lastJudged[0]!);
    expect(lastJudgedIndex, "the interrupted walk must have been reading poison, not something else").toBeGreaterThanOrEqual(0);

    // Process 2: a brand new PID with a freshly loaded profile.
    const secondProcessStart = w.counters.pages.length;
    const codes = await w.poll(w.bob, 4, 300000);
    const secondProcessPages = w.counters.pages.slice(secondProcessStart).filter((page) => page.length > 0);
    expect(secondProcessPages.length).toBeGreaterThan(0);

    // -----------------------------------------------------------------------------------------
    // The resuming poll's POSITION — why this is stated as "the cursor may not skip" and not as
    // "there is no cursor" (finding T15-F-001, ruled on by the orchestrator before T16 was written)
    // -----------------------------------------------------------------------------------------
    // This assertion used to read `expect(w.counters.cursored[secondProcessStart]).toBe(false)` —
    // the resuming poll must present NO cursor at all. It was re-stated, deliberately and once, for
    // three reasons that are recorded here because re-stating an existing assertion is the kind of
    // edit that must never happen quietly.
    //
    // 1. It was green only BECAUSE of the defect under repair. `world()`'s setup ends with
    //    `bob contact import --from alice-card --yes`, so a re-walk from the head of the mailbox is
    //    pending in every world this file builds, RED-4's included, and the killed poll above IS
    //    that re-walk. `Profile.takeMailboxRewalk()` DELETES the durable position before
    //    the walk begins and `keepMailboxRewalk()` writes it back only after the page loop, so a
    //    process killed inside the loop leaves no re-walk to present and the next poll is
    //    necessarily cursorless. Any crash-safe re-walk — which is what T15/T16 exist to build —
    //    makes that same poll cursored. An assertion that can only hold while the bug is present
    //    protects nothing and would force the fix to be wrong.
    //
    // 2. The alternative was rejected on the merits, not on cost. Moving the re-walk floor onto the
    //    RELAY would keep the resuming poll literally cursorless, but the relay is the
    //    adversary-adjacent component and this design keeps the recipient's RECOVERY DECISION
    //    local: `contact import` is an offline trust operation that makes no relay request at all
    //    (profile.ts:150-153). Putting the recovery position on the relay hands the flooding
    //    adversary a lever on the one path that recovers from flooding, and grows exactly the
    //    protocol surface T10 has just finished measuring.
    //
    // 3. What replaces it is strictly stronger, and is about the SAFETY PROPERTY rather than the
    //    mechanism. The cursorless line stood in for one real hazard: a locally held position
    //    advancing past envelopes the recipient was never offered, which design §4 R-4 makes
    //    permanent the moment a cursorless poll resumes at the mark. So: if the resuming poll
    //    presents a position at all, it must be one the RELAY ISSUED to the killed process for a
    //    page that process actually received — never a position further on. Tokens are compared for
    //    equality only; this test never parses, orders or does arithmetic on one.
    //
    // The narrow half of the old assertion — that a poll with NO re-walk pending is still
    // cursorless, which is the F-012 / T6-F-005 property that the relay is the durable holder of an
    // ordinary walk's mark — is not weakened by this: it is pinned where it still holds, by
    // "RED-4b" immediately after this test.
    const killedProcessRequests = w.counters.pages
      .slice(firstProcessStart, secondProcessStart)
      .map((ids, offset) => ({ ids, next: w.counters.pollNextCursors[firstProcessStart + offset] ?? null }))
      .filter((request) => request.ids.length > 0);
    const positionsIssuedToTheKilledProcess = killedProcessRequests
      .map((request) => request.next)
      .filter((token): token is string => token !== null);
    // A precondition, so the membership check below can never pass vacuously against an empty set:
    // every page of an 800-envelope flood at a batch of 50 is cut short, so the relay issued the
    // killed process a continuation token for each one it served.
    expect(
      positionsIssuedToTheKilledProcess.length,
      "the relay must have issued the killed process a continuation token for each cut-short page it served",
    ).toBeGreaterThanOrEqual(2);
    const presentedCursor = w.counters.pollCursors[secondProcessStart] ?? null;
    expect(
      // `null` is the ordinary cursorless poll; "0" is the head of the mailbox, which skips nothing
      // by construction. Everything else must be a token this client was handed for ground it saw.
      [null, "0", ...positionsIssuedToTheKilledProcess],
      `the poll that resumed after the SIGKILL presented cursor ${presentedCursor === null ? "<none>" : JSON.stringify(presentedCursor)}, ` +
        `which is not the head of the mailbox and not one of the ${String(positionsIssuedToTheKilledProcess.length)} continuation tokens the relay issued to the killed process for a page it actually received. ` +
        "A resume position the client holds locally may only ever be a token the relay issued for a page this client received and judged (profile.ts `keepMailboxRewalk`); anything beyond that marks envelopes as judged that the recipient was never offered, and once a walk resumes there they are unreachable for the rest of their lifetime (design §4, R-4). " +
        "This replaced an assertion that the resuming poll carries no cursor at all, which was true only while the re-walk position was destroyed by the crash it is meant to survive",
    ).toContain(presentedCursor);

    // The same no-skip property measured in ENVELOPES rather than in tokens, so it also binds the
    // cursorless path — a relay-held mark that ran ahead of what it served would pass the token
    // check above and fail here.
    const offeredToTheKilledProcess = killedProcessRequests.flatMap((request) => request.ids).map(poisonIndexOf).filter((index) => index >= 0);
    expect(offeredToTheKilledProcess.length, "the killed process must have been served poison to have judged any").toBeGreaterThan(0);
    const lastOfferedIndex = Math.max(...offeredToTheKilledProcess);
    const resumeIndexRaw = poisonIndexOf(secondProcessPages[0]![0]!);
    expect(
      // A first envelope that is not poison at all means the resumed walk landed past every poison
      // envelope the mailbox holds, which is the largest skip available here; it is scored as such
      // rather than as the -1 `poisonIndexOf` returns for "not one of ours".
      resumeIndexRaw >= 0 ? resumeIndexRaw : poison,
      `the poll that resumed after the SIGKILL was offered envelope index ${String(resumeIndexRaw)} first, but the killed process was never served anything past index ${String(lastOfferedIndex)}. ` +
        "A resumed walk may continue after what the interrupted one was offered; it may not step over ground the recipient never saw. Envelopes skipped this way are never re-offered, because the walk resumes at the mark and the mark is now past them (design §4, R-4)",
    ).toBeLessThanOrEqual(lastOfferedIndex + 1);

    expect(
      poisonIndexOf(secondProcessPages[0]![0]!),
      `after an interrupted poll judged poison up to index ${String(lastJudgedIndex)}, the next process's first cursorless page starts at envelope ${secondProcessPages[0]![0]!.slice(-12)}. ` +
        "It must start strictly after what the previous process already judged. Restarting at index 0 is the class itself: `GetEnvelopeBatchFrom` seeks to the head of the prefix on every call (mailbox_repo.go:325-326), so recipient progress is discarded on every poll and no finite number of polls ever finishes the walk. " +
        "No fixture can fake this assertion — it is about relay state surviving a SIGKILL",
    ).toBeGreaterThanOrEqual(lastJudgedIndex);

    expect(codes[codes.length - 1], `poll exit codes ${JSON.stringify(codes)} — the resumed walk must reach the legitimate message`).toBe(0);
    expect(await w.historyLength(w.bob, w.aliceIdentity)).toBe(1);

    // O(N) across K polls, not O(N x K). At the client's configured batch of 50, 800 poison plus one
    // legitimate envelope is 17 pages; four of them were already walked by the killed process.
    const pagesWalked = w.counters.polls;
    expect(
      pagesWalked,
      `${String(pagesWalked)} poll pages were served across all polls for a mailbox of ${String(poison + 1)} envelopes at a batch size of 50 (17 pages of real work). ` +
        "Total requests across K polls must be O(N), not O(N x K): a walk that restarts at the head re-pays for the whole flood on every poll, which is the unbounded amplification the design refuses to call a closure (§2)",
    ).toBeLessThanOrEqual(34);
  });
}, 600000);

// ===========================================================================
// RED-4b — the exception is NARROW: only a pending re-walk may present a position
// ===========================================================================

/**
 * The half of RED-4's original cursorless assertion that still holds, pinned where it holds.
 *
 * RED-4 above had to stop requiring that the poll following a crash carries no cursor, because a
 * crash-safe `contact import` re-walk is exactly a position that survives the crash and is presented
 * on the next poll. That exception is the re-walk and nothing else. For an ORDINARY poll — one with
 * no re-walk pending — the rule is unchanged and is the whole of F-012 / T6-F-005: the client keeps
 * no read position of its own, the RELAY is the durable holder of the mark, and a walk that started
 * itself from a locally remembered position would be reintroducing the state that finding removed.
 *
 * It is also the cursor-shaped statement of T6-F-004, and it is why a fix for the crash-safety
 * findings cannot be "never clear the re-walk": a position that outlived its own completed walk is
 * presented here, and this case turns red.
 *
 * Deliberately cheap: no flood. The property is about which position a poll presents, not about
 * how much poison the walk had to cross, and the expensive crossings are measured elsewhere in this
 * file.
 */
it("RED-4b: a poll with no re-walk pending presents no cursor — the relay stays the durable holder of the mark", async () => {
  await world("red4b-ordinary-poll", async (w) => {
    // `world()` ends with `bob contact import`, so the FIRST poll below is a re-walk. It is allowed
    // to present a position; that is R-5's recovery path and RED-4 covers it.
    const first = `E2E_FLOOD_ORDINARY_FIRST_${randomUUID()}`;
    await w.run(w.alice, ["send", "--to", w.bobIdentity, "--text", first]);
    const rewalkStart = w.counters.pages.length;
    const rewalkCodes = await w.poll(w.bob, 3, 120000);
    expect(rewalkCodes[rewalkCodes.length - 1], `re-walk poll exit codes ${JSON.stringify(rewalkCodes)}, want a final 0`).toBe(0);
    expect(await w.historyLength(w.bob, w.aliceIdentity)).toBe(1);

    // The re-walk reached the END of the mailbox: the last page the relay served reported no
    // continuation, which is the condition under which there is nothing left to re-walk
    // (inbound.ts:180 — a re-walk ENDS the moment the relay reports no more pages). Whatever the
    // implementation does with the position, from here on this profile's polls are ordinary ones.
    const rewalkNextCursors = w.counters.pollNextCursors.slice(rewalkStart);
    expect(rewalkNextCursors.length, "the re-walk must have made at least one poll request").toBeGreaterThan(0);
    expect(
      rewalkNextCursors[rewalkNextCursors.length - 1],
      `the last page of the import re-walk reported next_cursor ${JSON.stringify(rewalkNextCursors[rewalkNextCursors.length - 1])}, so the walk had not reached the end of the mailbox and this case cannot say what follows it. ` +
        "This is a precondition of the assertion below, not the assertion itself",
    ).toBeNull();

    const second = `E2E_FLOOD_ORDINARY_SECOND_${randomUUID()}`;
    await w.run(w.alice, ["send", "--to", w.bobIdentity, "--text", second]);
    const ordinaryStart = w.counters.pages.length;
    const ordinaryCodes = await w.poll(w.bob, 3, 120000);
    expect(ordinaryCodes[ordinaryCodes.length - 1], `ordinary poll exit codes ${JSON.stringify(ordinaryCodes)}, want a final 0`).toBe(0);
    expect(await w.historyLength(w.bob, w.aliceIdentity)).toBe(2);

    expect(
      w.counters.pollCursors[ordinaryStart] ?? null,
      `a poll made after the import re-walk had run to the end of the mailbox presented cursor ${JSON.stringify(w.counters.pollCursors[ordinaryStart] ?? null)}. ` +
        "An ordinary walk must present NO cursor: `inbound.ts:105` starts it with none and the RELAY resumes the recipient at its stored read position, which is what makes progress survive a process that never returned (finding T6-F-005) and what keeps an ordinary poll from writing to the store at all (F-012). " +
        "A client that presents a position here is either holding a read mark of its own or has kept a re-walk that outlived its own completed walk — and a re-walk that outlives its walk restarts every later poll at the same place and reinstates the whole flooding class (finding T6-F-004)",
    ).toBeNull();
  });
}, 300000);

// ===========================================================================
// RED-6 — the residual the design predicted (§4, R-5), at the depth T10 measured
// ===========================================================================

/**
 * A third real CLI profile, driven as a real process, whose card Bob has never seen.
 *
 * Alice is already pinned by Bob in `world`, so she cannot be the untrusted sender. Carol publishes
 * and sends exactly as a real peer does; the only thing missing is Bob's import of her card, which
 * is the condition R-5 is about.
 */
interface Carol { identityId: string; cardPath: string; send: (text: string) => Promise<void> }
async function introduceCarol(w: World): Promise<Carol> {
  const directory = dirname(w.bob);
  const carol = join(directory, "carol");
  const carolKey = randomBytes(32).toString("base64url");
  const carolRun = async (args: string[], expected: number | null = 0) => {
    const result = await command(process.execPath, [cli, ...args, "--profile", carol, "--json"], { ECHOLET_E2E_KEY: carolKey }, 60000);
    if (expected !== null) expect(result.code, `carol ${args[0]}`).toBe(expected);
    return JSON.parse(result.stdout) as { ok: boolean; data?: Record<string, unknown> };
  };
  await carolRun(["init", "--relay-url", w.proxyUrl, "--store-key-env", "ECHOLET_E2E_KEY"]);
  const carolCard = join(directory, "carol-card.json"), bobCard = join(directory, "bob-card-for-carol.json");
  await carolRun(["contact", "export", "--out", carolCard]);
  await w.run(w.bob, ["contact", "export", "--out", bobCard]);
  await carolRun(["contact", "import", "--from", bobCard, "--yes"]);
  await carolRun(["relay", "publish"]);
  const identityId = (JSON.parse(readFileSync(carolCard, "utf8")) as { signal_bundle: { device_record: { identity_id: string } } }).signal_bundle.device_record.identity_id;
  return {
    identityId, cardPath: carolCard,
    send: async (text: string) => { await carolRun(["send", "--to", w.bobIdentity, "--text", text]); },
  };
}

/**
 * The two flood depths that isolate T10-F-001, and the ONLY thing that differs between them.
 *
 * `maxPollPagesPerPoll = 16` (`inbound.ts:148`) bounds every walk, including the `contact import`
 * re-walk that is the design's own recovery path for R-5, and the re-walk request is consumed
 * (`inbound.ts:135`) whether or not that walk reached the end of the mailbox. At the shipped
 * defaults — poll byte budget `(1<<20)-4096`, `ECHOLET_MAX_MESSAGE_BYTES` 262 144, so 3 maximum-size
 * envelopes per page — 16 pages is 48 envelopes. Poison 49 envelopes deep and the re-walk stops one
 * page short of the message forever: the durable mark is already past it, every later poll is
 * cursorless and resumes after it, and it is lost until it expires.
 *
 * The old RED-6 could not see this. It flooded 40 envelopes at `ciphertext: 4` — about ONE page —
 * so it exercised the reset flag and never the truncation, and it passed while a 55-envelope flood
 * (5 self-published identities, 14 457 630 B, 60 requests, paid once) destroyed a message
 * permanently. Both depths are therefore run here, and the control is what makes the attack row a
 * statement about the page bound rather than about late import in general.
 *
 * `behind` is poison stored AFTER the message, so the target does not sit in the never-marked final
 * page: without it the residual the implementer disclosed would recover the message for a reason
 * that has nothing to do with the re-walk.
 *
 * Why `behind` is 60 and not 6 (finding T10R3-F-004)
 * ---------------------------------------------------
 * A walk never marks its FINAL page: `inbound.ts` reports page k's position on page k+1's request,
 * and the last page has no k+1. So "behind" only does its job if it is enough to fill at least one
 * whole page AFTER the message, and the size of a page is not a constant of this suite — it is
 * `min(poll_batch_size, what the relay's byte budget allows)`, which is 3 envelopes in the
 * maximum-size ciphertext regime these rows use and up to the configured batch of 50 in any smaller
 * one. `behind: 6` was therefore two pages here and ZERO pages the moment the ciphertext regime
 * changes — `ECHOLET_MAX_MESSAGE_BYTES`, the poll byte budget or the batch size moving is enough —
 * at which point the message sits in the never-marked final page and the row passes because the mark
 * never got past it, not because the re-walk recovered it. 60 exceeds the configured batch of 50, so
 * at least one full page follows the message under EVERY regime, and the row can only pass for the
 * reason it is about.
 */
const lateImportDepths = [
  {
    label: "control — 30 maximum-size poison ahead (10 pages), inside the 16-page valve",
    ahead: 30, behind: 60, aheadPages: 10, postImportPolls: 4, timeoutMs: 600000,
  },
  {
    label: "attack — 49 maximum-size poison ahead (17 pages), past the 16-page valve (T10-F-001)",
    ahead: 49, behind: 60, aheadPages: 17, postImportPolls: 9, timeoutMs: 900000,
  },
] as const;

describe.each(lateImportDepths)("RED-6: a contact card imported after the envelope arrived recovers the message — $label", ({ ahead, behind, aheadPages, postImportPolls, timeoutMs }) => {
  it("delivers the message the import was performed for", async () => {
    await world(`red6-late-import-${String(ahead)}`, async (w) => {
      // Poison FIRST, so Bob's pre-import walk has to move the durable mark past the untrusted
      // envelope rather than stopping on it.
      const aheadCost = await flood(w.relayUrl, w.bobRecipient, ahead, 262144, 4, 0);
      expect(aheadCost.stored, `all ${String(ahead)} poison envelopes ahead of the message must be stored`).toBe(ahead);

      const carol = await introduceCarol(w);
      const text = `E2E_FLOOD_LATE_IMPORT_${randomUUID()}`;
      await carol.send(text);

      // ...and poison BEHIND it, from a disjoint envelope_id range, so the message is not left in
      // the never-marked final page.
      const behindCost = await flood(w.relayUrl, w.bobRecipient, behind, 262144, 1, 1000);
      expect(behindCost.stored).toBe(behind);
      const attackerCost = {
        identities: aheadCost.identities + behindCost.identities,
        envelopes: aheadCost.stored + behindCost.stored,
        uploadedBytes: aheadCost.uploadedBytes + behindCost.uploadedBytes,
        requests: aheadCost.requests + behindCost.requests,
      };

      // Bob walks the WHOLE mailbox before Carol is trusted: every envelope is judged and refused,
      // and the mark ends up past Carol's message. A walk that stopped at the valve would leave the
      // mark short of it and recover the message for the wrong reason, so the drive continues until
      // a poll walks fewer pages than the valve allows - which is how "the walk reached the end of
      // the mailbox" is distinguished from "the walk ran out of patience".
      const beforeCodes: number[] = [];
      let reachedTheEnd = false;
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const marker = w.counters.pages.length;
        const result = await w.run(w.bob, ["poll"], null, 240000);
        beforeCodes.push(result.code ?? -1);
        if (w.counters.pages.length - marker < 16) { reachedTheEnd = true; break; }
      }
      expect(beforeCodes[beforeCodes.length - 1], `pre-import poll exit codes ${JSON.stringify(beforeCodes)}: a mailbox holding only permanently unacceptable envelopes must still fail closed on exit 3`).toBe(3);
      expect(reachedTheEnd, "the pre-import drive must have walked the mailbox to its end, so the durable mark is genuinely past the untrusted envelope").toBe(true);
      expect(w.counters.ackedIds, "F-012: a batch that accepted nothing acknowledges nothing").toEqual([]);
      expect(await w.historyLength(w.bob, carol.identityId), "the message must not be delivered before the card is imported").toBe(0);

      // The supported recovery path: the operator imports the card the message was waiting for.
      await w.run(w.bob, ["contact", "import", "--from", carol.cardPath, "--yes"]);

      // Every poll after the import, whatever it exits. The exit code is NOT the assertion: once the
      // mark is at the end of the mailbox a poll that delivers nothing exits 0, so a suite that
      // asserted the exit code would go green on a permanently lost message. Delivery is the claim.
      const afterCodes: number[] = [];
      const beforePolls = w.counters.polls;
      for (let attempt = 0; attempt < postImportPolls; attempt += 1) {
        afterCodes.push((await w.run(w.bob, ["poll"], null, 240000)).code ?? -1);
      }

      expect(
        await w.historyLength(w.bob, carol.identityId),
        `after ${String(attackerCost.identities)} self-published identities placed ${String(attackerCost.envelopes)} poison envelopes ` +
          `(${String(attackerCost.uploadedBytes)} B, ${String(attackerCost.requests)} requests, paid once) with ${String(ahead)} of them — ${String(aheadPages)} pages — ahead of the message, ` +
          `${String(postImportPolls)} polls after \`contact import\` (exit codes ${JSON.stringify(afterCodes)}, ${String(w.counters.polls - beforePolls)} pages served) left the message UNDELIVERED. ` +
          "It must be delivered. `contact import` is the design's own recovery path for R-5 and the only thing that makes the durable mark safe for a CONTACT_NOT_TRUSTED envelope, " +
          "but the re-walk it requests is bounded by the same maxPollPagesPerPoll = 16 valve (inbound.ts:148) and the request is consumed whether or not the walk reached the end (inbound.ts:135). " +
          "Past 16 pages of poison the re-walk never reaches the envelope, the mark is already past it, every later poll resumes after it, and the message is lost permanently — a denial of service traded for a lost message (T10-F-001). " +
          "The recovery must survive a flood of any depth: consume the re-walk request only when the walk actually reached the end, or hold a durable re-walk floor the mark may not pass until it does",
      ).toBe(1);
    });
  }, timeoutMs);
});

// ===========================================================================
// RED-7 — the read position must not answer questions before the asker is authenticated
// ===========================================================================

/**
 * T10-F-002. `resolveReadThrough` (`mailbox_handler.go:423-449`) is applied deliberately BEFORE
 * `challengeService.GetValid` and before `authorizeMailboxDevice`, so that malformed input never
 * depends on who is asking. The pure shape check belongs there. The BOUND does not: it calls
 * `HighestIssuedPosition(mailboxID)` and answers `400 INVALID_SCHEMA` above it against
 * `400 CHALLENGE_EXPIRED` below it, so the pair of answers is a comparator on a number that belongs
 * to the mailbox owner.
 *
 * `mailbox_id` is `sha256(identity_id + ":mailbox:v1")` and `identity_id` is printed on every contact
 * card, so anyone who has ever seen the victim's card can compute it. T10 recovered the exact
 * lifetime envelope count of a mailbox in about twenty requests with a fabricated `challenge_id`, a
 * fabricated `device_id` and the literal signature "AAAA". That is new metadata: it is the victim's
 * lifetime received-envelope count, not traffic the asking party observed, and `SEC-01 §6.2` confines
 * what the relay exposes to third parties.
 *
 * The assertion pins the OUTCOME — the answer must not vary with the mailbox's contents — not the
 * mechanism. Moving the bound after signature verification satisfies it; so does any other design
 * that makes an unauthenticated caller's answer independent of the mailbox. The control at the end
 * is what keeps that from being satisfied by simply deleting the check: a legitimate, signed poll
 * carrying a real read position must still work.
 */
it("RED-7: an unauthenticated caller cannot recover how many envelopes a mailbox has ever been issued", async () => {
  await world("red7-count-oracle", async (w) => {
    // A mailbox with an exactly known number of allocated positions, matching T10's measurement.
    const allocated = 66;
    expect((await flood(w.relayUrl, w.bobRecipient, allocated, 4)).stored).toBe(allocated);

    /**
     * One unauthenticated probe. Every credential is fabricated: a random challenge_id the relay
     * never issued, a random device_id with no binding to this mailbox, and a signature that is not
     * one. It goes straight to the relay rather than through the counting proxy, because it is the
     * attacker's traffic and must not be charged to the recipient's measured cost.
     *
     * Only the status and the typed error code are retained — never a body.
     */
    const probe = async (readThrough: number): Promise<string> => {
      const response = await fetch(`${w.relayUrl}/v1/mailbox/poll`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({
          challenge_id: randomUUID(), recipient_mailbox_id: w.bobRecipient.mailboxId,
          device_id: randomUUID(), signature: "AAAA", batch_size: 50, read_through: String(readThrough),
        }),
        signal: AbortSignal.timeout(10000),
      });
      let code = "none";
      try {
        const parsed = await response.json() as { error?: { code?: unknown } };
        if (typeof parsed.error?.code === "string" && /^[A-Z_]+$/.test(parsed.error.code)) code = parsed.error.code;
      } catch { /* a non-JSON refusal contributes its status alone */ }
      return `${String(response.status)} ${code}`;
    };

    // The binary search T10 ran, reproduced so the failure message carries the number it recovers.
    const baseline = await probe(0);
    let low = 0, high = 4096;
    while (low < high) {
      const mid = Math.floor((low + high + 1) / 2);
      (await probe(mid)) === baseline ? (low = mid) : (high = mid - 1);
    }

    // A ladder that straddles the true count. If the answer is a function of the mailbox's contents
    // rather than of the request alone, these are not all the same string.
    const ladder = [0, 1, allocated - 33, allocated - 1, allocated, allocated + 1, allocated + 33, 1000, 4096];
    const answers: string[] = [];
    for (const value of ladder) answers.push(await probe(value));
    const distinct = [...new Set(answers)];

    expect(
      distinct.length,
      `an unauthenticated caller — fabricated challenge_id, fabricated device_id, a signature that is not one — got ${JSON.stringify(distinct)} ` +
        `across read_through values ${JSON.stringify(ladder)}, and a binary search over those answers recovered ${String(low)} against a mailbox with exactly ${String(allocated)} allocated positions. ` +
        "The relay's answer to an unauthenticated caller must not depend on the mailbox's contents. `resolveReadThrough` (mailbox_handler.go:438-446) reads HighestIssuedPosition before the challenge is validated and before authorizeMailboxDevice, " +
        "so the pair of refusals is a comparator on the victim's LIFETIME received-envelope count — computable by anyone holding their contact card, since mailbox_id is sha256(identity_id + ':mailbox:v1'). " +
        "SEC-01 §6.2 confines what the relay exposes to third parties, and this is not in it (T10-F-002). " +
        "Keep the pure shape check before authentication; the bound that consults the mailbox must come after the signature is verified",
    ).toBe(1);

    // Control: the bound must not be satisfied by removing the protection. A real, signed poll that
    // reports a real read position must still deliver, and the mark must still work.
    const text = `E2E_ORACLE_CONTROL_${randomUUID()}`;
    await w.run(w.alice, ["send", "--to", w.bobIdentity, "--text", text]);
    const codes = await w.poll(w.bob, 4, 240000);
    expect(codes[codes.length - 1], `control poll exit codes ${JSON.stringify(codes)}: a legitimate, signed poll carrying a real read position must still deliver`).toBe(0);
    expect(await w.historyLength(w.bob, w.aliceIdentity)).toBe(1);
  });
}, 420000);
