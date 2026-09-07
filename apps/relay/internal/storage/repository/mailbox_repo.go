package repository

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"time"

	"echolet/apps/relay/internal/model"
	"echolet/apps/relay/internal/storage"

	"github.com/dgraph-io/badger/v4"
)

// DefaultMailboxRetentionCap mirrors config.MailboxTTLHours (168h). It is the
// upper bound on how long the relay keeps an envelope, regardless of the
// lifetime the envelope itself declares.
const DefaultMailboxRetentionCap = 7 * 24 * time.Hour

// mailboxSaveConflictRetries bounds how often an optimistic transaction is
// replayed after badger reports a write conflict on the same envelope key.
const mailboxSaveConflictRetries = 64

type MailboxRepository struct {
	db           *badger.DB
	retentionCap time.Duration
	now          func() time.Time
}

func NewMailboxRepository(s *storage.Storage) *MailboxRepository {
	return &MailboxRepository{
		db:           s.DB(),
		retentionCap: DefaultMailboxRetentionCap,
		now:          time.Now,
	}
}

// SetRetentionCap applies the server-configured retention cap. Non-positive
// values keep the default, so an unconfigured Config cannot silently reduce
// retention to zero.
func (r *MailboxRepository) SetRetentionCap(retentionCap time.Duration) {
	if retentionCap <= 0 {
		return
	}
	r.retentionCap = retentionCap
}

// SaveEnvelope stores an envelope under an immutable (recipient mailbox,
// envelope_id) pair.
//
// The existing record is read inside the same transaction: a byte-identical
// replay is a no-op (idempotent, and it never extends the retention deadline),
// and a different body under an already-used pair is refused with
// model.ErrEnvelopeIDConflict without replacing the stored envelope.
func (r *MailboxRepository) SaveEnvelope(envelope *model.MailboxEnvelope) error {
	data, err := json.Marshal(envelope)
	if err != nil {
		return err
	}

	key := mailboxEnvelopeKey(envelope.RecipientMailboxID, envelope.EnvelopeID)
	expiresAt := r.retentionDeadlineSeconds(envelope)

	return r.update(func(txn *badger.Txn) error {
		item, err := txn.Get(key)
		switch {
		case err == nil:
			stored, valueErr := item.ValueCopy(nil)
			if valueErr != nil {
				return valueErr
			}
			if bytes.Equal(stored, data) {
				// Idempotent replay: leave the accepted record and its
				// retention deadline exactly as they are.
				return nil
			}
			return model.ErrEnvelopeIDConflict
		case errors.Is(err, badger.ErrKeyNotFound):
			// Not stored yet.
		default:
			return err
		}

		entry := badger.NewEntry(key, data)
		entry.ExpiresAt = expiresAt
		return txn.SetEntry(entry)
	})
}

// GetEnvelopes returns up to limit envelopes that have not passed their declared
// expiry. Expired records are skipped BEFORE the batch limit is consumed, so a
// stale envelope can never wedge delivery of newer valid ones.
func (r *MailboxRepository) GetEnvelopes(mailboxID string, limit int) ([]*model.MailboxEnvelope, error) {
	envelopes := make([]*model.MailboxEnvelope, 0)
	if limit <= 0 {
		return envelopes, nil
	}

	nowMS := r.now().UnixMilli()

	err := r.db.View(func(txn *badger.Txn) error {
		prefix := []byte(fmt.Sprintf("mailbox:%s:", mailboxID))
		opts := badger.DefaultIteratorOptions
		opts.PrefetchSize = limit
		it := txn.NewIterator(opts)
		defer it.Close()

		count := 0
		for it.Seek(prefix); it.ValidForPrefix(prefix) && count < limit; it.Next() {
			item := it.Item()
			err := item.Value(func(val []byte) error {
				var envelope *model.MailboxEnvelope
				if err := json.Unmarshal(val, &envelope); err != nil {
					return err
				}
				if envelope == nil || envelope.ExpiresAtMs <= nowMS {
					return nil
				}
				envelopes = append(envelopes, envelope)
				count++
				return nil
			})
			if err != nil {
				return err
			}
		}
		return nil
	})

	return envelopes, err
}

// SenderMailboxOccupancy is what one sender currently occupies in one recipient
// mailbox, as the per-sender quota (T53, finding T52-F-001) needs to see it.
type SenderMailboxOccupancy struct {
	// LiveEnvelopes counts the envelopes this sender holds in this mailbox that
	// have NOT passed their declared expiry - the same predicate GetEnvelopes and
	// GetEnvelopeBatchFrom apply, so the number always means "envelopes this
	// sender is still occupying the recipient's drain walk with". It is capped at
	// the caller's countLimit; a caller only ever asks whether the quota is
	// reached, never how far past it the mailbox is.
	LiveEnvelopes int
	// EnvelopeAlreadyStored reports that this (mailbox, envelope_id) pair is
	// already taken. Storing under a pair that already exists can only be an
	// idempotent replay (a no-op) or an ENVELOPE_ID_CONFLICT (refused), so it can
	// never increase occupancy and must never be charged against the quota: that
	// is what keeps F-004's exact retry available to a sender sitting exactly at
	// its allowance.
	EnvelopeAlreadyStored bool
}

// SenderOccupancy reports the standing occupancy of mailboxID by
// senderIdentityID, and whether envelopeID is already stored there.
//
// It is deliberately computed by scanning the mailbox rather than kept as a
// counter incremented on send and decremented on ack. An envelope also leaves a
// mailbox by simply passing its expiry, with nobody acknowledging anything - the
// normal outcome when the recipient is offline - and a send/ack counter never
// learns about that, so it would silence a legitimate sender permanently.
//
// The scan is bounded twice over, because its cost is otherwise chosen by the
// caller of the send route: an already-stored envelope_id returns immediately
// without scanning at all, and counting stops as soon as countLimit is reached,
// so the work per send is O(quota) plus the expired and other-sender records the
// iterator walks past.
func (r *MailboxRepository) SenderOccupancy(mailboxID, senderIdentityID, envelopeID string, countLimit int) (SenderMailboxOccupancy, error) {
	occupancy := SenderMailboxOccupancy{}
	nowMS := r.now().UnixMilli()

	err := r.db.View(func(txn *badger.Txn) error {
		switch _, err := txn.Get(mailboxEnvelopeKey(mailboxID, envelopeID)); {
		case err == nil:
			occupancy.EnvelopeAlreadyStored = true
			return nil
		case errors.Is(err, badger.ErrKeyNotFound):
			// Not stored yet, so this envelope would occupy a new slot.
		default:
			return err
		}

		prefix := []byte(fmt.Sprintf("mailbox:%s:", mailboxID))
		opts := badger.DefaultIteratorOptions
		it := txn.NewIterator(opts)
		defer it.Close()

		for it.Seek(prefix); it.ValidForPrefix(prefix); it.Next() {
			if countLimit > 0 && occupancy.LiveEnvelopes >= countLimit {
				return nil
			}
			err := it.Item().Value(func(val []byte) error {
				var envelope *model.MailboxEnvelope
				if err := json.Unmarshal(val, &envelope); err != nil {
					return err
				}
				if envelope == nil || envelope.ExpiresAtMs <= nowMS {
					return nil
				}
				if envelope.SenderIdentityID != senderIdentityID {
					return nil
				}
				occupancy.LiveEnvelopes++
				return nil
			})
			if err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		return SenderMailboxOccupancy{}, err
	}

	return occupancy, nil
}

// EnvelopeBatch is one bounded mailbox selection: the envelopes chosen for this
// response plus whether the mailbox still holds undelivered envelopes that the
// bounds withheld.
type EnvelopeBatch struct {
	Envelopes []*model.MailboxEnvelope
	// HasMore reports that selection stopped on a bound rather than on the end
	// of the mailbox, so the caller must poll again to make progress.
	HasMore bool
	// NextCursor is the server-issued position to resume this walk from, and is
	// non-empty exactly when HasMore. It is produced here rather than by the
	// handler so that the position and its encoding stay in one place, and it is
	// derived only from a count the server computed - never from any stored
	// envelope field, so a sender can neither influence its size nor its value.
	NextCursor string
}

// maxMailboxCursorDigits bounds an accepted continuation token. The encoding is
// decimal, so 15 digits is far above any mailbox the retention cap can hold and
// small enough that parsing is trivially bounded.
const maxMailboxCursorDigits = 15

// encodeMailboxCursor renders a resume position as the opaque token the client
// echoes back. Clients must not interpret it; the decimal encoding is an
// implementation detail of this file.
func encodeMailboxCursor(position int) string {
	return strconv.Itoa(position)
}

// decodeMailboxCursor reads a continuation token previously issued by
// encodeMailboxCursor. An empty token means "start at the head of the mailbox".
// Anything else that is not a token this relay could have issued is refused with
// model.ErrInvalidMailboxCursor rather than being silently treated as position
// zero, which would turn a client bug into an invisible replay of page one.
func decodeMailboxCursor(cursor string) (int, error) {
	if cursor == "" {
		return 0, nil
	}
	if len(cursor) > maxMailboxCursorDigits {
		return 0, model.ErrInvalidMailboxCursor
	}
	for _, digit := range cursor {
		if digit < '0' || digit > '9' {
			return 0, model.ErrInvalidMailboxCursor
		}
	}
	position, err := strconv.Atoi(cursor)
	if err != nil || position < 0 {
		return 0, model.ErrInvalidMailboxCursor
	}
	return position, nil
}

// GetEnvelopeBatch selects a batch from the head of the mailbox. It is
// GetEnvelopeBatchFrom with no cursor; the cursor-aware form is the real
// implementation and the only one the poll route uses.
func (r *MailboxRepository) GetEnvelopeBatch(mailboxID string, limit int, byteBudget int64) (EnvelopeBatch, error) {
	return r.GetEnvelopeBatchFrom(mailboxID, limit, byteBudget, "")
}

// GetEnvelopeBatchFrom selects up to limit non-expired envelopes whose combined
// encoded size stays within byteBudget, resuming at a server-issued cursor.
//
// Both bounds are applied during selection, not afterwards, so an oversized
// batch is never materialized. The byte budget is deliberately allowed to be
// exceeded by the FIRST envelope only: a single envelope at the configured
// maximum message size must still be delivered, otherwise the largest legal
// message would wedge the mailbox forever. A non-positive byteBudget means "no
// byte bound", leaving limit as the only constraint.
//
// The cursor is a real resume position, not a "there is more" flag: it is the
// number of undelivered envelopes this walk has already handed out, so the scan
// skips exactly those and continues past them. Without it every call re-selects
// from the head of the prefix, and because a permanently rejected envelope is
// deliberately never acknowledged, an unauthenticated sender who fills one
// selection window monopolises it forever and the legitimate envelopes behind it
// are never delivered (round-2 finding R2-001 path B).
//
// A position is used rather than the last key returned because the key's second
// half is the sender-supplied envelope_id: a cursor derived from it would put an
// attacker-chosen string back on the wire, which is the constraint the original
// F-009 fix imposed and which still holds. Acknowledging or expiring an envelope
// between two pages of one walk shifts later positions by one, which can skip or
// repeat a single envelope; a skipped envelope is offered again by the next poll,
// because a walk always restarts at the head, and a repeated one is idempotent at
// the client (cli:inbox: dedupe). Nothing is dropped.
func (r *MailboxRepository) GetEnvelopeBatchFrom(mailboxID string, limit int, byteBudget int64, cursor string) (EnvelopeBatch, error) {
	batch := EnvelopeBatch{Envelopes: make([]*model.MailboxEnvelope, 0)}

	position, err := decodeMailboxCursor(cursor)
	if err != nil {
		return batch, err
	}
	if limit <= 0 {
		return batch, nil
	}

	nowMS := r.now().UnixMilli()
	var usedBytes int64

	err = r.db.View(func(txn *badger.Txn) error {
		prefix := []byte(fmt.Sprintf("mailbox:%s:", mailboxID))
		opts := badger.DefaultIteratorOptions
		opts.PrefetchSize = limit
		it := txn.NewIterator(opts)
		defer it.Close()

		remaining := position
		for it.Seek(prefix); it.ValidForPrefix(prefix); it.Next() {
			stop := false
			err := it.Item().Value(func(val []byte) error {
				var envelope *model.MailboxEnvelope
				if err := json.Unmarshal(val, &envelope); err != nil {
					return err
				}
				// Expired records are skipped before either bound is consumed
				// and before the cursor is consumed, so a stale envelope can
				// never wedge delivery of newer ones and can never shift the
				// resume position.
				if envelope == nil || envelope.ExpiresAtMs <= nowMS {
					return nil
				}
				// Already handed to this walk on an earlier page.
				if remaining > 0 {
					remaining--
					return nil
				}
				if len(batch.Envelopes) >= limit {
					batch.HasMore = true
					stop = true
					return nil
				}
				// The stored value is the envelope's own JSON encoding, so its
				// length is exactly what this envelope contributes to the
				// response body.
				encodedBytes := int64(len(val)) + envelopeSeparatorBytes
				if byteBudget > 0 && len(batch.Envelopes) > 0 && usedBytes+encodedBytes > byteBudget {
					batch.HasMore = true
					stop = true
					return nil
				}
				usedBytes += encodedBytes
				batch.Envelopes = append(batch.Envelopes, envelope)
				return nil
			})
			if err != nil {
				return err
			}
			if stop {
				return nil
			}
		}
		return nil
	})
	if err != nil {
		return EnvelopeBatch{Envelopes: make([]*model.MailboxEnvelope, 0)}, err
	}

	if batch.HasMore {
		batch.NextCursor = encodeMailboxCursor(position + len(batch.Envelopes))
	}

	return batch, nil
}

// envelopeSeparatorBytes accounts for the comma each additional array element
// adds to the encoded response.
const envelopeSeparatorBytes = 1

func (r *MailboxRepository) DeleteEnvelope(mailboxID, envelopeID string) error {
	return r.update(func(txn *badger.Txn) error {
		return txn.Delete(mailboxEnvelopeKey(mailboxID, envelopeID))
	})
}

// retentionDeadlineSeconds returns the physical retention deadline in Unix
// seconds: never later than the envelope's own declared expiry, never later
// than the configured server cap, and never zero (which badger reads as "keep
// forever").
func (r *MailboxRepository) retentionDeadlineSeconds(envelope *model.MailboxEnvelope) uint64 {
	now := r.now()
	deadline := envelope.ExpiresAtMs / 1000

	if capDeadline := now.Add(r.retentionCap).Unix(); deadline > capDeadline {
		deadline = capDeadline
	}
	if floor := now.Unix(); deadline < floor {
		// Already past its declared lifetime: store it as immediately expired
		// rather than as a record without any deadline at all.
		deadline = floor
	}
	if deadline < 0 {
		deadline = 0
	}

	return uint64(deadline)
}

// update replays the transaction while badger reports an optimistic write
// conflict on the keys it touched.
func (r *MailboxRepository) update(fn func(*badger.Txn) error) error {
	var err error
	for attempt := 0; attempt < mailboxSaveConflictRetries; attempt++ {
		err = r.db.Update(fn)
		if !errors.Is(err, badger.ErrConflict) {
			return err
		}
	}
	return err
}

func mailboxEnvelopeKey(mailboxID, envelopeID string) []byte {
	return []byte(fmt.Sprintf("mailbox:%s:%s", mailboxID, envelopeID))
}
