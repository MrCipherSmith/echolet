package service

import (
	"log/slog"
	"sync"
	"time"

	"echolet/apps/relay/internal/storage/repository"
)

// DefaultCleanupIntervalSeconds is how often the relay's cleanup ticker fires.
//
// It is a constant rather than a setting on purpose. ECHOLET_CLEANUP_INTERVAL_SECONDS
// was removed from the operator surface (flow 003, T28) and then from
// config.Config itself (T33), because runCleanup() sweeps nothing - retention is
// Badger's own TTL - so an operator tuning this number would be tuning nothing.
// The value is the 60 seconds that variable defaulted to, so the relay's
// behaviour is unchanged; it simply lives with the service that owns the ticker.
// It is positive by construction, which is also what stops a Config nobody filled
// in from panicking time.NewTicker.
const DefaultCleanupIntervalSeconds = 60

type CleanupService struct {
	mailboxRepo   *repository.MailboxRepository
	challengeRepo *repository.ChallengeRepository
	intervalSec   int
	mailboxTTL    time.Duration

	// mu guards the two channels below, which exist only between a Start and
	// the Stop that answers it. Start and Stop are called from different
	// goroutines - the router builds and starts the service, cmd/relay's signal
	// handler stops it - so the handle has to be published under a lock rather
	// than written once and hoped for.
	mu sync.Mutex
	// stop is closed to ask the ticker goroutine to return; stopped is closed
	// by that goroutine once it has. Stop waits for the second, so "the cleanup
	// service is stopped" means the goroutine is gone, not merely that it has
	// been asked to go. That distinction is the whole point of the residual:
	// the caller stops this service so that nothing is still writing when
	// Badger closes, and a stop that only signals would not give that.
	stop    chan struct{}
	stopped chan struct{}
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

// Start launches the cleanup ticker. It is a no-op on a service that is already
// running, so a second call cannot strand a goroutine that Stop can no longer
// reach.
func (s *CleanupService) Start() {
	s.mu.Lock()
	defer s.mu.Unlock()

	if s.stop != nil {
		return
	}
	stop, stopped := make(chan struct{}), make(chan struct{})
	s.stop, s.stopped = stop, stopped

	ticker := time.NewTicker(time.Duration(s.intervalSec) * time.Second)
	go func() {
		// Both deferred: the ticker's own goroutine is released and Stop is
		// released even if runCleanup panics, rather than leaving the shutdown
		// sequence waiting on a goroutine that is never coming back.
		defer close(stopped)
		defer ticker.Stop()

		for {
			select {
			case <-ticker.C:
				s.runCleanup()
			case <-stop:
				return
			}
		}
	}()
	slog.Info("Cleanup service started", "interval_sec", s.intervalSec)
}

// Stop ends the goroutine Start launched and waits for it to return.
//
// It is what puts the cleanup ticker inside the relay's shutdown sequence
// (cmd/relay/main.go). Until it existed the ticker was created inside Start with
// no handle kept anywhere, so it outlived the Badger close by construction:
// harmless only for as long as runCleanup has an empty body, and a transaction
// against a closing store the moment it is given the work its name implies.
//
// Stop is idempotent and safe on a service that was never started, because the
// startup failure paths in cmd/relay close the store through the same sequence
// as an ordinary stop and must not depend on how far the start got.
func (s *CleanupService) Stop() {
	s.mu.Lock()
	stop, stopped := s.stop, s.stopped
	s.stop, s.stopped = nil, nil
	s.mu.Unlock()

	if stop == nil {
		return
	}

	close(stop)
	<-stopped
	slog.Info("Cleanup service stopped")
}

func (s *CleanupService) runCleanup() {
	slog.Debug("Running cleanup...")
	// BadgerDB handles TTL automatically, but we can add custom cleanup logic here
	// For MVP, BadgerDB's built-in TTL is sufficient for mailbox envelopes
	slog.Debug("Cleanup completed")
}
