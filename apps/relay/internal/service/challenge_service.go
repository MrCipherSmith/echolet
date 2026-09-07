package service

import (
	"crypto/rand"
	"encoding/base64"
	"fmt"
	"time"

	"echolet/apps/relay/internal/model"
	"echolet/apps/relay/internal/storage/repository"
	"github.com/google/uuid"
)

var ErrInvalidChallenge = repository.ErrInvalidChallenge

type ChallengeService struct {
	repo                *repository.ChallengeRepository
	challengeTTLSeconds int
}

func NewChallengeService(repo *repository.ChallengeRepository, challengeTTLSeconds int) *ChallengeService {
	return &ChallengeService{
		repo:                repo,
		challengeTTLSeconds: challengeTTLSeconds,
	}
}

func (s *ChallengeService) CreateChallenge(recipientMailboxID, deviceID string) (*model.MailboxChallenge, error) {
	nonceBytes := make([]byte, 32)
	if _, err := rand.Read(nonceBytes); err != nil {
		return nil, err
	}

	challenge := &model.MailboxChallenge{
		ChallengeID:        uuid.New().String(),
		RecipientMailboxID: recipientMailboxID,
		DeviceID:           deviceID,
		Nonce:              base64.URLEncoding.EncodeToString(nonceBytes),
		ExpiresAtMs:        time.Now().Add(time.Duration(s.challengeTTLSeconds) * time.Second).UnixMilli(),
		Used:               false,
	}

	if err := s.repo.Save(challenge); err != nil {
		return nil, err
	}

	return challenge, nil
}

func (s *ChallengeService) ValidateAndInvalidate(challengeID string) (*model.MailboxChallenge, error) {
	challenge, err := s.GetValid(challengeID)
	if err != nil {
		return nil, err
	}

	if err := s.Invalidate(challengeID); err != nil {
		return nil, err
	}

	challenge.Used = true
	return challenge, nil
}

func (s *ChallengeService) GetValid(challengeID string) (*model.MailboxChallenge, error) {
	challenge, err := s.repo.Get(challengeID)
	if err != nil {
		return nil, err
	}

	if challenge.Used {
		return nil, fmt.Errorf("challenge already used")
	}

	if time.Now().UnixMilli() > challenge.ExpiresAtMs {
		return nil, fmt.Errorf("challenge expired")
	}

	return challenge, nil
}

func (s *ChallengeService) Invalidate(challengeID string) error {
	return s.repo.Invalidate(challengeID)
}
