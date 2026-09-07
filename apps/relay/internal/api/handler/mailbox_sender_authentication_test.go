package handler

import (
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"echolet/apps/relay/internal/cryptoutil"
	"echolet/apps/relay/internal/model"
)

// RED tests for T50 / finding T49-F-001 (major): /v1/messages/send must authenticate the sender.
//
// The route has never authenticated anyone. T49 measured what that costs on the real relay binary
// at default configuration: 49 unauthenticated POSTs of maximum-size envelopes (~12.8 MB, under
// 30 s inside the 120/min rate limit) permanently wedge a victim's mailbox for up to the 168 h
// retention cap, and 800 minimum-size envelopes do the same. The only secret required is the
// victim's recipient_mailbox_id, a digest of an identity id published in the victim's own contact
// card. T48's 16-page client walk raised the price from one envelope to forty-nine; it did not
// remove the capability, because a client-side page bound cannot outrun a mailbox an
// unauthenticated party can fill.
//
// The property pinned here closes the capability at its source: an envelope whose sender the relay
// cannot authenticate against an already-published, root-signed DeviceRecord is refused with a
// bounded 4xx BEFORE it is stored, so it never reaches a victim's mailbox at all. The trust chain
// is the one `authorizeMailboxDevice` already resolves for challenge / poll / ack - the
// (mailbox identity, device UUID) binding - applied to the SENDER's mailbox identity rather than
// the recipient's.
//
// The transcript is pinned literally in `mailboxEnvelopeSenderTranscript` below rather than by
// calling the production helper, so a relay that formats it differently fails here instead of
// silently diverging from the TypeScript senders. Its TypeScript counterpart is pinned in
// packages/crypto-core/src/mailbox/auth.envelope.test.ts.
//
// No exact status code or error code is pinned except where an existing contract already fixes one
// (F-004's HTTP 409 ENVELOPE_ID_CONFLICT). The tests require a bounded 4xx with a client error
// code, and that nothing was persisted.
//
// Only labels, counts, status codes, error codes and identifiers appear in output. Ciphertext is
// inert padding, and no request or response body is printed.

// ---------------------------------------------------------------------------
// Shared sender fixture
// ---------------------------------------------------------------------------

// testSenderDeviceID is the sender device UUID every envelope fixture in this package already
// uses, so binding the shared fixture to it needs no change to those fixtures.
const testSenderDeviceID = "7319a570-67c7-4c8b-bb0b-4dcdf41de5ec"

// legacySenderIdentityPlaceholder is the free-string sender identity the pre-T50 fixtures carry.
// It is not a published identity, so `sendEnvelopeRequest` replaces it with the shared test
// sender's real identity key before signing.
const legacySenderIdentityPlaceholder = "sender-identity"

// Fixed seeds keep the fixture deterministic: a byte-identical envelope must produce a
// byte-identical signature, which is what F-004's idempotent replay depends on.
var (
	testSenderIdentitySeed = [ed25519.SeedSize]byte{'t', '5', '0', '-', 's', 'e', 'n', 'd', 'e', 'r', '-', 'i', 'd', 'e', 'n', 't', 'i', 't', 'y', '-', 's', 'e', 'e', 'd', '-', '0', '0', '0', '0', '0', '0', '1'}
	testSenderDeviceSeed   = [ed25519.SeedSize]byte{'t', '5', '0', '-', 's', 'e', 'n', 'd', 'e', 'r', '-', 'd', 'e', 'v', 'i', 'c', 'e', '-', 's', 'e', 'e', 'd', '-', '0', '0', '0', '0', '0', '0', '0', '0', '2'}
	testImpostorDeviceSeed = [ed25519.SeedSize]byte{'t', '5', '0', '-', 'i', 'm', 'p', 'o', 's', 't', 'o', 'r', '-', 'd', 'e', 'v', 'i', 'c', 'e', '-', 's', 'e', 'e', 'd', '-', '0', '0', '0', '0', '0', '0', '3'}
)

func testSenderIdentityKey() ed25519.PrivateKey {
	return ed25519.NewKeyFromSeed(testSenderIdentitySeed[:])
}

func testSenderDeviceKey() ed25519.PrivateKey {
	return ed25519.NewKeyFromSeed(testSenderDeviceSeed[:])
}

func testImpostorDeviceKey() ed25519.PrivateKey {
	return ed25519.NewKeyFromSeed(testImpostorDeviceSeed[:])
}

// testSenderIdentityID is the sender's identity id: the base64url ed25519 identity public key,
// exactly as the CLI publishes it.
func testSenderIdentityID() string {
	return base64.RawURLEncoding.EncodeToString(testSenderIdentityKey().Public().(ed25519.PublicKey))
}

// testSenderDeviceRecord builds the sender's root-signed DeviceRecord - the same artefact
// /v2/prekeys/publish stores for every CLI profile that has run `relay publish`
// (storage/repository/signal_prekey_bundle_v2.go:55,83) and the same one
// /v1/device-records/publish stores directly.
func testSenderDeviceRecord(t *testing.T) *model.DeviceRecord {
	t.Helper()

	identityKey := testSenderIdentityKey()
	record := &model.DeviceRecord{
		Type:         "device_record",
		Version:      1,
		IdentityID:   testSenderIdentityID(),
		DeviceID:     testSenderDeviceID,
		DevicePubKey: base64.RawURLEncoding.EncodeToString(testSenderDeviceKey().Public().(ed25519.PublicKey)),
		Capabilities: map[string]bool{"mailbox_poll": true},
		CreatedAtMs:  1770000000000,
	}

	canonical, err := cryptoutil.MarshalCanonicalJSONWithoutSignature(record)
	if err != nil {
		t.Fatalf("MarshalCanonicalJSONWithoutSignature(sender) error = %v", err)
	}
	record.Signature = base64.RawURLEncoding.EncodeToString(ed25519.Sign(identityKey, canonical))
	return record
}

// publishTestSender makes the shared sender resolvable through the same
// (mailbox identity, device UUID) binding `authorizeMailboxDevice` uses. Saving is idempotent, so
// calling it per request is safe.
func publishTestSender(t *testing.T, handler *MailboxHandler) {
	t.Helper()
	if err := handler.deviceService.PublishDeviceRecord(testSenderDeviceRecord(t)); err != nil {
		t.Fatalf("PublishDeviceRecord(test sender) error = %v", err)
	}
}

// ---------------------------------------------------------------------------
// The transcript, pinned literally
// ---------------------------------------------------------------------------

func mailboxEnvelopeCiphertextDigest(ciphertext string) string {
	digest := sha256.Sum256([]byte(ciphertext))
	return base64.RawURLEncoding.EncodeToString(digest[:])
}

// mailboxEnvelopeSenderTranscript is the exact UTF-8 string the sender signs. It binds where the
// envelope lands, which envelope it is, who it claims to be from, what it contains, and how long it
// occupies the mailbox - every input to the T49-F-001 capability.
func mailboxEnvelopeSenderTranscript(envelope *model.MailboxEnvelope) string {
	return fmt.Sprintf(
		"echolet-mailbox-envelope:v1:%s:%s:%s:%s:%s:%d:%d",
		envelope.RecipientMailboxID,
		envelope.EnvelopeID,
		envelope.SenderIdentityID,
		envelope.SenderDeviceID,
		mailboxEnvelopeCiphertextDigest(envelope.Ciphertext),
		envelope.CreatedAtMs,
		envelope.ExpiresAtMs,
	)
}

func signEnvelopeTranscript(envelope *model.MailboxEnvelope, deviceKey ed25519.PrivateKey) string {
	return base64.RawURLEncoding.EncodeToString(ed25519.Sign(deviceKey, []byte(mailboxEnvelopeSenderTranscript(envelope))))
}

// ---------------------------------------------------------------------------
// Wire helpers
// ---------------------------------------------------------------------------

// envelopeWire renders an envelope as the JSON object the route receives, so a test can attach,
// omit or corrupt `sender_signature` without depending on the Go model's field layout.
func envelopeWire(t *testing.T, envelope *model.MailboxEnvelope) map[string]any {
	t.Helper()

	encoded, err := json.Marshal(envelope)
	if err != nil {
		t.Fatalf("json.Marshal(envelope) error = %v", err)
	}
	var wire map[string]any
	if err := json.Unmarshal(encoded, &wire); err != nil {
		t.Fatalf("json.Unmarshal(envelope) error = %v", err)
	}
	delete(wire, "sender_signature")
	return wire
}

func sendEnvelopeWire(t *testing.T, handler *MailboxHandler, wire map[string]any) *httptest.ResponseRecorder {
	t.Helper()
	return postJSON(t, http.HandlerFunc(handler.SendEnvelope), map[string]any{"envelope": wire})
}

// sendSignedEnvelope binds the envelope to the shared published sender and signs it, which is the
// authenticated path a real CLI send takes.
func sendSignedEnvelope(t *testing.T, handler *MailboxHandler, envelope *model.MailboxEnvelope) *httptest.ResponseRecorder {
	t.Helper()
	envelope.SenderIdentityID = testSenderIdentityID()
	envelope.SenderDeviceID = testSenderDeviceID
	wire := envelopeWire(t, envelope)
	wire["sender_signature"] = signEnvelopeTranscript(envelope, testSenderDeviceKey())
	return sendEnvelopeWire(t, handler, wire)
}

// assertBoundedClientRejection requires the bounded 4xx with a client error code that every
// malformed-input path on this route already answers with.
func assertBoundedClientRejection(t *testing.T, label string, response *httptest.ResponseRecorder) {
	t.Helper()
	if response.Code >= http.StatusInternalServerError {
		t.Fatalf("SendEnvelope(%s) status = %d, want a bounded 4xx (error code %q): an unauthenticated sender is malformed client input, not an internal error",
			label, response.Code, mailboxErrorCode(t, response))
	}
	if response.Code < http.StatusBadRequest {
		t.Fatalf("SendEnvelope(%s) status = %d, want a 4xx rejection: /v1/messages/send must not store an envelope whose sender it cannot authenticate against a published, root-signed DeviceRecord. "+
			"T49 measured 49 unauthenticated POSTs wedging a victim's mailbox for up to 168 h; the flooding path is only closed if this envelope never reaches the mailbox",
			label, response.Code)
	}
	if code := mailboxErrorCode(t, response); code == "" || code == "INTERNAL_ERROR" {
		t.Fatalf("SendEnvelope(%s) error code = %q, want a client-error code", label, code)
	}
}

func assertMailboxEmpty(t *testing.T, handler *MailboxHandler, label, mailboxID string) {
	t.Helper()
	stored, err := handler.mailboxService.GetEnvelopes(mailboxID, 100)
	if err != nil {
		t.Fatalf("GetEnvelopes() error = %v", err)
	}
	if len(stored) != 0 {
		t.Fatalf("stored envelopes after %s = %d, want 0: a refused envelope must never be persisted, or the refusal does not close the flooding path",
			label, len(stored))
	}
}

// newSenderAuthEnvelope builds an envelope in exactly the shape the CLI emits, addressed to the
// mailbox owner and attributed to the shared test sender.
func newSenderAuthEnvelope(mailboxID string, recipient *model.DeviceRecord, envelopeID, ciphertext string, nowMS int64) *model.MailboxEnvelope {
	return &model.MailboxEnvelope{
		Type:                "mailbox_envelope",
		Version:             1,
		EnvelopeID:          envelopeID,
		MessageID:           "3f9a0c86-71b2-4d5e-8a14-6c9e2b7d0f43",
		SenderIdentityID:    testSenderIdentityID(),
		SenderDeviceID:      testSenderDeviceID,
		RecipientIdentityID: recipient.IdentityID,
		RecipientDeviceID:   recipient.DeviceID,
		RecipientMailboxID:  mailboxID,
		PayloadType:         "ciphertext_message",
		Ciphertext:          ciphertext,
		CreatedAtMs:         nowMS - 1000,
		ExpiresAtMs:         nowMS + 24*int64(time.Hour/time.Millisecond),
		SizeBytes:           int64(len(ciphertext)),
	}
}

// senderAuthHarness returns a handler with the recipient AND the shared sender published.
func senderAuthHarness(t *testing.T) (*MailboxHandler, *model.DeviceRecord, ed25519.PrivateKey, string) {
	t.Helper()

	handler, deviceService, _ := newMailboxHandlerTestHarness(t)
	recipient, recipientDeviceKey := signedDeviceRecord(t)
	if err := deviceService.PublishDeviceRecord(recipient); err != nil {
		t.Fatalf("PublishDeviceRecord(recipient) error = %v", err)
	}
	publishTestSender(t, handler)
	return handler, recipient, recipientDeviceKey, cryptoutil.DeriveMailboxID(recipient.IdentityID)
}

// ---------------------------------------------------------------------------
// Properties
// ---------------------------------------------------------------------------

// TestSendEnvelopeAcceptsAnAuthenticatedSender is the control: the fix must not close the route.
// The sender's DeviceRecord is published, the transcript is signed with its device key, the
// envelope is accepted, and the signature survives storage so the victim's poll can still parse the
// response it gets back.
func TestSendEnvelopeAcceptsAnAuthenticatedSender(t *testing.T) {
	handler, recipient, recipientDeviceKey, mailboxID := senderAuthHarness(t)
	nowMS := time.Now().UnixMilli()

	envelope := newSenderAuthEnvelope(mailboxID, recipient, "5c2f9b71-8d43-4e60-a95c-1b7e0d3a6f28", "QUFBQUFBQUFBQUFB", nowMS)
	signature := signEnvelopeTranscript(envelope, testSenderDeviceKey())
	wire := envelopeWire(t, envelope)
	wire["sender_signature"] = signature

	accepted := sendEnvelopeWire(t, handler, wire)
	if accepted.Code != http.StatusOK {
		t.Fatalf("SendEnvelope(authenticated sender) status = %d, want %d (error code %q): a sender with a published, root-signed DeviceRecord must still be able to send",
			accepted.Code, http.StatusOK, mailboxErrorCode(t, accepted))
	}

	delivered := pollEnvelopeObjects(t, handler, recipient, recipientDeviceKey, mailboxID)
	if len(delivered) != 1 {
		t.Fatalf("poll returned %d envelopes, want exactly the 1 authenticated envelope", len(delivered))
	}
	if got, _ := delivered[0]["sender_signature"].(string); got != signature {
		t.Fatalf("polled envelope sender_signature = %q, want the accepted signature: the binding must be stored and served back, so the recipient can verify who the relay admitted",
			got)
	}
}

// TestSendEnvelopeRefusesAnUnauthenticatedSender is the finding itself. Each case is an envelope an
// attacker can build today with nothing but the victim's mailbox id.
func TestSendEnvelopeRefusesAnUnauthenticatedSender(t *testing.T) {
	nowMS := time.Now().UnixMilli()

	cases := []struct {
		name string
		// build returns the wire object to POST, given a correctly built envelope.
		build func(t *testing.T, envelope *model.MailboxEnvelope) map[string]any
	}{
		{
			name: "no sender_signature at all - exactly the T49-F-001 poison POST",
			build: func(t *testing.T, envelope *model.MailboxEnvelope) map[string]any {
				return envelopeWire(t, envelope)
			},
		},
		{
			name: "sender_signature is not base64url",
			build: func(t *testing.T, envelope *model.MailboxEnvelope) map[string]any {
				wire := envelopeWire(t, envelope)
				wire["sender_signature"] = "not a signature!!"
				return wire
			},
		},
		{
			name: "sender_signature is base64url of the wrong length",
			build: func(t *testing.T, envelope *model.MailboxEnvelope) map[string]any {
				wire := envelopeWire(t, envelope)
				wire["sender_signature"] = base64.RawURLEncoding.EncodeToString([]byte("too short to be ed25519"))
				return wire
			},
		},
		{
			name: "sender_signature is empty",
			build: func(t *testing.T, envelope *model.MailboxEnvelope) map[string]any {
				wire := envelopeWire(t, envelope)
				wire["sender_signature"] = ""
				return wire
			},
		},
		{
			name: "sender_signature is oversized, so it can never reach the store unbounded",
			build: func(t *testing.T, envelope *model.MailboxEnvelope) map[string]any {
				wire := envelopeWire(t, envelope)
				wire["sender_signature"] = strings.Repeat("A", 70000)
				return wire
			},
		},
		{
			name: "signed with a key that is not the sender's published device key",
			build: func(t *testing.T, envelope *model.MailboxEnvelope) map[string]any {
				wire := envelopeWire(t, envelope)
				wire["sender_signature"] = signEnvelopeTranscript(envelope, testImpostorDeviceKey())
				return wire
			},
		},
		{
			name: "signed with the sender's IDENTITY root key instead of its device key",
			build: func(t *testing.T, envelope *model.MailboxEnvelope) map[string]any {
				// The device record is root-signed by the identity key, but the identity key is not
				// the key the relay verifies mailbox operations with; only device_pubkey is.
				wire := envelopeWire(t, envelope)
				wire["sender_signature"] = signEnvelopeTranscript(envelope, testSenderIdentityKey())
				return wire
			},
		},
	}

	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			handler, recipient, _, mailboxID := senderAuthHarness(t)
			envelope := newSenderAuthEnvelope(mailboxID, recipient, "a1000000-0000-4000-8000-000000000001", "QUFBQUFBQUFBQUFB", nowMS)

			response := sendEnvelopeWire(t, handler, test.build(t, envelope))

			assertBoundedClientRejection(t, test.name, response)
			assertMailboxEmpty(t, handler, test.name, mailboxID)
		})
	}
}

// TestSendEnvelopeRefusesASignatureOverADifferentTranscript pins that the binding is not
// decorative. Each case takes a legitimately signed envelope and changes one bound field
// afterwards - the field an attacker would want to change to reuse a captured signature.
func TestSendEnvelopeRefusesASignatureOverADifferentTranscript(t *testing.T) {
	nowMS := time.Now().UnixMilli()

	cases := []struct {
		name   string
		mutate func(*model.MailboxEnvelope)
	}{
		{"recipient_mailbox_id - retargeting the envelope at another victim", func(e *model.MailboxEnvelope) {
			e.RecipientMailboxID = cryptoutil.DeriveMailboxID("some-other-victim-identity")
		}},
		{"envelope_id - re-injecting the same body as a fresh envelope", func(e *model.MailboxEnvelope) {
			e.EnvelopeID = "00000000-0000-4000-8000-000000000009"
		}},
		{"sender_identity_id - claiming a different sender", func(e *model.MailboxEnvelope) {
			e.SenderIdentityID = base64.RawURLEncoding.EncodeToString(testImpostorDeviceKey().Public().(ed25519.PublicKey))
		}},
		{"sender_device_id - claiming a different device", func(e *model.MailboxEnvelope) {
			e.SenderDeviceID = "8cc8010b-d4a1-4ce7-8203-a8f6b055c1b9"
		}},
		{"ciphertext - swapping the payload after signing", func(e *model.MailboxEnvelope) {
			e.Ciphertext = "QkJCQkJCQkJCQkJC"
			e.SizeBytes = int64(len(e.Ciphertext))
		}},
		{"created_at_ms", func(e *model.MailboxEnvelope) { e.CreatedAtMs -= 1 }},
		{"expires_at_ms - extending how long the envelope occupies the mailbox", func(e *model.MailboxEnvelope) {
			e.ExpiresAtMs += 1
		}},
	}

	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			handler, recipient, _, mailboxID := senderAuthHarness(t)

			signed := newSenderAuthEnvelope(mailboxID, recipient, "a2000000-0000-4000-8000-000000000002", "QUFBQUFBQUFBQUFB", nowMS)
			capturedSignature := signEnvelopeTranscript(signed, testSenderDeviceKey())

			test.mutate(signed)
			wire := envelopeWire(t, signed)
			wire["sender_signature"] = capturedSignature

			response := sendEnvelopeWire(t, handler, wire)
			assertBoundedClientRejection(t, test.name, response)

			// Check both mailboxes: the retargeting case deliberately points at another one.
			assertMailboxEmpty(t, handler, test.name, mailboxID)
			assertMailboxEmpty(t, handler, test.name+" (target mailbox)", signed.RecipientMailboxID)
		})
	}
}

// TestSendEnvelopeRefusesASenderWithNoPublishedDeviceRecord is the case that actually closes
// T49-F-001. A self-consistent signature over a self-chosen identity proves nothing: the relay must
// resolve the sender through the same (mailbox identity, device UUID) binding it uses for
// challenge / poll / ack, and refuse when there is no such binding.
func TestSendEnvelopeRefusesASenderWithNoPublishedDeviceRecord(t *testing.T) {
	handler, deviceService, _ := newMailboxHandlerTestHarness(t)
	recipient, _ := signedDeviceRecord(t)
	if err := deviceService.PublishDeviceRecord(recipient); err != nil {
		t.Fatalf("PublishDeviceRecord(recipient) error = %v", err)
	}
	// Deliberately NOT publishing the sender.

	mailboxID := cryptoutil.DeriveMailboxID(recipient.IdentityID)
	envelope := newSenderAuthEnvelope(mailboxID, recipient, "a3000000-0000-4000-8000-000000000003", "QUFBQUFBQUFBQUFB", time.Now().UnixMilli())
	wire := envelopeWire(t, envelope)
	wire["sender_signature"] = signEnvelopeTranscript(envelope, testSenderDeviceKey())

	response := sendEnvelopeWire(t, handler, wire)
	assertBoundedClientRejection(t, "sender has no published device record", response)
	assertMailboxEmpty(t, handler, "sender has no published device record", mailboxID)
}

// TestUnauthenticatedFloodCannotReachAMailbox is the finding stated as an outcome rather than as a
// mechanism. T49 drove 49 max-size and 800 minimum-size unauthenticated POSTs into a victim's
// mailbox and the victim could not receive anything afterwards. With sender authentication the
// flood never lands, so the legitimate message behind it is delivered by a single ordinary poll.
func TestUnauthenticatedFloodCannotReachAMailbox(t *testing.T) {
	const floodEnvelopes = 20

	handler, recipient, recipientDeviceKey, mailboxID := senderAuthHarness(t)
	nowMS := time.Now().UnixMilli()

	// The attacker knows only the victim's mailbox id. Every envelope is shape-valid, so nothing
	// T48 added refuses them, and each envelope_id sorts ahead of the random v4 UUID a real CLI
	// issues - the exact ordering T49 used to put the poison at the head of the mailbox.
	refused := 0
	for index := 0; index < floodEnvelopes; index++ {
		poison := newSenderAuthEnvelope(
			mailboxID,
			recipient,
			fmt.Sprintf("00000000-0000-1000-8000-%012d", index),
			"UE9JU09OUE9JU09OUE9JU09O",
			nowMS,
		)
		// An attacker cannot produce a device key bound to any published identity, so the best it
		// can do is a self-consistent signature over a self-chosen identity.
		poison.SenderIdentityID = base64.RawURLEncoding.EncodeToString(testImpostorDeviceKey().Public().(ed25519.PublicKey))
		wire := envelopeWire(t, poison)
		wire["sender_signature"] = signEnvelopeTranscript(poison, testImpostorDeviceKey())

		response := sendEnvelopeWire(t, handler, wire)
		if response.Code >= http.StatusBadRequest && response.Code < http.StatusInternalServerError {
			refused++
		}
	}
	if refused != floodEnvelopes {
		t.Fatalf("unauthenticated flood: %d of %d envelopes refused, want all %d; every one that is accepted occupies the victim's mailbox for up to the 168 h retention cap",
			refused, floodEnvelopes, floodEnvelopes)
	}
	assertMailboxEmpty(t, handler, fmt.Sprintf("a %d-envelope unauthenticated flood", floodEnvelopes), mailboxID)

	// The legitimate message that T49 saw permanently undeliverable.
	legitimate := newSenderAuthEnvelope(mailboxID, recipient, "5c2f9b71-8d43-4e60-a95c-1b7e0d3a6f28", "QUFBQUFBQUFBQUFB", nowMS)
	accepted := sendSignedEnvelope(t, handler, legitimate)
	if accepted.Code != http.StatusOK {
		t.Fatalf("SendEnvelope(legitimate, authenticated) status = %d, want %d (error code %q)",
			accepted.Code, http.StatusOK, mailboxErrorCode(t, accepted))
	}

	delivered := pollEnvelopeObjects(t, handler, recipient, recipientDeviceKey, mailboxID)
	if len(delivered) != 1 {
		t.Fatalf("poll returned %d envelopes, want exactly the 1 legitimate envelope: an unauthenticated flood must not cost the message behind it",
			len(delivered))
	}
	if got, _ := delivered[0]["envelope_id"].(string); got != legitimate.EnvelopeID {
		t.Fatalf("poll returned envelope_id %q, want %q", got, legitimate.EnvelopeID)
	}
}

// TestAuthenticatedSendKeepsEnvelopeIDReplaySemantics pins that authentication does not disturb
// F-004: a byte-identical replay of an accepted envelope stays idempotent, and a DIFFERENT body
// under the same envelope_id is still HTTP 409 ENVELOPE_ID_CONFLICT - not a signature complaint -
// because the conflicting envelope is validly re-signed and therefore reaches the store.
func TestAuthenticatedSendKeepsEnvelopeIDReplaySemantics(t *testing.T) {
	handler, recipient, _, mailboxID := senderAuthHarness(t)
	nowMS := time.Now().UnixMilli()
	const envelopeID = "3a4b1c66-0f2f-4c74-9d21-9b1d5f1a7c10"

	accepted := newSenderAuthEnvelope(mailboxID, recipient, envelopeID, "QUFBQUFBQUFBQUFB", nowMS)
	acceptedWire := envelopeWire(t, accepted)
	acceptedWire["sender_signature"] = signEnvelopeTranscript(accepted, testSenderDeviceKey())

	first := sendEnvelopeWire(t, handler, acceptedWire)
	if first.Code != http.StatusOK {
		t.Fatalf("SendEnvelope(first) status = %d, want %d (code %q)", first.Code, http.StatusOK, mailboxErrorCode(t, first))
	}

	replay := sendEnvelopeWire(t, handler, acceptedWire)
	if replay.Code != http.StatusOK {
		t.Fatalf("SendEnvelope(byte-identical signed replay) status = %d, want %d (code %q): the signature is deterministic, so an exact retry must stay idempotent",
			replay.Code, http.StatusOK, mailboxErrorCode(t, replay))
	}

	conflicting := newSenderAuthEnvelope(mailboxID, recipient, envelopeID, "QkJCQkJCQkJCQkJCQkJCQg", nowMS)
	conflictingWire := envelopeWire(t, conflicting)
	conflictingWire["sender_signature"] = signEnvelopeTranscript(conflicting, testSenderDeviceKey())

	conflict := sendEnvelopeWire(t, handler, conflictingWire)
	if conflict.Code != http.StatusConflict {
		t.Fatalf("SendEnvelope(validly signed different body, same envelope_id) status = %d, want %d ENVELOPE_ID_CONFLICT (code %q): sender authentication must run before storage without swallowing the conflict",
			conflict.Code, http.StatusConflict, mailboxErrorCode(t, conflict))
	}
	if code := mailboxErrorCode(t, conflict); code != "ENVELOPE_ID_CONFLICT" {
		t.Fatalf("SendEnvelope(conflicting) error code = %q, want ENVELOPE_ID_CONFLICT", code)
	}

	stored, err := handler.mailboxService.GetEnvelopes(mailboxID, 10)
	if err != nil {
		t.Fatalf("GetEnvelopes() error = %v", err)
	}
	if len(stored) != 1 || stored[0].Ciphertext != accepted.Ciphertext {
		t.Fatalf("stored envelopes = %d, want the 1 originally accepted envelope unchanged", len(stored))
	}
}

// TestPollNeverServesAnEmptySenderSignature guards the wire in the other direction. The CLI parses
// a whole poll response as z.array(MailboxEnvelopeSchema.strict()) and the signature field is a
// bounded non-empty string there, so a record written before the field existed must be served
// WITHOUT the key rather than with an empty one - otherwise one legacy record fails the batch parse
// and wedges the mailbox, which is the class of defect this flow has been closing since R2-001.
func TestPollNeverServesAnEmptySenderSignature(t *testing.T) {
	handler, recipient, recipientDeviceKey, mailboxID := senderAuthHarness(t)
	nowMS := time.Now().UnixMilli()

	// Written straight through the service, as a record stored before sender authentication existed.
	legacy := newSenderAuthEnvelope(mailboxID, recipient, "7b95a59f-53f2-4d51-8e27-a659cf30fd95", "QUFBQUFBQUFBQUFB", nowMS)
	if err := handler.mailboxService.StoreEnvelope(legacy); err != nil {
		t.Fatalf("StoreEnvelope(legacy) error = %v", err)
	}

	delivered := pollEnvelopeObjects(t, handler, recipient, recipientDeviceKey, mailboxID)
	if len(delivered) != 1 {
		t.Fatalf("poll returned %d envelopes, want 1", len(delivered))
	}
	if value, present := delivered[0]["sender_signature"]; present {
		if text, ok := value.(string); ok && text == "" {
			t.Fatalf("polled envelope carries sender_signature = \"\", which MailboxEnvelopeSchema refuses: the whole poll batch fails to parse and the mailbox is wedged. The field must be omitted when absent")
		}
	}
}

// ---------------------------------------------------------------------------
// Poll helper that keeps the raw JSON objects
// ---------------------------------------------------------------------------

// pollEnvelopeObjects runs the real challenge/poll handshake for the mailbox owner and returns the
// delivered envelopes as raw JSON objects, so assertions can inspect fields the Go model may not
// declare. Response bodies are decoded, never printed.
func pollEnvelopeObjects(t *testing.T, handler *MailboxHandler, recipient *model.DeviceRecord, recipientDeviceKey ed25519.PrivateKey, mailboxID string) []map[string]any {
	t.Helper()

	response := pollMailboxOnce(t, handler, mailboxID, recipient.DeviceID, recipientDeviceKey, 50)
	if response.Code != http.StatusOK {
		t.Fatalf("PollMailbox() status = %d (error code %q)", response.Code, mailboxErrorCode(t, response))
	}

	var parsed struct {
		Data struct {
			Envelopes []map[string]any `json:"envelopes"`
		} `json:"data"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &parsed); err != nil {
		t.Fatalf("json.Unmarshal(poll) error = %v", err)
	}
	return parsed.Data.Envelopes
}
