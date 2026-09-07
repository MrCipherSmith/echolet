package handler

import (
	"encoding/json"
	"fmt"
	"net/http"
	"testing"

	"echolet/apps/relay/internal/cryptoutil"
	"echolet/apps/relay/internal/service"
	"echolet/apps/relay/internal/storage"
	"echolet/apps/relay/internal/storage/repository"

	"github.com/dgraph-io/badger/v4"
)

// RED test for residual RI-23 (flow 003 T1 inventory), stated as the consequence
// an operator actually meets rather than as a repository return value.
//
// device_record_repo.go:125-165 abandons the whole binding backfill on the first
// undecodable record, and router.go:39 logs that and starts the relay anyway. The
// effect is that ONE corrupt record in the store denies service to every
// UNRELATED pre-binding identity: the relay answers /health, accepts
// connections, and refuses its legitimate owners at the first authorization step,
// because GetByMailboxAndDevice resolves only through the binding the backfill
// never wrote.
//
// This drives the real /v1/mailbox/challenge route, which is where a recipient
// first has to prove it owns its mailbox, so the failure reported is the one the
// owner would see. The companion assertions on the repository itself are in
// internal/storage/repository/device_record_backfill_test.go.
//
// No key material, store key or request body is printed; only status codes, error
// codes and fixture device identifiers appear in failure output.

func TestPreBindingIdentityStillAuthorizesWhenAnotherDeviceRecordIsUndecodable(t *testing.T) {
	handler, store, deviceService := newBackfillAuthorizationHarness(t)

	// A legitimate owner published before the binding key space existed: the
	// primary record is present, the binding is not.
	record, devicePrivateKey := signedDeviceRecord(t)
	seedRawDeviceRecordValue(t, store, record.IdentityID, record.DeviceID, marshalJSON(t, record))

	// One unrelated record the current model cannot decode. It shares nothing
	// with the owner above - not the identity, not the device, not the mailbox.
	seedRawDeviceRecordValue(t, store,
		"zzzz-unrelated-identity", "6a7b8c9d-0e1f-4a2b-9c3d-4e5f6a7b8c9d",
		[]byte("{ this is not a device record"))

	// The relay runs this at every start (router.go:39) and starts regardless of
	// what it returns, so the test ignores the error exactly as the relay does.
	// What matters is the state it leaves behind.
	_ = deviceService.BackfillMailboxBindings()

	mailboxID := cryptoutil.DeriveMailboxID(record.IdentityID)
	response := postJSON(t, http.HandlerFunc(handler.CreateChallenge), map[string]string{
		"recipient_mailbox_id": mailboxID,
		"device_id":            record.DeviceID,
		"signature": signMessage(t,
			cryptoutil.CreateMailboxCreateChallengeMessage(mailboxID, record.DeviceID), devicePrivateKey),
	})

	if response.Code != http.StatusOK {
		t.Fatalf("CreateChallenge(pre-binding owner, device %s) status = %d, want %d (error code %q). "+
			"One unrelated undecodable device record aborted the startup backfill "+
			"(device_record_repo.go:145-147, :159-161), so this owner's binding was never written and the relay - "+
			"which started anyway - refuses the identity at its first authorization step. The blast radius of one "+
			"bad record must be that record, not every pre-binding identity in the store",
			record.DeviceID, response.Code, http.StatusOK, mailboxErrorCode(t, response))
	}
}

func newBackfillAuthorizationHarness(t *testing.T) (*MailboxHandler, *storage.Storage, *service.DeviceRecordService) {
	t.Helper()

	st, err := storage.NewStorage(t.TempDir())
	if err != nil {
		t.Fatalf("NewStorage() error = %v", err)
	}
	t.Cleanup(func() { _ = st.Close() })

	deviceService := service.NewDeviceRecordService(repository.NewDeviceRecordRepository(st))
	mailboxService := service.NewMailboxService(repository.NewMailboxRepository(st))
	challengeService := service.NewChallengeService(repository.NewChallengeRepository(st), 60)

	handler := NewMailboxHandler(mailboxService, challengeService, deviceService,
		defaultMaxMailboxBatch, defaultMaxMessageBytes)
	return handler, st, deviceService
}

// seedRawDeviceRecordValue writes a value under the primary device-record key
// WITHOUT the device_mailbox binding, which is the pre-binding state the
// backfill exists to repair. The key shape is the one documented at
// internal/storage/repository/device_record_repo.go:15-27:
//
//	device_record:<identity_id>:<device_id>
//
// It is built here rather than reused because deviceRecordKey is unexported in
// that package.
func seedRawDeviceRecordValue(t *testing.T, store *storage.Storage, identityID, deviceID string, value []byte) {
	t.Helper()

	key := []byte(fmt.Sprintf("device_record:%s:%s", identityID, deviceID))
	if err := store.DB().Update(func(txn *badger.Txn) error {
		return txn.Set(key, value)
	}); err != nil {
		t.Fatalf("seeding a device record failed: %v", err)
	}
}

func marshalJSON(t *testing.T, value any) []byte {
	t.Helper()

	data, err := json.Marshal(value)
	if err != nil {
		t.Fatalf("json.Marshal() error = %v", err)
	}
	return data
}
