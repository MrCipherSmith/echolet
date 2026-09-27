package repository

import (
	"errors"
	"fmt"
	"testing"

	"echolet/apps/relay/internal/model"
	"echolet/apps/relay/internal/storage"

	"github.com/dgraph-io/badger/v4"
)

func newDeviceLimitStore(t *testing.T) *storage.Storage {
	t.Helper()
	st, err := storage.NewStorage(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	return st
}

func limitTestRecord(identityID string, device int) *model.DeviceRecord {
	return &model.DeviceRecord{
		IdentityID:   identityID,
		DeviceID:     fmt.Sprintf("00000000-0000-4000-8000-%012d", device),
		DevicePubKey: fmt.Sprintf("device-key-%d", device),
	}
}

func TestDeviceRecordSaveRefusesANewDeviceBeyondThePerIdentityLimit(t *testing.T) {
	repo := NewDeviceRecordRepository(newDeviceLimitStore(t))

	for device := 0; device < MaxDevicesPerIdentity; device++ {
		if err := repo.Save(limitTestRecord("identity-a", device)); err != nil {
			t.Fatalf("Save(device %d) error = %v, want nil below the limit", device, err)
		}
	}

	if err := repo.Save(limitTestRecord("identity-a", MaxDevicesPerIdentity)); !errors.Is(err, model.ErrTooManyDevices) {
		t.Fatalf("Save(device %d) error = %v, want ErrTooManyDevices", MaxDevicesPerIdentity, err)
	}

	// Re-publishing a device that is already stored is not a new device.
	if err := repo.Save(limitTestRecord("identity-a", 0)); err != nil {
		t.Fatalf("re-publishing a stored device error = %v, want nil", err)
	}

	// The bound is per identity, including one whose id extends the full one's.
	if err := repo.Save(limitTestRecord("identity-ab", 0)); err != nil {
		t.Fatalf("Save(another identity) error = %v, want nil", err)
	}
}

func TestSignalV2AuthorizationRefusesANewDeviceBeyondThePerIdentityLimit(t *testing.T) {
	st := newDeviceLimitStore(t)
	repo := NewDeviceRecordRepository(st)
	for device := 0; device < MaxDevicesPerIdentity; device++ {
		if err := repo.Save(limitTestRecord("identity-a", device)); err != nil {
			t.Fatal(err)
		}
	}

	err := st.DB().Update(func(txn *badger.Txn) error {
		return saveSignalV2Authorization(txn, limitTestRecord("identity-a", MaxDevicesPerIdentity))
	})
	if !errors.Is(err, model.ErrTooManyDevices) {
		t.Fatalf("saveSignalV2Authorization(new device) error = %v, want ErrTooManyDevices", err)
	}

	err = st.DB().Update(func(txn *badger.Txn) error {
		return saveSignalV2Authorization(txn, limitTestRecord("identity-a", 3))
	})
	if err != nil {
		t.Fatalf("saveSignalV2Authorization(stored device) error = %v, want nil", err)
	}
}
