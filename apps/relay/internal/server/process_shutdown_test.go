// Process-level shutdown tests for the relay binary.
//
// These deliberately run the real `cmd/relay` binary as a real child process
// rather than exercising a handler or a *Server in-process. Signal disposition
// is a property of the process: an in-process test can call Shutdown and pass
// while the shipped binary, which installs no signal handler at all, is still
// torn down by the kernel. The defect these pin was found that way - `docker
// stop` on the deployed relay reports `Exited (2)`, not `Exited (0)` - so the
// test has to be able to see the same thing Docker sees, which is the exit
// status of a process that was sent SIGTERM.
//
// Synchronisation here is always on an observable event, never on a sleep:
//   - "the relay is up"          -> /health answers 200 on the reserved port
//   - "a request is in flight"   -> the server has written `100 Continue`,
//     which net/http emits only once the handler has begun reading the body
//   - "the listener is gone"     -> a fresh dial is refused
//   - "the process is finished"  -> cmd.Wait has returned
package server

import (
	"bufio"
	"bytes"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"
)

// shutdownBudget is how long a signalled relay has to be gone.
//
// The bound comes from the deployment, not from taste: `docker stop` sends
// SIGTERM and then SIGKILLs after a 10s grace period by default, and systemd's
// TimeoutStopSec defaults to 90s. A relay that needs longer than the Docker
// grace period to stop is killed by Docker and reports a non-zero exit for that
// reason alone, so 10s is the largest bound under which "exited cleanly" still
// means anything on the target. It is also far longer than a correct idle
// shutdown needs (closing a listener with no active connections and closing
// Badger takes milliseconds), so a failure at this bound is a real hang and not
// a slow machine.
const shutdownBudget = 10 * time.Second

// startupBudget covers process start, Badger opening the data directory and the
// first /health answer. Generous on purpose: it is not part of any assertion,
// it only bounds the readiness wait so a broken start fails loudly.
const startupBudget = 30 * time.Second

// ioBudget bounds every socket read in these tests so a cut or stalled
// connection surfaces as a named failure instead of hanging the suite.
const ioBudget = 15 * time.Second

// TestRelayExitsZeroOnSIGTERM pins the headline property: an ordinary operator
// stop is a success, not a crash.
//
// `docker stop`, `restart: unless-stopped`, `restart: on-failure`, a systemd
// unit and any health monitor all key off the exit status. While the relay dies
// from the signal, every one of them reads a routine stop as a failure.
func TestRelayExitsZeroOnSIGTERM(t *testing.T) {
	p := startRelay(t)
	p.signal(t, syscall.SIGTERM)

	state, ok := p.wait(shutdownBudget)
	if !ok {
		t.Fatalf("relay did not exit within %s of SIGTERM; stderr:\n%s", shutdownBudget, p.stderrText())
	}
	if code := state.ExitCode(); code != 0 {
		t.Fatalf("relay exited %s after SIGTERM, want exit status 0 (ExitCode()==%d); "+
			"a normal operator stop must not look like a crash. stderr:\n%s",
			state.String(), code, p.stderrText())
	}
}

// TestRelayExitsZeroOnSIGINT pins the same property for Ctrl-C, which is how an
// operator stops a relay started in the foreground. SIGINT and SIGTERM must not
// diverge: an interactive stop and a supervisor stop are the same event.
func TestRelayExitsZeroOnSIGINT(t *testing.T) {
	p := startRelay(t)
	p.signal(t, syscall.SIGINT)

	state, ok := p.wait(shutdownBudget)
	if !ok {
		t.Fatalf("relay did not exit within %s of SIGINT; stderr:\n%s", shutdownBudget, p.stderrText())
	}
	if code := state.ExitCode(); code != 0 {
		t.Fatalf("relay exited %s after SIGINT, want exit status 0 (ExitCode()==%d); "+
			"Ctrl-C on a foreground relay must be a clean stop. stderr:\n%s",
			state.String(), code, p.stderrText())
	}
}

// TestRelayDrainsInFlightRequestOnSIGTERM pins graceful shutdown: a request the
// server has already begun serving is finished, and no new connection is
// accepted once the signal has arrived.
//
// The in-flight request is created with `Expect: 100-continue`. net/http emits
// the interim `100 Continue` response only when the handler first reads
// r.Body - for /v1/mailbox/challenge that is decodeJSONRequest - so reading that
// line is positive proof that the handler is running and blocked on a body we
// have not sent yet. That is the synchronisation point; the signal is sent only
// after it, so the request is provably in flight when SIGTERM arrives.
//
// The response's status does not matter (the challenge is unsigned and will be
// rejected). What matters is that a complete HTTP response arrives at all
// rather than the connection being cut mid-request.
func TestRelayDrainsInFlightRequestOnSIGTERM(t *testing.T) {
	p := startRelay(t)

	conn, err := net.Dial("tcp", p.addr)
	if err != nil {
		t.Fatalf("dial relay: %v", err)
	}
	t.Cleanup(func() { _ = conn.Close() })
	if err := conn.SetDeadline(time.Now().Add(ioBudget)); err != nil {
		t.Fatalf("set deadline: %v", err)
	}

	body := []byte(`{"recipient_mailbox_id":"drain-probe","device_id":"drain-probe","signature":"drain-probe"}`)
	head := "POST /v1/mailbox/challenge HTTP/1.1\r\n" +
		"Host: " + p.addr + "\r\n" +
		"Content-Type: application/json\r\n" +
		fmt.Sprintf("Content-Length: %d\r\n", len(body)) +
		"Expect: 100-continue\r\n" +
		"Connection: close\r\n\r\n"
	if _, err := io.WriteString(conn, head); err != nil {
		t.Fatalf("write request head: %v", err)
	}

	// Observable event: the handler has begun serving this request.
	br := bufio.NewReader(conn)
	interim, err := br.ReadString('\n')
	if err != nil {
		t.Fatalf("reading the interim response failed: %v (relay never began serving the request, "+
			"so nothing was in flight to drain); stderr:\n%s", err, p.stderrText())
	}
	if !strings.Contains(interim, "100") {
		t.Fatalf("expected an interim %q response before the body, got %q", "100 Continue", strings.TrimSpace(interim))
	}
	if _, err := br.ReadString('\n'); err != nil { // the blank line ending the interim response
		t.Fatalf("reading the interim response terminator: %v", err)
	}

	// The request is now provably in flight. Signal.
	p.signal(t, syscall.SIGTERM)

	// The listener must stop accepting. This is checked while the in-flight
	// request is still held open, so it is a statement about the shutdown
	// sequence and not merely about a dead process.
	if !dialRefusedWithin(p.addr, shutdownBudget) {
		t.Fatalf("relay still accepted a new connection on %s more than %s after SIGTERM; "+
			"a shutting-down relay must close its listener. stderr:\n%s", p.addr, shutdownBudget, p.stderrText())
	}

	// Finish the in-flight request. Both the write and the read must survive.
	if _, err := conn.Write(body); err != nil {
		t.Fatalf("the in-flight request was cut by SIGTERM: writing its body failed: %v; "+
			"an already-accepted request must be allowed to complete. stderr:\n%s", err, p.stderrText())
	}
	resp, err := http.ReadResponse(br, nil)
	if err != nil {
		t.Fatalf("the in-flight request was cut by SIGTERM: no response was read back: %v; "+
			"an already-accepted request must be allowed to complete. stderr:\n%s", err, p.stderrText())
	}
	defer func() { _ = resp.Body.Close() }()
	if _, err := io.ReadAll(resp.Body); err != nil {
		t.Fatalf("the in-flight response was truncated by SIGTERM: %v; status was %s. stderr:\n%s",
			err, resp.Status, p.stderrText())
	}

	// Reap, so the temporary data directory can be removed. The exit status is
	// this test's neighbour's assertion, not this one's.
	if _, ok := p.wait(shutdownBudget); !ok {
		t.Fatalf("relay did not exit within %s of SIGTERM; stderr:\n%s", shutdownBudget, p.stderrText())
	}
}

// TestRelayClosesStorageCleanlyOnSIGTERM pins that Badger is closed rather than
// abandoned, so the next start is an ordinary open and not a value-log replay.
//
// The observable is Badger's own on-disk footprint. While the database is open
// it holds a memtable write-ahead log (`NNNNN.mem`) and a `LOCK` file; a clean
// Close flushes the memtable into an SST, deletes the .mem file and releases
// the directory lock. A `.mem` file left behind is exactly the state that makes
// the next Open replay it. The precondition below asserts those files are
// present while the relay runs, so the post-condition cannot pass vacuously.
//
// This test deliberately does not assert the exit status - that is
// TestRelayExitsZeroOnSIGTERM's job - so that a failure here can only mean the
// store was not closed.
func TestRelayClosesStorageCleanlyOnSIGTERM(t *testing.T) {
	p := startRelay(t)

	if mems := memtableWALs(t, p.dataDir); len(mems) == 0 {
		t.Fatalf("precondition failed: no *.mem file in %s while the relay is running, so this "+
			"test could not distinguish a clean close from an abandoned one", p.dataDir)
	}
	if _, err := os.Stat(filepath.Join(p.dataDir, "LOCK")); err != nil {
		t.Fatalf("precondition failed: no LOCK file in %s while the relay is running: %v", p.dataDir, err)
	}

	p.signal(t, syscall.SIGTERM)
	if _, ok := p.wait(shutdownBudget); !ok {
		t.Fatalf("relay did not exit within %s of SIGTERM; stderr:\n%s", shutdownBudget, p.stderrText())
	}

	if mems := memtableWALs(t, p.dataDir); len(mems) > 0 {
		t.Fatalf("storage was not closed cleanly on SIGTERM: memtable write-ahead log(s) %v remain in %s. "+
			"A clean badger.Close flushes and deletes them; leaving them turns every ordinary stop into a "+
			"value-log replay on the next start. stderr:\n%s", mems, p.dataDir, p.stderrText())
	}
	if _, err := os.Stat(filepath.Join(p.dataDir, "LOCK")); err == nil {
		t.Fatalf("storage was not closed cleanly on SIGTERM: %s still holds a LOCK file, so the "+
			"directory lock was never released. stderr:\n%s", p.dataDir, p.stderrText())
	} else if !os.IsNotExist(err) {
		t.Fatalf("stat LOCK: %v", err)
	}
}

// --- harness -------------------------------------------------------------

// relayProcess is a running relay binary plus everything needed to observe it.
type relayProcess struct {
	cmd     *exec.Cmd
	addr    string
	dataDir string
	stderr  *lockedBuffer
	done    chan struct{}
}

// startRelay builds cmd/relay into a temporary directory, starts it on a
// reserved loopback port with an empty temporary data directory, and returns
// once /health has answered.
func startRelay(t *testing.T) *relayProcess {
	t.Helper()

	bin := buildRelay(t)
	addr := reserveLoopbackAddr(t)
	dataDir := filepath.Join(t.TempDir(), "relay-data")
	if err := os.MkdirAll(dataDir, 0o750); err != nil {
		t.Fatalf("create data dir: %v", err)
	}

	cmd := exec.Command(bin)
	// An explicit environment, not the developer's: any ECHOLET_* variable set
	// in the shell running the suite would otherwise change what is under test.
	cmd.Env = []string{
		"PATH=" + os.Getenv("PATH"),
		"HOME=" + os.Getenv("HOME"),
		"TMPDIR=" + os.TempDir(),
		"ECHOLET_HTTP_ADDR=" + addr,
		"ECHOLET_DATA_DIR=" + dataDir,
		"ECHOLET_LOG_LEVEL=info",
	}
	stderr := &lockedBuffer{}
	cmd.Stderr = stderr
	cmd.Stdout = stderr

	if err := cmd.Start(); err != nil {
		t.Fatalf("start relay binary: %v", err)
	}

	p := &relayProcess{cmd: cmd, addr: addr, dataDir: dataDir, stderr: stderr, done: make(chan struct{})}
	go func() {
		_ = cmd.Wait()
		close(p.done)
	}()
	t.Cleanup(func() {
		select {
		case <-p.done:
			return
		default:
		}
		_ = cmd.Process.Kill()
		<-p.done
	})

	p.waitReady(t)
	return p
}

// waitReady blocks until /health answers 200, the process dies, or the startup
// budget expires. The readiness signal is the answer itself, not a delay: the
// binary logs "Starting relay server" before it binds, so the log line alone
// would not prove the port is open.
func (p *relayProcess) waitReady(t *testing.T) {
	t.Helper()

	client := &http.Client{Timeout: 2 * time.Second}
	deadline := time.Now().Add(startupBudget)
	for time.Now().Before(deadline) {
		select {
		case <-p.done:
			t.Fatalf("relay exited before it was ready (%s); output:\n%s", p.cmd.ProcessState, p.stderrText())
		default:
		}
		resp, err := client.Get("http://" + p.addr + "/health")
		if err == nil {
			_, _ = io.Copy(io.Discard, resp.Body)
			_ = resp.Body.Close()
			if resp.StatusCode == http.StatusOK {
				return
			}
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("relay did not answer /health on %s within %s; output:\n%s", p.addr, startupBudget, p.stderrText())
}

func (p *relayProcess) signal(t *testing.T, sig syscall.Signal) {
	t.Helper()
	if err := p.cmd.Process.Signal(sig); err != nil {
		t.Fatalf("send %v: %v", sig, err)
	}
}

// wait reports the process state once the process has exited, or ok=false if it
// is still running after d.
func (p *relayProcess) wait(d time.Duration) (*os.ProcessState, bool) {
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case <-p.done:
		return p.cmd.ProcessState, true
	case <-timer.C:
		return nil, false
	}
}

func (p *relayProcess) stderrText() string { return p.stderr.String() }

// buildRelay compiles cmd/relay into the test's own temporary directory. It is
// never written into the repository tree.
func buildRelay(t *testing.T) string {
	t.Helper()

	goBin, err := exec.LookPath("go")
	if err != nil {
		t.Fatalf("the Go toolchain is required to build the relay binary under test: %v", err)
	}
	moduleRoot, err := filepath.Abs(filepath.Join("..", ".."))
	if err != nil {
		t.Fatalf("resolve module root: %v", err)
	}
	out := filepath.Join(t.TempDir(), "relay-under-test")

	build := exec.Command(goBin, "build", "-o", out, "./cmd/relay")
	build.Dir = moduleRoot
	build.Env = os.Environ()
	if combined, err := build.CombinedOutput(); err != nil {
		t.Fatalf("go build ./cmd/relay: %v\n%s", err, combined)
	}
	return out
}

// reserveLoopbackAddr picks a free loopback port by binding and releasing it.
func reserveLoopbackAddr(t *testing.T) string {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("reserve port: %v", err)
	}
	addr := listener.Addr().String()
	if err := listener.Close(); err != nil {
		t.Fatalf("release reserved port: %v", err)
	}
	return addr
}

// dialRefusedWithin reports whether the address stops accepting connections
// within d. Each iteration is a real dial, so this waits on the observable
// event (the listener closing) rather than on elapsed time.
func dialRefusedWithin(addr string, d time.Duration) bool {
	deadline := time.Now().Add(d)
	for {
		conn, err := net.DialTimeout("tcp", addr, time.Second)
		if err != nil {
			return true
		}
		_ = conn.Close()
		if !time.Now().Before(deadline) {
			return false
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// memtableWALs lists Badger's memtable write-ahead logs in a data directory.
func memtableWALs(t *testing.T, dataDir string) []string {
	t.Helper()
	matches, err := filepath.Glob(filepath.Join(dataDir, "*.mem"))
	if err != nil {
		t.Fatalf("glob %s: %v", dataDir, err)
	}
	names := make([]string, 0, len(matches))
	for _, m := range matches {
		names = append(names, filepath.Base(m))
	}
	return names
}

// lockedBuffer collects the child's output. exec copies into it from its own
// goroutine while the test reads it, so the access has to be guarded.
type lockedBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *lockedBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

func (b *lockedBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.String()
}
