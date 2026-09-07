package repository

import (
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"echolet/apps/relay/internal/model"
	"echolet/apps/relay/internal/storage"

	"github.com/dgraph-io/badger/v4"
)

var ErrInvalidChallenge = errors.New("invalid or expired challenge")

type ChallengeRepository struct {
	db *badger.DB
}

func NewChallengeRepository(s *storage.Storage) *ChallengeRepository {
	return &ChallengeRepository{db: s.DB()}
}

func (r *ChallengeRepository) Save(challenge *model.MailboxChallenge) error {
	data, err := json.Marshal(challenge)
	if err != nil {
		return err
	}

	return r.db.Update(func(txn *badger.Txn) error {
		key := fmt.Sprintf("challenge:%s", challenge.ChallengeID)
		return txn.Set([]byte(key), data)
	})
}

func (r *ChallengeRepository) Get(challengeID string) (*model.MailboxChallenge, error) {
	var challenge *model.MailboxChallenge

	err := r.db.View(func(txn *badger.Txn) error {
		key := fmt.Sprintf("challenge:%s", challengeID)
		item, err := txn.Get([]byte(key))
		if err != nil {
			return err
		}

		return item.Value(func(val []byte) error {
			return json.Unmarshal(val, &challenge)
		})
	})

	return challenge, err
}

// Invalidate atomically consumes a still-valid challenge. The transaction's read
// makes competing deletes conflict, so only one authenticated poll can proceed.
func (r *ChallengeRepository) Invalidate(challengeID string) error {
	err := r.db.Update(func(txn *badger.Txn) error {
		key := []byte(fmt.Sprintf("challenge:%s", challengeID))
		item, err := txn.Get(key)
		if errors.Is(err, badger.ErrKeyNotFound) {
			return ErrInvalidChallenge
		}
		if err != nil {
			return err
		}
		var challenge model.MailboxChallenge
		if err := item.Value(func(value []byte) error { return json.Unmarshal(value, &challenge) }); err != nil {
			return err
		}
		if challenge.Used || time.Now().UnixMilli() > challenge.ExpiresAtMs {
			return ErrInvalidChallenge
		}
		return txn.Delete(key)
	})
	if errors.Is(err, badger.ErrConflict) {
		return ErrInvalidChallenge
	}
	return err
}
