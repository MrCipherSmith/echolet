import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, linkSync, unlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import { createIdentityProfile, createSignedDeviceRecord } from "@echolet/client-core";
import { decodeBase64Url, deriveMailboxId, createMailboxCreateChallengeMessage, createMailboxChallengeMessage, createMailboxAckMessage, hashMailboxEnvelopeCiphertext, signMailboxEnvelopeMessage, signUtf8Message } from "@echolet/crypto-core";
import { DeviceRecordSchema, LIMITS, SignalPreKeyBundleV2Schema, signalAddressForDevice, type DeviceRecord, type SignalPreKeyBundleV2 } from "@echolet/protocol";
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
/**
 * How many independently signed bundles one profile keeps published.
 *
 * Read from the protocol rather than transcribed: `LIMITS.PREKEY_MIN_COUNT` was declared for
 * exactly this quantity beside `PREKEY_REFILL_THRESHOLD` and had no reader anywhere in the tree —
 * the pool was specified and never built. A second literal for one quantity is how two numbers
 * drift apart, so there is none here.
 *
 * It is a CLIENT constant. The relay neither learns it nor enforces it, in the same way
 * `LIMITS.MAX_MESSAGE_BYTES` is agreed in advance rather than negotiated on the wire.
 */
const poolTarget = LIMITS.PREKEY_MIN_COUNT;
/**
 * Where one pool member lives.
 *
 * Slot 0 keeps writing `cli:publication` with the unchanged schema and the same bytes it would have
 * had before the pool existed, because that key is the sole witness `hasPublication()` consults for
 * the send precondition; the remaining members go beside it under `cli:publication:<slot>`.
 */
const publicationSlotKey = (slot: number) => (slot === 0 ? publicationKey : `${publicationKey}:${String(slot)}`);
/**
 * An UNFINISHED re-walk of the mailbox, held as the position it has reached.
 *
 * Written by `contact import` as `"0"` (the head), ADVANCED by each page a walk fully judges, and
 * deleted the moment a walk reaches the end of the mailbox. See `requestMailboxRewalk` /
 * `pendingMailboxRewalk` / `keepMailboxRewalk` / `finishMailboxRewalk` for why it is a position and
 * no longer a flag (finding T10-F-001), and why the walk never removes it up front (finding
 * T10R3-F-001).
 */
const mailboxRewalkKey = "cli:mailbox-rewalk";
/**
 * The opaque, relay-issued decimal token a re-walk resumes strictly after; `"0"` is the head.
 *
 * It is the same token shape `cursor` and `read_through` already use on the wire
 * (`repository.DecodeMailboxCursor`, at most 15 digits), so a stored value that is not one cannot be
 * presented to the relay. Anything else - including the single `0x01` byte the flag this key used to
 * hold was written as - is read as `"0"`: an unreadable re-walk position must degrade to "walk the
 * whole mailbox again", never to "the re-walk never happened".
 */
const mailboxRewalkPosition = /^\d{1,15}$/;
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

  /**
   * Sign only mailbox operations; no private material leaves this boundary.
   *
   * A poll may carry `readThrough`, the recipient's durable read position. It is
   * signed rather than merely sent: the position decides what the recipient is
   * offered next, so an unbound value would let anyone who can reshape one poll
   * request advance a victim's mark and make the envelopes behind it unreachable
   * (T5 design §4, R-4). `createMailboxChallengeMessage` emits a distinct
   * transcript when it is present, so absent and present are different signed
   * statements.
   */
  async mailboxAuthorization(operation: { kind: "challenge" } | { kind: "poll"; challengeId: string; nonce: string; readThrough?: string } | { kind: "ack"; envelopeIds: string[] }) {
    const owned = structuredClone(operation);
    return this.transact(async (tx) => {
      const metadata = readMetadata(tx), record = metadata.device_record;
      const identity = await createIdentityProfile({ seed: metadata.seed, deviceLabel: "cli-device" });
      const key = decodeBase64Url(identity.deviceSecretKey), mailboxId = deriveMailboxId(record.identity_id);
      try {
        const text = owned.kind === "challenge" ? createMailboxCreateChallengeMessage(mailboxId, record.device_id)
          : owned.kind === "poll" ? createMailboxChallengeMessage(owned.challengeId, mailboxId, record.device_id, owned.nonce, owned.readThrough)
          : createMailboxAckMessage(mailboxId, record.device_id, owned.envelopeIds);
        return { recipient_mailbox_id: mailboxId, device_id: record.device_id, signature: signUtf8Message(text, key) };
      } finally { key.fill(0); }
    });
  }

  /**
   * Record that the next mailbox walk must start from the head of the mailbox
   * rather than from the relay-held read position.
   *
   * This is the one piece of read-position state that is kept locally, and it is
   * deliberately not the position itself (T5 design §4, R-4 / finding T6-F-005:
   * a poll that writes to the store breaks F-012's store-identity guarantee, and
   * the relay is the durable holder of the mark, which is what makes it survive a
   * process kill). It is written by `contact import`, which is an OFFLINE trust
   * operation and must stay one — no relay request is made here — and it exists
   * because importing a card is the exact event that changes the verdict for a
   * `CONTACT_NOT_TRUSTED` envelope the walk has already passed.
   */
  requestMailboxRewalk(): Promise<void> {
    return this.transact((tx) => { tx.set(mailboxRewalkKey, new TextEncoder().encode("0")); });
  }

  /**
   * Report a pending re-walk as the position it resumes strictly after, WITHOUT consuming it.
   *
   * Peek, not take (finding T10R3-F-001). This used to delete the position before handing it to the
   * walk, and `keepMailboxRewalk` wrote it back only once the page loop returned - so the whole
   * walk was a window in which the position existed in no durable place, and a process that ended
   * inside it (`inbound.ts` names an operator's Ctrl-C as a NORMAL interruption) silently dropped
   * the recovery the operator had asked for. The relay-held mark is already past the envelope the
   * import was performed for, every later poll is cursorless and resumes after it, and nothing
   * tells the operator anything happened.
   *
   * Nothing is removed here, so the position is never absent while a walk that owns it is in
   * flight. It is advanced per fully judged page by `keepMailboxRewalk` and removed only by
   * `finishMailboxRewalk`, at the end of the mailbox - which is what keeps finding T6-F-004 closed:
   * the position still does not survive its own SUCCESSFUL walk.
   *
   * This reads and writes nothing at all, so an ordinary poll still leaves the encrypted store
   * byte-identical (F-012).
   */
  pendingMailboxRewalk(): Promise<string | undefined> {
    return this.transact((tx) => {
      const stored = tx.get(mailboxRewalkKey);
      if (!stored) return undefined;
      const position = new TextDecoder().decode(stored);
      return mailboxRewalkPosition.test(position) ? position : "0";
    });
  }

  /**
   * Advance an UNFINISHED re-walk to the position the walk has now reached.
   *
   * This is the durable re-walk floor finding T10-F-001 is about. The re-walk is the design's own
   * recovery path for R-5 - the one thing that makes a durable read mark safe for an envelope
   * refused as CONTACT_NOT_TRUSTED before its sender's card was imported - and it is bounded by the
   * same `maxPollPagesPerPoll` liveness valve as any other walk. Before this, the request was
   * consumed whether or not the walk had reached the end of the mailbox: past 16 pages of poison the
   * truncated re-walk never reached the envelope, the mark was already past it, every later poll
   * resumed after it, and the message was lost permanently. Re-requesting a walk from the head
   * instead would loop forever without progressing, which is why what is kept is a POSITION.
   *
   * Since finding T10R3-F-001 it is called per fully judged PAGE rather than once at the end of the
   * walk, which is what makes the re-walk crash-safe: the store transaction replaces one position
   * with a later one, so at every instant durable storage holds a position at or BEHIND where the
   * walk truly got to. An interruption therefore costs repeated work, never a lost message.
   *
   * It is written only while a re-walk is in flight, so the F-012 store-identity guarantee for an
   * ordinary poll is untouched, and it is only ever a token the relay itself issued for a page this
   * walk actually received and fully judged - the same rule that bounds `read_through` (design §4,
   * R-4).
   */
  keepMailboxRewalk(position: string): Promise<void> {
    const kept = mailboxRewalkPosition.test(position) ? position : "0";
    return this.transact((tx) => { tx.set(mailboxRewalkKey, new TextEncoder().encode(kept)); });
  }

  /**
   * End a re-walk that has reached the END of the mailbox, and nothing else.
   *
   * This is the sole place the position is removed, and the condition is the sole condition under
   * which there is nothing left to re-walk: the relay reported no continuation, so this walk was
   * offered and judged every envelope the mailbox holds. It is the whole of finding T6-F-004 - a
   * re-walk position that outlived its own successful walk would restart every later poll at the
   * same place and reinstate the entire flooding class while every unit test still passed - and it
   * is why making the re-walk crash-safe could not be done by simply never clearing it.
   */
  finishMailboxRewalk(): Promise<void> {
    return this.transact((tx) => { tx.delete(mailboxRewalkKey); });
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
   * Whether `relay publish` has ever been ATTEMPTED for this profile.
   *
   * This is the deliberately CONSERVATIVE reading of the publication precondition. `cli:publication`
   * is slot 0 of the publication pool, written by `publicationBundle()`, by the pool fill and by
   * `rotatePublicationBundle()` — reached only from `publish()` and `rotateBundle()` — and it is
   * written inside the transaction that precedes the relay call, so its absence is durable proof
   * that no publication was ever offered. Only under that proof is a mailbox deposit CERTAIN to be
   * refused: since T50 `/v1/messages/send` authenticates the sender against an already-published,
   * root-signed device record.
   *
   * The converse is intentionally not claimed. A profile whose publication the relay rejected, or
   * whose publish response was lost, HAS attempted it, and this answers `true` for it — local state
   * cannot tell those apart from a stored record, and refusing only the provably doomed send is what
   * keeps this predicate from ever blocking a send that could have succeeded.
   *
   * The stored bytes are never decoded here: presence is the whole question, and a publication that
   * fails to parse is still an attempt.
   */
  hasPublication(): Promise<boolean> {
    return this.transact((tx) => tx.get(publicationKey) !== undefined);
  }

  /**
   * The exact signed bundle offered to the relay for slot 0, the pool's anchor. It is written
   * durably before any publication attempt and returned unchanged afterwards, so a lost response is
   * retried with the identical bundle_id around the identical reserved one-time prekey.
   */
  async publicationBundle(): Promise<SignalPreKeyBundleV2> {
    return this.transact(async (tx) => this.readPublicationSlot(tx, 0) ?? this.mintPublicationSlot(tx, 0, false));
  }

  /** One pool slot's durable member, or `undefined` when the slot is empty. */
  private readPublicationSlot(tx: StoreTransaction, slot: number): SignalPreKeyBundleV2 | undefined {
    const stored = tx.get(publicationSlotKey(slot));
    return stored ? publicationSchema.parse(decode(stored)).bundle : undefined;
  }

  /**
   * Allocate one slot's bundle and store it durably BEFORE it can be offered to anyone.
   *
   * `rotate` allocates a fresh one-time prekey first, and is false only for the very first bundle a
   * profile ever produces — the one signed around the initial prekey, exactly as before the pool
   * existed. Every other member must carry key material of its own: the relay reserves a one-time
   * prekey permanently and refuses a second bundle built around one it already holds, and two
   * members sharing a prekey would collapse the pool back towards a pool of one.
   */
  private async mintPublicationSlot(tx: StoreTransaction, slot: number, rotate: boolean): Promise<SignalPreKeyBundleV2> {
    if (rotate) {
      const record = readMetadata(tx).device_record;
      const client = await SignalClient.create(within(tx), signalAddressForDevice(record.identity_id, record.device_id));
      // Allocation only. The previously allocated `pre:` records are RETAINED, which is what keeps
      // a first contact against an earlier member decryptable days later; nothing here prunes them.
      await client.rotateOneTimePreKey();
    }
    const bundle = await this.signBundle(tx);
    tx.set(publicationSlotKey(slot), encode(publicationSchema.parse({ version: 1, bundle })));
    return bundle;
  }

  /**
   * The whole published pool, completed: N durable members indexed by slot.
   *
   * Each member is an independent publication — its own bundle id, its own reserved one-time prekey,
   * its own signature over the same device record — because a claim consumes one member rather than
   * the publication. Stored members are returned byte-identical on every call, so the lost-response
   * retry guarantee that used to belong to one publication now belongs to each of them.
   */
  async publicationPool(): Promise<SignalPreKeyBundleV2[]> {
    return (await this.restorePublicationPool()).members;
  }

  /**
   * The same fill, reporting how many slots this call had to allocate — what `relay publish` tells
   * the operator it minted.
   *
   * Empty slots are filled from the HIGHEST index down, so slot 0 carries the youngest
   * `created_at_ms` of the pool. The relay serves the oldest available member first, so this is what
   * makes slot 0 the last member consumed, which in turn is what keeps the anchor bundle id the
   * publish result reports stable while any member is still live.
   */
  async restorePublicationPool(): Promise<{ members: SignalPreKeyBundleV2[]; minted: number }> {
    return this.transact(async (tx) => {
      const members: Array<SignalPreKeyBundleV2 | undefined> = [];
      for (let slot = 0; slot < poolTarget; slot += 1) members.push(this.readPublicationSlot(tx, slot));
      let minted = 0;
      for (let slot = poolTarget - 1; slot >= 0; slot -= 1) {
        if (members[slot] !== undefined) continue;
        members[slot] = await this.mintPublicationSlot(tx, slot, members.some((member) => member !== undefined));
        minted += 1;
      }
      return { members: members as SignalPreKeyBundleV2[], minted };
    });
  }

  /**
   * Replace one slot's member with fresh key material, durably, before it is offered.
   *
   * Called for a slot the relay has just reported as no longer claimable — consumed by a
   * first-contact sender, or outside its validity window. The member it replaces is forgotten as a
   * PUBLICATION only: its private half stays in the store, because a sender may hold a claim on it
   * for days and the relay replays the exact bundle bytes bound to that claim forever.
   */
  async replacePublicationSlot(slot: number): Promise<SignalPreKeyBundleV2> {
    if (!Number.isInteger(slot) || slot < 0 || slot >= poolTarget) throw new ProfileError("Publication slot is outside the pool");
    return this.transact((tx) => this.mintPublicationSlot(tx, slot, true));
  }

  /**
   * Explicit, separate allocation for the pool's anchor slot: a newly generated one-time prekey and
   * a new independently signed bundle. Never performed implicitly by a publication retry, and never
   * by a pool top-up, which replaces only the slots the relay reported as no longer claimable.
   */
  async rotatePublicationBundle(): Promise<SignalPreKeyBundleV2> {
    return this.transact((tx) => this.mintPublicationSlot(tx, 0, true));
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
