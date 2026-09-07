package repository

import (
	"bytes"
	"encoding/json"
	"fmt"
	"log/slog"
	"strings"
	"testing"

	"echolet/apps/relay/internal/cryptoutil"
	"echolet/apps/relay/internal/model"
	"echolet/apps/relay/internal/storage"

	"github.com/dgraph-io/badger/v4"
)

// RED tests for residual RI-23 (flow 003 T1 inventory; BE-R-002, BE R-003,
// STATUS §4).
//
// BackfillDeviceMailboxBindings (device_record_repo.go:125-165) derives the
// authorization index for device records written before the
// (mailbox identity, device UUID) binding existed. It collects every record in a
// single View loop and returns the FIRST json.Unmarshal error it meets
// (device_record_repo.go:145-147), discarding every record already collected and
// never reaching the ones after it. router.go:39 logs that failure and starts the
// relay anyway.
//
// So one undecodable record - a truncated write, a value from an older schema, a
// single corrupted page - leaves EVERY pre-binding identity unbound. The relay
// answers /health, looks entirely healthy, and refuses its legitimate owners with
// UNAUTHORIZED_MAILBOX_ACCESS. The blast radius of one bad record is every
// unrelated identity in the store, which is what makes this a denial of service
// rather than a lost record.
//
// The property: an undecodable record is SKIPPED and COUNTED, the healthy records
// around it are still bound, and the count is reported so an operator can see that
// the store has something wrong in it. Nothing here pins how the skip is
// implemented.
//
// No stored value, key material or record content is ever printed; only counts,
// identifiers derived from test fixtures, and error text appear in failure output.

// undecodableDeviceRecordValue is not JSON. It stands for any value the current
// model cannot decode; nothing about the particular bytes matters.
const undecodableDeviceRecordValue = "{ this is not a device record"

// backfillFixture is one pre-binding device record: the primary
// device_record:<identity_id>:<device_id> key written WITHOUT its binding, which
// is exactly the state the backfill exists to repair.
type backfillFixture struct {
	identityID string
	deviceID   string
	mailboxID  string
}

func TestBackfillSkipsUndecodableRecordAndBindsTheHealthyOnes(t *testing.T) {
	store, repo := newBackfillTestRepository(t)

	// Two healthy pre-binding records with an undecodable one BETWEEN them in
	// key order, so a scan that aborts on the first failure loses the second
	// healthy record as well as the corrupt one, and a scan that merely ignores
	// its own error would still have to have collected the first.
	first := seedPreBindingDeviceRecord(t, store, "aaaa-identity", "3f1b2c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d")
	seedUndecodableDeviceRecord(t, store, "mmmm-identity", "6a7b8c9d-0e1f-4a2b-9c3d-4e5f6a7b8c9d")
	second := seedPreBindingDeviceRecord(t, store, "zzzz-identity", "9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a")

	if err := repo.BackfillDeviceMailboxBindings(); err != nil {
		t.Fatalf("BackfillDeviceMailboxBindings() error = %v, want nil: one undecodable record must be skipped, "+
			"not turned into a failure that abandons the whole scan. Aborting leaves every pre-binding identity "+
			"unbound while router.go:39 starts the relay anyway, so the relay comes up healthy and refuses its "+
			"legitimate owners", err)
	}

	for _, healthy := range []backfillFixture{first, second} {
		record, err := repo.GetByMailboxAndDevice(healthy.mailboxID, healthy.deviceID)
		if err != nil {
			t.Fatalf("GetByMailboxAndDevice(device %s) error = %v: a healthy device record next to an undecodable "+
				"one was left unbound, so its owner cannot authorize", healthy.deviceID, err)
		}
		if record == nil || record.IdentityID != healthy.identityID {
			t.Fatalf("GetByMailboxAndDevice(device %s) resolved to the wrong identity", healthy.deviceID)
		}
	}
}

// TestBackfillReportsTheNumberOfSkippedRecords pins the "counted" half.
//
// The count has to reach an operator, not just the code: the relay starts
// regardless of what the backfill found (router.go:39), so a silent skip trades
// one silent failure for another - the store would be quietly missing records
// with nothing anywhere saying so. slog is where the relay already reports
// startup facts ("Cleanup service started", "Storage closed", "BadgerDB opened"),
// so the assertion is that a record about the skipped entries appears there. The
// matcher is deliberately loose about wording: it requires only that some log
// record names a skip and carries the number of records skipped.
func TestBackfillReportsTheNumberOfSkippedRecords(t *testing.T) {
	store, repo := newBackfillTestRepository(t)

	seedPreBindingDeviceRecord(t, store, "aaaa-identity", "3f1b2c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d")
	seedUndecodableDeviceRecord(t, store, "mmmm-identity", "6a7b8c9d-0e1f-4a2b-9c3d-4e5f6a7b8c9d")
	seedUndecodableDeviceRecord(t, store, "nnnn-identity", "7b8c9d0e-1f2a-4b3c-8d4e-5f6a7b8c9d0e")

	logged := captureSlog(t)

	if err := repo.BackfillDeviceMailboxBindings(); err != nil {
		t.Fatalf("BackfillDeviceMailboxBindings() error = %v, want nil", err)
	}

	text := logged.String()
	if !mentionsSkippedCount(text, 2) {
		t.Fatalf("the backfill skipped 2 undecodable device records and reported nothing an operator can see. "+
			"Log output was:\n%s\nwant a record naming the skip and carrying the count 2, so a store with corrupt "+
			"records is visible rather than silently smaller than it should be", text)
	}
}

// mentionsSkippedCount reports whether the captured log names a skip and carries
// the given count. It matches on meaning rather than on an exact message, so any
// reasonable wording passes.
func mentionsSkippedCount(text string, count int) bool {
	lowered := strings.ToLower(text)
	named := strings.Contains(lowered, "skip") ||
		strings.Contains(lowered, "undecodable") ||
		strings.Contains(lowered, "corrupt") ||
		strings.Contains(lowered, "unreadable")
	return named && strings.Contains(lowered, fmt.Sprintf("%d", count))
}

// captureSlog installs a capturing default logger for the duration of the test
// and returns the buffer it writes into.
func captureSlog(t *testing.T) *bytes.Buffer {
	t.Helper()

	buffer := &bytes.Buffer{}
	previous := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(buffer, &slog.HandlerOptions{Level: slog.LevelDebug})))
	t.Cleanup(func() { slog.SetDefault(previous) })
	return buffer
}

func newBackfillTestRepository(t *testing.T) (*storage.Storage, *DeviceRecordRepository) {
	t.Helper()

	store, err := storage.NewStorage(t.TempDir())
	if err != nil {
		t.Fatalf("NewStorage() error = %v", err)
	}
	t.Cleanup(func() { _ = store.Close() })
	return store, NewDeviceRecordRepository(store)
}

// seedPreBindingDeviceRecord writes only the primary device_record key, with no
// device_mailbox binding - the state of every record published before the
// binding key space existed, and the only state the backfill has any work to do
// in. Save() would write both keys and make the test vacuous.
func seedPreBindingDeviceRecord(t *testing.T, store *storage.Storage, identityID, deviceID string) backfillFixture {
	t.Helper()

	record := &model.DeviceRecord{
		Type:         "device_record",
		Version:      1,
		IdentityID:   identityID,
		DeviceID:     deviceID,
		DevicePubKey: "kFtdJZ6vAqCmxsGqiVAgrkS9LhwsWQnvGYRl6t1RfhM",
		Capabilities: map[string]bool{"mailbox_poll": true},
		CreatedAtMs:  1770000000000,
		Signature:    "not-verified-by-the-backfill",
	}
	data, err := json.Marshal(record)
	if err != nil {
		t.Fatalf("json.Marshal(device record) error = %v", err)
	}
	writeRawDeviceRecord(t, store, identityID, deviceID, data)

	return backfillFixture{
		identityID: identityID,
		deviceID:   deviceID,
		mailboxID:  cryptoutil.DeriveMailboxID(identityID),
	}
}

// seedUndecodableDeviceRecord writes a value under the device_record prefix that
// the current model cannot decode.
func seedUndecodableDeviceRecord(t *testing.T, store *storage.Storage, identityID, deviceID string) {
	t.Helper()
	writeRawDeviceRecord(t, store, identityID, deviceID, []byte(undecodableDeviceRecordValue))
}

func writeRawDeviceRecord(t *testing.T, store *storage.Storage, identityID, deviceID string, value []byte) {
	t.Helper()

	if err := store.DB().Update(func(txn *badger.Txn) error {
		return txn.Set(deviceRecordKey(identityID, deviceID), value)
	}); err != nil {
		t.Fatalf("seeding a device record failed: %v", err)
	}
}
