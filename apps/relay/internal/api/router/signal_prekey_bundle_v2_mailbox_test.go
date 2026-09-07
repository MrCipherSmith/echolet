package router

import (
	"bytes"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"testing"
	"time"

	"echolet/apps/relay/internal/config"
	"echolet/apps/relay/internal/cryptoutil"
	"echolet/apps/relay/internal/storage"
)

func TestSignalV2PublishAuthorizesMailboxChallengeAcrossRestart(t *testing.T) {
	fixture := currentSignalV2RouterFixture(t, 33)
	dataDir := t.TempDir()

	st, err := storage.NewStorage(dataDir)
	if err != nil {
		t.Fatal(err)
	}
	r := NewRouter(signalV2RouterConfig(), st)
	assertRouterStatus(t, postRouterJSON(t, r, "/v2/prekeys/publish", fixture.request), http.StatusOK)
	assertRouterStatus(t, signedMailboxChallenge(t, r, fixture, fixture.devicePrivateKey), http.StatusOK)
	if err := st.Close(); err != nil {
		t.Fatal(err)
	}

	reopened, err := storage.NewStorage(dataDir)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	restartedRouter := NewRouter(signalV2RouterConfig(), reopened)

	wrongDeviceKey := seededPrivateKey(97)
	assertRouterError(t, signedMailboxChallenge(t, restartedRouter, fixture, wrongDeviceKey), http.StatusForbidden, "INVALID_SIGNATURE")
	assertRouterStatus(t, signedMailboxChallenge(t, restartedRouter, fixture, fixture.devicePrivateKey), http.StatusOK)
}

func TestFailedSignalV2PublishDoesNotAuthorizeMailboxChallenge(t *testing.T) {
	fixture := currentSignalV2RouterFixture(t, 33)
	fixture.bundle["signature"] = base64.RawURLEncoding.EncodeToString(make([]byte, ed25519.SignatureSize))
	fixture.request = marshalSignalV2PublishRequest(t, fixture.bundle)

	st, err := storage.NewStorage(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	r := NewRouter(signalV2RouterConfig(), st)

	assertRouterError(t, postRouterJSON(t, r, "/v2/prekeys/publish", fixture.request), http.StatusBadRequest, "INVALID_SIGNATURE")
	assertRouterError(t, signedMailboxChallenge(t, r, fixture, fixture.devicePrivateKey), http.StatusForbidden, "UNAUTHORIZED_MAILBOX_ACCESS")
}

func TestConflictingSignalV2PublishCannotReplaceMailboxAuthorization(t *testing.T) {
	original := currentSignalV2RouterFixture(t, 33)
	replacement := currentSignalV2RouterFixture(t, 97)

	st, err := storage.NewStorage(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	r := NewRouter(signalV2RouterConfig(), st)

	assertRouterStatus(t, postRouterJSON(t, r, "/v2/prekeys/publish", original.request), http.StatusOK)
	assertRouterError(t, postRouterJSON(t, r, "/v2/prekeys/publish", replacement.request), http.StatusConflict, "BUNDLE_ID_CONFLICT")
	assertRouterStatus(t, signedMailboxChallenge(t, r, original, original.devicePrivateKey), http.StatusOK)
	assertRouterError(t, signedMailboxChallenge(t, r, original, replacement.devicePrivateKey), http.StatusForbidden, "INVALID_SIGNATURE")
}

type signalV2RouterFixture struct {
	request          []byte
	bundle           map[string]any
	identityID       string
	deviceID         string
	devicePrivateKey ed25519.PrivateKey
}

func currentSignalV2RouterFixture(t *testing.T, deviceSeedStart byte) signalV2RouterFixture {
	t.Helper()

	_, file, _, _ := runtime.Caller(0)
	raw, err := os.ReadFile(filepath.Join(filepath.Dir(file), "../../../../../packages/protocol/src/types/fixtures/relay-v2.json"))
	if err != nil {
		t.Fatal(err)
	}
	var shared struct {
		ValidPublishRequest map[string]any `json:"valid_publish_request"`
	}
	if err := json.Unmarshal(raw, &shared); err != nil {
		t.Fatal(err)
	}
	bundle, ok := shared.ValidPublishRequest["bundle"].(map[string]any)
	if !ok {
		t.Fatal("shared valid_publish_request.bundle is not an object")
	}
	record, ok := bundle["device_record"].(map[string]any)
	if !ok {
		t.Fatal("shared valid_publish_request.bundle.device_record is not an object")
	}

	nowMS := time.Now().UnixMilli()
	bundle["created_at_ms"] = nowMS - 1_000
	bundle["expires_at_ms"] = nowMS + 24*60*60*1_000
	record["created_at_ms"] = nowMS - 1_000

	rootPrivateKey := seededPrivateKey(1)
	devicePrivateKey := seededPrivateKey(deviceSeedStart)
	devicePublicKey := devicePrivateKey.Public().(ed25519.PublicKey)
	record["device_pubkey"] = base64.RawURLEncoding.EncodeToString(devicePublicKey)
	canonicalRecord, err := cryptoutil.MarshalCanonicalJSONWithoutSignature(record)
	if err != nil {
		t.Fatal(err)
	}
	record["signature"] = base64.RawURLEncoding.EncodeToString(ed25519.Sign(rootPrivateKey, canonicalRecord))

	capabilities := record["capabilities"].(map[string]any)
	signedPreKey := bundle["signed_prekey"].(map[string]any)
	kyberPreKey := bundle["kyber_prekey"].(map[string]any)
	oneTimePreKey := bundle["one_time_prekey"].(map[string]any)
	transcript := []any{
		"echolet.signal.prekey_bundle.v2",
		bundle["bundle_id"],
		bundle["suite"],
		[]any{
			record["type"], record["version"], record["identity_id"], record["device_id"], record["device_pubkey"], record["device_label"],
			[]any{capabilities["mailbox_poll"], capabilities["receipts"], capabilities["attachments"]},
			record["created_at_ms"], record["signature"],
		},
		bundle["created_at_ms"],
		bundle["expires_at_ms"],
		bundle["registration_id"],
		bundle["signal_identity_key"],
		[]any{signedPreKey["key_id"], signedPreKey["public_key"], signedPreKey["signature"]},
		[]any{kyberPreKey["key_id"], kyberPreKey["public_key"], kyberPreKey["signature"]},
		[]any{oneTimePreKey["key_id"], oneTimePreKey["public_key"]},
	}
	transcriptJSON, err := json.Marshal(transcript)
	if err != nil {
		t.Fatal(err)
	}
	bundle["signature"] = base64.RawURLEncoding.EncodeToString(ed25519.Sign(devicePrivateKey, transcriptJSON))

	return signalV2RouterFixture{
		request:          marshalSignalV2PublishRequest(t, bundle),
		bundle:           bundle,
		identityID:       record["identity_id"].(string),
		deviceID:         record["device_id"].(string),
		devicePrivateKey: devicePrivateKey,
	}
}

func seededPrivateKey(first byte) ed25519.PrivateKey {
	seed := make([]byte, ed25519.SeedSize)
	for i := range seed {
		seed[i] = first + byte(i)
	}
	return ed25519.NewKeyFromSeed(seed)
}

func marshalSignalV2PublishRequest(t *testing.T, bundle map[string]any) []byte {
	t.Helper()
	raw, err := json.Marshal(map[string]any{"bundle": bundle})
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

func signedMailboxChallenge(t *testing.T, handler http.Handler, fixture signalV2RouterFixture, privateKey ed25519.PrivateKey) *httptest.ResponseRecorder {
	t.Helper()
	mailboxID := cryptoutil.DeriveMailboxID(fixture.identityID)
	message := cryptoutil.CreateMailboxCreateChallengeMessage(mailboxID, fixture.deviceID)
	payload, err := json.Marshal(map[string]string{
		"recipient_mailbox_id": mailboxID,
		"device_id":            fixture.deviceID,
		"signature":            base64.RawURLEncoding.EncodeToString(ed25519.Sign(privateKey, []byte(message))),
	})
	if err != nil {
		t.Fatal(err)
	}
	return postRouterJSON(t, handler, "/v1/mailbox/challenge", payload)
}

func postRouterJSON(t *testing.T, handler http.Handler, path string, body []byte) *httptest.ResponseRecorder {
	t.Helper()
	request := httptest.NewRequest(http.MethodPost, path, bytes.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	return response
}

func assertRouterStatus(t *testing.T, response *httptest.ResponseRecorder, want int) {
	t.Helper()
	if response.Code != want {
		t.Fatalf("status = %d, want %d: %s", response.Code, want, response.Body.String())
	}
}

func assertRouterError(t *testing.T, response *httptest.ResponseRecorder, wantStatus int, wantCode string) {
	t.Helper()
	assertRouterStatus(t, response, wantStatus)
	var parsed struct {
		Error struct {
			Code string `json:"code"`
		} `json:"error"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &parsed); err != nil {
		t.Fatal(err)
	}
	if parsed.Error.Code != wantCode {
		t.Fatalf("error code = %q, want %q: %s", parsed.Error.Code, wantCode, response.Body.String())
	}
}

func signalV2RouterConfig() config.Config {
	return config.Config{
		RateLimitPerMinute:  1_000,
		CleanupIntervalSec:  3_600,
		ChallengeTTLSeconds: 60,
		MaxMailboxBatch:     100,
		MaxMessageBytes:     262_144,
	}
}
