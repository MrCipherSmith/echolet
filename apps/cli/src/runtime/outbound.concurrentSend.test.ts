import { afterEach, describe, expect, it, vi } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createIdentityProfile, createSignedDeviceRecord } from "@echolet/client-core";
import { decodeBase64Url } from "@echolet/crypto-core";
import { signalAddressForDevice, type SignalPreKeyBundleV2 } from "@echolet/protocol";
import { EncryptedSqliteStore, SignalClient, exportSignedSignalBundleV2, type StoreTransaction } from "@echolet/session-node";
import { openProfile } from "./profile";
import { readHistory } from "./history";
import { RelayClient } from "../transport/relayClient";
import { openOutboundMessenger } from "./outbound";

// Review finding F-008: two independent runtime/store instances that send the same
// message id must produce exactly one outbox envelope, one envelope id and one history
// entry. The current code reads the prior outbox record outside the mutation transaction.

const paths: string[] = [];
const opened: Array<{ close(): Promise<void> }> = [];
afterEach(async () => {
  for (const handle of opened.splice(0)) await handle.close();
  for (const path of paths.splice(0)) rmSync(path, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const directory = () => {
  const path = mkdtempSync(join(tmpdir(), "echolet-concurrent-test-"));
  paths.push(path);
  return path;
};

async function profileFixture() {
  const profileDir = directory();
  const key = randomBytes(32);
  const config = {
    profile_version: 1 as const,
    profile_id: randomUUID(),
    relay_url: "http://127.0.0.1:8081",
    database_path: "client.sqlite",
    store_key_env: "ECHOLET_TEST_KEY",
    request_timeout_ms: 500,
    poll_batch_size: 50,
  };
  const environment = { ECHOLET_TEST_KEY: key.toString("base64url") };
  const profile = await openProfile({ profileDir, config, environment, initialize: true });
  opened.push(profile);
  return { profileDir, key, config, environment, profile };
}

async function untrustedRemote() {
  const identity = await createIdentityProfile({ deviceLabel: "remote" });
  const record = createSignedDeviceRecord(identity.identityId, identity.deviceId, identity.devicePubKey, identity.identitySecretKey, "remote");
  const store = new EncryptedSqliteStore(join(directory(), "remote.sqlite"), randomBytes(32));
  opened.push(store);
  const client = await SignalClient.create(store, signalAddressForDevice(record.identity_id, record.device_id));
  const bundle = await exportSignedSignalBundleV2(client, { deviceRecord: record, deviceSecretKey: decodeBase64Url(identity.deviceSecretKey) });
  return { identity, bundle, card: { type: "echolet_contact_card" as const, version: 1 as const, signal_bundle: bundle } };
}

type RecordedRequest = { path: string; body: Record<string, unknown> };
const relayResponse = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
function relayFetch(claimedBundle: SignalPreKeyBundleV2) {
  const requests: RecordedRequest[] = [];
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const request = { path: new URL(String(input)).pathname, body: JSON.parse(String(init?.body)) as Record<string, unknown> };
    requests.push(request);
    if (request.path === "/v2/prekeys/claim") return relayResponse({ ok: true, data: { bundle: claimedBundle } });
    if (request.path === "/v1/messages/send") {
      const envelope = request.body.envelope as { envelope_id: string };
      return relayResponse({ ok: true, data: { accepted: true, envelope_id: envelope.envelope_id, status: "relayed" } });
    }
    throw new Error(`unexpected relay path ${request.path}`);
  });
  return { fetch, requests };
}

/**
 * Explicit synchronisation barrier, no sleeping and no timing race.
 *
 * Anchoring (review finding T38-TP-001). The barrier used to fire on "the first store transaction
 * that reads `targetKey` and misses", which today happens to be the pre-read at outbound.ts:45 —
 * a read the source itself labels `// Optimization only`. Deleting that pre-read is exactly the
 * refactor the comment invites, and it silently re-anchored the barrier to the MUTATION
 * transaction, which releases only after the first sender has already committed its envelope. The
 * test then proved idempotent replay instead of concurrent-send exclusion, and stayed green.
 *
 * The barrier is therefore anchored to the SEMANTIC event instead: `idFactory("envelope")` is the
 * new-envelope allocation. A transaction is held only when it observed `targetKey` missing AND no
 * envelope had been allocated before it AND none was allocated inside it. A transaction that
 * already allocated an envelope is by definition past the point this test is about, so the
 * barrier refuses to arm on it and the test reports that the window never opened, instead of
 * quietly measuring something else.
 */
function holdBeforeFirstEnvelopeAllocation(targetKey: string, allocationCount: () => number) {
  const original = EncryptedSqliteStore.prototype.transaction;
  let signalArrival: () => void = () => undefined;
  let openGate: () => void = () => undefined;
  const arrived = new Promise<void>((resolve) => { signalArrival = resolve; });
  const gate = new Promise<void>((resolve) => { openGate = resolve; });
  let armed = true;
  const spy = vi.spyOn(EncryptedSqliteStore.prototype, "transaction") as unknown as {
    mockImplementation(fn: (this: EncryptedSqliteStore, operation: (tx: StoreTransaction) => unknown) => Promise<unknown>): void;
  };
  spy.mockImplementation(function (this: EncryptedSqliteStore, operation: (tx: StoreTransaction) => unknown) {
    let observed = false;
    const allocatedBefore = allocationCount();
    const wrapped = (tx: StoreTransaction) => operation({
      get: (key: string) => {
        const value = tx.get(key);
        if (key === targetKey && value === undefined) observed = true;
        return value;
      },
      set: (key: string, value: Uint8Array) => { tx.set(key, value); },
      delete: (key: string) => { tx.delete(key); },
      keys: (prefix?: string) => tx.keys(prefix),
    });
    return original.call(this, wrapped).then(async (result: unknown) => {
      const allocatedNothing = allocatedBefore === 0 && allocationCount() === 0;
      if (observed && armed && allocatedNothing) { armed = false; signalArrival(); await gate; }
      return result;
    });
  });
  return { arrived, release: () => { openGate(); } };
}

const messageID = "44444444-4444-4444-8444-444444444444";
const warmupMessageID = "55555555-5555-4555-8555-555555555555";
const envelopeA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const envelopeB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const claimID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

describe("CLI concurrent same-id send", () => {
  it("creates exactly one envelope and one history entry for two runtime instances sending the same message id", async () => {
    const local = await profileFixture();
    const remote = await untrustedRemote();
    await local.profile.importContact(remote.card, { confirm: async () => true });
    await local.profile.close();

    // Establish the peer session first: the concurrent window is then purely local.
    const warmupRelay = relayFetch(remote.bundle);
    const warmup = await openOutboundMessenger({
      profileDir: local.profileDir, environment: local.environment,
      relay: new RelayClient({ baseUrl: local.config.relay_url, timeoutMs: local.config.request_timeout_ms, fetch: warmupRelay.fetch }),
    });
    await warmup.send({ recipientIdentityId: remote.identity.identityId, messageId: warmupMessageID, plaintext: "SYNTHETIC_WARMUP_BODY" });
    await warmup.close();

    // Every new-envelope allocation, in the order the runtime made it. This is the seam the
    // barrier and the ordering assertions are anchored to; see holdBeforeFirstEnvelopeAllocation.
    const allocations: string[] = [];
    const idFactory = (envelopeId: string) => (kind: "claim" | "envelope") => {
      if (kind !== "envelope") return claimID;
      allocations.push(envelopeId);
      return envelopeId;
    };

    const firstRelay = relayFetch(remote.bundle);
    const secondRelay = relayFetch(remote.bundle);
    const first = await openOutboundMessenger({
      profileDir: local.profileDir, environment: local.environment,
      relay: new RelayClient({ baseUrl: local.config.relay_url, timeoutMs: local.config.request_timeout_ms, fetch: firstRelay.fetch }),
      idFactory: idFactory(envelopeA),
    });
    opened.push(first);
    const second = await openOutboundMessenger({
      profileDir: local.profileDir, environment: local.environment,
      relay: new RelayClient({ baseUrl: local.config.relay_url, timeoutMs: local.config.request_timeout_ms, fetch: secondRelay.fetch }),
      idFactory: idFactory(envelopeB),
    });
    opened.push(second);

    const input = { recipientIdentityId: remote.identity.identityId, messageId: messageID, plaintext: "SYNTHETIC_CONCURRENT_BODY" };
    const barrier = holdBeforeFirstEnvelopeAllocation(`cli:outbox:${messageID}`, () => allocations.length);

    const firstSend = first.send(input);
    const firstOutcome = firstSend.then((value) => ({ status: "fulfilled" as const, value }), (reason: unknown) => ({ status: "rejected" as const, reason }));

    // Racing the barrier against the first send turns "the window never opened" into an immediate,
    // self-describing failure instead of a 60 s harness timeout.
    const concurrencyWindow = await Promise.race([
      barrier.arrived.then(() => "opened" as const),
      firstOutcome.then(() => "first send finished without ever opening a concurrency window" as const),
    ]);
    const allocatedBeforeWindow = [...allocations];

    expect(concurrencyWindow).toBe("opened");
    // The window must open BEFORE the first sender allocates an envelope. If it opens afterwards,
    // the two sends are serialised and this test would silently degrade into an idempotent-replay
    // test (finding T38-TP-001, mutation MC3b).
    expect(allocatedBeforeWindow).toEqual([]);

    const secondReceipt = await second.send(input);
    barrier.release();
    const firstResult = await firstOutcome;

    const relayedEnvelopeIds = [...new Set([...firstRelay.requests, ...secondRelay.requests]
      .filter((request) => request.path === "/v1/messages/send")
      .map((request) => (request.body.envelope as { message_id: string; envelope_id: string }))
      .filter((envelope) => envelope.message_id === messageID)
      .map((envelope) => envelope.envelope_id))];

    await first.close();
    await second.close();
    const store = new EncryptedSqliteStore(join(local.profileDir, "client.sqlite"), local.key);
    opened.push(store);
    const persisted = await store.transaction((tx) => {
      const record = tx.get(`cli:outbox:${messageID}`);
      return {
        // Finding T38-TP-003 (1): this used to pass the COMPLETE key as the prefix, so the result
        // could only ever be 0 or 1 and the assertion was structurally unable to fail. It is now a
        // real prefix scan over the whole outbox, pinned against the exact set of message ids this
        // test sends.
        outboxKeys: tx.keys("cli:outbox:").sort(),
        // Project to the envelope id only: the stored record carries ciphertext.
        storedEnvelopeId: record
          ? (JSON.parse(new TextDecoder().decode(record)) as { envelope: { envelope_id: string } }).envelope.envelope_id
          : null,
        // Project to sequence numbers only: history entries carry plaintext.
        entries: readHistory(tx, remote.identity.identityId).filter((entry) => entry.messageId === messageID).map((entry) => entry.sequence),
      };
    });

    expect(firstResult.status).toBe("fulfilled");
    const firstReceipt = (firstResult as { value: { envelopeId: string; messageId: string } }).value;
    expect(firstReceipt.messageId).toBe(messageID);
    // Soft assertions so one run reports every duplicate the defect produces.
    expect.soft(persisted.entries).toHaveLength(1);
    expect.soft(persisted.outboxKeys).toEqual([`cli:outbox:${messageID}`, `cli:outbox:${warmupMessageID}`].sort());
    expect.soft(relayedEnvelopeIds).toHaveLength(1);
    expect.soft(firstReceipt.envelopeId).toBe(secondReceipt.envelopeId);
    // Only the sender that ran inside the window may allocate a new envelope; the one that was
    // held must adopt the committed record rather than allocating its own.
    expect.soft(allocations).toEqual([envelopeB]);
    // The persisted record, both receipts and everything that reached the relay must name one and
    // the same envelope. This is what the inert outboxKeys assertion used to claim to cover.
    expect.soft([...new Set([persisted.storedEnvelopeId, firstReceipt.envelopeId, secondReceipt.envelopeId, ...relayedEnvelopeIds])])
      .toEqual([envelopeB]);
  }, 60000);
});
