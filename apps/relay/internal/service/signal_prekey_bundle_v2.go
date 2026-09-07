package service

import "echolet/apps/relay/internal/validation"

// PublishSignalPreKeyBundleV2 keeps the error-only publish signature that the relay v2 API
// contract declares (see the relayV2Service interface in the relayv2-tagged repository tests).
// Callers that must report claimability to the client use PublishSignalPreKeyBundleV2Claimable.
func (s *PreKeyBundleService) PublishSignalPreKeyBundleV2(raw []byte, nowMS int64) error {
	_, err := s.PublishSignalPreKeyBundleV2Claimable(raw, nowMS)
	return err
}

// PublishSignalPreKeyBundleV2Claimable additionally reports whether the stored publication is
// available for a first-contact claim. A repeated publish of an already claimed bundle succeeds
// and stores nothing new, so without this the client cannot tell a real publication from a
// recovery attempt that restored nothing.
func (s *PreKeyBundleService) PublishSignalPreKeyBundleV2Claimable(raw []byte, nowMS int64) (bool, error) {
	bundle, err := validation.ValidateSignalPreKeyBundleV2(raw, nowMS)
	if err != nil {
		return false, err
	}
	return s.repo.SaveSignalV2(bundle)
}
func (s *PreKeyBundleService) ClaimSignalPreKeyBundleV2(claimID, identityID string, deviceID *string, nowMS int64) ([]byte, error) {
	if err := validation.ValidateSignalSelector(claimID, identityID, deviceID); err != nil {
		return nil, err
	}
	if deviceID != nil {
		owned := *deviceID
		deviceID = &owned
	}
	return s.repo.ClaimSignalV2(claimID, identityID, deviceID, nowMS)
}
