package handler

import (
	"bytes"
	"echolet/apps/relay/internal/service"
	"echolet/apps/relay/internal/storage"
	"echolet/apps/relay/internal/storage/repository"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestSignalV2HTTPPublishClaimAndErrors(t *testing.T) {
	st, err := storage.NewStorage(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	h := NewPreKeyBundleHandler(service.NewPreKeyBundleService(repository.NewPreKeyBundleRepository(st)))
	_, file, _, _ := runtime.Caller(0)
	raw, err := os.ReadFile(filepath.Join(filepath.Dir(file), "../../../../../packages/protocol/src/types/fixtures/relay-v2.json"))
	if err != nil {
		t.Fatal(err)
	}
	var fixture struct {
		Now     int64           `json:"now_ms"`
		Request json.RawMessage `json:"valid_publish_request"`
	}
	if err := json.Unmarshal(raw, &fixture); err != nil {
		t.Fatal(err)
	}
	h.nowMS = func() int64 { return fixture.Now }
	var request struct {
		Bundle json.RawMessage `json:"bundle"`
	}
	_ = json.Unmarshal(fixture.Request, &request)
	var bundle struct {
		Record struct {
			Identity string `json:"identity_id"`
			Device   string `json:"device_id"`
		} `json:"device_record"`
	}
	_ = json.Unmarshal(request.Bundle, &bundle)
	invoke := func(fn http.HandlerFunc, body []byte, want int, code string) *httptest.ResponseRecorder {
		t.Helper()
		w := httptest.NewRecorder()
		fn(w, httptest.NewRequest("POST", "/", bytes.NewReader(body)))
		if w.Code != want {
			t.Fatalf("status %d want %d: %s", w.Code, want, w.Body.String())
		}
		if code != "" && !bytes.Contains(w.Body.Bytes(), []byte(`"code":"`+code+`"`)) {
			t.Fatalf("missing code %s: %s", code, w.Body.String())
		}
		return w
	}
	invoke(h.PublishSignalPreKeyBundleV2, fixture.Request, 200, "")
	invoke(h.PublishSignalPreKeyBundleV2, fixture.Request, 200, "")
	for _, body := range []string{`{}`, `{"bundle":null}`, `{"bundle":{},"extra":1}`, `{"bundle":{},"bundle":{}}`, `{"bundle":{}} {}`} {
		invoke(h.PublishSignalPreKeyBundleV2, []byte(body), 400, "INVALID_SCHEMA")
	}
	claim := []byte(`{"claim_id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","identity_id":"` + bundle.Record.Identity + `","device_id":null}`)
	first := invoke(h.ClaimSignalPreKeyBundleV2, claim, 200, "")
	replay := invoke(h.ClaimSignalPreKeyBundleV2, claim, 200, "")
	if !bytes.Equal(first.Body.Bytes(), replay.Body.Bytes()) {
		t.Fatal("replay changed bytes")
	}
	var received struct {
		Data struct {
			Bundle json.RawMessage `json:"bundle"`
		} `json:"data"`
	}
	_ = json.Unmarshal(first.Body.Bytes(), &received)
	if !bytes.Equal(received.Data.Bundle, request.Bundle) {
		t.Fatal("HTTP claim compacted or reordered signed bundle")
	}
	conflict := bytes.Replace(claim, []byte(`"device_id":null`), []byte(`"device_id":"`+bundle.Record.Device+`"`), 1)
	invoke(h.ClaimSignalPreKeyBundleV2, conflict, 409, "CLAIM_ID_CONFLICT")
	unavailable := bytes.Replace(claim, []byte("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"), []byte("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"), 1)
	invoke(h.ClaimSignalPreKeyBundleV2, unavailable, 404, "PREKEY_BUNDLE_UNAVAILABLE")
	invoke(h.ClaimSignalPreKeyBundleV2, []byte(`{"claim_id":"bad","identity_id":"bad","device_id":null}`), 400, "INVALID_SCHEMA")
	h.nowMS = func() int64 { return fixture.Now + 8*24*60*60*1000 }
	invoke(h.PublishSignalPreKeyBundleV2, fixture.Request, 400, "BUNDLE_EXPIRED")
}

func TestSignalV2PublishResponseIncludesValidatedBundleID(t *testing.T) {
	st, err := storage.NewStorage(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	h := NewPreKeyBundleHandler(service.NewPreKeyBundleService(repository.NewPreKeyBundleRepository(st)))

	_, file, _, _ := runtime.Caller(0)
	raw, err := os.ReadFile(filepath.Join(filepath.Dir(file), "../../../../../packages/protocol/src/types/fixtures/relay-v2.json"))
	if err != nil {
		t.Fatal(err)
	}
	var fixture struct {
		Now     int64           `json:"now_ms"`
		Request json.RawMessage `json:"valid_publish_request"`
	}
	if err := json.Unmarshal(raw, &fixture); err != nil {
		t.Fatal(err)
	}
	h.nowMS = func() int64 { return fixture.Now }
	var published struct {
		Bundle struct {
			BundleID string `json:"bundle_id"`
		} `json:"bundle"`
	}
	if err := json.Unmarshal(fixture.Request, &published); err != nil {
		t.Fatal(err)
	}

	w := httptest.NewRecorder()
	h.PublishSignalPreKeyBundleV2(w, httptest.NewRequest(http.MethodPost, "/v2/prekeys/publish", bytes.NewReader(fixture.Request)))
	if w.Code != http.StatusOK {
		t.Fatalf("publish status = %d, want %d: %s", w.Code, http.StatusOK, w.Body.String())
	}
	var response struct {
		OK   bool `json:"ok"`
		Data struct {
			Stored   bool   `json:"stored"`
			BundleID string `json:"bundle_id"`
		} `json:"data"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &response); err != nil {
		t.Fatalf("decode publish response: %v", err)
	}
	if !response.OK || !response.Data.Stored || response.Data.BundleID != published.Bundle.BundleID {
		t.Fatalf("publish response = %+v, want ok=true stored=true bundle_id=%q", response, published.Bundle.BundleID)
	}
}
