package repository

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"hash/fnv"
	"strconv"
	"sync"
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

// mailboxOrderingStripes is how many mutexes serialize per-mailbox sequence
// allocation and ordering backfill. Striping rather than a map of locks keeps the
// lock set bounded: a mailbox id is attacker-choosable (it is a digest of a
// self-published identity), so a lock PER mailbox would be unbounded state grown
// by unauthenticated traffic - exactly the shape of defect finding T5-F-002
// records elsewhere. Different mailboxes may share a stripe; the only cost is
// that two unrelated sends briefly serialize.
const mailboxOrderingStripes = 256

type MailboxRepository struct {
	db           *badger.DB
	retentionCap time.Duration
	now          func() time.Time
	// ordering serializes sequence allocation and the one-shot backfill for one
	// mailbox. Badger's optimistic transactions would also detect the conflict on
	// the counter key and r.update would replay it, but under the concurrency a
	// flooded mailbox actually sees that degenerates into a retry storm; the lock
	// makes allocation contention-free and the retry loop the backstop it was.
	ordering [mailboxOrderingStripes]sync.Mutex
}

func NewMailboxRepository(s *storage.Storage) *MailboxRepository {
	return &MailboxRepository{
		db:           s.DB(),
		retentionCap: DefaultMailboxRetentionCap,
		now:          time.Now,
	}
}

// lockMailboxOrdering serializes sequence allocation for one mailbox and returns
// the matching unlock.
func (r *MailboxRepository) lockMailboxOrdering(mailboxID string) func() {
	digest := fnv.New32a()
	_, _ = digest.Write([]byte(mailboxID))
	lock := &r.ordering[digest.Sum32()%mailboxOrderingStripes]
	lock.Lock()
	return lock.Unlock
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
// envelope_id) pair, and gives it a RELAY-ASSIGNED position in that mailbox.
//
// The existing record is read inside the same transaction: a byte-identical
// replay is a no-op (idempotent, and it never extends the retention deadline, and
// it allocates no new position so an exact retry never moves the envelope in the
// recipient's queue), and a different body under an already-used pair is refused
// with model.ErrEnvelopeIDConflict without replacing the stored envelope.
//
// The position is written to the ordering side index described at
// mailboxOrderKey. It is what makes the SELECTION order the relay's rather than
// the sender's: finding T5-F-001 measured that the primary key's second half is
// the sender-supplied envelope_id, that validation admits ~10^28 identifiers
// sorting ahead of every random v4 UUID the CLI mints, and that a sender could
// therefore place an envelope in front of one the mailbox ALREADY held.
func (r *MailboxRepository) SaveEnvelope(envelope *model.MailboxEnvelope) error {
	data, err := json.Marshal(envelope)
	if err != nil {
		return err
	}

	mailboxID := envelope.RecipientMailboxID
	key := mailboxEnvelopeKey(mailboxID, envelope.EnvelopeID)
	expiresAt := r.retentionDeadlineSeconds(envelope)

	unlock := r.lockMailboxOrdering(mailboxID)
	defer unlock()

	// Records written before this relay assigned positions (or by any path other
	// than this one) must become selectable, not invisible. See
	// ensureMailboxOrderingLocked.
	if err := r.ensureMailboxOrderingLocked(mailboxID); err != nil {
		return err
	}

	return r.update(func(txn *badger.Txn) error {
		item, err := txn.Get(key)
		switch {
		case err == nil:
			stored, valueErr := item.ValueCopy(nil)
			if valueErr != nil {
				return valueErr
			}
			if bytes.Equal(stored, data) {
				// Idempotent replay: leave the accepted record, its retention
				// deadline and its position exactly as they are.
				return nil
			}
			return model.ErrEnvelopeIDConflict
		case errors.Is(err, badger.ErrKeyNotFound):
			// Not stored yet.
		default:
			return err
		}

		position, err := allocateMailboxPosition(txn, mailboxID)
		if err != nil {
			return err
		}

		entry := badger.NewEntry(key, data)
		entry.ExpiresAt = expiresAt
		if err := txn.SetEntry(entry); err != nil {
			return err
		}

		// The index entry carries the same physical deadline as the record it
		// points at, so it cannot outlive it. A dangling entry is skipped lazily
		// at selection anyway (GetEnvelopeBatchFrom), which is what covers the
		// other direction: an acknowledged envelope is deleted by primary key.
		orderEntry := badger.NewEntry(mailboxOrderKey(mailboxID, position), []byte(envelope.EnvelopeID))
		orderEntry.ExpiresAt = expiresAt
		return txn.SetEntry(orderEntry)
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
	// NextCursor is the server-issued position to resume this walk STRICTLY
	// AFTER, and is non-empty exactly when HasMore. It is produced here rather
	// than by the handler so that the position and its encoding stay in one
	// place, and it is derived only from a position the server assigned - never
	// from any stored envelope field, so a sender can neither influence its size
	// nor its value.
	NextCursor string
}

// maxMailboxCursorDigits bounds an accepted continuation token. The encoding is
// decimal, so 15 digits is far above any mailbox the retention cap can hold and
// small enough that parsing is trivially bounded.
const maxMailboxCursorDigits = 15

// encodeMailboxCursor renders a resume position as the opaque token the client
// echoes back. Clients must not interpret it; the decimal encoding is an
// implementation detail of this file.
func encodeMailboxCursor(position uint64) string {
	return strconv.FormatUint(position, 10)
}

// DecodeMailboxCursor reads a continuation token previously issued by
// encodeMailboxCursor, and yields the position the caller must resume STRICTLY
// AFTER. An empty token means "start at the head of the mailbox", which is the
// same as position zero because positions start at one.
//
// Anything else that is not a token this relay could have issued is refused with
// model.ErrInvalidMailboxCursor rather than being silently treated as position
// zero, which would turn a client bug into an invisible replay of page one - and,
// now that a cursorless poll resumes at the recipient's stored read position,
// into an invisible SKIP if the same rule were relaxed for read_through.
//
// Exported because the ack and poll routes apply the identical rule to
// read_through: one shape rule for every opaque position this relay issues.
func DecodeMailboxCursor(cursor string) (uint64, error) {
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
	position, err := strconv.ParseUint(cursor, 10, 64)
	if err != nil {
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
// relay-assigned position of the last envelope handed out, and the scan resumes
// STRICTLY AFTER it. Without it every call re-selects from the head of the
// prefix, and because a permanently rejected envelope is deliberately never
// acknowledged, an unauthenticated sender who fills one selection window
// monopolises it forever and the legitimate envelopes behind it are never
// delivered (round-2 finding R2-001 path B).
//
// Why "strictly after a position" and not "skip this many"
// --------------------------------------------------------
// The previous encoding was a COUNT of envelopes already handed out, and it
// documented its own defect: an envelope that leaves the mailbox between two
// pages of one walk shifts every later position by one, so an envelope is
// SKIPPED. That was survivable only while every walk restarted at the head, which
// is exactly the property design C4-2 removes - once a cursorless poll resumes at
// the recipient's stored mark, a skipped envelope is skipped for good. Acking
// between pages is not a corner case: it is what the client does on every page
// that yields anything.
//
// The position is still never derived from any sender-supplied value. The
// envelope_id stays out of the cursor, which is the constraint the original F-009
// fix imposed and which still holds; the position is assigned by SaveEnvelope.
//
// Selection walks the ORDERING INDEX, not the primary prefix, so the order is the
// relay's (finding T5-F-001). An index entry whose primary record is gone -
// acknowledged, or expired out from under it - is skipped lazily, the same shape
// as the expired-record skip, and it does not consume a bound.
func (r *MailboxRepository) GetEnvelopeBatchFrom(mailboxID string, limit int, byteBudget int64, cursor string) (EnvelopeBatch, error) {
	batch := EnvelopeBatch{Envelopes: make([]*model.MailboxEnvelope, 0)}

	resumeAfter, err := DecodeMailboxCursor(cursor)
	if err != nil {
		return batch, err
	}
	if limit <= 0 {
		return batch, nil
	}

	// Records written before this relay assigned positions are backfilled here as
	// well as on the store path, so a mailbox that predates the index is ordered
	// rather than invisible.
	unlock := r.lockMailboxOrdering(mailboxID)
	err = r.ensureMailboxOrderingLocked(mailboxID)
	unlock()
	if err != nil {
		return batch, err
	}

	nowMS := r.now().UnixMilli()
	var usedBytes int64
	var lastPosition uint64

	err = r.db.View(func(txn *badger.Txn) error {
		prefix := mailboxOrderPrefix(mailboxID)
		opts := badger.DefaultIteratorOptions
		opts.PrefetchSize = limit
		it := txn.NewIterator(opts)
		defer it.Close()

		// resumeAfter+1 cannot overflow: the token is bounded to
		// maxMailboxCursorDigits decimal digits, far below the uint64 ceiling.
		for it.Seek(mailboxOrderKey(mailboxID, resumeAfter+1)); it.ValidForPrefix(prefix); it.Next() {
			item := it.Item()
			position, err := decodeMailboxPosition(item.Key()[len(prefix):])
			if err != nil {
				// An index key this relay could not have written. Skipping it is
				// the only safe reading: it addresses no envelope.
				continue
			}
			envelopeID, err := item.ValueCopy(nil)
			if err != nil {
				return err
			}

			record, err := txn.Get(mailboxEnvelopeKey(mailboxID, string(envelopeID)))
			if errors.Is(err, badger.ErrKeyNotFound) {
				// Acknowledged or expired out from under its index entry.
				continue
			}
			if err != nil {
				return err
			}

			stop := false
			if err := record.Value(func(val []byte) error {
				var envelope *model.MailboxEnvelope
				if err := json.Unmarshal(val, &envelope); err != nil {
					return err
				}
				// Expired records are skipped before either bound is consumed
				// and before the resume position moves, so a stale envelope can
				// never wedge delivery of newer ones and can never carry the
				// recipient's read position past a valid envelope.
				if envelope == nil || envelope.ExpiresAtMs <= nowMS {
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
				lastPosition = position
				return nil
			}); err != nil {
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
		batch.NextCursor = encodeMailboxCursor(lastPosition)
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

// ---------------------------------------------------------------------------
// The ordering side index (design C4-1)
// ---------------------------------------------------------------------------
//
// mailboxseq:<mailbox_id>:<20-digit zero-padded position> -> <envelope_id>
//
// Deliberately a SIDE index and not a change to mailboxEnvelopeKey. The primary
// record has to stay at mailbox:<mailbox_id>:<envelope_id> because that layout is
// hard-coded by mailbox_repo_test.go's mailboxEnvelopeKeyForTest, and because
// keeping it preserves - unchanged and untested-by-implication - the idempotent
// byte-identical replay comparison, ENVELOPE_ID_CONFLICT, SenderOccupancy's O(1)
// already-stored check, DeleteEnvelope's addressing by (mailbox, envelope_id),
// the retention deadline, and GetEnvelopes.
//
// The padding is decimal and fixed-width so Badger's byte order over the index IS
// numeric order. Twenty digits covers every uint64.
//
// Nothing about the position reaches model.MailboxEnvelope: the client parses
// poll responses under MailboxEnvelopeSchema.strict(), so a new field on the
// envelope would be refused by every client. The position lives only here and in
// the cursor.
const mailboxOrderPositionDigits = 20

func mailboxOrderPrefix(mailboxID string) []byte {
	return []byte(fmt.Sprintf("mailboxseq:%s:", mailboxID))
}

func mailboxOrderKey(mailboxID string, position uint64) []byte {
	return []byte(fmt.Sprintf("mailboxseq:%s:%0*d", mailboxID, mailboxOrderPositionDigits, position))
}

// mailboxSequenceKey holds the next position this mailbox will allocate.
//
// Its ABSENCE is also the migration marker: a mailbox that holds primary records
// but has never allocated a position predates the ordering index, and its records
// would be invisible to an index-only selection. Note the trailing key shape -
// "mailboxseqnext:" is not a prefix of "mailboxseq:<id>:", so the counter can
// never be walked as if it were an index entry.
func mailboxSequenceKey(mailboxID string) []byte {
	return []byte(fmt.Sprintf("mailboxseqnext:%s", mailboxID))
}

// mailboxReadMarkKey holds one recipient DEVICE's durable read position in one
// mailbox: the highest position that device has judged - committed or permanently
// refused. It is per device, not per mailbox, because two devices of the same
// identity drain independently.
func mailboxReadMarkKey(mailboxID, deviceID string) []byte {
	return []byte(fmt.Sprintf("mailboxmark:%s:%s", mailboxID, deviceID))
}

func decodeMailboxPosition(raw []byte) (uint64, error) {
	return strconv.ParseUint(string(raw), 10, 64)
}

func encodeMailboxPosition(position uint64) []byte {
	return []byte(strconv.FormatUint(position, 10))
}

// readMailboxSequence returns the next position this mailbox will allocate, and
// whether the counter exists at all.
func readMailboxSequence(txn *badger.Txn, mailboxID string) (uint64, bool, error) {
	item, err := txn.Get(mailboxSequenceKey(mailboxID))
	switch {
	case errors.Is(err, badger.ErrKeyNotFound):
		return 0, false, nil
	case err != nil:
		return 0, false, err
	}
	raw, err := item.ValueCopy(nil)
	if err != nil {
		return 0, false, err
	}
	next, err := decodeMailboxPosition(raw)
	if err != nil {
		return 0, false, err
	}
	return next, true, nil
}

// allocateMailboxPosition hands out the next position and advances the counter
// inside the caller's transaction. Positions start at 1, so position 0 is
// available as "before everything", which is what an absent cursor and an
// unset read mark both mean.
func allocateMailboxPosition(txn *badger.Txn, mailboxID string) (uint64, error) {
	next, exists, err := readMailboxSequence(txn, mailboxID)
	if err != nil {
		return 0, err
	}
	if !exists || next == 0 {
		next = 1
	}
	if err := txn.Set(mailboxSequenceKey(mailboxID), encodeMailboxPosition(next+1)); err != nil {
		return 0, err
	}
	return next, nil
}

// mailboxBackfillBatch bounds one backfill transaction. A migration of an
// existing relay's mailbox can be arbitrarily large and a Badger transaction
// cannot; the batches are idempotent (the same records in the same key order
// receive the same positions) and the counter is written LAST, so an interrupted
// backfill is simply retried on the next call rather than half-applied.
const mailboxBackfillBatch = 512

// ensureMailboxOrderingLocked gives every primary record in a mailbox a position
// if the mailbox has never allocated one. The caller must hold the mailbox's
// ordering lock.
//
// This is the migration step the design's section 5 names, and it is also a
// correctness requirement inside this tree: TestGetEnvelopeBatchFiltersExpired-
// BeforeApplyingBatchLimit (the T38-TP-002 regression on the production poll
// path) seeds raw primary keys and then drives GetEnvelopeBatch, and that file
// may not be edited. Records that exist only under the primary key must be
// selectable, or an index-only selection makes an existing relay's entire mailbox
// undeliverable rather than merely unordered.
//
// It runs on the READ path as well as before every store, so a record written by
// any other path is still selectable.
func (r *MailboxRepository) ensureMailboxOrderingLocked(mailboxID string) error {
	var needed bool
	if err := r.db.View(func(txn *badger.Txn) error {
		_, exists, err := readMailboxSequence(txn, mailboxID)
		needed = !exists
		return err
	}); err != nil {
		return err
	}
	if !needed {
		return nil
	}

	// Primary records in key order. That is the order this relay served them in
	// before the index existed, so a migration does not reshuffle a mailbox.
	type record struct {
		envelopeID string
		expiresAt  uint64
	}
	records := make([]record, 0)
	prefix := []byte(fmt.Sprintf("mailbox:%s:", mailboxID))
	if err := r.db.View(func(txn *badger.Txn) error {
		opts := badger.DefaultIteratorOptions
		opts.PrefetchValues = false
		it := txn.NewIterator(opts)
		defer it.Close()
		for it.Seek(prefix); it.ValidForPrefix(prefix); it.Next() {
			item := it.Item()
			records = append(records, record{
				envelopeID: string(item.Key()[len(prefix):]),
				expiresAt:  item.ExpiresAt(),
			})
		}
		return nil
	}); err != nil {
		return err
	}

	for start := 0; start < len(records); start += mailboxBackfillBatch {
		end := start + mailboxBackfillBatch
		if end > len(records) {
			end = len(records)
		}
		batch := records[start:end]
		offset := start
		if err := r.update(func(txn *badger.Txn) error {
			for index, entry := range batch {
				orderEntry := badger.NewEntry(
					mailboxOrderKey(mailboxID, uint64(offset+index+1)),
					[]byte(entry.envelopeID),
				)
				orderEntry.ExpiresAt = entry.expiresAt
				if err := txn.SetEntry(orderEntry); err != nil {
					return err
				}
			}
			return nil
		}); err != nil {
			return err
		}
	}

	// Written last: until it exists the mailbox is still "not yet backfilled".
	return r.update(func(txn *badger.Txn) error {
		if _, exists, err := readMailboxSequence(txn, mailboxID); err != nil || exists {
			return err
		}
		return txn.Set(mailboxSequenceKey(mailboxID), encodeMailboxPosition(uint64(len(records))+1))
	})
}

// HighestIssuedPosition is the highest position this mailbox has ever allocated.
// It is the upper bound on any continuation token or read position the relay
// could have issued, and therefore the bound the ack and poll routes refuse a
// read_through above: a recipient that reports a position beyond the end of its
// own mailbox marks envelopes judged that it was never offered, and with a
// durable mark those envelopes are unreachable for the rest of their lifetime
// (design section 4, R-4).
func (r *MailboxRepository) HighestIssuedPosition(mailboxID string) (uint64, error) {
	var highest uint64
	err := r.db.View(func(txn *badger.Txn) error {
		next, exists, err := readMailboxSequence(txn, mailboxID)
		if err != nil || !exists || next == 0 {
			return err
		}
		highest = next - 1
		return nil
	})
	return highest, err
}

// ReadMark is the durable read position of one recipient device in one mailbox.
// Zero means "nothing judged yet", which is the head of the mailbox.
func (r *MailboxRepository) ReadMark(mailboxID, deviceID string) (uint64, error) {
	var mark uint64
	err := r.db.View(func(txn *badger.Txn) error {
		item, err := txn.Get(mailboxReadMarkKey(mailboxID, deviceID))
		if errors.Is(err, badger.ErrKeyNotFound) {
			return nil
		}
		if err != nil {
			return err
		}
		raw, err := item.ValueCopy(nil)
		if err != nil {
			return err
		}
		mark, err = decodeMailboxPosition(raw)
		return err
	})
	return mark, err
}

// AdvanceReadMark moves a device's read position forward, and only forward.
//
// Monotonicity is the whole safety property: the mark decides what the recipient
// is offered NEXT, so a value that could move it backwards would let a replayed
// or reordered request rewind a victim to the head of a flooded mailbox - the
// flooding class reinstated through the very mechanism that closes it. Recovery
// from a mark that is too far ahead is not a rewind: it is an explicit poll
// carrying a cursor, which always re-walks from wherever the recipient asks.
func (r *MailboxRepository) AdvanceReadMark(mailboxID, deviceID string, position uint64) error {
	unlock := r.lockMailboxOrdering(mailboxID)
	defer unlock()

	return r.update(func(txn *badger.Txn) error {
		key := mailboxReadMarkKey(mailboxID, deviceID)
		switch item, err := txn.Get(key); {
		case err == nil:
			raw, valueErr := item.ValueCopy(nil)
			if valueErr != nil {
				return valueErr
			}
			current, parseErr := decodeMailboxPosition(raw)
			if parseErr != nil {
				return parseErr
			}
			if position <= current {
				return nil
			}
		case errors.Is(err, badger.ErrKeyNotFound):
			// No mark yet.
		default:
			return err
		}
		// The physical deadline is far beyond the envelope retention cap, so a
		// mark can never expire while an envelope it covers still exists, and the
		// key does not accumulate forever for a device that stops polling.
		return txn.SetEntry(badger.NewEntry(key, encodeMailboxPosition(position)).WithTTL(mailboxReadMarkTTL))
	})
}

// mailboxReadMarkTTL keeps a read position alive far longer than any envelope it
// could be about (DefaultMailboxRetentionCap is 168h).
const mailboxReadMarkTTL = 30 * 24 * time.Hour
