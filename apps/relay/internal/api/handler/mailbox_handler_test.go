package handler

import (
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"echolet/apps/relay/internal/cryptoutil"
	"echolet/apps/relay/internal/model"
	"echolet/apps/relay/internal/service"
	"echolet/apps/relay/internal/storage"
	"echolet/apps/relay/internal/storage/repository"
)

func TestMailboxPollAndAckRequireVerifiedOwnershipAndSignature(t *testing.T) {
	handler, deviceService, mailboxService := newMailboxHandlerTestHarness(t)
	record, devicePrivateKey := signedDeviceRecord(t)
	mailboxID := cryptoutil.DeriveMailboxID(record.IdentityID)

	if err := deviceService.PublishDeviceRecord(record); err != nil {
		t.Fatalf("PublishDeviceRecord() error = %v", err)
	}

	envelope := &model.MailboxEnvelope{
		Type:                "mailbox_envelope",
		Version:             1,
		EnvelopeID:          "7b95a59f-53f2-4d51-8e27-a659cf30fd95",
		MessageID:           "09c2b413-41fe-46ac-9a7f-76aa87e1cd93",
		SenderIdentityID:    "sender-identity",
		SenderDeviceID:      "7319a570-67c7-4c8b-bb0b-4dcdf41de5ec",
		RecipientIdentityID: record.IdentityID,
		RecipientDeviceID:   record.DeviceID,
		RecipientMailboxID:  mailboxID,
		PayloadType:         "ciphertext_message",
		Ciphertext:          "ciphertext",
		CreatedAtMs:         1770000000000,
		ExpiresAtMs:         1770600000000,
		SizeBytes:           128,
	}
	if err := mailboxService.StoreEnvelope(envelope); err != nil {
		t.Fatalf("StoreEnvelope() error = %v", err)
	}

	challengeResponse := postJSON(t, http.HandlerFunc(handler.CreateChallenge), map[string]string{
		"recipient_mailbox_id": mailboxID,
		"device_id":            record.DeviceID,
		"signature": signMessage(
			t,
			cryptoutil.CreateMailboxCreateChallengeMessage(mailboxID, record.DeviceID),
			devicePrivateKey,
		),
	})
	if challengeResponse.Code != http.StatusOK {
		t.Fatalf("CreateChallenge() status = %d body = %s", challengeResponse.Code, challengeResponse.Body.String())
	}

	var parsedChallenge struct {
		OK   bool `json:"ok"`
		Data struct {
			ChallengeID string `json:"challenge_id"`
			Nonce       string `json:"nonce"`
		} `json:"data"`
	}
	if err := json.Unmarshal(challengeResponse.Body.Bytes(), &parsedChallenge); err != nil {
		t.Fatalf("json.Unmarshal(challenge) error = %v", err)
	}

	invalidPoll := postJSON(t, http.HandlerFunc(handler.PollMailbox), map[string]string{
		"challenge_id":         parsedChallenge.Data.ChallengeID,
		"recipient_mailbox_id": mailboxID,
		"device_id":            record.DeviceID,
		"signature":            "invalid",
	})
	if invalidPoll.Code != http.StatusForbidden {
		t.Fatalf("PollMailbox(invalid) status = %d body = %s", invalidPoll.Code, invalidPoll.Body.String())
	}

	validPollSignature := signMessage(
		t,
		cryptoutil.CreateMailboxChallengeMessage(
			parsedChallenge.Data.ChallengeID,
			mailboxID,
			record.DeviceID,
			parsedChallenge.Data.Nonce,
		),
		devicePrivateKey,
	)
	validPoll := postJSON(t, http.HandlerFunc(handler.PollMailbox), map[string]string{
		"challenge_id":         parsedChallenge.Data.ChallengeID,
		"recipient_mailbox_id": mailboxID,
		"device_id":            record.DeviceID,
		"signature":            validPollSignature,
	})
	if validPoll.Code != http.StatusOK {
		t.Fatalf("PollMailbox(valid) status = %d body = %s", validPoll.Code, validPoll.Body.String())
	}

	invalidAck := postJSON(t, http.HandlerFunc(handler.AckMailbox), map[string]any{
		"recipient_mailbox_id": mailboxID,
		"device_id":            record.DeviceID,
		"envelope_ids":         []string{envelope.EnvelopeID},
		"signature":            "invalid",
	})
	if invalidAck.Code != http.StatusForbidden {
		t.Fatalf("AckMailbox(invalid) status = %d body = %s", invalidAck.Code, invalidAck.Body.String())
	}

	validAckSignature := signMessage(
		t,
		cryptoutil.CreateMailboxAckMessage(mailboxID, record.DeviceID, []string{envelope.EnvelopeID}),
		devicePrivateKey,
	)
	validAck := postJSON(t, http.HandlerFunc(handler.AckMailbox), map[string]any{
		"recipient_mailbox_id": mailboxID,
		"device_id":            record.DeviceID,
		"envelope_ids":         []string{envelope.EnvelopeID},
		"signature":            validAckSignature,
	})
	if validAck.Code != http.StatusOK {
		t.Fatalf("AckMailbox(valid) status = %d body = %s", validAck.Code, validAck.Body.String())
	}
}

func TestMailboxChallengeRejectsUnauthorizedMailboxAccess(t *testing.T) {
	handler, deviceService, _ := newMailboxHandlerTestHarness(t)
	record, devicePrivateKey := signedDeviceRecord(t)
	if err := deviceService.PublishDeviceRecord(record); err != nil {
		t.Fatalf("PublishDeviceRecord() error = %v", err)
	}

	response := postJSON(t, http.HandlerFunc(handler.CreateChallenge), map[string]string{
		"recipient_mailbox_id": "wrong-mailbox",
		"device_id":            record.DeviceID,
		"signature": signMessage(
			t,
			cryptoutil.CreateMailboxCreateChallengeMessage("wrong-mailbox", record.DeviceID),
			devicePrivateKey,
		),
	})
	if response.Code != http.StatusForbidden {
		t.Fatalf("CreateChallenge(unauthorized) status = %d body = %s", response.Code, response.Body.String())
	}
}

func TestMailboxChallengeRejectsInvalidSignature(t *testing.T) {
	handler, deviceService, _ := newMailboxHandlerTestHarness(t)
	record, _ := signedDeviceRecord(t)
	mailboxID := cryptoutil.DeriveMailboxID(record.IdentityID)
	if err := deviceService.PublishDeviceRecord(record); err != nil {
		t.Fatalf("PublishDeviceRecord() error = %v", err)
	}

	response := postJSON(t, http.HandlerFunc(handler.CreateChallenge), map[string]string{
		"recipient_mailbox_id": mailboxID,
		"device_id":            record.DeviceID,
		"signature":            "invalid",
	})
	if response.Code != http.StatusForbidden {
		t.Fatalf("CreateChallenge(invalid-signature) status = %d body = %s", response.Code, response.Body.String())
	}
}

func newMailboxHandlerTestHarness(t *testing.T) (*MailboxHandler, *service.DeviceRecordService, *service.MailboxService) {
	t.Helper()

	st, err := storage.NewStorage(t.TempDir())
	if err != nil {
		t.Fatalf("NewStorage() error = %v", err)
	}
	t.Cleanup(func() {
		_ = st.Close()
	})

	deviceRepo := repository.NewDeviceRecordRepository(st)
	mailboxRepo := repository.NewMailboxRepository(st)
	challengeRepo := repository.NewChallengeRepository(st)

	deviceService := service.NewDeviceRecordService(deviceRepo)
	mailboxService := service.NewMailboxService(mailboxRepo)
	challengeService := service.NewChallengeService(challengeRepo, 60)

	return NewMailboxHandler(mailboxService, challengeService, deviceService, 100, 262144), deviceService, mailboxService
}

func signedDeviceRecord(t *testing.T) (*model.DeviceRecord, ed25519.PrivateKey) {
	t.Helper()

	identityPublicKey, identityPrivateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("GenerateKey(identity) error = %v", err)
	}
	devicePublicKey, devicePrivateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("GenerateKey(device) error = %v", err)
	}

	record := &model.DeviceRecord{
		Type:         "device_record",
		Version:      1,
		IdentityID:   base64.RawURLEncoding.EncodeToString(identityPublicKey),
		DeviceID:     "8cc8010b-d4a1-4ce7-8203-a8f6b055c1b9",
		DevicePubKey: base64.RawURLEncoding.EncodeToString(devicePublicKey),
		Capabilities: map[string]bool{"mailbox_poll": true},
		CreatedAtMs:  1770000000000,
	}

	canonical, err := cryptoutil.MarshalCanonicalJSONWithoutSignature(record)
	if err != nil {
		t.Fatalf("MarshalCanonicalJSONWithoutSignature() error = %v", err)
	}
	record.Signature = base64.RawURLEncoding.EncodeToString(ed25519.Sign(identityPrivateKey, canonical))

	return record, devicePrivateKey
}

func signMessage(t *testing.T, message string, privateKey ed25519.PrivateKey) string {
	t.Helper()
	return base64.RawURLEncoding.EncodeToString(ed25519.Sign(privateKey, []byte(message)))
}

func postJSON(t *testing.T, handler http.Handler, payload any) *httptest.ResponseRecorder {
	t.Helper()

	body, err := json.Marshal(payload)
	if err != nil {
		t.Fatalf("json.Marshal() error = %v", err)
	}

	request := httptest.NewRequest(http.MethodPost, "/", bytes.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)
	return recorder
}

func TestMailboxConcurrentPollConsumesChallengeExactlyOnce(t *testing.T) {
	handler, deviceService, _ := newMailboxHandlerTestHarness(t)
	record, key := signedDeviceRecord(t)
	if err := deviceService.PublishDeviceRecord(record); err != nil {
		t.Fatal(err)
	}
	mailboxID := cryptoutil.DeriveMailboxID(record.IdentityID)
	challenge, err := handler.challengeService.CreateChallenge(mailboxID, record.DeviceID)
	if err != nil {
		t.Fatal(err)
	}
	payload := map[string]string{
		"challenge_id":         challenge.ChallengeID,
		"recipient_mailbox_id": mailboxID,
		"device_id":            record.DeviceID,
		"signature":            signMessage(t, cryptoutil.CreateMailboxChallengeMessage(challenge.ChallengeID, mailboxID, record.DeviceID, challenge.Nonce), key),
	}
	body, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	const clients = 16
	start := make(chan struct{})
	results := make(chan *httptest.ResponseRecorder, clients)
	for i := 0; i < clients; i++ {
		go func() {
			<-start
			recorder := httptest.NewRecorder()
			request := httptest.NewRequest(http.MethodPost, "/v1/mailbox/poll", bytes.NewReader(body))
			handler.PollMailbox(recorder, request)
			results <- recorder
		}()
	}
	close(start)
	successes := 0
	for i := 0; i < clients; i++ {
		response := <-results
		if response.Code == http.StatusOK {
			successes++
			continue
		}
		var failure struct {
			Error struct {
				Code string `json:"code"`
			} `json:"error"`
		}
		if err := json.Unmarshal(response.Body.Bytes(), &failure); err != nil {
			t.Fatal(err)
		}
		if response.Code != http.StatusBadRequest || failure.Error.Code != "CHALLENGE_EXPIRED" {
			t.Errorf("unexpected response: %d %s", response.Code, response.Body.String())
		}
	}
	if successes != 1 {
		t.Fatalf("successful polls = %d, want exactly 1", successes)
	}
}
