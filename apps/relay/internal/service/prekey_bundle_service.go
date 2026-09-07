package service

import (
	"echolet/apps/relay/internal/model"
	"echolet/apps/relay/internal/storage/repository"
)

type PreKeyBundleService struct {
	repo *repository.PreKeyBundleRepository
}

func NewPreKeyBundleService(repo *repository.PreKeyBundleRepository) *PreKeyBundleService {
	return &PreKeyBundleService{repo: repo}
}

func (s *PreKeyBundleService) PublishPreKeyBundle(bundle *model.PreKeyBundle) error {
	return s.repo.Save(bundle)
}

func (s *PreKeyBundleService) GetPreKeyBundles(identityID string) ([]*model.PreKeyBundle, error) {
	return s.repo.GetByIdentity(identityID)
}
