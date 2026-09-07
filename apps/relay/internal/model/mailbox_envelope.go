package model

import "errors"

// ErrEnvelopeIDConflict is returned when a (recipient mailbox, envelope_id) pair
// is reused with a different envelope body. The error string is the wire error
// code the CLI already expects at HTTP 409.
var ErrEnvelopeIDConflict = errors.New("ENVELOPE_ID_CONFLICT")

// ErrInvalidMailboxCursor is returned when a poll carries a continuation token
// this relay could not have issued. It is a client error, not an internal one:
// the route answers 400 INVALID_SCHEMA rather than 500.
var ErrInvalidMailboxCursor = errors.New("INVALID_MAILBOX_CURSOR")

type MailboxEnvelope struct {
	Type                string `json:"type"`
	Version             int    `json:"version"`
	EnvelopeID          string `json:"envelope_id"`
	MessageID           string `json:"message_id"`
	SenderIdentityID    string `json:"sender_identity_id"`
	SenderDeviceID      string `json:"sender_device_id"`
	RecipientIdentityID string `json:"recipient_identity_id"`
	RecipientDeviceID   string `json:"recipient_device_id"`
	RecipientMailboxID  string `json:"recipient_mailbox_id"`
	PayloadType         string `json:"payload_type"`
	Ciphertext          string `json:"ciphertext"`
	CreatedAtMs         int64  `json:"created_at_ms"`
	ExpiresAtMs         int64  `json:"expires_at_ms"`
	SizeBytes           int64  `json:"size_bytes"`
	// SenderSignature is the sender's base64url raw ed25519 signature over
	// cryptoutil.CreateMailboxEnvelopeMessage, verified at /v1/messages/send
	// against the sender's already-published, root-signed DeviceRecord
	// (T50, finding T49-F-001).
	//
	// `omitempty` is load-bearing: the CLI parses a whole poll response as
	// z.array(MailboxEnvelopeSchema.strict()) where the field is a bounded
	// NON-EMPTY string, so a record stored before sender authentication existed
	// must be served without the key rather than with "". One such record served
	// as "" fails the batch parse and wedges the mailbox.
	SenderSignature string `json:"sender_signature,omitempty"`
}
