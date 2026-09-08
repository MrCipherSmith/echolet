# T28 — Second documentation reconciliation, repoint `test:e2e`, remove the cleanup knob

Flow 003, task T28. Tree: HEAD `c5fde09`. Machine: macOS arm64, `node` v26.5.0
(`/opt/homebrew/bin/node`, the default non-login interpreter), pnpm 10.0.0.
Reads first: `t25-verification-report.md` (findings V-002, V-003, V-004) and
`t7-reconciliation-report.md` (the first documentation pass, and why a second
was needed — done at `4346e2b`, six behaviour-changing commits later).

**Scope honoured.** Only documentation, `apps/cli/package.json`'s scripts,
`deploy/relay/**` and the three env examples were changed. No test and no
Go or TypeScript source was touched. Two files already carried modifications
from an earlier, paused attempt at this same task (see §0); they were reviewed
and verified rather than assumed correct, then completed. Two files
(`apps/cli/src/commands/cli.test.ts`, `apps/cli/test/e2e/publication-claimability.test.ts`)
and the flow's own `flow.json`/`journal.md` were left untouched — the first two
belong to the two concurrent test-writing agents named in the dispatch and are
outside this task's file set; the flow files are the tracker's own.

---

## 0. Resuming an interrupted attempt

`git status` at the start of this session showed seven files already modified
(`apps/cli/package.json`, both compose files, `run-relay.sh`, all three env
examples) plus a partial edit of the requirements `README.md`. The flow's
`journal.md` records `T28: started (attempt 1) — 003-T28-docs (re-dispatch
after pause)` and `PAUSED.md` says T27 and T28 "were dispatched and stopped;
both need re-dispatching from scratch" — so this is the same attempt's own
earlier work, left on disk when its process ended before writing a report.
Every factual claim already present in that partial work was re-verified
against the tree exactly as if it were unfamiliar (§2), rather than trusted
because it looked finished; nothing was reverted.

---

## 1. V-004 — `test:e2e` repointed, not renamed

**Decision honoured as given.** `apps/cli/package.json`:

```diff
- "test:e2e": "vitest run test/e2e/two-process.test.ts"
+ "test:e2e": "vitest run test/e2e"
```

`apps/cli/vitest.config.ts` sets no `include`, so `vitest run test/e2e` collects
every file under that directory with no exclusion needed — the same six files
the plain `test` script already reached. No file had to be left out of the
repoint.

**Measured twice on `c5fde09`**, through `keryx ctx run`:

| Run | Files | Tests | Result | Vitest-internal duration | Real wall-clock |
|---|---|---|---|---|---|
| 1 | 6 | 29 | **1 failed, 28 passed** | 208.6 s | `3m29.961s` |
| 2 | 6 | 29 | **29 passed** | 291.5 s | `4m52.611s` |

The single failure in run 1 was in `flood-closure.test.ts`, scenario "closure
and cost at '4 identities x 49 maximum-size poison…'": `poll exit codes
[3,3,3,3]`, the same T52-F-001 wedge language already recorded as an open,
documented bound elsewhere in this repository. It did **not** reproduce on run
2 with byte-identical code — the two runs used the same `git rev-parse HEAD`
(`c5fde09`) and the same script. Two concurrent agents were writing tests
during this session (`git diff --stat` at the end shows uncommitted edits to
`apps/cli/src/commands/cli.test.ts` and
`apps/cli/test/e2e/publication-claimability.test.ts` that this task did not
make), so CPU/IO contention from that concurrent work is the most likely cause;
it is recorded here for honesty, not attributed to the repoint, and not
reported as a regression this task introduced — per the dispatch's own
instruction to ignore the concurrent agents' files and not report their
failures as mine. No file "could not run in that context": all six ran to
completion both times.

**No file was excluded.** The wall-clock figure quoted in every corrected
document is the clean run: **291.5 s vitest-internal / `4m52.611s` real**, with
the flaky first run disclosed alongside it rather than discarded silently.

Documents corrected to quote the new script behaviour and the measured cost:
`docs/STATUS_CURRENT.md` (the T55 bullet, and the dedicated `test:e2e` section
rewritten in full), `docs/requirements/echolet-cli-prototype/README.md`
(the "What `test:e2e` actually runs" paragraph),
`metrics-and-validation.md` (the fourth gate command's explanation), and
`specification.md` (the implementation-state table cell). The
`c302485`-dated historical matrix sentence in `STATUS_CURRENT.md`'s flow-002
section was **left alone** — it is an explicitly dated measurement of a past
tree, the same category T7 chose not to rewrite, and rewriting it would make it
report something that was not true when it was taken.

---

## 2. V-003 — reconciled against the current tree, each claim verified first

Every deletion below was re-established against `c5fde09` before being made —
by reading the source at the named line, or by reading the test that pins it.

### 2.1 `STATUS_CURRENT.md` limitation 3 — the poll byte budget

**Was:** "`ECHOLET_MAX_MESSAGE_BYTES`-независимый бюджет байт на poll; при 2 MiB
relay вернул почти вдвое больше, чем клиент примет."

**Evidence it is stale.** `mailbox_handler.go:70`:
`const clientPollResponseBound int64 = 4 * protocol.MaxMessageBytes`, and
`config.go:109-114`: `config.Validate()` refuses to start if
`ECHOLET_MAX_MESSAGE_BYTES > protocol.MaxMessageBytes`. A 2 MiB configuration —
the exact configuration the deleted claim was measured against — can no longer
start at all; the relationship is now derived from one protocol constant on
both sides. Landed in `5235a6d`. Pin:
`TestPollResponseBoundsAreDerivedFromTheProtocolMaximum`,
`TestValidateRefusesAMaxMessageBytesTheRelayCannotDeliver`.

**Change.** Struck through and replaced with the evidence above, not deleted
outright — the reader can see what was claimed and why it no longer holds,
matching the first pass's practice of naming the tree evidence at every
deletion.

### 2.2 `STATUS_CURRENT.md` limitation 4 — backfill resilience

**Was:** "`BackfillDeviceMailboxBindings` is the sole `device_mailbox` writer
with no bounded conflict retry, and one undecodable record aborts the whole
scan (measured: 0 of 2 healthy records bound after one corrupt one)."

**Evidence it is stale.** `device_record_repo.go:136-191`:
`BackfillDeviceMailboxBindings` now counts and skips an undecodable record
(`skipped++`, a single warning with the count at the end) instead of returning
an error that aborts the scan; a decode failure in one record no longer
prevents any other record from being bound. `:201-212`:
`saveDeviceMailboxBindingWithRetry` retries each write up to
`deviceRecordConflictRetries` times on `badger.ErrConflict` — the same bounded
retry `Save` already used elsewhere. Landed in `18afa36`. Pin:
`TestBackfillSkipsUndecodableRecordAndBindsTheHealthyOnes`,
`TestBackfillReportsTheNumberOfSkippedRecords`,
`TestPreBindingIdentityStillAuthorizesWhenAnotherDeviceRecordIsUndecodable`.

**What was kept, deliberately.** The clause that startup-scan cost was never
measured by a verifier is still true and still open; it was not claimed away.

### 2.3 `STATUS_CURRENT.md` limitation 10 — the `CleanupService` ticker

**Was:** the ticker "starts in `Start()` with no stop channel and is not part
of the shutdown sequence — harmless today only because the body is empty," and
`internal/service` "has no test files."

**Evidence it is stale.** `cleanup_service.go:29-104`: `Start()` now creates
`stop`/`stopped` channels under a mutex; `Stop()` closes `stop` and blocks on
`<-stopped`, so "stopped" means the goroutine has actually returned, not merely
that it was asked to. `cmd/relay/main.go:178`,
`stopBackgroundWorkAndCloseStorage`: `r.Stop()` runs on every path that closes
the store, including both startup-failure paths. `internal/service` now holds
`cleanup_service_stop_test.go` (committed; distinct from the untracked,
in-flight `cleanup_service_stop_join_test.go` from one of the two concurrent
test agents, which was not read or relied on). Landed in `18afa36`. Pin:
`TestCleanupServiceStopEndsItsTickerGoroutine`,
`TestRelayStopsTheCleanupServiceBeforeClosingStorage`.

**What stays true and stays open.** `runCleanup()` is still exactly two
`slog.Debug` calls (`cleanup_service.go:106-111`); `mailboxRepo`,
`challengeRepo` and `mailboxTTL` are still stored and never read. This is the
V-002 gap, handled next.

### 2.4 The renewal-timer claim, and the adjacent `geekom` claim it sat beside

**Was (three documents):** "`depr`'s certificate-renewal timer is not
installed," sitting in the same paragraph or bullet as "`geekom` is still on
loopback plain HTTP" in `STATUS_CURRENT.md` and the requirements `README.md`.

**Evidence it is stale, read myself rather than taken from the dispatch.**
[`t14-renewal-report.md`](t14-renewal-report.md): a root-scope `systemd` timer
built from the repository's own committed `deploy/relay/systemd/*` units,
unmodified, enabled and active on `depr`, its service run three times end to
end with `status=0/SUCCESS` each time and zero Let's Encrypt requests (serial
unchanged). Independently re-confirmed here with a single read-only
`GET /health` to `https://depr.tail5a88fb.ts.net:8443` (`200`,
`ssl_verify_result=0`) — nothing else was sent to either host.

`docs/requirements/echolet-cli-prototype/deployment-runbook.md` had **already**
been corrected for this (its header now reads "Both relays serve TLS, both
certificates renew themselves"), most likely by T14 itself, which listed that
file in its own scope. Checked directly: no stale "not installed" phrasing
remains anywhere in that file. **No change was needed there** — the dispatch's
own instruction to verify before changing cuts both ways, and this is the case
where nothing was in fact stale.

`STATUS_CURRENT.md` and the requirements `README.md` were **not** yet
corrected, and the stale renewal-timer claim in both sat in the same
paragraph/bullet as an equally stale "`geekom` is on loopback" claim — fixing
one and leaving the other would have produced a paragraph that contradicted
itself mid-sentence. [`t11-geekom-tls-report.md`](../002-2026-09-07-echolet-close-the-flood-class-operator-c/t11-geekom-tls-report.md)
establishes that `geekom` switched to HTTPS on its tailnet address on
2026-09-07 (same day, after `depr`), with its own `systemctl --user` renewal
timer (root is unavailable to that host's operator). Independently
re-confirmed here with a read-only `GET /health` to
`https://geekom.tail5a88fb.ts.net:8443` (`200`, `ssl_verify_result=0`) — the
same single-request check as `depr`, nothing else sent. Both documents were
corrected together: the renewal-timer clause, the `geekom`-loopback clause, the
AC7 framing, the "what remains open" list, and the near-term gates item that
named both. This is one step wider than the four claims the dispatch listed by
name, but it is the same category of staleness (a post-`4346e2b` fact the
prior pass never saw) sitting in text this task was already correcting — see
§4 for why it was not left half-fixed.

---

## 3. V-002 — the cleanup-interval knob removed from every operator-facing file

**Decision honoured as given: removed, not implemented behind.**

`ECHOLET_CLEANUP_INTERVAL_SECONDS` is gone from all six files it appeared in,
each replaced with a comment stating that retention is Badger's own TTL and
needs no interval:

- `deploy/relay/docker-compose.yml`
- `deploy/relay/docker-compose.insecure-loopback.yml`
- `deploy/relay/run-relay.sh`
- `deploy/relay/env/depr.env.example`
- `deploy/relay/env/geekom.env.example`
- `deploy/relay/env/insecure-loopback.env.example`

`docs/OPS-23_LOCAL_ENV_VARS.md`'s entry for the variable was rewritten from a
"here is the setting, and here is why it does nothing" shape to "this setting
was removed, and here is why," and the line was dropped from its `.env.local`
example. `docs/STATUS_CURRENT.md` limitation 10 and the requirements
`README.md`'s equivalent bullet were corrected the same way (§2.3).
`deployment-runbook.md`'s open-limitations bullet was rewritten from "bounds
nothing" to "removed as a knob, here is why."

**What was verified before removing anything.** `runCleanup()`
(`cleanup_service.go:106-111`) is confirmed still an empty body — two
`slog.Debug` calls, nothing else — so removing the knob does not hide a real
effect. The stoppable-ticker half (§2.3) is unrelated to the knob and was left
exactly as `18afa36` built it: only the configuration surface was touched, not
the service or its `Stop()`.

**Go source, not touched, and exactly what would be required.**
`apps/relay/internal/config/config.go:58`:
`CleanupIntervalSec int \`env:"ECHOLET_CLEANUP_INTERVAL_SECONDS" envDefault:"60"\``
is unchanged. Removing the field itself — so that an operator who sets the
variable anyway gets no effect from it rather than a silently-accepted one, and
so the relay's own startup log line stops naming an interval nobody is meant to
set — is a Go change to `internal/config` (and the `router.go`/
`NewCleanupService` call site that reads it), and per the dispatch's own
instruction that is reported here and left undone rather than attempted:
**it needs its own task with tests**, because it is a product change to what
the relay accepts, not a documentation change. Every corrected document says
this plainly rather than implying the variable is gone from the binary.

**Deployment impact, stated rather than assumed.** Removing the variable from
the *committed example* files changes nothing for a host whose live `.env`
file already omits it or whose deployed relay is already running — the Go
default (`envDefault:"60"`) applies exactly as it did before, because
`CleanupIntervalSec` was never read for anything but the harmless ticker
interval. `geekom` and `depr` were not touched, redeployed, or their live env
files edited by this task; whether a future redeployment on either host copies
the new example files verbatim is an operator decision this task does not
make. If either host's own (uncommitted, per-host) `.env` file still sets the
variable, it will keep being read by the unchanged Go binary and will keep
having no effect beyond the interval of two debug log lines — the same
behaviour as before this task, not a new one.

---

## 4. Why the `geekom`/AC7 correction, beyond the four named claims

The dispatch named four specific stale assertions under V-003. Independently
verifying the `depr` renewal-timer claim (item 4) meant reading the paragraph
it lives in, in both `STATUS_CURRENT.md` and the requirements `README.md`; in
both documents that paragraph also asserted `geekom` was still on loopback
plain HTTP, which `t11-geekom-tls-report.md` shows was already false at the
time T7 ran (that report's source tree, `da24daa`, is a T7-reconciliation
commit itself — the fact was already stale the day T7's own commit landed, for
a fact T7 never checked because it was not part of the AC4 record T7 mined).
Correcting the timer half of a paragraph while leaving the loopback half wrong
would have produced a sentence that was true in its first clause and false in
its second, in a document this task was already editing for exactly that
category of defect. `PAUSED.md`, part of the same flow package, states both
facts as settled ("Both relays are live... renewal automated on both") and was
not written by this task, so this is not a case of manufacturing a claim to
justify an edit — it is the same "reconcile against the current tree, verify
each claim" instruction applied to the sentence sitting immediately next to
the one named. Both facts were re-verified directly in this task (§2.4) rather
than taken from `PAUSED.md`'s word.

---

## 5. Files changed

| file | what changed |
|---|---|
| `apps/cli/package.json` | `test:e2e` repointed from one file to the whole `test/e2e` directory (V-004). |
| `deploy/relay/docker-compose.yml` | Removed `ECHOLET_CLEANUP_INTERVAL_SECONDS`; added a comment stating retention is the store's TTL (V-002). |
| `deploy/relay/docker-compose.insecure-loopback.yml` | Same. |
| `deploy/relay/run-relay.sh` | Same — the `-e "ECHOLET_CLEANUP_INTERVAL_SECONDS=..."` line removed, replaced with a comment. |
| `deploy/relay/env/depr.env.example` | Same. |
| `deploy/relay/env/geekom.env.example` | Same. |
| `deploy/relay/env/insecure-loopback.env.example` | Same. |
| `docs/OPS-23_LOCAL_ENV_VARS.md` | The `ECHOLET_CLEANUP_INTERVAL_SECONDS` entry rewritten to state removal and why; dropped from the `.env.local` example (V-002). |
| `docs/STATUS_CURRENT.md` | Corrected limitations 3, 4, 10, 11; the AC4/`geekom`/renewal section; every `test:e2e` mention and the dedicated section on it; near-term gate 5; added a note on the point-in-time nature of this pass (V-002, V-003, V-004). |
| `docs/requirements/echolet-cli-prototype/README.md` | Corrected the `test:e2e` paragraph with the measured wall-clock; verified and refined the `geekom`/renewal AC4 section already partly drafted; fixed a `docker-compose.yml` line reference. Version 0.2.2 → 0.2.3. |
| `docs/requirements/echolet-cli-prototype/deployment-runbook.md` | Rewrote the cleanup-knob limitation bullet from "bounds nothing" to "removed, and why" (V-002). The renewal-timer/`geekom` claims here needed no change — already correct. Version 0.5.0 → 0.5.1. |
| `docs/requirements/echolet-cli-prototype/metrics-and-validation.md` | Rewrote the fourth gate command's explanation for the repointed script, with the measured file/test counts and wall-clock (V-004). Version 0.1.2 → 0.1.3. |
| `docs/requirements/echolet-cli-prototype/specification.md` | Corrected the e2e implementation-state cell for the repointed script (V-004). Version 0.1.1 → 0.1.2. |

Not changed, and why: `apps/relay/internal/config/config.go` (would remove the
knob's binding in Go — reported in §3, left for a task with tests);
`apps/cli/src/commands/cli.test.ts` and
`apps/cli/test/e2e/publication-claimability.test.ts` (uncommitted edits from
the two concurrent test-writing agents; not read for content, not touched);
`.metaproject/flows/003-.../flow.json` and `journal.md` (the flow tracker's
own state).

---

## 6. What would actually prevent this a third time

This is the second time documentation was reconciled mid-wave and stale again
by the wave's end — T7 at `4346e2b`, six behaviour-changing commits later;
now at `c5fde09`, with `geekom`'s TLS switch alone going stale in
`STATUS_CURRENT.md` and the requirements `README.md` on the very day T7's own
commit landed. A third manual pass is not a fix; it is the same failure mode
with a higher number. Two things are true about both staleness events that
matter for what would actually prevent a third:

1. **Every stale claim so far was a plain-text assertion with no link back to
   the commit or state that could invalidate it.** "The ticker is not part of
   the shutdown sequence" and "geekom is on loopback" are both sentences a
   human (or an agent) has to remember to re-check; nothing fails if they
   don't.
2. **The repository already has the two pieces a mechanical check needs.**
   `STATUS_CURRENT.md` already carries an explicit pinned revision line
   ("Ревизия, к которой относится этот статус — коммит `X`"), and the flow's
   own push gate is already being hardened in this same flow (T23, T24) to
   distinguish a real test failure from a vacuous one.

**The concrete mechanism:** a documentation-freshness check wired into that
same push gate, not a new manual habit. It would (a) parse the pinned revision
hash out of `STATUS_CURRENT.md`'s header, (b) compute
`git log <pinned>..HEAD -- apps/ packages/` filtered to commits that are not
themselves documentation-only, and (c) fail the push (or at minimum emit a
named, visible warning in the gate's own report) when that set is non-empty —
forcing every commit that changes relay or CLI behaviour to either update the
pinned hash after a reconciliation pass, or be caught at the same gate that
already inspects every push. This turns "the docs are stale" from a fact
someone has to think to go looking for into a fact the existing gate already
reports, the same way it now reports a vacuous test selection instead of a
silent pass. It is a Go/script change to the push-gate tooling under
`.git/hooks` and whatever T23/T24 land as its durable home, not a documentation
change, so it was not built in this task — it is named here, concretely enough
to implement, rather than promised.

---

## 7. Routing audit

- `graph_used`: **no** — *not relevant*. Every target was named by the dispatch,
  by a `file:line` in the T25 report, or by a commit hash; this was reading and
  running those exact files and running two measured commands, not a
  "where does X live" search.
- `wiki_used`: **no** — *not relevant*. Reconciling requirement documents and
  flow reports against the tree; the authoritative sources are the flow
  packages and the code, both read directly. `keryx wiki check-links` was run
  as the dispatch requires (§8).
- `ctx_used`: **yes** — `keryx ctx rg` for every search over project code and
  documentation, `keryx ctx run` for every command (`git`, the two `test:e2e`
  measurement runs, the read-only health checks against `depr`/`geekom`), and
  direct `Read` for files already known by exact path (the two source reports,
  the source files named by the dispatch). Raw logs under
  `.metaproject/data/gdctx/`.
- `raw_rg_used`: **no**. No bare `rg`/`grep` ran over project code at any
  point; two `find` invocations over `.metaproject/flows/` directory listings
  were escaped with `# keryx:raw` and a stated reason (directory listing, not a
  code or text search) before being routed through `keryx ctx run`.

**Redaction.** No store key, private key, plaintext or HTTP request body
appears in this report or in any file it changed. The two read-only HTTPS
health checks against `depr` and `geekom` sent no request body and are the same
class of check T25 and T7 already performed; their IP addresses were redacted
automatically by this session's own output filtering and are not reproduced
here.

## 8. Files written

- This report.
- `dispatches/003-T28-docs-result.json`.
- The thirteen files listed in §5.
- `keryx wiki check-links`: 19 pages, 38 internal links, **0 broken** — run
  after all edits above, confirming this task broke nothing in the wiki.
