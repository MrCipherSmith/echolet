package handler

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"echolet/apps/relay/internal/model"
)

// RED tests for review findings F-004 and F-005 (submission side).
//
// F-004: saving a DIFFERENT envelope body under an already-used
// (recipient mailbox, envelope_id) pair must be rejected as a conflict mapped to
// HTTP 409, while a byte-identical replay stays idempotent and the originally
// accepted envelope remains retrievable unchanged.
//
// F-005 (a): an envelope whose declared expires_at_ms already lies in the past
// must be rejected at submission and must never be persisted.
//
// The tests intentionally avoid printing ciphertext values; only lengths,
// identifiers and status codes are reported on failure.

const (
	f004MailboxID          = "mailbox-f004-envelope-identity"
	f004EnvelopeID         = "3a4b1c66-0f2f-4c74-9d21-9b1d5f1a7c10"
	f004AcceptedCiphertext = "QUFBQUFBQUFBQUFB"
	f004ChangedCiphertext  = "QkJCQkJCQkJCQkJCQkJCQg"
)

func TestSendEnvelopeRejectsConflictingEnvelopeIDWithHTTP409(t *testing.T) {
	handler, _, mailboxService := newMailboxHandlerTestHarness(t)

	nowMS := time.Now().UnixMilli()
	accepted := newTestMailboxEnvelope(
		f004MailboxID,
		f004EnvelopeID,
		f004AcceptedCiphertext,
		nowMS-1000,
		nowMS+24*int64(time.Hour/time.Millisecond),
	)

	firstSend := sendEnvelopeRequest(t, handler, accepted)
	if firstSend.Code != http.StatusOK {
		t.Fatalf("SendEnvelope(first) status = %d, want %d (code %q)",
			firstSend.Code, http.StatusOK, mailboxErrorCode(t, firstSend))
	}

	replay := sendEnvelopeRequest(t, handler, accepted)
	if replay.Code != http.StatusOK {
		t.Fatalf("SendEnvelope(byte-identical replay) status = %d, want %d (code %q): identical retries must stay idempotent",
			replay.Code, http.StatusOK, mailboxErrorCode(t, replay))
	}

	conflicting := newTestMailboxEnvelope(
		f004MailboxID,
		f004EnvelopeID,
		f004ChangedCiphertext,
		nowMS-1000,
		nowMS+24*int64(time.Hour/time.Millisecond),
	)
	conflict := sendEnvelopeRequest(t, handler, conflicting)
	if conflict.Code != http.StatusConflict {
		t.Fatalf("SendEnvelope(different body, same envelope_id) status = %d, want %d ENVELOPE_ID_CONFLICT (got code %q)",
			conflict.Code, http.StatusConflict, mailboxErrorCode(t, conflict))
	}
	if code := mailboxErrorCode(t, conflict); code != "ENVELOPE_ID_CONFLICT" {
		t.Fatalf("SendEnvelope(different body, same envelope_id) error code = %q, want ENVELOPE_ID_CONFLICT", code)
	}

	stored, err := mailboxService.GetEnvelopes(f004MailboxID, 10)
	if err != nil {
		t.Fatalf("GetEnvelopes() error = %v", err)
	}
	if len(stored) != 1 {
		t.Fatalf("stored envelopes = %d, want 1", len(stored))
	}
	if stored[0].EnvelopeID != f004EnvelopeID {
		t.Fatalf("stored envelope_id = %q, want %q", stored[0].EnvelopeID, f004EnvelopeID)
	}
	if stored[0].Ciphertext != accepted.Ciphertext || stored[0].SizeBytes != accepted.SizeBytes {
		t.Fatalf("originally accepted envelope was overwritten: stored size_bytes = %d, want %d",
			stored[0].SizeBytes, accepted.SizeBytes)
	}
}

func TestSendEnvelopeRejectsAlreadyExpiredEnvelope(t *testing.T) {
	handler, _, mailboxService := newMailboxHandlerTestHarness(t)

	nowMS := time.Now().UnixMilli()
	hourMS := int64(time.Hour / time.Millisecond)
	expired := newTestMailboxEnvelope(
		"mailbox-f005-expired-submission",
		"5f0b0d5b-2c2e-4e9b-8b3c-2f4b3d6a9e77",
		"Q0NDQ0NDQ0NDQ0ND",
		nowMS-2*hourMS,
		nowMS-hourMS,
	)

	response := sendEnvelopeRequest(t, handler, expired)
	if response.Code != http.StatusBadRequest {
		t.Fatalf("SendEnvelope(already expired) status = %d, want %d: an envelope whose expires_at_ms is in the past must be rejected at submission",
			response.Code, http.StatusBadRequest)
	}
	code := mailboxErrorCode(t, response)
	if code != "INVALID_SCHEMA" && code != "ENVELOPE_EXPIRED" {
		t.Fatalf("SendEnvelope(already expired) error code = %q, want INVALID_SCHEMA or ENVELOPE_EXPIRED", code)
	}

	stored, err := mailboxService.GetEnvelopes(expired.RecipientMailboxID, 10)
	if err != nil {
		t.Fatalf("GetEnvelopes() error = %v", err)
	}
	if len(stored) != 0 {
		t.Fatalf("stored envelopes = %d, want 0: a rejected expired envelope must never be persisted", len(stored))
	}
}

func newTestMailboxEnvelope(mailboxID, envelopeID, ciphertext string, createdAtMs, expiresAtMs int64) *model.MailboxEnvelope {
	return &model.MailboxEnvelope{
		Type:                "mailbox_envelope",
		Version:             1,
		EnvelopeID:          envelopeID,
		MessageID:           "1e9a6b4c-0d5f-4a2e-9c3d-8b7a6f5e4d3c",
		SenderIdentityID:    "sender-identity",
		SenderDeviceID:      "7319a570-67c7-4c8b-bb0b-4dcdf41de5ec",
		RecipientIdentityID: "recipient-identity",
		RecipientDeviceID:   "8cc8010b-d4a1-4ce7-8203-a8f6b055c1b9",
		RecipientMailboxID:  mailboxID,
		PayloadType:         "ciphertext_message",
		Ciphertext:          ciphertext,
		CreatedAtMs:         createdAtMs,
		ExpiresAtMs:         expiresAtMs,
		// The CLI contract (apps/cli/src/runtime/outbound.ts, inbound.ts) defines
		// size_bytes as the byte length of the ciphertext string itself.
		SizeBytes: int64(len(ciphertext)),
	}
}

// sendEnvelopeRequest posts an envelope on the authenticated send path.
//
// T50 (finding T49-F-001): /v1/messages/send now authenticates the sender against an
// already-published, root-signed DeviceRecord, so every fixture that expects the route to ACCEPT an
// envelope has to carry that binding. Rather than changing each fixture, this shared helper
// publishes the package's shared test sender (mailbox_sender_authentication_test.go, idempotent),
// attributes the envelope to it, and signs the transcript with its device key.
//
// Nothing else changes: the envelope handed in is posted exactly as built, so every caller keeps
// asserting the property it was written for - identifier bounds, wire shape, envelope-id conflicts,
// expiry - now exercised on the authenticated path rather than on an anonymous one. A caller that
// deliberately corrupts a field still gets that corrupted field signed and posted, so the
// validation order it depends on is unchanged.
//
// Callers that need explicit control over the signature use sendEnvelopeWire instead.
func sendEnvelopeRequest(t *testing.T, handler *MailboxHandler, envelope *model.MailboxEnvelope) *httptest.ResponseRecorder {
	t.Helper()
	publishTestSender(t, handler)
	if envelope.SenderIdentityID == legacySenderIdentityPlaceholder {
		envelope.SenderIdentityID = testSenderIdentityID()
	}
	wire := envelopeWire(t, envelope)
	wire["sender_signature"] = signEnvelopeTranscript(envelope, testSenderDeviceKey())
	return sendEnvelopeWire(t, handler, wire)
}

// mailboxErrorCode extracts only the error code from a relay error envelope.
// The response body itself is never echoed into test output.
func mailboxErrorCode(t *testing.T, response *httptest.ResponseRecorder) string {
	t.Helper()
	var parsed struct {
		Error struct {
			Code string `json:"code"`
		} `json:"error"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &parsed); err != nil {
		return ""
	}
	return parsed.Error.Code
}
