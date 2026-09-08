package repository

import (
	"bytes"
	"crypto/sha256"
	"echolet/apps/relay/internal/model"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/dgraph-io/badger/v4"
)

func updateV2(db *badger.DB, fn func(*badger.Txn) error) error {
	for attempt := 0; attempt < 64; attempt++ {
		err := db.Update(fn)
		if !errors.Is(err, badger.ErrConflict) {
			return err
		}
	}
	return badger.ErrConflict
}
func readV2(tx *badger.Txn, key string) ([]byte, error) {
	item, err := tx.Get([]byte(key))
	if err != nil {
		return nil, err
	}
	return item.ValueCopy(nil)
}

// SaveSignalV2 reports whether the stored publication is available for a first-contact claim.
//
// A repeated publish is idempotent: it re-stores byte-identical bytes and deliberately never
// re-adds the availability index, so after a claim the publication is stored but unclaimable.
// Only the relay can answer that question - a successful publish response is otherwise identical
// on the first-store and the re-store paths - and the answer is exactly the stored `Claimed` flag,
// because ClaimSignalV2 sets it and deletes the availability entry in one transaction. Expiry does
// not enter into it: validation rejects an out-of-window bundle before publication reaches here.
func (r *PreKeyBundleRepository) SaveSignalV2(bundle *model.SignalPreKeyBundleV2) (bool, error) {
	if bundle.DeviceRecord.IdentityID != bundle.IdentityID || bundle.DeviceRecord.DeviceID != bundle.DeviceID || bundle.DeviceRecord.DevicePubKey == "" {
		return false, model.ErrV2Schema
	}
	claimable := false
	err := updateV2(r.db, func(tx *badger.Txn) error {
		// updateV2 re-runs this closure on a Badger conflict; the answer belongs to the attempt
		// that commits.
		claimable = false
		key := "v2:bundle:" + bundle.BundleID
		old, err := readV2(tx, key)
		if err == nil {
			var stored model.SignalPreKeyBundleV2
			if err := json.Unmarshal(old, &stored); err != nil {
				return err
			}
			if bytes.Equal(stored.Raw, bundle.Raw) {
				claimable = !stored.Claimed
				return saveSignalV2Authorization(tx, &bundle.DeviceRecord)
			}
			return model.ErrV2BundleConflict
		}
		if !errors.Is(err, badger.ErrKeyNotFound) {
			return err
		}
		tuple, _ := json.Marshal([]any{bundle.IdentityID, bundle.DeviceID, bundle.SignalIdentity, bundle.OneTimeKeyID})
		reservations := []string{fmt.Sprintf("v2:otk:tuple:%x", sha256.Sum256(tuple)), fmt.Sprintf("v2:otk:public:%x", sha256.Sum256([]byte(bundle.OneTimePublicKey)))}
		for _, index := range reservations {
			_, err := tx.Get([]byte(index))
			if err == nil {
				return model.ErrV2PreKeyReused
			}
			if !errors.Is(err, badger.ErrKeyNotFound) {
				return err
			}
			if err := tx.Set([]byte(index), []byte(bundle.BundleID)); err != nil {
				return err
			}
		}
		data, err := json.Marshal(bundle)
		if err != nil {
			return err
		}
		if err := tx.Set([]byte(key), data); err != nil {
			return err
		}
		if err := saveSignalV2Authorization(tx, &bundle.DeviceRecord); err != nil {
			return err
		}
		if err := tx.Set([]byte(fmt.Sprintf("v2:available:%s:%016d:%s", bundle.IdentityID, bundle.CreatedAtMS, bundle.BundleID)), []byte(bundle.BundleID)); err != nil {
			return err
		}
		claimable = true
		return nil
	})
	if err != nil {
		return false, err
	}
	return claimable, nil
}

// The caller's publication transaction owns both this authorization and all OTK indexes.
func saveSignalV2Authorization(tx *badger.Txn, record *model.DeviceRecord) error {
	key := string(deviceRecordKey(record.IdentityID, record.DeviceID))
	old, err := readV2(tx, key)
	if err == nil {
		var stored model.DeviceRecord
		if err := json.Unmarshal(old, &stored); err != nil {
			return err
		}
		if stored.IdentityID != record.IdentityID || stored.DeviceID != record.DeviceID || stored.DevicePubKey != record.DevicePubKey {
			return model.ErrV2BundleConflict
		}
		// The binding is immutable and idempotent; re-asserting it keeps records
		// published before the index existed authorizable.
		return SaveDeviceMailboxBinding(tx, record)
	}
	if !errors.Is(err, badger.ErrKeyNotFound) {
		return err
	}
	data, err := json.Marshal(record)
	if err != nil {
		return err
	}
	if err := tx.Set([]byte(key), data); err != nil {
		return err
	}
	return SaveDeviceMailboxBinding(tx, record)
}

type signalClaimV2 struct {
	IdentityID  string
	DeviceID    *string
	Bundle      []byte
	BundleID    string
	ClaimedAtMS int64
}

func (r *PreKeyBundleRepository) ClaimSignalV2(claimID, identityID string, deviceID *string, nowMS int64) ([]byte, error) {
	var result []byte
	err := updateV2(r.db, func(tx *badger.Txn) error {
		claimKey := "v2:claim:" + claimID
		old, err := readV2(tx, claimKey)
		if err == nil {
			var claim signalClaimV2
			if err := json.Unmarshal(old, &claim); err != nil {
				return err
			}
			same := claim.DeviceID == nil && deviceID == nil || claim.DeviceID != nil && deviceID != nil && *claim.DeviceID == *deviceID
			if claim.IdentityID != identityID || !same {
				return model.ErrV2ClaimConflict
			}
			result = claim.Bundle
			return nil
		}
		if !errors.Is(err, badger.ErrKeyNotFound) {
			return err
		}
		prefix := []byte("v2:available:" + identityID + ":")
		it := tx.NewIterator(badger.DefaultIteratorOptions)
		defer it.Close()
		for it.Seek(prefix); it.ValidForPrefix(prefix); it.Next() {
			id, err := it.Item().ValueCopy(nil)
			if err != nil {
				return err
			}
			bundleKey := "v2:bundle:" + string(id)
			data, err := readV2(tx, bundleKey)
			if err != nil {
				return err
			}
			var bundle model.SignalPreKeyBundleV2
			if err := json.Unmarshal(data, &bundle); err != nil {
				return err
			}
			if bundle.Claimed || nowMS < bundle.CreatedAtMS || nowMS >= bundle.ExpiresAtMS || deviceID != nil && bundle.DeviceID != *deviceID {
				continue
			}
			bundle.Claimed = true
			updated, err := json.Marshal(bundle)
			if err != nil {
				return err
			}
			if err := tx.Set([]byte(bundleKey), updated); err != nil {
				return err
			}
			if err := tx.Delete(it.Item().KeyCopy(nil)); err != nil {
				return err
			}
			claimData, err := json.Marshal(signalClaimV2{IdentityID: identityID, DeviceID: deviceID, Bundle: bundle.Raw, BundleID: bundle.BundleID, ClaimedAtMS: nowMS})
			if err != nil {
				return err
			}
			if err := tx.Set([]byte(claimKey), claimData); err != nil {
				return err
			}
			result = append([]byte(nil), bundle.Raw...)
			return nil
		}
		return model.ErrV2Unavailable
	})
	if err != nil {
		return nil, err
	}
	return result, nil
}
