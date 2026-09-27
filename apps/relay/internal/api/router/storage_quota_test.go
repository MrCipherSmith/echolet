package router

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"echolet/apps/relay/internal/config"
	"echolet/apps/relay/internal/storage"
)

// A relay at its storage cap must refuse what adds data and keep open what a
// recipient needs to drain its mailbox - otherwise a full relay can never empty.
func TestAFullRelayRefusesWritesButKeepsTheDrainPathOpen(t *testing.T) {
	st, err := storage.NewStorage(t.TempDir())
	if err != nil {
		t.Fatalf("NewStorage() error = %v", err)
	}
	t.Cleanup(func() { _ = st.Close() })

	// One byte: a freshly opened Badger directory is already larger than that.
	router := NewRouter(config.Config{RateLimitPerMinute: 1_000, MaxStorageBytes: 1}, st)
	t.Cleanup(router.Stop)

	post := func(path string) *httptest.ResponseRecorder {
		recorder := httptest.NewRecorder()
		request := httptest.NewRequest(http.MethodPost, path, strings.NewReader("{}"))
		request.Header.Set("Content-Type", "application/json")
		router.ServeHTTP(recorder, request)
		return recorder
	}

	for _, path := range []string{
		"/v1/device-records/publish",
		"/v1/prekeys/publish",
		"/v2/prekeys/publish",
		"/v2/prekeys/claim",
		"/v1/messages/send",
	} {
		if got := post(path).Code; got != http.StatusInsufficientStorage {
			t.Errorf("POST %s status = %d, want %d on a full relay", path, got, http.StatusInsufficientStorage)
		}
	}

	for _, path := range []string{"/v1/mailbox/challenge", "/v1/mailbox/poll", "/v1/mailbox/ack"} {
		if got := post(path).Code; got == http.StatusInsufficientStorage {
			t.Errorf("POST %s status = %d: the drain path must stay open on a full relay", path, got)
		}
	}
}
