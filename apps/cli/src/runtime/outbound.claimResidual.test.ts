import { afterEach, describe, expect, it, vi } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createIdentityProfile, createSignedDeviceRecord } from "@echolet/client-core";
import { decodeBase64Url } from "@echolet/crypto-core";
import { signalAddressForDevice, type SignalPreKeyBundleV2 } from "@echolet/protocol";
import { EncryptedSqliteStore, SignalClient, exportSignedSignalBundleV2 } from "@echolet/session-node";
import { openProfile } from "./profile";
import { RelayClient } from "../transport/relayClient";
import { openOutboundMessenger } from "./outbound";

// RED tests for flow 003 / T12 — the residual behind the T11 observation "the claim is not rolled
// back when the subsequent mailbox deposit fails"
// (.metaproject/flows/002-.../t11-geekom-tls-report.md §10.1).
//
// What was established first, by reading and by measurement, because the right assertion depends on
// it (t12-prekey-claim-analysis.md carries the full write-up):
//
//   * The claim and the deposit are two separate client-issued requests: `POST /v2/prekeys/claim`
//     then `POST /v1/messages/send` (runtime/outbound.ts sendOwned). The failure T11 hit is a
//     SERVER-side rejection of the SECOND request — the relay refused the deposit under
//     `UNAUTHORIZED_MAILBOX_ACCESS` because that sender had never run `relay publish` — after the
//     first had already committed.
//   * The consumption is permanent BY DESIGN and must stay so. The relay reserves a one-time
//     prekey's tombstones forever, replays a committed claim byte-for-byte under its `claim_id`, and
//     never lets two claim ids reach the same one-time prekey (specification.md, "Atomic claim";
//     repository/prekey_bundle_v2_test.go). A rollback would hand one Signal one-time prekey to two
//     senders. So a rollback test is NOT written here, and the existing Go tests that forbid one are
//     left exactly as they are.
//   * Replenishment already works on the relay: a newly signed publication with a fresh one-time
//     prekey restores availability, while the earlier claim id keeps replaying its own bundle.
//     Measured against the real repository, not modelled.
//   * The same sender's own retry after a failed deposit already recovers, and does not re-claim.
//     Measured; also covered by outbound.test.ts "keeps an ambiguous send pending...".
//
// What is left, and what these tests pin, is the bound that is missing on the CLIENT: the CLI takes
// the irreversible step — spending a scarce, non-renewable resource that belongs to somebody else —
// before it has established that the reversible preconditions of its own send hold, and it never
// releases a stored claim that has become unusable. Both turn a transient or operator-fixable
// condition into a permanent denial of first contact, for a recipient who has no CLI command to
// replenish.
//
// No store key, private key, plaintext or HTTP request body is asserted on or printed here: the
// assertions carry request PATHS, error CODES and booleans only.

const paths: string[] = [];
const opened: Array<{ close(): Promise<void> }> = [];
afterEach(async () => {
  for (const handle of opened.splice(0)) await handle.close();
  for (const path of paths.splice(0)) rmSync(path, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const directory = () => {
  const path = mkdtempSync(join(tmpdir(), "echolet-claim-residual-test-"));
  paths.push(path);
  return path;
};

async function profileFixture() {
  const profileDir = directory();
  const config = {
    profile_version: 1 as const,
    profile_id: randomUUID(),
    relay_url: "http://127.0.0.1:8081",
    database_path: "client.sqlite",
    store_key_env: "ECHOLET_TEST_KEY",
    request_timeout_ms: 500,
    poll_batch_size: 50,
  };
  const environment = { ECHOLET_TEST_KEY: randomBytes(32).toString("base64url") };
  const profile = await openProfile({ profileDir, config, environment, initialize: true });
  opened.push(profile);
  return { profileDir, config, environment, profile };
}

/** A recipient that has published exactly one bundle, and can allocate a fresh one on demand. */
async function recipientPeer() {
  const identity = await createIdentityProfile({ deviceLabel: "recipient" });
  const record = createSignedDeviceRecord(identity.identityId, identity.deviceId, identity.devicePubKey, identity.identitySecretKey, "recipient");
  const store = new EncryptedSqliteStore(join(directory(), "recipient.sqlite"), randomBytes(32));
  opened.push(store);
  const client = await SignalClient.create(store, signalAddressForDevice(record.identity_id, record.device_id));
  const deviceSecretKey = decodeBase64Url(identity.deviceSecretKey);
  const bundle = await exportSignedSignalBundleV2(client, { deviceRecord: record, deviceSecretKey });
  /** The explicit rotation the relay requires for a replacement publication: a NEW one-time prekey. */
  const replenish = async (createdAtMs: number) => {
    await client.rotateOneTimePreKey();
    return exportSignedSignalBundleV2(client, { deviceRecord: record, deviceSecretKey, createdAtMs });
  };
  return { identity, bundle, replenish, card: { type: "echolet_contact_card" as const, version: 1 as const, signal_bundle: bundle } };
}

/** A CLI profile that trusts `recipient` but has not published anything to the relay yet. */
async function senderProfile(recipient: Awaited<ReturnType<typeof recipientPeer>>) {
  const local = await profileFixture();
  await local.profile.importContact(recipient.card, { confirm: async () => true });
  await local.profile.close();
  return local;
}

interface WireEnvelope {
  envelope_id: string;
  sender_device_id: string;
}

/**
 * The relay semantics this task depends on, modelled from the measured Go implementation:
 *
 *   - one claimable publication at a time; a claim consumes it permanently,
 *   - a repeated `claim_id` replays the exact bundle already bound to it, expiry included,
 *   - no available publication answers 404 `PREKEY_BUNDLE_UNAVAILABLE`,
 *   - since T50 a deposit from a device the relay holds no published record for is refused
 *     403 `UNAUTHORIZED_MAILBOX_ACCESS`.
 *
 * The claim route is deliberately NOT gated on the caller having published: that is the relay's real
 * behaviour (router.go registers `/v2/prekeys/claim` with no authentication), and pretending
 * otherwise would hide the very ordering these tests are about.
 */
function relayFake(available: SignalPreKeyBundleV2 | null) {
  const requestPaths: string[] = [];
  const claims = new Map<string, SignalPreKeyBundleV2>();
  const publishedDevices = new Set<string>();
  const state = { available };
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const failure = (status: number, code: string) => json(status, { ok: false, error: { code, message: code } });

  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    requestPaths.push(path);
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;

    if (path === "/v2/prekeys/publish") {
      const bundle = body.bundle as SignalPreKeyBundleV2;
      publishedDevices.add(bundle.device_record.device_id);
      return json(200, { ok: true, data: { stored: true, bundle_id: bundle.bundle_id, claimable: true } });
    }
    if (path === "/v2/prekeys/claim") {
      const claimId = String(body.claim_id);
      const replay = claims.get(claimId);
      if (replay) return json(200, { ok: true, data: { bundle: replay } });
      if (state.available === null) return failure(404, "PREKEY_BUNDLE_UNAVAILABLE");
      claims.set(claimId, state.available);
      const served = state.available;
      state.available = null;
      return json(200, { ok: true, data: { bundle: served } });
    }
    if (path === "/v1/messages/send") {
      const envelope = (body as unknown as { envelope: WireEnvelope }).envelope;
      if (!publishedDevices.has(envelope.sender_device_id)) return failure(403, "UNAUTHORIZED_MAILBOX_ACCESS");
      return json(200, { ok: true, data: { accepted: true, envelope_id: envelope.envelope_id, status: "relayed" } });
    }
    throw new Error(`unexpected relay path ${path}`);
  });

  return {
    fetch,
    state,
    claimsIssued: () => claims.size,
    claimRequests: () => requestPaths.filter((path) => path === "/v2/prekeys/claim").length,
  };
}

type Fixture = Awaited<ReturnType<typeof profileFixture>>;
const messengerFor = (fixture: Fixture, fetch: typeof globalThis.fetch, now?: () => number) =>
  openOutboundMessenger({
    profileDir: fixture.profileDir,
    environment: fixture.environment,
    relay: new RelayClient({ baseUrl: fixture.config.relay_url, timeoutMs: fixture.config.request_timeout_ms, fetch }),
    ...(now ? { now } : {}),
  });

const codeOf = (error: unknown) => {
  const value = error as { remoteCode?: string; code?: string } | null;
  return value?.remoteCode ?? value?.code ?? "NO_ERROR";
};

describe("first-contact claim residuals", () => {
  it("does not spend the recipient's one-time prekey on a send the relay is certain to refuse", async () => {
    // T11 §10.1 exactly: a profile that has run `init` and `contact import` but not `relay publish`.
    // Since T50 the relay refuses that profile's deposit under `UNAUTHORIZED_MAILBOX_ACCESS`, which
    // cli.ts already documents as "an ordinary, operator-fixable precondition". The CLI nevertheless
    // claims the recipient's only one-time prekey BEFORE it discovers this, so a send that could
    // never have been accepted permanently burns a resource belonging to a third party.
    const recipient = await recipientPeer();
    const unpublished = await senderProfile(recipient);
    const properlyPublished = await senderProfile(recipient);
    const relay = relayFake(recipient.bundle);

    const doomed = await messengerFor(unpublished, relay.fetch);
    opened.push(doomed);
    const refusal = await doomed
      .send({ recipientIdentityId: recipient.identity.identityId, messageId: randomUUID(), plaintext: "never accepted" })
      .catch((error: unknown) => error);
    // That this send fails is correct and is not what is under test. Today it fails at the relay
    // under `UNAUTHORIZED_MAILBOX_ACCESS`; a fix may refuse it earlier and under its own code, so
    // only the failure is pinned, not the vocabulary.
    expect(codeOf(refusal), "a profile that has never published must not be able to deposit").not.toBe("NO_ERROR");
    await doomed.close();

    // The load-bearing property, stated as an outcome rather than as a mechanism: a first-contact
    // send that FAILED must leave the recipient reachable by a DIFFERENT sender. Nothing was
    // delivered, so nothing of the recipient's should have been spent.
    const other = await messengerFor(properlyPublished, relay.fetch);
    opened.push(other);
    await other.publish();
    await expect(
      other.send({ recipientIdentityId: recipient.identity.identityId, messageId: randomUUID(), plaintext: "first contact" }),
      "a send the relay refused must not deny first contact to every later sender",
    ).resolves.toMatchObject({ status: "delivered" });

    // Guards the same property from the other side once it holds: exactly one claim was needed, and
    // it belongs to the sender that actually delivered.
    expect(relay.claimsIssued()).toBe(1);
  }, 60000);

  it("does not stay wedged on a stored claim whose bundle has expired, once the recipient replenishes", async () => {
    // A claim commits on the relay and its response is lost. The CLI durably keeps the `claim_id` so
    // the retry replays the same bundle — correct, and the relay replays it exactly, expiry
    // included. But the sender may come back after that bundle's validity window has closed. The
    // stored claim is then dead: it can never establish a session, and the CLI holds it forever, so
    // every later first-contact attempt to that recipient replays the dead bundle instead of
    // claiming the fresh publication sitting on the relay. A transient failure becomes permanent.
    const recipient = await recipientPeer();
    const sender = await senderProfile(recipient);
    const t0 = recipient.bundle.created_at_ms;
    const afterExpiry = recipient.bundle.expires_at_ms + 60_000;

    let dropClaimResponse = true;
    const relay = relayFake(recipient.bundle);
    const lossy = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const response = await relay.fetch(input, init);
      // The claim COMMITS on the relay and the response never reaches the client.
      if (dropClaimResponse && new URL(String(input)).pathname === "/v2/prekeys/claim") {
        throw new DOMException("response lost", "AbortError");
      }
      return response;
    }) as unknown as typeof globalThis.fetch;

    const first = await messengerFor(sender, lossy, () => t0);
    await first.publish();
    const messageId = randomUUID();
    const lost = await first
      .send({ recipientIdentityId: recipient.identity.identityId, messageId, plaintext: "delayed first contact" })
      .catch((error: unknown) => error);
    expect(codeOf(lost)).toBe("RELAY_TIMEOUT");
    await first.close();

    // Time passes beyond the claimed bundle's window; the recipient publishes a fresh one, which the
    // relay does make claimable again (measured against the real repository).
    dropClaimResponse = false;
    relay.state.available = await recipient.replenish(afterExpiry);

    const resumed = await messengerFor(sender, lossy, () => afterExpiry);
    opened.push(resumed);
    await expect(
      resumed.send({ recipientIdentityId: recipient.identity.identityId, messageId, plaintext: "delayed first contact" }),
      "a stored claim that has expired must not outlive the recipient's fresh publication",
    ).resolves.toMatchObject({ status: "delivered" });
  }, 60000);

  it("does not report an expired stored claim as a contact pin mismatch", async () => {
    // Same wedge, with nothing left to replenish it. The recipient's pinned identity, device, device
    // key and Signal identity key all still match — only the validity window has closed — yet
    // `sendOwned` funnels every failure of `importVerifiedSignalBundleV2` into
    // `CONTACT_PIN_MISMATCH`, telling the operator their peer may be an impostor. cli.ts's own rule
    // is that the failure vocabulary must grow "where flattening actively misleads"; the honest
    // answer here is the exhausted-recipient condition the CLI already reports under the relay's own
    // code. This assertion prescribes no particular replacement, only that it is not the trust
    // violation it is not.
    const recipient = await recipientPeer();
    const sender = await senderProfile(recipient);
    const t0 = recipient.bundle.created_at_ms;
    const afterExpiry = recipient.bundle.expires_at_ms + 60_000;

    let dropClaimResponse = true;
    const relay = relayFake(recipient.bundle);
    const lossy = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const response = await relay.fetch(input, init);
      if (dropClaimResponse && new URL(String(input)).pathname === "/v2/prekeys/claim") {
        throw new DOMException("response lost", "AbortError");
      }
      return response;
    }) as unknown as typeof globalThis.fetch;

    const first = await messengerFor(sender, lossy, () => t0);
    await first.publish();
    const messageId = randomUUID();
    await first
      .send({ recipientIdentityId: recipient.identity.identityId, messageId, plaintext: "delayed first contact" })
      .catch(() => undefined);
    await first.close();

    dropClaimResponse = false; // the recipient publishes nothing new: state.available stays null

    const resumed = await messengerFor(sender, lossy, () => afterExpiry);
    opened.push(resumed);
    const failure = await resumed
      .send({ recipientIdentityId: recipient.identity.identityId, messageId, plaintext: "delayed first contact" })
      .catch((error: unknown) => error);
    expect(
      codeOf(failure),
      "an expired prekey bundle is an exhausted recipient, not a contact whose pin no longer matches",
    ).not.toBe("CONTACT_PIN_MISMATCH");
  }, 60000);
});
