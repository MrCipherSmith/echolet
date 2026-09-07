package handler

import (
	"crypto/ed25519"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"echolet/apps/relay/internal/cryptoutil"
)

// RED tests for flow 002 / T5 design §3 C4-2 and §8 RED-7: `/v1/mailbox/ack` gains `read_through`,
// the recipient's durable read position, and it is authorised by the device signature
// `authorizeMailboxDevice` already resolves (mailbox_handler.go:579-595).
//
// Why the read position needs its own authorisation rules
// -------------------------------------------------------
// The mark is new server-side state that decides what a recipient is offered NEXT. Design §4, R-4
// states the hazard plainly: "a client that advances the mark past an envelope it never read skips
// that envelope permanently." So the mark is exactly as security-relevant as the ack itself, and it
// must be bound by the same signature and bounded by the same token rule the cursor already has
// (decodeMailboxCursor, mailbox_repo.go:252-269).
//
// What is pinned here, and why each assertion is transcript-agnostic
// ------------------------------------------------------------------
// The exact transcript string is the implementer's to mint - the design only requires that
// `createMailboxAckMessage` (packages/crypto-core/src/mailbox/auth.ts:22-27) and its Go twin
// `CreateMailboxAckMessage` (cryptoutil/signatures.go:37) gain `read_through` together. These tests
// therefore never construct the new transcript. They assert only properties that hold for ANY
// correct transcript:
//
//   - a `read_through` that the presented signature does not cover is refused (it cannot be, if the
//     value is genuinely bound);
//   - a `read_through` that is not a token this relay could have issued is refused with the same
//     bounded `INVALID_SCHEMA` the cursor rule already answers, BEFORE the signature is consulted -
//     the ordering the route already uses for its other client-input bounds
//     (mailbox_handler.go:522-538, deliberately ahead of authorizeMailboxDevice at :540, so
//     malformed client input never answers 500 and never depends on authorisation).
//
// Monotonicity - "a lower read_through never rewinds the stored mark" - is pinned end to end
// instead, by the `>=` in apps/cli/test/e2e/flood-closure.test.ts RED-4, which requires a resuming
// process to start at or after where the previous one stopped.
//
// Only status codes, error codes and identifiers are printed. Ciphertext is inert padding.

// readMarkHarness publishes a recipient and one sender, and puts `envelopes` envelopes in the
// recipient's mailbox through the real, fully authenticated send route.
func readMarkHarness(t *testing.T, envelopes int) (*MailboxHandler, string, string, ed25519.PrivateKey, []string) {
	t.Helper()

	handler, recipient, recipientDeviceKey, mailboxID := quotaHarness(t)
	sender := publishQuotaSender(t, handler, "read-mark-sender")
	nowMS := time.Now().UnixMilli()

	ids := make([]string, 0, envelopes)
	for index := 0; index < envelopes; index++ {
		id := quotaEnvelopeID(index)
		if response := sendFromQuotaSender(t, handler, sender, quotaEnvelope(mailboxID, recipient, id, nowMS)); response.Code != http.StatusOK {
			t.Fatalf("SendEnvelope(%d) status = %d (code %q), want %d", index, response.Code, mailboxErrorCode(t, response), http.StatusOK)
		}
		ids = append(ids, id)
	}
	return handler, mailboxID, recipient.DeviceID, recipientDeviceKey, ids
}

// ackWithReadThrough posts an ack carrying `read_through`, signed with the transcript that exists
// TODAY (recipient_mailbox_id, device_id, envelope_ids). That is the point: today the extra field is
// invisible to the signature, so the relay accepts a read position nobody authorised.
func ackWithReadThrough(
	t *testing.T,
	handler *MailboxHandler,
	mailboxID, deviceID string,
	deviceKey ed25519.PrivateKey,
	envelopeIDs []string,
	readThrough any,
) *httptest.ResponseRecorder {
	t.Helper()

	payload := map[string]any{
		"recipient_mailbox_id": mailboxID,
		"device_id":            deviceID,
		"envelope_ids":         envelopeIDs,
		"signature":            signMessage(t, cryptoutil.CreateMailboxAckMessage(mailboxID, deviceID, envelopeIDs), deviceKey),
	}
	if readThrough != nil {
		payload["read_through"] = readThrough
	}
	return postJSON(t, http.HandlerFunc(handler.AckMailbox), payload)
}

// ackWithReadThroughSignedV2 is the LEGITIMATE-CLIENT helper, and the counterpart of the ATTACK
// helper `ackWithReadThrough` above.
//
// The two exist side by side on purpose, because the difference between them is the whole subject of
// TestAckSignatureMustBindReadThrough. `ackWithReadThrough` signs the V1 transcript
// (recipient_mailbox_id, device_id, envelope_ids), so `read_through` is invisible to the signature -
// that is what makes it an attack, and it must stay that way. This helper signs the V2 transcript
// `CreateMailboxAckMessageV2(recipient_mailbox_id, device_id, envelope_ids, read_through)`, which is
// the transcript the handler actually builds whenever `read_through` is present
// (mailbox_handler.go:706-709) and therefore what a real, correctly implemented recipient sends.
//
// Use this one whenever the point of a test is a client that is authentic but wrong about its read
// position, so the test exercises the read-position rule itself rather than the signature check.
func ackWithReadThroughSignedV2(
	t *testing.T,
	handler *MailboxHandler,
	mailboxID, deviceID string,
	deviceKey ed25519.PrivateKey,
	envelopeIDs []string,
	readThrough string,
) *httptest.ResponseRecorder {
	t.Helper()

	return postJSON(t, http.HandlerFunc(handler.AckMailbox), map[string]any{
		"recipient_mailbox_id": mailboxID,
		"device_id":            deviceID,
		"envelope_ids":         envelopeIDs,
		"read_through":         readThrough,
		"signature":            signMessage(t, cryptoutil.CreateMailboxAckMessageV2(mailboxID, deviceID, envelopeIDs, readThrough), deviceKey),
	})
}

// storedEnvelopeCount is the only evidence that a refused ack changed nothing.
func storedEnvelopeCount(t *testing.T, handler *MailboxHandler, mailboxID string) int {
	t.Helper()
	stored, err := handler.mailboxService.GetEnvelopes(mailboxID, 4096)
	if err != nil {
		t.Fatalf("GetEnvelopes() error = %v", err)
	}
	return len(stored)
}

// TestAckSignatureMustBindReadThrough is RED-7's first half.
//
// The recipient's read position decides what it is offered next and, once a cursorless poll resumes
// at that position instead of at the head of the mailbox, an advanced mark permanently skips
// everything behind it (design §4, R-4). A value that determines that must be inside the signed
// transcript, exactly as `envelope_ids` already is (cryptoutil/signatures.go:37-46) - otherwise
// anyone who can replay or reshape one ack request body can silently advance a victim's mark and
// make the messages behind it unreachable, without ever holding the victim's device key.
func TestAckSignatureMustBindReadThrough(t *testing.T) {
	handler, mailboxID, deviceID, deviceKey, ids := readMarkHarness(t, 3)

	response := ackWithReadThrough(t, handler, mailboxID, deviceID, deviceKey, ids[:1], "2")

	if response.Code == http.StatusOK {
		t.Fatalf("AckMailbox(read_through=2, signed with a transcript that does not mention it) status = 200. "+
			"The presented signature covers only (recipient_mailbox_id, device_id, envelope_ids), so the read position is unauthenticated: a caller who never held the recipient's device key could advance the mark and make every envelope behind it unreachable. "+
			"`createMailboxAckMessage` (packages/crypto-core/src/mailbox/auth.ts:22-27) and its Go twin `CreateMailboxAckMessage` (cryptoutil/signatures.go:37) must bind read_through TOGETHER, under a new version prefix, so the two sides of the wire cannot disagree about what was signed")
	}
	if response.Code < http.StatusBadRequest || response.Code >= http.StatusInternalServerError {
		t.Fatalf("AckMailbox(unbound read_through) status = %d (code %q), want a bounded 4xx: an unauthorised read position is client input the relay declines, not an internal error",
			response.Code, mailboxErrorCode(t, response))
	}
	if count := storedEnvelopeCount(t, handler, mailboxID); count != len(ids) {
		t.Fatalf("mailbox holds %d envelopes after a refused ack, want %d: a refused ack must delete nothing", count, len(ids))
	}
}

// TestAckRefusesAReadThroughTokenThisRelayCouldNotHaveIssued is RED-7's second half.
//
// `read_through` is the same opaque, server-issued decimal token the cursor is, so it takes the same
// rule: at most maxMailboxCursorDigits digits, digits only, and anything else refused with
// INVALID_SCHEMA rather than silently coerced (decodeMailboxCursor, mailbox_repo.go:252-269, whose
// comment states why: coercing an uninterpretable token "would turn a client bug into an invisible
// replay of page one" - and, with a mark, into an invisible SKIP).
//
// Like the envelope_ids bounds at mailbox_handler.go:522-538, this is a shape rule on client input
// and belongs ahead of authorizeMailboxDevice, so a malformed token never answers 500 and never
// depends on who is asking.
func TestAckRefusesAReadThroughTokenThisRelayCouldNotHaveIssued(t *testing.T) {
	handler, mailboxID, deviceID, deviceKey, ids := readMarkHarness(t, 3)

	for _, malformed := range []struct {
		label string
		value any
	}{
		{"non-numeric", "12x"},
		{"negative", "-1"},
		{"leading plus", "+1"},
		{"empty-but-present", " "},
		{"beyond the 15-digit cursor bound", "0000000000000000"},
	} {
		response := ackWithReadThrough(t, handler, mailboxID, deviceID, deviceKey, ids[:1], malformed.value)
		if response.Code == http.StatusOK {
			t.Fatalf("AckMailbox(read_through = %s) status = 200: a token this relay could not have issued must be refused, not ignored and not coerced to zero. "+
				"decodeMailboxCursor already refuses exactly this shape on the poll route (mailbox_repo.go:252-269); the read position needs the same rule, because a token that is silently discarded leaves the recipient's mark wherever it happened to be",
				malformed.label)
		}
		if code := mailboxErrorCode(t, response); response.Code != http.StatusBadRequest || code != "INVALID_SCHEMA" {
			t.Fatalf("AckMailbox(read_through = %s) status = %d code = %q, want 400 INVALID_SCHEMA: this is a bound on client input and, like the envelope_ids bounds at mailbox_handler.go:522-538, it must be applied before authorizeMailboxDevice so malformed input never answers 500 and never depends on authorisation",
				malformed.label, response.Code, code)
		}
		if count := storedEnvelopeCount(t, handler, mailboxID); count != len(ids) {
			t.Fatalf("mailbox holds %d envelopes after a refused ack (%s), want %d", count, malformed.label, len(ids))
		}
	}
}

// TestAckRefusesAReadThroughAboveAnyPositionTheRelayIssued is the third RED-7 rule, and the one that
// actually bounds the damage.
//
// A well-formed token is not necessarily a token this relay ever handed out. A recipient that sends
// a read position beyond the end of its own mailbox marks envelopes as judged that it was never
// offered - the R-4 hazard, reached by a client bug rather than by an attacker, and permanent.
//
// The caller here is therefore the LEGITIMATE but buggy client the comment above describes, so it
// posts through `ackWithReadThroughSignedV2`: it signs the V2 transcript the handler builds whenever
// `read_through` is present, and its signature verifies. That is what makes this a statement about
// the read-position bound and nothing else. Posting it through the attack helper
// `ackWithReadThrough` would sign the V1 transcript instead, and the case would then be decided by
// whichever of the range bound and the signature check happens to run first - which is a fact about
// ordering, not about R-4.
func TestAckRefusesAReadThroughAboveAnyPositionTheRelayIssued(t *testing.T) {
	handler, mailboxID, deviceID, deviceKey, ids := readMarkHarness(t, 3)

	response := ackWithReadThroughSignedV2(t, handler, mailboxID, deviceID, deviceKey, ids[:1], "999999999999999")

	if response.Code == http.StatusOK {
		t.Fatalf("AckMailbox(read_through far above every position this mailbox ever held) status = 200. "+
			"The mailbox holds %d envelopes, so no walk could have reported that position. Accepting it advances the recipient's mark past envelopes it was never offered, and once a cursorless poll resumes at the mark those envelopes are unreachable for the rest of their lifetime (design §4, R-4)",
			len(ids))
	}
	if code := mailboxErrorCode(t, response); response.Code != http.StatusBadRequest || code != "INVALID_SCHEMA" {
		t.Fatalf("AckMailbox(read_through above every issued position) status = %d code = %q, want 400 INVALID_SCHEMA, the same answer decodeMailboxCursor gives a token this relay could not have issued",
			response.Code, code)
	}
	if count := storedEnvelopeCount(t, handler, mailboxID); count != len(ids) {
		t.Fatalf("mailbox holds %d envelopes after a refused ack, want %d", count, len(ids))
	}
}

// TestAckWithoutReadThroughStillAcknowledgesAndDeletes is a GUARD, not a RED.
//
// Whatever shape `read_through` takes, an ack that carries envelope ids must keep doing the one job
// it has had since F-012: delete exactly those envelopes, under the recipient's own signature. This
// is here so the transcript change cannot quietly break acknowledgement itself - the ack-recovery
// case in apps/cli/test/e2e/two-process.test.ts is the named hazard of this whole change.
func TestAckWithoutReadThroughStillAcknowledgesAndDeletes(t *testing.T) {
	handler, mailboxID, deviceID, deviceKey, ids := readMarkHarness(t, 3)

	response := ackWithReadThrough(t, handler, mailboxID, deviceID, deviceKey, ids[:2], nil)
	if response.Code != http.StatusOK {
		t.Fatalf("AckMailbox(2 envelope ids, no read_through) status = %d (code %q), want 200", response.Code, mailboxErrorCode(t, response))
	}
	if count := storedEnvelopeCount(t, handler, mailboxID); count != 1 {
		t.Fatalf("mailbox holds %d envelopes after acknowledging 2 of 3, want 1", count)
	}
}
