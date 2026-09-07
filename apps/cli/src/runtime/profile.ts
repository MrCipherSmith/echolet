import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, linkSync, unlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import { createIdentityProfile, createSignedDeviceRecord } from "@echolet/client-core";
import { decodeBase64Url, deriveMailboxId, createMailboxCreateChallengeMessage, createMailboxChallengeMessage, createMailboxAckMessage, hashMailboxEnvelopeCiphertext, signMailboxEnvelopeMessage, signUtf8Message } from "@echolet/crypto-core";
import { DeviceRecordSchema, SignalPreKeyBundleV2Schema, signalAddressForDevice, type DeviceRecord, type SignalPreKeyBundleV2 } from "@echolet/protocol";
import { EncryptedSqliteStore, SignalClient, exportSignedSignalBundleV2, importVerifiedSignalBundleV2, type StoreTransaction, type TransactionalStore } from "@echolet/session-node";
import { ConfigurationError, parseClientConfig, readStoreKey, type ClientConfig, type Environment } from "./config";

export class ProfileError extends Error {
  readonly code = "PROFILE_REJECTED";
}

/**
 * Local durable-storage failure. Raised only when the store itself refuses to begin, commit or
 * read a transaction; failures raised by the transactional operation keep their own type so that
 * validation, trust and native decrypt rejections stay distinguishable from persistence loss.
 */
export class PersistenceError extends Error {
  readonly code = "PERSISTENCE_FAILURE";
  constructor() { super("Local profile persistence failed"); this.name = "PersistenceError"; }
}

const metadataKey = "cli:profile";
const publicationKey = "cli:publication";
const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const decode = (value: Uint8Array): unknown => JSON.parse(new TextDecoder().decode(value));
const metadataSchema = z.object({
  version: z.literal(1), profile_id: z.string().uuid(), seed: z.string().min(1),
  // Preserve the legacy signature's nested property ordering.
  device_record: z.custom<DeviceRecord>((value) => DeviceRecordSchema.strict().safeParse(value).success),
}).strict();
const cardSchema = z.object({
  type: z.literal("echolet_contact_card"), version: z.literal(1),
  display_name: z.string().min(1).max(128).optional(),
  signal_bundle: SignalPreKeyBundleV2Schema.refine((bundle) => bundle.one_time_prekey !== null),
}).strict();
const contactSchema = z.object({
  identity_id: z.string(), device_id: z.string().uuid(),
  device_pubkey: z.string(), signal_identity_key: z.string(),
}).strict();
// Store the exact signed bundle without reconstructing it: the relay accepts one bundle per
// reserved one-time prekey, so a retry must resubmit the byte-identical publication.
const publicationSchema = z.object({
  version: z.literal(1),
  bundle: z.custom<SignalPreKeyBundleV2>((value) => SignalPreKeyBundleV2Schema.safeParse(value).success, "Invalid stored publication bundle"),
}).strict();
/** The envelope fields bound into the sender transcript the relay verifies. */
export interface MailboxEnvelopeBinding {
  recipientMailboxId: string;
  envelopeId: string;
  senderIdentityId: string;
  senderDeviceId: string;
  ciphertext: string;
  createdAtMs: number;
  expiresAtMs: number;
}
export type ContactIdentifiers = z.infer<typeof contactSchema>;
export type ContactCard = z.infer<typeof cardSchema>;
type Metadata = z.infer<typeof metadataSchema>;

/** Compose existing Signal operations inside a caller-owned atomic transaction. */
function within(tx: StoreTransaction): TransactionalStore {
  return { transaction: async (operation) => operation(tx) };
}

function readMetadata(tx: StoreTransaction): Metadata {
  const bytes = tx.get(metadataKey);
  if (!bytes) throw new ProfileError("Missing profile identity; refusing replacement");
  return metadataSchema.parse(decode(bytes));
}

export interface OpenProfileOptions {
  profileDir: string;
  config?: unknown;
  environment?: Environment;
  initialize?: boolean;
}

export class Profile {
  /**
   * Single durable-storage boundary. A rejection raised by `operation` keeps its own type; every
   * other rejection is a local storage failure and is reported as such.
   */
  private transact<T>(operation: (tx: StoreTransaction) => T | Promise<T>): Promise<T> {
    let raised: { error: unknown } | undefined;
    return this.store.transaction(async (tx) => {
      try { return await operation(tx); }
      catch (error) { raised = { error }; throw error; }
    }).catch((error: unknown) => {
      if (raised && Object.is(raised.error, error)) throw error;
      throw new PersistenceError();
    });
  }

  /** Sign only mailbox operations; no private material leaves this boundary. */
  async mailboxAuthorization(operation: { kind: "challenge" } | { kind: "poll"; challengeId: string; nonce: string } | { kind: "ack"; envelopeIds: string[] }) {
    const owned = structuredClone(operation);
    return this.transact(async (tx) => {
      const metadata = readMetadata(tx), record = metadata.device_record;
      const identity = await createIdentityProfile({ seed: metadata.seed, deviceLabel: "cli-device" });
      const key = decodeBase64Url(identity.deviceSecretKey), mailboxId = deriveMailboxId(record.identity_id);
      try {
        const text = owned.kind === "challenge" ? createMailboxCreateChallengeMessage(mailboxId, record.device_id)
          : owned.kind === "poll" ? createMailboxChallengeMessage(owned.challengeId, mailboxId, record.device_id, owned.nonce)
          : createMailboxAckMessage(mailboxId, record.device_id, owned.envelopeIds);
        return { recipient_mailbox_id: mailboxId, device_id: record.device_id, signature: signUtf8Message(text, key) };
      } finally { key.fill(0); }
    });
  }

  /**
   * Sign an outbound mailbox envelope's sender transcript. Same boundary as `mailboxAuthorization`:
   * the device key is derived from the profile's own seed inside the transaction, used once, and
   * zeroed. Only the transcript's bound fields cross the boundary, never key material.
   */
  private async signEnvelopeBinding(tx: StoreTransaction, binding: MailboxEnvelopeBinding): Promise<string> {
    const metadata = readMetadata(tx);
    const identity = await createIdentityProfile({ seed: metadata.seed, deviceLabel: "cli-device" });
    const key = decodeBase64Url(identity.deviceSecretKey);
    try {
      return signMailboxEnvelopeMessage(
        binding.recipientMailboxId, binding.envelopeId, binding.senderIdentityId, binding.senderDeviceId,
        hashMailboxEnvelopeCiphertext(binding.ciphertext), binding.createdAtMs, binding.expiresAtMs, key,
      );
    } finally { key.fill(0); }
  }

  /**
   * Internal runtime boundary: the callback must not retain transactional objects.
   *
   * `signEnvelope` is offered lazily rather than eagerly derived, so the read-only callers pay
   * nothing for it; it is the only way an envelope built inside this transaction can carry the
   * sender binding `/v1/messages/send` now requires (T50, finding T49-F-001).
   */
  withRuntime<T>(operation: (
    tx: StoreTransaction,
    client: SignalClient,
    local: DeviceRecord,
    signEnvelope: (binding: MailboxEnvelopeBinding) => Promise<string>,
  ) => Promise<T> | T): Promise<T> {
    return this.transact(async (tx) => {
      const local = readMetadata(tx).device_record;
      const client = await SignalClient.create(within(tx), signalAddressForDevice(local.identity_id, local.device_id));
      return operation(tx, client, local, (binding) => this.signEnvelopeBinding(tx, binding));
    });
  }

  constructor(private readonly store: EncryptedSqliteStore, private readonly config: ClientConfig) {}

  /** Configured upper bound on the envelopes requested in one mailbox poll. */
  get pollBatchSize(): number { return this.config.poll_batch_size; }

  /** Sign a new bundle from the current durable Signal records; never leaves the transaction. */
  private async signBundle(tx: StoreTransaction): Promise<SignalPreKeyBundleV2> {
    const metadata = readMetadata(tx);
    const identity = await createIdentityProfile({ seed: metadata.seed, deviceLabel: "cli-device" });
    const client = await SignalClient.create(within(tx), signalAddressForDevice(metadata.device_record.identity_id, metadata.device_record.device_id));
    const key = decodeBase64Url(identity.deviceSecretKey);
    try {
      return await exportSignedSignalBundleV2(client, { deviceRecord: metadata.device_record, deviceSecretKey: key });
    } finally { key.fill(0); }
  }

  async exportContact(): Promise<ContactCard> {
    return this.transact(async (tx) => cardSchema.parse({ type: "echolet_contact_card", version: 1, signal_bundle: await this.signBundle(tx) }));
  }

  /**
   * The exact signed bundle offered to the relay. It is written durably before any publication
   * attempt and returned unchanged afterwards, so a lost response is retried with the identical
   * bundle_id around the identical reserved one-time prekey.
   */
  async publicationBundle(): Promise<SignalPreKeyBundleV2> {
    return this.transact(async (tx) => {
      const stored = tx.get(publicationKey);
      if (stored) return publicationSchema.parse(decode(stored)).bundle;
      const bundle = await this.signBundle(tx);
      tx.set(publicationKey, encode(publicationSchema.parse({ version: 1, bundle })));
      return bundle;
    });
  }

  /**
   * Explicit, separate allocation: a newly generated one-time prekey and a new independently
   * signed bundle. Never performed implicitly by a publication retry.
   */
  async rotatePublicationBundle(): Promise<SignalPreKeyBundleV2> {
    return this.transact(async (tx) => {
      const metadata = readMetadata(tx);
      const client = await SignalClient.create(within(tx), signalAddressForDevice(metadata.device_record.identity_id, metadata.device_record.device_id));
      await client.rotateOneTimePreKey();
      const bundle = await this.signBundle(tx);
      tx.set(publicationKey, encode(publicationSchema.parse({ version: 1, bundle })));
      return bundle;
    });
  }

  async importContact(input: unknown, options: { confirm?: (identifiers: Readonly<ContactIdentifiers>) => boolean | Promise<boolean> }): Promise<boolean> {
    // Own the input before the confirmation callback can yield or mutate it.
    const card = cardSchema.parse(JSON.parse(JSON.stringify(input)));
    const wire = card.signal_bundle, record = wire.device_record;
    const verified = importVerifiedSignalBundleV2(wire, { identityId: record.identity_id, deviceId: record.device_id });
    const identifiers: ContactIdentifiers = {
      identity_id: record.identity_id, device_id: record.device_id,
      device_pubkey: record.device_pubkey, signal_identity_key: wire.signal_identity_key,
    };
    if (typeof options.confirm !== "function") throw new ProfileError("Explicit contact confirmation is required");
    if (await options.confirm(Object.freeze({ ...identifiers })) !== true) return false;
    return this.transact(async (tx) => {
      const key = `cli:contact:${identifiers.identity_id}`;
      const previous = tx.get(key);
      if (previous && JSON.stringify(contactSchema.parse(decode(previous))) !== JSON.stringify(identifiers)) {
        throw new ProfileError("Contact identifiers changed; replacement is not supported");
      }
      const metadata = readMetadata(tx);
      const client = await SignalClient.create(within(tx), signalAddressForDevice(metadata.device_record.identity_id, metadata.device_record.device_id));
      await client.approveRemote(verified.address, verified.bundle.identityKey().serialize());
      tx.set(key, encode(identifiers));
      return true;
    });
  }

  listContacts(): Promise<ContactIdentifiers[]> {
    return this.transact((tx) => tx.keys("cli:contact:").sort().map((key) => contactSchema.parse(decode(tx.get(key)!))));
  }

  summary() {
    return this.transact((tx) => {
      const metadata = readMetadata(tx);
      return { profile_id: this.config.profile_id, identity_id: metadata.device_record.identity_id, device_id: metadata.device_record.device_id, contact_count: tx.keys("cli:contact:").length };
    });
  }

  async diagnostics() {
    return { ...await this.summary(), storage: "encrypted", runtime: "node-reference" };
  }

  close(): Promise<void> { return this.store.close(); }
}

export async function openProfile(options: OpenProfileOptions): Promise<Profile> {
  const configPath = join(resolve(options.profileDir), "config.json");
  const hasConfig = existsSync(configPath);
  if (!hasConfig && (!options.initialize || options.config === undefined)) throw new ConfigurationError("Profile initialization requires configuration");
  const config = parseClientConfig(hasConfig ? JSON.parse(readFileSync(configPath, "utf8")) : options.config);
  if (hasConfig && options.config !== undefined && JSON.stringify(parseClientConfig(options.config)) !== JSON.stringify(config)) {
    throw new ConfigurationError("Existing profile configuration cannot be replaced");
  }
  const key = readStoreKey(config, options.environment ?? process.env);
  const databasePath = resolve(options.profileDir, config.database_path);
  let store: EncryptedSqliteStore | undefined;
  try {
    if (!existsSync(databasePath) && (hasConfig || !options.initialize)) throw new ProfileError("Profile database is missing; refusing replacement");
    mkdirSync(dirname(databasePath), { recursive: true, mode: 0o700 });
    store = new EncryptedSqliteStore(databasePath, key);
    await store.transaction(async (tx) => {
      if (!tx.get(metadataKey)) {
        if (!options.initialize || tx.keys().length) throw new ProfileError("Incomplete profile; refusing replacement");
        const identity = await createIdentityProfile({ deviceLabel: "cli-device" });
        const record = createSignedDeviceRecord(identity.identityId, identity.deviceId, identity.devicePubKey, identity.identitySecretKey, "cli-device");
        await SignalClient.create(within(tx), signalAddressForDevice(record.identity_id, record.device_id));
        tx.set(metadataKey, encode({ version: 1, profile_id: config.profile_id, seed: identity.seed, device_record: record } satisfies Metadata));
      }
      const metadata = readMetadata(tx);
      if (metadata.profile_id !== config.profile_id) throw new ProfileError("Database belongs to another profile");
      await SignalClient.create(within(tx), signalAddressForDevice(metadata.device_record.identity_id, metadata.device_record.device_id));
    });
    if (!hasConfig) {
      mkdirSync(dirname(configPath), { recursive: true, mode: 0o700 });
      const temporary = `${configPath}.${randomUUID()}.tmp`;
      writeFileSync(temporary, JSON.stringify(config, null, 2), { flag: "wx", mode: 0o600, flush: true });
      try { linkSync(temporary, configPath); } finally { unlinkSync(temporary); }
    }
    return new Profile(store, config);
  } catch (error) {
    await store?.close();
    throw error;
  } finally { key.fill(0); }
}
