package validation

import (
	"strings"
	"testing"
	"time"

	"echolet/apps/relay/internal/model"
)

// RED tests for review finding BE-R-001 (minor).
//
// ValidateMailboxEnvelope (validate.go:72-99) bounds the ciphertext but inspects no identifier
// length at all. The independent verifier drove a 70000-byte recipient_mailbox_id through the
// handler harness and got HTTP 500; the identical envelope with a short id got 200. envelope_id
// has the same problem: both are halves of the Badger key built at mailbox_repo.go:261-263, so an
// oversized value is refused by the store rather than by validation, and purely attacker-supplied
// input turns into an internal error.
//
// Validation must refuse such an envelope itself, as a bounded client error. These tests
// deliberately do NOT pin a particular maximum: they require that a plainly oversized identifier
// is refused as a *ValidationError, and that ordinary identifiers keep validating, so the
// implementer is free to choose a sensible bound.
//
// Identifier values are synthetic padding and only their lengths are ever printed.

// oversizedIdentifierBytes is the length the verifier reproduced the HTTP 500 with.
const oversizedIdentifierBytes = 70000

func TestValidateMailboxEnvelopeBoundsIdentifierLengths(t *testing.T) {
	const maxBytes int64 = 262144

	tests := []struct {
		name    string
		mutate  func(*model.MailboxEnvelope)
		lengths func(*model.MailboxEnvelope) int
	}{
		{
			name:    "oversized recipient_mailbox_id",
			mutate:  func(e *model.MailboxEnvelope) { e.RecipientMailboxID = strings.Repeat("A", oversizedIdentifierBytes) },
			lengths: func(e *model.MailboxEnvelope) int { return len(e.RecipientMailboxID) },
		},
		{
			name:    "oversized envelope_id",
			mutate:  func(e *model.MailboxEnvelope) { e.EnvelopeID = strings.Repeat("A", oversizedIdentifierBytes) },
			lengths: func(e *model.MailboxEnvelope) int { return len(e.EnvelopeID) },
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			envelope := newIdentifierTestEnvelope()
			test.mutate(envelope)

			err := ValidateMailboxEnvelope(envelope, maxBytes)

			if err == nil {
				t.Fatalf("ValidateMailboxEnvelope(identifier_len=%d) = nil, want a bounded rejection: an unbounded attacker-supplied identifier must be refused by validation, not by the store",
					test.lengths(envelope))
			}
			validationErr, ok := err.(*ValidationError)
			if !ok {
				t.Fatalf("ValidateMailboxEnvelope(identifier_len=%d) error type = %T, want *ValidationError",
					test.lengths(envelope), err)
			}
			if validationErr.Code != "INVALID_SCHEMA" && validationErr.Code != "PAYLOAD_TOO_LARGE" {
				t.Fatalf("ValidateMailboxEnvelope(identifier_len=%d) error code = %q, want INVALID_SCHEMA or PAYLOAD_TOO_LARGE",
					test.lengths(envelope), validationErr.Code)
			}
		})
	}

	// Control: ordinary identifiers must keep validating, so the bound cannot be obtained by
	// refusing everything.
	t.Run("ordinary identifiers still validate", func(t *testing.T) {
		envelope := newIdentifierTestEnvelope()
		if err := ValidateMailboxEnvelope(envelope, maxBytes); err != nil {
			t.Fatalf("ValidateMailboxEnvelope(ordinary identifiers) error = %v, want nil", err)
		}
	})
}

// newIdentifierTestEnvelope builds an envelope whose every field is ordinary and valid: a
// 43-character base64url mailbox id, UUID envelope/message/device ids and a short ciphertext.
func newIdentifierTestEnvelope() *model.MailboxEnvelope {
	nowMS := time.Now().UnixMilli()
	ciphertext := "QUFBQUFBQUFBQUFB"
	return &model.MailboxEnvelope{
		Type:                "mailbox_envelope",
		Version:             1,
		EnvelopeID:          "6d0f2a41-3b8c-4e7d-9a52-1c4b7e8f0a36",
		MessageID:           "0b3c9e51-72af-4d18-8c6e-5a2f4b1d907e",
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
