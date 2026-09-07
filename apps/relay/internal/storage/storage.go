package storage

import (
	"log/slog"

	"github.com/dgraph-io/badger/v4"
)

type Storage struct {
	db *badger.DB
}

func NewStorage(dataDir string) (*Storage, error) {
	opts := badger.DefaultOptions(dataDir).WithLoggingLevel(badger.WARNING)
	db, err := badger.Open(opts)
	if err != nil {
		return nil, err
	}

	slog.Info("BadgerDB opened", "dir", dataDir)
	return &Storage{db: db}, nil
}

func (s *Storage) DB() *badger.DB {
	return s.db
}

func (s *Storage) Close() error {
	return s.db.Close()
}
