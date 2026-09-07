package handler

import (
	"crypto/ed25519"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"echolet/apps/relay/internal/cryptoutil"
	"echolet/apps/relay/internal/model"
	"echolet/apps/relay/internal/service"
	"echolet/apps/relay/internal/storage"
	"echolet/apps/relay/internal/storage/repository"
)

// RED tests for review finding F-009 (server side) and for the item handed over
// by the completed T34 fix (finding T34-I-003).
//
// F-009: a valid poll batch can exceed the CLI's response-byte bound and then
// never drain. config.go:16 defaults MaxMailboxBatch=100, mailbox_handler.go
// fetches that many and returns next_cursor=null, while relayClient.ts:86
// rejects any response above 1 MiB. Batch selection must therefore honour a
// shared aggregate response-byte budget, always return at least one valid
// envelope, honour the batch size the client asked for, and signal that more
// work remains so the mailbox drains across polls.
//
// T34-I-003: request_body.go:18 pins the /v1/messages/send body limit to a
// hand-chosen 1 MiB constant instead of deriving it from cfg.MaxMessageBytes,
// so raising ECHOLET_MAX_MESSAGE_BYTES silently makes the route reject
// legitimate maximum-size envelopes.
//
// No ciphertext, plaintext or request body is ever written into test output -
// only byte counts, status codes and envelope identifiers.

// maxPollResponseBytes is the aggregate response-byte budget shared by the
// relay and the CLI. It mirrors the client's hard bound at
// apps/cli/src/transport/relayClient.ts:86; a poll response above it is
// rejected by the client and the mailbox can never drain.
const maxPollResponseBytes = 1 << 20

// pollCapacityMaxMessageBytes mirrors config.MaxMessageBytes (262144), the
// largest ciphertext the relay accepts. A mailbox full of envelopes this size
// is the worst case F-009 describes.
const pollCapacityMaxMessageBytes = 262144

// TestMailboxPollHonoursAggregateResponseByteBudget pins F-009: a mailbox
// filled with maximum-size valid envelopes must drain across successive polls,
// and no single poll response may exceed the shared byte budget.
func TestMailboxPollHonoursAggregateResponseByteBudget(t *testing.T) {
	const storedEnvelopes = 8

	handler, deviceService, mailboxService := newMailboxHandlerTestHarness(t)
	record, devicePrivateKey := signedDeviceRecord(t)
	mailboxID := cryptoutil.DeriveMailboxID(record.IdentityID)
	if err := deviceService.PublishDeviceRecord(record); err != nil {
		t.Fatalf("PublishDeviceRecord() error = %v", err)
	}

	pending := map[string]bool{}
	for index := 0; index < storedEnvelopes; index++ {
		envelope := maximumSizeEnvelope(t, record, mailboxID, index)
		if err := mailboxService.StoreEnvelope(envelope); err != nil {
			t.Fatalf("StoreEnvelope(%d) error = %v", index, err)
		}
		pending[envelope.EnvelopeID] = true
	}

	delivered := map[string]bool{}
	polls := 0
	for len(delivered) < storedEnvelopes {
		polls++
		if polls > storedEnvelopes+2 {
			t.Fatalf("polls = %d without draining %d envelopes: the mailbox is not making progress", polls, storedEnvelopes)
		}

		response := pollMailboxOnce(t, handler, mailboxID, record.DeviceID, devicePrivateKey, 0)
		if response.Code != http.StatusOK {
			t.Fatalf("poll %d: status = %d, want %d", polls, response.Code, http.StatusOK)
		}

		bodyBytes := response.Body.Len()
		if bodyBytes > maxPollResponseBytes {
			t.Fatalf("poll %d: response body = %d bytes, want at most %d; "+
				"batch selection must honour a shared aggregate response-byte budget, not only MaxMailboxBatch=100, "+
				"otherwise the CLI rejects the response at relayClient.ts:86 and the mailbox never drains",
				polls, bodyBytes, maxPollResponseBytes)
		}

		batch := decodePollResponse(t, response)
		if len(batch.Data.Envelopes) == 0 {
			t.Fatalf("poll %d: returned no envelopes while %d remain; a poll must always return at least one valid envelope", polls, storedEnvelopes-len(delivered))
		}

		envelopeIDs := make([]string, 0, len(batch.Data.Envelopes))
		for _, envelope := range batch.Data.Envelopes {
			if !pending[envelope.EnvelopeID] {
				t.Fatalf("poll %d: returned unexpected envelope %s", polls, envelope.EnvelopeID)
			}
			delivered[envelope.EnvelopeID] = true
			envelopeIDs = append(envelopeIDs, envelope.EnvelopeID)
		}

		if remaining := storedEnvelopes - len(delivered); remaining > 0 && batch.Data.NextCursor == nil {
			t.Fatalf("poll %d: next_cursor = null while %d envelopes remain undelivered; "+
				"the response must signal remaining work so the client knows to poll again",
				polls, remaining)
		}

		if err := mailboxService.AckEnvelopes(mailboxID, envelopeIDs); err != nil {
			t.Fatalf("AckEnvelopes() error = %v", err)
		}
	}

	if polls < 2 {
		t.Fatalf("polls = %d for %d maximum-size envelopes, want more than one bounded batch", polls, storedEnvelopes)
	}
}

// TestMailboxPollHonoursRequestedBatchSize pins the client-supplied batch size
// reaching the relay: the CLI's validated poll_batch_size must actually bound
// the batch the relay selects.
func TestMailboxPollHonoursRequestedBatchSize(t *testing.T) {
	const (
		storedEnvelopes  = 5
		requestedBatch   = 2
		smallCiphertext  = 64
		expectedReturned = requestedBatch
	)

	handler, deviceService, mailboxService := newMailboxHandlerTestHarness(t)
	record, devicePrivateKey := signedDeviceRecord(t)
	mailboxID := cryptoutil.DeriveMailboxID(record.IdentityID)
	if err := deviceService.PublishDeviceRecord(record); err != nil {
		t.Fatalf("PublishDeviceRecord() error = %v", err)
	}
	for index := 0; index < storedEnvelopes; index++ {
		if err := mailboxService.StoreEnvelope(envelopeWithCiphertextSize(t, record, mailboxID, index, smallCiphertext)); err != nil {
			t.Fatalf("StoreEnvelope(%d) error = %v", index, err)
		}
	}

	response := pollMailboxOnce(t, handler, mailboxID, record.DeviceID, devicePrivateKey, requestedBatch)
	if response.Code != http.StatusOK {
		t.Fatalf("poll status = %d, want %d", response.Code, http.StatusOK)
	}

	batch := decodePollResponse(t, response)
	if len(batch.Data.Envelopes) != expectedReturned {
		t.Fatalf("envelopes returned = %d for a requested batch_size of %d, want %d; "+
			"the client's configured poll_batch_size must reach the relay request and bound the batch",
			len(batch.Data.Envelopes), requestedBatch, expectedReturned)
	}
	if batch.Data.NextCursor == nil {
		t.Fatalf("next_cursor = null while %d of %d envelopes were withheld by the requested batch size; "+
			"the response must signal remaining work", storedEnvelopes-expectedReturned, storedEnvelopes)
	}
}

// TestMailboxPollAlwaysReturnsAtLeastOneMaximumSizeEnvelope guards the other
// side of the byte budget: enforcing it must never starve delivery of a single
// legitimately large envelope.
func TestMailboxPollAlwaysReturnsAtLeastOneMaximumSizeEnvelope(t *testing.T) {
	handler, deviceService, mailboxService := newMailboxHandlerTestHarness(t)
	record, devicePrivateKey := signedDeviceRecord(t)
	mailboxID := cryptoutil.DeriveMailboxID(record.IdentityID)
	if err := deviceService.PublishDeviceRecord(record); err != nil {
		t.Fatalf("PublishDeviceRecord() error = %v", err)
	}

	envelope := maximumSizeEnvelope(t, record, mailboxID, 0)
	if err := mailboxService.StoreEnvelope(envelope); err != nil {
		t.Fatalf("StoreEnvelope() error = %v", err)
	}

	response := pollMailboxOnce(t, handler, mailboxID, record.DeviceID, devicePrivateKey, 0)
	if response.Code != http.StatusOK {
		t.Fatalf("poll status = %d, want %d", response.Code, http.StatusOK)
	}

	batch := decodePollResponse(t, response)
	if len(batch.Data.Envelopes) != 1 || batch.Data.Envelopes[0].EnvelopeID != envelope.EnvelopeID {
		t.Fatalf("envelopes returned = %d, want exactly the single stored maximum-size envelope", len(batch.Data.Envelopes))
	}
	if batch.Data.NextCursor != nil {
		t.Fatalf("next_cursor is non-null although the mailbox is fully drained")
	}
}

// TestSendEnvelopeBodyLimitIsDerivedFromMaxMessageBytes pins the item handed
// over by T34 (finding T34-I-003). The /v1/messages/send body bound must be
// derived from the configured cfg.MaxMessageBytes, not from the hand-chosen
// 1 MiB constant at request_body.go:18, so that raising
// ECHOLET_MAX_MESSAGE_BYTES cannot silently reject legitimate envelopes.
//
// The assertion is on the derived relationship, never on the literal.
func TestSendEnvelopeBodyLimitIsDerivedFromMaxMessageBytes(t *testing.T) {
	// Deliberately above the current hardcoded envelopeRequestBodyLimit.
	const configuredMaxMessageBytes int64 = 2 << 20

	handler := newMailboxHandlerWithMaxMessageBytes(t, configuredMaxMessageBytes)
	record, _ := signedDeviceRecord(t)
	mailboxID := cryptoutil.DeriveMailboxID(record.IdentityID)

	atLimit := envelopeWithCiphertextSize(t, record, mailboxID, 0, int(configuredMaxMessageBytes))
	// T50: the route authenticates the sender, so the fixture goes through the shared signing
	// helper. The property under test - that the body bound is derived from cfg.MaxMessageBytes -
	// is unchanged; the signature adds ~110 bytes against the 64 KiB envelopeJSONOverheadBytes
	// headroom the bound already reserves.
	accepted := sendEnvelopeRequest(t, handler, atLimit)
	if accepted.Code != http.StatusOK {
		t.Fatalf("send of an envelope whose ciphertext is exactly the configured ECHOLET_MAX_MESSAGE_BYTES (%d): status = %d, want %d; "+
			"the request-body bound must be derived from cfg.MaxMessageBytes instead of the fixed constant at request_body.go:18",
			configuredMaxMessageBytes, accepted.Code, http.StatusOK)
	}

	// The bound must still exist: a body far above the derived limit is refused
	// without being streamed into the decoder.
	oversized := envelopeWithCiphertextSize(t, record, mailboxID, 1, int(configuredMaxMessageBytes)*4)
	rejected := sendEnvelopeRequest(t, handler, oversized)
	if rejected.Code < 400 || rejected.Code >= 500 {
		t.Fatalf("send of a body far above the derived limit: status = %d, want a 4xx bounded rejection", rejected.Code)
	}
}

type pollResponseBody struct {
	OK   bool `json:"ok"`
	Data struct {
		Envelopes []struct {
			EnvelopeID string `json:"envelope_id"`
		} `json:"envelopes"`
		NextCursor *string `json:"next_cursor"`
	} `json:"data"`
}

func decodePollResponse(t *testing.T, response *httptest.ResponseRecorder) pollResponseBody {
	t.Helper()

	var parsed pollResponseBody
	if err := json.Unmarshal(response.Body.Bytes(), &parsed); err != nil {
		t.Fatalf("json.Unmarshal(poll response) error = %v", err)
	}
	if !parsed.OK {
		t.Fatalf("poll response is not a success envelope")
	}
	return parsed
}

// pollMailboxOnce performs one full challenge + signed poll round trip. A
// batchSize of 0 omits the field, so the relay's own default applies.
func pollMailboxOnce(
	t *testing.T,
	handler *MailboxHandler,
	mailboxID string,
	deviceID string,
	devicePrivateKey ed25519.PrivateKey,
	batchSize int,
) *httptest.ResponseRecorder {
	t.Helper()

	challengeResponse := postJSON(t, http.HandlerFunc(handler.CreateChallenge), map[string]string{
		"recipient_mailbox_id": mailboxID,
		"device_id":            deviceID,
		"signature":            signMessage(t, cryptoutil.CreateMailboxCreateChallengeMessage(mailboxID, deviceID), devicePrivateKey),
	})
	if challengeResponse.Code != http.StatusOK {
		t.Fatalf("CreateChallenge() status = %d", challengeResponse.Code)
	}

	var parsedChallenge struct {
		Data struct {
			ChallengeID string `json:"challenge_id"`
			Nonce       string `json:"nonce"`
		} `json:"data"`
	}
	if err := json.Unmarshal(challengeResponse.Body.Bytes(), &parsedChallenge); err != nil {
		t.Fatalf("json.Unmarshal(challenge) error = %v", err)
	}

	payload := map[string]any{
		"challenge_id":         parsedChallenge.Data.ChallengeID,
		"recipient_mailbox_id": mailboxID,
		"device_id":            deviceID,
		"signature": signMessage(t, cryptoutil.CreateMailboxChallengeMessage(
			parsedChallenge.Data.ChallengeID, mailboxID, deviceID, parsedChallenge.Data.Nonce,
		), devicePrivateKey),
	}
	if batchSize > 0 {
		payload["batch_size"] = batchSize
	}

	return postJSON(t, http.HandlerFunc(handler.PollMailbox), payload)
}

func maximumSizeEnvelope(t *testing.T, record *model.DeviceRecord, mailboxID string, index int) *model.MailboxEnvelope {
	t.Helper()
	return envelopeWithCiphertextSize(t, record, mailboxID, index, pollCapacityMaxMessageBytes)
}

// envelopeWithCiphertextSize builds a schema-valid envelope whose ciphertext is
// exactly ciphertextBytes long. The ciphertext is inert padding; no real
// ciphertext or plaintext is used anywhere in these tests.
func envelopeWithCiphertextSize(t *testing.T, record *model.DeviceRecord, mailboxID string, index, ciphertextBytes int) *model.MailboxEnvelope {
	t.Helper()

	now := time.Now().UnixMilli()
	return &model.MailboxEnvelope{
		Type:                "mailbox_envelope",
		Version:             1,
		EnvelopeID:          fmt.Sprintf("7b95a59f-53f2-4d51-8e27-a659cf30%04d", index),
		MessageID:           fmt.Sprintf("09c2b413-41fe-46ac-9a7f-76aa87e1%04d", index),
		SenderIdentityID:    "sender-identity",
		SenderDeviceID:      "7319a570-67c7-4c8b-bb0b-4dcdf41de5ec",
		RecipientIdentityID: record.IdentityID,
		RecipientDeviceID:   record.DeviceID,
		RecipientMailboxID:  mailboxID,
		PayloadType:         "ciphertext_message",
		Ciphertext:          strings.Repeat("A", ciphertextBytes),
		CreatedAtMs:         now - 1000,
		ExpiresAtMs:         now + int64(time.Hour/time.Millisecond),
		SizeBytes:           int64(ciphertextBytes),
	}
}

func newMailboxHandlerWithMaxMessageBytes(t *testing.T, maxMessageBytes int64) *MailboxHandler {
	t.Helper()

	st, err := storage.NewStorage(t.TempDir())
	if err != nil {
		t.Fatalf("NewStorage() error = %v", err)
	}
	t.Cleanup(func() { _ = st.Close() })

	deviceService := service.NewDeviceRecordService(repository.NewDeviceRecordRepository(st))
	mailboxService := service.NewMailboxService(repository.NewMailboxRepository(st))
	challengeService := service.NewChallengeService(repository.NewChallengeRepository(st), 60)

	return NewMailboxHandler(mailboxService, challengeService, deviceService, 100, maxMessageBytes)
}
