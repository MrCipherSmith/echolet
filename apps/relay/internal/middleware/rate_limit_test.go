package middleware

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"
)

// RED tests for review findings F-010 and F-011.
//
// F-010 (rate_limit.go:31): the middleware defers the shared-mutex unlock until
// the whole middleware returns, so next.ServeHTTP executes while the global
// limiter lock is held. One slow request therefore blocks every other route and
// client, including /health.
//
// F-011 (rate_limit.go:29): the quota key is the full r.RemoteAddr, TCP source
// port included, so every new connection mints a fresh per-minute quota and the
// buckets are never pruned.
//
// These tests pin the intended behaviour only. They never write request bodies,
// key material or client payloads into test output.

// rateLimiterTestSeam is the minimal deterministic seam the fix must expose so
// that bucket expiry can be tested without wall-clock sleeps. It is declared
// here (test-only) and asserted at runtime, so this file keeps compiling before
// the seam exists.
type rateLimiterTestSeam interface {
	// SetClock replaces the limiter's time source. Must be callable before the
	// first request.
	SetClock(now func() time.Time)
	// TrackedClients reports how many quota buckets the limiter currently
	// retains.
	TrackedClients() int
}

// handlerEntryTimeout is a deadlock detector, not a correctness delay: the
// assertions below are driven entirely by channel synchronisation and this
// bound only decides how long a wedged run waits before reporting the failure.
const handlerEntryTimeout = 5 * time.Second

// TestRateLimiterReleasesSharedLockBeforeInvokingHandler pins F-010.
//
// While one request is still executing inside the downstream handler, an
// independent request from a different host must still be able to reach the
// limiter's decision and enter the handler. Quota accounting belongs under the
// lock; next.ServeHTTP and the rejection write do not.
func TestRateLimiterReleasesSharedLockBeforeInvokingHandler(t *testing.T) {
	const (
		firstRemoteAddr  = "192.0.2.10:40001"
		secondRemoteAddr = "198.51.100.7:50002"
	)

	entered := make(chan string, 2)
	release := make(chan struct{})
	blocking := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		entered <- r.RemoteAddr
		<-release
	})

	limited := NewRateLimiter(100).Middleware(blocking)

	var inFlight sync.WaitGroup
	serve := func(remoteAddr string) {
		inFlight.Add(1)
		go func() {
			defer inFlight.Done()
			request := httptest.NewRequest(http.MethodGet, "/health", nil)
			request.RemoteAddr = remoteAddr
			limited.ServeHTTP(httptest.NewRecorder(), request)
		}()
	}

	serve(firstRemoteAddr)
	if got := <-entered; got != firstRemoteAddr {
		t.Fatalf("first handler entry from %q, want %q", got, firstRemoteAddr)
	}

	// The first request is now parked inside the handler. The limiter must not
	// still be holding its shared mutex.
	serve(secondRemoteAddr)
	select {
	case got := <-entered:
		if got != secondRemoteAddr {
			t.Fatalf("second handler entry from %q, want %q", got, secondRemoteAddr)
		}
	case <-time.After(handlerEntryTimeout):
		close(release)
		inFlight.Wait()
		t.Fatalf("an independent request from %s never reached the handler while a request from %s was still executing: "+
			"the rate limiter holds its shared mutex across next.ServeHTTP (rate_limit.go:31), so one slow request blocks every other route and client",
			secondRemoteAddr, firstRemoteAddr)
	}

	close(release)
	inFlight.Wait()
}

// TestRateLimiterKeysQuotaByNormalizedRemoteHost pins F-011 (a).
//
// A host that opens a fresh TCP connection per request - which is exactly what
// the one-command-per-process CLI does - must not receive a fresh quota each
// time. The key must be the normalized host from net.SplitHostPort.
func TestRateLimiterKeysQuotaByNormalizedRemoteHost(t *testing.T) {
	const limit = 3

	for _, host := range []string{"192.0.2.10", "[2001:db8::1]"} {
		t.Run(host, func(t *testing.T) {
			limiter := NewRateLimiter(limit)
			handler := limiter.Middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.WriteHeader(http.StatusOK)
			}))

			statuses := make([]int, 0, limit+1)
			for offset := 0; offset <= limit; offset++ {
				recorder := httptest.NewRecorder()
				request := httptest.NewRequest(http.MethodPost, "/v1/mailbox/poll", nil)
				// A new source port for every request: one host, many connections.
				request.RemoteAddr = fmt.Sprintf("%s:%d", host, 40000+offset)
				handler.ServeHTTP(recorder, request)
				statuses = append(statuses, recorder.Code)
			}

			for index := 0; index < limit; index++ {
				if statuses[index] != http.StatusOK {
					t.Fatalf("request %d of %d from host %s: status = %d, want %d", index+1, limit, host, statuses[index], http.StatusOK)
				}
			}
			if statuses[limit] != http.StatusTooManyRequests {
				t.Fatalf("request %d from host %s over %d separate connections: status = %d, want %d; "+
					"the quota key must be the normalized remote host (net.SplitHostPort), not the full r.RemoteAddr including the TCP source port (rate_limit.go:29)",
					limit+1, host, limit+1, statuses[limit], http.StatusTooManyRequests)
			}

			// An unrelated host must keep its own independent quota.
			recorder := httptest.NewRecorder()
			request := httptest.NewRequest(http.MethodPost, "/v1/mailbox/poll", nil)
			request.RemoteAddr = "203.0.113.9:40000"
			handler.ServeHTTP(recorder, request)
			if recorder.Code != http.StatusOK {
				t.Fatalf("first request from unrelated host 203.0.113.9: status = %d, want %d; quotas must be per host, not global", recorder.Code, http.StatusOK)
			}
		})
	}
}

// TestRateLimiterIgnoresForwardedHeadersByDefault pins the explicit
// trusted-proxy declaration required by F-011.
//
// Declared behaviour: the quota identity is derived from the transport peer
// host alone. Client-supplied forwarding headers are untrusted input and must
// never mint a new quota bucket. Any proxy-aware behaviour must be opt-in and
// configured with the trusted proxies, never inferred from the headers.
func TestRateLimiterIgnoresForwardedHeadersByDefault(t *testing.T) {
	const (
		limit = 3
		host  = "192.0.2.10"
	)

	limiter := NewRateLimiter(limit)
	handler := limiter.Middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))

	var lastStatus int
	for offset := 0; offset <= limit; offset++ {
		recorder := httptest.NewRecorder()
		request := httptest.NewRequest(http.MethodPost, "/v1/mailbox/poll", nil)
		request.RemoteAddr = fmt.Sprintf("%s:%d", host, 41000+offset)
		request.Header.Set("X-Forwarded-For", fmt.Sprintf("203.0.113.%d", offset+1))
		request.Header.Set("X-Real-IP", fmt.Sprintf("203.0.113.%d", offset+1))
		handler.ServeHTTP(recorder, request)
		lastStatus = recorder.Code
	}

	if lastStatus != http.StatusTooManyRequests {
		t.Fatalf("request %d from host %s carrying a distinct X-Forwarded-For each time: status = %d, want %d; "+
			"untrusted forwarding headers must not create a new quota bucket, and trusted-proxy handling must be explicit opt-in",
			limit+1, host, lastStatus, http.StatusTooManyRequests)
	}
}

// TestRateLimiterPrunesIdleBuckets pins F-011 (b): buckets whose window has
// long passed must be removed instead of accumulating for every observed
// client. Driven by an injected clock, never by sleeping.
func TestRateLimiterPrunesIdleBuckets(t *testing.T) {
	limiter := NewRateLimiter(5)

	seam, ok := any(limiter).(rateLimiterTestSeam)
	if !ok {
		t.Fatalf("*RateLimiter must expose the deterministic seam SetClock(func() time.Time) and TrackedClients() int " +
			"so idle-bucket expiry can be asserted without wall-clock sleeps: rate_limit.go calls time.Now() directly and never deletes a bucket")
	}

	base := time.Date(2026, 9, 6, 12, 0, 0, 0, time.UTC)
	current := base
	seam.SetClock(func() time.Time { return current })

	handler := limiter.Middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	serve := func(host string) {
		request := httptest.NewRequest(http.MethodPost, "/v1/mailbox/poll", nil)
		request.RemoteAddr = host + ":40000"
		handler.ServeHTTP(httptest.NewRecorder(), request)
	}

	idleHosts := []string{"192.0.2.10", "192.0.2.11", "192.0.2.12"}
	for _, host := range idleHosts {
		serve(host)
	}
	if got := seam.TrackedClients(); got != len(idleHosts) {
		t.Fatalf("tracked quota buckets = %d after %d distinct hosts, want %d", got, len(idleHosts), len(idleHosts))
	}

	// Every window has long since elapsed; a single later request must not
	// leave the three abandoned buckets behind.
	current = base.Add(30 * time.Minute)
	serve("203.0.113.4")

	if got := seam.TrackedClients(); got > 1 {
		t.Fatalf("tracked quota buckets = %d long after the idle hosts' windows expired, want at most 1: "+
			"idle buckets must be pruned instead of retained for every host and port ever observed", got)
	}
}
