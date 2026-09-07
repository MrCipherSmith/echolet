package handler

import (
	"crypto/ed25519"
	"encoding/json"
	"net/http"
	"regexp"
	"testing"
	"time"

	"echolet/apps/relay/internal/cryptoutil"
	"echolet/apps/relay/internal/model"
)

// RED tests for round-2 review findings R2-001 / R2-L-001 (major), path A, at the route the
// unauthenticated attacker actually reaches.
//
// The relay bounds envelope identifiers by length (validation/validate.go:117-121) but not by
// shape, while the CLI parses the WHOLE poll response as z.array(MailboxEnvelopeSchema.strict())
// (apps/cli/src/transport/relayClient.ts:80), which requires UUID envelope_id / message_id /
// sender_device_id / recipient_device_id and the literal payload_type "ciphertext_message".
// When these tests were written /v1/messages/send had no sender authentication; T51 added it, and
// the mailbox id is still derivable from a published contact card while a sender identity still
// costs one unauthenticated /v1/device-records/publish (finding T52-F-001). So a POST can still
// place an envelope in the victim's mailbox that the victim's own client cannot parse. Every subsequent poll then fails with INVALID_RELAY_RESPONSE before accept() and
// before ackPending(), and the legitimate messages queued behind the poison are never delivered.
//
// The property pinned here is the outcome, stated over what the victim's poll returns: an envelope
// the relay hands to a poll must be one the client's wire schema can parse, and a refused poison
// attempt must not cost the legitimate envelope behind it. No implementation is pinned - only that
// the poison is refused with a bounded client error and never persisted.
//
// Only status codes, error codes and identifiers appear in output; no request or response body is
// printed and the ciphertext is synthetic padding.

// clientUUIDPattern is the shape z.string().uuid() accepts, transcribed so this test asserts the
// client's contract rather than a Go-side approximation of it.
var clientUUIDPattern = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$`)

const clientPayloadTypeLiteral = "ciphertext_message"

// shapePoisonEnvelopeIDs gives each poison attempt its own envelope_id, so an earlier refusal can
// never be mistaken for an ENVELOPE_ID_CONFLICT on a later one.
var shapePoisonEnvelopeIDs = []string{
	"a1000000-0000-4000-8000-000000000001",
	"a1000000-0000-4000-8000-000000000002",
	"a1000000-0000-4000-8000-000000000003",
	"a1000000-0000-4000-8000-000000000004",
	"a1000000-0000-4000-8000-000000000005",
}

func TestPollNeverReturnsAnEnvelopeTheClientSchemaRefuses(t *testing.T) {
	handler, deviceService, mailboxService := newMailboxHandlerTestHarness(t)
	record, devicePrivateKey := signedDeviceRecord(t)
	mailboxID := cryptoutil.DeriveMailboxID(record.IdentityID)
	if err := deviceService.PublishDeviceRecord(record); err != nil {
		t.Fatalf("PublishDeviceRecord() error = %v", err)
	}

	nowMS := time.Now().UnixMilli()
	hourMS := int64(time.Hour / time.Millisecond)

	// One unauthenticated POST per shape the client refuses. Each identifier is far below the
	// 256-byte bound T41 added, so the existing length check cannot refuse any of them.
	poisonAttempts := []struct {
		name   string
		mutate func(*model.MailboxEnvelope)
	}{
		{"envelope_id is not a uuid", func(e *model.MailboxEnvelope) { e.EnvelopeID = "poison-not-a-uuid" }},
		{"message_id is not a uuid", func(e *model.MailboxEnvelope) { e.MessageID = "also-not-a-uuid" }},
		{"sender_device_id is not a uuid", func(e *model.MailboxEnvelope) { e.SenderDeviceID = "not-a-uuid" }},
		{"recipient_device_id is not a uuid", func(e *model.MailboxEnvelope) { e.RecipientDeviceID = "not-a-uuid" }},
		{"payload_type is not the ciphertext_message literal", func(e *model.MailboxEnvelope) { e.PayloadType = "not_ciphertext_message" }},
	}

	for index, attempt := range poisonAttempts {
		t.Run(attempt.name, func(t *testing.T) {
			poison := newShapeTestEnvelopeFor(mailboxID, record, nowMS, hourMS)
			poison.EnvelopeID = shapePoisonEnvelopeIDs[index]
			attempt.mutate(poison)

			response := sendEnvelopeRequest(t, handler, poison)

			if response.Code >= http.StatusInternalServerError {
				t.Fatalf("SendEnvelope(%s) status = %d, want a bounded 4xx (error code %q)",
					attempt.name, response.Code, mailboxErrorCode(t, response))
			}
			if response.Code < http.StatusBadRequest {
				t.Fatalf("SendEnvelope(%s) status = %d, want a 4xx rejection: the relay must not accept an envelope its own client's wire schema refuses, because one such envelope wedges the recipient's every poll",
					attempt.name, response.Code)
			}
			if code := mailboxErrorCode(t, response); code == "" || code == "INTERNAL_ERROR" {
				t.Fatalf("SendEnvelope(%s) error code = %q, want a client-error code", attempt.name, code)
			}
		})
	}

	// Nothing the attacker sent may be in the mailbox.
	stored, err := mailboxService.GetEnvelopes(mailboxID, 100)
	if err != nil {
		t.Fatalf("GetEnvelopes() error = %v", err)
	}
	if len(stored) != 0 {
		// Reported, not fatal, so the poll below still runs and shows what such a stored envelope
		// does to the victim's next poll.
		t.Errorf("stored envelopes after %d poison attempts = %d, want 0: a refused envelope must never be persisted",
			len(poisonAttempts), len(stored))
	}

	// The legitimate envelope behind the poison must still be accepted and delivered.
	legitimate := newShapeTestEnvelopeFor(mailboxID, record, nowMS, hourMS)
	legitimate.EnvelopeID = "5c2f9b71-8d43-4e60-a95c-1b7e0d3a6f28"
	accepted := sendEnvelopeRequest(t, handler, legitimate)
	if accepted.Code != http.StatusOK {
		t.Fatalf("SendEnvelope(legitimate) status = %d, want %d (error code %q)",
			accepted.Code, http.StatusOK, mailboxErrorCode(t, accepted))
	}

	delivered := pollMailboxEnvelopes(t, handler, record, devicePrivateKey, mailboxID)

	// Every envelope a poll hands back must be one the client can parse. A single unparsable
	// envelope fails the whole z.array(MailboxEnvelopeSchema.strict()) parse, so this is the exact
	// property that decides whether the mailbox is wedged.
	for _, envelope := range delivered {
		assertClientParsableEnvelope(t, envelope)
	}
	if len(delivered) != 1 {
		t.Fatalf("poll returned %d envelopes, want exactly the 1 legitimate envelope: a refused poison attempt must not cost the message queued behind it",
			len(delivered))
	}
	if delivered[0].EnvelopeID != legitimate.EnvelopeID {
		t.Fatalf("poll returned envelope_id %q, want %q", delivered[0].EnvelopeID, legitimate.EnvelopeID)
	}
}

// assertClientParsableEnvelope fails unless the envelope satisfies every shape constraint
// MailboxEnvelopeSchema declares. An envelope that fails any of these is one the CLI's poll parse
// refuses for the whole batch, wedging the mailbox.
func assertClientParsableEnvelope(t *testing.T, envelope *model.MailboxEnvelope) {
	t.Helper()
	uuidFields := []struct {
		name  string
		value string
	}{
		{"envelope_id", envelope.EnvelopeID},
		{"message_id", envelope.MessageID},
		{"sender_device_id", envelope.SenderDeviceID},
		{"recipient_device_id", envelope.RecipientDeviceID},
	}
	for _, field := range uuidFields {
		if !clientUUIDPattern.MatchString(field.value) {
			t.Errorf("delivered envelope %s = %q, which MailboxEnvelopeSchema refuses as a uuid: the whole poll batch would fail to parse, so every legitimate envelope in it is undeliverable",
				field.name, field.value)
		}
	}
	if envelope.PayloadType != clientPayloadTypeLiteral {
		t.Errorf("delivered envelope payload_type = %q, want the literal %q required by MailboxEnvelopeSchema",
			envelope.PayloadType, clientPayloadTypeLiteral)
	}
}

// pollMailboxEnvelopes runs the real challenge/poll handshake for the mailbox owner and returns the
// delivered envelopes. Response bodies are decoded, never printed.
func pollMailboxEnvelopes(t *testing.T, handler *MailboxHandler, record *model.DeviceRecord, devicePrivateKey ed25519.PrivateKey, mailboxID string) []*model.MailboxEnvelope {
	t.Helper()

	challengeResponse := postJSON(t, http.HandlerFunc(handler.CreateChallenge), map[string]string{
		"recipient_mailbox_id": mailboxID,
		"device_id":            record.DeviceID,
		"signature":            signMessage(t, cryptoutil.CreateMailboxCreateChallengeMessage(mailboxID, record.DeviceID), devicePrivateKey),
	})
	if challengeResponse.Code != http.StatusOK {
		t.Fatalf("CreateChallenge() status = %d (error code %q)", challengeResponse.Code, mailboxErrorCode(t, challengeResponse))
	}

	var challenge struct {
		Data struct {
			ChallengeID string `json:"challenge_id"`
			Nonce       string `json:"nonce"`
		} `json:"data"`
	}
	if err := json.Unmarshal(challengeResponse.Body.Bytes(), &challenge); err != nil {
		t.Fatalf("json.Unmarshal(challenge) error = %v", err)
	}

	pollResponse := postJSON(t, http.HandlerFunc(handler.PollMailbox), map[string]any{
		"challenge_id":         challenge.Data.ChallengeID,
		"recipient_mailbox_id": mailboxID,
		"device_id":            record.DeviceID,
		"batch_size":           50,
		"signature": signMessage(t, cryptoutil.CreateMailboxChallengeMessage(
			challenge.Data.ChallengeID, mailboxID, record.DeviceID, challenge.Data.Nonce), devicePrivateKey),
	})
	if pollResponse.Code != http.StatusOK {
		t.Fatalf("PollMailbox() status = %d (error code %q)", pollResponse.Code, mailboxErrorCode(t, pollResponse))
	}

	var poll struct {
		Data struct {
			Envelopes []*model.MailboxEnvelope `json:"envelopes"`
		} `json:"data"`
	}
	if err := json.Unmarshal(pollResponse.Body.Bytes(), &poll); err != nil {
		t.Fatalf("json.Unmarshal(poll) error = %v", err)
	}
	return poll.Data.Envelopes
}

// newShapeTestEnvelopeFor builds an envelope in exactly the shape the CLI emits, addressed to the
// mailbox owner.
func newShapeTestEnvelopeFor(mailboxID string, record *model.DeviceRecord, nowMS, hourMS int64) *model.MailboxEnvelope {
	ciphertext := "QUFBQUFBQUFBQUFB"
	return &model.MailboxEnvelope{
		Type:                "mailbox_envelope",
		Version:             1,
		EnvelopeID:          "b1d4e7c2-5a63-4f18-9c07-2e8b6a4d3f51",
		MessageID:           "3f9a0c86-71b2-4d5e-8a14-6c9e2b7d0f43",
		SenderIdentityID:    "sender-identity",
		SenderDeviceID:      "7319a570-67c7-4c8b-bb0b-4dcdf41de5ec",
		RecipientIdentityID: record.IdentityID,
		RecipientDeviceID:   record.DeviceID,
		RecipientMailboxID:  mailboxID,
		PayloadType:         clientPayloadTypeLiteral,
		Ciphertext:          ciphertext,
		CreatedAtMs:         nowMS - 1000,
		ExpiresAtMs:         nowMS + 24*hourMS,
		SizeBytes:           int64(len(ciphertext)),
	}
}
