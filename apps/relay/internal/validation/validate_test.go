package validation

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"testing"

	"echolet/apps/relay/internal/cryptoutil"
	"echolet/apps/relay/internal/model"
)

func TestValidateDeviceRecordRejectsInvalidSignature(t *testing.T) {
	publicKey, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("GenerateKey() error = %v", err)
	}

	record := &model.DeviceRecord{
		Type:         "device_record",
		Version:      1,
		IdentityID:   base64.RawURLEncoding.EncodeToString(publicKey),
		DeviceID:     "8cc8010b-d4a1-4ce7-8203-a8f6b055c1b9",
		DevicePubKey: base64.RawURLEncoding.EncodeToString(publicKey),
		Capabilities: map[string]bool{"mailbox_poll": true},
		CreatedAtMs:  1770000000000,
	}

	canonical, err := cryptoutil.MarshalCanonicalJSONWithoutSignature(record)
	if err != nil {
		t.Fatalf("MarshalCanonicalJSONWithoutSignature() error = %v", err)
	}
	record.Signature = base64.RawURLEncoding.EncodeToString(ed25519.Sign(privateKey, canonical))

	if err := ValidateDeviceRecord(record); err != nil {
		t.Fatalf("ValidateDeviceRecord(valid) error = %v", err)
	}

	record.DevicePubKey = "tampered"
	if err := ValidateDeviceRecord(record); err == nil {
		t.Fatalf("ValidateDeviceRecord(tampered) expected error")
	}
}

func TestValidatePreKeyBundleRejectsInvalidSignatures(t *testing.T) {
	identityPublicKey, identityPrivateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("GenerateKey(identity) error = %v", err)
	}
	devicePublicKey, devicePrivateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("GenerateKey(device) error = %v", err)
	}

	bundle := &model.PreKeyBundle{
		Type:         "prekey_bundle",
		Version:      1,
		BundleID:     "bf705c17-25fe-44e5-aec2-ef94d8de7796",
		IdentityID:   base64.RawURLEncoding.EncodeToString(identityPublicKey),
		DeviceID:     "8cc8010b-d4a1-4ce7-8203-a8f6b055c1b9",
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
		t.Fatalf("MarshalCanonicalJSONWithoutSignature(signedPreKey) error = %v", err)
	}
	bundle.SignedPreKey.Signature = base64.RawURLEncoding.EncodeToString(
		ed25519.Sign(devicePrivateKey, signedPreKeyCanonical),
	)

	bundleCanonical, err := cryptoutil.MarshalCanonicalJSONWithoutSignature(bundle)
	if err != nil {
		t.Fatalf("MarshalCanonicalJSONWithoutSignature(bundle) error = %v", err)
	}
	bundle.Signature = base64.RawURLEncoding.EncodeToString(ed25519.Sign(identityPrivateKey, bundleCanonical))

	if err := ValidatePreKeyBundle(bundle); err != nil {
		t.Fatalf("ValidatePreKeyBundle(valid) error = %v", err)
	}

	bundle.Signature = "invalid"
	if err := ValidatePreKeyBundle(bundle); err == nil {
		t.Fatalf("ValidatePreKeyBundle(tampered) expected error")
	}
}
