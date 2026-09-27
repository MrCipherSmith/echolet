package middleware

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func quotaRequest(t *testing.T, quota *StorageQuota, body string) *httptest.ResponseRecorder {
	t.Helper()
	next := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusOK) })
	recorder := httptest.NewRecorder()
	quota.Middleware(next).ServeHTTP(recorder, httptest.NewRequest(http.MethodPost, "/v1/messages/send", strings.NewReader(body)))
	return recorder
}

func TestStorageQuotaAdmitsWritesBelowTheCap(t *testing.T) {
	quota := NewStorageQuota(1000, func() (int64, error) { return 100, nil })
	quota.Refresh()

	if got := quotaRequest(t, quota, "{}").Code; got != http.StatusOK {
		t.Fatalf("status = %d, want %d below the cap", got, http.StatusOK)
	}
}

func TestStorageQuotaRefusesWritesOnceMeasuredUsageReachesTheCap(t *testing.T) {
	quota := NewStorageQuota(1000, func() (int64, error) { return 1000, nil })
	quota.Refresh()

	response := quotaRequest(t, quota, "{}")
	if response.Code != http.StatusInsufficientStorage {
		t.Fatalf("status = %d, want %d at the cap", response.Code, http.StatusInsufficientStorage)
	}
	if !strings.Contains(response.Body.String(), `"STORAGE_FULL"`) {
		t.Fatalf("body = %s, want error code STORAGE_FULL", response.Body.String())
	}
}

func TestStorageQuotaCountsAdmittedWritesUntilTheNextMeasurement(t *testing.T) {
	quota := NewStorageQuota(1000, func() (int64, error) { return 900, nil })
	quota.Refresh()

	body := strings.Repeat("x", 150)
	if got := quotaRequest(t, quota, body).Code; got != http.StatusOK {
		t.Fatalf("first write status = %d, want %d", got, http.StatusOK)
	}
	// 900 measured + 150 admitted crosses the cap before any re-measurement.
	if got := quotaRequest(t, quota, body).Code; got != http.StatusInsufficientStorage {
		t.Fatalf("second write status = %d, want %d once admitted bytes reach the cap", got, http.StatusInsufficientStorage)
	}
}

func TestStorageQuotaReopensWhenAMeasurementShowsSpaceWasReclaimed(t *testing.T) {
	used := int64(1000)
	quota := NewStorageQuota(1000, func() (int64, error) { return used, nil })
	quota.Refresh()
	if !quota.Exhausted() {
		t.Fatal("precondition: quota should be exhausted")
	}

	used = 400
	quota.Refresh()
	if got := quotaRequest(t, quota, "{}").Code; got != http.StatusOK {
		t.Fatalf("status = %d after space was reclaimed, want %d", got, http.StatusOK)
	}
}

func TestStorageQuotaKeepsItsEstimateWhenAMeasurementFails(t *testing.T) {
	fail := false
	quota := NewStorageQuota(1000, func() (int64, error) {
		if fail {
			return 0, errors.New("disk unreadable")
		}
		return 1000, nil
	})
	quota.Refresh()

	fail = true
	quota.Refresh()
	if !quota.Exhausted() {
		t.Fatal("a failed measurement lifted the cap; it must keep the previous estimate")
	}
}

func TestStorageQuotaIsDisabledWithoutAConfiguredCap(t *testing.T) {
	quota := NewStorageQuota(0, func() (int64, error) { return 1 << 40, nil })
	quota.Refresh()

	if got := quotaRequest(t, quota, "{}").Code; got != http.StatusOK {
		t.Fatalf("status = %d with no cap configured, want %d", got, http.StatusOK)
	}
}
