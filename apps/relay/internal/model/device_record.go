package model

type DeviceRecord struct {
	Type         string          `json:"type"`
	Version      int             `json:"version"`
	IdentityID   string          `json:"identity_id"`
	DeviceID     string          `json:"device_id"`
	DevicePubKey string          `json:"device_pubkey"`
	DeviceLabel  *string         `json:"device_label,omitempty"`
	Capabilities map[string]bool `json:"capabilities"`
	CreatedAtMs  int64           `json:"created_at_ms"`
	Signature    string          `json:"signature"`
}
