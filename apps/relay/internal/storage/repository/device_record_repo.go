package repository

import (
	"encoding/json"
	"errors"
	"fmt"

	"echolet/apps/relay/internal/cryptoutil"
	"echolet/apps/relay/internal/model"
	"echolet/apps/relay/internal/storage"

	"github.com/dgraph-io/badger/v4"
)

// deviceRecordPrefix and deviceMailboxBindingPrefix are the two key spaces that
// describe a published device.
//
//	device_record:<identity_id>:<device_id>   -> the signed record
//	device_mailbox:<mailbox_id>:<device_id>   -> the identity that owns it
//
// The binding is the authorization index: a device UUID is only ever resolvable
// through the mailbox of the identity it was published under, so the same UUID
// published under an unrelated identity cannot shadow the legitimate owner.
const (
	deviceRecordPrefix         = "device_record:"
	deviceMailboxBindingPrefix = "device_mailbox:"
)

const deviceRecordConflictRetries = 64

type DeviceRecordRepository struct {
	db *badger.DB
}

func NewDeviceRecordRepository(s *storage.Storage) *DeviceRecordRepository {
	return &DeviceRecordRepository{db: s.DB()}
}

// Save stores the device record and its (mailbox identity, device UUID)
// binding in one transaction.
func (r *DeviceRecordRepository) Save(record *model.DeviceRecord) error {
	data, err := json.Marshal(record)
	if err != nil {
		return err
	}

	var lastErr error
	for attempt := 0; attempt < deviceRecordConflictRetries; attempt++ {
		lastErr = r.db.Update(func(txn *badger.Txn) error {
			if err := txn.Set(deviceRecordKey(record.IdentityID, record.DeviceID), data); err != nil {
				return err
			}
			return SaveDeviceMailboxBinding(txn, record)
		})
		if !errors.Is(lastErr, badger.ErrConflict) {
			return lastErr
		}
	}
	return lastErr
}

func (r *DeviceRecordRepository) Get(identityID, deviceID string) (*model.DeviceRecord, error) {
	var record *model.DeviceRecord

	err := r.db.View(func(txn *badger.Txn) error {
		item, err := txn.Get(deviceRecordKey(identityID, deviceID))
		if err != nil {
			return err
		}

		return item.Value(func(val []byte) error {
			return json.Unmarshal(val, &record)
		})
	})

	return record, err
}

// GetByMailboxAndDevice resolves a device through the immutable
// (mailbox identity, device UUID) binding. It never scans the device_record key
// space, so a duplicate device UUID published under another identity is
// invisible here and cannot deny the legitimate mailbox owner.
//
// It returns badger.ErrKeyNotFound when no device is bound to that mailbox.
func (r *DeviceRecordRepository) GetByMailboxAndDevice(mailboxID, deviceID string) (*model.DeviceRecord, error) {
	if mailboxID == "" || deviceID == "" {
		return nil, badger.ErrKeyNotFound
	}

	var record *model.DeviceRecord

	err := r.db.View(func(txn *badger.Txn) error {
		bindingItem, err := txn.Get(deviceMailboxBindingKey(mailboxID, deviceID))
		if err != nil {
			return err
		}

		identityID, err := bindingItem.ValueCopy(nil)
		if err != nil {
			return err
		}

		recordItem, err := txn.Get(deviceRecordKey(string(identityID), deviceID))
		if err != nil {
			return err
		}

		return recordItem.Value(func(val []byte) error {
			return json.Unmarshal(val, &record)
		})
	})
	if err != nil {
		return nil, err
	}
	if record == nil {
		return nil, badger.ErrKeyNotFound
	}

	return record, nil
}

// BackfillDeviceMailboxBindings derives the authorization index for device
// records written before the binding existed. The binding is a pure function of
// the stored record, so this is idempotent and safe to run at every start.
func (r *DeviceRecordRepository) BackfillDeviceMailboxBindings() error {
	var pending []*model.DeviceRecord

	err := r.db.View(func(txn *badger.Txn) error {
		prefix := []byte(deviceRecordPrefix)
		it := txn.NewIterator(badger.DefaultIteratorOptions)
		defer it.Close()

		for it.Seek(prefix); it.ValidForPrefix(prefix); it.Next() {
			err := it.Item().Value(func(val []byte) error {
				var record *model.DeviceRecord
				if err := json.Unmarshal(val, &record); err != nil {
					return err
				}
				if record == nil || record.IdentityID == "" || record.DeviceID == "" {
					return nil
				}
				pending = append(pending, record)
				return nil
			})
			if err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		return err
	}

	for _, record := range pending {
		err := r.db.Update(func(txn *badger.Txn) error {
			return SaveDeviceMailboxBinding(txn, record)
		})
		if err != nil {
			return err
		}
	}

	return nil
}

// SaveDeviceMailboxBinding writes the (mailbox identity, device UUID) binding
// inside the caller's transaction. The binding is immutable: the first
// publication wins and later publications never rebind the pair.
func SaveDeviceMailboxBinding(txn *badger.Txn, record *model.DeviceRecord) error {
	if record == nil || record.IdentityID == "" || record.DeviceID == "" {
		return nil
	}

	key := deviceMailboxBindingKey(cryptoutil.DeriveMailboxID(record.IdentityID), record.DeviceID)
	_, err := txn.Get(key)
	if err == nil {
		return nil
	}
	if !errors.Is(err, badger.ErrKeyNotFound) {
		return err
	}

	return txn.Set(key, []byte(record.IdentityID))
}

func deviceRecordKey(identityID, deviceID string) []byte {
	return []byte(fmt.Sprintf("%s%s:%s", deviceRecordPrefix, identityID, deviceID))
}

func deviceMailboxBindingKey(mailboxID, deviceID string) []byte {
	return []byte(fmt.Sprintf("%s%s:%s", deviceMailboxBindingPrefix, mailboxID, deviceID))
}
