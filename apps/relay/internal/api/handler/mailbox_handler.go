package handler

import (
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"time"

	"echolet/apps/relay/internal/cryptoutil"
	"echolet/apps/relay/internal/model"
	"echolet/apps/relay/internal/protocol"
	"echolet/apps/relay/internal/service"
	"echolet/apps/relay/internal/storage/repository"
	"echolet/apps/relay/internal/validation"

	"github.com/dgraph-io/badger/v4"
)

type MailboxHandler struct {
	mailboxService   *service.MailboxService
	challengeService *service.ChallengeService
	deviceService    *service.DeviceRecordService
	maxMailboxBatch  int
	// maxMessageBytes is always POSITIVE: NewMailboxHandler resolves an
	// unconfigured (non-positive) maximum to the protocol maximum before it is
	// stored, so no reader of this field has to know about a fallback and no two
	// readers can disagree about one.
	maxMessageBytes    int64
	senderUnackedQuota int
	nowMS              func() int64
}

// NewMailboxHandler builds the handler.
//
// A non-positive maxMsgBytes means "unconfigured" and is resolved HERE, once, to
// the protocol maximum - so h.maxMessageBytes is always positive and every
// consumer of it agrees. That resolution used to live in envelopeBodyLimit()
// alone, while validation.ValidateMailboxEnvelope was handed the raw field, so a
// handler built at zero applied a 256 KB body limit and then refused every
// ciphertext inside it as PAYLOAD_TOO_LARGE: the relay came up healthy and
// accepted nothing (residual R-3, flow 003; measured as finding T21-F-001).
//
// The zero is resolved rather than refused because a zero-value config.Config is
// a supported way to build this relay - internal/server constructs one directly -
// and "unconfigured" has a correct answer: the protocol maximum both sides
// already derive every other bound from. An OPERATOR who sets
// ECHOLET_MAX_MESSAGE_BYTES=0 is a different case and is refused at startup by
// config.Load(), which is the only place that can tell an explicit zero from an
// unset variable.
func NewMailboxHandler(
	mailboxSvc *service.MailboxService,
	challengeSvc *service.ChallengeService,
	deviceSvc *service.DeviceRecordService,
	maxBatch int,
	maxMsgBytes int64,
) *MailboxHandler {
	if maxMsgBytes <= 0 {
		maxMsgBytes = defaultMaxMessageBytes
	}
	return &MailboxHandler{
		mailboxService:     mailboxSvc,
		challengeService:   challengeSvc,
		deviceService:      deviceSvc,
		maxMailboxBatch:    maxBatch,
		maxMessageBytes:    maxMsgBytes,
		senderUnackedQuota: defaultSenderUnackedQuota,
		nowMS:              func() int64 { return time.Now().UnixMilli() },
	}
}

// SetSenderUnackedQuota applies the server-configured per-sender quota. A
// non-positive value keeps the default, so an unconfigured Config cannot silently
// reduce a legitimate sender's allowance to zero - the same rule
// MailboxRepository.SetRetentionCap follows.
func (h *MailboxHandler) SetSenderUnackedQuota(quota int) {
	if quota <= 0 {
		return
	}
	h.senderUnackedQuota = quota
}

type SendEnvelopeRequest struct {
	Envelope *model.MailboxEnvelope `json:"envelope"`
}

// clientPollResponseBound is the response bound a conforming client enforces,
// derived from the SAME protocol maximum this relay validates
// ECHOLET_MAX_MESSAGE_BYTES against. It mirrors `responseByteBoundFor` in
// apps/cli/src/transport/relayClient.ts, which reads
// LIMITS.MAX_MESSAGE_BYTES - so the two are one derivation from one number,
// not two literals that happen to match today (residual RI-09). At the shared
// 262144 it is the 1 MiB that used to be written here by hand.
const clientPollResponseBound int64 = 4 * protocol.MaxMessageBytes

// pollEnvelopeByteBudget is the aggregate encoded-envelope budget for one poll
// response: the client's response bound minus the room the surrounding success
// envelope and next_cursor need, so a batch this relay selects is never one the
// client has to refuse. A deployment may configure a LOWER maximum, which only
// leaves this budget with more headroom; it may not configure a higher one,
// because that envelope would come back in a response the client refuses in
// full - config.Validate refuses to start rather than accept messages it could
// never hand back.
const pollEnvelopeByteBudget int64 = clientPollResponseBound - pollResponseWrapperBytes

// pollResponseWrapperBytes reserves room for {"ok":true,"data":{"envelopes":
// [...],"next_cursor":"..."}} around the selected envelopes.
const pollResponseWrapperBytes int64 = 4 << 10

// next_cursor is an opaque, server-issued continuation token: it means "more
// envelopes remain, poll again passing this back verbatim as `cursor`", and it
// carries a resume position so the following poll continues past the envelopes
// this one returned instead of re-selecting them from the head of the mailbox.
// Its value is produced by the repository from a count the server computed, so a
// sender can influence neither its size nor its content. The client must not
// interpret it.

// envelopeBodyLimit derives the /v1/messages/send request-body bound from the
// configured maximum ciphertext size, so raising ECHOLET_MAX_MESSAGE_BYTES can
// never leave the route silently rejecting legitimate maximum-size envelopes.
//
// It reads h.maxMessageBytes directly: NewMailboxHandler has already resolved an
// unconfigured maximum, so the "unconfigured, use the protocol maximum" fallback
// that used to sit here is now applied once, at construction, where the size
// validation below sees it too. One field, one meaning, both consumers.
func (h *MailboxHandler) envelopeBodyLimit() int64 {
	return h.maxMessageBytes + envelopeJSONOverheadBytes
}

func (h *MailboxHandler) SendEnvelope(w http.ResponseWriter, r *http.Request) {
	var req SendEnvelopeRequest
	if !decodeJSONRequest(w, r, h.envelopeBodyLimit(), &req) {
		return
	}

	if req.Envelope == nil {
		writeJSONError(w, http.StatusBadRequest, "INVALID_SCHEMA", "envelope is required")
		return
	}

	if err := validation.ValidateMailboxEnvelope(req.Envelope, h.maxMessageBytes); err != nil {
		if ve, ok := err.(*validation.ValidationError); ok {
			writeJSONError(w, http.StatusBadRequest, ve.Code, ve.Message)
		} else {
			writeJSONError(w, http.StatusBadRequest, "INVALID_SCHEMA", err.Error())
		}
		return
	}

	// An envelope that has already passed its declared lifetime is never
	// accepted: storing it would only occupy the recipient's next batch.
	if req.Envelope.ExpiresAtMs <= h.nowMS() {
		writeJSONError(w, http.StatusBadRequest, "INVALID_SCHEMA", "expires_at_ms is already in the past")
		return
	}

	// Sender authentication (T50, finding T49-F-001). It runs AFTER the shape,
	// bound and expiry checks so a malformed envelope keeps answering with the
	// rule it violated, and BEFORE the store so a sender the relay cannot
	// authenticate never occupies a byte of the victim's mailbox.
	//
	// Deliberately not part of validation.ValidateMailboxEnvelope: that function
	// is called directly by internal/validation tests with unsigned envelopes,
	// and it has no access to the device records this check resolves against.
	if !h.authenticateSender(w, req.Envelope) {
		return
	}

	// Per-sender unacked-envelope quota (T54, finding T52-F-001). It runs AFTER
	// authentication, so an unauthenticated caller can never consume a real
	// sender's allowance by claiming their identity id, and BEFORE the store, so a
	// refused envelope never occupies a byte of the victim's mailbox.
	if !h.enforceSenderQuota(w, req.Envelope) {
		return
	}

	if err := h.mailboxService.StoreEnvelope(req.Envelope); err != nil {
		if errors.Is(err, model.ErrEnvelopeIDConflict) {
			writeJSONError(
				w,
				http.StatusConflict,
				"ENVELOPE_ID_CONFLICT",
				"envelope_id is already used by a different envelope in this mailbox",
			)
			return
		}
		writeJSONError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "failed to store envelope")
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(map[string]interface{}{
		"ok": true,
		"data": map[string]interface{}{
			"accepted":    true,
			"envelope_id": req.Envelope.EnvelopeID,
			"status":      "relayed",
		},
	})
}

// maxSenderSignatureBytes bounds the sender-supplied binding before it can reach
// the store. A raw ed25519 signature is 64 bytes - 86 base64url characters - so
// 256 is far above every legitimate value and matches both
// validation.MaxIdentifierBytes and the client's own
// `z.string().min(1).max(256)` slot, which the victim's poll response is parsed
// under.
const maxSenderSignatureBytes = 256

// authenticateSender refuses an envelope whose sender the relay cannot resolve to
// an already-published, root-signed DeviceRecord and verify against.
//
// This is the fix for T49-F-001. /v1/messages/send had never authenticated
// anyone, so knowing a victim's recipient_mailbox_id - a digest of an identity id
// the victim publishes in its own contact card - was enough to wedge the mailbox
// for up to the 168 h retention cap with 49 maximum-size POSTs.
//
// The trust chain is the one authorizeMailboxDevice already resolves for
// challenge / poll / ack: the immutable (mailbox identity, device UUID) binding,
// applied here to the SENDER's mailbox identity rather than to the recipient's.
// It writes its own error response and reports whether the sender was
// authenticated.
func (h *MailboxHandler) authenticateSender(w http.ResponseWriter, envelope *model.MailboxEnvelope) bool {
	if envelope.SenderSignature == "" {
		writeJSONError(w, http.StatusBadRequest, "INVALID_SCHEMA", "sender_signature is required")
		return false
	}
	if len(envelope.SenderSignature) > maxSenderSignatureBytes {
		writeJSONError(w, http.StatusBadRequest, "INVALID_SCHEMA", "sender_signature exceeds the maximum signature length")
		return false
	}

	senderRecord, err := h.authorizeMailboxDevice(
		cryptoutil.DeriveMailboxID(envelope.SenderIdentityID),
		envelope.SenderDeviceID,
	)
	if err != nil {
		writeSenderAuthorizationError(w, err)
		return false
	}

	signatureValid, err := cryptoutil.VerifyMessageSignature(
		cryptoutil.CreateMailboxEnvelopeMessage(
			envelope.RecipientMailboxID,
			envelope.EnvelopeID,
			envelope.SenderIdentityID,
			envelope.SenderDeviceID,
			cryptoutil.HashMailboxEnvelopeCiphertext(envelope.Ciphertext),
			envelope.CreatedAtMs,
			envelope.ExpiresAtMs,
		),
		envelope.SenderSignature,
		senderRecord.DevicePubKey,
	)
	if err != nil || !signatureValid {
		writeJSONError(w, http.StatusForbidden, "INVALID_SIGNATURE", "sender signature verification failed")
		return false
	}

	return true
}

// writeSenderAuthorizationError answers an unresolvable sender under the same
// wire code the mailbox routes already use for "no such (identity, device)
// binding", so one name keeps meaning one thing on both sides of the wire. The
// message names the actual precondition - the sender's device record has to be
// published first - and echoes no caller-supplied value.
func writeSenderAuthorizationError(w http.ResponseWriter, err error) {
	if errors.Is(err, badger.ErrKeyNotFound) || errors.Is(err, errMailboxOwnershipMismatch) {
		writeJSONError(
			w,
			http.StatusForbidden,
			"UNAUTHORIZED_MAILBOX_ACCESS",
			"sender device record is not published; publish it before sending",
		)
		return
	}

	writeJSONError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "failed to authorize sender")
}

// defaultSenderUnackedQuota is the maximum number of UNACKED envelopes one
// sender identity may hold in one recipient mailbox, used when the server is not
// configured otherwise (ECHOLET_MAX_UNACKED_ENVELOPES_PER_SENDER).
//
// Why sixteen, stated so it can be argued with:
//
//   - Legitimate use never reaches it. A two-party conversation acknowledges on
//     every poll, so the standing unacked count from any one sender is normally
//     0-2. One `send` is one envelope, so 16 means sixteen consecutive messages to
//     a peer who has not polled even once.
//   - It is strictly below what one identity needs to fill the recipient's
//     bounded drain walk in the worst regime T52 measured on the real binary: the
//     ~1 MiB poll response budget admits 3 maximum-size envelopes per page and the
//     client walks 16 pages (apps/cli/src/runtime/inbound.ts), so the walk covers
//     48 envelopes. 16 < 48, so one identity can no longer fill it and 32 slots
//     stay free for the message queued behind the poison.
//   - It is far below ECHOLET_MAX_MAILBOX_BATCH (100), so one poll page can still
//     carry more than a single sender's entire allowance.
//
// What it does NOT do, stated here rather than left to be rediscovered: it bounds
// one SENDER, not total mailbox occupancy, and POST /v1/device-records/publish is
// unauthenticated, so an attacker mints another identity for the cost of one
// request. The quota raises the price of the T52-F-001 wedge from 1 identity to
// about ceil(48/16) = 3 in the byte-bounded regime and ceil(800/16) = 50 in the
// count-bounded one. That is a linear price increase, not a structural fix; the
// residue is pinned by TestKnownResidueDistinctIdentitiesStillWedgeTheDrainWalk.
const defaultSenderUnackedQuota = 16

// enforceSenderQuota refuses an envelope that would push the sender past its
// unacked allowance in this recipient's mailbox. It writes its own error response
// and reports whether the envelope may proceed to the store.
//
// Two properties the tests depend on:
//
//   - It counts LIVE envelopes by scanning the mailbox, never a counter
//     incremented on send and decremented on ack. An envelope also leaves a
//     mailbox by expiring with nobody acknowledging it - the normal outcome when
//     the recipient is offline - and a counter would keep charging a sender for
//     envelopes that occupy nothing, silencing a legitimate contact permanently.
//   - It exempts an envelope_id already stored in this mailbox. Storing under an
//     existing pair is either an idempotent replay or an ENVELOPE_ID_CONFLICT, so
//     it cannot increase occupancy; charging it would make F-004's exact retry
//     fail with a condition the sender cannot clear, at exactly the boundary where
//     a lost response makes that retry necessary.
//
// The status is 403 and not 429, following UNAUTHORIZED_MAILBOX_ACCESS (403) and
// PREKEY_BUNDLE_UNAVAILABLE (404): apps/cli/src/transport/relayClient.ts
// classifies 429 as retryable and cli.ts classify() maps every retryable error to
// RELAY_UNAVAILABLE (exit 4) WITHOUT reading remoteCode, so a 429 would discard
// the diagnosis and put a legitimate sender into a retry loop against a condition
// only the recipient (by acknowledging) or time (by expiry) can clear.
func (h *MailboxHandler) enforceSenderQuota(w http.ResponseWriter, envelope *model.MailboxEnvelope) bool {
	quota := h.senderUnackedQuota
	if quota <= 0 {
		quota = defaultSenderUnackedQuota
	}

	occupancy, err := h.mailboxService.SenderOccupancy(
		envelope.RecipientMailboxID,
		envelope.SenderIdentityID,
		envelope.EnvelopeID,
		quota,
	)
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "failed to evaluate the sender quota")
		return false
	}

	if occupancy.EnvelopeAlreadyStored {
		return true
	}
	if occupancy.LiveEnvelopes >= quota {
		writeJSONError(
			w,
			http.StatusForbidden,
			"SENDER_QUOTA_EXCEEDED",
			"sender has too many unacknowledged envelopes in this mailbox; they clear as the recipient acknowledges them or they expire",
		)
		return false
	}

	return true
}

type ChallengeRequest struct {
	RecipientMailboxID string `json:"recipient_mailbox_id"`
	DeviceID           string `json:"device_id"`
	Signature          string `json:"signature"`
}

type ChallengeResponse struct {
	ChallengeID string `json:"challenge_id"`
	Nonce       string `json:"nonce"`
	ExpiresAtMs int64  `json:"expires_at_ms"`
}

func (h *MailboxHandler) CreateChallenge(w http.ResponseWriter, r *http.Request) {
	var req ChallengeRequest
	if !decodeJSONRequest(w, r, compactRequestBodyLimit, &req) {
		return
	}

	if req.RecipientMailboxID == "" || req.DeviceID == "" || req.Signature == "" {
		writeJSONError(w, http.StatusBadRequest, "INVALID_SCHEMA", "recipient_mailbox_id, device_id and signature are required")
		return
	}

	deviceRecord, err := h.authorizeMailboxDevice(req.RecipientMailboxID, req.DeviceID)
	if err != nil {
		writeMailboxAuthorizationError(w, err)
		return
	}

	signatureValid, err := cryptoutil.VerifyMessageSignature(
		cryptoutil.CreateMailboxCreateChallengeMessage(req.RecipientMailboxID, req.DeviceID),
		req.Signature,
		deviceRecord.DevicePubKey,
	)
	if err != nil || !signatureValid {
		writeJSONError(w, http.StatusForbidden, "INVALID_SIGNATURE", "signature verification failed")
		return
	}

	challenge, err := h.challengeService.CreateChallenge(req.RecipientMailboxID, req.DeviceID)
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "failed to create challenge")
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(map[string]interface{}{
		"ok": true,
		"data": ChallengeResponse{
			ChallengeID: challenge.ChallengeID,
			Nonce:       challenge.Nonce,
			ExpiresAtMs: challenge.ExpiresAtMs,
		},
	})
}

type PollRequest struct {
	ChallengeID        string `json:"challenge_id"`
	RecipientMailboxID string `json:"recipient_mailbox_id"`
	DeviceID           string `json:"device_id"`
	Signature          string `json:"signature"`
	// BatchSize is the client's requested upper bound on the number of
	// envelopes in this response. It is a preference, not an authority: the
	// server cap and the response-byte budget still apply. Omitted or zero
	// means "use the server default".
	BatchSize int `json:"batch_size"`
	// Cursor is the continuation token a previous poll returned as next_cursor,
	// echoed back verbatim. A token this relay could not have issued is a client
	// error. Omitted or empty means "resume at this device's stored read
	// position" - which is the head of the mailbox until the device has judged
	// anything, and which is what makes recipient progress durable across polls,
	// rate limits, timeouts and process exit (design C4-2).
	Cursor string `json:"cursor"`
	// ReadThrough is the highest position this device has JUDGED - committed or
	// permanently refused - reported on the next page's request. A pointer so
	// "absent" and "present" are distinguishable: the two cases sign different
	// transcripts, and only the present case may move the stored mark.
	ReadThrough *string `json:"read_through"`
}

// decodeReadThroughShape applies the shape rule every opaque position this relay
// issues shares (repository.DecodeMailboxCursor), and NOTHING that depends on the
// mailbox.
//
// Its refusals are 400 INVALID_SCHEMA and stay BEFORE the challenge, the device
// binding and the signature, like the envelope_ids bounds above: malformed client
// input must never answer 500 and must never depend on who is asking. Silently
// coercing an uninterpretable token is not an option - decodeMailboxCursor's own
// comment says why, and with a durable mark a discarded token is an invisible
// SKIP rather than merely an invisible replay.
//
// It writes its own error response and reports whether the request may proceed.
func (h *MailboxHandler) decodeReadThroughShape(w http.ResponseWriter, readThrough *string) (uint64, bool) {
	if readThrough == nil {
		return 0, true
	}
	if *readThrough == "" {
		writeJSONError(w, http.StatusBadRequest, "INVALID_SCHEMA", "read_through is present but empty")
		return 0, false
	}

	position, err := repository.DecodeMailboxCursor(*readThrough)
	if err != nil {
		writeJSONError(w, http.StatusBadRequest, "INVALID_SCHEMA", "read_through is not a position issued by this relay")
		return 0, false
	}

	return position, true
}

// readThroughWithinIssued applies the bound that makes a well-formed position
// meaningful: a position above the highest this mailbox ever allocated is not a
// position this relay could have issued, and accepting it would advance the
// recipient's mark past envelopes it was never offered (design §4, R-4).
//
// Unlike the shape rule it CONSULTS THE MAILBOX, so it must never be answered to
// a caller who has not proved they may ask about that mailbox. Finding T10-F-002:
// while this ran before authentication, the pair of refusals it produces - 400
// INVALID_SCHEMA above the bound against whatever the request's own defects
// deserve below it - was a comparator on the number of envelopes the mailbox had
// ever been issued, and about twenty requests carrying a fabricated challenge_id,
// a fabricated device_id and a signature that was not one recovered that number
// exactly. mailbox_id is sha256(identity_id + ":mailbox:v1") and identity_id is
// printed on every contact card, so anyone who had ever seen the victim's card
// could compute the target. That is the victim's lifetime received-envelope
// count, not traffic the asking party observed, and SEC-01 §6.2 confines what the
// relay exposes to third parties.
//
// Callers therefore apply it only after the caller is ESTABLISHED, which on both
// routes means after VerifyMessageSignature. The ack route used to apply it one
// step earlier, after the device binding resolved but before the signature was
// checked, and that step was enough to keep the oracle open for anyone holding
// the victim's contact card: the card carries the identity_id the mailbox id is
// derived from AND the device_id, so "name a device this mailbox knows" excludes
// nobody (finding T10R3-F-002).
func (h *MailboxHandler) readThroughWithinIssued(w http.ResponseWriter, mailboxID string, readThrough *string, position uint64) bool {
	if readThrough == nil {
		return true
	}

	highest, err := h.mailboxService.HighestIssuedPosition(mailboxID)
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "failed to evaluate the read position")
		return false
	}
	if position > highest {
		writeJSONError(w, http.StatusBadRequest, "INVALID_SCHEMA", "read_through is above every position issued for this mailbox")
		return false
	}

	return true
}

func (h *MailboxHandler) PollMailbox(w http.ResponseWriter, r *http.Request) {
	var req PollRequest
	if !decodeJSONRequest(w, r, compactRequestBodyLimit, &req) {
		return
	}

	if req.ChallengeID == "" || req.RecipientMailboxID == "" || req.DeviceID == "" || req.Signature == "" {
		writeJSONError(w, http.StatusBadRequest, "INVALID_SCHEMA", "challenge_id, recipient_mailbox_id, device_id and signature are required")
		return
	}
	if req.BatchSize < 0 {
		writeJSONError(w, http.StatusBadRequest, "INVALID_SCHEMA", "batch_size must be a positive integer")
		return
	}

	// Shape only. The bound that consults the mailbox is applied further down,
	// after the device signature verifies (finding T10-F-002).
	readThrough, ok := h.decodeReadThroughShape(w, req.ReadThrough)
	if !ok {
		return
	}

	challenge, err := h.challengeService.GetValid(req.ChallengeID)
	if err != nil {
		writeJSONError(w, http.StatusBadRequest, "CHALLENGE_EXPIRED", "invalid or expired challenge")
		return
	}
	if challenge.RecipientMailboxID != req.RecipientMailboxID || challenge.DeviceID != req.DeviceID {
		writeJSONError(w, http.StatusForbidden, "UNAUTHORIZED_MAILBOX_ACCESS", "challenge does not match mailbox/device")
		return
	}

	deviceRecord, err := h.authorizeMailboxDevice(req.RecipientMailboxID, req.DeviceID)
	if err != nil {
		writeMailboxAuthorizationError(w, err)
		return
	}

	// The transcript depends on whether a read position is carried, so a poll
	// that reports one cannot be reshaped into a poll that reports a different
	// one, or none, under the same signature.
	pollTranscript := cryptoutil.CreateMailboxChallengeMessage(
		req.ChallengeID,
		req.RecipientMailboxID,
		req.DeviceID,
		challenge.Nonce,
	)
	if req.ReadThrough != nil {
		pollTranscript = cryptoutil.CreateMailboxChallengeMessageV2(
			req.ChallengeID,
			req.RecipientMailboxID,
			req.DeviceID,
			challenge.Nonce,
			*req.ReadThrough,
		)
	}

	signatureValid, err := cryptoutil.VerifyMessageSignature(
		pollTranscript,
		req.Signature,
		deviceRecord.DevicePubKey,
	)
	if err != nil || !signatureValid {
		writeJSONError(w, http.StatusForbidden, "INVALID_SIGNATURE", "signature verification failed")
		return
	}

	// Now, and not before: the caller has proved they hold the device key this
	// mailbox is bound to, so an answer that depends on the mailbox's contents is
	// an answer to its owner (finding T10-F-002).
	if !h.readThroughWithinIssued(w, req.RecipientMailboxID, req.ReadThrough, readThrough) {
		return
	}

	if err := h.challengeService.Invalidate(req.ChallengeID); err != nil {
		if errors.Is(err, service.ErrInvalidChallenge) {
			writeJSONError(w, http.StatusBadRequest, "CHALLENGE_EXPIRED", "invalid or expired challenge")
			return
		}
		writeJSONError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "failed to invalidate challenge")
		return
	}

	// The read position is recorded before selection, under the signature that
	// just verified, so a walk that is killed, rate-limited or timed out after
	// this point has still made durable progress. This is the whole of C4-2: the
	// judgement a page produced survives the process that produced it.
	if req.ReadThrough != nil {
		if err := h.mailboxService.AdvanceReadMark(req.RecipientMailboxID, req.DeviceID, readThrough); err != nil {
			writeJSONError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "failed to record the read position")
			return
		}
	}

	// A poll WITHOUT a cursor resumes at this device's stored read position
	// rather than at the head of the mailbox. A poll WITH one resumes strictly
	// after that token, so a full re-walk (cursor "0") is always available - which
	// is how `contact import` recovers an envelope the walk already passed,
	// without the relay ever rewinding a mark.
	cursor := req.Cursor
	if cursor == "" {
		mark, err := h.mailboxService.ReadMark(req.RecipientMailboxID, req.DeviceID)
		if err != nil {
			writeJSONError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "failed to read the stored read position")
			return
		}
		if mark > 0 {
			cursor = strconv.FormatUint(mark, 10)
		}
	}

	batch, err := h.mailboxService.GetEnvelopeBatchFrom(
		challenge.RecipientMailboxID,
		h.pollBatchSize(req.BatchSize),
		pollEnvelopeByteBudget,
		cursor,
	)
	if err != nil {
		if errors.Is(err, model.ErrInvalidMailboxCursor) {
			writeJSONError(w, http.StatusBadRequest, "INVALID_SCHEMA", "cursor is not a continuation token issued by this relay")
			return
		}
		writeJSONError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "failed to get envelopes")
		return
	}

	// next_cursor is the remaining-work signal AND the resume position: non-null
	// means the response was cut short by the batch or byte bound and the client
	// must poll again passing it back as `cursor`.
	var nextCursor *string
	if batch.NextCursor != "" {
		cursor := batch.NextCursor
		nextCursor = &cursor
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(map[string]interface{}{
		"ok": true,
		"data": map[string]interface{}{
			"envelopes":   batch.Envelopes,
			"next_cursor": nextCursor,
		},
	})
}

// pollBatchSize resolves the effective envelope count bound for one poll: the
// client's requested batch size when it asked for one, always clamped to the
// server's configured maximum.
func (h *MailboxHandler) pollBatchSize(requested int) int {
	limit := h.maxMailboxBatch
	if limit <= 0 {
		limit = defaultMaxMailboxBatch
	}
	if requested > 0 && requested < limit {
		return requested
	}
	return limit
}

type AckRequest struct {
	RecipientMailboxID string   `json:"recipient_mailbox_id"`
	DeviceID           string   `json:"device_id"`
	EnvelopeIDs        []string `json:"envelope_ids"`
	Signature          string   `json:"signature"`
	// ReadThrough is the recipient's durable read position, optionally carried
	// here as well as on the poll. The CLI reports it on the poll instead (finding
	// T6-F-001: an ack sent only to report a position is an ack REQUEST, and the
	// F-012 accept-nothing path makes none), but the route accepts it so an
	// acknowledgement and a read position can be one signed statement.
	ReadThrough *string `json:"read_through"`
}

func (h *MailboxHandler) AckMailbox(w http.ResponseWriter, r *http.Request) {
	var req AckRequest
	if !decodeJSONRequest(w, r, compactRequestBodyLimit, &req) {
		return
	}

	if req.RecipientMailboxID == "" || req.DeviceID == "" || req.Signature == "" {
		writeJSONError(w, http.StatusBadRequest, "INVALID_SCHEMA", "recipient_mailbox_id, device_id and signature are required")
		return
	}

	if len(req.EnvelopeIDs) > h.maxAckedEnvelopeIDs() {
		writeJSONError(w, http.StatusBadRequest, "INVALID_SCHEMA", "envelope_ids exceeds the maximum mailbox batch")
		return
	}

	// The element COUNT was bounded above; the element LENGTH was not, and every
	// element becomes the second half of the Badger key DeleteEnvelope removes
	// (storage/repository/mailbox_repo.go). Badger refuses a key beyond its own
	// ceiling, so without this bound a caller-supplied element answers HTTP 500 -
	// an internal error for malformed client input (round-2 finding R2-002). The
	// offending value is never echoed.
	for _, envelopeID := range req.EnvelopeIDs {
		if len(envelopeID) > validation.MaxIdentifierBytes {
			writeJSONError(w, http.StatusBadRequest, "INVALID_SCHEMA", "an envelope_ids entry exceeds the maximum identifier length")
			return
		}
	}

	// Shape only, and deliberately still ahead of authorisation: like the
	// envelope_ids bounds above, a token this relay could not have issued is
	// malformed client input, so it must answer the same bounded 400 INVALID_SCHEMA
	// whoever is asking and must never reach a code path that could answer 500. The
	// bound that CONSULTS THE MAILBOX is a different rule and is applied further
	// down, after the device signature verifies (finding T10R3-F-002).
	readThrough, ok := h.decodeReadThroughShape(w, req.ReadThrough)
	if !ok {
		return
	}

	deviceRecord, err := h.authorizeMailboxDevice(req.RecipientMailboxID, req.DeviceID)
	if err != nil {
		writeMailboxAuthorizationError(w, err)
		return
	}

	// As on the poll route: an ack that reports a read position signs a different
	// transcript from one that does not, so the position cannot be added to,
	// removed from or altered in a request the recipient signed.
	ackTranscript := cryptoutil.CreateMailboxAckMessage(req.RecipientMailboxID, req.DeviceID, req.EnvelopeIDs)
	if req.ReadThrough != nil {
		ackTranscript = cryptoutil.CreateMailboxAckMessageV2(req.RecipientMailboxID, req.DeviceID, req.EnvelopeIDs, *req.ReadThrough)
	}

	signatureValid, err := cryptoutil.VerifyMessageSignature(
		ackTranscript,
		req.Signature,
		deviceRecord.DevicePubKey,
	)
	if err != nil || !signatureValid {
		writeJSONError(w, http.StatusForbidden, "INVALID_SIGNATURE", "signature verification failed")
		return
	}

	// Now, and not before - the same split the poll route already makes (finding
	// T10-F-002), completed here for the ack route (finding T10R3-F-002). While
	// this ran ahead of the signature check, the relay answered two DIFFERENT
	// things to a caller who could not produce a verifying signature: 400
	// INVALID_SCHEMA for a position above the highest this mailbox was ever issued
	// and 403 INVALID_SIGNATURE for one at or below it. That pair is a comparator
	// on the victim's lifetime received-envelope count, and a binary search over it
	// recovers the number in about thirteen requests. Naming a real device is no
	// barrier: mailbox_id is sha256(identity_id + ":mailbox:v1") and identity_id and
	// device_id are printed on the same contact card, so the caller who can compute
	// the mailbox id can read the device id off the card. Behind the signature the
	// caller is established, so an answer that depends on the mailbox's contents is
	// an answer to its owner. The R-4 bound itself is unchanged and still refuses an
	// out-of-range position with 400 INVALID_SCHEMA - to the legitimate recipient,
	// which is who it was always for (TestAckRefusesAReadThroughAboveAnyPositionThe
	// RelayIssued, which signs the V2 transcript the handler builds above).
	if !h.readThroughWithinIssued(w, req.RecipientMailboxID, req.ReadThrough, readThrough) {
		return
	}

	if err := h.mailboxService.AckEnvelopes(req.RecipientMailboxID, req.EnvelopeIDs); err != nil {
		writeJSONError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "failed to ack envelopes")
		return
	}

	if req.ReadThrough != nil {
		if err := h.mailboxService.AdvanceReadMark(req.RecipientMailboxID, req.DeviceID, readThrough); err != nil {
			writeJSONError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "failed to record the read position")
			return
		}
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(map[string]interface{}{
		"ok": true,
		"data": map[string]interface{}{
			"acked": len(req.EnvelopeIDs),
		},
	})
}

// errMailboxOwnershipMismatch marks an authorization failure that must never be
// distinguished from "no such binding" on the wire.
var errMailboxOwnershipMismatch = errors.New("mailbox ownership mismatch")

// authorizeMailboxDevice resolves the device through the immutable
// (mailbox identity, device UUID) binding. A device UUID published under an
// unrelated identity lives under that identity's own mailbox key and is
// therefore invisible here, so it cannot deny the legitimate owner.
func (h *MailboxHandler) authorizeMailboxDevice(recipientMailboxID, deviceID string) (*model.DeviceRecord, error) {
	record, err := h.deviceService.GetByMailboxAndDevice(recipientMailboxID, deviceID)
	if err != nil {
		return nil, err
	}
	if record == nil {
		return nil, badger.ErrKeyNotFound
	}

	// Defence in depth: the binding is derived from the record's own identity,
	// so this can only fail if the two key spaces have diverged.
	if cryptoutil.DeriveMailboxID(record.IdentityID) != recipientMailboxID {
		return nil, errMailboxOwnershipMismatch
	}

	return record, nil
}

func (h *MailboxHandler) maxAckedEnvelopeIDs() int {
	if h.maxMailboxBatch > 0 {
		return h.maxMailboxBatch
	}
	return maxAckEnvelopeIDs
}

func writeMailboxAuthorizationError(w http.ResponseWriter, err error) {
	if errors.Is(err, badger.ErrKeyNotFound) || errors.Is(err, errMailboxOwnershipMismatch) {
		writeJSONError(w, http.StatusForbidden, "UNAUTHORIZED_MAILBOX_ACCESS", "device is not authorized for mailbox access")
		return
	}

	writeJSONError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "failed to authorize mailbox access")
}
