import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { deriveMailboxId } from "@echolet/crypto-core";
import { MailboxEnvelopeSchema, signalAddressForDevice, type MailboxEnvelope } from "@echolet/protocol";
import { importVerifiedSignalBundleV2 } from "@echolet/session-node";
import { MAX_PLAINTEXT_BYTES } from "../limits";
import { RelayClient, RelayError } from "../transport/relayClient";
import { openProfile, PersistenceError, type Profile, type OpenProfileOptions, type ContactIdentifiers } from "./profile";
import { appendHistory } from "./history";

export class OutboundError extends Error {
  /**
   * `code` is the machine name the CLI reports and `classify()` maps to an exit code; `message` is
   * the operator-readable sentence, defaulting to the code so every pre-existing throw site keeps
   * the exact shape it had. Carrying an action in the message is the idiom `ProfileError` and
   * `ConfigurationError` already use — a fixed code beside free text — and it is used here only
   * where naming the condition is not enough to act on it.
   */
  constructor(readonly code: string, message: string = code) { super(message); this.name = "OutboundError"; }
}
const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const decode = <T>(bytes: Uint8Array): T => JSON.parse(new TextDecoder().decode(bytes)) as T;
/**
 * The largest message body this client will encrypt, in bytes.
 *
 * The value moved to `../limits` when the operator console became its fourth reader: the console's
 * pure layer must be able to bound a compose buffer at the same number, and importing this module
 * to learn it would have pulled the store, the relay client and libsignal into a renderer. It is
 * re-exported here because this module is where a reader looks for the messenger's own bound, and
 * because `commands/cli.ts` has imported it from here since the stdin body path landed.
 */
export { MAX_PLAINTEXT_BYTES } from "../limits";
const inputSchema = z.object({ recipientIdentityId: z.string().min(1), messageId: z.string().uuid(), plaintext: z.string().max(MAX_PLAINTEXT_BYTES) }).strict();
type SendInput = z.infer<typeof inputSchema>;
interface Outbox { contentHash: string; envelope: MailboxEnvelope; status: "pending" | "delivered" }
const keyFor = (id: string) => `cli:outbox:${id}`;
/**
 * A stored pool member the relay will not accept back because its validity window has closed.
 *
 * It is read here and nowhere else: `BUNDLE_EXPIRED` is carried inland by the transport allowlist so
 * this loop can tell a dead slot from a malformed one, and it is deliberately absent from the CLI's
 * reported-code allowlist, so the operator's failure vocabulary is unchanged and `classify()` never
 * sees it.
 */
const expiredPublication = (error: unknown): boolean => error instanceof RelayError && error.remoteCode === "BUNDLE_EXPIRED";
const receipt = (record: Outbox) => ({ messageId: record.envelope.message_id, envelopeId: record.envelope.envelope_id, status: "delivered" as const });
type Options = Pick<OpenProfileOptions, "profileDir" | "environment"> & { relay: RelayClient; idFactory?: (kind: "claim" | "envelope") => string; now?: () => number };

class OutboundMessenger {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly profile: Profile, private readonly options: Options) {}
  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation).catch((error: unknown) => {
      if (error instanceof RelayError || error instanceof OutboundError || error instanceof PersistenceError) throw error;
      throw new OutboundError("OUTBOUND_REJECTED");
    });
    this.queue = result.catch(() => {});
    return result;
  }
  /**
   * Bring the published pool back up to N — the recovery a drained recipient has never had.
   *
   * `relay publish` used to mean "submit my publication". A publication served exactly one
   * first-contact sender, a claim is permanent, and `/v2/prekeys/claim` carries no authentication,
   * so one unauthenticated request from anyone who knew an identity id silenced a recipient with no
   * way back through the frozen command surface. It now means "bring my pool back up to N",
   * idempotent-with-top-up.
   *
   * The loop, and why each half is the shape it is:
   *
   * 1. Re-submit EVERY stored member, slot 0 first. Each re-submission is idempotent — the relay
   *    re-stores byte-identical bytes and deliberately never re-adds the availability index — and it
   *    answers `claimable` truthfully per member. There is no "how many are left" route to ask
   *    instead, and adding one would be a wire change; the re-submission IS the query. Every member
   *    is asked, including the ones last seen as live, because that belief goes stale the moment a
   *    claim lands and a client that trusted it would report a full pool while holding a drained one.
   * 2. Mint one replacement per slot the relay refused to keep serving, highest slot first, and
   *    publish it. Nothing else is re-minted: an unconsumed member keeps its exact stored bytes, so
   *    the lost-response retry guarantee that used to belong to one publication now belongs to each
   *    member, and no one-time prekey is reserved that no sender will ever use.
   *
   * A member whose seven-day window has closed is answered `BUNDLE_EXPIRED` and is a dead slot, not
   * a failed command: the whole pool is minted within seconds of itself and therefore ages together,
   * so treating expiry as fatal would break the recovery path in the case it is most needed. Every
   * other refusal is surfaced, because a malformed or mis-signed member re-minted in silence would
   * hide a real defect behind an endless supply of fresh key material.
   *
   * What this buys, stated honestly: one attacking source goes from silencing 120 recipients a
   * minute to 6, while the recipient pays about thirty times per bundle what the attacker pays to
   * destroy it. It is a price increase and a recovery path, not a closure.
   */
  publish() {
    return this.serial(async () => {
      const restored = await this.profile.restorePublicationPool();
      const members = [...restored.members];
      let minted = restored.minted;
      let claimable = 0;
      const dead: number[] = [];
      for (const [slot, member] of members.entries()) {
        let answer;
        try { answer = await this.options.relay.publishBundle(member); }
        catch (error) { if (!expiredPublication(error)) throw error; dead.push(slot); continue; }
        if (answer.claimable) claimable += 1; else dead.push(slot);
      }
      // Highest slot first, for the reason `restorePublicationPool()` fills in that order: slot 0
      // stays the youngest member, so it is the last one a claim reaches and the reported anchor
      // holds still while anything else is live.
      for (const slot of [...dead].reverse()) {
        const replacement = await this.profile.replacePublicationSlot(slot);
        members[slot] = replacement;
        minted += 1;
        if ((await this.options.relay.publishBundle(replacement)).claimable) claimable += 1;
      }
      // `claimable` answers the only question the operator is asking - can anyone still reach me for
      // the first time - and the per-member truth is right beside it, so a publish that restored
      // nothing cannot report plain success.
      return {
        stored: true as const,
        bundleId: members[0]!.bundle_id,
        claimable: claimable > 0,
        pool: { target: members.length, claimable, minted },
      };
    });
  }
  /** Explicit fresh allocation: a new one-time prekey and a new independently signed bundle. */
  rotateBundle() { return this.serial(async () => { await this.profile.rotatePublicationBundle(); }); }
  send(input: SendInput) {
    const parsed = inputSchema.safeParse(input);
    if (!parsed.success || Buffer.byteLength(parsed.data.plaintext) > MAX_PLAINTEXT_BYTES) return Promise.reject(new OutboundError("INVALID_MESSAGE"));
    return this.serial(() => this.sendOwned(parsed.data));
  }
  private async sendOwned(input: SendInput) {
    const contentHash = createHash("sha256").update(JSON.stringify([input.recipientIdentityId, input.messageId, input.plaintext])).digest("hex");
    // Optimization only: the authoritative read is repeated inside the mutation transaction.
    const prior = await this.profile.withRuntime((tx) => { const value = tx.get(keyFor(input.messageId)); return value ? decode<Outbox>(value) : null; });
    if (prior) return this.settle(prior, contentHash);
    const contact = (await this.profile.listContacts()).find((value) => value.identity_id === input.recipientIdentityId);
    if (!contact) throw new OutboundError("CONTACT_NOT_TRUSTED");
    // `send` presupposes `relay publish`, and this is where the client says so — locally, before it
    // spends anything belonging to the RECIPIENT.
    //
    // Since T50 (finding T49-F-001) the relay authenticates a mailbox deposit against an
    // already-published, root-signed device record, so a profile that has never offered a
    // publication is certain to be refused 403 `UNAUTHORIZED_MAILBOX_ACCESS` on
    // `/v1/messages/send`. `/v2/prekeys/claim` carries no authentication at all, so without this
    // guard the doomed send takes the irreversible step first: it permanently consumes the
    // recipient's one-time prekey on its way to a deposit that could never have been accepted.
    // Each published bundle serves exactly one first-contact sender, and since T26 the recipient's
    // pool of them is finite and refilled only when they run `relay publish` themselves, so every
    // wasted claim costs a third party a top-up they did not ask for - and a pool drained faster
    // than its owner notices still ends in the denial the pool only makes rarer.
    //
    // This is not a new restriction — publication was already a hard precondition of a successful
    // deposit. Only the MOMENT the operator is told changes: here, at no cost, instead of one
    // irreversible request too late and at somebody else's expense.
    //
    // Ordered AFTER the contact-trust check on purpose. `CONTACT_NOT_TRUSTED` is the more specific
    // local diagnosis of the same send and predates this guard; an unpinned recipient must keep
    // reporting it. Both checks are local, so the ordering costs nothing either way.
    //
    // It is a local client decision, so it is an `OutboundError` and never a `RelayError`: no
    // request was made, and nothing here may be mistaken for something the relay said.
    if (!(await this.profile.hasPublication())) {
      throw new OutboundError(
        "SENDER_NOT_PUBLISHED",
        "This profile has never published its device record, so the relay cannot accept its messages; run `relay publish` for this profile, then send again.",
      );
    }
    const address = signalAddressForDevice(contact.identity_id, contact.device_id);
    const sessionKey = `session:${JSON.stringify([address.name, address.deviceId])}`;
    const claimKey = `cli:claim:${contact.identity_id}`;
    const claimId = await this.profile.withRuntime((tx) => {
      if (tx.get(sessionKey)) return null;
      const previous = tx.get(claimKey);
      if (previous) return decode<string>(previous);
      const id = z.string().uuid().parse(this.options.idFactory?.("claim") ?? randomUUID());
      tx.set(claimKey, encode(id));
      return id;
    });
    const claimed = claimId === null ? null : await this.claimFirstContact(contact, claimKey, claimId);
    const verified = claimed?.verified;
    const outcome = await this.profile.withRuntime(async (tx, client, local, signEnvelope) => {
      // Another instance may have committed this message id while the claim was in flight.
      const committed = tx.get(keyFor(input.messageId));
      if (committed) return { record: decode<Outbox>(committed), existed: true };
      const pinned = tx.get(`cli:contact:${contact.identity_id}`);
      if (!pinned || JSON.stringify(decode<ContactIdentifiers>(pinned)) !== JSON.stringify(contact)) throw new OutboundError("CONTACT_PIN_MISMATCH");
      if (verified) await client.establish(address, verified.bundle);
      const message = await client.encrypt(address, input.messageId, input.plaintext);
      const ciphertext = Buffer.from(JSON.stringify({ version: 1, type: message.type, body: Buffer.from(message.body).toString("base64url") })).toString("base64url");
      const created = this.options.now?.() ?? Date.now();
      const envelopeId = this.options.idFactory?.("envelope") ?? randomUUID();
      const recipientMailboxId = deriveMailboxId(contact.identity_id), expires = created + 86400000;
      // The sender binding the relay verifies against this profile's published device record
      // (T50, finding T49-F-001). ed25519 over a transcript built only from these fields, so the
      // byte-identical retry of an ambiguous send replays the byte-identical signature and stays
      // idempotent rather than becoming an ENVELOPE_ID_CONFLICT (F-004).
      const senderSignature = await signEnvelope({
        recipientMailboxId, envelopeId, senderIdentityId: local.identity_id, senderDeviceId: local.device_id,
        ciphertext, createdAtMs: created, expiresAtMs: expires,
      });
      const envelope = MailboxEnvelopeSchema.strict().parse({
        type: "mailbox_envelope", version: 1, envelope_id: envelopeId, message_id: input.messageId,
        sender_identity_id: local.identity_id, sender_device_id: local.device_id,
        recipient_identity_id: contact.identity_id, recipient_device_id: contact.device_id, recipient_mailbox_id: recipientMailboxId,
        payload_type: "ciphertext_message", ciphertext, created_at_ms: created, expires_at_ms: expires, size_bytes: Buffer.byteLength(ciphertext),
        sender_signature: senderSignature,
      });
      const record: Outbox = { contentHash, envelope, status: "pending" };
      tx.set(keyFor(input.messageId), encode(record));
      appendHistory(tx, { contactIdentityId: contact.identity_id, messageId: input.messageId, direction: "outbound", plaintext: input.plaintext, createdAtMs: created });
      tx.delete(claimKey);
      return { record, existed: false };
    });
    const delivered = outcome.existed ? await this.settle(outcome.record, contentHash) : await this.deliver(outcome.record);
    // A dead claim is recovered automatically, never silently: one of the recipient's one-time
    // prekeys was spent by the claim this send had to abandon, so the receipt says so rather than
    // leaving the operator to discover later that retries are consuming a peer's key material.
    return claimed?.replaced === true ? { ...delivered, claimReplaced: true as const } : delivered;
  }
  /**
   * Claim the recipient's first-contact bundle under a durable claim id, and verify it against the
   * imported pin.
   *
   * The stored claim id is what makes a lost claim response recoverable: the relay replays the exact
   * bundle bound to it, expiry included, so the same one-time prekey is never handed to a second
   * sender. That exact replay is also how a stored claim becomes DEAD. A sender that comes back
   * after the claimed bundle's validity window has closed replays a bundle no session can ever be
   * established from, and the claim was only ever deleted on success - so every later first-contact
   * attempt to that recipient replayed the same dead bundle, permanently, even while a fresh
   * claimable publication sat on the relay.
   *
   * A dead claim is therefore released exactly once and one fresh claim is taken in its place.
   * Nothing is rolled back and no relay behaviour is relied on beyond replenishment: the relay's
   * consumption of the abandoned one-time prekey stays permanent, which is what keeps one one-time
   * prekey bound to one sender. Dropping the id costs nothing, because the only thing it can still
   * buy is a bundle that cannot be used. The replacement id is written durably BEFORE the second
   * claim is issued, exactly as the first was, so an ambiguous replacement is replayed rather than
   * re-allocated. It is done at most once per send, so a recipient whose fresh publication is also
   * outside its window cannot turn one send into a claim loop.
   *
   * An expired bundle is not a trust failure and is not reported as one. The pinned identity,
   * device, device key and Signal identity key are checked first and still answer
   * `CONTACT_PIN_MISMATCH`; a closed validity window is the exhausted-recipient condition instead -
   * `PREKEY_BUNDLE_UNAVAILABLE` when the replacement claim finds nothing left to claim, and
   * `PREKEY_BUNDLE_EXPIRED` when even the replacement is outside its window. Telling an operator
   * their contact's pin no longer matches raises a security alarm; a one-time prekey that expired is
   * not one (cli.ts: the failure vocabulary grows "where flattening actively misleads").
   */
  private async claimFirstContact(contact: ContactIdentifiers, claimKey: string, claimId: string) {
    let identifier = claimId;
    let replaced = false;
    for (;;) {
      const bundle = await this.options.relay.claimBundle({ claimId: identifier, identityId: contact.identity_id, deviceId: contact.device_id });
      // One reading of the clock for the decision and for the verification, so a bundle cannot be
      // judged dead here and live there.
      const at = this.options.now?.() ?? Date.now();
      if (bundle.one_time_prekey === null || bundle.device_record.identity_id !== contact.identity_id || bundle.device_record.device_id !== contact.device_id ||
          bundle.device_record.device_pubkey !== contact.device_pubkey || bundle.signal_identity_key !== contact.signal_identity_key) throw new OutboundError("CONTACT_PIN_MISMATCH");
      if (at < bundle.created_at_ms || at >= bundle.expires_at_ms) {
        if (replaced) throw new OutboundError("PREKEY_BUNDLE_EXPIRED");
        replaced = true;
        identifier = await this.profile.withRuntime((tx) => {
          const id = z.string().uuid().parse(this.options.idFactory?.("claim") ?? randomUUID());
          tx.set(claimKey, encode(id));
          return id;
        });
        continue;
      }
      try {
        return { verified: importVerifiedSignalBundleV2(bundle, { identityId: contact.identity_id, deviceId: contact.device_id }, at), replaced };
      } catch { throw new OutboundError("CONTACT_PIN_MISMATCH"); }
    }
  }
  /** Reconcile with an already persisted record: identical content is idempotent, different content is not. */
  private settle(record: Outbox, contentHash: string) {
    if (record.contentHash !== contentHash) throw new OutboundError("MESSAGE_ID_CONFLICT");
    return this.deliver(record);
  }
  private async deliver(record: Outbox) {
    if (record.status === "delivered") return receipt(record);
    await this.profile.withRuntime(async (_tx, client) => {
      const remote = signalAddressForDevice(record.envelope.recipient_identity_id, record.envelope.recipient_device_id);
      const persisted = await client.retry(remote, record.envelope.message_id);
      const expected = Buffer.from(JSON.stringify({ version: 1, type: persisted.type, body: Buffer.from(persisted.body).toString("base64url") })).toString("base64url");
      if (record.envelope.ciphertext !== expected) throw new OutboundError("OUTBOUND_REJECTED");
    });
    await this.options.relay.sendEnvelope(record.envelope);
    await this.profile.withRuntime((tx) => tx.set(keyFor(record.envelope.message_id), encode({ ...record, status: "delivered" })));
    return receipt(record);
  }
  retryPending() {
    return this.serial(async () => {
      const pending = await this.profile.withRuntime((tx) => tx.keys("cli:outbox:").sort().map((key) => decode<Outbox>(tx.get(key)!)).filter((value) => value.status === "pending"));
      const results = [];
      for (const record of pending) results.push(await this.deliver(record));
      return results;
    });
  }
  diagnostics() { return this.serial(() => this.profile.diagnostics()); }
  async close() { await this.queue; await this.profile.close(); }
}
export async function openOutboundMessenger(options: Options) {
  const owned = { ...options, environment: options.environment ? { ...options.environment } : undefined };
  return new OutboundMessenger(await openProfile(owned), owned);
}
