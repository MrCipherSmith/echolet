package cryptoutil

import (
	"bytes"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"sort"
	"strings"
)

func DeriveMailboxID(identityPubKey string) string {
	hash := sha256.Sum256([]byte(fmt.Sprintf("%s:mailbox:v1", identityPubKey)))
	return base64.RawURLEncoding.EncodeToString(hash[:])
}

func CreateMailboxChallengeMessage(challengeID, recipientMailboxID, deviceID, nonce string) string {
	return fmt.Sprintf(
		"echolet-mailbox-challenge:v1:%s:%s:%s:%s",
		challengeID,
		recipientMailboxID,
		deviceID,
		nonce,
	)
}

func CreateMailboxCreateChallengeMessage(recipientMailboxID, deviceID string) string {
	return fmt.Sprintf(
		"echolet-mailbox-create-challenge:v1:%s:%s",
		recipientMailboxID,
		deviceID,
	)
}

func CreateMailboxAckMessage(recipientMailboxID, deviceID string, envelopeIDs []string) string {
	normalizedEnvelopeIDs := append([]string(nil), envelopeIDs...)
	sort.Strings(normalizedEnvelopeIDs)
	return fmt.Sprintf(
		"echolet-mailbox-ack:v1:%s:%s:%s",
		recipientMailboxID,
		deviceID,
		strings.Join(normalizedEnvelopeIDs, ","),
	)
}

// HashMailboxEnvelopeCiphertext binds an envelope's payload into the sender
// transcript by digest rather than inline, so the signed string stays a few
// hundred bytes for a 256 KiB ciphertext while still pinning the exact payload
// bytes. Its TypeScript counterpart is hashMailboxEnvelopeCiphertext in
// packages/crypto-core/src/mailbox/auth.ts.
func HashMailboxEnvelopeCiphertext(ciphertext string) string {
	digest := sha256.Sum256([]byte(ciphertext))
	return base64.RawURLEncoding.EncodeToString(digest[:])
}

// CreateMailboxEnvelopeMessage is the transcript /v1/messages/send
// authenticates a sender with (T50, finding T49-F-001). It binds where the
// envelope lands, which envelope it is, who it claims to be from, what it
// contains and how long it occupies the mailbox - every input to the
// mailbox-flooding capability T49 measured.
//
// The string is a wire contract shared with the TypeScript senders
// (createMailboxEnvelopeMessage in packages/crypto-core/src/mailbox/auth.ts) and
// is pinned literally on both sides. Change it only by minting a new version
// prefix in both languages together.
func CreateMailboxEnvelopeMessage(
	recipientMailboxID string,
	envelopeID string,
	senderIdentityID string,
	senderDeviceID string,
	ciphertextDigest string,
	createdAtMs int64,
	expiresAtMs int64,
) string {
	return fmt.Sprintf(
		"echolet-mailbox-envelope:v1:%s:%s:%s:%s:%s:%d:%d",
		recipientMailboxID,
		envelopeID,
		senderIdentityID,
		senderDeviceID,
		ciphertextDigest,
		createdAtMs,
		expiresAtMs,
	)
}

func MarshalCanonicalJSONWithoutSignature(value any) ([]byte, error) {
	raw, err := json.Marshal(value)
	if err != nil {
		return nil, err
	}

	var decoded any
	if err := json.Unmarshal(raw, &decoded); err != nil {
		return nil, err
	}

	var buffer bytes.Buffer
	if err := writeCanonicalJSON(&buffer, stripSignatureFields(decoded)); err != nil {
		return nil, err
	}

	return buffer.Bytes(), nil
}

func VerifyCanonicalJSONSignature(value any, signatureBase64URL, publicKeyBase64URL string) (bool, error) {
	message, err := MarshalCanonicalJSONWithoutSignature(value)
	if err != nil {
		return false, err
	}

	return VerifyMessageSignature(string(message), signatureBase64URL, publicKeyBase64URL)
}

func VerifyMessageSignature(message, signatureBase64URL, publicKeyBase64URL string) (bool, error) {
	signature, err := base64.RawURLEncoding.DecodeString(signatureBase64URL)
	if err != nil {
		return false, err
	}

	publicKey, err := base64.RawURLEncoding.DecodeString(publicKeyBase64URL)
	if err != nil {
		return false, err
	}

	if len(signature) != ed25519.SignatureSize {
		return false, fmt.Errorf("invalid signature length")
	}

	if len(publicKey) != ed25519.PublicKeySize {
		return false, fmt.Errorf("invalid public key length")
	}

	return ed25519.Verify(ed25519.PublicKey(publicKey), []byte(message), signature), nil
}

func stripSignatureFields(value any) any {
	switch typed := value.(type) {
	case map[string]any:
		result := make(map[string]any, len(typed))
		for key, child := range typed {
			if key == "signature" {
				continue
			}
			result[key] = stripSignatureFields(child)
		}
		return result
	case []any:
		result := make([]any, len(typed))
		for index, child := range typed {
			result[index] = stripSignatureFields(child)
		}
		return result
	default:
		return value
	}
}

func writeCanonicalJSON(buffer *bytes.Buffer, value any) error {
	switch typed := value.(type) {
	case map[string]any:
		keys := make([]string, 0, len(typed))
		for key := range typed {
			keys = append(keys, key)
		}
		sort.Strings(keys)

		buffer.WriteByte('{')
		for index, key := range keys {
			if index > 0 {
				buffer.WriteByte(',')
			}

			keyJSON, err := json.Marshal(key)
			if err != nil {
				return err
			}
			buffer.Write(keyJSON)
			buffer.WriteByte(':')

			if err := writeCanonicalJSON(buffer, typed[key]); err != nil {
				return err
			}
		}
		buffer.WriteByte('}')
		return nil
	case []any:
		buffer.WriteByte('[')
		for index, item := range typed {
			if index > 0 {
				buffer.WriteByte(',')
			}

			if err := writeCanonicalJSON(buffer, item); err != nil {
				return err
			}
		}
		buffer.WriteByte(']')
		return nil
	default:
		encoded, err := json.Marshal(typed)
		if err != nil {
			return err
		}
		buffer.Write(encoded)
		return nil
	}
}
