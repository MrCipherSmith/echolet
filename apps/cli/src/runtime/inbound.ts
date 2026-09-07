import { createHash } from "node:crypto";
import { z } from "zod";
import { deriveMailboxId } from "@echolet/crypto-core";
import { signalAddressForDevice, type MailboxEnvelope } from "@echolet/protocol";
import { openProfile, PersistenceError, ProfileError, type Profile, type OpenProfileOptions, type ContactIdentifiers } from "./profile";
import { appendHistory, readHistory } from "./history";
import { RelayClient, RelayError } from "../transport/relayClient";

export class InboundError extends Error {
  constructor(readonly code: string) { super(code); this.name = "InboundError"; }
}

/**
 * One permanently rejected envelope. Deliberately carries nothing but the relay-assigned
 * identifier and the typed rejection code: `poll()`'s result is returned verbatim to stdout by
 * `commands/cli.ts`, so no ciphertext, plaintext, store key or other sender-supplied string may
 * appear here.
 */
export interface RejectedEnvelope {
  readonly envelopeId: string;
  readonly code: string;
}

/**
 * Result of one mailbox poll.
 *
 * - `received`  envelopes accepted and committed by this poll, across every page it walked.
 * - `more`      the relay's remaining-work signal (`next_cursor`) as of the last page read: true
 *               when the relay cut that response short at its own batch or byte bound and the
 *               caller should poll again.
 * - `rejected`  permanently unacceptable envelopes, in the order they were read. They are neither
 *               committed nor acknowledged, so the relay keeps them queued; they simply no longer
 *               stop the rest of the batch, or the pages behind it, from being delivered.
 */
export interface PollResult {
  readonly received: number;
  readonly more: boolean;
  readonly rejected: RejectedEnvelope[];
}

/**
 * A failure that is not a verdict about the envelope that happened to be in flight.
 *
 * Local persistence loss, relay unavailability and a profile that cannot be read are all
 * conditions a retry can clear, and the specification requires that such an envelope stays
 * queued, unacknowledged and retriable. They therefore abort the whole poll instead of being
 * isolated: nothing is acknowledged, and the transaction that was open is rolled back.
 *
 * Everything else - an untrusted or unpinned sender, a misaddressed envelope, malformed
 * ciphertext or wrapper, a message-ID conflict, a decrypt that does not authenticate - is a
 * permanent verdict about that one envelope. Retrying it can never succeed, so it is isolated
 * and the rest of the batch proceeds.
 */
const isNotAnEnvelopeVerdict = (error: unknown): boolean =>
  error instanceof PersistenceError || error instanceof RelayError || error instanceof ProfileError;
const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const decode = <T>(value: Uint8Array): T => JSON.parse(new TextDecoder().decode(value)) as T;
const base64 = z.string().min(1).max(1024 * 1024).regex(/^[A-Za-z0-9_-]+$/).refine((value) => Buffer.from(value, "base64url").toString("base64url") === value);
const wrapperSchema = z.object({ version: z.literal(1), type: z.union([z.literal(2), z.literal(3)]), body: base64 }).strict();
const ackKey = (id: string) => `cli:pending-ack:${id}`;
/**
 * How many relay pages one `poll()` will walk while every page has yielded nothing.
 *
 * Since flow 002 / T5 C4-3 this is a LIVENESS VALVE and nothing more. It used to be the whole of
 * the recipient's patience: nothing carried progress from one poll to the next, so a legitimate
 * message that did not fall inside these pages was never delivered and expired behind the poison.
 * Now the recipient's read position is durable and held by the relay, so hitting the valve costs
 * one more `poll` invocation instead of a lost message, and `poll` already reports `more: true` as
 * the signal to poll again.
 *
 * It still has to exist: each page costs a challenge and a poll round trip, and the mailbox is
 * attacker-fillable, so one `poll` must return in bounded time rather than walking a mailbox an
 * attacker chose the size of.
 */
const maxPollPagesPerPoll = 16;
type Options = Pick<OpenProfileOptions, "profileDir" | "environment"> & { relay: RelayClient; now?: () => number };

class InboundMessenger {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly profile: Profile, private readonly options: Options) {}
  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation).catch((error: unknown) => {
      if (error instanceof InboundError || error instanceof RelayError || error instanceof PersistenceError) throw error;
      throw new InboundError("INBOUND_REJECTED");
    });
    this.queue = result.catch(() => {});
    return result;
  }
  /**
   * Reads one page of the mailbox, resuming at `cursor` when the previous page reported one and
   * reporting `readThrough`, the position of the last page this walk fully judged.
   *
   * The read position rides on the POLL rather than on the ack (finding T6-F-001). The poll is
   * already signed and challenge-bound, so the position is authenticated by the same key with no
   * extra request, and the ack stays purely about acknowledgement - which is what keeps F-012's
   * "a batch that accepted nothing acknowledges nothing" literally true as "no ack REQUEST at all".
   *
   * It is reported per PAGE, not once at the end of the walk (finding T6-F-003). A walk that
   * reported its progress only on completion would lose all of it to a rate-limit 429, a request
   * timeout, an operator's Ctrl-C or a supervisor restart - and under the shipped 120/min per-IP
   * limit the recipient's own rate limiter interrupts a long walk routinely, so that is the normal
   * case rather than the exotic one. Presenting page k's position on page k+1's request costs no
   * extra request and bounds the repeated work after any interruption to a single page.
   */
  private async page(cursor: string | undefined, readThrough: string | undefined) {
    const challenge = await this.options.relay.createChallenge(await this.profile.mailboxAuthorization({ kind: "challenge" }));
    if (challenge.expires_at_ms <= (this.options.now?.() ?? Date.now())) throw new InboundError("CHALLENGE_EXPIRED");
    const authorization = await this.profile.mailboxAuthorization({
      kind: "poll", challengeId: challenge.challenge_id, nonce: challenge.nonce,
      ...(readThrough === undefined ? {} : { readThrough }),
    });
    // The configured batch size is forwarded so the relay bounds the batch it
    // selects; without it the relay applies its own maximum and can return a
    // response larger than this client will read. A challenge is single-use, so
    // each page needs its own.
    return this.options.relay.pollMailbox({
      ...authorization, challenge_id: challenge.challenge_id, batch_size: this.profile.pollBatchSize,
      ...(cursor === undefined ? {} : { cursor }),
      ...(readThrough === undefined ? {} : { read_through: readThrough }),
    });
  }
  poll() {
    return this.serial(async () => {
      const rejected: RejectedEnvelope[] = [];
      let received = 0;
      let firstRejection: InboundError | undefined;
      let more = false;
      // A poll with no cursor resumes at the read position the RELAY holds for this device, so a
      // walk continues where the last one stopped even across a process that never returned. The
      // one exception is a pending `contact import` re-walk: an explicit cursor - "0" for the head
      // of the mailbox - asks for ground the mark is already past, which is how an envelope refused
      // as CONTACT_NOT_TRUSTED before the card existed is offered again (T5 design §4, R-5). It is
      // consumed exactly once, here, before the walk begins: a re-walk that outlived its own walk
      // would restart every subsequent poll at the same place and silently reinstate the whole
      // flooding class (finding T6-F-004).
      //
      // What is consumed is a POSITION, not a flag, and an unfinished re-walk is carried forward at
      // the position it reached (finding T10-F-001). The re-walk is bounded by the same
      // `maxPollPagesPerPoll` valve as any other walk, so past 16 pages of poison a flag-shaped
      // re-walk stopped short of the envelope it was performed for and every later poll resumed
      // after it from the mark: the recovery path the durable mark depends on was itself wedged by
      // a flood of the same order, and a lost message does not come back. Re-requesting the walk
      // from the head would loop forever without progressing; resuming it moves it strictly
      // forward, so it costs one more `poll` per valve's worth of pages and always terminates.
      const rewalkFrom = await this.profile.takeMailboxRewalk();
      // The position an unfinished re-walk must resume strictly after, or `undefined` once the walk
      // has reached the end of the mailbox and there is nothing left to re-walk.
      let rewalk = rewalkFrom;
      let cursor: string | undefined = rewalkFrom;
      // The highest position this walk has fully judged. Held in memory for the duration of the
      // walk and put on the wire; never persisted locally, because a poll that writes to the store
      // breaks F-012's store-identity guarantee and because the relay is the durable holder
      // (finding T6-F-005). The re-walk position above is not this: it is written only while a
      // re-walk is in flight, so an ordinary poll still leaves the store byte-identical.
      let readThrough: string | undefined;
      // Walk the relay's pages while every page so far has yielded nothing and the relay says more
      // remain. A permanently rejected envelope is deliberately never acknowledged (F-012), so it
      // stays queued and keeps occupying its place in the relay's selection order; without walking,
      // an unauthenticated sender who fills one selection window makes every batch entirely poison
      // and the legitimate envelopes behind it are never delivered (round-2 finding R2-001 path B).
      // The walk stops as soon as anything is accepted, because the accepted envelopes must be
      // acknowledged promptly and the next `poll()` resumes the remainder - from the durable mark,
      // or from the re-walk position when a re-walk is still in flight.
      try {
        for (let page = 0; page < maxPollPagesPerPoll; page += 1) {
          const batch = await this.page(cursor, readThrough);
          const accepted = await this.accept(batch.envelopes);
          received += accepted.received;
          rejected.push(...accepted.rejected);
          firstRejection ??= accepted.firstRejection;
          more = batch.next_cursor !== null;
          cursor = batch.next_cursor ?? undefined;
          // The page just judged becomes the position the NEXT page's request reports. It is only
          // ever a token the relay itself issued for a page this walk actually received, which is
          // what keeps the mark from advancing past an envelope the recipient never read (R-4).
          readThrough = batch.next_cursor ?? undefined;
          // A re-walk in flight advances with the walk, and ENDS - `undefined`, nothing to carry
          // forward - the moment the relay reports no more pages. Only a page that was fully judged
          // moves it, so an interrupted judgement re-offers that page rather than skipping it.
          if (rewalk !== undefined) rewalk = batch.next_cursor ?? undefined;
          if (accepted.received > 0 || !more) break;
        }
      } catch (error) {
        // A relay outage, a rate limit or a local storage failure must not silently spend the
        // re-walk: without this an unreachable relay would consume the `contact import` recovery
        // and the envelope it was performed for would never be offered again.
        if (rewalk !== undefined) {
          try { await this.profile.keepMailboxRewalk(rewalk); } catch { /* the failure being unwound is the one the operator must see */ }
        }
        throw error;
      }
      // An unfinished re-walk is carried forward BEFORE any verdict is re-raised: the walk that
      // most needs to be resumed is exactly the one that judged nothing but poison and threw.
      if (rewalk !== undefined) await this.profile.keepMailboxRewalk(rewalk);
      // Nothing survived any page the walk reached: keep the historical whole-batch contract, which
      // is also the F-012 guarantee - re-raise the first rejection, acknowledge nothing, mutate
      // nothing. Walking further pages changes only how much of the mailbox is consulted before
      // this answer is given, never whether it is given. What the walk JUDGED is not thrown away
      // with the answer: each page reported the previous page's position on the way past, so the
      // pages already refused are not re-downloaded and re-refused by the next poll.
      if (received === 0 && firstRejection) throw firstRejection;
      await this.ackPending();
      return { received, more, rejected } satisfies PollResult;
    });
  }
  /**
   * Per-envelope acceptance. Each envelope is admitted in its own transaction, so a permanently
   * unacceptable one rolls back only itself and the envelopes around it are still committed and
   * become acknowledgeable. A failure that is not a verdict about the envelope aborts the whole
   * poll instead, leaving every envelope queued and unacknowledged.
   */
  private async accept(envelopes: MailboxEnvelope[]) {
    const rejected: RejectedEnvelope[] = [];
    let received = 0;
    let firstRejection: InboundError | undefined;
    for (const envelope of envelopes) {
      try {
        await this.acceptOne(envelope);
        received += 1;
      } catch (error) {
        if (isNotAnEnvelopeVerdict(error)) throw error;
        const rejection = error instanceof InboundError ? error : new InboundError("INBOUND_REJECTED");
        firstRejection ??= rejection;
        rejected.push({ envelopeId: envelope.envelope_id, code: rejection.code });
      }
    }
    return { received, rejected, firstRejection };
  }
  private acceptOne(envelope: MailboxEnvelope) {
    return this.profile.withRuntime(async (tx, client, local) => {
      const now = this.options.now?.() ?? Date.now();
      if (envelope.recipient_identity_id !== local.identity_id || envelope.recipient_device_id !== local.device_id ||
          envelope.recipient_mailbox_id !== deriveMailboxId(local.identity_id) || envelope.size_bytes !== Buffer.byteLength(envelope.ciphertext) ||
          !Number.isSafeInteger(envelope.created_at_ms) || !Number.isSafeInteger(envelope.expires_at_ms) || envelope.created_at_ms < 0 ||
          envelope.created_at_ms > now || envelope.expires_at_ms <= now || envelope.expires_at_ms <= envelope.created_at_ms) throw new InboundError("INVALID_ENVELOPE");
      const contactBytes = tx.get(`cli:contact:${envelope.sender_identity_id}`);
      if (!contactBytes) throw new InboundError("CONTACT_NOT_TRUSTED");
      const contact = decode<ContactIdentifiers>(contactBytes);
      if (contact.identity_id !== envelope.sender_identity_id || contact.device_id !== envelope.sender_device_id) throw new InboundError("CONTACT_PIN_MISMATCH");
      const remote = signalAddressForDevice(contact.identity_id, contact.device_id);
      const addressKey = JSON.stringify([remote.name, remote.deviceId]);
      const trusted = tx.get(`trust:${addressKey}`);
      if (!trusted || Buffer.from(trusted).toString("base64url") !== contact.signal_identity_key) throw new InboundError("CONTACT_PIN_MISMATCH");
      const raw = Buffer.from(base64.parse(envelope.ciphertext), "base64url");
      const wrapper = wrapperSchema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw)));
      const hash = createHash("sha256").update(envelope.ciphertext).digest("hex");
      const inboxKey = `cli:inbox:${addressKey}:${envelope.message_id}`;
      const previous = tx.get(inboxKey);
      if (previous) {
        if (decode<string>(previous) !== hash) throw new InboundError("MESSAGE_ID_CONFLICT");
      } else {
        const plaintext = await client.decrypt(remote, { messageId: envelope.message_id, type: wrapper.type, body: Buffer.from(wrapper.body, "base64url") });
        tx.set(inboxKey, encode(hash));
        appendHistory(tx, { contactIdentityId: contact.identity_id, messageId: envelope.message_id, direction: "inbound", plaintext, createdAtMs: envelope.created_at_ms });
      }
      const pending = tx.get(ackKey(envelope.envelope_id));
      if (pending && decode<string>(pending) !== inboxKey) throw new InboundError("INVALID_ENVELOPE");
      tx.set(ackKey(envelope.envelope_id), encode(inboxKey));
    });
  }
  private async ackPending() {
    const ids = await this.profile.withRuntime((tx) => tx.keys("cli:pending-ack:").sort().map((key) => key.slice("cli:pending-ack:".length)));
    for (let start = 0; start < ids.length; start += 100) {
      const envelopeIds = ids.slice(start, start + 100);
      const authorization = await this.profile.mailboxAuthorization({ kind: "ack", envelopeIds });
      await this.options.relay.ackMailbox({ ...authorization, envelope_ids: envelopeIds });
      await this.profile.withRuntime((tx) => { for (const id of envelopeIds) tx.delete(ackKey(id)); });
    }
    return { acked: ids.length };
  }
  retryPendingAcks() { return this.serial(() => this.ackPending()); }
  history(input: { contactIdentityId: string }) {
    const id = input.contactIdentityId;
    return this.serial(() => this.profile.withRuntime((tx) => readHistory(tx, id)));
  }
  diagnostics() { return this.serial(() => this.profile.diagnostics()); }
  async close() { await this.queue; await this.profile.close(); }
}
export async function openInboundMessenger(options: Options) {
  const owned = { ...options, environment: options.environment ? { ...options.environment } : undefined };
  return new InboundMessenger(await openProfile(owned), owned);
}
