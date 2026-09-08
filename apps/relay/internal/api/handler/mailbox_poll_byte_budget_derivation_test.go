package handler

import (
	"net/http"
	"testing"

	"echolet/apps/relay/internal/config"
	"echolet/apps/relay/internal/cryptoutil"
	"echolet/apps/relay/internal/protocol"
	"echolet/apps/relay/internal/service"
	"echolet/apps/relay/internal/storage"
	"echolet/apps/relay/internal/storage/repository"
)

// Residual RI-09 (flow 003 T1 inventory; HL-N-003 = T35-I-001 = SEC R-005,
// T54-F-003, STATUS §3): one environment variable could make a mailbox silently
// undeliverable, because the relay accepted envelopes up to its CONFIGURED
// maximum while the poll route's byte budget - and the client's response bound -
// were compile-time literals with no relation to it.
//
// WHAT THIS FILE PINNED BEFORE, AND WHY IT WAS RE-AUTHORED (task T21).
// It held TestMaximumSizeEnvelopeIsDeliverableAtRaisedMaxMessageBytes, which
// drove the same round trip with ECHOLET_MAX_MESSAGE_BYTES RAISED to 2 MiB. The
// property it was about - an envelope the relay accepts must be one the relay can
// hand back inside what the recipient will read - is unchanged and is pinned
// below. Only the configuration moved, because the closure taken for RI-09 (T11)
// made the old one non-existent rather than merely unimplemented:
//
//   - protocol.MaxMessageBytes (mirroring LIMITS.MAX_MESSAGE_BYTES in
//     packages/protocol) is now the single source both sides derive from - the
//     relay its poll byte budget, the client its response bound - and neither
//     learns a size at runtime, because nothing on this wire negotiates one.
//   - config.Validate() therefore REFUSES AT STARTUP a configured maximum above
//     that protocol maximum, the way it already refuses a half-configured TLS
//     pair. A relay at 2 MiB no longer starts, so a test driving one asserts
//     nothing an operator can reach.
//   - Making that old test green would have required capping the accepted size at
//     the poll budget, which turns the frozen
//     TestSendEnvelopeBodyLimitIsDerivedFromMaxMessageBytes red (measured: 413
//     where it wants 200). The two demanded 200 and 4xx for one request at one
//     size, so exactly one could ever be green.
//
// The retired name is recorded here on purpose: nothing it asserted was dropped,
// and the assertions below are strictly stronger than the "either coherent
// answer" it allowed - a permitted configuration must now ACCEPT the envelope and
// hand it back, with no refusal branch, because refusing what the deployment is
// configured to carry is itself the defect.
//
// WHY THIS DRIVES THE ROUTES INSTEAD OF ASSERTING ON A CONSTANT. An assertion
// such as `pollEnvelopeByteBudget >= maxMessageBytes + wrapper` would pin one
// particular arithmetic and would be satisfied by any edit that keeps the mailbox
// undeliverable. So the whole round trip is driven through the real SendEnvelope
// and PollMailbox handlers over real Badger storage, at every maximum a
// deployment may be configured with, and the assertion is on what an operator
// would observe.
//
// WHY NO NUMBER IS HARDCODED. Every size here is derived: the configured maxima
// are expressed relative to protocol.MaxMessageBytes, and the bound the response
// is measured against is computed by clientPollResponseBoundFor, which re-states
// the CLIENT's rule. Changing the protocol constant re-scales this file; it never
// silently un-pins it.
//
// No ciphertext, plaintext or request body is printed. Only byte counts, status
// codes, error codes and envelope identifiers appear in failure output.

// clientPollResponseBoundFor re-states, in Go, the bound a conforming client
// enforces on a poll response: `responseByteBoundFor` in
// apps/cli/src/transport/relayClient.ts,
//
//	Math.max(pollResponseEnvelopeBudgetFactor * maxMessageBytes,
//	         maxMessageBytes + pollResponseWrapperBytes)
//
// It is written out here rather than read from mailbox_handler.go's
// clientPollResponseBound, so that these tests measure the relay against the
// CLIENT's rule instead of against the relay's own copy of it; if the two ever
// diverge, TestPollResponseBoundsAreDerivedFromTheProtocolMaximum below is what
// says so.
//
// Its argument is the PROTOCOL maximum, never a deployment's configured one: the
// relay does not advertise its configuration and the client sizes this bound from
// the shared constant alone. A deployment configured lower simply produces
// smaller responses.
func clientPollResponseBoundFor(maxMessageBytes int64) int64 {
	const clientPollResponseWrapperBytes int64 = 64 << 10
	const clientPollResponseEnvelopeBudgetFactor int64 = 4

	scaled := clientPollResponseEnvelopeBudgetFactor * maxMessageBytes
	exempted := maxMessageBytes + clientPollResponseWrapperBytes
	if scaled > exempted {
		return scaled
	}
	return exempted
}

// TestMaximumSizeEnvelopeIsDeliverableAtEveryPermittedMaxMessageBytes pins
// RI-09's property at the configurations that now exist: for EVERY
// ECHOLET_MAX_MESSAGE_BYTES the relay will start with, an envelope of exactly
// that maximum must be accepted, handed back by a poll, and carried in a response
// within the bound the recipient enforces.
//
// The maxima are derived from protocol.MaxMessageBytes rather than written out,
// and each one is first put through the real config.Validate() - so the test
// cannot drift into asserting a configuration the relay refuses, which is exactly
// how its predecessor became unsatisfiable.
func TestMaximumSizeEnvelopeIsDeliverableAtEveryPermittedMaxMessageBytes(t *testing.T) {
	clientBound := clientPollResponseBoundFor(protocol.MaxMessageBytes)

	// Every maximum Load() can produce, at both ends of the permitted range and in
	// the middle: the protocol maximum itself, and configurations below it. Zero is
	// NOT here - see the note under this table.
	cases := []struct {
		name string
		// configured is what an operator sets, and is also the ciphertext size the
		// handler then accepts.
		configured int64
	}{
		{name: "at the protocol maximum", configured: protocol.MaxMessageBytes},
		{name: "at half the protocol maximum", configured: protocol.MaxMessageBytes / 2},
		{name: "at a sixteenth of the protocol maximum", configured: protocol.MaxMessageBytes / 16},
	}

	// WHY ZERO IS NOT IN THAT TABLE. The table's `configured` doubles as the
	// ciphertext size, and a zero maximum is not a zero-byte envelope: zero means
	// "unconfigured", which the handler resolves to the protocol maximum. It gets
	// its own round trip next door, in unconfigured_max_message_bytes_test.go
	// (TestAnUnconfiguredMaxMessageBytesCarriesAnEnvelopeOfTheProtocolMaximum),
	// where the ciphertext is the protocol maximum rather than the configured
	// value.
	//
	// It used to be absent for a different reason, worth keeping: at the time this
	// file was written a handler at zero accepted NOTHING - envelopeBodyLimit fell
	// back to the protocol maximum but ValidateMailboxEnvelope was handed the zero
	// unchanged, so the route answered 400/PAYLOAD_TOO_LARGE to a ciphertext of
	// exactly the protocol maximum. That was measured here, reported as residual
	// R-3 / finding T21-F-001, and closed in T22 by resolving the zero once in
	// NewMailboxHandler. An operator's explicit ECHOLET_MAX_MESSAGE_BYTES=0 is
	// refused at startup by config.Load() instead.

	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			if err := (config.Config{MaxMessageBytes: testCase.configured}).Validate(); err != nil {
				t.Fatalf("config.Validate() with ECHOLET_MAX_MESSAGE_BYTES = %d returned %v; this test may only "+
					"exercise configurations the relay actually starts with", testCase.configured, err)
			}

			handler, deviceService, mailboxService := newConfiguredMaxMessageBytesHarness(t, testCase.configured)

			record, devicePrivateKey := signedDeviceRecord(t)
			mailboxID := cryptoutil.DeriveMailboxID(record.IdentityID)
			if err := deviceService.PublishDeviceRecord(record); err != nil {
				t.Fatalf("PublishDeviceRecord() error = %v", err)
			}

			envelope := envelopeWithCiphertextSize(t, record, mailboxID, 0, int(testCase.configured))
			sent := sendEnvelopeRequest(t, handler, envelope)
			if sent.Code != http.StatusOK {
				t.Fatalf("SendEnvelope(ciphertext = the configured maximum, %d) status = %d, want %d (error code %q); "+
					"a deployment the relay agreed to start with must accept an envelope of exactly the size it is "+
					"configured to carry - refusing it is the same defect one hop earlier",
					testCase.configured, sent.Code, http.StatusOK, mailboxErrorCode(t, sent))
			}

			// The relay accepted the envelope, so it has undertaken to deliver it:
			// the poll carrying it must produce a response the client will read.
			response := pollMailboxOnce(t, handler, mailboxID, record.DeviceID, devicePrivateKey, 0)
			if response.Code != http.StatusOK {
				t.Fatalf("poll status = %d, want %d (error code %q)", response.Code, http.StatusOK, mailboxErrorCode(t, response))
			}

			if bodyBytes := int64(response.Body.Len()); bodyBytes > clientBound {
				t.Fatalf("with ECHOLET_MAX_MESSAGE_BYTES = %d the relay accepted an envelope of exactly the maximum it "+
					"carries (%d) and then answered the poll with %d bytes, above the %d a conforming client enforces "+
					"(responseByteBoundFor in apps/cli/src/transport/relayClient.ts, derived from the same "+
					"protocol maximum of %d). The client refuses the whole batch, so nothing in it is ever "+
					"acknowledged and the mailbox is undeliverable while both sides look healthy. The poll byte budget "+
					"(pollEnvelopeByteBudget) and that client bound are two derivations of one number and must stay in "+
					"step; see TestPollResponseBoundsAreDerivedFromTheProtocolMaximum",
					testCase.configured, testCase.configured, bodyBytes, clientBound, protocol.MaxMessageBytes)
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
		})
	}
}

// TestPollResponseBoundsAreDerivedFromTheProtocolMaximum keeps the three
// statements of one number in step, so the round trip above cannot be green while
// a real recipient still refuses the batch.
//
// The three are: the client's own bound (re-stated by clientPollResponseBoundFor
// from relayClient.ts), the relay's clientPollResponseBound that
// pollEnvelopeByteBudget is cut from, and maxPollResponseBytes in
// mailbox_poll_capacity_test.go - a hand-written mirror of the client's bound
// that three other tests measure poll responses against.
//
// maxPollResponseBytes is deliberately NOT edited: it is numerically the client's
// bound at today's protocol maximum, and raising it would assert an acceptance
// that does not exist. This test is what makes it a derivation in effect - if the
// protocol constant ever moves, the mirror stops mirroring and this fails by name
// instead of the suite going quietly wrong.
func TestPollResponseBoundsAreDerivedFromTheProtocolMaximum(t *testing.T) {
	clientBound := clientPollResponseBoundFor(protocol.MaxMessageBytes)

	if int64(maxPollResponseBytes) != clientBound {
		t.Fatalf("maxPollResponseBytes = %d but a client at the protocol maximum of %d bounds a poll response at %d; "+
			"that constant claims to mirror the client's hard bound, so every test measuring a poll response against "+
			"it is now measuring against the wrong number (mailbox_poll_capacity_test.go)",
			int64(maxPollResponseBytes), protocol.MaxMessageBytes, clientBound)
	}

	if clientPollResponseBound > clientBound {
		t.Fatalf("clientPollResponseBound = %d, above the %d a conforming client accepts at the protocol maximum of "+
			"%d; pollEnvelopeByteBudget is cut from it, so the relay would be permitted to select a batch every "+
			"recipient refuses in full (residual RI-09)",
			clientPollResponseBound, clientBound, protocol.MaxMessageBytes)
	}

	// The budget must still leave room for the wrapper, or the derivation above is
	// arithmetically vacuous.
	if pollEnvelopeByteBudget >= clientPollResponseBound {
		t.Fatalf("pollEnvelopeByteBudget = %d, not below the %d response bound it must fit inside once the response "+
			"wrapper is accounted for", pollEnvelopeByteBudget, clientPollResponseBound)
	}

	// And it must still admit one maximum-size envelope, or nothing is deliverable
	// at all - the failure the first-envelope exemption exists to prevent.
	if pollEnvelopeByteBudget < protocol.MaxMessageBytes {
		t.Fatalf("pollEnvelopeByteBudget = %d, below the protocol maximum ciphertext of %d: no single maximum-size "+
			"envelope would fit in one poll response", pollEnvelopeByteBudget, protocol.MaxMessageBytes)
	}
}

// newConfiguredMaxMessageBytesHarness is newMailboxHandlerTestHarness with an
// explicit ECHOLET_MAX_MESSAGE_BYTES, returning the services the round trip
// needs. It exists rather than reusing newMailboxHandlerWithMaxMessageBytes
// (mailbox_poll_capacity_test.go) because that helper returns only the handler
// and these tests have to publish a recipient and read the store back.
func newConfiguredMaxMessageBytesHarness(t *testing.T, maxMessageBytes int64) (*MailboxHandler, *service.DeviceRecordService, *service.MailboxService) {
	t.Helper()

	st, err := storage.NewStorage(t.TempDir())
	if err != nil {
		t.Fatalf("NewStorage() error = %v", err)
	}
	t.Cleanup(func() { _ = st.Close() })

	deviceService := service.NewDeviceRecordService(repository.NewDeviceRecordRepository(st))
	mailboxService := service.NewMailboxService(repository.NewMailboxRepository(st))
	challengeService := service.NewChallengeService(repository.NewChallengeRepository(st), 60)

	handler := NewMailboxHandler(mailboxService, challengeService, deviceService, defaultMaxMailboxBatch, maxMessageBytes)
	return handler, deviceService, mailboxService
}
