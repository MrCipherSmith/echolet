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
 *   RED-6  the late-`contact import` recovery path (design §4, R-5) — a guard, not a RED
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
 * Returns the attacker's own cost, which is the number AC2 asks to be stated.
 */
async function flood(relayUrl: string, recipient: Recipient, poison: number, ciphertextBytes: number, concurrency = 1) {
  const perIdentity = 16;
  const identities: Attacker[] = [];
  for (let placed = 0; placed < poison; placed += perIdentity) identities.push(await publishAttacker(relayUrl));
  const work = Array.from({ length: poison }, (_, index) => ({ attacker: identities[Math.floor(index / perIdentity)]!, index }));
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
  /** Whether each ack request carried a `read_through`, and its value when it did. */
  ackReadThrough: Array<string | null>;
  ackedIds: string[];
  statuses: number[];
}

function counterProxy(relayUrl: string) {
  const counters: Counters = {
    requests: 0, polls: 0, acks: 0, challenges: 0, upBytes: 0, downBytes: 0,
    pages: [], cursored: [], ackReadThrough: [], ackedIds: [], statuses: [],
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
        let cursored = false;
        try { cursored = typeof (JSON.parse(requestBody.toString("utf8")) as { cursor?: unknown }).cursor === "string"; } catch { /* bounded */ }
        counters.cursored.push(cursored);
        let ids: string[] = [];
        try {
          const parsed = JSON.parse(bytes.toString("utf8")) as { data?: { envelopes?: Array<{ envelope_id?: unknown }> } };
          ids = (parsed.data?.envelopes ?? []).map((entry) => typeof entry.envelope_id === "string" ? entry.envelope_id : "");
        } catch { /* a non-success poll response contributes an empty page */ }
        counters.pages.push(ids);
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

    async function runRaw(profile: string, args: string[], timeoutMs = 20000) {
      return command(process.execPath, [cli, ...args, "--profile", profile, "--json"], { ECHOLET_E2E_KEY: keys.get(profile)! }, timeoutMs);
    }
    async function run(profile: string, args: string[], expected: number | null = 0, timeoutMs = 20000) {
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

    // Process 2: a brand new PID with a freshly loaded profile, polling with NO cursor.
    const secondProcessStart = w.counters.pages.length;
    const codes = await w.poll(w.bob, 4, 300000);
    const secondProcessPages = w.counters.pages.slice(secondProcessStart).filter((page) => page.length > 0);
    expect(secondProcessPages.length).toBeGreaterThan(0);
    expect(
      w.counters.cursored[secondProcessStart],
      "the resuming poll must be cursorless — `inbound.ts:105` starts every walk with no cursor, and it is the RELAY that must resume the recipient at its stored read position",
    ).toBe(false);

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
// RED-6 — the residual the design predicted: a card imported after the envelope arrived
// ===========================================================================

/**
 * This is a GUARD, not a RED: it passes today, because a cursorless poll restarts at the head and
 * re-offers everything. It must still pass afterwards.
 *
 * Design §4, R-5: with a durable read position, a `CONTACT_NOT_TRUSTED` envelope is passed ONCE
 * instead of being re-offered on every poll, so importing the card later would no longer recover
 * it. `contact import` therefore has to reset the mark. The poison in front of Alice's envelope is
 * what forces the walk to move the mark past her message before the card exists, so an
 * implementation that omits the reset fails here rather than in production.
 */
it("RED-6 (guard): a contact card imported after the envelope arrived still recovers the message", async () => {
  await world("red6-late-import", async (w) => {
    // Poison first, so Bob's pre-import walk has to move past the untrusted envelope rather than
    // stopping on it. The per-sender quota (16) forces three self-published identities for 40.
    expect((await flood(w.relayUrl, w.bobRecipient, 40, 4)).stored).toBe(40);
    // Alice is already pinned by Bob in `world`, so the untrusted sender here is a THIRD real CLI
    // profile whose card Bob imports only after its envelope is already queued behind the poison.
    const carol = join(dirname(w.bob), "carol");
    const carolKey = randomBytes(32).toString("base64url");
    const carolRun = async (args: string[], expected: number | null = 0) => {
      const result = await command(process.execPath, [cli, ...args, "--profile", carol, "--json"], { ECHOLET_E2E_KEY: carolKey }, 60000);
      if (expected !== null) expect(result.code, `carol ${args[0]}`).toBe(expected);
      return JSON.parse(result.stdout) as { ok: boolean; data?: Record<string, unknown> };
    };
    await carolRun(["init", "--relay-url", w.proxyUrl, "--store-key-env", "ECHOLET_E2E_KEY"]);
    const carolCard = join(dirname(w.bob), "carol-card.json"), bobCard = join(dirname(w.bob), "bob-card-for-carol.json");
    await carolRun(["contact", "export", "--out", carolCard]);
    await w.run(w.bob, ["contact", "export", "--out", bobCard]);
    await carolRun(["contact", "import", "--from", bobCard, "--yes"]);
    await carolRun(["relay", "publish"]);
    const carolIdentity = (JSON.parse(readFileSync(carolCard, "utf8")) as { signal_bundle: { device_record: { identity_id: string } } }).signal_bundle.device_record.identity_id;
    const text = `E2E_FLOOD_LATE_IMPORT_${randomUUID()}`;
    await carolRun(["send", "--to", w.bobIdentity, "--text", text]);

    // Bob walks the whole mailbox before Carol is trusted: every envelope is judged and refused.
    const before = await w.poll(w.bob, 3, 180000);
    expect(before[before.length - 1], `poll exit codes ${JSON.stringify(before)}: a mailbox holding only permanently unacceptable envelopes must still fail closed on exit 3`).toBe(3);
    expect(w.counters.ackedIds, "F-012: a batch that accepted nothing acknowledges nothing").toEqual([]);
    expect(await w.historyLength(w.bob, carolIdentity)).toBe(0);

    await w.run(w.bob, ["contact", "import", "--from", carolCard, "--yes"]);

    const after = await w.poll(w.bob, 4, 180000);
    expect(
      after[after.length - 1],
      `poll exit codes ${JSON.stringify(after)} after importing the sender's card. The message must be delivered. ` +
        "Design §4 R-5: a durable read position passes a CONTACT_NOT_TRUSTED envelope once, so `contact import` — the exact event that changes the verdict — must reset the mark, or importing a card late silently loses the message it was imported for",
    ).toBe(0);
    expect(await w.historyLength(w.bob, carolIdentity)).toBe(1);
  });
}, 420000);
