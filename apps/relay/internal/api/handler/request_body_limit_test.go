package handler

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"echolet/apps/relay/internal/service"
	"echolet/apps/relay/internal/storage"
	"echolet/apps/relay/internal/storage/repository"
)

// RED test for review finding F-006 (a).
//
// Every v1 JSON handler must bound the request body BEFORE decoding it and
// reject an over-limit body with a bounded error, instead of streaming the whole
// body into encoding/json. Only the v2 surface currently uses
// http.MaxBytesReader (signal_prekey_bundle_v2.go:31).
//
// The probe body is syntactically valid JSON with no known fields, so every
// handler already answers 4xx today; the property under test is therefore
// isolated to how many bytes the handler consumed from the request body.
// Request bodies are never written into test output — only byte counts are.

const (
	oversizedRequestBodyBytes = 8 << 20 // 8 MiB probe body
	maxRequestBodyReadBytes   = 4 << 20 // handlers must stop far below the probe size
)

type countingBodyReader struct {
	inner io.Reader
	read  int64
}

func (c *countingBodyReader) Read(p []byte) (int, error) {
	n, err := c.inner.Read(p)
	c.read += int64(n)
	return n, err
}

func TestV1JSONHandlersBoundRequestBodyBeforeDecoding(t *testing.T) {
	store, err := storage.NewStorage(t.TempDir())
	if err != nil {
		t.Fatalf("NewStorage() error = %v", err)
	}
	t.Cleanup(func() { _ = store.Close() })

	deviceService := service.NewDeviceRecordService(repository.NewDeviceRecordRepository(store))
	mailboxService := service.NewMailboxService(repository.NewMailboxRepository(store))
	challengeService := service.NewChallengeService(repository.NewChallengeRepository(store), 60)
	preKeyBundleService := service.NewPreKeyBundleService(repository.NewPreKeyBundleRepository(store))

	mailboxHandler := NewMailboxHandler(mailboxService, challengeService, deviceService, 100, 262144)
	deviceRecordHandler := NewDeviceRecordHandler(deviceService)
	preKeyBundleHandler := NewPreKeyBundleHandler(preKeyBundleService)

	// Every v1 json.NewDecoder(r.Body) site enumerated by finding F-006.
	sites := []struct {
		name    string
		path    string
		handler http.HandlerFunc
	}{
		{"mailbox_handler.go:46 SendEnvelope", "/v1/messages/send", mailboxHandler.SendEnvelope},
		{"mailbox_handler.go:96 CreateChallenge", "/v1/mailbox/challenge", mailboxHandler.CreateChallenge},
		{"mailbox_handler.go:149 PollMailbox", "/v1/mailbox/poll", mailboxHandler.PollMailbox},
		{"mailbox_handler.go:225 AckMailbox", "/v1/mailbox/ack", mailboxHandler.AckMailbox},
		{"device_record_handler.go:38 PublishDeviceRecord", "/v1/device-records/publish", deviceRecordHandler.PublishDeviceRecord},
		{"prekey_bundle_handler.go:28 PublishPreKeyBundle", "/v1/prekeys/publish", preKeyBundleHandler.PublishPreKeyBundle},
	}

	probeBody := `{"__probe_padding":"` + strings.Repeat("A", oversizedRequestBodyBytes) + `"}`

	for _, site := range sites {
		t.Run(site.name, func(t *testing.T) {
			body := &countingBodyReader{inner: strings.NewReader(probeBody)}
			request := httptest.NewRequest(http.MethodPost, site.path, body)
			request.Header.Set("Content-Type", "application/json")
			recorder := httptest.NewRecorder()

			site.handler(recorder, request)

			if recorder.Code < 400 || recorder.Code >= 500 {
				t.Fatalf("%s: status = %d, want a 4xx bounded rejection for an over-limit body", site.name, recorder.Code)
			}
			if body.read > maxRequestBodyReadBytes {
				t.Fatalf("%s: consumed %d bytes of a %d byte body, want at most %d: the request body must be bounded with http.MaxBytesReader before decoding",
					site.name, body.read, len(probeBody), maxRequestBodyReadBytes)
			}
		})
	}
}
