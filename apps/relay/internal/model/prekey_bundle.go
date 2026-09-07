package model

type PreKeyBundle struct {
	Type           string          `json:"type"`
	Version        int             `json:"version"`
	BundleID       string          `json:"bundle_id"`
	IdentityID     string          `json:"identity_id"`
	DeviceID       string          `json:"device_id"`
	DevicePubKey   string          `json:"device_pubkey"`
	SignedPreKey   SignedPreKey    `json:"signed_prekey"`
	OneTimePreKeys []OneTimePreKey `json:"one_time_prekeys"`
	CreatedAtMs    int64           `json:"created_at_ms"`
	Signature      string          `json:"signature"`
}

type SignedPreKey struct {
	KeyID       string `json:"key_id"`
	PublicKey   string `json:"public_key"`
	CreatedAtMs int64  `json:"created_at_ms"`
	ExpiresAtMs int64  `json:"expires_at_ms"`
	Signature   string `json:"signature"`
}

type OneTimePreKey struct {
	KeyID     string `json:"key_id"`
	PublicKey string `json:"public_key"`
}
