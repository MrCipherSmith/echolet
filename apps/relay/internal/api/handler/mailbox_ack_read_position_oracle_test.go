package handler

import (
	"crypto/ed25519"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"

	"echolet/apps/relay/internal/cryptoutil"
)

// RED test for finding T10R3-F-002: `/v1/mailbox/ack` is still a lifetime-envelope-count oracle for
// a caller who holds the victim's contact card.
//
// What T14 fixed, and what it did not
// -----------------------------------
// T14 split the read-position rule in two: `decodeReadThroughShape` (a pure shape check on client
// input, still ahead of the challenge, the device binding and the signature) and
// `readThroughWithinIssued` (the bound that CONSULTS THE MAILBOX through
// `HighestIssuedPosition`). On `/v1/mailbox/poll` the mailbox-dependent half was moved after
// `VerifyMessageSignature` (mailbox_handler.go:549) and the oracle is closed there. On
// `/v1/mailbox/ack` it was moved only as far as `authorizeMailboxDevice` (mailbox_handler.go:699),
// which is BEFORE the signature is verified.
//
// So on the ack route the relay still answers two different things to a caller who cannot produce a
// verifying signature: `400 INVALID_SCHEMA` when the submitted `read_through` is above the highest
// position this mailbox was ever issued, and `403 INVALID_SIGNATURE` when it is at or below it. That
// pair of answers is a comparator on the victim's LIFETIME received-envelope count, and a binary
// search over it recovers the number exactly - T10 attempt 3 recovered 66 in 13 requests.
//
// Why "it needs a real device_id" is not a mitigation
// ---------------------------------------------------
// The implementation report describes what remains as a bound requiring the caller to name a device
// this mailbox knows. `mailbox_id` is `sha256(identity_id + ":mailbox:v1")` and BOTH `identity_id`
// and `device_id` are printed on the same contact card (packages/protocol device_record), so the
// caller who can compute the mailbox id is the same caller who can read the device id off the card.
// Naming a genuine device does not shrink the adversary population at all; it is the same set of
// people either way. That is why the probe below deliberately presents the REAL recipient device id
// together with a signature that is not one.
//
// What this file asserts, and what it deliberately does not
// ---------------------------------------------------------
// It asserts only the OUTCOME a caller can observe - the (status, error code) pair - and requires it
// not to vary with the mailbox's contents. It does not name a mechanism. Moving
// `readThroughWithinIssued` after `VerifyMessageSignature` on this route satisfies it; so does
// answering every signature-less ack that carries a read position with one uniform refusal. What it
// does NOT permit is satisfying the requirement by deleting the R-4 bound: `TestAckReadPositionBound
// SurvivesForAnAuthenticatedCaller` below is a guard requiring an out-of-range position under a
// VALID signature to still be refused, and requiring a legitimate in-range ack to still succeed.
//
// Only statuses, error codes and counts are printed. No request body, signature or key material
// appears in any message here.

// oracleLadderProbe posts one ack carrying `read_through` under a signature that cannot verify, and
// returns the only thing a caller can see: "<status> <error code>".
//
// The signature is a real ed25519 signature over the V1 ack transcript, which the relay does not use
// once `read_through` is present. It is therefore a well-formed value that simply does not verify -
// exactly the position a card-holding third party is in, and never a malformed field that a shape
// check could refuse for an unrelated reason.
func oracleLadderProbe(
	t *testing.T,
	handler *MailboxHandler,
	mailboxID, deviceID string,
	unrelatedKey ed25519.PrivateKey,
	envelopeIDs []string,
	readThrough string,
) string {
	t.Helper()

	payload := map[string]any{
		"recipient_mailbox_id": mailboxID,
		"device_id":            deviceID,
		"envelope_ids":         envelopeIDs,
		"read_through":         readThrough,
		"signature":            signMessage(t, cryptoutil.CreateMailboxAckMessage(mailboxID, deviceID, envelopeIDs), unrelatedKey),
	}
	response := postJSON(t, http.HandlerFunc(handler.AckMailbox), payload)
	return fmt.Sprintf("%d %s", response.Code, mailboxErrorCode(t, response))
}

// TestAckDoesNotAnswerTheMailboxEnvelopeCountToAnUnverifiedCaller is the RED assertion.
func TestAckDoesNotAnswerTheMailboxEnvelopeCountToAnUnverifiedCaller(t *testing.T) {
	const allocated = 6
	handler, mailboxID, deviceID, _, ids := readMarkHarness(t, allocated)

	// An unrelated key. Every field the caller presents is genuine except the one that matters: the
	// mailbox id and the device id are both read straight off the victim's contact card, and the
	// signature is a real signature by somebody who is not the recipient.
	_, unrelatedKey, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatalf("GenerateKey() error = %v", err)
	}

	probe := func(readThrough uint64) string {
		return oracleLadderProbe(t, handler, mailboxID, deviceID, unrelatedKey, ids[:1], fmt.Sprintf("%d", readThrough))
	}

	// The binary search T10 attempt 3 ran, reproduced so the failure message carries the number it
	// recovers rather than merely asserting that two strings differ.
	baseline := probe(0)
	var low, high uint64 = 0, 4096
	for low < high {
		mid := (low + high + 1) / 2
		if probe(mid) == baseline {
			low = mid
		} else {
			high = mid - 1
		}
	}

	// A ladder that straddles the true count. If the answer is a function of the mailbox's contents
	// rather than of the request alone, these are not all the same string.
	ladder := []uint64{0, 1, allocated - 1, allocated, allocated + 1, allocated + 33, 1000, 4096}
	answers := make([]string, 0, len(ladder))
	distinct := make(map[string]struct{}, len(ladder))
	for _, value := range ladder {
		answer := probe(value)
		answers = append(answers, answer)
		distinct[answer] = struct{}{}
	}

	if len(distinct) != 1 {
		t.Fatalf("AckMailbox answered %d distinct results %v across read_through values %v, and a binary search over them recovered %d against a mailbox holding exactly %d envelopes. "+
			"The caller presented the victim's own mailbox id and the victim's own device id - both printed on the same contact card - with a signature that does not verify, so it has proved nothing and must learn nothing. "+
			"`readThroughWithinIssued` reads HighestIssuedPosition at mailbox_handler.go:699, after authorizeMailboxDevice but BEFORE VerifyMessageSignature, so the pair of refusals is a comparator on the victim's lifetime received-envelope count (finding T10R3-F-002; SEC-01 section 6.2 confines what the relay exposes to third parties). "+
			"The poll route already applies the same bound after the signature verifies (mailbox_handler.go:549); this route must not answer a question about the mailbox before the caller is established either. "+
			"Answer must be independent of the mailbox's contents",
			len(distinct), answers, ladder, low, len(ids))
	}
}

// TestAckDoesNotAnswerTheMailboxEnvelopeCountToAnUnknownDevice is a GUARD, already satisfied.
//
// It records the half of T10-F-002 that T14 did close on this route, so a fix for the half above
// cannot reopen it: a caller who names a device this mailbox has never seen must get one uniform
// refusal, whatever read position it submits.
func TestAckDoesNotAnswerTheMailboxEnvelopeCountToAnUnknownDevice(t *testing.T) {
	const allocated = 6
	handler, mailboxID, _, _, ids := readMarkHarness(t, allocated)

	_, unrelatedKey, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatalf("GenerateKey() error = %v", err)
	}
	strangerDeviceID := quotaDeviceUUID("t15-ack-oracle-stranger")

	distinct := make(map[string]struct{})
	answers := make([]string, 0)
	for _, value := range []string{"0", "1", "5", "6", "7", "99", "4096"} {
		answer := oracleLadderProbe(t, handler, mailboxID, strangerDeviceID, unrelatedKey, ids[:1], value)
		answers = append(answers, answer)
		distinct[answer] = struct{}{}
	}
	if len(distinct) != 1 {
		t.Fatalf("AckMailbox answered %d distinct results %v to a caller naming a device this mailbox has never seen: the answer must not depend on the mailbox's contents", len(distinct), answers)
	}
}

// TestAckReadPositionBoundSurvivesForAnAuthenticatedCaller is the control that keeps the assertion
// above from being satisfied by deleting the protection instead of reordering it.
//
// Design section 4, R-4: a recipient that reports a position beyond the end of its own mailbox marks
// envelopes as judged that it was never offered, and once a cursorless poll resumes at the mark they
// are unreachable for the rest of their lifetime. That bound must still apply - it simply must be
// applied to a caller the relay has established, not to anyone who can compute a mailbox id.
func TestAckReadPositionBoundSurvivesForAnAuthenticatedCaller(t *testing.T) {
	const allocated = 6
	handler, mailboxID, deviceID, deviceKey, ids := readMarkHarness(t, allocated)

	signedAck := func(readThrough string, envelopeIDs []string) *httptest.ResponseRecorder {
		payload := map[string]any{
			"recipient_mailbox_id": mailboxID,
			"device_id":            deviceID,
			"envelope_ids":         envelopeIDs,
			"read_through":         readThrough,
			"signature":            signMessage(t, cryptoutil.CreateMailboxAckMessageV2(mailboxID, deviceID, envelopeIDs, readThrough), deviceKey),
		}
		return postJSON(t, http.HandlerFunc(handler.AckMailbox), payload)
	}

	// Out of range, correctly signed: still refused, and nothing deleted.
	refused := signedAck("999999999999999", ids[:1])
	if code := mailboxErrorCode(t, refused); refused.Code != http.StatusBadRequest || code != "INVALID_SCHEMA" {
		t.Fatalf("AckMailbox(read_through above every issued position, correctly signed) status = %d code = %q, want 400 INVALID_SCHEMA: the R-4 bound must survive whatever reordering closes the oracle",
			refused.Code, code)
	}
	if count := storedEnvelopeCount(t, handler, mailboxID); count != len(ids) {
		t.Fatalf("mailbox holds %d envelopes after a refused ack, want %d", count, len(ids))
	}

	// In range, correctly signed: still acknowledged, and the envelopes really go.
	accepted := signedAck("1", ids[:2])
	if accepted.Code != http.StatusOK {
		t.Fatalf("AckMailbox(read_through=1, correctly signed) status = %d (code %q), want 200: a legitimate recipient reporting a real read position must still be served",
			accepted.Code, mailboxErrorCode(t, accepted))
	}
	if count := storedEnvelopeCount(t, handler, mailboxID); count != len(ids)-2 {
		t.Fatalf("mailbox holds %d envelopes after acknowledging 2 of %d, want %d", count, len(ids), len(ids)-2)
	}
}
