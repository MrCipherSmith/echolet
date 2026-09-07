package validation

import (
	"regexp"

	"echolet/apps/relay/internal/cryptoutil"
	"echolet/apps/relay/internal/model"
)

func ValidateDeviceRecord(record *model.DeviceRecord) error {
	if record.Type != "device_record" {
		return &ValidationError{Code: "INVALID_SCHEMA", Message: "type must be device_record"}
	}
	if record.Version != 1 {
		return &ValidationError{Code: "INVALID_SCHEMA", Message: "version must be 1"}
	}
	if record.IdentityID == "" {
		return &ValidationError{Code: "INVALID_SCHEMA", Message: "identity_id is required"}
	}
	if record.DeviceID == "" {
		return &ValidationError{Code: "INVALID_SCHEMA", Message: "device_id is required"}
	}
	// /v1/device-records/publish is unauthenticated in the sense that matters
	// here: the record only has to verify against its own freshly generated
	// identity key, so both halves of the Badger key
	// "device:<identity_id>:<device_id>" are caller-chosen. Without this bound an
	// oversized value is refused by the store instead of by validation and
	// surfaces as HTTP 500 - an internal error is the wrong answer to malformed
	// client input. Only the field name is returned; the value is never echoed.
	for _, identifier := range []identifierField{
		{"identity_id", record.IdentityID},
		{"device_id", record.DeviceID},
	} {
		if len(identifier.Value) > MaxIdentifierBytes {
			return &ValidationError{Code: "INVALID_SCHEMA", Message: identifier.Name + " exceeds the maximum identifier length"}
		}
	}
	if record.DevicePubKey == "" {
		return &ValidationError{Code: "INVALID_SCHEMA", Message: "device_pubkey is required"}
	}
	if record.Signature == "" {
		return &ValidationError{Code: "INVALID_SIGNATURE", Message: "signature is required"}
	}
	ok, err := cryptoutil.VerifyCanonicalJSONSignature(record, record.Signature, record.IdentityID)
	if err != nil || !ok {
		return &ValidationError{Code: "INVALID_SIGNATURE", Message: "signature verification failed"}
	}
	return nil
}

func ValidatePreKeyBundle(bundle *model.PreKeyBundle) error {
	if bundle.Type != "prekey_bundle" {
		return &ValidationError{Code: "INVALID_SCHEMA", Message: "type must be prekey_bundle"}
	}
	if bundle.Version != 1 {
		return &ValidationError{Code: "INVALID_SCHEMA", Message: "version must be 1"}
	}
	if bundle.IdentityID == "" {
		return &ValidationError{Code: "INVALID_SCHEMA", Message: "identity_id is required"}
	}
	if bundle.DeviceID == "" {
		return &ValidationError{Code: "INVALID_SCHEMA", Message: "device_id is required"}
	}
	if bundle.Signature == "" {
		return &ValidationError{Code: "INVALID_SIGNATURE", Message: "signature is required"}
	}
	if len(bundle.OneTimePreKeys) == 0 {
		return &ValidationError{Code: "INVALID_SCHEMA", Message: "one_time_prekeys must not be empty"}
	}
	if bundle.SignedPreKey.ExpiresAtMs <= bundle.SignedPreKey.CreatedAtMs {
		return &ValidationError{Code: "INVALID_SCHEMA", Message: "signed_prekey.expires_at_ms must be after created_at_ms"}
	}

	bundleSignatureValid, err := cryptoutil.VerifyCanonicalJSONSignature(bundle, bundle.Signature, bundle.IdentityID)
	if err != nil || !bundleSignatureValid {
		return &ValidationError{Code: "INVALID_SIGNATURE", Message: "bundle signature verification failed"}
	}

	signedPreKeyValid, err := cryptoutil.VerifyCanonicalJSONSignature(bundle.SignedPreKey, bundle.SignedPreKey.Signature, bundle.DevicePubKey)
	if err != nil || !signedPreKeyValid {
		identitySignatureValid, identityErr := cryptoutil.VerifyCanonicalJSONSignature(bundle.SignedPreKey, bundle.SignedPreKey.Signature, bundle.IdentityID)
		if identityErr != nil || !identitySignatureValid {
			return &ValidationError{Code: "INVALID_SIGNATURE", Message: "signed_prekey signature verification failed"}
		}
	}
	return nil
}

// MaxIdentifierBytes bounds every caller-supplied identifier string that ends up
// inside a Badger key.
//
// A mailbox envelope's fields are caller-supplied. Since T51 /v1/messages/send
// authenticates the sender against an already-published, root-signed
// DeviceRecord, but that binding is verified in the handler and costs an
// attacker only one unauthenticated /v1/device-records/publish (finding
// T52-F-001), so these identifiers must still be treated as attacker-controlled
// here; recipient_mailbox_id and envelope_id are the
// two halves of the key "mailbox:<recipient_mailbox_id>:<envelope_id>"
// (storage/repository/mailbox_repo.go), and Badger refuses a key beyond its own
// maximum. Without a bound here an oversized identifier is refused by the store
// instead of by validation and surfaces as HTTP 500 - an internal error is the
// wrong answer to malformed client input. The same reasoning applies to
// ValidateDeviceRecord's two identifiers and to the /v1/mailbox/ack envelope id
// elements bounded in api/handler, which is why the constant is exported and
// shared rather than repeated per route.
//
// 256 bytes is far above every legitimate value: identity ids and mailbox ids
// are 43-character base64url digests, and envelope/message/device ids are
// 36-character UUIDs.
const MaxIdentifierBytes = 256

// identifierField pairs an identifier's field name with its value. Only the name
// is ever returned in an error; the value is caller-supplied and never echoed.
type identifierField struct {
	Name  string
	Value string
}

// clientMailboxUUID is the shape the CLI's own wire schema requires of an
// envelope's four UUID fields, transcribed from `z.string().uuid()` as zod 4
// implements it (packages/protocol/src/types/mailboxEnvelope.ts): 8-4-4-4-12
// hex in either case, version 1-8, variant 8/9/a/b, plus the nil UUID that zod
// admits as a special case and unlike zod 3 NOT the max UUID.
//
// The relay must refuse exactly what its client refuses. `pollMailbox` parses a
// poll response as one `z.array(MailboxEnvelopeSchema.strict())`, so a single
// stored envelope whose identifiers are merely short-but-malformed fails the
// whole batch parse before per-envelope acceptance runs, and the legitimate
// traffic queued behind it is never delivered (round-2 finding R2-001 path A).
//
// This is deliberately a separate rule from validation/signal_prekey_bundle_v2.go's
// `uuidV2`, which governs the v2 prekey routes, is lowercase-only and does admit
// the max UUID. That rule is not changed here.
var clientMailboxUUID = regexp.MustCompile(`^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000)$`)

// mailboxEnvelopePayloadType is the single payload type the CLI's wire schema
// declares as a literal.
const mailboxEnvelopePayloadType = "ciphertext_message"

// mailboxEnvelopeIdentifiers names the envelope's identifier-shaped string
// fields for the length bound.
func mailboxEnvelopeIdentifiers(envelope *model.MailboxEnvelope) []identifierField {
	return []identifierField{
		{"envelope_id", envelope.EnvelopeID},
		{"message_id", envelope.MessageID},
		{"sender_identity_id", envelope.SenderIdentityID},
		{"sender_device_id", envelope.SenderDeviceID},
		{"recipient_identity_id", envelope.RecipientIdentityID},
		{"recipient_device_id", envelope.RecipientDeviceID},
		{"recipient_mailbox_id", envelope.RecipientMailboxID},
		{"payload_type", envelope.PayloadType},
	}
}

// mailboxEnvelopeUUIDIdentifiers names exactly the four fields the client's wire
// schema constrains to UUID shape. sender_identity_id, recipient_identity_id and
// recipient_mailbox_id are deliberately absent: the client declares them as free
// strings and they carry base64url ed25519 keys and SHA-256 digests, so
// requiring UUIDs there would refuse all real traffic.
func mailboxEnvelopeUUIDIdentifiers(envelope *model.MailboxEnvelope) []identifierField {
	return []identifierField{
		{"envelope_id", envelope.EnvelopeID},
		{"message_id", envelope.MessageID},
		{"sender_device_id", envelope.SenderDeviceID},
		{"recipient_device_id", envelope.RecipientDeviceID},
	}
}

func ValidateMailboxEnvelope(envelope *model.MailboxEnvelope, maxBytes int64) error {
	if envelope.Type != "mailbox_envelope" {
		return &ValidationError{Code: "INVALID_SCHEMA", Message: "type must be mailbox_envelope"}
	}
	if envelope.Version != 1 {
		return &ValidationError{Code: "INVALID_SCHEMA", Message: "version must be 1"}
	}
	// The length bound runs first, so an oversized identifier keeps answering
	// with the bound it violated rather than with a shape complaint.
	for _, identifier := range mailboxEnvelopeIdentifiers(envelope) {
		if len(identifier.Value) > MaxIdentifierBytes {
			return &ValidationError{Code: "INVALID_SCHEMA", Message: identifier.Name + " exceeds the maximum identifier length"}
		}
	}
	for _, identifier := range mailboxEnvelopeUUIDIdentifiers(envelope) {
		if !clientMailboxUUID.MatchString(identifier.Value) {
			return &ValidationError{Code: "INVALID_SCHEMA", Message: identifier.Name + " must be a uuid"}
		}
	}
	if envelope.PayloadType != mailboxEnvelopePayloadType {
		return &ValidationError{Code: "INVALID_SCHEMA", Message: "payload_type must be " + mailboxEnvelopePayloadType}
	}
	if envelope.Ciphertext == "" {
		return &ValidationError{Code: "INVALID_SCHEMA", Message: "ciphertext is required"}
	}
	// size_bytes is attacker-supplied. The authority is the actual decoded
	// ciphertext length, which the CLI contract defines size_bytes to equal
	// (apps/cli/src/runtime/outbound.ts, inbound.ts).
	actualCiphertextBytes := int64(len(envelope.Ciphertext))
	if actualCiphertextBytes > maxBytes {
		return &ValidationError{Code: "PAYLOAD_TOO_LARGE", Message: "envelope size exceeds limit"}
	}
	if envelope.SizeBytes > maxBytes {
		return &ValidationError{Code: "PAYLOAD_TOO_LARGE", Message: "envelope size exceeds limit"}
	}
	if envelope.SizeBytes != actualCiphertextBytes {
		return &ValidationError{Code: "INVALID_SCHEMA", Message: "size_bytes does not match the ciphertext length"}
	}
	if envelope.ExpiresAtMs <= envelope.CreatedAtMs {
		return &ValidationError{Code: "INVALID_SCHEMA", Message: "expires_at_ms must be after created_at_ms"}
	}
	return nil
}

type ValidationError struct {
	Code    string
	Message string
}

func (e *ValidationError) Error() string {
	return e.Message
}
