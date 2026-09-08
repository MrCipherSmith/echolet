package service

import (
	"context"
	"log/slog"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// Flow 003 T27 - V-007: stopping the cleanup service must WAIT for its
// goroutine, not merely ask it to go.
//
// Stop's own comment states the property: "'the cleanup service is stopped'
// means the goroutine is gone, not merely that it has been asked to go. That
// distinction is the whole point of the residual: the caller stops this service
// so that nothing is still writing when Badger closes, and a stop that only
// signals would not give that." T9's report calls the join "the property".
//
// MEASURED (flow 003 T25 §4, mutation G7): replacing `<-stopped` with
// `_ = stopped` in Stop left internal/service AND internal/server green under
// -race. TestCleanupServiceStopEndsItsTickerGoroutine cannot see the difference
// by construction - it POLLS the goroutine dump for up to five seconds after
// Stop returns, and a goroutine that was merely signalled still exits within
// microseconds, so the poll succeeds either way. It pins "the goroutine ends",
// which is the weaker half. This file pins the join itself.
//
// HOW IT TELLS "WAITED" FROM "GOT LUCKY", WITH NO SLEEP ANYWHERE. The ticker
// goroutine is held INSIDE runCleanup for as long as the test likes, by giving
// slog a handler that blocks on the record runCleanup emits. While it is held:
//
//  1. a second goroutine calls Stop and, the instant Stop returns, records
//     whether the ticker goroutine was still inside runCleanup;
//  2. a third goroutine releases the block, and only once it has observed
//     EITHER that Stop is parked on a channel receive (the joining shape) or
//     that Stop has already returned (the signal-only shape). Both are
//     observable events, so neither branch is a timing guess.
//
// That makes the two orderings mutually exclusive and each one forced by a
// happens-before chain rather than by luck:
//
//   - a Stop that joins: release -> handler returns -> runCleanup returns ->
//     goroutine returns -> close(stopped) -> Stop returns. The flag it reads is
//     necessarily false.
//   - a Stop that only signals: Stop returns -> flag read (still inside) ->
//     stopReturned closed -> release. The flag it reads is necessarily true.
//
// Every bounded wait below is a wait on an observable event; the bound exists
// only to turn a hang into a named failure, exactly as in
// cleanup_service_stop_test.go.

// joinTickerInterval is the shortest interval the service accepts, so the
// ticker fires once and parks the goroutine where this test can hold it. It is
// not a synchronisation device: the test waits for the handler's `entered`
// channel, never for a duration.
const joinTickerInterval = 1

// blockingCleanupHandler is a slog handler that holds the FIRST record
// runCleanup emits until it is released, and reports whether the emitting
// goroutine is still inside.
//
// It records nothing and formats nothing: no attribute value ever leaves this
// type, so no stored value can reach a test log.
type blockingCleanupHandler struct {
	entered chan struct{}
	release chan struct{}
	// inside is true exactly while the ticker goroutine is held in Handle.
	inside atomic.Bool
	first  sync.Once
}

func (h *blockingCleanupHandler) Enabled(context.Context, slog.Level) bool { return true }

func (h *blockingCleanupHandler) WithAttrs([]slog.Attr) slog.Handler { return h }

func (h *blockingCleanupHandler) WithGroup(string) slog.Handler { return h }

func (h *blockingCleanupHandler) Handle(_ context.Context, record slog.Record) error {
	if !recordCameFromRunCleanup(record) {
		return nil
	}

	held := false
	h.first.Do(func() { held = true })
	if !held {
		// runCleanup's second record, and any later tick. Only the first one
		// holds the goroutine, so the service can never be wedged by this test.
		return nil
	}

	h.inside.Store(true)
	close(h.entered)
	<-h.release
	h.inside.Store(false)
	return nil
}

// recordCameFromRunCleanup identifies a record by the FUNCTION that emitted it
// rather than by its text, so a reworded log line does not silently turn this
// test into one that observes nothing. The message is kept only as a fallback
// for a build where slog captured no caller PC.
func recordCameFromRunCleanup(record slog.Record) bool {
	if record.PC != 0 {
		frame, _ := runtime.CallersFrames([]uintptr{record.PC}).Next()
		if strings.Contains(frame.Function, "(*CleanupService).runCleanup") {
			return true
		}
	}
	return strings.Contains(record.Message, "Running cleanup")
}

// stopFrame is how a Stop CALL renders in a goroutine dump:
// `...internal/service.(*CleanupService).Stop(0x...)`. The open parenthesis
// keeps it from matching this test's own frames.
const stopFrame = "(*CleanupService).Stop("

// stopIsParkedOnItsGoroutine reports whether some goroutine is inside Stop AND
// blocked on a channel receive - which, in Stop, is `<-stopped` and nothing
// else. A Stop that only signals is never in this state, so this is the
// observable that distinguishes the two shapes.
func stopIsParkedOnItsGoroutine() bool {
	for _, block := range strings.Split(cleanupGoroutineStacks(), "\n\ngoroutine ") {
		if !strings.Contains(block, stopFrame) {
			continue
		}
		header, _, _ := strings.Cut(block, "\n")
		if strings.Contains(header, "chan receive") {
			return true
		}
	}
	return false
}

func TestCleanupServiceStopWaitsForItsGoroutineInsteadOfOnlySignallingIt(t *testing.T) {
	handler := &blockingCleanupHandler{entered: make(chan struct{}), release: make(chan struct{})}

	previous := slog.Default()
	slog.SetDefault(slog.New(handler))
	defer slog.SetDefault(previous)

	var releaseOnce sync.Once
	release := func() { releaseOnce.Do(func() { close(handler.release) }) }
	// Whatever happens below - including a t.Fatalf - the ticker goroutine is
	// let go, so a failing assertion cannot wedge the rest of the package.
	defer release()

	// The repositories are never read (runCleanup has an empty body, RI-63), so
	// nil is a faithful fixture and keeps this test free of a Badger directory.
	cleanup := NewCleanupService(nil, nil, joinTickerInterval, 168)
	cleanup.Start()

	select {
	case <-handler.entered:
	case <-time.After(cleanupGoroutineDeadline):
		t.Fatalf("the cleanup ticker did not run runCleanup within %s, so this test never got hold of the "+
			"goroutine and could not tell a Stop that joins from one that only signals. Start() must launch a "+
			"goroutine that calls runCleanup on its ticker", cleanupGoroutineDeadline)
	}

	// Precondition, asserted rather than assumed: the goroutine really is held.
	if !handler.inside.Load() {
		t.Fatalf("precondition failed: the ticker goroutine reported entering runCleanup but is not being held, " +
			"so the assertion below could not distinguish anything")
	}

	stopReturned := make(chan struct{})
	var stillInsideWhenStopReturned atomic.Bool

	go func() {
		cleanup.Stop()
		// Read FIRST, publish afterwards: the releaser below cannot act on
		// stopReturned until this value is already recorded.
		stillInsideWhenStopReturned.Store(handler.inside.Load())
		close(stopReturned)
	}()

	go func() {
		defer release()
		deadline := time.Now().Add(cleanupGoroutineDeadline)
		for time.Now().Before(deadline) {
			if stopIsParkedOnItsGoroutine() {
				// Stop is waiting on its goroutine. Let the goroutine finish so
				// that the wait can end.
				return
			}
			select {
			case <-stopReturned:
				// Stop has already returned without ever parking, while the
				// goroutine it launched is still inside runCleanup. Release it so
				// the test can settle rather than hang on the failure.
				return
			default:
				runtime.Gosched()
			}
		}
	}()

	select {
	case <-stopReturned:
	case <-time.After(cleanupGoroutineDeadline):
		t.Fatalf("Stop() did not return within %s while its goroutine was held inside runCleanup and then "+
			"released; stopping must end, not block for ever:\n%s", cleanupGoroutineDeadline, cleanupGoroutineStacks())
	}

	if stillInsideWhenStopReturned.Load() {
		t.Fatalf("Stop() returned while the goroutine Start() launched was STILL executing runCleanup. Stopping " +
			"the cleanup service must join that goroutine, not merely signal it: the relay stops this service " +
			"(cmd/relay/main.go) so that nothing is still writing when Badger closes, and a Stop that returns " +
			"before its goroutine has left runCleanup gives the shutdown sequence no such guarantee - the store " +
			"closes underneath a transaction that is still in flight. Signalling is necessary; the join is the " +
			"property")
	}

	// The weaker half, kept so that a Stop which somehow satisfied the join by
	// never starting the goroutine could not pass: it really is gone afterwards.
	if !waitForCleanupGoroutine(t, false) {
		t.Fatalf("a goroutine is still running CleanupService code %s after Stop() returned:\n%s",
			cleanupGoroutineDeadline, cleanupGoroutineStacks())
	}
}
