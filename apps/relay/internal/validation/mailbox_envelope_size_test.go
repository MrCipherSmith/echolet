package validation

import (
	"strings"
	"testing"
	"time"

	"echolet/apps/relay/internal/model"
)

// RED test for review finding F-006 (b).
//
// ValidateMailboxEnvelope currently compares only the attacker-supplied
// SizeBytes against maxBytes (validate.go:82) and never inspects the actual
// decoded ciphertext, so a small declared size_bytes smuggles an oversized
// ciphertext past the configured message limit and into Badger.
//
// The CLI contract defines size_bytes as the byte length of the ciphertext
// string itself (apps/cli/src/runtime/outbound.ts:79 and inbound.ts:46), so an
// envelope whose declared size matches its ciphertext and stays within the
// limit must keep validating.
//
// Ciphertext values are synthetic padding and are never printed.

func TestValidateMailboxEnvelopeChecksActualCiphertextBytes(t *testing.T) {
	const maxBytes int64 = 1024

	tests := []struct {
		name           string
		ciphertextLen  int
		declaredSize   int64
		wantError      bool
		wantErrorCodes []string
	}{
		{
			name:           "oversized ciphertext with understated size_bytes",
			ciphertextLen:  4096,
			declaredSize:   16,
			wantError:      true,
			wantErrorCodes: []string{"PAYLOAD_TOO_LARGE"},
		},
		{
			name:           "declared size_bytes does not match ciphertext",
			ciphertextLen:  512,
			declaredSize:   8,
			wantError:      true,
			wantErrorCodes: []string{"INVALID_SCHEMA", "PAYLOAD_TOO_LARGE"},
		},
		{
			name:          "consistent ciphertext within the limit is accepted",
			ciphertextLen: 512,
			declaredSize:  512,
			wantError:     false,
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			envelope := newSizeTestEnvelope(test.ciphertextLen, test.declaredSize)

			err := ValidateMailboxEnvelope(envelope, maxBytes)

			if !test.wantError {
				if err != nil {
					t.Fatalf("ValidateMailboxEnvelope(consistent envelope) error = %v, want nil", err)
				}
				return
			}
			if err == nil {
				t.Fatalf("ValidateMailboxEnvelope(ciphertext_len=%d, size_bytes=%d, max=%d) = nil, want rejection %v: actual ciphertext bytes must be checked against both size_bytes and the configured maximum",
					test.ciphertextLen, test.declaredSize, maxBytes, test.wantErrorCodes)
			}
			validationErr, ok := err.(*ValidationError)
			if !ok {
				t.Fatalf("ValidateMailboxEnvelope() error type = %T, want *ValidationError", err)
			}
			if !containsCode(test.wantErrorCodes, validationErr.Code) {
				t.Fatalf("ValidateMailboxEnvelope() error code = %q, want one of %v", validationErr.Code, test.wantErrorCodes)
			}
		})
	}
}

func newSizeTestEnvelope(ciphertextLen int, declaredSize int64) *model.MailboxEnvelope {
	nowMS := time.Now().UnixMilli()
	return &model.MailboxEnvelope{
		Type:                "mailbox_envelope",
		Version:             1,
		EnvelopeID:          "9d1c0f77-4b2a-4a1e-a6f0-5c8e3b2d1a09",
		MessageID:           "2b7e4d90-8c1a-4f3b-9e5d-6a0c7b8d9e10",
		SenderIdentityID:    "sender-identity",
		SenderDeviceID:      "7319a570-67c7-4c8b-bb0b-4dcdf41de5ec",
		RecipientIdentityID: "recipient-identity",
		RecipientDeviceID:   "8cc8010b-d4a1-4ce7-8203-a8f6b055c1b9",
		RecipientMailboxID:  "mailbox-f006-size",
		PayloadType:         "ciphertext_message",
		Ciphertext:          strings.Repeat("A", ciphertextLen),
		CreatedAtMs:         nowMS,
		ExpiresAtMs:         nowMS + 24*int64(time.Hour/time.Millisecond),
		SizeBytes:           declaredSize,
	}
}

func containsCode(codes []string, code string) bool {
	for _, candidate := range codes {
		if candidate == code {
			return true
		}
	}
	return false
}
