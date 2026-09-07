package model

import "errors"

var (
	ErrV2Schema         = errors.New("INVALID_SCHEMA")
	ErrV2Signature      = errors.New("INVALID_SIGNATURE")
	ErrV2Expired        = errors.New("BUNDLE_EXPIRED")
	ErrV2BundleConflict = errors.New("BUNDLE_ID_CONFLICT")
	ErrV2PreKeyReused   = errors.New("ONE_TIME_PREKEY_REUSED")
	ErrV2ClaimConflict  = errors.New("CLAIM_ID_CONFLICT")
	ErrV2Unavailable    = errors.New("PREKEY_BUNDLE_UNAVAILABLE")
)

// Raw is stored as bytes, not json.RawMessage: persistence must not compact it.
type SignalPreKeyBundleV2 struct {
	BundleID         string
	IdentityID       string
	DeviceID         string
	DeviceRecord     DeviceRecord
	SignalIdentity   string
	OneTimeKeyID     uint32
	OneTimePublicKey string
	CreatedAtMS      int64
	ExpiresAtMS      int64
	Raw              []byte
	Claimed          bool
}
