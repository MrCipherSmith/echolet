//go:build relayv2

package repository_test

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"

	"echolet/apps/relay/internal/service"
	"echolet/apps/relay/internal/storage"
	"echolet/apps/relay/internal/storage/repository"
)

// relayV2Service is the API the GREEN implementation must provide. Keeping the
// contract in the RED test lets the existing v1 implementation continue to
// compile and run when the relayv2 build tag is omitted.
type relayV2Service interface {
	PublishSignalPreKeyBundleV2(bundleJSON []byte, nowMS int64) error
	ClaimSignalPreKeyBundleV2(claimID, identityID string, deviceID *string, nowMS int64) ([]byte, error)
}

type fixtureMutation struct {
	Path  string `json:"path"`
	Value any    `json:"value"`
}

type fixtureCase struct {
	Name      string            `json:"name"`
	ErrorCode string            `json:"error_code"`
	Mutations []fixtureMutation `json:"mutations"`
}

type relayV2Fixtures struct {
	NowMS                 int64           `json:"now_ms"`
	ValidPublishRequest   json.RawMessage `json:"valid_publish_request"`
	ValidVariants         []fixtureCase   `json:"valid_variants"`
	InvalidPublishRequest []fixtureCase   `json:"invalid_publish_requests"`
}

func TestSignalPreKeyBundleV2SharedFixtures(t *testing.T) {
	fixtures := loadRelayV2Fixtures(t)

	t.Run("valid non-schema-order capabilities", func(t *testing.T) {
		v2, closeStore := openRelayV2Service(t, t.TempDir())
		defer closeStore()
		if err := v2.PublishSignalPreKeyBundleV2(bundleFromRequest(t, fixtures.ValidPublishRequest), fixtures.NowMS); err != nil {
			t.Fatalf("PublishSignalPreKeyBundleV2(valid fixture) error = %v", err)
		}
	})

	for _, testCase := range fixtures.InvalidPublishRequest {
		t.Run(testCase.Name, func(t *testing.T) {
			v2, closeStore := openRelayV2Service(t, t.TempDir())
			defer closeStore()
			request := applyFixtureMutations(t, fixtures.ValidPublishRequest, testCase.Mutations)
			err := v2.PublishSignalPreKeyBundleV2(bundleFromRequest(t, request), fixtures.NowMS)
			assertErrorCode(t, err, testCase.ErrorCode)
		})
	}
}

func TestSignalPreKeyBundleV2PublishIsImmutableAndIdempotent(t *testing.T) {
	fixtures := loadRelayV2Fixtures(t)
	v2, closeStore := openRelayV2Service(t, t.TempDir())
	defer closeStore()
	primary := bundleFromRequest(t, fixtures.ValidPublishRequest)

	if err := v2.PublishSignalPreKeyBundleV2(primary, fixtures.NowMS); err != nil {
		t.Fatalf("first publish error = %v", err)
	}
	if err := v2.PublishSignalPreKeyBundleV2(primary, fixtures.NowMS); err != nil {
		t.Fatalf("byte-identical publish must be idempotent: %v", err)
	}

	changed := bundleFromVariant(t, fixtures, "changed_same_bundle_id")
	assertErrorCode(t, v2.PublishSignalPreKeyBundleV2(changed, fixtures.NowMS), "BUNDLE_ID_CONFLICT")
}

func TestSignalPreKeyBundleV2OneTimePreKeyReservationsArePermanent(t *testing.T) {
	fixtures := loadRelayV2Fixtures(t)
	primary := bundleFromRequest(t, fixtures.ValidPublishRequest)

	for _, variantName := range []string{"new_bundle_same_otk", "new_bundle_same_otk_key_id", "new_bundle_same_otk_tuple"} {
		t.Run(variantName, func(t *testing.T) {
			v2, closeStore := openRelayV2Service(t, t.TempDir())
			defer closeStore()
			if err := v2.PublishSignalPreKeyBundleV2(primary, fixtures.NowMS); err != nil {
				t.Fatal(err)
			}
			assertErrorCode(t, v2.PublishSignalPreKeyBundleV2(bundleFromVariant(t, fixtures, variantName), fixtures.NowMS), "ONE_TIME_PREKEY_REUSED")
		})
	}

	t.Run("after expiry", func(t *testing.T) {
		v2, closeStore := openRelayV2Service(t, t.TempDir())
		defer closeStore()
		if err := v2.PublishSignalPreKeyBundleV2(primary, fixtures.NowMS); err != nil {
			t.Fatal(err)
		}
		later := fixtures.NowMS + 2*24*60*60*1000
		assertErrorCode(t, v2.PublishSignalPreKeyBundleV2(bundleFromVariant(t, fixtures, "expired_tombstone_reuse"), later), "ONE_TIME_PREKEY_REUSED")
	})

	t.Run("after claim and restart", func(t *testing.T) {
		dir := t.TempDir()
		v2, closeStore := openRelayV2Service(t, dir)
		if err := v2.PublishSignalPreKeyBundleV2(primary, fixtures.NowMS); err != nil {
			t.Fatal(err)
		}
		if _, err := v2.ClaimSignalPreKeyBundleV2("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", fixtureIdentity(t, primary), nil, fixtures.NowMS); err != nil {
			t.Fatalf("claim error = %v", err)
		}
		closeStore()

		reopened, closeReopened := openRelayV2Service(t, dir)
		defer closeReopened()
		assertErrorCode(t, reopened.PublishSignalPreKeyBundleV2(bundleFromVariant(t, fixtures, "new_bundle_same_otk"), fixtures.NowMS), "ONE_TIME_PREKEY_REUSED")
	})
}

func TestSignalPreKeyBundleV2ConcurrentClaimsAllocateExactlyOnce(t *testing.T) {
	fixtures := loadRelayV2Fixtures(t)
	v2, closeStore := openRelayV2Service(t, t.TempDir())
	defer closeStore()
	primary := bundleFromRequest(t, fixtures.ValidPublishRequest)
	identityID := fixtureIdentity(t, primary)
	if err := v2.PublishSignalPreKeyBundleV2(primary, fixtures.NowMS); err != nil {
		t.Fatal(err)
	}

	const claimants = 20
	start := make(chan struct{})
	results := make(chan error, claimants)
	var ready sync.WaitGroup
	ready.Add(claimants)
	for index := 0; index < claimants; index++ {
		go func(index int) {
			ready.Done()
			<-start
			claimID := fmt.Sprintf("%08d-0000-4000-8000-%012d", index+1, index+1)
			claimed, err := v2.ClaimSignalPreKeyBundleV2(claimID, identityID, nil, fixtures.NowMS)
			if err == nil && !bytes.Equal(claimed, primary) {
				err = fmt.Errorf("claim returned changed bytes")
			}
			results <- err
		}(index)
	}
	ready.Wait()
	close(start)

	successes := 0
	for index := 0; index < claimants; index++ {
		err := <-results
		if err == nil {
			successes++
			continue
		}
		if !strings.Contains(err.Error(), "PREKEY_BUNDLE_UNAVAILABLE") {
			t.Errorf("unexpected claim error = %v", err)
		}
	}
	if successes != 1 {
		t.Fatalf("successful claims = %d, want exactly 1", successes)
	}
}

func TestSignalPreKeyBundleV2ClaimReplayIsExactAndSelectorBound(t *testing.T) {
	fixtures := loadRelayV2Fixtures(t)
	v2, closeStore := openRelayV2Service(t, t.TempDir())
	defer closeStore()
	primary := bundleFromRequest(t, fixtures.ValidPublishRequest)
	if err := v2.PublishSignalPreKeyBundleV2(primary, fixtures.NowMS); err != nil {
		t.Fatal(err)
	}

	claimID := "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
	identityID := fixtureIdentity(t, primary)
	first, err := v2.ClaimSignalPreKeyBundleV2(claimID, identityID, nil, fixtures.NowMS)
	if err != nil {
		t.Fatalf("first claim error = %v", err)
	}
	second, err := v2.ClaimSignalPreKeyBundleV2(claimID, identityID, nil, fixtures.NowMS+1)
	if err != nil {
		t.Fatalf("claim replay error = %v", err)
	}
	if !bytes.Equal(first, second) || !bytes.Equal(first, primary) {
		t.Fatalf("claim replay changed stored bytes")
	}

	deviceID := fixtureDevice(t, primary)
	_, err = v2.ClaimSignalPreKeyBundleV2(claimID, identityID, &deviceID, fixtures.NowMS+2)
	assertErrorCode(t, err, "CLAIM_ID_CONFLICT")
}

func openRelayV2Service(t *testing.T, dir string) (relayV2Service, func()) {
	t.Helper()
	store, err := storage.NewStorage(dir)
	if err != nil {
		t.Fatal(err)
	}
	legacy := service.NewPreKeyBundleService(repository.NewPreKeyBundleRepository(store))
	v2, ok := any(legacy).(relayV2Service)
	if !ok {
		_ = store.Close()
		t.Fatal("PreKeyBundleService does not implement relay v2 publish/claim API")
	}
	return v2, func() {
		if err := store.Close(); err != nil {
			t.Errorf("close storage: %v", err)
		}
	}
}

func loadRelayV2Fixtures(t *testing.T) relayV2Fixtures {
	t.Helper()
	_, currentFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("runtime.Caller failed")
	}
	path := filepath.Join(filepath.Dir(currentFile), "../../../../../packages/protocol/src/types/fixtures/relay-v2.json")
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read shared fixtures: %v", err)
	}
	var fixtures relayV2Fixtures
	if err := json.Unmarshal(raw, &fixtures); err != nil {
		t.Fatalf("decode shared fixtures: %v", err)
	}
	return fixtures
}

func bundleFromVariant(t *testing.T, fixtures relayV2Fixtures, name string) []byte {
	t.Helper()
	for _, variant := range fixtures.ValidVariants {
		if variant.Name == name {
			return bundleFromRequest(t, applyFixtureMutations(t, fixtures.ValidPublishRequest, variant.Mutations))
		}
	}
	t.Fatalf("fixture variant %q not found", name)
	return nil
}

func applyFixtureMutations(t *testing.T, raw json.RawMessage, mutations []fixtureMutation) json.RawMessage {
	t.Helper()
	// Preserve untouched nested object order: the legacy DeviceRecord signature
	// authenticates capabilities insertion order. map[string]any destroyed it.
	var replace func(json.RawMessage, []string, any) json.RawMessage
	replace = func(input json.RawMessage, path []string, value any) json.RawMessage {
		var object map[string]json.RawMessage
		if err := json.Unmarshal(input, &object); err != nil {
			t.Fatal(err)
		}
		if len(path) == 1 {
			encoded, err := json.Marshal(value)
			if err != nil {
				t.Fatal(err)
			}
			object[path[0]] = encoded
		} else {
			object[path[0]] = replace(object[path[0]], path[1:], value)
		}
		encoded, err := json.Marshal(object)
		if err != nil {
			t.Fatal(err)
		}
		return encoded
	}
	for _, mutation := range mutations {
		raw = replace(raw, strings.Split(mutation.Path, "."), mutation.Value)
	}
	return raw
}

func bundleFromRequest(t *testing.T, request json.RawMessage) []byte {
	t.Helper()
	var envelope struct {
		Bundle json.RawMessage `json:"bundle"`
	}
	if err := json.Unmarshal(request, &envelope); err != nil {
		t.Fatal(err)
	}
	if len(envelope.Bundle) == 0 {
		t.Fatal("fixture request has no bundle")
	}
	return []byte(envelope.Bundle)
}

func fixtureIdentity(t *testing.T, bundle []byte) string {
	t.Helper()
	var value struct {
		DeviceRecord struct {
			IdentityID string `json:"identity_id"`
			DeviceID   string `json:"device_id"`
		} `json:"device_record"`
	}
	if err := json.Unmarshal(bundle, &value); err != nil {
		t.Fatal(err)
	}
	return value.DeviceRecord.IdentityID
}

func fixtureDevice(t *testing.T, bundle []byte) string {
	t.Helper()
	var value struct {
		DeviceRecord struct {
			DeviceID string `json:"device_id"`
		} `json:"device_record"`
	}
	if err := json.Unmarshal(bundle, &value); err != nil {
		t.Fatal(err)
	}
	return value.DeviceRecord.DeviceID
}

func assertErrorCode(t *testing.T, err error, code string) {
	t.Helper()
	if err == nil || !strings.Contains(err.Error(), code) {
		t.Fatalf("error = %v, want code %s", err, code)
	}
}
