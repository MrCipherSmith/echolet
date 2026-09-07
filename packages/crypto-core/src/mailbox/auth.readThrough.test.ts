import { describe, expect, it } from "vitest";
import {
  createMailboxAckMessage,
  deriveIdentityKeyPairFromSeed,
  signUtf8Message,
  verifyUtf8Message,
} from "../index";

/**
 * RED tests for flow 002 / T5 design §3 C4-2: the mailbox ack transcript gains `read_through`, the
 * recipient's durable read position.
 *
 * Why this belongs in the shared transcript and not only in the request body
 * -------------------------------------------------------------------------
 * `read_through` decides what the recipient is offered NEXT. Once a cursorless poll resumes at the
 * stored mark instead of at the head of the mailbox (C4-2), a value that advances the mark past an
 * envelope makes that envelope unreachable for the rest of its lifetime — design §4, R-4 names this
 * as the hazard the change introduces. A field with that power must be inside the signed transcript,
 * exactly as `envelope_ids` already is.
 *
 * This is a BREAKING wire change with a deadline
 * ----------------------------------------------
 * `createMailboxAckMessage` here and `cryptoutil.CreateMailboxAckMessage` in the Go relay
 * (apps/relay/internal/cryptoutil/signatures.go:37-46) are two halves of one contract: the relay
 * rebuilds this exact string byte for byte and verifies it against the recipient's published,
 * root-signed DeviceRecord. A client built before this change cannot ack against a relay built after
 * it. Design §5 records the consequence: the cost is zero only while no relay is yet serving, which
 * is the ordering this flow already fixes.
 *
 * How these tests avoid dictating the implementation
 * --------------------------------------------------
 * The exact new string is the implementer's to mint (design §3 leaves it open; the envelope
 * transcript's own comment says to "mint a new version prefix on both sides together"). Nothing here
 * asserts a literal. What is asserted is the only property that makes the field load-bearing: the
 * transcript, and therefore the signature, must DEPEND on `read_through`.
 *
 * The extra argument is passed through a widened local alias so `pnpm typecheck` stays green while
 * the production signature is still the three-parameter one. At runtime the current implementation
 * ignores it, which is precisely what these assertions detect.
 */

const seed = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const keys = deriveIdentityKeyPairFromSeed(seed, "device:cli-device");
const mailboxId = "mailbox-t5-read-through";
const deviceId = "8cc8010b-d4a1-4ce7-8203-a8f6b055c1b9";
const envelopeIds = [
  "00000000-0000-1000-8000-000000000002",
  "00000000-0000-1000-8000-000000000001",
];

/**
 * Forward declaration of the four-argument transcript C4-2 requires.
 *
 * Signing and verifying go through the raw `signUtf8Message` / `verifyUtf8Message` primitives rather
 * than through `signMailboxAckMessage` / `verifyMailboxAckMessage`, so these assertions do not
 * depend on the ARITY those two wrappers end up with. What they do depend on is the one property
 * that matters: a signature over the transcript for one read position must not authorise another.
 */
const ackTranscript = createMailboxAckMessage as unknown as
  (recipientMailboxId: string, deviceId: string, envelopeIds: string[], readThrough: string) => string;

describe("the mailbox ack transcript binds the recipient's read position (T5 C4-2)", () => {
  it("produces a different transcript for a different read_through", () => {
    const atTwo = ackTranscript(mailboxId, deviceId, envelopeIds, "2");
    const atOneThousand = ackTranscript(mailboxId, deviceId, envelopeIds, "1000");

    expect(
      atTwo,
      "createMailboxAckMessage ignores read_through, so two acks that claim completely different read positions sign the identical string. " +
        "A signature that does not cover the read position leaves it unauthenticated on the wire: whoever can reshape one ack request body can advance a victim's mark and make every envelope behind it unreachable (design §4, R-4). " +
        "The Go twin cryptoutil.CreateMailboxAckMessage must gain the same parameter in the same change",
    ).not.toBe(atOneThousand);
  });

  it("refuses a signature that was made for a different read_through", () => {
    const signature = signUtf8Message(ackTranscript(mailboxId, deviceId, envelopeIds, "2"), keys.secretKey);

    expect(
      verifyUtf8Message(ackTranscript(mailboxId, deviceId, envelopeIds, "2"), signature, keys.publicKey),
      "the transcript the recipient actually signed must verify",
    ).toBe(true);
    expect(
      verifyUtf8Message(ackTranscript(mailboxId, deviceId, envelopeIds, "1000"), signature, keys.publicKey),
      "a signature made for read_through=2 currently authorises read_through=1000, because the value is outside the signed transcript. " +
        "The read position must be bound, or the relay's own authorisation check (mailbox_handler.go:546-554) cannot tell the two apart",
    ).toBe(false);
  });

  it("still normalises envelope id order, so the existing ack contract is unchanged", () => {
    // Pre-existing guarantee (auth.ts:26): the ids are sorted before signing, so a recipient and a
    // relay that received them in different orders still agree. Adding read_through must not disturb
    // it — packages/crypto-core/src/mailbox/auth.test.ts pins the three-argument form and stays green.
    expect(ackTranscript(mailboxId, deviceId, [envelopeIds[1]!, envelopeIds[0]!], "7"))
      .toBe(ackTranscript(mailboxId, deviceId, [envelopeIds[0]!, envelopeIds[1]!], "7"));
  });

  it("binds the read position even when nothing is acknowledged", () => {
    // C4-3: `poll()` advances the mark on the ACCEPT-NOTHING path too, which is the path F-012
    // governs — nothing deleted, no history written, no session advanced, the first rejection still
    // re-raised. The only thing that moves is the recipient's own read position, under the
    // recipient's own signature, so an ack carrying no envelope ids at all must still be a
    // distinguishable, signed statement.
    expect(
      ackTranscript(mailboxId, deviceId, [], "16"),
      "an ack that acknowledges nothing and an ack that acknowledges nothing at a different read position must not sign the same string",
    ).not.toBe(ackTranscript(mailboxId, deviceId, [], "32"));
  });
});
