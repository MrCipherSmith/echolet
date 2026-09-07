package router

import (
	"fmt"
	"log/slog"
	"net/http"
	"time"

	"echolet/apps/relay/internal/api/handler"
	"echolet/apps/relay/internal/config"
	"echolet/apps/relay/internal/middleware"
	"echolet/apps/relay/internal/service"
	"echolet/apps/relay/internal/storage"
	"echolet/apps/relay/internal/storage/repository"

	"github.com/go-chi/chi/v5"
)

// Router is the relay's HTTP handler together with the background work whose
// lifetime is tied to it.
//
// NewRouter used to hand back a bare *chi.Mux, which left the caller no way to
// end the cleanup ticker it starts below: the goroutine outlived the store it
// can write into, and cmd/relay's shutdown sequence - whose whole purpose is
// that nothing is still writing when Badger closes - could not reach it. The mux
// is embedded rather than wrapped so this stays an http.Handler everywhere one
// is expected; the only thing added is a way to stop what NewRouter started.
type Router struct {
	*chi.Mux

	cleanup *service.CleanupService
}

// Stop ends the background work NewRouter started and waits for it to finish.
// It must be called before the storage the handlers were built over is closed.
func (r *Router) Stop() {
	r.cleanup.Stop()
}

func NewRouter(cfg config.Config, st *storage.Storage) *Router {
	r := chi.NewRouter()

	rateLimiter := middleware.NewRateLimiter(cfg.RateLimitPerMinute)

	r.Use(middleware.Recover)
	r.Use(middleware.RequestID)
	r.Use(rateLimiter.Middleware)

	// Initialize repositories
	deviceRecordRepo := repository.NewDeviceRecordRepository(st)
	preKeyBundleRepo := repository.NewPreKeyBundleRepository(st)
	mailboxRepo := repository.NewMailboxRepository(st)
	mailboxRepo.SetRetentionCap(time.Duration(cfg.MailboxTTLHours) * time.Hour)
	challengeRepo := repository.NewChallengeRepository(st)

	// Initialize services
	deviceRecordSvc := service.NewDeviceRecordService(deviceRecordRepo)
	// Device records published before the (mailbox identity, device UUID)
	// binding existed still need to authorize their owner.
	if err := deviceRecordSvc.BackfillMailboxBindings(); err != nil {
		slog.Error("failed to backfill mailbox device bindings", "error", err)
	}
	preKeyBundleSvc := service.NewPreKeyBundleService(preKeyBundleRepo)
	mailboxSvc := service.NewMailboxService(mailboxRepo)
	challengeSvc := service.NewChallengeService(challengeRepo, cfg.ChallengeTTLSeconds)

	// Start cleanup service. The handle is kept and returned: see Router.Stop.
	cleanupSvc := service.NewCleanupService(mailboxRepo, challengeRepo, cfg.CleanupIntervalSec, cfg.MailboxTTLHours)
	cleanupSvc.Start()

	// Initialize handlers
	deviceRecordHandler := handler.NewDeviceRecordHandler(deviceRecordSvc)
	preKeyBundleHandler := handler.NewPreKeyBundleHandler(preKeyBundleSvc)
	mailboxHandler := handler.NewMailboxHandler(mailboxSvc, challengeSvc, deviceRecordSvc, cfg.MaxMailboxBatch, cfg.MaxMessageBytes)
	mailboxHandler.SetSenderUnackedQuota(cfg.MaxUnackedEnvelopesPerSender)

	startTime := time.Now()
	r.Get("/health", func(w http.ResponseWriter, r *http.Request) {
		uptimeMs := time.Since(startTime).Milliseconds()
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		fmt.Fprintf(w, `{"ok":true,"data":{"status":"healthy","uptime_ms":%d}}`, uptimeMs)
	})

	// Device Record routes
	r.Post("/v1/device-records/publish", deviceRecordHandler.PublishDeviceRecord)

	// PreKey Bundle routes
	r.Post("/v1/prekeys/publish", preKeyBundleHandler.PublishPreKeyBundle)
	r.Post("/v2/prekeys/publish", preKeyBundleHandler.PublishSignalPreKeyBundleV2)
	r.Post("/v2/prekeys/claim", preKeyBundleHandler.ClaimSignalPreKeyBundleV2)
	r.Get("/v1/prekeys/{identityID}", func(w http.ResponseWriter, r *http.Request) {
		identityID := chi.URLParam(r, "identityID")
		preKeyBundleHandler.GetPreKeyBundles(w, r, identityID)
	})

	// Mailbox routes
	r.Post("/v1/messages/send", mailboxHandler.SendEnvelope)
	r.Post("/v1/mailbox/challenge", mailboxHandler.CreateChallenge)
	r.Post("/v1/mailbox/poll", mailboxHandler.PollMailbox)
	r.Post("/v1/mailbox/ack", mailboxHandler.AckMailbox)

	return &Router{Mux: r, cleanup: cleanupSvc}
}
