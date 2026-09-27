package middleware

import (
	"log/slog"
	"net/http"
	"sync/atomic"
)

// StorageQuota refuses writes once the store has reached ECHOLET_MAX_STORAGE_BYTES.
//
// The disk is measured periodically (Refresh), and every admitted write adds its
// request size to the figure until the next measurement, so a burst between two
// measurements is counted rather than let through unseen. Reads and the mailbox
// challenge/poll/ack routes are never wrapped: a full relay must still let
// recipients drain and acknowledge, because that is what frees space.
type StorageQuota struct {
	maxBytes int64
	measure  func() (int64, error)
	used     atomic.Int64
}

// NewStorageQuota builds a quota over measure. A maxBytes of zero or less
// disables it, which is what a Config nobody filled in describes.
func NewStorageQuota(maxBytes int64, measure func() (int64, error)) *StorageQuota {
	return &StorageQuota{maxBytes: maxBytes, measure: measure}
}

// Refresh replaces the running estimate with a fresh measurement. A failed
// measurement keeps the previous estimate rather than resetting it to zero,
// which would silently lift the cap.
func (q *StorageQuota) Refresh() {
	if q.maxBytes <= 0 {
		return
	}
	used, err := q.measure()
	if err != nil {
		slog.Warn("storage usage measurement failed; keeping previous estimate", "error", err)
		return
	}
	q.used.Store(used)
	if used >= q.maxBytes {
		slog.Warn("storage cap reached; refusing writes until space is reclaimed",
			"used_bytes", used, "max_bytes", q.maxBytes)
	}
}

// Exhausted reports whether the store has reached its cap.
func (q *StorageQuota) Exhausted() bool {
	return q.maxBytes > 0 && q.used.Load() >= q.maxBytes
}

func (q *StorageQuota) Middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if q.Exhausted() {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusInsufficientStorage)
			_, _ = w.Write([]byte(`{"ok":false,"error":{"code":"STORAGE_FULL","message":"relay storage is full"}}`))
			return
		}
		if q.maxBytes > 0 && r.ContentLength > 0 {
			q.used.Add(r.ContentLength)
		}
		next.ServeHTTP(w, r)
	})
}
