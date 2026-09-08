package router

import (
	"testing"

	"echolet/apps/relay/internal/config"
	"echolet/apps/relay/internal/storage"
)

// Flow 003, T33: with the cleanup interval gone from Config, NewRouter must still
// start a cleanup ticker - and must start one that works from a Config nobody
// configured a period into.
//
// This is the hazard the removed field left behind. NewRouter passed
// cfg.CleanupIntervalSec straight to time.NewTicker, which PANICS on a
// non-positive duration, so a zero-value Config took the relay's router down at
// construction. Nothing in the package said so; the two Signal v2 router tests
// simply carried `CleanupIntervalSec: 3600` in their config literals to step
// around it, which is why those literals can lose that line without losing an
// assertion - the value was never asserted on, it was a workaround for a knob
// that configured nothing.
//
// The service, its Stop() and its place in the relay's shutdown sequence are NOT
// removed and are exercised here: Stop() must return, and must return twice, so
// the startup-failure paths in cmd/relay can call it without knowing how far the
// start got.
func TestNewRouterStartsACleanupTickerWithoutAConfiguredInterval(t *testing.T) {
	st, err := storage.NewStorage(t.TempDir())
	if err != nil {
		t.Fatalf("NewStorage() error = %v", err)
	}
	t.Cleanup(func() { _ = st.Close() })

	// Deliberately no cleanup period of any kind: the ticker's period is the
	// cleanup service's own business now.
	router := NewRouter(config.Config{RateLimitPerMinute: 1_000}, st)
	if router == nil {
		t.Fatal("NewRouter returned nil")
	}

	// Stop() is the shutdown sequence's handle on the ticker goroutine, and it
	// waits for that goroutine to return rather than merely signalling it. If the
	// ticker had never started, or had panicked, this is where it shows.
	router.Stop()
	router.Stop()
}
