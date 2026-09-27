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
		return txn.SetEntry(badger.NewEntry([]byte(key), data).WithTTL(challengeStorageTTL(challenge, time.Now())))
	})
}

// challengeRetentionGrace keeps a challenge stored a little past its own expiry,
// so a poll racing the deadline still meets ErrInvalidChallenge rather than a
// missing key, and the two paths stay indistinguishable to the caller.
const challengeRetentionGrace = time.Minute

// challengeStorageTTL bounds how long an issued challenge occupies the store.
// The challenge route is unauthenticated, so a challenge nobody redeems must
// not be kept forever.
func challengeStorageTTL(challenge *model.MailboxChallenge, now time.Time) time.Duration {
	remaining := time.UnixMilli(challenge.ExpiresAtMs).Sub(now)
	if remaining < 0 {
		remaining = 0
	}
	return remaining + challengeRetentionGrace
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
