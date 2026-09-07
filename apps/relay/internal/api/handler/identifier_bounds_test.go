package handler

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"net/http"
	"strings"
	"testing"

	"echolet/apps/relay/internal/cryptoutil"
	"echolet/apps/relay/internal/model"
	"echolet/apps/relay/internal/service"
	"echolet/apps/relay/internal/storage"
	"echolet/apps/relay/internal/storage/repository"
)

// RED tests for round-2 review finding R2-002 (minor): the BE-R-001 class is not closed.
//
// T41 bounded the identifier strings of a mailbox envelope only. Two other write paths still put an
// unbounded caller-supplied string straight into a Badger key, whose 65000-byte ceiling then
// answers with HTTP 500 - an internal error reported for purely malformed client input:
//
//	/v1/device-records/publish  device_id ~65 kB      -> 500 (unauthenticated; ValidateDeviceRecord
//	                                                    checks non-emptiness only, validate.go:18-20,
//	                                                    key built at device_record_repo.go)
//	/v1/mailbox/ack             envelope_ids[i] 65 kB -> 500 (self-authenticated; the element count
//	                                                    is bounded at mailbox_handler.go:315, the
//	                                                    element length is not, and DeleteEnvelope
//	                                                    deletes unconditionally)
//
// The round-2 reviewer reproduced both against a scratchpad relay: device_id 64960 bytes -> 500,
// device_id 64900 bytes -> 200 (the boundary is Badger's key ceiling, not any relay rule).
//
// These tests require a bounded 4xx with a client error code on both routes and pin no particular
// maximum, so the implementer is free to reuse maxEnvelopeIdentifierBytes or to require a UUID.
// Identifier values are synthetic padding; only lengths, status codes and error codes are printed.

// oversizedKeyIdentifierBytes is the length at which the reviewer reproduced HTTP 500 on
// /v1/device-records/publish, chosen to stay inside the 64 KiB compact request-body limit.
const oversizedKeyIdentifierBytes = 64960

// oversizedAckEnvelopeIDBytes is the length the reviewer reproduced HTTP 500 with on
// /v1/mailbox/ack.
const oversizedAckEnvelopeIDBytes = 65000

func TestPublishDeviceRecordRejectsOversizedDeviceIDWithClientError(t *testing.T) {
	handler := newDeviceRecordHandlerTestHarness(t)

	oversized, _ := signedDeviceRecordWithDeviceID(t, strings.Repeat("A", oversizedKeyIdentifierBytes))
	response := postJSON(t, http.HandlerFunc(handler.PublishDeviceRecord), map[string]any{"device_record": oversized})

	if response.Code >= http.StatusInternalServerError {
		t.Fatalf("PublishDeviceRecord(device_id_len=%d) status = %d, want a bounded 4xx: an unauthenticated caller-supplied identifier that cannot fit a store key must be refused by validation, not surfaced as an internal error (error code %q)",
			len(oversized.DeviceID), response.Code, mailboxErrorCode(t, response))
	}
	if response.Code < http.StatusBadRequest {
		t.Fatalf("PublishDeviceRecord(device_id_len=%d) status = %d, want a 4xx rejection",
			len(oversized.DeviceID), response.Code)
	}
	if code := mailboxErrorCode(t, response); code == "" || code == "INTERNAL_ERROR" {
		t.Fatalf("PublishDeviceRecord(device_id_len=%d) error code = %q, want a client-error code",
			len(oversized.DeviceID), code)
	}

	// Control: an ordinary UUID device_id must still be published, so the bound cannot be obtained
	// by refusing the route outright.
	ordinary, _ := signedDeviceRecordWithDeviceID(t, "8cc8010b-d4a1-4ce7-8203-a8f6b055c1b9")
	accepted := postJSON(t, http.HandlerFunc(handler.PublishDeviceRecord), map[string]any{"device_record": ordinary})
	if accepted.Code != http.StatusOK {
		t.Fatalf("PublishDeviceRecord(ordinary device_id) status = %d, want %d (error code %q)",
			accepted.Code, http.StatusOK, mailboxErrorCode(t, accepted))
	}
}

func TestAckMailboxRejectsOversizedEnvelopeIDWithClientError(t *testing.T) {
	handler, deviceService, _ := newMailboxHandlerTestHarness(t)
	record, devicePrivateKey := signedDeviceRecord(t)
	mailboxID := cryptoutil.DeriveMailboxID(record.IdentityID)
	if err := deviceService.PublishDeviceRecord(record); err != nil {
		t.Fatalf("PublishDeviceRecord() error = %v", err)
	}

	oversizedIDs := []string{strings.Repeat("A", oversizedAckEnvelopeIDBytes)}
	response := postJSON(t, http.HandlerFunc(handler.AckMailbox), map[string]any{
		"recipient_mailbox_id": mailboxID,
		"device_id":            record.DeviceID,
		"envelope_ids":         oversizedIDs,
		"signature":            signMessage(t, cryptoutil.CreateMailboxAckMessage(mailboxID, record.DeviceID, oversizedIDs), devicePrivateKey),
	})

	if response.Code >= http.StatusInternalServerError {
		t.Fatalf("AckMailbox(envelope_id_len=%d) status = %d, want a bounded 4xx: the element count is bounded but the element length is not, so an oversized entry reaches the store key and answers with an internal error (error code %q)",
			len(oversizedIDs[0]), response.Code, mailboxErrorCode(t, response))
	}
	if response.Code < http.StatusBadRequest {
		t.Fatalf("AckMailbox(envelope_id_len=%d) status = %d, want a 4xx rejection",
			len(oversizedIDs[0]), response.Code)
	}
	if code := mailboxErrorCode(t, response); code == "" || code == "INTERNAL_ERROR" {
		t.Fatalf("AckMailbox(envelope_id_len=%d) error code = %q, want a client-error code",
			len(oversizedIDs[0]), code)
	}

	// Control: an ordinary UUID envelope_id must still be acknowledged, including one that is not
	// in the mailbox - acking an already-delivered envelope is the client's retry path.
	ordinaryIDs := []string{"7b95a59f-53f2-4d51-8e27-a659cf30fd95"}
	accepted := postJSON(t, http.HandlerFunc(handler.AckMailbox), map[string]any{
		"recipient_mailbox_id": mailboxID,
		"device_id":            record.DeviceID,
		"envelope_ids":         ordinaryIDs,
		"signature":            signMessage(t, cryptoutil.CreateMailboxAckMessage(mailboxID, record.DeviceID, ordinaryIDs), devicePrivateKey),
	})
	if accepted.Code != http.StatusOK {
		t.Fatalf("AckMailbox(ordinary envelope_id) status = %d, want %d (error code %q)",
			accepted.Code, http.StatusOK, mailboxErrorCode(t, accepted))
	}
}

func newDeviceRecordHandlerTestHarness(t *testing.T) *DeviceRecordHandler {
	t.Helper()
	store, err := storage.NewStorage(t.TempDir())
	if err != nil {
		t.Fatalf("NewStorage() error = %v", err)
	}
	t.Cleanup(func() { _ = store.Close() })
	return NewDeviceRecordHandler(service.NewDeviceRecordService(repository.NewDeviceRecordRepository(store)))
}

// signedDeviceRecordWithDeviceID self-signs a device record for a freshly generated identity, with
// the given device_id. Any caller can do this: /v1/device-records/publish is unauthenticated and
// the record only has to verify against its own identity key.
func signedDeviceRecordWithDeviceID(t *testing.T, deviceID string) (*model.DeviceRecord, ed25519.PrivateKey) {
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
		DeviceID:     deviceID,
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
