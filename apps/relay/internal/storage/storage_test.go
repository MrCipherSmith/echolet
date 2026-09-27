package storage

import (
	"testing"

	"github.com/dgraph-io/badger/v4"
)

func TestDiskUsageGrowsWithStoredData(t *testing.T) {
	st, err := NewStorage(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })

	before, err := st.DiskUsage()
	if err != nil {
		t.Fatalf("DiskUsage() error = %v", err)
	}

	value := make([]byte, 4<<20)
	if err := st.DB().Update(func(txn *badger.Txn) error { return txn.Set([]byte("big"), value) }); err != nil {
		t.Fatal(err)
	}
	if err := st.DB().Sync(); err != nil {
		t.Fatal(err)
	}

	after, err := st.DiskUsage()
	if err != nil {
		t.Fatalf("DiskUsage() error = %v", err)
	}
	if after < before+int64(len(value)) {
		t.Fatalf("DiskUsage() = %d after writing %d bytes over %d, want it to account for the write", after, len(value), before)
	}
}

// Badger's value log and memtable are sparse files whose apparent length is
// 2 GiB and 128 MiB on an empty store. Counting apparent length would put a
// fresh relay over the default 2 GiB cap before it stored a single byte.
func TestDiskUsageOfAFreshStoreIgnoresSparsePreallocation(t *testing.T) {
	st, err := NewStorage(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })

	used, err := st.DiskUsage()
	if err != nil {
		t.Fatalf("DiskUsage() error = %v", err)
	}
	if used > 64<<20 {
		t.Fatalf("DiskUsage() of an empty store = %d bytes, want well under 64 MiB: sparse preallocation is being counted", used)
	}
}

func TestCollectGarbageOnAStoreWithNothingToReclaimSucceeds(t *testing.T) {
	st, err := NewStorage(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })

	if err := st.CollectGarbage(); err != nil {
		t.Fatalf("CollectGarbage() error = %v, want nil when no value log file qualifies", err)
	}
}
