package service

import (
	"testing"
	"time"
)

func TestCleanupTickRunsItsMaintenanceInOrder(t *testing.T) {
	ran := make(chan string, 4)
	cleanup := NewCleanupService(nil, nil, joinTickerInterval, 168)
	cleanup.SetMaintenance(
		func() { ran <- "gc" },
		func() { ran <- "measure" },
	)
	cleanup.Start()
	defer cleanup.Stop()

	for _, want := range []string{"gc", "measure"} {
		select {
		case got := <-ran:
			if got != want {
				t.Fatalf("maintenance ran %q, want %q: the storage cap must be re-measured after GC", got, want)
			}
		case <-time.After(cleanupGoroutineDeadline):
			t.Fatalf("maintenance task %q did not run within %s", want, cleanupGoroutineDeadline)
		}
	}
}
