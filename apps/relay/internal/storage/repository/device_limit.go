package repository

import (
	"errors"

	"echolet/apps/relay/internal/model"

	"github.com/dgraph-io/badger/v4"
)

// MaxDevicesPerIdentity bounds how many device records one identity may hold.
//
// Publishing a device record needs no prior registration, so without a bound a
// single identity key could mint device UUIDs until the disk is full. Sixteen is
// far above what one person runs and small enough that one identity cannot
// take a meaningful share of the storage cap.
const MaxDevicesPerIdentity = 16

// ensureDeviceCapacity refuses a NEW device for an identity that already holds
// MaxDevicesPerIdentity records. Re-publishing a device that is already stored
// never counts against the bound. It runs inside the caller's write
// transaction, so two concurrent publications cannot both take the last slot:
// the iteration is a read Badger checks for conflicts at commit.
func ensureDeviceCapacity(txn *badger.Txn, identityID, deviceID string) error {
	_, err := txn.Get(deviceRecordKey(identityID, deviceID))
	if err == nil {
		return nil
	}
	if !errors.Is(err, badger.ErrKeyNotFound) {
		return err
	}

	prefix := []byte(deviceRecordPrefix + identityID + ":")
	opts := badger.DefaultIteratorOptions
	opts.PrefetchValues = false
	opts.Prefix = prefix
	it := txn.NewIterator(opts)
	defer it.Close()

	stored := 0
	for it.Seek(prefix); it.ValidForPrefix(prefix); it.Next() {
		stored++
		if stored >= MaxDevicesPerIdentity {
			return model.ErrTooManyDevices
		}
	}
	return nil
}
