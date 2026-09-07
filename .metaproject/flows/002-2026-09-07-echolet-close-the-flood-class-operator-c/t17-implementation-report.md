# T17 — Implementation report: the relay handles SIGTERM and SIGINT

Flow: `002-2026-09-07-echolet-close-the-flood-class-operator-c`
Task: T17 (task-implementer), against the RED set T18 wrote in
`apps/relay/internal/server/process_shutdown_test.go`.

---

## 1. The defect

`apps/relay/cmd/relay/main.go` installed no signal handler. SIGTERM and SIGINT
therefore had their default disposition, which is death by signal, and the
process never ran a line of shutdown code. Three consequences followed, all
observed on the deployed relays:

1. **A normal stop looked like a crash.** `docker stop` reported `Exited (2)`.
   Every supervisor that keys off exit status — `restart: on-failure`,
   `restart: unless-stopped`, a systemd unit, any monitor — read a routine
   operator stop as a failure.
2. **Every stop abandoned Badger.** `st.Close()` was reached only through
   `defer`, and a `defer` does not run when the kernel kills the process. The
   data directory kept its `LOCK` and its memtable write-ahead log (`NNNNN.mem`),
   so the *next* start was a value-log replay — a recovery path exercised on
   every ordinary restart, by accident, and never measured.
3. **In-flight requests were cut**, not drained. A client mid-request saw the
   connection close rather than a response.

Note that `Server.Shutdown` already existed in
`apps/relay/internal/server/server.go` and was already correct. Nothing ever
called it. That is exactly why T18's tests drive the real `cmd/relay` binary as
a child process: an in-process test of a shutdown function would have been green
the whole time while the shipped binary still died badly.

---

## 2. The change

One product file changed: `apps/relay/cmd/relay/main.go`.
SHA-256 `72e9a873d146351ead30914bd17c19171195aa27347423bd2e4cecb382c9e299`.
`gofmt -l` clean, `go vet ./cmd/relay/` exit 0.

`main` became `os.Exit(run())`, and `run() int` carries the sequence. The
`defer st.Close()` is gone — a `defer` and an `os.Exit` in the same function is
precisely the shape that produced defect (2), so every exit path now closes the
store explicitly through one helper, `closeStorage`.

### 2.1 Where the handler is installed, and why there

`signal.Notify` is called **immediately after the logger is configured and
before `storage.NewStorage`** — not after the listener is up.

The reason is defect (2) again, in its worst form. Between `badger.Open` and the
first `/health` answer the data directory is already locked and already has a
memtable write-ahead log in it. If the handler were installed only after the
server was serving, a signal landing in that window — a container stopped
seconds after being started, a supervisor giving up on a slow boot, an operator
who changed their mind — would abandon a directory that had just been opened.
Installing first costs nothing: a signal arriving during startup is buffered on
the channel, and the sequence below picks it up as soon as it reaches the
select, producing a clean immediate shutdown.

### 2.2 The shutdown order

Order is the fix, not an incidental detail:

1. **Stop accepting.** `srv.Shutdown(ctx)` closes the listeners first, before it
   waits for anything. From the moment the signal is handled, a fresh dial is
   refused. (`TestRelayDrainsInFlightRequestOnSIGTERM` checks this *while* an
   in-flight request is still held open, so it is a statement about the sequence
   and not merely about a dead process.)
2. **Drain.** The same call then waits for requests already being served to
   return.
3. **Close storage.** `st.Close()` runs only after the drain has finished, or
   after it has been forced to finish. Closing Badger underneath a running
   handler would be a worse defect than the one being fixed: the handler's write
   would fail against a closing database instead of simply being drained.
4. **Exit 0.** An operator stop is a success.

`<-serveErr` is collected between 3 and 4 only to log an unexpected serve error.
It cannot extend the stop, because `Serve` returns as soon as its listener is
closed and `Shutdown` closes the listener before it waits.

### 2.3 The drain timeout: 5 s

The ceiling is imposed by the deployment, not chosen by taste. `docker stop`
SIGKILLs after a 10 s grace period by default; a relay that needs longer is
killed and reports non-zero for that reason alone, which is the exact symptom
this work removes. The whole sequence — drain, then close Badger — must fit
inside that with room to spare, so the drain gets 5 s and the store close, which
takes tens of milliseconds, gets the rest.

**A handler still running at the deadline does not get to extend it.**
`srv.Shutdown` returns `context.DeadlineExceeded`, `srv.Close()` then closes the
remaining connections, the store is closed cleanly, and the exit status is still
**0**. A client that will not finish in time is not the operator's stop failing,
and a slow client must not be able to make the relay look like it crashed.

Measured (see §5): signal → exit is 5.05 s wall in the timeout path, half the
Docker grace period.

### 2.4 A second signal

The channel is buffered at 2 so a second signal is **observable rather than
dropped**. A second SIGTERM/SIGINT arriving during the drain means an operator
saying "stop waiting", so it:

- abandons the *drain* — `srv.Close()` closes the remaining connections at once;
- does **not** abandon the *store* — the in-flight `Shutdown` result is still
  collected (`<-drained`) before anything is closed, so the store is never
  closed while `Shutdown` is running, and the sequence continues into the same
  clean `st.Close()` and the same exit 0.

**Every later signal is dropped on purpose.** Past that point there is nothing
left to wait for, and interrupting the store close is exactly the damage this
task exists to prevent. The relay is deliberately un-SIGTERM-able for the tens
of milliseconds Badger takes to flush; SIGKILL still works, and Docker's grace
period is 200× longer than that window.

Measured (see §5): second signal → exit is 0.05 s, store clean.

### 2.5 Exit statuses

| Path | Status |
|---|---|
| SIGTERM / SIGINT, drain completes | 0 |
| SIGTERM / SIGINT, drain deadline exceeded | 0 |
| SIGTERM / SIGINT, second signal escalates | 0 |
| Serve returns on its own with a real error (e.g. port in use) | 1 |
| Config load, storage open, or `server.New` fails | 1 |
| **`st.Close()` fails on any path** | **1** |

The last row is a deliberate choice. An unflushed memtable is the durability
problem this whole path exists to prevent; exiting 0 after one would hide it
from the very supervisor the exit status is for. A failing Badger close is not a
normal stop.

### 2.6 Logging

Only operational facts are logged: the signal name, the drain timeout, and
whether the drain completed. No store key, no private key, no plaintext and no
HTTP request body appears on any new log line. The pre-existing "Starting relay
server" line still logs certificate **paths** only, unchanged.

---

## 3. What was NOT changed

- **No test file, at all.** `process_shutdown_test.go` is byte-identical to
  T18's recorded digest (§6).
- **`internal/server/server.go` is untouched.** `Shutdown`, `Close`, `Serve` and
  the timeout constants were already correct; the defect was that nothing called
  them.
- **The cleanup service goroutine** (`service.CleanupService.Start`) is still
  not stopped on shutdown. It is left alone deliberately — see residual R-2.
- Nothing was weakened, skipped, narrowed or deleted, and no validation was
  relaxed. The vitest total is unchanged at 293 and every Go package still
  reports `ok`.

---

## 4. Test results

The four T18 tests, `go test ./internal/server/ -v -count=1`:

| Test | Before | After |
|---|---|---|
| `TestRelayExitsZeroOnSIGTERM` | FAIL — `relay exited signal: terminated` | **PASS (1.82 s)** |
| `TestRelayExitsZeroOnSIGINT` | FAIL — killed by signal | **PASS (1.36 s)** |
| `TestRelayDrainsInFlightRequestOnSIGTERM` | FAIL — `no response was read back: unexpected EOF` | **PASS (1.42 s)** |
| `TestRelayClosesStorageCleanlyOnSIGTERM` | FAIL — `*.mem` and `LOCK` remained | **PASS (1.23 s)** |

All four are well inside the 10 s `shutdownBudget`.

---

## 5. Escalation paths, measured

Neither the drain-timeout path nor the second-signal path is covered by T18's
four tests, so both were exercised by hand against a freshly built binary in the
session scratchpad (never in the repository tree), holding a request in flight
with `Expect: 100-continue` and never sending its body:

**Second signal during the drain**

```
interim: HTTP/1.1 100 Continu
alive 0.5s after 1st signal (drain holding): True
sent 2nd signal
exit code: 0   elapsed after escalation: 0.05s
mem files left: []   LOCK left: False
WARN  "Second shutdown signal received; closing connections immediately"
INFO  "Storage closed"
```

**Drain deadline, no second signal**

```
alive 0.5s after 1st signal (drain holding): True
exit code: 0   elapsed: 4.51s after the 0.5s hold  (5.05s from the signal)
mem files left: []   LOCK left: False
WARN  "Drain did not complete; closing remaining connections" error="context deadline exceeded"
INFO  "Storage closed"
```

Both end in exit 0 with no `*.mem` and no `LOCK` — the same post-condition
`TestRelayClosesStorageCleanlyOnSIGTERM` asserts for the ordinary path.

---

## 6. Test-file identity

`apps/relay/internal/server/process_shutdown_test.go`
SHA-256 `c38372f5ff4a983d6ad39799dfda28e36e5d9e8625131094222bc5eb08329155`

Identical to T18's recorded value. Measured by digest, not mtime, after every
edit in this task.

---

## 7. Full matrix

Node v26.5.0 (default non-login interpreter). All runs local; neither `geekom`
nor `depr` was contacted.

| Run | Exit | Result |
|---|---|---|
| `pnpm typecheck` | 0 | 7 projects Done |
| `pnpm test` | 0 | 50 files, **293 tests, 293 passed, 0 failed** (protocol 12, client-db 1, crypto-core 20, client-core 2, session-node 24, mobile 6, cli 228) |
| `pnpm --filter @echolet/cli test:e2e` | 0 | 1 file, **3/3 passed**, 16.9 s |
| `go test ./... -count=1` | 0 | 8 packages `ok`, 8 no-test, 0 FAIL |
| `go test ./... -count=1 -race` | 0 | 8 `ok`, 0 FAIL, **0 DATA RACE** |
| `go test ./... -count=1 -race -tags relayv2` | 0 | 8 `ok`, 0 FAIL, **0 DATA RACE** |
| `go vet ./cmd/relay/` | 0 | clean |
| `gofmt -l apps/relay/cmd/relay/` | 0 | clean |

`pnpm test:e2e` does not exist at the workspace root — the script lives in
`apps/cli/package.json` and was run there. That is a naming detail of the repo,
not a gap in the matrix.

---

## 8. Residuals

**R-1 — A handler that outlives the forced close is not waited for.**
When the drain deadline expires (or a second signal escalates), `srv.Close()`
closes the connections, but `net/http` offers no API that waits for handler
*goroutines* beyond `Shutdown` itself. A handler stuck past the deadline can
therefore still be executing a few instructions while `st.Close()` runs. It
cannot corrupt anything — Badger returns `ErrDBClosed`/`ErrBlockedWrites` to a
write against a closing database rather than damaging it — and the window is
only ever reached by an explicit escalation or a client that ignored a 5 s
drain. Fixing it properly would need the relay to track its own in-flight
handler count, which is a larger change than this defect warrants.

**R-2 — The cleanup service goroutine is never stopped.**
`service.CleanupService.Start()` spawns a `time.Ticker` goroutine that is not
cancellable and is not part of the shutdown sequence. It is harmless *today*
only because `runCleanup()` is a documented no-op that touches no storage — the
comment says Badger's built-in TTL is sufficient for the MVP. **If that function
is ever given real work, it must be shut down before `st.Close()`**, or it
reintroduces exactly the "write against a closing store" hazard that §2.2 step 3
exists to prevent. Stopping it now would mean giving `NewRouter` a lifecycle it
does not currently have, which is out of this task's scope; flagged so the next
person to touch `runCleanup` sees it.

**R-3 — No test covers the drain timeout or the second signal.**
Both were verified by hand (§5) and are described in the code's comments, but
T18's suite pins neither, so a regression in either escalation path would be
silent. Both are testable with the same harness: hold an `Expect: 100-continue`
request open and either wait past 5 s or send a second signal.

**R-4 — `pnpm test:e2e` has no root script.** Pre-existing; noted only so a
verifier does not read the root failure as a regression from this task.

**R-5 — `gofmt -l apps/relay` still reports three pre-existing unformatted
files** (`internal/api/handler/mailbox_read_mark_test.go`,
`internal/api/handler/signal_prekey_bundle_v2.go`,
`internal/storage/repository/signal_prekey_bundle_v2.go`), carried over from
T16-F-003. The file this task changed is not among them.

**R-6 — The drain timeout is a compile-time constant, not configuration.**
5 s is right for Docker's 10 s default grace period. An operator running with
`--time` raised or a systemd unit with a 90 s `TimeoutStopSec` cannot lengthen
it without a rebuild. Making it an `ECHOLET_*` variable would be a config-surface
change T18's spec did not ask for; the constant carries the reasoning in a
comment so the next person changing it knows what bounds it.

---

## Routing audit

- `graph_used`: no — the change is one known entry point (`cmd/relay/main.go`)
  named directly by the RED set; no blast-radius question arose.
- `wiki_used`: no — not-relevant. The task is process signal disposition, not
  domain behaviour or a business rule.
- `ctx_used`: yes — `keryx ctx rg` for every search, `keryx ctx run` for every
  build, test and matrix command, `keryx ctx read` for schema and file reads.
- `raw_rg_used`: no.
