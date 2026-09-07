package handler

import (
	"encoding/json"
	"errors"
	"net/http"
)

// Request body bounds for the v1 JSON surface. Every v1 decoder site wraps
// r.Body in http.MaxBytesReader with one of these BEFORE handing it to
// encoding/json, so an unbounded body can never be streamed into the decoder.
const (
	compactRequestBodyLimit  = 64 << 10 // 64 KiB: challenge, poll, ack, device record
	envelopeRequestBodyLimit = 1 << 20  // 1 MiB: prekey bundle publication
)

// envelopeJSONOverheadBytes is the room reserved, on top of the configured
// maximum ciphertext size, for the surrounding JSON object and the envelope's
// other fields. The fixed fields are a few hundred bytes; 64 KiB is generous
// while still keeping the bound far below the probe size a hostile client can
// force the decoder to read.
const envelopeJSONOverheadBytes int64 = 64 << 10

// defaultMaxMessageBytes mirrors config.MaxMessageBytes so an unconfigured
// handler still derives a usable bound instead of collapsing to the overhead.
const defaultMaxMessageBytes int64 = 262144

// defaultMaxMailboxBatch mirrors config.MaxMailboxBatch, used when a handler is
// constructed without a configured batch size.
const defaultMaxMailboxBatch = 100

// maxAckEnvelopeIDs bounds the ack request's variable-length array when the
// handler has no configured mailbox batch size to bound it with.
const maxAckEnvelopeIDs = 1000

// maxOneTimePreKeysPerBundle bounds the only variable-length array in a v1
// prekey bundle publication.
const maxOneTimePreKeysPerBundle = 1000

// decodeJSONRequest bounds the request body and decodes it. It writes the error
// response itself and reports whether decoding succeeded.
func decodeJSONRequest(w http.ResponseWriter, r *http.Request, limit int64, target any) bool {
	r.Body = http.MaxBytesReader(w, r.Body, limit)

	if err := json.NewDecoder(r.Body).Decode(target); err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			writeJSONError(w, http.StatusRequestEntityTooLarge, "PAYLOAD_TOO_LARGE", "request body exceeds limit")
			return false
		}
		writeJSONError(w, http.StatusBadRequest, "INVALID_JSON", "invalid request body")
		return false
	}

	return true
}
