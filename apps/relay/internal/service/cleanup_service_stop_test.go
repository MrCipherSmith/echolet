package service

import (
	"reflect"
	"runtime"
	"strings"
	"testing"
	"time"
)

// RED test for residual RI-30 (flow 003 T1 inventory; T17-F-002).
//
// CleanupService.Start (cleanup_service.go:31-39) creates a time.Ticker inside
// the call, launches a goroutine that ranges over it, keeps no stop channel and
// never calls ticker.Stop(). router.go:47-48 constructs the service, starts it
// and keeps no handle. There is therefore no way for anything - including
// cmd/relay's shutdown sequence - to end that goroutine, and until this file
// internal/service had no test at all, so nothing observed it either.
//
// It is harmless TODAY only because runCleanup() is two slog.Debug calls with an
// empty body (RI-63). That is the whole point: an unstoppable timer, an empty
// body and no test is precisely how "a write against a closing store" comes back
// silently. The moment runCleanup is given the Badger work its name and its
// configured ECHOLET_CLEANUP_INTERVAL_SECONDS both imply, the relay has
// transactions on a timer that shutdown step 3 (cmd/relay/main.go:104-114) was
// written to prevent and cannot reach.
//
// WHAT SHAPE THE FIX HAS TO TAKE. The relay's stop is a plain sequence of calls
// in main.go, and router.NewRouter returns a bare *chi.Mux with no lifecycle, so
// whatever ends the goroutine has to be something a caller holding the service
// can invoke. This test accepts any of Stop/Close/Shutdown, with or without an
// error return, and asserts only the property: after it returns, no goroutine is
// still running CleanupService code. A context-cancellable Start is an equally
// good design as long as one of those methods exists for the shutdown sequence
// to call.
//
// The companion test that the relay actually calls it, before the store closes,
// is TestRelayStopsTheCleanupServiceBeforeClosingStorage in internal/server.

// cleanupGoroutineDeadline bounds the wait for the ticker goroutine to appear
// and, later, to be gone. It is not a sleep: both waits poll the observable
// (the process's own goroutine stacks) and return the instant it changes. The
// bound only turns a hang into a named failure.
const cleanupGoroutineDeadline = 5 * time.Second

// cleanupTickerInterval is long enough that the ticker never fires during the
// test, so a leaked goroutine stays parked and harmless to the rest of the
// package rather than running runCleanup on a loop.
const cleanupTickerInterval = 3600

func TestCleanupServiceStopEndsItsTickerGoroutine(t *testing.T) {
	// The repositories are never read: mailboxRepo, challengeRepo and mailboxTTL
	// are stored by the constructor and used nowhere (RI-63), so nil is a
	// faithful fixture and keeps this test free of a Badger directory.
	cleanup := NewCleanupService(nil, nil, cleanupTickerInterval, 168)

	cleanup.Start()

	// Precondition, so the post-condition below cannot pass vacuously: the
	// goroutine Start launches is really there.
	if !waitForCleanupGoroutine(t, true) {
		t.Fatalf("precondition failed: no goroutine is running CleanupService code %s after Start(), so this test "+
			"could not tell a stopped ticker from one that was never started", cleanupGoroutineDeadline)
	}

	stop := stopShapedMethod(cleanup)
	if !stop.IsValid() {
		t.Fatalf("CleanupService exposes no way to stop the goroutine Start() launches: no Stop, Close or Shutdown "+
			"method exists on %T, and cleanup_service.go:31-39 keeps neither the ticker nor a cancellation channel. "+
			"The relay's stop sequence (cmd/relay/main.go:104-114) therefore cannot end it, and it outlives the "+
			"Badger close by construction - a timer with real work in runCleanup would be writing into a closing "+
			"store with nothing able to prevent it", cleanup)
	}
	stop.Call(nil)

	if !waitForCleanupGoroutine(t, false) {
		t.Fatalf("a goroutine is still running CleanupService code %s after the service was stopped; "+
			"stopping the service must end the goroutine Start() launched, not merely stop scheduling work in it:\n%s",
			cleanupGoroutineDeadline, cleanupGoroutineStacks())
	}
}

// stopShapedMethod returns the service's stop method, or an invalid Value when
// it has none. Any of Stop/Close/Shutdown is accepted, with no arguments and any
// return.
func stopShapedMethod(value any) reflect.Value {
	subject := reflect.ValueOf(value)
	for _, name := range []string{"Stop", "Close", "Shutdown"} {
		method := subject.MethodByName(name)
		if method.IsValid() && method.Type().NumIn() == 0 {
			return method
		}
	}
	return reflect.Value{}
}

// waitForCleanupGoroutine waits until a goroutine running CleanupService code is
// present (want=true) or absent (want=false), and reports whether that happened
// within the deadline. The observable is the process's own goroutine dump, so
// this returns as soon as the state changes.
func waitForCleanupGoroutine(t *testing.T, want bool) bool {
	t.Helper()

	deadline := time.Now().Add(cleanupGoroutineDeadline)
	for {
		if cleanupGoroutineRunning() == want {
			return true
		}
		if !time.Now().Before(deadline) {
			return false
		}
		runtime.Gosched()
	}
}

// cleanupGoroutineFrame is how a CleanupService METHOD frame renders in a
// goroutine dump: `...internal/service.(*CleanupService).Start.func1(...)`.
//
// The receiver parentheses are load-bearing. A bare "CleanupService" would also
// match this test's own frame - `service.TestCleanupServiceStopEnds...` - so the
// dump would never be free of it, the precondition would pass vacuously and the
// post-condition could never be satisfied by any fix.
const cleanupGoroutineFrame = "(*CleanupService)."

func cleanupGoroutineRunning() bool {
	return strings.Contains(cleanupGoroutineStacks(), cleanupGoroutineFrame)
}

// cleanupGoroutineStacks dumps every goroutine's stack. Only frame names are
// ever produced, never any stored value.
func cleanupGoroutineStacks() string {
	buffer := make([]byte, 1<<16)
	for {
		written := runtime.Stack(buffer, true)
		if written < len(buffer) {
			return string(buffer[:written])
		}
		buffer = make([]byte, 2*len(buffer))
	}
}
