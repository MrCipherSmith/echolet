package handler

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"fmt"
	"net/http"
	"testing"

	"echolet/apps/relay/internal/cryptoutil"
	"echolet/apps/relay/internal/model"
	"echolet/apps/relay/internal/storage/repository"
)

func TestPublishDeviceRecordAnswersConflictOnceAnIdentityHoldsTheMaximumDevices(t *testing.T) {
	handler := newDeviceRecordHandlerTestHarness(t)

	identityPublicKey, identityPrivateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	publish := func(device int) int {
		devicePublicKey, _, err := ed25519.GenerateKey(rand.Reader)
		if err != nil {
			t.Fatal(err)
		}
		record := &model.DeviceRecord{
			Type:         "device_record",
			Version:      1,
			IdentityID:   base64.RawURLEncoding.EncodeToString(identityPublicKey),
			DeviceID:     fmt.Sprintf("7b95a59f-53f2-4d51-8e27-%012d", device),
			DevicePubKey: base64.RawURLEncoding.EncodeToString(devicePublicKey),
			Capabilities: map[string]bool{"mailbox_poll": true},
			CreatedAtMs:  1770000000000,
		}
		canonical, err := cryptoutil.MarshalCanonicalJSONWithoutSignature(record)
		if err != nil {
			t.Fatal(err)
		}
		record.Signature = base64.RawURLEncoding.EncodeToString(ed25519.Sign(identityPrivateKey, canonical))
		return postJSON(t, http.HandlerFunc(handler.PublishDeviceRecord), map[string]any{"device_record": record}).Code
	}

	for device := 0; device < repository.MaxDevicesPerIdentity; device++ {
		if got := publish(device); got != http.StatusOK {
			t.Fatalf("publish(device %d) status = %d, want %d below the limit", device, got, http.StatusOK)
		}
	}
	if got := publish(repository.MaxDevicesPerIdentity); got != http.StatusConflict {
		t.Fatalf("publish(device %d) status = %d, want %d at the limit", repository.MaxDevicesPerIdentity, got, http.StatusConflict)
	}
}
