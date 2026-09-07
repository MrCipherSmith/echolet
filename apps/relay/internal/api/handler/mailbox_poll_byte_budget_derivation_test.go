package handler

import (
	"net/http"
	"testing"

	"echolet/apps/relay/internal/cryptoutil"
	"echolet/apps/relay/internal/service"
	"echolet/apps/relay/internal/storage"
	"echolet/apps/relay/internal/storage/repository"
)

// RED test for residual RI-09 (flow 003 T1 inventory; HL-N-003 = T35-I-001 =
// SEC R-005, T54-F-003, STATUS §3).
//
// The defect is a RELATIONSHIP BETWEEN TWO NUMBERS, not either number:
//
//	mailbox_handler.go:67  const pollEnvelopeByteBudget int64 = (1 << 20) - pollResponseWrapperBytes
//	config.go:37           MaxMessageBytes `env:"ECHOLET_MAX_MESSAGE_BYTES" envDefault:"262144"`
//
// The send route DOES derive its bound from the configured maximum
// (envelopeBodyLimit(), mailbox_handler.go:81-89). The poll route does not: the
// budget is a compile-time constant, so raising ECHOLET_MAX_MESSAGE_BYTES past
// roughly 1 MiB produces envelopes the relay accepts and then hands back in a
// response above the CLI's hard response bound
// (apps/cli/src/transport/relayClient.ts:144, `if (size > 1024 * 1024)`), which
// the client refuses in full. Nothing in that batch is ever acknowledged, so one
// environment variable makes a mailbox silently undeliverable. Unreachable at the
// 262144 default, which is why nothing has caught it.
//
// WHY THIS TEST DRIVES THE ROUTES INSTEAD OF ASSERTING ON THE CONSTANT. An
// assertion such as `pollEnvelopeByteBudget >= maxMessageBytes + wrapper` would
// pin one particular arithmetic and would be satisfied by any edit that changes
// the constant, including one that keeps the mailbox undeliverable. So the whole
// round trip is driven at the configured maximum, through the real SendEnvelope
// and PollMailbox handlers over real Badger storage, and the assertion is on
// what an operator would observe: an envelope the relay accepted must be one the
// relay can hand back.
//
// WHAT IS AND IS NOT PINNED. The test deliberately allows EITHER coherent
// answer, because both close the defect and the choice belongs to the
// implementer:
//
//	(a) the poll side is made to fit the send side - the response carrying a
//	    configured-maximum envelope stays within the bound the client enforces; or
//	(b) the send side is made to fit the poll side - /v1/messages/send refuses a
//	    ciphertext it could never deliver, with a bounded 4xx and a typed code, so
//	    the operator learns at publish time instead of never.
//
// What it refuses is exactly today's behaviour: accept the envelope, then answer
// the poll with a body the client must throw away.
//
// A WARNING ABOUT (b), ESTABLISHED BY TRYING IT. Answer (b) is not actually
// free, and RI-09's "relay-internal, no protocol change" classification does not
// survive contact with the tree. TestSendEnvelopeBodyLimitIsDerivedFromMaxMessageBytes
// (mailbox_poll_capacity_test.go:200-227) already pins the opposite half at the
// SAME 2 MiB: an envelope of exactly the configured ECHOLET_MAX_MESSAGE_BYTES
// must be ACCEPTED by /v1/messages/send. Capping the accepted size at the poll
// budget was tried in an out-of-tree copy and turns that test red. So the two
// tests together say the relay must accept a 2 MiB envelope AND must not answer
// a poll with more than 1 MiB - which is unsatisfiable while the client's bound
// is the fixed `1024 * 1024` at relayClient.ts:144. Closing RI-09 therefore
// means the CLIENT's response bound has to move with the configured maximum too;
// it is a two-sided change, not a relay-internal one. That is a correction to the
// inventory row, and it is recorded here because it is the first thing the
// implementer will hit.
//
// No ciphertext, plaintext or request body is printed. Only byte counts, status
// codes, error codes and envelope identifiers appear in failure output.

// raisedPollMaxMessageBytes is ECHOLET_MAX_MESSAGE_BYTES raised to 2 MiB - the
// operator action RI-09 describes. It is above the poll budget's fixed 1 MiB
// ceiling, which is the only property that matters here; the exact value is not
// asserted on anywhere.
const raisedPollMaxMessageBytes int64 = 2 << 20

func TestMaximumSizeEnvelopeIsDeliverableAtRaisedMaxMessageBytes(t *testing.T) {
	handler, deviceService, mailboxService := newRaisedMaxMessageBytesHarness(t, raisedPollMaxMessageBytes)

	record, devicePrivateKey := signedDeviceRecord(t)
	mailboxID := cryptoutil.DeriveMailboxID(record.IdentityID)
	if err := deviceService.PublishDeviceRecord(record); err != nil {
		t.Fatalf("PublishDeviceRecord() error = %v", err)
	}

	envelope := envelopeWithCiphertextSize(t, record, mailboxID, 0, int(raisedPollMaxMessageBytes))
	sent := sendEnvelopeRequest(t, handler, envelope)

	if sent.Code != http.StatusOK {
		// Answer (b). The relay declined to accept what it cannot deliver, which
		// is coherent - but it still has to be a bounded client refusal, not an
		// internal error, and it must not leave the envelope half-stored.
		if sent.Code >= http.StatusInternalServerError || sent.Code < http.StatusBadRequest {
			t.Fatalf("SendEnvelope(ciphertext = the configured ECHOLET_MAX_MESSAGE_BYTES, %d) status = %d, "+
				"want either %d or a bounded 4xx with a typed code (error code %q)",
				raisedPollMaxMessageBytes, sent.Code, http.StatusOK, mailboxErrorCode(t, sent))
		}
		if code := mailboxErrorCode(t, sent); code == "" || code == "INTERNAL_ERROR" {
			t.Fatalf("SendEnvelope(ciphertext = %d) error code = %q, want a typed client-error code",
				raisedPollMaxMessageBytes, code)
		}
		stored, err := mailboxService.GetEnvelopes(mailboxID, 10)
		if err != nil {
			t.Fatalf("GetEnvelopes() error = %v", err)
		}
		if len(stored) != 0 {
			t.Fatalf("SendEnvelope was refused but %d envelope(s) are stored, want 0", len(stored))
		}
		return
	}

	// Answer (a). The relay accepted the envelope, so it has undertaken to
	// deliver it: the poll that carries it must produce a response the client
	// will accept.
	response := pollMailboxOnce(t, handler, mailboxID, record.DeviceID, devicePrivateKey, 0)
	if response.Code != http.StatusOK {
		t.Fatalf("poll status = %d, want %d (error code %q)", response.Code, http.StatusOK, mailboxErrorCode(t, response))
	}

	bodyBytes := response.Body.Len()
	if bodyBytes > maxPollResponseBytes {
		t.Fatalf("with ECHOLET_MAX_MESSAGE_BYTES = %d the relay accepted an envelope of exactly that size and then "+
			"answered the poll with %d bytes, above the %d the client enforces at "+
			"apps/cli/src/transport/relayClient.ts:144. The client refuses the whole batch, so nothing in it is ever "+
			"acknowledged and the mailbox is undeliverable. The poll byte budget (mailbox_handler.go:67) is a "+
			"compile-time constant with no relation to h.maxMessageBytes, while the send route derives its own bound "+
			"at mailbox_handler.go:81-89; the two must agree. Note that refusing the envelope at send is not "+
			"available on its own: TestSendEnvelopeBodyLimitIsDerivedFromMaxMessageBytes pins acceptance at this "+
			"same size, so the client's response bound has to move with the configured maximum as well",
			raisedPollMaxMessageBytes, bodyBytes, maxPollResponseBytes)
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
}

// newRaisedMaxMessageBytesHarness is newMailboxHandlerTestHarness with a
// configured ECHOLET_MAX_MESSAGE_BYTES, returning the services the round trip
// needs. It exists rather than reusing newMailboxHandlerWithMaxMessageBytes
// (mailbox_poll_capacity_test.go:328) because that helper returns only the
// handler and this test has to publish a recipient and read the store back.
func newRaisedMaxMessageBytesHarness(t *testing.T, maxMessageBytes int64) (*MailboxHandler, *service.DeviceRecordService, *service.MailboxService) {
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
