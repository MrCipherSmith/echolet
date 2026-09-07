package service

import (
	"echolet/apps/relay/internal/model"
	"echolet/apps/relay/internal/storage/repository"
)

type MailboxService struct {
	repo *repository.MailboxRepository
}

func NewMailboxService(repo *repository.MailboxRepository) *MailboxService {
	return &MailboxService{repo: repo}
}

func (s *MailboxService) StoreEnvelope(envelope *model.MailboxEnvelope) error {
	return s.repo.SaveEnvelope(envelope)
}

func (s *MailboxService) GetEnvelopes(mailboxID string, limit int) ([]*model.MailboxEnvelope, error) {
	return s.repo.GetEnvelopes(mailboxID, limit)
}

// GetEnvelopeBatch selects a batch bounded by both an envelope count and an
// aggregate encoded-byte budget, starting at the head of the mailbox.
func (s *MailboxService) GetEnvelopeBatch(mailboxID string, limit int, byteBudget int64) (repository.EnvelopeBatch, error) {
	return s.repo.GetEnvelopeBatch(mailboxID, limit, byteBudget)
}

// GetEnvelopeBatchFrom is GetEnvelopeBatch resumed at a server-issued cursor, and
// reports the cursor for the page after this one. An unusable cursor is returned
// as model.ErrInvalidMailboxCursor.
func (s *MailboxService) GetEnvelopeBatchFrom(mailboxID string, limit int, byteBudget int64, cursor string) (repository.EnvelopeBatch, error) {
	return s.repo.GetEnvelopeBatchFrom(mailboxID, limit, byteBudget, cursor)
}

// SenderOccupancy reports how much of one recipient mailbox one sender identity
// currently occupies, and whether the envelope_id it is about to use is already
// taken. It is the input to the per-sender unacked-envelope quota; the count is
// capped at countLimit, because the only question the quota asks is whether the
// bound has been reached.
func (s *MailboxService) SenderOccupancy(mailboxID, senderIdentityID, envelopeID string, countLimit int) (repository.SenderMailboxOccupancy, error) {
	return s.repo.SenderOccupancy(mailboxID, senderIdentityID, envelopeID, countLimit)
}

func (s *MailboxService) AckEnvelopes(mailboxID string, envelopeIDs []string) error {
	for _, envelopeID := range envelopeIDs {
		if err := s.repo.DeleteEnvelope(mailboxID, envelopeID); err != nil {
			return err
		}
	}
	return nil
}
