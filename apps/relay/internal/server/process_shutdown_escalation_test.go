// Process-level tests for the two shutdown ESCALATION paths, and for the
// cleanup service's place in the stop sequence.
//
// Residual RI-31 (flow 003 T1 inventory; T17-F-003): process_shutdown_test.go
// declares four tests and every one of them exercises the ordinary millisecond
// drain. Neither escalation - the drain deadline being exceeded
// (cmd/relay/main.go:121-135) and a second signal arriving during shutdown
// (main.go:136-152) - is covered by anything. Those are the two paths on which
// the store is most at risk, so they are the least protected: a change that
// returned non-zero on a DeadlineExceeded, or one that let a second signal skip
// the Badger close, would turn a routine operator stop into what looks like a
// crash, or leave a memtable write-ahead log for the next start to replay, and
// nothing would go red.
//
// Residual RI-30 (T17-F-002): the cleanup ticker is outside the stop sequence
// entirely. The half of that residual which is only visible from outside the
// process - that the relay actually stops the service, and does it before Badger
// closes - is pinned here; the half about CleanupService's own shape is
// TestCleanupServiceStopEndsItsTickerGoroutine in internal/service.
//
// These tests extend process_shutdown_test.go's harness in its own style and
// change nothing in it. Synchronisation is always on an observable event, never
// on a sleep:
//   - "a request is in flight"    -> the server has written `100 Continue`,
//     which net/http emits only once the handler has begun reading the body
//   - "the shutdown has started"  -> a fresh dial is refused, so the listener is
//     already closed and main.go is inside the drain
//   - "the process is finished"   -> cmd.Wait has returned
//
// The one duration that is compared against anything is the relay's own drain
// timeout, and it is used as a floor to distinguish "the second signal cut the
// drain short" from "the drain simply expired" - not as a wait.
package server

import (
	"bufio"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"
)

// relayDrainTimeout mirrors the drainTimeout constant at cmd/relay/main.go:32.
// It is read from there, never asserted on: the tests below use it to size a
// budget and to separate the two escalation paths from each other.
const relayDrainTimeout = 5 * time.Second

// escalationBudget is how long a relay whose drain deadline is deliberately
// exceeded has to be gone. It is the drain timeout plus process_shutdown_test's
// own shutdownBudget, so it bounds "the drain expired, then the store closed"
// without ever bounding the assertion itself.
const escalationBudget = relayDrainTimeout + shutdownBudget

// TestRelayExitsZeroWhenTheDrainDeadlineIsExceeded pins the first escalation.
//
// A client that will not finish is not the operator's stop failing. The relay
// must give up on it at the deadline, close the remaining connections, close
// Badger cleanly anyway, and still report success - otherwise one stalled client
// is enough to make `docker stop` look like a crash to every supervisor keying
// off the exit status.
//
// The request here is deliberately never completed: its body is written into the
// `Content-Length` the server is waiting for and never sent, so the handler stays
// blocked in decodeJSONRequest for as long as the connection lives and the drain
// can only end by expiring.
func TestRelayExitsZeroWhenTheDrainDeadlineIsExceeded(t *testing.T) {
	p := startRelay(t)
	conn, _ := beginUnfinishedRequest(t, p)
	defer func() { _ = conn.Close() }()

	p.signal(t, syscall.SIGTERM)

	state, ok := p.wait(escalationBudget)
	if !ok {
		t.Fatalf("relay did not exit within %s of SIGTERM while one request was held open past the %s drain "+
			"deadline; the drain must expire and the stop must complete regardless of a client that will not "+
			"finish. stderr:\n%s", escalationBudget, relayDrainTimeout, p.stderrText())
	}
	if code := state.ExitCode(); code != 0 {
		t.Fatalf("relay exited %s after its drain deadline was exceeded, want exit status 0 (ExitCode()==%d); "+
			"a client that would not finish in time is not the operator's stop failing. stderr:\n%s",
			state.String(), code, p.stderrText())
	}

	assertStorageClosedCleanly(t, p, "the drain deadline was exceeded")
}

// TestRelayExitsZeroOnASecondSignalDuringShutdown pins the second escalation.
//
// A second signal is an operator saying "stop waiting". It must abandon the
// drain - and only the drain: the store close is the part of the sequence that
// must never be skipped, because an abandoned Badger directory is the durability
// problem the whole path exists to prevent.
//
// The second signal is sent only after a fresh dial is refused, which is positive
// proof that Shutdown has already closed the listener and main.go is inside the
// drain, so the signal is provably an escalation rather than a race with the
// first one. That the escalation really happened is then measurable: the process
// must be gone in less than the drain timeout it abandoned. The margin is three
// orders of magnitude - closing two connections and a Badger directory takes
// milliseconds against a 5s floor - so this cannot be read as a timing tolerance.
func TestRelayExitsZeroOnASecondSignalDuringShutdown(t *testing.T) {
	p := startRelay(t)
	conn, _ := beginUnfinishedRequest(t, p)
	defer func() { _ = conn.Close() }()

	firstSignalAt := time.Now()
	p.signal(t, syscall.SIGTERM)

	// Observable event: the listener is closed, so the drain is running.
	if !dialRefusedWithin(p.addr, shutdownBudget) {
		t.Fatalf("relay still accepted a new connection on %s more than %s after the first SIGTERM, so the "+
			"shutdown had not begun and a second signal would not have been an escalation. stderr:\n%s",
			p.addr, shutdownBudget, p.stderrText())
	}

	p.signal(t, syscall.SIGTERM)

	state, ok := p.wait(escalationBudget)
	if !ok {
		t.Fatalf("relay did not exit within %s of a second SIGTERM sent during shutdown. stderr:\n%s",
			escalationBudget, p.stderrText())
	}
	elapsed := time.Since(firstSignalAt)

	if code := state.ExitCode(); code != 0 {
		t.Fatalf("relay exited %s after a second SIGTERM during shutdown, want exit status 0 (ExitCode()==%d); "+
			"an operator pressing Ctrl-C twice must still be a clean stop. stderr:\n%s",
			state.String(), code, p.stderrText())
	}
	if elapsed >= relayDrainTimeout {
		t.Fatalf("relay took %s to exit after a second SIGTERM, which is at least the %s drain timeout it was "+
			"asked to abandon; the second signal must cut the drain short rather than being absorbed while the "+
			"deadline runs out on its own. stderr:\n%s", elapsed, relayDrainTimeout, p.stderrText())
	}

	assertStorageClosedCleanly(t, p, "a second signal arrived during shutdown")
}

// TestRelayStopsTheCleanupServiceBeforeClosingStorage pins the half of RI-30
// that is only observable from outside the process.
//
// router.go:47-48 starts the cleanup service and keeps no handle, so nothing
// stops it and it is not part of main.go's stop sequence at all. Today that is
// survivable only because runCleanup() has an empty body; the sequence at
// main.go:104-114 exists precisely so that nothing is still writing when Badger
// closes, and a timer outside it is a hole in that argument rather than a bug
// waiting for a trigger.
//
// The only evidence a process-level test can have is the relay's own log, which
// is where every other step of the stop already reports itself ("Shutdown signal
// received", "In-flight requests drained", "Storage closed"). The assertion is
// therefore that the stop is reported for the cleanup service, and that it is
// reported BEFORE the store close - the ordering is the property, not the
// wording, and the matcher accepts any phrasing that names the cleanup service
// and a stop.
func TestRelayStopsTheCleanupServiceBeforeClosingStorage(t *testing.T) {
	p := startRelay(t)

	// Precondition: the service really was started, so a missing stop below
	// cannot be explained by there being nothing to stop.
	if indexOfLogMessage(p.stderrText(), func(message string) bool {
		return strings.Contains(message, "cleanup service started")
	}) < 0 {
		t.Fatalf("precondition failed: the relay did not report starting the cleanup service, so this test could "+
			"not distinguish a service that was stopped from one that never ran. stderr:\n%s", p.stderrText())
	}

	p.signal(t, syscall.SIGTERM)
	if _, ok := p.wait(shutdownBudget); !ok {
		t.Fatalf("relay did not exit within %s of SIGTERM; stderr:\n%s", shutdownBudget, p.stderrText())
	}

	output := p.stderrText()
	stopIndex := indexOfLogMessage(output, mentionsCleanupStop)
	closeIndex := indexOfLogMessage(output, func(message string) bool {
		return strings.Contains(message, "storage closed")
	})
	if closeIndex < 0 {
		t.Fatalf("the relay never reported closing storage, so the ordering under test is not observable. "+
			"stderr:\n%s", output)
	}
	if stopIndex < 0 {
		t.Fatalf("the relay stopped without ever stopping its cleanup service: cleanup_service.go:31-39 launches a "+
			"ticker goroutine that router.go:47-48 keeps no handle to, so main.go's stop sequence "+
			"(cmd/relay/main.go:104-114) cannot end it and it outlives the Badger close. Step 3 of that sequence "+
			"exists so that nothing is still writing when the store closes; a timer outside it is exactly the "+
			"hazard it was written to remove. stderr:\n%s", output)
	}
	if stopIndex > closeIndex {
		t.Fatalf("the relay stopped its cleanup service AFTER closing storage. The timer must be stopped between "+
			"the drain and the store close, or a cleanup that touches Badger runs against a closing database. "+
			"stderr:\n%s", output)
	}
}

// mentionsCleanupStop reports whether a log MESSAGE names the cleanup service
// and a stop. It matches on meaning rather than on an exact message, so any
// reasonable phrasing passes.
func mentionsCleanupStop(message string) bool {
	return strings.Contains(message, "cleanup") &&
		(strings.Contains(message, "stop") || strings.Contains(message, "shut"))
}

// indexOfLogMessage returns the byte offset of the first log line whose MESSAGE
// satisfies the predicate, or -1.
//
// Only the message is matched, never the whole line. The relay logs its data
// directory ("BadgerDB opened dir=..."), and under `go test` that path contains
// the running test's own name - so matching whole lines would let a test called
// TestRelayStopsTheCleanupService... satisfy a search for "cleanup" and "stop"
// out of its own temporary directory name. The message is extracted from the
// slog TextHandler encoding the relay installs (internal/logging), which writes
// `msg="..."` for any message containing a space.
func indexOfLogMessage(output string, matches func(message string) bool) int {
	offset := 0
	for _, line := range strings.Split(output, "\n") {
		if message, ok := logMessage(line); ok && matches(message) {
			return offset
		}
		offset += len(line) + 1
	}
	return -1
}

// logMessage extracts the lower-cased msg field of one slog TextHandler line.
func logMessage(line string) (string, bool) {
	start := strings.Index(line, "msg=")
	if start < 0 {
		return "", false
	}
	rest := line[start+len("msg="):]
	if strings.HasPrefix(rest, `"`) {
		end := strings.Index(rest[1:], `"`)
		if end < 0 {
			return "", false
		}
		return strings.ToLower(rest[1 : 1+end]), true
	}
	if end := strings.IndexByte(rest, ' '); end >= 0 {
		rest = rest[:end]
	}
	return strings.ToLower(rest), true
}

// beginUnfinishedRequest opens a request the relay has provably begun serving
// and will never see the end of.
//
// It is process_shutdown_test.go's `Expect: 100-continue` synchronisation point
// used for the opposite purpose: there, reading `100 Continue` proves the handler
// is running so that the body can then be sent and the drain observed to
// complete; here the body is deliberately withheld, so the handler stays blocked
// in decodeJSONRequest and the drain can only end by escalation. The declared
// Content-Length is never satisfied, which is what holds the connection open.
//
// No request body is ever sent, so nothing is written to the relay's store and
// nothing is printed.
func beginUnfinishedRequest(t *testing.T, p *relayProcess) (net.Conn, *bufio.Reader) {
	t.Helper()

	conn, err := net.Dial("tcp", p.addr)
	if err != nil {
		t.Fatalf("dial relay: %v", err)
	}
	if err := conn.SetDeadline(time.Now().Add(escalationBudget + ioBudget)); err != nil {
		t.Fatalf("set deadline: %v", err)
	}

	const bodyBytes = 90
	head := "POST /v1/mailbox/challenge HTTP/1.1\r\n" +
		"Host: " + p.addr + "\r\n" +
		"Content-Type: application/json\r\n" +
		fmt.Sprintf("Content-Length: %d\r\n", bodyBytes) +
		"Expect: 100-continue\r\n" +
		"Connection: close\r\n\r\n"
	if _, err := io.WriteString(conn, head); err != nil {
		_ = conn.Close()
		t.Fatalf("write request head: %v", err)
	}

	reader := bufio.NewReader(conn)
	interim, err := reader.ReadString('\n')
	if err != nil {
		_ = conn.Close()
		t.Fatalf("reading the interim response failed: %v (the relay never began serving the request, so nothing "+
			"was in flight to hold the drain open); stderr:\n%s", err, p.stderrText())
	}
	if !strings.Contains(interim, "100") {
		_ = conn.Close()
		t.Fatalf("expected an interim %q response before the body, got %q", "100 Continue", strings.TrimSpace(interim))
	}
	if _, err := reader.ReadString('\n'); err != nil { // the blank line ending the interim response
		_ = conn.Close()
		t.Fatalf("reading the interim response terminator: %v", err)
	}

	return conn, reader
}

// assertStorageClosedCleanly repeats TestRelayClosesStorageCleanlyOnSIGTERM's
// observable on the escalation paths: a clean badger.Close flushes the memtable
// into an SST, deletes the *.mem write-ahead log and releases the directory
// lock. Anything left behind turns the next start into a value-log replay, which
// is the durability problem the escalation paths must not trade away for speed.
func assertStorageClosedCleanly(t *testing.T, p *relayProcess, because string) {
	t.Helper()

	if mems := memtableWALs(t, p.dataDir); len(mems) > 0 {
		t.Fatalf("storage was not closed cleanly when %s: memtable write-ahead log(s) %v remain in %s. "+
			"The store close is the one step no escalation may skip. stderr:\n%s",
			because, mems, p.dataDir, p.stderrText())
	}
	if _, err := os.Stat(filepath.Join(p.dataDir, "LOCK")); err == nil {
		t.Fatalf("storage was not closed cleanly when %s: %s still holds a LOCK file, so the directory lock was "+
			"never released. stderr:\n%s", because, p.dataDir, p.stderrText())
	} else if !os.IsNotExist(err) {
		t.Fatalf("stat LOCK: %v", err)
	}
}
