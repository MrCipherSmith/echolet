package service

import (
	"echolet/apps/relay/internal/model"
	"echolet/apps/relay/internal/storage/repository"
)

type DeviceRecordService struct {
	repo *repository.DeviceRecordRepository
}

func NewDeviceRecordService(repo *repository.DeviceRecordRepository) *DeviceRecordService {
	return &DeviceRecordService{repo: repo}
}

func (s *DeviceRecordService) PublishDeviceRecord(record *model.DeviceRecord) error {
	return s.repo.Save(record)
}

// GetByMailboxAndDevice resolves a device through the immutable
// (mailbox identity, device UUID) binding rather than by a global device UUID
// scan, so a UUID published under an unrelated identity cannot deny the
// legitimate mailbox owner.
func (s *DeviceRecordService) GetByMailboxAndDevice(mailboxID, deviceID string) (*model.DeviceRecord, error) {
	return s.repo.GetByMailboxAndDevice(mailboxID, deviceID)
}

// BackfillMailboxBindings derives the authorization index for device records
// written before the binding key space existed.
func (s *DeviceRecordService) BackfillMailboxBindings() error {
	return s.repo.BackfillDeviceMailboxBindings()
}
