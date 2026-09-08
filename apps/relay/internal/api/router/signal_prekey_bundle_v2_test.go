package router

import (
	"echolet/apps/relay/internal/config"
	"echolet/apps/relay/internal/storage"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestSignalV2RoutesAreAdditive(t *testing.T) {
	st, err := storage.NewStorage(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	// CleanupIntervalSec is gone from Config (flow 003, T33). It was only ever
	// here to keep NewRouter's ticker off a zero interval; the cleanup service now
	// owns its own period, so there is nothing to set. See
	// TestNewRouterStartsACleanupTickerWithoutAConfiguredInterval.
	r := NewRouter(config.Config{RateLimitPerMinute: 1000}, st)
	for _, path := range []string{"/v2/prekeys/publish", "/v2/prekeys/claim", "/v1/prekeys/publish"} {
		w := httptest.NewRecorder()
		r.ServeHTTP(w, httptest.NewRequest("POST", path, strings.NewReader(`{}`)))
		if w.Code != 400 {
			t.Fatalf("%s: %d", path, w.Code)
		}
	}
	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest("GET", "/health", nil))
	if w.Code != 200 {
		t.Fatalf("health: %d", w.Code)
	}
}
