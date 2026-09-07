package handler

import (
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"echolet/apps/relay/internal/cryptoutil"
	"echolet/apps/relay/internal/model"
)

// RED tests for T53 / finding T52-F-001 (major): a per-sender unacked-envelope quota on a mailbox.
//
// What T52 measured, by execution against the real relay binary at default configuration:
// sender authentication (T51) is real and correct - unsigned, tampered, wrong-key and
// unpublished-sender envelopes are all refused before storage - but POST /v1/device-records/publish
// is itself unauthenticated. An attacker mints an ed25519 identity, self-publishes one device
// record (HTTP 200, no credential), and then floods a victim with *perfectly valid* signatures. The
// thresholds are unchanged from before sender authentication: 48 maximum-size envelopes deliver and
// 49 wedge; 799 deliver and 800 wedge; the wedge holds up to the 168 h retention cap.
//
// What this file pins, and what it deliberately does NOT claim
// ------------------------------------------------------------
// A per-sender quota raises the attacker's cost roughly LINEARLY: they need about
// (drain-walk capacity / quota) identities instead of one. It does NOT structurally close the class
// while identity creation is free. Every test here is written to that honesty:
//
//   - the quota itself, and that it is refused before storage with a distinguishable code
//     (TestSendEnvelopeEnforcesAPerSenderUnackedQuota)
//   - that it frees again on ack and on expiry, so it is a quota and not a permanent lockout of a
//     legitimate contact (TestAckingAnEnvelopeFreesSenderQuota,
//     TestExpiredEnvelopesDoNotConsumeSenderQuota)
//   - that it is scoped to ONE recipient mailbox, so one victim cannot lock a sender out of every
//     other conversation (TestSenderQuotaIsScopedToOneRecipientMailbox)
//   - that F-004's idempotent replay does not consume additional quota, so an ambiguous send
//     retried with the identical envelope never burns the sender's own allowance
//     (TestIdempotentReplayDoesNotConsumeSenderQuota)
//   - the measurable improvement: one identity alone can no longer wedge the client's bounded drain
//     walk (TestASingleIdentityCannotWedgeTheBoundedDrainWalk)
//   - and the honest residue, recorded rather than hidden: N distinct identities still occupy
//     N x quota slots and still wedge the walk
//     (TestKnownResidueDistinctIdentitiesStillWedgeTheDrainWalk)
//
// Only labels, counts, status codes, error codes and identifiers are ever printed. Ciphertext is
// inert padding; no request or response body is echoed.

// ---------------------------------------------------------------------------
// The pinned numbers
// ---------------------------------------------------------------------------

// senderUnackedQuota is the maximum number of UNACKED envelopes one sender identity may hold in one
// recipient mailbox.
//
// Why sixteen, stated so it can be argued with:
//
//   - Legitimate use never reaches it. A two-party conversation acks on every poll, so the standing
//     unacked count from any one sender is normally 0-2. In this prototype one `send` is one
//     envelope, so 16 is sixteen consecutive messages to a peer who has not polled even once - an
//     order of magnitude of headroom over any real backlog.
//   - It is strictly below what one identity would need to fill the recipient's bounded drain walk
//     in the WORST (byte-bounded) regime T52 measured: 16 pages x 3 maximum-size envelopes per page
//     = 48 slots. 16 < 48, so one identity can never fill the walk, and 32 slots stay free for the
//     legitimate message behind it.
//   - It raises the attacker's identity count from 1 to ceil(48/16) = 3 in the byte-bounded regime
//     and from 1 to ceil(800/16) = 50 in the count-bounded regime. That is the linear improvement,
//     and it is the whole improvement.
//   - It is far below ECHOLET_MAX_MAILBOX_BATCH (100), so one poll page can still carry more than a
//     single sender's entire allowance.
//
// Lower would buy more attacker cost at the price of squeezing a legitimate offline backlog; higher
// (32) would leave ceil(48/32) = 2 identities, which is barely an improvement at all.
const senderUnackedQuota = 16

// senderQuotaErrorCode is the wire code the route must answer with. It is pinned literally, and in
// exactly one place per language, because the Go relay and the TypeScript client have to agree on
// it for the condition to survive the transport boundary at all - the same requirement that made
// PREKEY_BUNDLE_UNAVAILABLE and UNAUTHORIZED_MAILBOX_ACCESS explicit codes rather than a generic
// protocol rejection. Its client-side half is pinned in
// apps/cli/src/transport/relayClient.senderQuota.test.ts and
// apps/cli/src/commands/cli.senderQuota.test.ts.
const senderQuotaErrorCode = "SENDER_QUOTA_EXCEEDED"

// clientDrainWalkPages is the recipient's bounded page walk, apps/cli/src/runtime/inbound.ts:71
// (`maxPollPagesPerPoll = 16`). It is the bound the whole T49/T52 flooding class turns on: a
// permanently-unacceptable envelope is deliberately never acknowledged (F-012), so poison at the
// head of the mailbox is re-offered on every poll, and a legitimate message that never falls inside
// these pages is never delivered and expires.
const clientDrainWalkPages = 16

// maxSizeDrainWalkEnvelopes is the number of MAXIMUM-size envelopes that walk covers in the
// byte-bounded regime T52 measured on the real binary: the ~1 MiB poll response budget admits 3
// envelopes of 262 144-byte ciphertext per page, so 16 pages reach 48 - the exact point where T52
// recorded "48 deliver, 49 wedge". It appears here only as the number the quota must stay under.
const maxSizeDrainWalkEnvelopes = 48

// quotaWalkPageSize is the page size the drain-walk simulations below use. It is a legal
// poll_batch_size (config.ts bounds it to 1..100) chosen small so a faithful 16-page walk can be
// driven with small envelopes instead of ~12.8 MB of maximum-size ciphertext. The mechanics - real
// challenge, real poll route, real cursor resumption, nothing acked - are the production ones.
const quotaWalkPageSize = 2

// ---------------------------------------------------------------------------
// Senders
// ---------------------------------------------------------------------------

// quotaTestSender is one published sender identity: exactly what an attacker mints for the cost of
// one unauthenticated POST /v1/device-records/publish, and also exactly what a legitimate CLI
// profile holds after `relay publish`. The tests below rely on those being indistinguishable,
// because T52 proved they are.
type quotaTestSender struct {
	label      string
	identityID string
	deviceID   string
	deviceKey  ed25519.PrivateKey
}

// quotaDeviceUUID derives a deterministic, wire-valid device UUID from a label. The envelope's
// sender_device_id must satisfy validation.clientMailboxUUID (version 1-8, variant 8/9/a/b).
func quotaDeviceUUID(label string) string {
	digest := sha256.Sum256([]byte("t53-quota-device-uuid:" + label))
	h := hex.EncodeToString(digest[:])
	return fmt.Sprintf("%s-%s-4%s-8%s-%s", h[0:8], h[8:12], h[12:15], h[15:18], h[18:30])
}

// publishQuotaSender mints a fresh identity and publishes its own root-signed DeviceRecord, which
// is all the relay requires of a sender. Deterministic seeds keep a byte-identical envelope
// producing a byte-identical signature, which is what F-004's idempotent replay depends on.
func publishQuotaSender(t *testing.T, handler *MailboxHandler, label string) quotaTestSender {
	t.Helper()

	identitySeed := sha256.Sum256([]byte("t53-quota-identity-seed:" + label))
	deviceSeed := sha256.Sum256([]byte("t53-quota-device-seed:" + label))
	identityKey := ed25519.NewKeyFromSeed(identitySeed[:])
	deviceKey := ed25519.NewKeyFromSeed(deviceSeed[:])

	sender := quotaTestSender{
		label:      label,
		identityID: base64.RawURLEncoding.EncodeToString(identityKey.Public().(ed25519.PublicKey)),
		deviceID:   quotaDeviceUUID(label),
		deviceKey:  deviceKey,
	}

	record := &model.DeviceRecord{
		Type:         "device_record",
		Version:      1,
		IdentityID:   sender.identityID,
		DeviceID:     sender.deviceID,
		DevicePubKey: base64.RawURLEncoding.EncodeToString(deviceKey.Public().(ed25519.PublicKey)),
		Capabilities: map[string]bool{"mailbox_poll": true},
		CreatedAtMs:  1770000000000,
	}
	canonical, err := cryptoutil.MarshalCanonicalJSONWithoutSignature(record)
	if err != nil {
		t.Fatalf("MarshalCanonicalJSONWithoutSignature(%s) error = %v", label, err)
	}
	record.Signature = base64.RawURLEncoding.EncodeToString(ed25519.Sign(identityKey, canonical))

	if err := handler.deviceService.PublishDeviceRecord(record); err != nil {
		t.Fatalf("PublishDeviceRecord(%s) error = %v", label, err)
	}
	return sender
}

// sendFromQuotaSender attributes the envelope to the given published sender and signs the
// transcript with that sender's device key: the fully authenticated path a real CLI send takes, and
// the one T52 showed an attacker can take too.
func sendFromQuotaSender(t *testing.T, handler *MailboxHandler, sender quotaTestSender, envelope *model.MailboxEnvelope) *httptest.ResponseRecorder {
	t.Helper()
	envelope.SenderIdentityID = sender.identityID
	envelope.SenderDeviceID = sender.deviceID
	wire := envelopeWire(t, envelope)
	wire["sender_signature"] = signEnvelopeTranscript(envelope, sender.deviceKey)
	return sendEnvelopeWire(t, handler, wire)
}

// ---------------------------------------------------------------------------
// Envelopes, mailboxes and assertions
// ---------------------------------------------------------------------------

// quotaEnvelopeID renders a head-sorting envelope id. Badger iterates "mailbox:<id>:<envelope_id>"
// lexicographically, so these sort ahead of every random v4 UUID a real CLI issues - the exact
// ordering T49 and T52 used to put poison at the head of a victim's mailbox.
func quotaEnvelopeID(index int) string {
	return fmt.Sprintf("00000000-0000-1000-8000-%012d", index)
}

// legitimateEnvelopeID sorts AFTER every quotaEnvelopeID, so an envelope carrying it is queued
// behind all the poison - the message T52 watched expire undelivered.
const legitimateEnvelopeID = "ffffffff-ffff-4fff-8fff-ffffffffffff"

func quotaEnvelope(mailboxID string, recipient *model.DeviceRecord, envelopeID string, nowMS int64) *model.MailboxEnvelope {
	return newSenderAuthEnvelope(mailboxID, recipient, envelopeID, "UVVGQlFVRkJRVUZC", nowMS)
}

// quotaEnvelopeExpiringIn builds an envelope with a deliberately short declared lifetime, so the
// test can observe what expiry does to the quota without reaching into the repository's clock.
func quotaEnvelopeExpiringIn(mailboxID string, recipient *model.DeviceRecord, envelopeID string, nowMS, lifetimeMS int64) *model.MailboxEnvelope {
	envelope := quotaEnvelope(mailboxID, recipient, envelopeID, nowMS)
	envelope.ExpiresAtMs = nowMS + lifetimeMS
	return envelope
}

// quotaHarness returns a handler with the recipient published and its mailbox id. Senders are
// published per test, because who is allowed to send is the whole subject here.
func quotaHarness(t *testing.T) (*MailboxHandler, *model.DeviceRecord, ed25519.PrivateKey, string) {
	t.Helper()

	handler, deviceService, _ := newMailboxHandlerTestHarness(t)
	recipient, recipientDeviceKey := signedDeviceRecord(t)
	if err := deviceService.PublishDeviceRecord(recipient); err != nil {
		t.Fatalf("PublishDeviceRecord(recipient) error = %v", err)
	}
	return handler, recipient, recipientDeviceKey, cryptoutil.DeriveMailboxID(recipient.IdentityID)
}

// storedEnvelopeIDs lists what the mailbox actually holds, which is the only evidence that a
// refusal happened BEFORE storage rather than after it.
func storedEnvelopeIDs(t *testing.T, handler *MailboxHandler, mailboxID string) []string {
	t.Helper()
	stored, err := handler.mailboxService.GetEnvelopes(mailboxID, 4096)
	if err != nil {
		t.Fatalf("GetEnvelopes() error = %v", err)
	}
	ids := make([]string, 0, len(stored))
	for _, envelope := range stored {
		ids = append(ids, envelope.EnvelopeID)
	}
	return ids
}

// assertQuotaRejection requires the bounded, distinguishable refusal the quota must answer with.
//
// The status must not be 429. That is not a style preference: the CLI's transport boundary
// classifies 429 (and every 5xx) as RETRYABLE (apps/cli/src/transport/relayClient.ts), and
// classify() maps a retryable RelayError to RELAY_UNAVAILABLE exit 4 WITHOUT ever consulting
// remoteCode - so a 429 would discard the diagnosis entirely and put a legitimate sender into a
// retry loop against a condition only the recipient can clear. The precedent to follow is
// PREKEY_BUNDLE_UNAVAILABLE (404) and UNAUTHORIZED_MAILBOX_ACCESS (403): a non-retryable 4xx
// carrying a code the client is willing to name.
func assertQuotaRejection(t *testing.T, label string, response *httptest.ResponseRecorder) {
	t.Helper()

	code := mailboxErrorCode(t, response)
	if response.Code < http.StatusBadRequest || response.Code >= http.StatusInternalServerError {
		t.Fatalf("SendEnvelope(%s) status = %d (code %q), want a bounded 4xx: an envelope beyond the sender's quota is client input the relay declines, not an internal error, and it must never reach the store",
			label, response.Code, code)
	}
	if response.Code == http.StatusTooManyRequests {
		t.Fatalf("SendEnvelope(%s) status = 429: relayClient.ts classifies 429 as retryable, so classify() answers RELAY_UNAVAILABLE (exit 4) and throws remoteCode away. The quota must answer a NON-retryable 4xx, as PREKEY_BUNDLE_UNAVAILABLE (404) and UNAUTHORIZED_MAILBOX_ACCESS (403) already do",
			label)
	}
	if code != senderQuotaErrorCode {
		t.Fatalf("SendEnvelope(%s) error code = %q, want %q: the condition must be distinguishable on the wire instead of collapsing into INVALID_SCHEMA, INVALID_SIGNATURE, UNAUTHORIZED_MAILBOX_ACCESS or the client's generic PROTOCOL_REJECTED",
			label, code, senderQuotaErrorCode)
	}
}

// ---------------------------------------------------------------------------
// Poll: one page, and the recipient's whole bounded walk
// ---------------------------------------------------------------------------

// pollMailboxPage performs one full challenge + signed poll round trip at an explicit cursor, which
// is what the recipient's multi-page walk actually does. An empty cursor starts at the head.
func pollMailboxPage(
	t *testing.T,
	handler *MailboxHandler,
	mailboxID string,
	deviceID string,
	devicePrivateKey ed25519.PrivateKey,
	batchSize int,
	cursor string,
) *httptest.ResponseRecorder {
	t.Helper()

	challengeResponse := postJSON(t, http.HandlerFunc(handler.CreateChallenge), map[string]string{
		"recipient_mailbox_id": mailboxID,
		"device_id":            deviceID,
		"signature":            signMessage(t, cryptoutil.CreateMailboxCreateChallengeMessage(mailboxID, deviceID), devicePrivateKey),
	})
	if challengeResponse.Code != http.StatusOK {
		t.Fatalf("CreateChallenge() status = %d", challengeResponse.Code)
	}

	var parsedChallenge struct {
		Data struct {
			ChallengeID string `json:"challenge_id"`
			Nonce       string `json:"nonce"`
		} `json:"data"`
	}
	if err := json.Unmarshal(challengeResponse.Body.Bytes(), &parsedChallenge); err != nil {
		t.Fatalf("json.Unmarshal(challenge) error = %v", err)
	}

	payload := map[string]any{
		"challenge_id":         parsedChallenge.Data.ChallengeID,
		"recipient_mailbox_id": mailboxID,
		"device_id":            deviceID,
		"batch_size":           batchSize,
		"signature": signMessage(t, cryptoutil.CreateMailboxChallengeMessage(
			parsedChallenge.Data.ChallengeID, mailboxID, deviceID, parsedChallenge.Data.Nonce,
		), devicePrivateKey),
	}
	if cursor != "" {
		payload["cursor"] = cursor
	}

	return postJSON(t, http.HandlerFunc(handler.PollMailbox), payload)
}

// drainWalkReaches reproduces the recipient's bounded drain walk against the REAL poll route: at
// most clientDrainWalkPages pages of pageSize envelopes, resuming on the relay's own next_cursor,
// acknowledging NOTHING - because the poison is permanently unacceptable and F-012 requires it is
// never acked. It reports whether the wanted envelope was reached inside those pages, and how many
// pages it took.
//
// This is the exact mechanism of the T49-F-001 / T52-F-001 wedge, so a test that drives it is
// asserting the outcome the user cares about rather than an internal counter.
func drainWalkReaches(
	t *testing.T,
	handler *MailboxHandler,
	recipient *model.DeviceRecord,
	recipientDeviceKey ed25519.PrivateKey,
	mailboxID string,
	pageSize int,
	wantedEnvelopeID string,
) (bool, int) {
	t.Helper()

	cursor := ""
	for page := 1; page <= clientDrainWalkPages; page++ {
		response := pollMailboxPage(t, handler, mailboxID, recipient.DeviceID, recipientDeviceKey, pageSize, cursor)
		if response.Code != http.StatusOK {
			t.Fatalf("drain walk page %d: poll status = %d (code %q)", page, response.Code, mailboxErrorCode(t, response))
		}

		batch := decodePollResponse(t, response)
		for _, envelope := range batch.Data.Envelopes {
			if envelope.EnvelopeID == wantedEnvelopeID {
				return true, page
			}
		}
		if batch.Data.NextCursor == nil {
			return false, page
		}
		cursor = *batch.Data.NextCursor
	}
	return false, clientDrainWalkPages
}

// ackEnvelopesAsOwner acknowledges through the real /v1/mailbox/ack route, signed by the mailbox
// owner - the only way an envelope legitimately leaves a mailbox before it expires.
func ackEnvelopesAsOwner(
	t *testing.T,
	handler *MailboxHandler,
	recipient *model.DeviceRecord,
	recipientDeviceKey ed25519.PrivateKey,
	mailboxID string,
	envelopeIDs []string,
) {
	t.Helper()

	response := postJSON(t, http.HandlerFunc(handler.AckMailbox), map[string]any{
		"recipient_mailbox_id": mailboxID,
		"device_id":            recipient.DeviceID,
		"envelope_ids":         envelopeIDs,
		"signature":            signMessage(t, cryptoutil.CreateMailboxAckMessage(mailboxID, recipient.DeviceID, envelopeIDs), recipientDeviceKey),
	})
	if response.Code != http.StatusOK {
		t.Fatalf("AckMailbox(%d envelopes) status = %d (code %q)", len(envelopeIDs), response.Code, mailboxErrorCode(t, response))
	}
}

// ---------------------------------------------------------------------------
// Property 1 - the quota itself
// ---------------------------------------------------------------------------

// TestSendEnvelopeEnforcesAPerSenderUnackedQuota is the quota, stated plainly. One published sender
// identity may hold senderUnackedQuota unacked envelopes in one recipient mailbox; the next one is
// refused with a bounded, non-retryable, distinguishable 4xx and is never stored.
func TestSendEnvelopeEnforcesAPerSenderUnackedQuota(t *testing.T) {
	handler, recipient, _, mailboxID := quotaHarness(t)
	sender := publishQuotaSender(t, handler, "single-sender")
	nowMS := time.Now().UnixMilli()

	for index := 0; index < senderUnackedQuota; index++ {
		response := sendFromQuotaSender(t, handler, sender, quotaEnvelope(mailboxID, recipient, quotaEnvelopeID(index), nowMS))
		if response.Code != http.StatusOK {
			t.Fatalf("SendEnvelope(envelope %d of the quota) status = %d (code %q), want %d: the quota must admit exactly %d unacked envelopes from one sender, or it truncates legitimate conversation",
				index+1, response.Code, mailboxErrorCode(t, response), http.StatusOK, senderUnackedQuota)
		}
	}

	beyondID := quotaEnvelopeID(senderUnackedQuota)
	beyond := sendFromQuotaSender(t, handler, sender, quotaEnvelope(mailboxID, recipient, beyondID, nowMS))
	assertQuotaRejection(t, fmt.Sprintf("envelope %d, one past the quota", senderUnackedQuota+1), beyond)

	stored := storedEnvelopeIDs(t, handler, mailboxID)
	if len(stored) != senderUnackedQuota {
		t.Fatalf("mailbox holds %d envelopes after one sender was refused at the quota, want exactly %d: a refused envelope must never be persisted, or the quota bounds nothing",
			len(stored), senderUnackedQuota)
	}
	for _, id := range stored {
		if id == beyondID {
			t.Fatalf("the refused envelope %s is in the mailbox: the quota must be enforced BEFORE storage", beyondID)
		}
	}
}

// TestSenderQuotaIsScopedToOneRecipientMailbox pins that the bound is per (recipient mailbox,
// sender), not global per sender. A global quota would hand any single hostile recipient the power
// to silence a sender's conversations with everyone else - trading one denial of service for a
// worse one.
func TestSenderQuotaIsScopedToOneRecipientMailbox(t *testing.T) {
	handler, bob, _, bobMailboxID := quotaHarness(t)

	carol, _ := signedDeviceRecord(t)
	if err := handler.deviceService.PublishDeviceRecord(carol); err != nil {
		t.Fatalf("PublishDeviceRecord(carol) error = %v", err)
	}
	carolMailboxID := cryptoutil.DeriveMailboxID(carol.IdentityID)

	sender := publishQuotaSender(t, handler, "two-recipients")
	nowMS := time.Now().UnixMilli()

	for index := 0; index < senderUnackedQuota; index++ {
		response := sendFromQuotaSender(t, handler, sender, quotaEnvelope(bobMailboxID, bob, quotaEnvelopeID(index), nowMS))
		if response.Code != http.StatusOK {
			t.Fatalf("SendEnvelope(bob, %d) status = %d (code %q), want %d", index+1, response.Code, mailboxErrorCode(t, response), http.StatusOK)
		}
	}
	assertQuotaRejection(t, "bob's mailbox, one past the quota",
		sendFromQuotaSender(t, handler, sender, quotaEnvelope(bobMailboxID, bob, quotaEnvelopeID(senderUnackedQuota), nowMS)))

	toCarol := sendFromQuotaSender(t, handler, sender, quotaEnvelope(carolMailboxID, carol, quotaEnvelopeID(0), nowMS))
	if toCarol.Code != http.StatusOK {
		t.Fatalf("SendEnvelope(carol) status = %d (code %q), want %d: the quota is per recipient mailbox. A sender at quota with one contact must still be able to write to every other contact, otherwise one hostile recipient silences the sender everywhere",
			toCarol.Code, mailboxErrorCode(t, toCarol), http.StatusOK)
	}
	if ids := storedEnvelopeIDs(t, handler, carolMailboxID); len(ids) != 1 {
		t.Fatalf("carol's mailbox holds %d envelopes, want 1", len(ids))
	}
}

// ---------------------------------------------------------------------------
// Property 2 - it frees again, so it is a quota and not a lockout
// ---------------------------------------------------------------------------

// TestAckingAnEnvelopeFreesSenderQuota is the difference between a quota and a permanent ban. Once
// the recipient acknowledges an envelope it no longer occupies the mailbox, so it must no longer
// occupy the sender's allowance either - otherwise a legitimate contact who once sent sixteen
// messages can never send again.
func TestAckingAnEnvelopeFreesSenderQuota(t *testing.T) {
	handler, recipient, recipientDeviceKey, mailboxID := quotaHarness(t)
	sender := publishQuotaSender(t, handler, "ack-frees")
	nowMS := time.Now().UnixMilli()

	for index := 0; index < senderUnackedQuota; index++ {
		if response := sendFromQuotaSender(t, handler, sender, quotaEnvelope(mailboxID, recipient, quotaEnvelopeID(index), nowMS)); response.Code != http.StatusOK {
			t.Fatalf("SendEnvelope(%d) status = %d (code %q), want %d", index+1, response.Code, mailboxErrorCode(t, response), http.StatusOK)
		}
	}
	assertQuotaRejection(t, "before any acknowledgement",
		sendFromQuotaSender(t, handler, sender, quotaEnvelope(mailboxID, recipient, quotaEnvelopeID(senderUnackedQuota), nowMS)))

	// The recipient reads and acknowledges two of them, exactly as a normal poll does.
	ackEnvelopesAsOwner(t, handler, recipient, recipientDeviceKey, mailboxID, []string{quotaEnvelopeID(0), quotaEnvelopeID(1)})

	for offset := 0; offset < 2; offset++ {
		id := quotaEnvelopeID(senderUnackedQuota + offset)
		response := sendFromQuotaSender(t, handler, sender, quotaEnvelope(mailboxID, recipient, id, nowMS))
		if response.Code != http.StatusOK {
			t.Fatalf("SendEnvelope(%s, after 2 acknowledgements) status = %d (code %q), want %d: an acknowledged envelope no longer occupies the mailbox, so it must not keep occupying the sender's quota. A quota that never frees is a permanent lockout of a legitimate contact",
				id, response.Code, mailboxErrorCode(t, response), http.StatusOK)
		}
	}

	// And the bound is standing, not a one-off: the sender is at quota again.
	assertQuotaRejection(t, "after the freed slots were reused",
		sendFromQuotaSender(t, handler, sender, quotaEnvelope(mailboxID, recipient, quotaEnvelopeID(senderUnackedQuota+2), nowMS)))

	if stored := storedEnvelopeIDs(t, handler, mailboxID); len(stored) != senderUnackedQuota {
		t.Fatalf("mailbox holds %d envelopes, want %d", len(stored), senderUnackedQuota)
	}
}

// TestExpiredEnvelopesDoNotConsumeSenderQuota is the other half of "it frees again", and the half a
// naive implementation gets wrong. An envelope can leave a mailbox without anyone acknowledging it:
// it simply passes its declared expiry, and the poll walk already skips it
// (storage/repository/mailbox_repo.go). A quota kept as a standalone counter incremented on send
// and decremented on ack would never learn about that, so a sender whose messages expired
// unacknowledged - precisely what happens when the recipient is offline - would be silenced
// permanently.
func TestExpiredEnvelopesDoNotConsumeSenderQuota(t *testing.T) {
	const lifetimeMS = 2000

	handler, recipient, _, mailboxID := quotaHarness(t)
	sender := publishQuotaSender(t, handler, "expiry-frees")
	nowMS := time.Now().UnixMilli()

	for index := 0; index < senderUnackedQuota; index++ {
		response := sendFromQuotaSender(t, handler, sender, quotaEnvelopeExpiringIn(mailboxID, recipient, quotaEnvelopeID(index), nowMS, lifetimeMS))
		if response.Code != http.StatusOK {
			t.Fatalf("SendEnvelope(short-lived %d) status = %d (code %q), want %d", index+1, response.Code, mailboxErrorCode(t, response), http.StatusOK)
		}
	}
	assertQuotaRejection(t, "while the short-lived envelopes are still live",
		sendFromQuotaSender(t, handler, sender, quotaEnvelopeExpiringIn(mailboxID, recipient, quotaEnvelopeID(senderUnackedQuota), nowMS, lifetimeMS)))

	// Wait for the declared lifetime to pass. The relay's physical retention deadline is expressed
	// in whole seconds (retentionDeadlineSeconds), so allow a second of slack beyond the declared
	// millisecond expiry before concluding anything.
	deadline := time.Now().Add(8 * time.Second)
	for {
		expired := len(storedEnvelopeIDs(t, handler, mailboxID)) == 0 &&
			time.Now().UnixMilli() > ((nowMS+lifetimeMS)/1000+1)*1000
		if expired {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("the %d short-lived envelopes had not left the mailbox within 8s of their declared expiry; the fixture, not the quota, is at fault", senderUnackedQuota)
		}
		time.Sleep(25 * time.Millisecond)
	}

	fresh := sendFromQuotaSender(t, handler, sender, quotaEnvelope(mailboxID, recipient, legitimateEnvelopeID, time.Now().UnixMilli()))
	if fresh.Code != http.StatusOK {
		t.Fatalf("SendEnvelope(after every earlier envelope expired) status = %d (code %q), want %d: an expired envelope occupies neither the mailbox nor the drain walk, so it must not occupy the sender's quota. Counting sends instead of live envelopes turns an offline recipient into a permanent block on a legitimate sender",
			fresh.Code, mailboxErrorCode(t, fresh), http.StatusOK)
	}
}

// ---------------------------------------------------------------------------
// Property 3 - legitimate use is unaffected: F-004's exact retry
// ---------------------------------------------------------------------------

// TestIdempotentReplayDoesNotConsumeSenderQuota pins F-004 against the quota. A send whose response
// was lost is retried with the byte-identical envelope, and because both the transcript and ed25519
// are deterministic the retry is byte-identical too - which is what keeps it an idempotent replay
// rather than an ENVELOPE_ID_CONFLICT.
//
// A quota that counted requests instead of distinct occupied slots would charge a sender for its
// own retries, so an ambiguous send at the boundary would burn the sender's allowance and, worse,
// would make the retry itself fail with a condition the sender cannot clear.
func TestIdempotentReplayDoesNotConsumeSenderQuota(t *testing.T) {
	handler, recipient, _, mailboxID := quotaHarness(t)
	sender := publishQuotaSender(t, handler, "idempotent-replay")
	nowMS := time.Now().UnixMilli()

	for index := 0; index < senderUnackedQuota-1; index++ {
		if response := sendFromQuotaSender(t, handler, sender, quotaEnvelope(mailboxID, recipient, quotaEnvelopeID(index), nowMS)); response.Code != http.StatusOK {
			t.Fatalf("SendEnvelope(%d) status = %d (code %q), want %d", index+1, response.Code, mailboxErrorCode(t, response), http.StatusOK)
		}
	}

	// The last envelope the quota admits, sent under an ambiguous response and then retried.
	lastID := quotaEnvelopeID(senderUnackedQuota - 1)
	last := quotaEnvelope(mailboxID, recipient, lastID, nowMS)
	last.SenderIdentityID = sender.identityID
	last.SenderDeviceID = sender.deviceID
	wire := envelopeWire(t, last)
	wire["sender_signature"] = signEnvelopeTranscript(last, sender.deviceKey)

	if first := sendEnvelopeWire(t, handler, wire); first.Code != http.StatusOK {
		t.Fatalf("SendEnvelope(the envelope that reaches the quota) status = %d (code %q), want %d", first.Code, mailboxErrorCode(t, first), http.StatusOK)
	}

	for attempt := 1; attempt <= 3; attempt++ {
		replay := sendEnvelopeWire(t, handler, wire)
		if replay.Code != http.StatusOK {
			t.Fatalf("SendEnvelope(byte-identical replay %d, sender exactly at quota) status = %d (code %q), want %d: F-004 requires an exact retry to stay an idempotent replay. The envelope already occupies its one slot, so replaying it must not be charged again - otherwise a lost response at the boundary locks the sender out of a mailbox it is legitimately using",
				attempt, replay.Code, mailboxErrorCode(t, replay), http.StatusOK)
		}
	}

	if stored := storedEnvelopeIDs(t, handler, mailboxID); len(stored) != senderUnackedQuota {
		t.Fatalf("mailbox holds %d envelopes after %d distinct sends and 3 exact replays, want %d: a replay must occupy no additional slot",
			len(stored), senderUnackedQuota, senderUnackedQuota)
	}

	// The quota is still in force, so the replays neither raised nor bypassed it.
	assertQuotaRejection(t, "a genuinely new envelope after three exact replays",
		sendFromQuotaSender(t, handler, sender, quotaEnvelope(mailboxID, recipient, quotaEnvelopeID(senderUnackedQuota), nowMS)))
}

// ---------------------------------------------------------------------------
// Property 4 - the measurable improvement
// ---------------------------------------------------------------------------

// TestASingleIdentityCannotWedgeTheBoundedDrainWalk is the point of T54, stated as the outcome the
// user cares about rather than as a counter.
//
// T52 measured, on the real binary: one self-published identity floods 49 maximum-size envelopes
// and the legitimate message behind them is never delivered, for up to 168 h. With a per-sender
// quota strictly below the walk's capacity, that single identity can no longer fill the walk, so
// the message behind its poison is still delivered.
//
// The walk is driven here at its real mechanics - real challenge, real poll route, real cursor
// resumption, clientDrainWalkPages pages, and NOTHING acknowledged, because permanently
// unacceptable poison is never acked (F-012).
func TestASingleIdentityCannotWedgeTheBoundedDrainWalk(t *testing.T) {
	// Precondition, so the test can never pass vacuously: one sender's whole allowance must be
	// smaller than the walk, both as simulated here and in the byte-bounded regime T52 measured.
	if senderUnackedQuota >= clientDrainWalkPages*quotaWalkPageSize {
		t.Fatalf("senderUnackedQuota (%d) is not below the simulated drain walk (%d pages x %d), so this test would prove nothing",
			senderUnackedQuota, clientDrainWalkPages, quotaWalkPageSize)
	}
	if senderUnackedQuota >= maxSizeDrainWalkEnvelopes {
		t.Fatalf("senderUnackedQuota (%d) is not below the %d maximum-size envelopes the recipient's 16-page walk covers, so one identity could still fill it exactly as T52 measured",
			senderUnackedQuota, maxSizeDrainWalkEnvelopes)
	}

	// One identity, minted the way T52 showed an attacker mints one: a fresh keypair plus a single
	// unauthenticated self-publish. Every envelope below is genuinely, verifiably signed.
	handler, recipient, recipientDeviceKey, mailboxID := quotaHarness(t)
	attacker := publishQuotaSender(t, handler, "single-identity-flood")
	legitimate := publishQuotaSender(t, handler, "legitimate-contact")
	nowMS := time.Now().UnixMilli()

	// More attempts than the whole walk can hold, so without the quota the walk is certainly wedged.
	floodAttempts := clientDrainWalkPages*quotaWalkPageSize + 4
	accepted := 0
	for index := 0; index < floodAttempts; index++ {
		if sendFromQuotaSender(t, handler, attacker, quotaEnvelope(mailboxID, recipient, quotaEnvelopeID(index), nowMS)).Code == http.StatusOK {
			accepted++
		}
	}

	// The legitimate message T52 watched expire undelivered. Its envelope_id sorts behind every
	// poison id, so it is the last thing in the mailbox.
	delivered := sendFromQuotaSender(t, handler, legitimate, quotaEnvelope(mailboxID, recipient, legitimateEnvelopeID, nowMS))
	if delivered.Code != http.StatusOK {
		t.Fatalf("SendEnvelope(legitimate contact, behind the flood) status = %d (code %q), want %d: a different sender's own quota is untouched by the attacker's",
			delivered.Code, mailboxErrorCode(t, delivered), http.StatusOK)
	}

	reached, pages := drainWalkReaches(t, handler, recipient, recipientDeviceKey, mailboxID, quotaWalkPageSize, legitimateEnvelopeID)
	if !reached {
		t.Fatalf("the legitimate message was NOT reached within the recipient's %d-page drain walk after one identity placed %d of %d attempted envelopes (walk stopped at page %d). "+
			"One identity must not be able to fill the walk: that is the whole measurable improvement the per-sender quota buys, and without it T52-F-001 stands unchanged",
			clientDrainWalkPages, accepted, floodAttempts, pages)
	}
}

// ---------------------------------------------------------------------------
// Property 5 - the honest residue, recorded rather than hidden
// ---------------------------------------------------------------------------

// quotaIdentitiesToWedge is how many distinct identities it takes to refill the simulated walk once
// each is bounded by senderUnackedQuota: ceil((walk capacity + 1) / quota). In the byte-bounded
// regime T52 measured the same arithmetic gives ceil(49/16) = 4 identities for a 48-envelope walk.
const quotaIdentitiesToWedge = (clientDrainWalkPages*quotaWalkPageSize)/senderUnackedQuota + 1

// TestKnownResidueDistinctIdentitiesStillWedgeTheDrainWalk records what the per-sender quota does
// NOT close, so that nobody has to rediscover it and the next verification has a threshold to
// measure from.
//
// A per-sender quota bounds one SENDER; it does not bound total mailbox occupancy. Identity
// creation is free - POST /v1/device-records/publish accepts a fresh self-signed record with no
// credential (T52-F-001) - so an attacker simply mints more identities. The quota raises the price
// from one identity to about (walk capacity / quota) identities. That is a linear improvement, not
// a structural fix.
//
// This test is GREEN both before and after T54: it asserts current behaviour on purpose. If a later
// change genuinely closes the class - binding occupancy to something an attacker cannot self-mint,
// or letting a recipient drain permanently-unacceptable envelopes without the 16-page cap - this
// test SHOULD start failing. Update it then; do not delete it, and do not weaken it to hide the
// residue in the meantime.
func TestKnownResidueDistinctIdentitiesStillWedgeTheDrainWalk(t *testing.T) {
	handler, recipient, recipientDeviceKey, mailboxID := quotaHarness(t)
	legitimate := publishQuotaSender(t, handler, "residue-legitimate-contact")
	nowMS := time.Now().UnixMilli()

	// Each identity fills its own allowance. Nothing here is unauthenticated: every envelope carries
	// a signature that verifies against a device record the relay itself accepted for free.
	accepted := 0
	for identity := 0; identity < quotaIdentitiesToWedge; identity++ {
		attacker := publishQuotaSender(t, handler, fmt.Sprintf("residue-identity-%d", identity))
		for index := 0; index < senderUnackedQuota; index++ {
			envelopeID := quotaEnvelopeID(identity*senderUnackedQuota + index)
			if sendFromQuotaSender(t, handler, attacker, quotaEnvelope(mailboxID, recipient, envelopeID, nowMS)).Code == http.StatusOK {
				accepted++
			}
		}
	}

	// The residue in one number: the quota bounds each sender, and nothing bounds the mailbox.
	if accepted != quotaIdentitiesToWedge*senderUnackedQuota {
		t.Fatalf("%d of %d envelopes from %d distinct published identities were accepted, want all %d. "+
			"This test records the KNOWN RESIDUE of the per-sender quota: it bounds one sender, not total mailbox occupancy. If a change made this fewer, the class may now be closed further than the quota alone closes it - re-measure and update this test rather than deleting it",
			accepted, quotaIdentitiesToWedge*senderUnackedQuota, quotaIdentitiesToWedge, quotaIdentitiesToWedge*senderUnackedQuota)
	}

	sent := sendFromQuotaSender(t, handler, legitimate, quotaEnvelope(mailboxID, recipient, legitimateEnvelopeID, nowMS))
	if sent.Code != http.StatusOK {
		t.Fatalf("SendEnvelope(legitimate contact) status = %d (code %q), want %d", sent.Code, mailboxErrorCode(t, sent), http.StatusOK)
	}

	reached, pages := drainWalkReaches(t, handler, recipient, recipientDeviceKey, mailboxID, quotaWalkPageSize, legitimateEnvelopeID)
	if reached {
		t.Fatalf("the legitimate message WAS reached at page %d despite %d identities x %d envelopes filling the %d-page walk. "+
			"That is better than the per-sender quota alone promises. Re-measure the new wedge threshold and update this residue test to the behaviour that now holds",
			pages, quotaIdentitiesToWedge, senderUnackedQuota, clientDrainWalkPages)
	}
}
