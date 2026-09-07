package repository

import (
	"encoding/json"
	"fmt"
	"testing"
	"time"

	"echolet/apps/relay/internal/model"
	"echolet/apps/relay/internal/storage"

	"github.com/dgraph-io/badger/v4"
)

// RED tests for review finding F-005 (b) and (c).
//
// (b) SaveEnvelope pins a flat WithTTL(7*24h) (mailbox_repo.go:30), so a normal
//     24h CLI envelope is retained for seven days. Physical retention must never
//     exceed the envelope's own declared lifetime, nor the configured server cap,
//     and an identical retry must not extend the deadline.
//
// (c) GetEnvelopes appends every stored record until the batch limit is reached
//     (mailbox_repo.go:46-55) without consulting ExpiresAtMs, so one stale expired
//     envelope keeps blocking delivery of newer valid envelopes in the same poll.
//
// Ciphertext values are synthetic padding and are never printed.

const (
	mailboxServerRetentionCapSeconds = int64(7 * 24 * 60 * 60) // config.MailboxTTLHours default of 168h
	mailboxRetentionToleranceSeconds = int64(1)
)

func TestSaveEnvelopeRetentionNeverExceedsDeclaredLifetime(t *testing.T) {
	hourMS := int64(time.Hour / time.Millisecond)

	t.Run("declared lifetime shorter than the server cap", func(t *testing.T) {
		store, repo := newMailboxRepositoryForTest(t)
		nowMS := time.Now().UnixMilli()
		envelope := newRetentionTestEnvelope(
			"mailbox-f005-retention",
			"11111111-1111-4111-8111-111111111111",
			nowMS-1000,
			nowMS+hourMS,
		)

		if err := repo.SaveEnvelope(envelope); err != nil {
			t.Fatalf("SaveEnvelope() error = %v", err)
		}

		storedExpiry := storedEnvelopeExpirySeconds(t, store, envelope)
		declaredExpiry := envelope.ExpiresAtMs / 1000
		if storedExpiry == 0 {
			t.Fatalf("stored envelope has no physical expiry, want a deadline at %d", declaredExpiry)
		}
		if diff := storedExpiry - declaredExpiry; diff > mailboxRetentionToleranceSeconds || diff < -mailboxRetentionToleranceSeconds {
			t.Fatalf("stored retention deadline = %d, want %d (+/-%ds): physical retention must not exceed the envelope's declared lifetime (over-retained by %ds)",
				storedExpiry, declaredExpiry, mailboxRetentionToleranceSeconds, diff)
		}
	})

	t.Run("declared lifetime longer than the server cap", func(t *testing.T) {
		store, repo := newMailboxRepositoryForTest(t)
		nowMS := time.Now().UnixMilli()
		envelope := newRetentionTestEnvelope(
			"mailbox-f005-retention-cap",
			"22222222-2222-4222-8222-222222222222",
			nowMS-1000,
			nowMS+30*24*hourMS,
		)

		if err := repo.SaveEnvelope(envelope); err != nil {
			t.Fatalf("SaveEnvelope() error = %v", err)
		}

		storedExpiry := storedEnvelopeExpirySeconds(t, store, envelope)
		capDeadline := nowMS/1000 + mailboxServerRetentionCapSeconds
		if storedExpiry == 0 || storedExpiry > capDeadline+mailboxRetentionToleranceSeconds {
			t.Fatalf("stored retention deadline = %d, want at most the configured server cap %d",
				storedExpiry, capDeadline)
		}
	})

	t.Run("identical retry does not extend expiry", func(t *testing.T) {
		store, repo := newMailboxRepositoryForTest(t)
		nowMS := time.Now().UnixMilli()
		envelope := newRetentionTestEnvelope(
			"mailbox-f005-retention-retry",
			"33333333-3333-4333-8333-333333333333",
			nowMS-1000,
			nowMS+hourMS,
		)

		if err := repo.SaveEnvelope(envelope); err != nil {
			t.Fatalf("SaveEnvelope(first) error = %v", err)
		}
		firstExpiry := storedEnvelopeExpirySeconds(t, store, envelope)

		if err := repo.SaveEnvelope(envelope); err != nil {
			t.Fatalf("SaveEnvelope(identical retry) error = %v", err)
		}
		secondExpiry := storedEnvelopeExpirySeconds(t, store, envelope)

		declaredExpiry := envelope.ExpiresAtMs / 1000
		if secondExpiry > firstExpiry+mailboxRetentionToleranceSeconds {
			t.Fatalf("retention deadline after identical retry = %d, first save = %d: an identical retry must not extend expiry",
				secondExpiry, firstExpiry)
		}
		if secondExpiry > declaredExpiry+mailboxRetentionToleranceSeconds {
			t.Fatalf("retention deadline after identical retry = %d, want at most the declared expiry %d",
				secondExpiry, declaredExpiry)
		}
	})
}

func TestGetEnvelopesFiltersExpiredBeforeApplyingBatchLimit(t *testing.T) {
	store, repo := newMailboxRepositoryForTest(t)
	mailboxID := "mailbox-f005-batch"
	nowMS := time.Now().UnixMilli()
	hourMS := int64(time.Hour / time.Millisecond)

	// "00000000-..." sorts first inside the mailbox prefix, so an unfiltered
	// reader consumes the whole batch budget on a stale record.
	expired := newRetentionTestEnvelope(mailboxID, "00000000-0000-4000-8000-000000000001", nowMS-4*hourMS, nowMS-hourMS)
	valid := newRetentionTestEnvelope(mailboxID, "ffffffff-ffff-4fff-8fff-ffffffffffff", nowMS-1000, nowMS+hourMS)

	// Seeded directly: both records were written while still valid, and only the
	// first has since passed its declared expiry.
	seedStoredEnvelope(t, store, expired)
	seedStoredEnvelope(t, store, valid)

	batch, err := repo.GetEnvelopes(mailboxID, 1)
	if err != nil {
		t.Fatalf("GetEnvelopes(limit=1) error = %v", err)
	}
	if len(batch) != 1 {
		t.Fatalf("GetEnvelopes(limit=1) returned %d envelopes, want 1", len(batch))
	}
	if batch[0].EnvelopeID != valid.EnvelopeID {
		t.Fatalf("GetEnvelopes(limit=1) returned envelope %q, want %q: expired records must be filtered before the batch limit is applied",
			batch[0].EnvelopeID, valid.EnvelopeID)
	}

	full, err := repo.GetEnvelopes(mailboxID, 10)
	if err != nil {
		t.Fatalf("GetEnvelopes(limit=10) error = %v", err)
	}
	if len(full) != 1 {
		t.Fatalf("GetEnvelopes(limit=10) returned %d envelopes, want 1 (expired records must not be delivered)", len(full))
	}
	if full[0].EnvelopeID != valid.EnvelopeID {
		t.Fatalf("GetEnvelopes(limit=10) returned envelope %q, want %q", full[0].EnvelopeID, valid.EnvelopeID)
	}
}

// TestGetEnvelopeBatchFiltersExpiredBeforeApplyingBatchLimit is the F-005 (c) regression on the
// PRODUCTION poll path (review finding T38-TP-002).
//
// TestGetEnvelopesFiltersExpiredBeforeApplyingBatchLimit above pins GetEnvelopes, which has no
// production caller: /v1/mailbox/poll reaches GetEnvelopeBatch (mailbox_handler.go:252 ->
// mailbox_service.go -> mailbox_repo.go:153). Removing the ExpiresAtMs skip from GetEnvelopeBatch
// therefore left `go test ./...` green, so the expiry filter that actually serves polls was
// unprotected.
//
// Ciphertext values are synthetic padding and are never printed.
func TestGetEnvelopeBatchFiltersExpiredBeforeApplyingBatchLimit(t *testing.T) {
	store, repo := newMailboxRepositoryForTest(t)
	mailboxID := "mailbox-t38tp002-batch"
	nowMS := time.Now().UnixMilli()
	hourMS := int64(time.Hour / time.Millisecond)

	// "00000000-..." sorts first inside the mailbox prefix, so an unfiltered reader consumes the
	// whole batch budget on a stale record - exactly the wedge F-005 (c) is about.
	expired := newRetentionTestEnvelope(mailboxID, "00000000-0000-4000-8000-000000000001", nowMS-4*hourMS, nowMS-hourMS)
	valid := newRetentionTestEnvelope(mailboxID, "ffffffff-ffff-4fff-8fff-ffffffffffff", nowMS-1000, nowMS+hourMS)

	// Seeded directly: both records were written while still valid, and only the first has since
	// passed its declared expiry.
	seedStoredEnvelope(t, store, expired)
	seedStoredEnvelope(t, store, valid)

	// A batch limit of one is the sharpest form of the defect: the single slot must go to the
	// envelope that is still deliverable.
	batch, err := repo.GetEnvelopeBatch(mailboxID, 1, 0)
	if err != nil {
		t.Fatalf("GetEnvelopeBatch(limit=1) error = %v", err)
	}
	if len(batch.Envelopes) != 1 {
		t.Fatalf("GetEnvelopeBatch(limit=1) returned %d envelopes, want 1", len(batch.Envelopes))
	}
	if batch.Envelopes[0].EnvelopeID != valid.EnvelopeID {
		t.Fatalf("GetEnvelopeBatch(limit=1) returned envelope %q, want %q: expired records must be skipped before the batch limit is consumed",
			batch.Envelopes[0].EnvelopeID, valid.EnvelopeID)
	}
	if batch.HasMore {
		t.Fatalf("GetEnvelopeBatch(limit=1) reported HasMore = true, want false: an expired record left behind is not remaining work")
	}

	// And with room to spare, the expired record must not be delivered at all.
	full, err := repo.GetEnvelopeBatch(mailboxID, 10, 0)
	if err != nil {
		t.Fatalf("GetEnvelopeBatch(limit=10) error = %v", err)
	}
	if len(full.Envelopes) != 1 {
		t.Fatalf("GetEnvelopeBatch(limit=10) returned %d envelopes, want 1 (expired records must never be delivered)", len(full.Envelopes))
	}
	if full.Envelopes[0].EnvelopeID != valid.EnvelopeID {
		t.Fatalf("GetEnvelopeBatch(limit=10) returned envelope %q, want %q", full.Envelopes[0].EnvelopeID, valid.EnvelopeID)
	}

	// The byte budget must not resurrect the expired record either: expiry is applied before
	// either bound, so a budget that admits exactly one envelope still admits the valid one.
	budgeted, err := repo.GetEnvelopeBatch(mailboxID, 10, 1)
	if err != nil {
		t.Fatalf("GetEnvelopeBatch(byteBudget=1) error = %v", err)
	}
	if len(budgeted.Envelopes) != 1 || budgeted.Envelopes[0].EnvelopeID != valid.EnvelopeID {
		t.Fatalf("GetEnvelopeBatch(byteBudget=1) returned %d envelopes (first %q), want exactly the valid envelope %q",
			len(budgeted.Envelopes), firstEnvelopeID(budgeted.Envelopes), valid.EnvelopeID)
	}
}

func firstEnvelopeID(envelopes []*model.MailboxEnvelope) string {
	if len(envelopes) == 0 {
		return ""
	}
	return envelopes[0].EnvelopeID
}

func newMailboxRepositoryForTest(t *testing.T) (*storage.Storage, *MailboxRepository) {
	t.Helper()
	store, err := storage.NewStorage(t.TempDir())
	if err != nil {
		t.Fatalf("NewStorage() error = %v", err)
	}
	t.Cleanup(func() { _ = store.Close() })
	return store, NewMailboxRepository(store)
}

func newRetentionTestEnvelope(mailboxID, envelopeID string, createdAtMs, expiresAtMs int64) *model.MailboxEnvelope {
	ciphertext := "RkZGRkZGRkZGRkZG"
	return &model.MailboxEnvelope{
		Type:                "mailbox_envelope",
		Version:             1,
		EnvelopeID:          envelopeID,
		MessageID:           "4c3d2e1f-0a9b-4c8d-9e7f-6a5b4c3d2e1f",
		SenderIdentityID:    "sender-identity",
		SenderDeviceID:      "7319a570-67c7-4c8b-bb0b-4dcdf41de5ec",
		RecipientIdentityID: "recipient-identity",
		RecipientDeviceID:   "8cc8010b-d4a1-4ce7-8203-a8f6b055c1b9",
		RecipientMailboxID:  mailboxID,
		PayloadType:         "ciphertext_message",
		Ciphertext:          ciphertext,
		CreatedAtMs:         createdAtMs,
		ExpiresAtMs:         expiresAtMs,
		SizeBytes:           int64(len(ciphertext)),
	}
}

// storedEnvelopeExpirySeconds reads the physical retention deadline Badger holds
// for a stored envelope, in Unix seconds (0 when no TTL was set).
func storedEnvelopeExpirySeconds(t *testing.T, store *storage.Storage, envelope *model.MailboxEnvelope) int64 {
	t.Helper()
	var expiresAt uint64
	err := store.DB().View(func(txn *badger.Txn) error {
		item, err := txn.Get(mailboxEnvelopeKeyForTest(envelope))
		if err != nil {
			return err
		}
		expiresAt = item.ExpiresAt()
		return nil
	})
	if err != nil {
		t.Fatalf("read stored envelope %q: %v", envelope.EnvelopeID, err)
	}
	return int64(expiresAt)
}

// seedStoredEnvelope writes an envelope with a long physical TTL, simulating a
// record accepted while valid whose declared lifetime has since elapsed.
func seedStoredEnvelope(t *testing.T, store *storage.Storage, envelope *model.MailboxEnvelope) {
	t.Helper()
	data, err := json.Marshal(envelope)
	if err != nil {
		t.Fatalf("json.Marshal(envelope) error = %v", err)
	}
	err = store.DB().Update(func(txn *badger.Txn) error {
		return txn.SetEntry(badger.NewEntry(mailboxEnvelopeKeyForTest(envelope), data).WithTTL(30 * 24 * time.Hour))
	})
	if err != nil {
		t.Fatalf("seed stored envelope %q: %v", envelope.EnvelopeID, err)
	}
}

func mailboxEnvelopeKeyForTest(envelope *model.MailboxEnvelope) []byte {
	return []byte(fmt.Sprintf("mailbox:%s:%s", envelope.RecipientMailboxID, envelope.EnvelopeID))
}
