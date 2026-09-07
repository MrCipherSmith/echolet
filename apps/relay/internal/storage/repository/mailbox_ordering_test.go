package repository

import (
	"fmt"
	"sync"
	"testing"
	"time"

	"echolet/apps/relay/internal/model"
)

// RED tests for flow 002 / T5 finding T5-F-001 (major): the ORDER a recipient drains its mailbox in
// is chosen by the SENDER, not by the relay.
//
// The mechanism, at file:line
// ---------------------------
// Every selection is a Badger prefix scan in byte order over
// "mailbox:<mailbox_id>:<envelope_id>" (mailboxEnvelopeKey, mailbox_repo.go:429-431; scans at :104,
// :183, :326). The second key component is supplied by the sender and constrained only by the shape
// rule at validation/validate.go:134, which admits the nil UUID and roughly 10^28 further
// "00000000-…" identifiers. The T5 probe found 0 of 200 000 random v4 UUIDs sorting below that
// prefix, so an attacker can place an envelope ahead of one that is ALREADY STORED.
//
// The design's answer (t5-flood-closure-design.md §3, C4-1) is a per-mailbox ordering SIDE index,
// "mailboxseq:<mailbox_id>:<server seq> -> <envelope_id>", written inside SaveEnvelope's existing
// transaction and iterated by GetEnvelopeBatchFrom. It is deliberately a side index and not a change
// to mailboxEnvelopeKey, because mailbox_repo_test.go:294-296 hard-codes the primary layout in
// mailboxEnvelopeKeyForTest and that file may not be edited.
//
// Every test in this file therefore asserts an OBSERVABLE ordering property through the existing
// public repository surface. Nothing here references a symbol that does not exist yet, so the
// package still compiles and the pre-existing repository tests are unaffected: these fail on an
// assertion, which is what a RED test is, rather than on a build error, which is not.
//
// Only identifiers, counts and positions are printed. Ciphertext is inert synthetic padding.

// orderingHeadSortingID renders an envelope_id that sorts ahead of every random v4 UUID a real CLI
// mints — the exact ordering T48's real-relay evidence used to put poison at the head of a victim's
// mailbox.
func orderingHeadSortingID(index int) string {
	return fmt.Sprintf("00000000-0000-1000-8000-%012d", index)
}

// orderingTailSortingID sorts after every orderingHeadSortingID.
func orderingTailSortingID(index int) string {
	return fmt.Sprintf("ffffffff-ffff-4fff-8fff-%012d", index)
}

func orderingEnvelope(mailboxID, envelopeID string, nowMS int64) *model.MailboxEnvelope {
	return newRetentionTestEnvelope(mailboxID, envelopeID, nowMS-1000, nowMS+int64(time.Hour/time.Millisecond))
}

// selectionOrder is what a polling recipient actually sees: the envelope ids of one batch, in the
// order the relay chose to hand them out.
func selectionOrder(t *testing.T, repo *MailboxRepository, mailboxID string, limit int) []string {
	t.Helper()
	batch, err := repo.GetEnvelopeBatch(mailboxID, limit, 0)
	if err != nil {
		t.Fatalf("GetEnvelopeBatch(%q, %d) error = %v", mailboxID, limit, err)
	}
	ids := make([]string, 0, len(batch.Envelopes))
	for _, envelope := range batch.Envelopes {
		ids = append(ids, envelope.EnvelopeID)
	}
	return ids
}

// TestSelectionOrderIsAssignedByTheRelayNotBySenderSuppliedEnvelopeIDs is finding T5-F-001 stated as
// the outcome the recipient experiences.
//
// A legitimate envelope is stored FIRST. A later sender then stores one whose envelope_id sorts
// below it. The recipient must still be offered the envelope that arrived first: an attacker must
// not be able to get in front of mail that is already in the box.
func TestSelectionOrderIsAssignedByTheRelayNotBySenderSuppliedEnvelopeIDs(t *testing.T) {
	_, repo := newMailboxRepositoryForTest(t)
	mailboxID := "mailbox-t5f001-order"
	nowMS := time.Now().UnixMilli()

	legitimate := orderingEnvelope(mailboxID, orderingTailSortingID(1), nowMS)
	if err := repo.SaveEnvelope(legitimate); err != nil {
		t.Fatalf("SaveEnvelope(legitimate) error = %v", err)
	}
	for index := 0; index < 3; index++ {
		if err := repo.SaveEnvelope(orderingEnvelope(mailboxID, orderingHeadSortingID(index), nowMS)); err != nil {
			t.Fatalf("SaveEnvelope(poison %d) error = %v", index, err)
		}
	}

	order := selectionOrder(t, repo, mailboxID, 10)
	if len(order) != 4 {
		t.Fatalf("selection returned %d envelopes, want 4", len(order))
	}
	if order[0] != legitimate.EnvelopeID {
		t.Fatalf("first selected envelope = %q, want %q (stored first). "+
			"Selection is a byte-order prefix scan keyed on the SENDER-supplied envelope_id (mailbox_repo.go:429-431), and validation/validate.go:134 admits ~10^28 ids that sort below every random v4 UUID, so a sender chooses its own queue position - including ahead of an envelope that is already stored. "+
			"Order must be assigned by the relay in store order (design C4-1: a mailboxseq: side index written inside SaveEnvelope's transaction and iterated by GetEnvelopeBatchFrom)",
			order[0], legitimate.EnvelopeID)
	}
}

// TestConcurrentStoresGetDistinctIncreasingPositionsAndNothingIsLost pins the ordering index under
// the concurrency the relay actually sees, so it is run by `go test -race` like everything else in
// this package.
//
// Two properties, both observable without reaching into the index:
//
//   - Nothing collides. Twenty concurrent stores must produce twenty distinct selectable envelopes.
//     A sequence allocated by a read-then-write outside the transaction would hand two envelopes the
//     same position and silently drop one.
//   - Store order dominates id order. An envelope stored strictly AFTER all twenty completed, under
//     the lowest envelope_id the shape rule admits (the nil UUID, validate.go:134), must be selected
//     LAST. Under today's key order it is selected first.
func TestConcurrentStoresGetDistinctIncreasingPositionsAndNothingIsLost(t *testing.T) {
	_, repo := newMailboxRepositoryForTest(t)
	mailboxID := "mailbox-t5f001-concurrent"
	nowMS := time.Now().UnixMilli()

	const concurrentStores = 20
	var wait sync.WaitGroup
	errs := make([]error, concurrentStores)
	wait.Add(concurrentStores)
	for index := 0; index < concurrentStores; index++ {
		go func(index int) {
			defer wait.Done()
			// Descending ids, so byte order is the exact reverse of any plausible store order.
			errs[index] = repo.SaveEnvelope(orderingEnvelope(mailboxID, orderingTailSortingID(concurrentStores-index), nowMS))
		}(index)
	}
	wait.Wait()
	for index, err := range errs {
		if err != nil {
			t.Fatalf("SaveEnvelope(concurrent %d) error = %v", index, err)
		}
	}

	// Stored strictly after every concurrent write has returned, under the lowest admissible id.
	last := orderingEnvelope(mailboxID, "00000000-0000-0000-0000-000000000000", nowMS)
	if err := repo.SaveEnvelope(last); err != nil {
		t.Fatalf("SaveEnvelope(last) error = %v", err)
	}

	order := selectionOrder(t, repo, mailboxID, 100)
	if len(order) != concurrentStores+1 {
		t.Fatalf("selection returned %d envelopes after %d concurrent stores plus one, want %d: two envelopes sharing a position would drop one",
			len(order), concurrentStores, concurrentStores+1)
	}
	seen := make(map[string]bool, len(order))
	for _, id := range order {
		if seen[id] {
			t.Fatalf("envelope %q was selected twice: positions must be distinct", id)
		}
		seen[id] = true
	}
	if order[len(order)-1] != last.EnvelopeID {
		t.Fatalf("the envelope stored LAST was selected at position %d of %d, want last. "+
			"It carries the nil UUID, which validate.go:134 admits and which sorts below everything, so under the sender-keyed byte order it is served first. "+
			"A relay-assigned, strictly increasing per-mailbox position is what makes store order the selection order",
			indexOf(order, last.EnvelopeID)+1, len(order))
	}
}

func indexOf(values []string, wanted string) int {
	for index, value := range values {
		if value == wanted {
			return index
		}
	}
	return -1
}

// TestByteIdenticalReplayAllocatesNoPositionAndDoesNotMoveTheEnvelope protects F-004's exact retry
// against the ordering index.
//
// mailbox_repo.go:66-89 makes a byte-identical replay a no-op that never extends the retention
// deadline, and T54 exempts it from the per-sender quota (mailbox_handler.go:311-313). Allocating a
// new position for a replay would move the envelope to the back of the recipient's queue - a lost
// send response would silently reorder the conversation - and would leak positions.
func TestByteIdenticalReplayAllocatesNoPositionAndDoesNotMoveTheEnvelope(t *testing.T) {
	_, repo := newMailboxRepositoryForTest(t)
	mailboxID := "mailbox-t5f001-replay"
	nowMS := time.Now().UnixMilli()

	first := orderingEnvelope(mailboxID, orderingTailSortingID(1), nowMS)
	second := orderingEnvelope(mailboxID, orderingHeadSortingID(2), nowMS)
	third := orderingEnvelope(mailboxID, orderingHeadSortingID(3), nowMS)
	for _, envelope := range []*model.MailboxEnvelope{first, second, third} {
		if err := repo.SaveEnvelope(envelope); err != nil {
			t.Fatalf("SaveEnvelope(%q) error = %v", envelope.EnvelopeID, err)
		}
	}
	before := selectionOrder(t, repo, mailboxID, 10)

	for attempt := 1; attempt <= 3; attempt++ {
		if err := repo.SaveEnvelope(orderingEnvelope(mailboxID, first.EnvelopeID, nowMS)); err != nil {
			t.Fatalf("SaveEnvelope(byte-identical replay %d) error = %v: F-004 requires an exact retry to stay an idempotent no-op", attempt, err)
		}
	}

	after := selectionOrder(t, repo, mailboxID, 10)
	if len(after) != len(before) {
		t.Fatalf("mailbox holds %d selectable envelopes after 3 byte-identical replays, want %d: a replay must occupy no additional position", len(after), len(before))
	}
	for index := range before {
		if before[index] != after[index] {
			t.Fatalf("selection order changed at position %d after byte-identical replays (%q -> %q): an exact retry must not move the envelope in the recipient's queue",
				index, before[index], after[index])
		}
	}

	// The conflict rule is unchanged: a DIFFERENT body under a used pair is still refused, and still
	// without replacing the stored envelope.
	conflicting := orderingEnvelope(mailboxID, first.EnvelopeID, nowMS)
	conflicting.MessageID = "11111111-2222-4333-8444-555555555555"
	if err := repo.SaveEnvelope(conflicting); err != model.ErrEnvelopeIDConflict {
		t.Fatalf("SaveEnvelope(different body under a used envelope_id) error = %v, want ErrEnvelopeIDConflict", err)
	}
	if conflicted := selectionOrder(t, repo, mailboxID, 10); len(conflicted) != len(before) {
		t.Fatalf("mailbox holds %d selectable envelopes after a refused conflict, want %d", len(conflicted), len(before))
	}
}

// TestSenderOccupancyAndDeleteStillAddressByMailboxAndEnvelopeID is the guard that C4-1 stays a SIDE
// index. The primary record must remain at mailbox:<mailbox_id>:<envelope_id> so that
// SenderOccupancy's O(1) already-stored check (mailbox_repo.go:173) and DeleteEnvelope (:387) keep
// addressing an envelope by the pair the ack route knows, which is the only identifier a recipient
// ever sends back.
func TestSenderOccupancyAndDeleteStillAddressByMailboxAndEnvelopeID(t *testing.T) {
	_, repo := newMailboxRepositoryForTest(t)
	mailboxID := "mailbox-t5f001-addressing"
	nowMS := time.Now().UnixMilli()

	stored := orderingEnvelope(mailboxID, orderingHeadSortingID(1), nowMS)
	if err := repo.SaveEnvelope(stored); err != nil {
		t.Fatalf("SaveEnvelope() error = %v", err)
	}

	occupancy, err := repo.SenderOccupancy(mailboxID, stored.SenderIdentityID, stored.EnvelopeID, 16)
	if err != nil {
		t.Fatalf("SenderOccupancy(already stored) error = %v", err)
	}
	if !occupancy.EnvelopeAlreadyStored {
		t.Fatalf("SenderOccupancy(%q).EnvelopeAlreadyStored = false, want true: the already-stored check must stay an O(1) lookup on the primary (mailbox, envelope_id) key, or F-004's exact retry starts being charged against the sender quota", stored.EnvelopeID)
	}

	fresh, err := repo.SenderOccupancy(mailboxID, stored.SenderIdentityID, orderingHeadSortingID(999), 16)
	if err != nil {
		t.Fatalf("SenderOccupancy(fresh) error = %v", err)
	}
	if fresh.LiveEnvelopes != 1 {
		t.Fatalf("SenderOccupancy(fresh).LiveEnvelopes = %d, want 1", fresh.LiveEnvelopes)
	}

	if err := repo.DeleteEnvelope(mailboxID, stored.EnvelopeID); err != nil {
		t.Fatalf("DeleteEnvelope() error = %v", err)
	}
	if order := selectionOrder(t, repo, mailboxID, 10); len(order) != 0 {
		t.Fatalf("selection returned %d envelopes after DeleteEnvelope, want 0: an acknowledged envelope must leave the recipient's queue, ordering index included", len(order))
	}
	after, err := repo.SenderOccupancy(mailboxID, stored.SenderIdentityID, orderingHeadSortingID(999), 16)
	if err != nil {
		t.Fatalf("SenderOccupancy(after delete) error = %v", err)
	}
	if after.LiveEnvelopes != 0 {
		t.Fatalf("SenderOccupancy(after delete).LiveEnvelopes = %d, want 0: ack must free the sender's quota slot", after.LiveEnvelopes)
	}
}

// TestCursorResumesStrictlyAfterTheEnvelopesAlreadyDelivered closes the skip/repeat window the
// position cursor documents at mailbox_repo.go:296-303.
//
// Today the cursor is "how many envelopes this walk has already handed out", so an envelope that
// leaves the mailbox between two pages of one walk shifts every later position by one and an
// envelope is SKIPPED. mailbox_repo.go:302 argues that is harmless because "a walk always restarts
// at the head" - which is exactly the property C4-2 removes. Once a cursorless poll resumes at the
// recipient's stored mark, a skipped envelope is skipped for good, so the cursor has to mean
// "resume strictly after this envelope" instead of "skip this many".
//
// Acking between pages is not a corner case: it is what `poll` does on every page that yields
// anything (inbound.ts:128).
func TestCursorResumesStrictlyAfterTheEnvelopesAlreadyDelivered(t *testing.T) {
	_, repo := newMailboxRepositoryForTest(t)
	mailboxID := "mailbox-t5f001-cursor"
	nowMS := time.Now().UnixMilli()

	ids := []string{orderingHeadSortingID(1), orderingHeadSortingID(2), orderingHeadSortingID(3), orderingHeadSortingID(4)}
	for _, id := range ids {
		if err := repo.SaveEnvelope(orderingEnvelope(mailboxID, id, nowMS)); err != nil {
			t.Fatalf("SaveEnvelope(%q) error = %v", id, err)
		}
	}

	first, err := repo.GetEnvelopeBatchFrom(mailboxID, 2, 0, "")
	if err != nil {
		t.Fatalf("GetEnvelopeBatchFrom(page 1) error = %v", err)
	}
	if len(first.Envelopes) != 2 || first.NextCursor == "" {
		t.Fatalf("page 1 returned %d envelopes with cursor %q, want 2 and a continuation token", len(first.Envelopes), first.NextCursor)
	}
	delivered := []string{first.Envelopes[0].EnvelopeID, first.Envelopes[1].EnvelopeID}

	// The recipient acknowledges the first envelope of page 1 before asking for page 2.
	if err := repo.DeleteEnvelope(mailboxID, delivered[0]); err != nil {
		t.Fatalf("DeleteEnvelope(%q) error = %v", delivered[0], err)
	}

	second, err := repo.GetEnvelopeBatchFrom(mailboxID, 2, 0, first.NextCursor)
	if err != nil {
		t.Fatalf("GetEnvelopeBatchFrom(page 2) error = %v", err)
	}
	got := make([]string, 0, len(second.Envelopes))
	for _, envelope := range second.Envelopes {
		got = append(got, envelope.EnvelopeID)
	}
	if len(got) != 2 {
		t.Fatalf("page 2 returned %d envelopes %v after one envelope from page 1 was acknowledged, want the 2 that were never delivered. "+
			"A count-based cursor (mailbox_repo.go:325 `remaining := position`) skips one envelope for every envelope that left the mailbox mid-walk. That is survivable only while every walk restarts at the head; once a cursorless poll resumes at the recipient's stored read position, a skipped envelope is skipped permanently",
			len(got), got)
	}
	for _, id := range got {
		for _, alreadyDelivered := range delivered {
			if id == alreadyDelivered {
				t.Fatalf("page 2 re-delivered %q, which page 1 already returned: the cursor must resume STRICTLY AFTER the envelopes handed out", id)
			}
		}
	}
	if got[0] != ids[2] || got[1] != ids[3] {
		t.Fatalf("page 2 returned %v, want %v: the two envelopes never handed out, in order", got, ids[2:])
	}
}

// TestExpiredEnvelopesDoNotConsumeTheResumePosition keeps the F-005 ordering guarantee
// (mailbox_repo.go:333-339) attached to the new cursor meaning: an envelope that passed its declared
// expiry is skipped before the cursor is consumed, so it can neither wedge delivery nor move the
// recipient's read position past a valid envelope.
func TestExpiredEnvelopesDoNotConsumeTheResumePosition(t *testing.T) {
	store, repo := newMailboxRepositoryForTest(t)
	mailboxID := "mailbox-t5f001-expiry"
	nowMS := time.Now().UnixMilli()
	hourMS := int64(time.Hour / time.Millisecond)

	// Seeded directly, the same way TestGetEnvelopesFiltersExpiredBeforeApplyingBatchLimit does:
	// records accepted while valid whose declared lifetime has since elapsed.
	seedStoredEnvelope(t, store, newRetentionTestEnvelope(mailboxID, orderingHeadSortingID(1), nowMS-4*hourMS, nowMS-hourMS))
	seedStoredEnvelope(t, store, newRetentionTestEnvelope(mailboxID, orderingHeadSortingID(2), nowMS-4*hourMS, nowMS-hourMS))

	// GetEnvelopes scans the PRIMARY mailbox prefix and must keep doing so: directly seeded records
	// carry no ordering-index entry, and mailbox_repo_test.go:115-129 drives this path.
	if envelopes, err := repo.GetEnvelopes(mailboxID, 10); err != nil || len(envelopes) != 0 {
		t.Fatalf("GetEnvelopes(expired only) = %d envelopes, err = %v, want 0 and nil", len(envelopes), err)
	}

	valid := []string{orderingTailSortingID(1), orderingTailSortingID(2), orderingTailSortingID(3)}
	for _, id := range valid {
		if err := repo.SaveEnvelope(orderingEnvelope(mailboxID, id, nowMS)); err != nil {
			t.Fatalf("SaveEnvelope(%q) error = %v", id, err)
		}
	}

	page, err := repo.GetEnvelopeBatchFrom(mailboxID, 2, 0, "")
	if err != nil {
		t.Fatalf("GetEnvelopeBatchFrom(page 1) error = %v", err)
	}
	if len(page.Envelopes) != 2 {
		t.Fatalf("page 1 returned %d envelopes, want 2: two expired records at the head must be skipped before the batch limit is consumed", len(page.Envelopes))
	}
	if page.NextCursor == "" {
		t.Fatalf("page 1 reported no continuation token, but a third valid envelope remains")
	}

	rest, err := repo.GetEnvelopeBatchFrom(mailboxID, 2, 0, page.NextCursor)
	if err != nil {
		t.Fatalf("GetEnvelopeBatchFrom(page 2) error = %v", err)
	}
	if len(rest.Envelopes) != 1 || rest.Envelopes[0].EnvelopeID != valid[2] {
		t.Fatalf("page 2 returned %d envelopes, want exactly the one valid envelope %q: an expired record must not shift the resume position",
			len(rest.Envelopes), valid[2])
	}
}
