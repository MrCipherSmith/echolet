package repository

import (
	"encoding/json"
	"fmt"

	"echolet/apps/relay/internal/model"
	"echolet/apps/relay/internal/storage"

	"github.com/dgraph-io/badger/v4"
)

type PreKeyBundleRepository struct {
	db *badger.DB
}

func NewPreKeyBundleRepository(s *storage.Storage) *PreKeyBundleRepository {
	return &PreKeyBundleRepository{db: s.DB()}
}

func (r *PreKeyBundleRepository) Save(bundle *model.PreKeyBundle) error {
	data, err := json.Marshal(bundle)
	if err != nil {
		return err
	}

	return r.db.Update(func(txn *badger.Txn) error {
		key := fmt.Sprintf("prekey_bundle:%s:%s", bundle.IdentityID, bundle.BundleID)
		return txn.Set([]byte(key), data)
	})
}

func (r *PreKeyBundleRepository) GetByIdentity(identityID string) ([]*model.PreKeyBundle, error) {
	var bundles []*model.PreKeyBundle

	err := r.db.View(func(txn *badger.Txn) error {
		prefix := fmt.Sprintf("prekey_bundle:%s:", identityID)
		opts := badger.DefaultIteratorOptions
		opts.PrefetchSize = 10
		it := txn.NewIterator(opts)
		defer it.Close()

		for it.Seek([]byte(prefix)); it.ValidForPrefix([]byte(prefix)); it.Next() {
			item := it.Item()
			err := item.Value(func(val []byte) error {
				var bundle *model.PreKeyBundle
				if err := json.Unmarshal(val, &bundle); err != nil {
					return err
				}
				bundles = append(bundles, bundle)
				return nil
			})
			if err != nil {
				return err
			}
		}
		return nil
	})

	return bundles, err
}
