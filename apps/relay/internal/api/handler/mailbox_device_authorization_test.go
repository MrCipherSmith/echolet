package handler

import (
	"crypto/ed25519"
	"encoding/json"
	"net/http"
	"testing"
	"time"

	"echolet/apps/relay/internal/cryptoutil"
	"echolet/apps/relay/internal/model"
)

// RED test for review finding F-007.
//
// Mailbox device authorization must resolve the device by the
// (mailbox identity, device UUID) binding. Today DeviceRecordRepository.GetByDeviceID
// scans device_record:* globally and stops at the first record whose device UUID
// matches, so a device UUID published under an unrelated identity that sorts
// earlier denies service to the legitimate recipient on challenge, poll and ack.

type mailboxDeviceIdentity struct {
	record     *model.DeviceRecord
	privateKey ed25519.PrivateKey
}

func TestMailboxAuthorizationIsScopedToOwningMailboxIdentity(t *testing.T) {
	handler, deviceService, mailboxService := newMailboxHandlerTestHarness(t)

	firstRecord, firstKey := signedDeviceRecord(t)
	secondRecord, secondKey := signedDeviceRecord(t)
	if firstRecord.DeviceID != secondRecord.DeviceID {
		t.Fatalf("test precondition: both records must share the same device UUID, got %q and %q",
			firstRecord.DeviceID, secondRecord.DeviceID)
	}
	if firstRecord.IdentityID == secondRecord.IdentityID {
		t.Fatalf("test precondition: records must belong to different identities")
	}

	// device_record keys are "device_record:<identity_id>:<device_id>", so the
	// lexicographically smaller identity is scanned first by the global lookup.
	// Making that one the UNRELATED identity deterministically reproduces the
	// denial-of-service described in F-007.
	candidates := []mailboxDeviceIdentity{{firstRecord, firstKey}, {secondRecord, secondKey}}
	if candidates[1].record.IdentityID < candidates[0].record.IdentityID {
		candidates[0], candidates[1] = candidates[1], candidates[0]
	}
	unrelated := candidates[0]
	legitimate := candidates[1]

	if err := deviceService.PublishDeviceRecord(unrelated.record); err != nil {
		t.Fatalf("PublishDeviceRecord(unrelated) error = %v", err)
	}
	if err := deviceService.PublishDeviceRecord(legitimate.record); err != nil {
		t.Fatalf("PublishDeviceRecord(legitimate) error = %v", err)
	}

	mailboxID := cryptoutil.DeriveMailboxID(legitimate.record.IdentityID)
	nowMS := time.Now().UnixMilli()
	envelope := newTestMailboxEnvelope(
		mailboxID,
		"c1a2b3d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d",
		"RERERERERERERERE",
		nowMS-1000,
		nowMS+24*int64(time.Hour/time.Millisecond),
	)
	envelope.RecipientIdentityID = legitimate.record.IdentityID
	envelope.RecipientDeviceID = legitimate.record.DeviceID
	if err := mailboxService.StoreEnvelope(envelope); err != nil {
		t.Fatalf("StoreEnvelope() error = %v", err)
	}

	challengeResponse := postJSON(t, http.HandlerFunc(handler.CreateChallenge), map[string]string{
		"recipient_mailbox_id": mailboxID,
		"device_id":            legitimate.record.DeviceID,
		"signature": signMessage(
			t,
			cryptoutil.CreateMailboxCreateChallengeMessage(mailboxID, legitimate.record.DeviceID),
			legitimate.privateKey,
		),
	})
	if challengeResponse.Code != http.StatusOK {
		t.Fatalf("CreateChallenge(legitimate owner) status = %d, want %d (code %q): a duplicate device UUID under an unrelated identity must not deny the owner",
			challengeResponse.Code, http.StatusOK, mailboxErrorCode(t, challengeResponse))
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

	pollResponse := postJSON(t, http.HandlerFunc(handler.PollMailbox), map[string]string{
		"challenge_id":         parsedChallenge.Data.ChallengeID,
		"recipient_mailbox_id": mailboxID,
		"device_id":            legitimate.record.DeviceID,
		"signature": signMessage(
			t,
			cryptoutil.CreateMailboxChallengeMessage(
				parsedChallenge.Data.ChallengeID,
				mailboxID,
				legitimate.record.DeviceID,
				parsedChallenge.Data.Nonce,
			),
			legitimate.privateKey,
		),
	})
	if pollResponse.Code != http.StatusOK {
		t.Fatalf("PollMailbox(legitimate owner) status = %d, want %d (code %q)",
			pollResponse.Code, http.StatusOK, mailboxErrorCode(t, pollResponse))
	}

	ackResponse := postJSON(t, http.HandlerFunc(handler.AckMailbox), map[string]any{
		"recipient_mailbox_id": mailboxID,
		"device_id":            legitimate.record.DeviceID,
		"envelope_ids":         []string{envelope.EnvelopeID},
		"signature": signMessage(
			t,
			cryptoutil.CreateMailboxAckMessage(mailboxID, legitimate.record.DeviceID, []string{envelope.EnvelopeID}),
			legitimate.privateKey,
		),
	})
	if ackResponse.Code != http.StatusOK {
		t.Fatalf("AckMailbox(legitimate owner) status = %d, want %d (code %q)",
			ackResponse.Code, http.StatusOK, mailboxErrorCode(t, ackResponse))
	}

	// The unrelated identity must still be unable to reach the victim mailbox.
	unrelatedResponse := postJSON(t, http.HandlerFunc(handler.CreateChallenge), map[string]string{
		"recipient_mailbox_id": mailboxID,
		"device_id":            unrelated.record.DeviceID,
		"signature": signMessage(
			t,
			cryptoutil.CreateMailboxCreateChallengeMessage(mailboxID, unrelated.record.DeviceID),
			unrelated.privateKey,
		),
	})
	if unrelatedResponse.Code != http.StatusForbidden {
		t.Fatalf("CreateChallenge(unrelated identity) status = %d, want %d", unrelatedResponse.Code, http.StatusForbidden)
	}
}
