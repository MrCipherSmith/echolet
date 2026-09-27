package storage

import (
	"errors"
	"io/fs"
	"log/slog"
	"path/filepath"

	"github.com/dgraph-io/badger/v4"
)

// valueLogGCDiscardRatio is the share of a value log file that must be garbage
// before Badger rewrites it. 0.5 is Badger's documented default.
const valueLogGCDiscardRatio = 0.5

// maxValueLogGCRounds bounds one CollectGarbage call, so a cleanup tick cannot
// hold the shutdown sequence (which waits for the tick) for an unbounded time.
const maxValueLogGCRounds = 8

type Storage struct {
	db      *badger.DB
	dataDir string
}

func NewStorage(dataDir string) (*Storage, error) {
	opts := badger.DefaultOptions(dataDir).WithLoggingLevel(badger.WARNING)
	db, err := badger.Open(opts)
	if err != nil {
		return nil, err
	}

	slog.Info("BadgerDB opened", "dir", dataDir)
	return &Storage{db: db, dataDir: dataDir}, nil
}

func (s *Storage) DB() *badger.DB {
	return s.db
}

// DiskUsage is the number of bytes the store occupies on disk right now.
//
// It walks the data directory instead of calling badger.DB.Size, whose figures
// are refreshed by Badger only once a minute and would let a full minute of
// writes through a storage cap unnoticed. It counts the blocks each file really
// occupies, not its apparent length: Badger creates its value log and memtable
// as sparse files (2 GiB and 128 MiB on an EMPTY store), so apparent sizes
// would report a fresh relay as already over a 2 GiB cap.
func (s *Storage) DiskUsage() (int64, error) {
	var total int64
	err := filepath.WalkDir(s.dataDir, func(_ string, entry fs.DirEntry, err error) error {
		if err != nil {
			// Badger rotates files while it runs; one vanishing mid-walk is
			// not a failure of the measurement.
			if errors.Is(err, fs.ErrNotExist) {
				return nil
			}
			return err
		}
		if entry.IsDir() {
			return nil
		}
		info, err := entry.Info()
		if err != nil {
			if errors.Is(err, fs.ErrNotExist) {
				return nil
			}
			return err
		}
		total += allocatedBytes(info)
		return nil
	})
	return total, err
}

// CollectGarbage reclaims disk space held by expired and overwritten values.
//
// Badger's TTL only hides an expired key; the bytes stay in the value log until
// that file is rewritten. Without this call a relay whose mailboxes expire on
// schedule still grows on disk forever.
func (s *Storage) CollectGarbage() error {
	for round := 0; round < maxValueLogGCRounds; round++ {
		err := s.db.RunValueLogGC(valueLogGCDiscardRatio)
		if errors.Is(err, badger.ErrNoRewrite) || errors.Is(err, badger.ErrRejected) {
			return nil
		}
		if err != nil {
			return err
		}
	}
	return nil
}

func (s *Storage) Close() error {
	return s.db.Close()
}
