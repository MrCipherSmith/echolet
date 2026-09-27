package repository

import (
	"errors"
	"sync"
	"testing"
	"time"

	"echolet/apps/relay/internal/model"
	"echolet/apps/relay/internal/storage"

	"github.com/dgraph-io/badger/v4"
)

func TestChallengeIsStoredWithATTLBoundedByItsOwnExpiry(t *testing.T) {
	st, err := storage.NewStorage(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	repo := NewChallengeRepository(st)

	before := time.Now()
	challenge := &model.MailboxChallenge{ChallengeID: "unredeemed", ExpiresAtMs: before.Add(time.Minute).UnixMilli()}
	if err := repo.Save(challenge); err != nil {
		t.Fatal(err)
	}

	var expiresAt uint64
	if err := st.DB().View(func(txn *badger.Txn) error {
		item, err := txn.Get([]byte("challenge:unredeemed"))
		if err != nil {
			return err
		}
		expiresAt = item.ExpiresAt()
		return nil
	}); err != nil {
		t.Fatal(err)
	}

	if expiresAt == 0 {
		t.Fatal("challenge stored without a TTL: an unredeemed challenge would occupy the store forever")
	}
	latest := uint64(before.Add(time.Minute + challengeRetentionGrace + 5*time.Second).Unix())
	if expiresAt > latest {
		t.Fatalf("challenge TTL ends at %d, want no later than %d (expiry plus grace)", expiresAt, latest)
	}
}

func TestChallengeStorageTTLNeverDropsBelowTheGrace(t *testing.T) {
	now := time.Now()
	expired := &model.MailboxChallenge{ExpiresAtMs: now.Add(-time.Hour).UnixMilli()}
	if got := challengeStorageTTL(expired, now); got != challengeRetentionGrace {
		t.Fatalf("challengeStorageTTL(already expired) = %s, want %s", got, challengeRetentionGrace)
	}
}

func TestChallengeInvalidateAllowsOnlyOneConcurrentConsumer(t *testing.T) {
	st, err := storage.NewStorage(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	repo := NewChallengeRepository(st)
	challenge := &model.MailboxChallenge{ChallengeID: "concurrent", ExpiresAtMs: time.Now().Add(time.Minute).UnixMilli()}
	if err := repo.Save(challenge); err != nil {
		t.Fatal(err)
	}
	const consumers = 16
	var ready sync.WaitGroup
	ready.Add(consumers)
	start := make(chan struct{})
	results := make(chan error, consumers)
	for i := 0; i < consumers; i++ {
		go func() {
			_, err := repo.Get(challenge.ChallengeID)
			ready.Done()
			<-start
			if err == nil {
				err = repo.Invalidate(challenge.ChallengeID)
			}
			results <- err
		}()
	}
	ready.Wait() // Every consumer has observed the same unconsumed record.
	close(start)
	successes := 0
	for i := 0; i < consumers; i++ {
		if err := <-results; err == nil {
			successes++
		} else if !errors.Is(err, ErrInvalidChallenge) {
			t.Errorf("unexpected consume error: %v", err)
		}
	}
	if successes != 1 {
		t.Fatalf("successful consumers = %d, want exactly 1", successes)
	}
}

func TestChallengeInvalidateRechecksExpiryAndUsed(t *testing.T) {
	st, err := storage.NewStorage(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	repo := NewChallengeRepository(st)
	for _, challenge := range []*model.MailboxChallenge{
		{ChallengeID: "expired", ExpiresAtMs: time.Now().Add(-time.Second).UnixMilli()},
		{ChallengeID: "used", ExpiresAtMs: time.Now().Add(time.Minute).UnixMilli(), Used: true},
	} {
		if err := repo.Save(challenge); err != nil {
			t.Fatal(err)
		}
		if err := repo.Invalidate(challenge.ChallengeID); err == nil {
			t.Errorf("consumed invalid challenge %s", challenge.ChallengeID)
		}
	}
}
