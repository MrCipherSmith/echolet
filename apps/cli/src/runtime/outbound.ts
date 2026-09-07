import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { deriveMailboxId } from "@echolet/crypto-core";
import { MailboxEnvelopeSchema, signalAddressForDevice, type MailboxEnvelope } from "@echolet/protocol";
import { importVerifiedSignalBundleV2 } from "@echolet/session-node";
import { RelayClient, RelayError } from "../transport/relayClient";
import { openProfile, PersistenceError, type Profile, type OpenProfileOptions, type ContactIdentifiers } from "./profile";
import { appendHistory } from "./history";

export class OutboundError extends Error {
  constructor(readonly code: string) { super(code); this.name = "OutboundError"; }
}
const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const decode = <T>(bytes: Uint8Array): T => JSON.parse(new TextDecoder().decode(bytes)) as T;
const inputSchema = z.object({ recipientIdentityId: z.string().min(1), messageId: z.string().uuid(), plaintext: z.string().max(65536) }).strict();
type SendInput = z.infer<typeof inputSchema>;
interface Outbox { contentHash: string; envelope: MailboxEnvelope; status: "pending" | "delivered" }
const keyFor = (id: string) => `cli:outbox:${id}`;
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
  /** Submits the durable publication bundle; a retry resubmits the identical signed bytes. */
  publish() { return this.serial(async () => this.options.relay.publishBundle(await this.profile.publicationBundle())); }
  /** Explicit fresh allocation: a new one-time prekey and a new independently signed bundle. */
  rotateBundle() { return this.serial(async () => { await this.profile.rotatePublicationBundle(); }); }
  send(input: SendInput) {
    const parsed = inputSchema.safeParse(input);
    if (!parsed.success || Buffer.byteLength(parsed.data.plaintext) > 65536) return Promise.reject(new OutboundError("INVALID_MESSAGE"));
    return this.serial(() => this.sendOwned(parsed.data));
  }
  private async sendOwned(input: SendInput) {
    const contentHash = createHash("sha256").update(JSON.stringify([input.recipientIdentityId, input.messageId, input.plaintext])).digest("hex");
    // Optimization only: the authoritative read is repeated inside the mutation transaction.
    const prior = await this.profile.withRuntime((tx) => { const value = tx.get(keyFor(input.messageId)); return value ? decode<Outbox>(value) : null; });
    if (prior) return this.settle(prior, contentHash);
    const contact = (await this.profile.listContacts()).find((value) => value.identity_id === input.recipientIdentityId);
    if (!contact) throw new OutboundError("CONTACT_NOT_TRUSTED");
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
    let verified: ReturnType<typeof importVerifiedSignalBundleV2> | undefined;
    if (claimId !== null) {
      const bundle = await this.options.relay.claimBundle({ claimId, identityId: contact.identity_id, deviceId: contact.device_id });
      try {
        if (bundle.one_time_prekey === null || bundle.device_record.identity_id !== contact.identity_id || bundle.device_record.device_id !== contact.device_id ||
            bundle.device_record.device_pubkey !== contact.device_pubkey || bundle.signal_identity_key !== contact.signal_identity_key) throw new Error();
        verified = importVerifiedSignalBundleV2(bundle, { identityId: contact.identity_id, deviceId: contact.device_id }, this.options.now?.() ?? Date.now());
      } catch { throw new OutboundError("CONTACT_PIN_MISMATCH"); }
    }
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
    return outcome.existed ? this.settle(outcome.record, contentHash) : this.deliver(outcome.record);
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
