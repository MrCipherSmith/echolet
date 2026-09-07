import { afterEach, describe, expect, it, vi } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openProfile } from "./profile";
import { createIdentityProfile } from "../../../../packages/client-core/src/identity/createIdentityProfile";
import { createSignedDeviceRecord } from "../../../../packages/client-core/src/identity/createSignedDeviceRecord";
import { SignalClient } from "../../../../packages/session-node/src/SignalClient";
import { EncryptedSqliteStore } from "../../../../packages/session-node/src/EncryptedSqliteStore";
import { exportSignedSignalBundleV2, importVerifiedSignalBundleV2 } from "../../../../packages/session-node/src/wire";
import { SignalPreKeyBundleV2Schema, signalAddressForDevice, signalBundleV2SigningText } from "../../../../packages/protocol/src/types/signalPreKeyBundleV2";
import { decodeBase64Url, signUtf8Message } from "../../../../packages/crypto-core/src/index";

const paths: string[] = [];
const opened: Array<{ close(): Promise<void> }> = [];
afterEach(async () => {
  for (const handle of opened.splice(0)) await handle.close();
  for (const path of paths.splice(0)) rmSync(path, { recursive: true, force: true });
  vi.restoreAllMocks();
});
const directory = () => { const path = mkdtempSync(join(tmpdir(), "echolet-cli-test-")); paths.push(path); return path; };
async function local() {
  const profileDir = directory(), key = randomBytes(32);
  const config = { profile_version: 1, profile_id: randomUUID(), relay_url: "http://127.0.0.1:8081", database_path: "client.sqlite", store_key_env: "ECHOLET_TEST_KEY", request_timeout_ms: 5000, poll_batch_size: 50 };
  const environment = { ECHOLET_TEST_KEY: key.toString("base64url") };
  const profile = await openProfile({ profileDir, config, environment, initialize: true });
  opened.push(profile);
  return { profileDir, profile, config, environment, key };
}
async function remote(credentials?: Awaited<ReturnType<typeof createIdentityProfile>>) {
  const identity = credentials ?? await createIdentityProfile({ deviceLabel: "cli-fixture" });
  const record = createSignedDeviceRecord(identity.identityId, identity.deviceId, identity.devicePubKey, identity.identitySecretKey, "cli-fixture");
  const store = new EncryptedSqliteStore(join(directory(), "remote.sqlite"), randomBytes(32)); opened.push(store);
  const client = await SignalClient.create(store, signalAddressForDevice(record.identity_id, record.device_id));
  const wire = await exportSignedSignalBundleV2(client, { deviceRecord: record, deviceSecretKey: decodeBase64Url(identity.deviceSecretKey) });
  return { identity, wire, card: { type: "echolet_contact_card", version: 1, signal_bundle: wire } };
}

describe("CLI durable profile and mutual trust", () => {
  it("initializes once, preserves all public identities after reopen and rejects wrong key without replacement", async () => {
    const a = await local(), first = await a.profile.exportContact();
    await a.profile.close();
    const db = join(a.profileDir, "client.sqlite"), before = readFileSync(db);
    await expect(openProfile({ profileDir: a.profileDir, environment: { ECHOLET_TEST_KEY: randomBytes(32).toString("base64url") }, initialize: true })).rejects.toThrow();
    expect(readFileSync(db)).toEqual(before);
    const reopened = await openProfile({ profileDir: a.profileDir, environment: a.environment }); opened.push(reopened);
    const second = await reopened.exportContact();
    expect(second.signal_bundle.device_record).toEqual(first.signal_bundle.device_record);
    expect(second.signal_bundle.signal_identity_key).toBe(first.signal_bundle.signal_identity_key);
    expect(second.signal_bundle.registration_id).toBe(first.signal_bundle.registration_id);
    expect(readFileSync(join(a.profileDir, "config.json"), "utf8")).not.toContain(a.environment.ECHOLET_TEST_KEY);
  });

  it("exports a complete independently verifiable contact card with no private material", async () => {
    const a = await local(), card = await a.profile.exportContact();
    expect(Object.keys(card).sort()).toEqual(["signal_bundle", "type", "version"]);
    expect(card.type).toBe("echolet_contact_card"); expect(card.version).toBe(1);
    const wire = SignalPreKeyBundleV2Schema.parse(card.signal_bundle);
    expect(wire.one_time_prekey).not.toBeNull();
    expect(() => importVerifiedSignalBundleV2(JSON.parse(JSON.stringify(wire)), { identityId: wire.device_record.identity_id, deviceId: wire.device_record.device_id })).not.toThrow();
    expect(JSON.stringify(card)).not.toMatch(/identitySecretKey|deviceSecretKey|sessionSecretKey|"seed"|private_key/);
  });

  it("requires explicit confirmation of all four exact identifiers before pinning", async () => {
    const a = await local(), b = await remote(), declined = vi.fn(async () => false);
    await expect(a.profile.importContact(b.card, {})).rejects.toThrow();
    await a.profile.importContact(b.card, { confirm: declined });
    expect(await a.profile.listContacts()).toEqual([]);
    expect(declined).toHaveBeenCalledWith(expect.objectContaining({ identity_id: b.identity.identityId, device_id: b.identity.deviceId, device_pubkey: b.identity.devicePubKey, signal_identity_key: b.wire.signal_identity_key }));
    await a.profile.importContact(b.card, { confirm: async () => true });
    expect(await a.profile.listContacts()).toEqual([expect.objectContaining({ identity_id: b.identity.identityId, device_id: b.identity.deviceId, signal_identity_key: b.wire.signal_identity_key })]);
  });

  it("mutually pins native Signal identities durably without establishing sessions or consuming prekeys", async () => {
    const a = await local(), b = await local();
    const ac = await a.profile.exportContact(), bc = await b.profile.exportContact();
    await a.profile.importContact(bc, { confirm: async () => true });
    await b.profile.importContact(ac, { confirm: async () => true });
    for (const [owner, card] of [[a, bc], [b, ac]] as const) {
      await owner.profile.close();
      const store = new EncryptedSqliteStore(join(owner.profileDir, "client.sqlite"), owner.key); opened.push(store);
      const record = card.signal_bundle.device_record, address = signalAddressForDevice(record.identity_id, record.device_id);
      await store.transaction((tx) => {
        expect(Buffer.from(tx.get(`trust:${JSON.stringify([address.name, address.deviceId])}`)!).toString("base64url")).toBe(card.signal_bundle.signal_identity_key);
        expect(tx.keys("session:")).toEqual([]);
        expect(tx.get("pre:1")).toBeDefined();
      });
    }
  });

  it("rejects forged root/device/native signatures and changed valid Signal identities without changing trust", async () => {
    const a = await local(), b = await remote();
    await a.profile.importContact(b.card, { confirm: async () => true });
    const before = await a.profile.listContacts();
    const variants = ["root", "device", "native"] as const;
    for (const variant of variants) {
      const card = JSON.parse(JSON.stringify(b.card));
      if (variant === "root") card.signal_bundle.device_record.signature = Buffer.alloc(64).toString("base64url");
      else if (variant === "device") card.signal_bundle.signature = Buffer.alloc(64).toString("base64url");
      else {
        card.signal_bundle.kyber_prekey.signature = Buffer.alloc(64).toString("base64url");
        card.signal_bundle.signature = signUtf8Message(signalBundleV2SigningText(card.signal_bundle), decodeBase64Url(b.identity.deviceSecretKey));
      }
      const confirm = vi.fn(async () => true);
      await expect(a.profile.importContact(card, { confirm })).rejects.toThrow();
      expect(confirm).not.toHaveBeenCalled();
      expect(await a.profile.listContacts()).toEqual(before);
    }
    const changed = await remote(b.identity);
    await expect(a.profile.importContact(changed.card, { confirm: async () => true })).rejects.toThrow();
    expect(await a.profile.listContacts()).toEqual(before);
  });

  it("normal summaries and diagnostics do not expose secrets or encrypted history payloads", async () => {
    const a = await local(), marker = "SYNTHETIC_PLAINTEXT_MUST_NOT_APPEAR";
    await a.profile.close();
    const store = new EncryptedSqliteStore(join(a.profileDir, "client.sqlite"), a.key);
    await store.transaction((tx) => tx.set("history:test", new TextEncoder().encode(JSON.stringify({ body: marker })))); await store.close();
    const profile = await openProfile({ profileDir: a.profileDir, environment: a.environment }); opened.push(profile);
    const log = vi.spyOn(console, "log").mockImplementation(() => {}), error = vi.spyOn(console, "error").mockImplementation(() => {});
    const result = JSON.stringify([await profile.summary(), await profile.diagnostics(), log.mock.calls, error.mock.calls]);
    expect(result).not.toContain(marker); expect(result).not.toContain(a.environment.ECHOLET_TEST_KEY);
    expect(result).not.toMatch(/identitySecretKey|deviceSecretKey|sessionSecretKey|"seed"|private_key/);
    expect(readFileSync(join(a.profileDir, "client.sqlite")).includes(Buffer.from(marker))).toBe(false);
  });
});
