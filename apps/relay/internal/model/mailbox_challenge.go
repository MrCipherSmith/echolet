package model

type MailboxChallenge struct {
	ChallengeID        string `json:"challenge_id"`
	RecipientMailboxID string `json:"recipient_mailbox_id"`
	DeviceID           string `json:"device_id"`
	Nonce              string `json:"nonce"`
	ExpiresAtMs        int64  `json:"expires_at_ms"`
	Used               bool   `json:"used"`
}
