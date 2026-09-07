package handler

import (
	"net/http"
	"strings"
	"testing"
	"time"

	"echolet/apps/relay/internal/model"
)

// RED tests for review finding BE-R-001 (minor), at the route the attacker actually reaches.
//
// When these tests were written /v1/messages/send had no sender authentication (router.go:76);
// T51 added it, but a sender identity still costs one unauthenticated /v1/device-records/publish
// (finding T52-F-001), so the envelope body is still attacker-supplied. The independent verifier drove a 70000-byte recipient_mailbox_id through this
// handler and got HTTP 500, while the identical envelope with a short id got 200; a 70000-byte
// envelope_id produced the same 500. Both are halves of the Badger key at mailbox_repo.go:261-263,
// so the store, not validation, is what refuses them - and an internal error is the wrong answer
// to malformed client input.
//
// The required behaviour is a bounded 4xx rejection with a client error code, and nothing
// persisted. No exact maximum is pinned, only that 70000 bytes is refused and that ordinary
// identifiers still succeed.
//
// Only lengths, status codes and error codes are printed; identifier values are synthetic padding
// and never appear in output.

func TestSendEnvelopeRejectsOversizedIdentifiersWithClientError(t *testing.T) {
	const oversizedBytes = 70000
	nowMS := time.Now().UnixMilli()
	hourMS := int64(time.Hour / time.Millisecond)

	cases := []struct {
		name          string
		mutate        func(*model.MailboxEnvelope)
		mutatedLength func(*model.MailboxEnvelope) int
	}{
		{
			name:          "oversized recipient_mailbox_id",
			mutate:        func(e *model.MailboxEnvelope) { e.RecipientMailboxID = strings.Repeat("A", oversizedBytes) },
			mutatedLength: func(e *model.MailboxEnvelope) int { return len(e.RecipientMailboxID) },
		},
		{
			name:          "oversized envelope_id",
			mutate:        func(e *model.MailboxEnvelope) { e.EnvelopeID = strings.Repeat("A", oversizedBytes) },
			mutatedLength: func(e *model.MailboxEnvelope) int { return len(e.EnvelopeID) },
		},
	}

	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			handler, _, mailboxService := newMailboxHandlerTestHarness(t)

			envelope := newTestMailboxEnvelope(
				"mailbox-ber001-identifier",
				"7c1e4a90-5d3b-4f26-8e91-0a6b5c4d3e2f",
				"QUFBQUFBQUFBQUFB",
				nowMS-1000,
				nowMS+24*hourMS,
			)
			test.mutate(envelope)

			response := sendEnvelopeRequest(t, handler, envelope)

			if response.Code >= http.StatusInternalServerError {
				t.Fatalf("SendEnvelope(identifier_len=%d) status = %d, want a bounded 4xx: attacker-supplied identifier length must be validated, not surfaced as an internal error",
					test.mutatedLength(envelope), response.Code)
			}
			if response.Code < http.StatusBadRequest {
				t.Fatalf("SendEnvelope(identifier_len=%d) status = %d, want a 4xx rejection",
					test.mutatedLength(envelope), response.Code)
			}
			if code := mailboxErrorCode(t, response); code == "" || code == "INTERNAL_ERROR" {
				t.Fatalf("SendEnvelope(identifier_len=%d) error code = %q, want a client-error code",
					test.mutatedLength(envelope), code)
			}

			stored, err := mailboxService.GetEnvelopes(envelope.RecipientMailboxID, 10)
			if err != nil {
				t.Fatalf("GetEnvelopes() error = %v", err)
			}
			if len(stored) != 0 {
				t.Fatalf("stored envelopes = %d, want 0: a rejected envelope must never be persisted", len(stored))
			}
		})
	}

	// Control: the identical envelope with ordinary identifiers must still be accepted, so the
	// bound cannot be obtained by refusing the route outright.
	t.Run("ordinary identifiers are still accepted", func(t *testing.T) {
		handler, _, _ := newMailboxHandlerTestHarness(t)

		envelope := newTestMailboxEnvelope(
			"mailbox-ber001-control",
			"1f8d6b23-9e04-4a7c-85d1-3b2c9f6e0a47",
			"QUFBQUFBQUFBQUFB",
			nowMS-1000,
			nowMS+24*hourMS,
		)

		response := sendEnvelopeRequest(t, handler, envelope)
		if response.Code != http.StatusOK {
			t.Fatalf("SendEnvelope(ordinary identifiers) status = %d, want %d (code %q)",
				response.Code, http.StatusOK, mailboxErrorCode(t, response))
		}
	})
}
