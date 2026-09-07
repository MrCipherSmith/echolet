package validation

import (
	"strings"
	"testing"
	"time"

	"echolet/apps/relay/internal/model"
)

// RED tests for round-2 review findings R2-001 / R2-L-001 (major), path A: the relay and its own
// client do not agree on what a valid mailbox envelope is.
//
// T41 bounded every identifier-shaped field of the envelope by LENGTH
// (validate.go:117-121, maxEnvelopeIdentifierBytes). It checks nothing about their SHAPE. The
// CLI's wire schema does: MailboxEnvelopeSchema (packages/protocol/src/types/mailboxEnvelope.ts)
// declares
//
//	envelope_id          z.string().uuid()
//	message_id           z.string().uuid()
//	sender_device_id     z.string().uuid()
//	recipient_device_id  z.string().uuid()
//	payload_type         z.literal("ciphertext_message")
//
// and the whole poll response is parsed as z.array(MailboxEnvelopeSchema.strict())
// (apps/cli/src/transport/relayClient.ts:80) - one array, all or nothing.
//
// When these tests were written /v1/messages/send had no sender authentication; T51 added it, but
// a sender identity still costs one unauthenticated /v1/device-records/publish (finding T52-F-001),
// so without this shape check the relay would still store, and later return, an
// envelope its own client cannot parse. One such envelope makes the victim's every poll fail with
// INVALID_RELAY_RESPONSE before accept() runs and before ackPending() is reached, so the
// legitimate traffic queued behind it is never delivered and is lost at its declared expiry. That
// is the HL-N-001 harm restored in full, at the cost of one unauthenticated request.
//
// What these tests pin is the AGREEMENT, not a particular implementation of it: an envelope this
// relay accepts must be one the client's schema can parse. They deliberately do not pin the
// rejection message, and they pin only INVALID_SCHEMA as the code because that is what every other
// shape rejection on this route already uses.
//
// Identifier values below are synthetic literals, never secrets, and no request body is printed.

// shapeInvalidEnvelopes enumerates exactly the five fields MailboxEnvelopeSchema constrains by
// shape and ValidateMailboxEnvelope does not. Each mutation is well under the 256-byte identifier
// bound T41 added, so the existing length check cannot answer any of them.
func shapeInvalidEnvelopes() []struct {
	Name   string
	Field  string
	Mutate func(*model.MailboxEnvelope)
} {
	return []struct {
		Name   string
		Field  string
		Mutate func(*model.MailboxEnvelope)
	}{
		{"envelope_id is not a uuid", "envelope_id", func(e *model.MailboxEnvelope) { e.EnvelopeID = "poison-not-a-uuid" }},
		{"message_id is not a uuid", "message_id", func(e *model.MailboxEnvelope) { e.MessageID = "also-not-a-uuid" }},
		{"sender_device_id is not a uuid", "sender_device_id", func(e *model.MailboxEnvelope) { e.SenderDeviceID = "not-a-uuid" }},
		{"recipient_device_id is not a uuid", "recipient_device_id", func(e *model.MailboxEnvelope) { e.RecipientDeviceID = "not-a-uuid" }},
		{"payload_type is not the ciphertext_message literal", "payload_type", func(e *model.MailboxEnvelope) { e.PayloadType = "not_ciphertext_message" }},
	}
}

func TestValidateMailboxEnvelopeAgreesWithTheClientWireSchema(t *testing.T) {
	const maxBytes int64 = 262144

	for _, test := range shapeInvalidEnvelopes() {
		t.Run(test.Name, func(t *testing.T) {
			envelope := newShapeTestEnvelope()
			test.Mutate(envelope)

			err := ValidateMailboxEnvelope(envelope, maxBytes)

			if err == nil {
				t.Fatalf("ValidateMailboxEnvelope(malformed %s) = nil, want a rejection: the relay must not store an envelope its own client's wire schema (MailboxEnvelopeSchema) refuses to parse, because one such envelope wedges the recipient's every poll",
					test.Field)
			}
			validationErr, ok := err.(*ValidationError)
			if !ok {
				t.Fatalf("ValidateMailboxEnvelope(malformed %s) error type = %T, want *ValidationError", test.Field, err)
			}
			if validationErr.Code != "INVALID_SCHEMA" {
				t.Fatalf("ValidateMailboxEnvelope(malformed %s) error code = %q, want INVALID_SCHEMA", test.Field, validationErr.Code)
			}
		})
	}

	// Controls. The agreement runs in both directions: every shape the CLI actually emits must keep
	// validating, so the rejection above cannot be obtained by tightening the route into uselessness.
	t.Run("an envelope in the shape the CLI emits still validates", func(t *testing.T) {
		if err := ValidateMailboxEnvelope(newShapeTestEnvelope(), maxBytes); err != nil {
			t.Fatalf("ValidateMailboxEnvelope(CLI-shaped envelope) error = %v, want nil", err)
		}
	})

	// The three identifiers the client declares as free strings must NOT be forced into UUID shape:
	// sender_identity_id and recipient_identity_id are base64url ed25519 keys and
	// recipient_mailbox_id is a base64url SHA-256 digest (apps/cli/src/runtime/outbound.ts,
	// packages/crypto-core deriveMailboxId). Requiring UUIDs there would refuse all real traffic.
	t.Run("base64url identity and mailbox identifiers are still accepted", func(t *testing.T) {
		envelope := newShapeTestEnvelope()
		envelope.SenderIdentityID = "kK3fXcQ2m8Nv1pRt5YbHs7Ld0WjZaE6UoCgIn9TxPyQ"
		envelope.RecipientIdentityID = "Zq7Wn2Bs5Xk9Ld3Pc0Rt8Yv1Ma6Jh4Ug7Ef2Ib5Oa0"
		envelope.RecipientMailboxID = "R8Zt3nQpXv1LcYbA7uKdWm4EhSj0FgTiNrOzPyBxQmU"
		if err := ValidateMailboxEnvelope(envelope, maxBytes); err != nil {
			t.Fatalf("ValidateMailboxEnvelope(base64url identity/mailbox identifiers) error = %v, want nil: only the four UUID fields and payload_type are shape-constrained by the client schema", err)
		}
	})

	// The length bound T41 added is still the answer for an oversized identifier: closing the shape
	// gap must not replace BE-R-001's guard with a shape check that a short-but-malformed value
	// passes and a long-but-well-formed value fails.
	t.Run("the identifier length bound still holds", func(t *testing.T) {
		envelope := newShapeTestEnvelope()
		envelope.SenderIdentityID = strings.Repeat("A", 70000)
		err := ValidateMailboxEnvelope(envelope, maxBytes)
		if err == nil {
			t.Fatalf("ValidateMailboxEnvelope(sender_identity_id length=%d) = nil, want the BE-R-001 length rejection", len(envelope.SenderIdentityID))
		}
	})
}

// newShapeTestEnvelope builds the envelope exactly as the CLI emits it: UUID envelope/message and
// device identifiers, the ciphertext_message payload type, a base64url mailbox digest and a short
// synthetic ciphertext.
func newShapeTestEnvelope() *model.MailboxEnvelope {
	nowMS := time.Now().UnixMilli()
	ciphertext := "QUFBQUFBQUFBQUFB"
	return &model.MailboxEnvelope{
		Type:                "mailbox_envelope",
		Version:             1,
		EnvelopeID:          "b1d4e7c2-5a63-4f18-9c07-2e8b6a4d3f51",
		MessageID:           "3f9a0c86-71b2-4d5e-8a14-6c9e2b7d0f43",
		SenderIdentityID:    "sender-identity",
		SenderDeviceID:      "7319a570-67c7-4c8b-bb0b-4dcdf41de5ec",
		RecipientIdentityID: "recipient-identity",
		RecipientDeviceID:   "8cc8010b-d4a1-4ce7-8203-a8f6b055c1b9",
		RecipientMailboxID:  "R8Zt3nQpXv1LcYbA7uKdWm4EhSj0FgTiNrOzPyBxQmU",
		PayloadType:         "ciphertext_message",
		Ciphertext:          ciphertext,
		CreatedAtMs:         nowMS - 1000,
		ExpiresAtMs:         nowMS + 24*int64(time.Hour/time.Millisecond),
		SizeBytes:           int64(len(ciphertext)),
	}
}
