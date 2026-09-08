package handler

import (
	"net/http"
	"testing"

	"echolet/apps/relay/internal/config"
	"echolet/apps/relay/internal/cryptoutil"
	"echolet/apps/relay/internal/protocol"
)

// Residual R-3 (flow 003 T11 §5), measured by T21 as finding T21-F-001, closed
// here as T22.
//
// THE DEFECT. A MailboxHandler built with maxMessageBytes = 0 accepted NOTHING.
// Two places consume that field as a size and they disagreed about zero:
// envelopeBodyLimit() applied a fallback to the protocol maximum
// (mailbox_handler.go), and validation.ValidateMailboxEnvelope was handed the
// zero unchanged (validate.go), so every ciphertext was "above" it and
// /v1/messages/send answered 400 PAYLOAD_TOO_LARGE. The relay came up healthy and
// refused every legitimate envelope. The fallback existed in one of the two
// places that need it.
//
// WHY THE ZERO IS RESOLVED RATHER THAN REFUSED. config.Validate() permits a zero
// MaxMessageBytes deliberately: it is the zero value of a partially constructed
// Config, which internal/server builds directly and which the handler is
// documented to read as "unconfigured, use the protocol maximum". A zero-value
// struct is the idiomatic Go default and six internal/server tests already depend
// on it. So the reading is made TRUE instead of half true - the zero is resolved
// once, in NewMailboxHandler, so both consumers see one positive maximum - rather
// than the struct's default being outlawed.
//
// THIS IS NOT THE OPERATOR SURFACE. An operator who writes
// ECHOLET_MAX_MESSAGE_BYTES=0 is saying something, and "silently 256 KB" is not a
// safe answer to it; that half is refused at startup by Load() and is pinned in
// internal/config/max_message_bytes_config_test.go
// (TestLoadRefusesAnExplicitlyZeroMaxMessageBytes). The two halves are
// deliberately different: an unset variable and a zero-value struct mean
// "unconfigured", and only Load() can tell those apart from an explicit zero.
//
// No ciphertext, plaintext or request body is printed. Only byte counts, status
// codes, error codes and envelope identifiers appear in failure output.

// TestAnUnconfiguredMaxMessageBytesCarriesAnEnvelopeOfTheProtocolMaximum drives
// the real send + poll round trip through a handler built the way internal/server
// builds its Config: with the maximum left at its zero value.
func TestAnUnconfiguredMaxMessageBytesCarriesAnEnvelopeOfTheProtocolMaximum(t *testing.T) {
	const unconfigured int64 = 0

	// The same guard the sibling deliverability test uses: this may only exercise
	// a configuration the relay actually starts with.
	if err := (config.Config{MaxMessageBytes: unconfigured}).Validate(); err != nil {
		t.Fatalf("config.Validate() with an unconfigured MaxMessageBytes returned %v; a zero-value Config is the "+
			"struct internal/server builds directly, so it must remain a configuration the relay starts with", err)
	}

	handler, deviceService, mailboxService := newConfiguredMaxMessageBytesHarness(t, unconfigured)

	record, devicePrivateKey := signedDeviceRecord(t)
	mailboxID := cryptoutil.DeriveMailboxID(record.IdentityID)
	if err := deviceService.PublishDeviceRecord(record); err != nil {
		t.Fatalf("PublishDeviceRecord() error = %v", err)
	}

	envelope := envelopeWithCiphertextSize(t, record, mailboxID, 0, int(protocol.MaxMessageBytes))
	sent := sendEnvelopeRequest(t, handler, envelope)
	if sent.Code != http.StatusOK {
		t.Fatalf("SendEnvelope(ciphertext = the protocol maximum, %d) through a handler with an UNCONFIGURED "+
			"maximum: status = %d, want %d (error code %q). An unconfigured maximum is documented to mean "+
			"\"use the protocol maximum\"; envelopeBodyLimit() already reads it that way, and a relay that "+
			"comes up healthy and then refuses every legitimate envelope is the worst shape of this defect "+
			"(residual R-3, finding T21-F-001)",
			protocol.MaxMessageBytes, sent.Code, http.StatusOK, mailboxErrorCode(t, sent))
	}

	// Accepted means undertaken to deliver: the poll must hand it back.
	response := pollMailboxOnce(t, handler, mailboxID, record.DeviceID, devicePrivateKey, 0)
	if response.Code != http.StatusOK {
		t.Fatalf("poll status = %d, want %d (error code %q)", response.Code, http.StatusOK, mailboxErrorCode(t, response))
	}

	batch := decodePollResponse(t, response)
	delivered := false
	for _, returned := range batch.Data.Envelopes {
		if returned.EnvelopeID == envelope.EnvelopeID {
			delivered = true
		}
	}
	if !delivered {
		t.Fatalf("the accepted maximum-size envelope %s was not returned by the poll (%d envelope(s) returned); "+
			"an envelope the relay accepted must be one the relay hands back",
			envelope.EnvelopeID, len(batch.Data.Envelopes))
	}

	stored, err := mailboxService.GetEnvelopes(mailboxID, 10)
	if err != nil {
		t.Fatalf("GetEnvelopes() error = %v", err)
	}
	if len(stored) != 1 {
		t.Fatalf("envelopes in the mailbox = %d after one accepted send, want 1", len(stored))
	}
}

// TestAnUnconfiguredMaxMessageBytesIsTheProtocolMaximumAndNotUnbounded is the
// other half, and it is what stops the fix above from being "ignore the field
// when it is zero". Resolving the zero must resolve it to the protocol maximum,
// so the size rule is still enforced; an unconfigured relay is not an open one.
func TestAnUnconfiguredMaxMessageBytesIsTheProtocolMaximumAndNotUnbounded(t *testing.T) {
	const unconfigured int64 = 0

	handler, deviceService, mailboxService := newConfiguredMaxMessageBytesHarness(t, unconfigured)

	record, _ := signedDeviceRecord(t)
	mailboxID := cryptoutil.DeriveMailboxID(record.IdentityID)
	if err := deviceService.PublishDeviceRecord(record); err != nil {
		t.Fatalf("PublishDeviceRecord() error = %v", err)
	}

	oversized := protocol.MaxMessageBytes + 1
	envelope := envelopeWithCiphertextSize(t, record, mailboxID, 0, int(oversized))
	sent := sendEnvelopeRequest(t, handler, envelope)
	if sent.Code != http.StatusBadRequest {
		t.Fatalf("SendEnvelope(ciphertext = one byte above the protocol maximum, %d) through a handler with an "+
			"UNCONFIGURED maximum: status = %d, want %d. \"Unconfigured\" must mean the protocol maximum, not "+
			"\"no maximum\": the poll byte budget is cut from that same constant, so an envelope above it could "+
			"be accepted, stored and then never handed back inside a response any recipient reads",
			oversized, sent.Code, http.StatusBadRequest)
	}
	if code := mailboxErrorCode(t, sent); code != "PAYLOAD_TOO_LARGE" {
		t.Fatalf("error code for a ciphertext of %d bytes = %q, want PAYLOAD_TOO_LARGE; the sender has to learn "+
			"that the size is what was wrong", oversized, code)
	}

	stored, err := mailboxService.GetEnvelopes(mailboxID, 10)
	if err != nil {
		t.Fatalf("GetEnvelopes() error = %v", err)
	}
	if len(stored) != 0 {
		t.Fatalf("envelopes in the mailbox = %d after one refused send, want 0", len(stored))
	}
}
