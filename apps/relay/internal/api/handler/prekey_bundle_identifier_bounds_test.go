package handler

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"net/http"
	"strings"
	"testing"

	"echolet/apps/relay/internal/cryptoutil"
	"echolet/apps/relay/internal/model"
	"echolet/apps/relay/internal/service"
	"echolet/apps/relay/internal/storage"
	"echolet/apps/relay/internal/storage/repository"
)

// RED tests for residual RI-19 (flow 003 T1 inventory; originally T48-004).
//
// The v1 prekey-bundle route is the last write path that puts an unbounded
// caller-supplied string into a Badger key. ValidatePreKeyBundle
// (internal/validation/validate.go:51-87) checks `identity_id`, `device_id` and
// `bundle_id` for non-emptiness ONLY - it applies MaxIdentifierBytes to none of
// them - while PreKeyBundleRepository.Save
// (internal/storage/repository/prekey_bundle_repo.go:28) builds the key
//
//	prekey_bundle:<identity_id>:<bundle_id>
//
// from two of them. Badger's own key ceiling then answers malformed client input
// with HTTP 500, which is exactly the BE-R-001 / F-006 defect already closed on
// /v1/device-records/publish and /v1/mailbox/ack
// (see identifier_bounds_test.go in this package). `/v1/prekeys/publish` is still
// mounted at internal/api/router/router.go:68.
//
// WHERE THE BOUNDS AND SHAPES COME FROM. Nothing here invents a new rule; every
// value used below is transcribed from a rule the relay already enforces
// elsewhere, so the fix can reuse them verbatim:
//
//   - the length bound: validation.MaxIdentifierBytes = 256
//     (internal/validation/validate.go:110), applied by ValidateDeviceRecord at
//     validate.go:30-37 and by ValidateMailboxEnvelope at validate.go:178-182.
//   - the shapes the v2 prekey path already requires
//     (internal/validation/signal_prekey_bundle_v2.go:148-152, 167, 181):
//     `bundle_id` and `device_id` are UUIDs (uuidV2), and `identity_id` is a
//     32-byte raw base64url ed25519 key (b64(identityID, 32, -1)), i.e. the
//     43-character form the CLI already sends.
//
// These tests deliberately pin NO particular maximum and no particular shape
// rule. They require only what the defect is about: an over-long identifier must
// be refused as client input with a bounded 4xx and a typed client error code,
// never a 500, and nothing may be stored - while a bundle carrying exactly the
// shapes the v2 path accepts must still be published, so the bound cannot be
// obtained by refusing the route outright.
//
// Identifier values below are synthetic padding. No key material, no store key
// and no request body is ever printed; only field names, lengths, status codes
// and error codes appear in failure output.

// oversizedPreKeyIdentifierBytes is comfortably past Badger's key ceiling
// (65000 bytes) and past MaxIdentifierBytes by more than two orders of
// magnitude, while staying far inside envelopeRequestBodyLimit (1 MiB) so the
// body itself is never what is being refused.
const oversizedPreKeyIdentifierBytes = 65000

// The three shapes the v2 path accepts, reused here as the control values.
const (
	controlPreKeyBundleID = "bf705c17-25fe-44e5-aec2-ef94d8de7796"
	controlPreKeyDeviceID = "8cc8010b-d4a1-4ce7-8203-a8f6b055c1b9"
)

func TestPublishPreKeyBundleRejectsOversizedIdentifiersWithClientError(t *testing.T) {
	for _, testCase := range []struct {
		field string
		why   string
	}{
		{
			field: "bundle_id",
			why: "bundle_id is the second half of the Badger key " +
				"prekey_bundle:<identity_id>:<bundle_id> and is validated nowhere",
		},
		{
			field: "device_id",
			why: "device_id is signed into the bundle and stored unbounded; " +
				"ValidatePreKeyBundle checks only that it is non-empty",
		},
		// identity_id is already refused today, but only incidentally: it doubles
		// as the verification key at validate.go:44, so an over-long value fails
		// signature verification before it can reach a store key. That is a
		// coincidence of this route's shape, not a bound - it would evaporate the
		// moment identity_id stopped being the key. This case is kept as a
		// standing guard that it never regresses into a 500.
		{
			field: "identity_id",
			why:   "identity_id is the first half of the same Badger key",
		},
	} {
		t.Run(testCase.field, func(t *testing.T) {
			handler, preKeyService := newPreKeyBundleTestHarness(t)

			bundle := signedPreKeyBundle(t, preKeyBundleIdentifiers{
				bundleID:   controlPreKeyBundleID,
				deviceID:   controlPreKeyDeviceID,
				oversized:  testCase.field,
				identityID: "",
			})
			response := postJSON(t, http.HandlerFunc(handler.PublishPreKeyBundle), map[string]any{"bundle": bundle})

			if response.Code >= http.StatusInternalServerError {
				t.Fatalf("PublishPreKeyBundle(%s length %d) status = %d, want a bounded 4xx: %s, "+
					"so an identifier that cannot fit a store key must be refused by validation instead of "+
					"surfacing as an internal error (error code %q)",
					testCase.field, oversizedPreKeyIdentifierBytes, response.Code, testCase.why,
					mailboxErrorCode(t, response))
			}
			if response.Code < http.StatusBadRequest {
				t.Fatalf("PublishPreKeyBundle(%s length %d) status = %d, want a 4xx rejection: %s. "+
					"Accepting it stores an unbounded caller-supplied identifier; the sibling routes "+
					"/v1/device-records/publish and /v1/mailbox/ack already refuse this",
					testCase.field, oversizedPreKeyIdentifierBytes, response.Code, testCase.why)
			}
			if code := mailboxErrorCode(t, response); code == "" || code == "INTERNAL_ERROR" {
				t.Fatalf("PublishPreKeyBundle(%s length %d) error code = %q, want a typed client-error code",
					testCase.field, oversizedPreKeyIdentifierBytes, code)
			}

			// Nothing may be stored. The refused bundle must not be retrievable
			// under the identity it claimed.
			stored, err := preKeyService.GetPreKeyBundles(bundle.IdentityID)
			if err != nil {
				t.Fatalf("GetPreKeyBundles() error = %v", err)
			}
			if len(stored) != 0 {
				t.Fatalf("PublishPreKeyBundle(%s length %d) was refused but %d bundle(s) are stored under that identity, want 0",
					testCase.field, oversizedPreKeyIdentifierBytes, len(stored))
			}
		})
	}
}

// TestPublishPreKeyBundleStillAcceptsV2ShapedIdentifiers is the control for the
// test above: the bound must be a bound, not a closed route. The identifiers
// used here are exactly the shapes the v2 prekey path already accepts
// (signal_prekey_bundle_v2.go:148-152, 167, 181), so a fix that adopts those
// rules keeps this green.
func TestPublishPreKeyBundleStillAcceptsV2ShapedIdentifiers(t *testing.T) {
	handler, preKeyService := newPreKeyBundleTestHarness(t)

	bundle := signedPreKeyBundle(t, preKeyBundleIdentifiers{
		bundleID: controlPreKeyBundleID,
		deviceID: controlPreKeyDeviceID,
	})
	response := postJSON(t, http.HandlerFunc(handler.PublishPreKeyBundle), map[string]any{"bundle": bundle})
	if response.Code != http.StatusOK {
		t.Fatalf("PublishPreKeyBundle(v2-shaped identifiers) status = %d, want %d (error code %q); "+
			"the identifier bound must not be obtained by refusing legitimate publications",
			response.Code, http.StatusOK, mailboxErrorCode(t, response))
	}

	stored, err := preKeyService.GetPreKeyBundles(bundle.IdentityID)
	if err != nil {
		t.Fatalf("GetPreKeyBundles() error = %v", err)
	}
	if len(stored) != 1 {
		t.Fatalf("stored bundles = %d after an accepted publication, want 1", len(stored))
	}
}

// preKeyBundleIdentifiers describes which identifier of the fixture, if any, is
// built at oversizedPreKeyIdentifierBytes.
type preKeyBundleIdentifiers struct {
	identityID string
	deviceID   string
	bundleID   string
	oversized  string
}

// signedPreKeyBundle self-signs a v1 prekey bundle. Any caller can do this:
// /v1/prekeys/publish is unauthenticated and the bundle only has to verify
// against its own freshly generated identity key, so every identifier below is
// attacker-chosen. The fixture mirrors the one in
// internal/validation/validate_test.go:55-86.
func signedPreKeyBundle(t *testing.T, ids preKeyBundleIdentifiers) *model.PreKeyBundle {
	t.Helper()

	identityPublicKey, identityPrivateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("GenerateKey(identity) error = %v", err)
	}
	devicePublicKey, devicePrivateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("GenerateKey(device) error = %v", err)
	}

	identityID := ids.identityID
	if identityID == "" {
		identityID = base64.RawURLEncoding.EncodeToString(identityPublicKey)
	}
	deviceID := ids.deviceID
	bundleID := ids.bundleID
	padding := strings.Repeat("A", oversizedPreKeyIdentifierBytes)
	switch ids.oversized {
	case "":
	case "identity_id":
		identityID = padding
	case "device_id":
		deviceID = padding
	case "bundle_id":
		bundleID = padding
	default:
		t.Fatalf("signedPreKeyBundle: unknown identifier %q", ids.oversized)
	}

	bundle := &model.PreKeyBundle{
		Type:         "prekey_bundle",
		Version:      1,
		BundleID:     bundleID,
		IdentityID:   identityID,
		DeviceID:     deviceID,
		DevicePubKey: base64.RawURLEncoding.EncodeToString(devicePublicKey),
		SignedPreKey: model.SignedPreKey{
			KeyID:       "spk-1",
			PublicKey:   base64.RawURLEncoding.EncodeToString(devicePublicKey),
			CreatedAtMs: 1770000000000,
			ExpiresAtMs: 1770600000000,
		},
		OneTimePreKeys: []model.OneTimePreKey{
			{KeyID: "otk-1", PublicKey: base64.RawURLEncoding.EncodeToString(devicePublicKey)},
		},
		CreatedAtMs: 1770000000000,
	}

	signedPreKeyCanonical, err := cryptoutil.MarshalCanonicalJSONWithoutSignature(bundle.SignedPreKey)
	if err != nil {
		t.Fatalf("MarshalCanonicalJSONWithoutSignature(signed_prekey) error = %v", err)
	}
	bundle.SignedPreKey.Signature = base64.RawURLEncoding.EncodeToString(
		ed25519.Sign(devicePrivateKey, signedPreKeyCanonical),
	)

	bundleCanonical, err := cryptoutil.MarshalCanonicalJSONWithoutSignature(bundle)
	if err != nil {
		t.Fatalf("MarshalCanonicalJSONWithoutSignature(bundle) error = %v", err)
	}
	bundle.Signature = base64.RawURLEncoding.EncodeToString(ed25519.Sign(identityPrivateKey, bundleCanonical))

	return bundle
}

func newPreKeyBundleTestHarness(t *testing.T) (*PreKeyBundleHandler, *service.PreKeyBundleService) {
	t.Helper()

	store, err := storage.NewStorage(t.TempDir())
	if err != nil {
		t.Fatalf("NewStorage() error = %v", err)
	}
	t.Cleanup(func() { _ = store.Close() })

	preKeyService := service.NewPreKeyBundleService(repository.NewPreKeyBundleRepository(store))
	return NewPreKeyBundleHandler(preKeyService), preKeyService
}
