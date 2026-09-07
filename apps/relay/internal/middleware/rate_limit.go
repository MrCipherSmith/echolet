package middleware

import (
	"net"
	"net/http"
	"sync"
	"time"
)

// rateLimitWindow is the length of one quota window.
const rateLimitWindow = time.Minute

// idleBucketPruneInterval bounds how often the limiter sweeps expired quota
// buckets. Without a sweep the map grows once per distinct client host ever
// observed and is never reclaimed.
const idleBucketPruneInterval = time.Minute

// RateLimiter applies a per-host request quota.
//
// Quota identity is the transport peer host alone, taken from r.RemoteAddr via
// net.SplitHostPort. Client-supplied forwarding headers (X-Forwarded-For,
// X-Real-IP) are untrusted input and are deliberately never consulted: honouring
// them would let any client mint an unlimited number of fresh quota buckets by
// varying a header it controls. Running the relay behind a reverse proxy
// therefore requires explicit opt-in support configured with the set of trusted
// proxies; it is never inferred from the presence of a header.
type RateLimiter struct {
	clients     map[string]*clientRecord
	mu          sync.Mutex
	limit       int
	now         func() time.Time
	lastPruneAt time.Time
}

type clientRecord struct {
	count   int
	resetAt time.Time
}

func NewRateLimiter(limit int) *RateLimiter {
	return &RateLimiter{
		clients: make(map[string]*clientRecord),
		limit:   limit,
		now:     time.Now,
	}
}

// SetClock replaces the limiter's time source. It exists so window expiry and
// idle-bucket pruning can be exercised deterministically instead of by sleeping.
func (rl *RateLimiter) SetClock(now func() time.Time) {
	if now == nil {
		return
	}
	rl.mu.Lock()
	defer rl.mu.Unlock()
	rl.now = now
}

// TrackedClients reports how many quota buckets are currently retained.
func (rl *RateLimiter) TrackedClients() int {
	rl.mu.Lock()
	defer rl.mu.Unlock()
	return len(rl.clients)
}

func (rl *RateLimiter) Middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// The quota decision is taken under the lock and the lock is released
		// before anything slow happens. Holding it across next.ServeHTTP would
		// serialize every route and every client behind the slowest request in
		// flight.
		if rl.allow(quotaKey(r.RemoteAddr)) {
			next.ServeHTTP(w, r)
			return
		}

		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusTooManyRequests)
		_, _ = w.Write([]byte(`{"ok":false,"error":{"code":"RATE_LIMITED","message":"rate limit exceeded"}}`))
	})
}

// allow accounts one request against the caller's quota and reports whether it
// may proceed. It performs no I/O, so the lock is held for a bounded amount of
// work only.
func (rl *RateLimiter) allow(key string) bool {
	rl.mu.Lock()
	defer rl.mu.Unlock()

	now := rl.now()
	rl.pruneLocked(now)

	record, exists := rl.clients[key]
	if !exists || now.After(record.resetAt) {
		rl.clients[key] = &clientRecord{count: 1, resetAt: now.Add(rateLimitWindow)}
		return true
	}

	record.count++
	return record.count <= rl.limit
}

// pruneLocked drops buckets whose window has elapsed. Callers must hold rl.mu.
func (rl *RateLimiter) pruneLocked(now time.Time) {
	if now.Sub(rl.lastPruneAt) < idleBucketPruneInterval {
		return
	}
	rl.lastPruneAt = now

	for key, record := range rl.clients {
		if now.After(record.resetAt) {
			delete(rl.clients, key)
		}
	}
}

// quotaKey normalizes a transport peer address to its host. The TCP source port
// must never be part of the key: a client that opens a fresh connection per
// request - which is exactly what the one-command-per-process CLI does - would
// otherwise receive a brand new quota every time.
func quotaKey(remoteAddr string) string {
	host, _, err := net.SplitHostPort(remoteAddr)
	if err != nil {
		// No port to strip (or an address shape we do not recognise): use the
		// value as given rather than inventing one.
		host = remoteAddr
	}
	// Canonicalize IP literals so different spellings of one address (for
	// example an IPv6 form with or without zero compression) share a bucket.
	if ip := net.ParseIP(host); ip != nil {
		return ip.String()
	}
	return host
}
