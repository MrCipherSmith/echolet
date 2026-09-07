package service

import (
	"log/slog"
	"time"

	"echolet/apps/relay/internal/storage/repository"
)

type CleanupService struct {
	mailboxRepo   *repository.MailboxRepository
	challengeRepo *repository.ChallengeRepository
	intervalSec   int
	mailboxTTL    time.Duration
}

func NewCleanupService(
	mailboxRepo *repository.MailboxRepository,
	challengeRepo *repository.ChallengeRepository,
	intervalSec int,
	mailboxTTLHours int,
) *CleanupService {
	return &CleanupService{
		mailboxRepo:   mailboxRepo,
		challengeRepo: challengeRepo,
		intervalSec:   intervalSec,
		mailboxTTL:    time.Duration(mailboxTTLHours) * time.Hour,
	}
}

func (s *CleanupService) Start() {
	ticker := time.NewTicker(time.Duration(s.intervalSec) * time.Second)
	go func() {
		for range ticker.C {
			s.runCleanup()
		}
	}()
	slog.Info("Cleanup service started", "interval_sec", s.intervalSec)
}

func (s *CleanupService) runCleanup() {
	slog.Debug("Running cleanup...")
	// BadgerDB handles TTL automatically, but we can add custom cleanup logic here
	// For MVP, BadgerDB's built-in TTL is sufficient for mailbox envelopes
	slog.Debug("Cleanup completed")
}
