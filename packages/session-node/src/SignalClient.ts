import { createHash, randomInt } from "node:crypto";
import * as L from "@signalapp/libsignal-client";
import type { StoreTransaction, TransactionalStore } from "./store";

export interface DeviceAddress {
  name: string;
  deviceId: number;
}
export interface StoredCiphertext {
  messageId: string;
  type: number;
  body: Uint8Array;
}
interface DeviceMetadata {
  address: DeviceAddress;
  registrationId: number;
}
interface OutboxRecord {
  messageId: string;
  type: number;
  body: string;
  contentHash: string;
}
const encode = (value: unknown): Uint8Array =>
  new TextEncoder().encode(JSON.stringify(value));
const decode = <T>(value: Uint8Array): T =>
  JSON.parse(new TextDecoder().decode(value)) as T;
const binary = (value: Uint8Array): Uint8Array<ArrayBuffer> =>
  Uint8Array.from(value);
const addressKey = (value: DeviceAddress): string =>
  JSON.stringify([value.name, value.deviceId]);
const protocolAddress = (value: DeviceAddress): L.ProtocolAddress =>
  L.ProtocolAddress.new(value.name, value.deviceId);
function requireRecord(
  tx: StoreTransaction,
  key: string,
): Uint8Array<ArrayBuffer> {
  const value = tx.get(key);
  if (!value) throw new Error(`Missing session record: ${key.split(":")[0]}`);
  return binary(value);
}
function assertAddress(address: DeviceAddress): void {
  if (
    !address.name ||
    address.name.length > 256 ||
    !Number.isInteger(address.deviceId) ||
    address.deviceId < 1 ||
    address.deviceId > 127
  )
    throw new Error("Invalid device address");
}
function assertMessageId(id: string): void {
  if (!id || id.length > 256) throw new Error("Invalid message id");
}
const remoteKey = (address: L.ProtocolAddress): string =>
  addressKey({ name: address.name(), deviceId: address.deviceId() });

/** Pointer to the one-time prekey currently offered in `publicBundle()`; absent means the initial `pre:1`. */
const oneTimePreKeyPointer = "pre-current";
const maxOneTimePreKeyId = 0xffffff;
function currentOneTimePreKeyId(tx: StoreTransaction): number {
  const value = tx.get(oneTimePreKeyPointer);
  if (!value) return 1;
  const id = decode<unknown>(binary(value));
  if (
    typeof id !== "number" ||
    !Number.isSafeInteger(id) ||
    id < 1 ||
    id > maxOneTimePreKeyId
  )
    throw new Error("Invalid one-time prekey pointer");
  return id;
}

/** All callbacks operate on one caller-owned transaction; never keep mutable native records between calls. */
class Records
  extends L.IdentityKeyStore
  implements
    L.SessionStore,
    L.PreKeyStore,
    L.SignedPreKeyStore,
    L.KyberPreKeyStore
{
  constructor(private readonly tx: StoreTransaction) {
    super();
  }
  async getIdentityKey(): Promise<L.PrivateKey> {
    return L.PrivateKey.deserialize(requireRecord(this.tx, "identity"));
  }
  async getLocalRegistrationId(): Promise<number> {
    return decode<DeviceMetadata>(requireRecord(this.tx, "device"))
      .registrationId;
  }
  async getIdentity(address: L.ProtocolAddress): Promise<L.PublicKey | null> {
    const value = this.tx.get(`trust:${remoteKey(address)}`);
    return value ? L.PublicKey.deserialize(binary(value)) : null;
  }
  async isTrustedIdentity(
    address: L.ProtocolAddress,
    key: L.PublicKey,
  ): Promise<boolean> {
    return (await this.getIdentity(address))?.equals(key) ?? false;
  }
  async saveIdentity(
    address: L.ProtocolAddress,
    key: L.PublicKey,
  ): Promise<L.IdentityChange> {
    if (!(await this.isTrustedIdentity(address, key)))
      throw new Error("Remote identity is not explicitly approved");
    return L.IdentityChange.NewOrUnchanged;
  }
  async getSession(
    address: L.ProtocolAddress,
  ): Promise<L.SessionRecord | null> {
    const value = this.tx.get(`session:${remoteKey(address)}`);
    return value ? L.SessionRecord.deserialize(binary(value)) : null;
  }
  async saveSession(
    address: L.ProtocolAddress,
    record: L.SessionRecord,
  ): Promise<void> {
    this.tx.set(`session:${remoteKey(address)}`, record.serialize());
  }
  async getExistingSessions(
    addresses: L.ProtocolAddress[],
  ): Promise<L.SessionRecord[]> {
    return Promise.all(
      addresses.map(async (address) => {
        const record = await this.getSession(address);
        if (!record) throw new Error("Missing session");
        return record;
      }),
    );
  }
  async getPreKey(id: number): Promise<L.PreKeyRecord> {
    return L.PreKeyRecord.deserialize(requireRecord(this.tx, `pre:${id}`));
  }
  async savePreKey(id: number, record: L.PreKeyRecord): Promise<void> {
    this.tx.set(`pre:${id}`, record.serialize());
  }
  async removePreKey(id: number): Promise<void> {
    this.tx.delete(`pre:${id}`);
  }
  async getSignedPreKey(id: number): Promise<L.SignedPreKeyRecord> {
    return L.SignedPreKeyRecord.deserialize(
      requireRecord(this.tx, `signed:${id}`),
    );
  }
  async saveSignedPreKey(
    id: number,
    record: L.SignedPreKeyRecord,
  ): Promise<void> {
    this.tx.set(`signed:${id}`, record.serialize());
  }
  async getKyberPreKey(id: number): Promise<L.KyberPreKeyRecord> {
    return L.KyberPreKeyRecord.deserialize(
      requireRecord(this.tx, `kyber:${id}`),
    );
  }
  async saveKyberPreKey(
    id: number,
    record: L.KyberPreKeyRecord,
  ): Promise<void> {
    this.tx.set(`kyber:${id}`, record.serialize());
  }
  async markKyberPreKeyUsed(
    id: number,
    signedId: number,
    baseKey: L.PublicKey,
  ): Promise<void> {
    const key = `used:${id}:${signedId}:${Buffer.from(baseKey.serialize()).toString("base64")}`;
    if (this.tx.get(key))
      throw new Error("Kyber prekey already used for this base key");
    this.tx.set(key, Uint8Array.of(1));
  }
}

/** Node-only reference integration. This does not implement the existing Echolet relay wire protocol. */
export class SignalClient {
  private constructor(
    private readonly store: TransactionalStore,
    readonly address: Readonly<DeviceAddress>,
  ) {}
  static async create(
    store: TransactionalStore,
    address: DeviceAddress,
  ): Promise<SignalClient> {
    assertAddress(address);
    const ownedAddress = Object.freeze({ ...address });
    await store.transaction((tx) => {
      const stored = tx.get("device");
      if (stored) {
        const metadata = decode<DeviceMetadata>(stored);
        if (addressKey(metadata.address) !== addressKey(ownedAddress))
          throw new Error("Store belongs to another local device");
        L.PrivateKey.deserialize(requireRecord(tx, "identity"));
        return;
      }
      if (tx.keys().length)
        throw new Error("Incomplete device store; refusing identity reset");
      const identity = L.PrivateKey.generate(),
        pre = L.PrivateKey.generate(),
        signed = L.PrivateKey.generate(),
        kyber = L.KEMKeyPair.generate();
      tx.set(
        "device",
        encode({
          address: ownedAddress,
          registrationId: randomInt(1, 16380),
        } satisfies DeviceMetadata),
      );
      tx.set("identity", identity.serialize());
      tx.set(
        "pre:1",
        L.PreKeyRecord.new(1, pre.getPublicKey(), pre).serialize(),
      );
      tx.set(
        "signed:2",
        L.SignedPreKeyRecord.new(
          2,
          Date.now(),
          signed.getPublicKey(),
          signed,
          identity.sign(signed.getPublicKey().serialize()),
        ).serialize(),
      );
      tx.set(
        "kyber:3",
        L.KyberPreKeyRecord.new(
          3,
          Date.now(),
          kyber,
          identity.sign(kyber.getPublicKey().serialize()),
        ).serialize(),
      );
    });
    return new SignalClient(store, ownedAddress);
  }
  async publicBundle(): Promise<L.PreKeyBundle> {
    return this.store.transaction(async (tx) => {
      const records = new Records(tx),
        identity = await records.getIdentityKey(),
        signed = await records.getSignedPreKey(2),
        kyber = await records.getKyberPreKey(3);
      const preBytes = tx.get(`pre:${currentOneTimePreKeyId(tx)}`),
        pre = preBytes ? L.PreKeyRecord.deserialize(binary(preBytes)) : null;
      return L.PreKeyBundle.new(
        await records.getLocalRegistrationId(),
        this.address.deviceId,
        pre?.id() ?? null,
        pre?.publicKey() ?? null,
        signed.id(),
        signed.publicKey(),
        signed.signature(),
        identity.getPublicKey(),
        kyber.id(),
        kyber.publicKey(),
        kyber.signature(),
      );
    });
  }
  /**
   * Explicitly allocate a fresh one-time prekey and offer it from `publicBundle()`.
   * Previously allocated prekey records are retained so in-flight sessions still resolve.
   */
  async rotateOneTimePreKey(): Promise<number> {
    return this.store.transaction((tx) => {
      requireRecord(tx, "identity");
      const allocated = tx
        .keys("pre:")
        .map((key) => Number.parseInt(key.slice("pre:".length), 10))
        .filter((id) => Number.isSafeInteger(id) && id >= 1);
      const next = Math.max(currentOneTimePreKeyId(tx), ...allocated) + 1;
      if (next > maxOneTimePreKeyId)
        throw new Error("One-time prekey identifiers are exhausted");
      const pre = L.PrivateKey.generate();
      tx.set(
        `pre:${next}`,
        L.PreKeyRecord.new(next, pre.getPublicKey(), pre).serialize(),
      );
      tx.set(oneTimePreKeyPointer, encode(next));
      return next;
    });
  }
  /** Caller must verify this exact key out of band. Existing approvals cannot be replaced silently. */
  async approveRemote(
    remote: DeviceAddress,
    serializedIdentity: Uint8Array,
  ): Promise<void> {
    assertAddress(remote);
    const address = { ...remote },
      key = L.PublicKey.deserialize(binary(serializedIdentity));
    await this.store.transaction(async (tx) => {
      const records = new Records(tx),
        old = await records.getIdentity(protocolAddress(address));
      if (old && !old.equals(key))
        throw new Error(
          "Remote identity changed; explicit re-verification and session reset required",
        );
      tx.set(`trust:${addressKey(address)}`, key.serialize());
    });
  }
  async establish(
    remote: DeviceAddress,
    bundle: L.PreKeyBundle,
  ): Promise<void> {
    assertAddress(remote);
    const address = protocolAddress({ ...remote });
    if (bundle.deviceId() !== remote.deviceId)
      throw new Error("Bundle device does not match recipient");
    await this.store.transaction(async (tx) => {
      const records = new Records(tx);
      if (!(await records.isTrustedIdentity(address, bundle.identityKey())))
        throw new Error("Remote identity is not explicitly approved");
      if (await records.getSession(address))
        throw new Error("Session already exists; refusing implicit reset");
      await L.processPreKeyBundle(
        bundle,
        address,
        protocolAddress(this.address),
        records,
        records,
      );
    });
  }
  async encrypt(
    remote: DeviceAddress,
    messageId: string,
    plaintext: string,
  ): Promise<StoredCiphertext> {
    assertAddress(remote);
    assertMessageId(messageId);
    if (Buffer.byteLength(plaintext) > 64 * 1024)
      throw new Error("Message exceeds reference size limit");
    const address = { ...remote },
      key = `outbox:${addressKey(address)}:${messageId}`,
      payload = encode({ messageId, body: plaintext }),
      contentHash = createHash("sha256").update(payload).digest("hex");
    return this.store.transaction(async (tx) => {
      const records = new Records(tx);
      if (!(await records.getIdentity(protocolAddress(address))))
        throw new Error("Remote identity is not explicitly approved");
      const previous = tx.get(key);
      if (previous) {
        const record = decode<OutboxRecord>(previous);
        if (record.contentHash !== contentHash)
          throw new Error("Message id already used with different content");
        return this.outgoing(record);
      }
      const message = await L.signalEncrypt(
        payload,
        protocolAddress(address),
        protocolAddress(this.address),
        records,
        records,
      );
      const record: OutboxRecord = {
        messageId,
        type: message.type(),
        body: Buffer.from(message.serialize()).toString("base64"),
        contentHash,
      };
      tx.set(key, encode(record));
      return this.outgoing(record);
    });
  }
  async retry(
    remote: DeviceAddress,
    messageId: string,
  ): Promise<StoredCiphertext> {
    assertAddress(remote);
    assertMessageId(messageId);
    const address = { ...remote };
    return this.store.transaction((tx) => {
      requireRecord(tx, `trust:${addressKey(address)}`);
      return this.outgoing(
        decode<OutboxRecord>(
          requireRecord(tx, `outbox:${addressKey(address)}:${messageId}`),
        ),
      );
    });
  }
  async decrypt(
    remote: DeviceAddress,
    message: StoredCiphertext,
  ): Promise<string> {
    assertAddress(remote);
    assertMessageId(message.messageId);
    if (message.body.byteLength > 1024 * 1024)
      throw new Error("Ciphertext exceeds reference size limit");
    const address = { ...remote },
      messageId = message.messageId,
      type = message.type,
      body = binary(message.body);
    return this.store.transaction(async (tx) => {
      const key = `inbox:${addressKey(address)}:${messageId}`;
      if (tx.get(key)) throw new Error("Message already received");
      const records = new Records(tx),
        sender = protocolAddress(address),
        local = protocolAddress(this.address);
      let plaintext: Uint8Array;
      if (type === L.CiphertextMessageType.PreKey)
        plaintext = await L.signalDecryptPreKey(
          L.PreKeySignalMessage.deserialize(body),
          sender,
          local,
          records,
          records,
          records,
          records,
          records,
        );
      else if (type === L.CiphertextMessageType.Whisper)
        plaintext = await L.signalDecrypt(
          L.SignalMessage.deserialize(body),
          sender,
          local,
          records,
          records,
        );
      else throw new Error("Unsupported ciphertext type");
      const payload = decode<{ messageId?: unknown; body?: unknown }>(
        plaintext,
      );
      if (payload.messageId !== messageId || typeof payload.body !== "string")
        throw new Error("Authenticated message payload mismatch");
      tx.set(key, encode({ messageId, body: payload.body }));
      return payload.body;
    });
  }
  private outgoing(record: OutboxRecord): StoredCiphertext {
    return {
      messageId: record.messageId,
      type: record.type,
      body: Uint8Array.from(Buffer.from(record.body, "base64")),
    };
  }
}
