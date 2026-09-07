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
	r := NewRouter(config.Config{RateLimitPerMinute: 1000, CleanupIntervalSec: 3600}, st)
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
