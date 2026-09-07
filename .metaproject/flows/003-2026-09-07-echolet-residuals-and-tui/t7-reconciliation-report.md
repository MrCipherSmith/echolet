# T7 — Reconciling every document with the tree

Flow 003, task T7. Tree: HEAD `4346e2b`. Machine: macOS arm64, `node` v26.5.0
(`/opt/homebrew/bin/node`, the default non-login interpreter), go1.26.1.

**Scope honoured.** Only documents and one flow journal were changed. No file
under `apps/`, `packages/` or `deploy/` was touched; no test, no `package.json`,
no `flow.json`, no frozen `acceptance-criteria.md`. Neither `geekom` nor `depr`
was contacted: every AC4 statement written here is sourced from
`t11-tls-report.md` and from flow 002's `flow.json` AC4 record, read but never
re-run. No private key, store key, plaintext or request body appears here.

**Method.** Every stale assertion was re-established against the current tree
before it was deleted — by reading the source at the line, by running the test
that pins it, or, in one case, by re-running the mutation experiment in an
out-of-tree copy. Where the inventory's evidence and mine disagree, §5 says so.

---

## 1. Files changed

| file | what changed |
|---|---|
| `docs/requirements/echolet-cli-prototype/deployment-runbook.md` | Deleted both stale clean-shutdown claims (§7.5 and §14) and replaced them with what the relay does. Rewrote the status header, §3.1, §6.5 and §14 for the post-AC4 world: `depr` on TLS, `geekom` still loopback, renewal timer not installed, hot reload unexercised on the host. Added the `docker-compose.yml` finding to §6 and §14, the named-volume note to §12, and the `CleanupService` limitation to §14. Version 0.3.0 → 0.4.0. |
| `docs/STATUS_CURRENT.md` | Dropped two of the four clauses of the test-coverage limitation. Added the clean-shutdown fix to the flow 002 change list. Replaced the "AC4 blocked" paragraph with the AC4 record plus four carried-forward open items. Added a dedicated section on what `test:e2e` actually runs. Added the `CleanupService` and missing-`lint` limitations and a deployment limitation. Updated the revision line and gate 5. |
| `docs/requirements/echolet-cli-prototype/README.md` | Added the clean-shutdown fix to "What changed in flow 002". Added a "What `test:e2e` actually runs" paragraph and removed the bare `test:e2e` **3/3** from the status line. Replaced the "AC4 not established" paragraph. Added the `CleanupService` and missing-`lint` limitations. Version 0.2.0 → 0.2.1. |
| `docs/requirements/echolet-cli-prototype/metrics-and-validation.md` | Explained precisely what the gate's fourth command runs and where the broader e2e coverage comes from; corrected the stale "planned surfaces" sentence; relabelled the "Clean end-to-end runs" metric row; recorded why `pnpm lint` is not in the gate. Version 0.1.1 → 0.1.2. |
| `docs/requirements/echolet-cli-prototype/specification.md` | Named the file and the script behind the "3/3 unfiltered iterations" cell in the implementation-state table. |
| `docs/OPS-23_LOCAL_ENV_VARS.md` | Recorded that `ECHOLET_CLEANUP_INTERVAL_SECONDS` currently bounds nothing, with the reason and where retention actually comes from. |
| `.metaproject/flows/002-.../journal.md` | Appended two dated errata (label, shutdown, AC4). The timestamped `ac-confirmed` lines were **not** rewritten — they mirror `flow.json`, which is out of scope, and rewriting them would desynchronise the two. |

---

## 2. Deletions, and the evidence that made each stale

### 2.1 `deployment-runbook.md` §7.5 — "the relay does not exit cleanly on SIGTERM"

Deleted:

> *One known rough edge: `docker stop` reports `Exited (2)`, not `Exited (0)` —
> the relay does not exit cleanly on SIGTERM.*

**Evidence on this tree.** `apps/relay/cmd/relay/main.go` handles the signal and
documents the ordering at `:104-114`: `srv.Shutdown(ctx)` with a
`drainTimeout` of 5 s (`main.go:32`), `srv.Close()` only if the drain returns an
error or a second signal arrives, then `closeStorage(st, 0)` and `os.Exit(run())`
with 0. A failing store close deliberately returns 1 (`main.go:168-175`).

Run here:

```
=== RUN   TestRelayExitsZeroOnSIGTERM              --- PASS (2.04s)
=== RUN   TestRelayExitsZeroOnSIGINT               --- PASS (1.38s)
=== RUN   TestRelayDrainsInFlightRequestOnSIGTERM  --- PASS (2.78s)
=== RUN   TestRelayClosesStorageCleanlyOnSIGTERM   --- PASS (1.19s)
ok  	echolet/apps/relay/internal/server	7.927s
```

Commit chain: `25bfed3` pinned it, `a2f07bb` fixed it, `85f5d77` recorded it
measured on both hosts (`.State.ExitCode` 2 → 0), `4346e2b` corrected the
phrasing in flow 002's journal **only**.

The replacement text states the behaviour and names `a2f07bb`, so the tree no
longer asserts nothing at all about a behaviour it now guarantees.

### 2.2 `deployment-runbook.md` §14 — the same claim as a limitation

Deleted:

> ***`docker stop` on the relay exits 2, not 0.** The relay does not shut down
> cleanly on SIGTERM.*

Same evidence as §2.1. Replaced in §14 by four bullets that are true: `geekom`
still on loopback, the renewal timer not installed, `docker-compose.yml` unable
to perform the TLS switch, and `ECHOLET_CLEANUP_INTERVAL_SECONDS` binding
nothing.

### 2.3 `STATUS_CURRENT.md` — the cursor-path coverage clause

Deleted: «Курсорный путь `GetEnvelopeBatchFrom` … не имеет теста репозитория с
непустым курсором».

**Evidence.** `apps/relay/internal/storage/repository/mailbox_ordering_test.go`,
`TestCursorResumesStrictlyAfterTheEnvelopesAlreadyDelivered`, calls
`repo.GetEnvelopeBatchFrom(mailboxID, 2, 0, "")` at `:292` and then
`repo.GetEnvelopeBatchFrom(mailboxID, 2, 0, first.NextCursor)` at `:306`, with an
ack between the two pages. That is a non-empty cursor at repository level.

*Residue, deliberately not claimed away:* the narrower property the original
finding worried about — "expiry is skipped before the cursor is consumed" — is
still guarded by a source comment rather than by an assertion. The deleted clause
did not say that, and I did not substitute a new claim for it; it is recorded
here and in the inventory's RI-59 detail.

### 2.4 `STATUS_CURRENT.md` — the byte-budget mutation clause

Deleted: «освобождение бюджета байт для первого конверта переживает удаление».

**Evidence — re-run here, not inherited.** `cp -R apps` into the session
scratchpad with a symlink to the real `packages/`. Control:
`go test ./internal/storage/repository/` → `ok`. Mutant: the guard at
`mailbox_repo.go:463` changed from

```go
if byteBudget > 0 && len(batch.Envelopes) > 0 && usedBytes+encodedBytes > byteBudget {
```

to

```go
if byteBudget > 0 && usedBytes+encodedBytes > byteBudget {
```

Result:

```
--- FAIL: TestGetEnvelopeBatchFiltersExpiredBeforeApplyingBatchLimit (0.06s)
    mailbox_repo_test.go:217: GetEnvelopeBatch(byteBudget=1) returned 0 envelopes (first ""),
    want exactly the valid envelope "ffffffff-ffff-4fff-8fff-ffffffffffff"
FAIL	echolet/apps/relay/internal/storage/repository
```

The mutation is killed. The scratch copy was deleted afterwards; the tree was
never mutated.

### 2.5 Stale items that turned out to need **no** deletion

For each of these I looked for the assertion in the tree's documents and did not
find it. Nothing was deleted, and nothing was invented to delete.

| item | claim | why no edit |
|---|---|---|
| RI-18 | the ack-route lifetime-count oracle is open | Closed in code: `readThroughWithinIssued` runs at `mailbox_handler.go:736` (ack) and `:553` (poll), **after** `VerifyMessageSignature` at `:710` and `:540`; the rationale comment at `:440-464` names T10R3-F-002; `mailbox_ack_read_position_oracle_test.go` exists. `rg -i oracle docs/` → **0 matches**. The only in-repo statements of it are the inventory (which already marks it ALREADY-CLOSED) and flow 003's frozen `acceptance-criteria.md`, which is out of bounds. |
| RI-44 | `parseClientConfig` and `RelayClient` disagree on loopback | Closed: `apps/cli/src/transport/loopback.ts` is the single predicate, imported by `runtime/config.ts:2` and `transport/relayClient.ts:3`, with the reason in the comment at `relayClient.ts:76-80`. The inventory pointed the deletion at `STATUS_CURRENT.md:80` — see §5.1: that line does not carry the claim. |
| RI-43 | `init` accepts a relay URL with a path | Closed: `isRelayOrigin` at `config.ts:38` and the refusal at `:48-50`. The deployment runbook §9 already describes this correctly, in the past tense ("Until finding T10-F-003 `init` accepted a path…"). |
| RI-04 | an attacker chooses its position in the drain walk | Closed by the server-assigned `mailboxseq:<mailbox_id>:<20-digit position>` index (`mailbox_repo.go:546,566,570`). No shipped document asserts the old behaviour. |
| RI-11 | the contact-import re-walk is not crash-safe | Closed: `inbound.ts` peeks (`pendingMailboxRewalk`, `:155`), advances per judged page (`keepMailboxRewalk`, `:205`) and deletes only at the end (`finishMailboxRewalk`, `:202`). `STATUS_CURRENT.md` and the requirements README already state it as crash-safe. |
| RI-50 | source comments say `/v1/messages/send` has no sender authentication | All three surviving sites are already past-tense ("When these tests were written … T51 added it"), and all three are test files, out of this task's scope. `rg -i "no sender authentication" docs/` → 0 matches. |

---

## 3. What was brought to HEAD, and what was reconciled

### 3.1 The clean-shutdown fix (`a2f07bb`) added to both change-lists

`STATUS_CURRENT.md` and the requirements `README.md` both listed four flow 002
changes and stopped before `a2f07bb`. Both now carry a fifth entry stating: no
signal handler before, `Exited (2)`; now listeners closed, in-flight requests
drained for up to 5 s, Badger closed, exit 0, with exit 1 kept deliberately for a
failing store close; pinned by four tests, measured on both hosts as
`.State.ExitCode` 2 → 0.

Both entries also state what the fix does **not** guarantee, because the
inventory established both and neither is closed: nothing tracks handler
goroutines past the drain deadline (RI-29), and neither escalation path — the
deadline expiring, a second signal — has a test (RI-31). Those are stated as
open, not as fixed.

`STATUS_CURRENT.md`'s revision line now reads `4346e2b` with the matrix
attributed to `c302485`, so a reader is not told that a behaviour change was
inside the measured tree when it was not.

### 3.2 AC4

Three documents said AC4 was blocked on the tailnet's HTTPS Certificates toggle.
Mined from `t11-tls-report.md` (§0, §2, §3, §5, §6, §8, §11, §13) and reconciled
in `STATUS_CURRENT.md`, the requirements `README.md` and the deployment runbook
(status header, §3.1, §4, §6, §6.5, §7.5, §12, §14):

- `depr` publishes HTTPS on `100.100.188.64:8443`; the relay process terminates
  TLS (`scheme=https tls_cert_file=/etc/echolet/tls/cert.pem …`).
- `https://depr.tail5a88fb.ts.net:8443/health` → 200, `ssl_verify_result=0`
  against the system trust store, `remote_ip=100.100.188.64`, no `-k` anywhere.
- Certificate `CN=depr.tail5a88fb.ts.net`, issuer Let's Encrypt `YE2`, valid
  `Sep 7 2026 18:35:38 GMT` → `Dec 6 2026 18:35:37 GMT`.
- Plain HTTP to the same port → `HTTP/1.0 400 Bad Request`, from the TLS
  listener.
- The full acceptance scenario ran from a second machine over direct HTTPS with
  no tunnel, forward, proxy or shim.

**Carried forward honestly, in all three documents:**

1. **`geekom` is still on loopback plain HTTP**, awaiting one privileged
   `sudo tailscale cert` only the user can run. One relay of two serves HTTPS, so
   AC7's two-relay deployment stays open.
2. **The certificate-renewal timer is not installed.** The certificate expires
   **6 December 2026** and nothing on the host renews it. §4 of the deployment
   runbook now carries this as a warning immediately above the five commands that
   fix it, and it is repeated in §14, `STATUS_CURRENT.md` and the requirements
   README.
3. **Hot reload on renewal has never been exercised on `depr`** (re-issuing costs
   a Let's Encrypt duplicate-rate slot). Recorded as unproven on the host, with
   the note that an automated test covers the path.
4. **`docker-compose.yml` cannot perform the TLS switch.** Its data mount is
   `"${ECHOLET_HOST_DATA_DIR:?…}:/var/lib/echolet"` and there is no
   `ECHOLET_DATA_VOLUME` branch, so `docker compose config` fails outright for a
   host whose store lives in the named volume `echolet-relay-data`. Verified
   independently by reading `deploy/relay/docker-compose.yml:75`; the failure
   message itself comes from `t11-tls-report.md` §3.2. Only `run-relay.sh` can
   perform that switch, and it is what was used. The compose file was not
   changed.

Care taken with wording: the runbook's §7.5 "does not establish AC4" block is
**kept** — the loopback path still establishes nothing about AC4 — and the new
paragraph says AC4 was established by the TLS path on `depr`, not by that one.
§3.1 is described as satisfied *now*, with an explicit instruction to re-run the
`CertDomains` check rather than trust the paragraph, because it is a tailnet-wide
setting that can be turned off again and `geekom` was never re-checked.

### 3.3 The e2e labelling

Measured here, on `4346e2b`:

```
$ pnpm --filter @echolet/cli test:e2e
> vitest run test/e2e/two-process.test.ts
 ✓ test/e2e/two-process.test.ts (3 tests) 43920ms
 Test Files  1 passed (1)
      Tests  3 passed (3)
```

and, from `npx vitest list`, `apps/cli` collects **39 files**, of which the six
under `test/e2e/` hold **29 tests**: `two-process` 3, `flood-closure` 9,
`init-relay-url` 9, `rewalk-crash-safety` 4, `relay-tls` 3,
`publication-claimability` 1. `apps/cli/vitest.config.ts` declares no `include`,
so vitest's default pattern reaches all six under the plain `test` script — which
is why **no coverage is lost** and the quoted `pnpm test` 293/293 genuinely does
include flood-closure, crash-safety and the TLS end-to-end.

Every document that quoted the figure now names the script, the file(s) and the
count:

- `STATUS_CURRENT.md` — the matrix row, the T55 bullet, the flow 002 matrix
  sentence, and a new section "Что именно измеряет `test:e2e`".
- requirements `README.md` — a new "What `test:e2e` actually runs" paragraph; the
  bare **3/3** removed from the status sentence.
- `metrics-and-validation.md` — a paragraph under the gate's command block, and
  the metric row relabelled "Clean two-process scenario iterations
  (`test/e2e/two-process.test.ts`)".
- `specification.md` — the implementation-state cell now names the file and says
  the other five run under `pnpm test`.
- flow 002's journal — a dated erratum (§4 below).

All five also record that **there is no root `test:e2e` script**, so
`pnpm test:e2e` at the repository root fails as written in the gate.

`package.json` was not touched: renaming or repointing the script is another
task, and every document says which of the two is chosen has not been decided.

### 3.4 Two limitations nobody had recorded

**`CleanupService` is a stub whose interval is presented as meaningful.**
`apps/relay/internal/service/cleanup_service.go`: `runCleanup()` is
`slog.Debug("Running cleanup...")` plus `slog.Debug("Cleanup completed")`;
`mailboxRepo`, `challengeRepo` and `mailboxTTL` are stored by the constructor and
never read; the ticker is created inside `Start()` with no stop channel and is
not part of the shutdown sequence; `internal/service` has no test files.
`ECHOLET_CLEANUP_INTERVAL_SECONDS` is nevertheless set in
`deploy/relay/docker-compose.yml:64`,
`deploy/relay/docker-compose.insecure-loopback.yml:85`,
`deploy/relay/run-relay.sh:194` and all three env examples
(`depr.env.example:61`, `geekom.env.example:64`,
`insecure-loopback.env.example:102`), and documented in `OPS-23:87`. Retention is
Badger's TTL from `ECHOLET_MAILBOX_TTL_HOURS`. Recorded as **open** in
`STATUS_CURRENT.md` (limitation 10), the requirements `README.md`, the deployment
runbook §14 and `OPS-23` itself.

**No package declares a `lint` script.** Run here:

```
> echolet@ lint /Users/…/echolet
> pnpm -r lint
Scope: 7 of 8 workspace projects
None of the selected packages has a "lint" script
```

exit 0. So the lint leg of the quality matrix is vacuous rather than green, and
that is the mechanical cause of the earlier finding that the strict health
adapter cannot execute ESLint — there is no ESLint to execute. Recorded as
**open** in `STATUS_CURRENT.md` (limitation 9), the requirements `README.md`, and
`metrics-and-validation.md` (as the reason `pnpm lint` is absent from the gate).

---

## 4. What was deliberately not rewritten

Flow 002's journal contains timestamped `ac-confirmed` lines that are mirrored in
`flow.json`. `flow.json` is out of scope for this task, and editing only the
journal copy would leave the two disagreeing — a new contradiction in place of an
old one. The historical verification reports (`t37`, `t42`, `t49`,
`t17-implementation-report`) are dated records of what those runs did; `t49`
already writes it precisely ("`test/e2e/two-process.test.ts` **3/3**").

Instead, three dated errata were **appended** to flow 002's journal — the label,
the shutdown claim, and AC4 — in the same free-text style the journal already
uses. Nothing was removed from it.

---

## 5. Where I disagree with the inventory

The inventory is good work and every substantive verdict I checked held. Three
pointers did not.

**5.1 RI-44's deletion target does not exist.** The inventory says to delete "the
loopback-disagreement half of T10R3-F-003" from `docs/STATUS_CURRENT.md:80`. That
line lists the T10 r3 **verifier** findings — `T10R3V-F-001` (process),
`T10R3V-F-002` (untracked binary), `T10R3V-F-003` (the "byte-identical" wording)
and `T10R3V-F-004` (IPv4-mapped loopback refused in the safe direction). The
loopback-predicate disagreement is `T10R3-F-003` (no `V`), and that line does not
mention it. All four items it *does* list are still open (RI-46, RI-48, RI-45 in
the inventory's own table), so nothing there was deleted.

**5.2 "both flow READMEs" do not exist.** §2.6 says the `test:e2e` 3/3 sentence
appears in "`STATUS_CURRENT.md`, the requirements `README.md`, both flow READMEs
and every verification report". Neither flow 001 nor flow 002 has a `README.md`;
only flow 003 does, and it does not quote the figure. The shipped-document set is
`STATUS_CURRENT.md`, the requirements `README.md`, `metrics-and-validation.md`
and `specification.md` — four, not six, plus the historical reports.

**5.3 RI-29's file:line description is slightly out of date.** The row says
`main.go:118-148` is "`Close()` then `closeStorage(st, 0)`". On this tree the
sequence is `srv.Shutdown(ctx)` first, with `srv.Close()` reached only on a drain
error or a second signal. The **substance** of RI-29 is unaffected and I did not
soften it: nothing in the relay counts in-flight handler goroutines, so "no
handler outlives the store" is still an argument rather than a guarantee, and
that is exactly how both change-list entries phrase it.

---

## 6. What is still contradictory and was not resolved here

1. **`apps/cli/package.json`'s `test:e2e` still runs one of six files.** Every
   document now says so precisely, but the script itself is unchanged because
   `package.json` is out of scope for this task. Until it is renamed or
   repointed, the documents carry the correction and the script carries the
   misleading name. AC3 of this flow is therefore served only in its "every
   document quotes it under the corrected name and count" half.
2. **There is no root `test:e2e` script**, so the gate command in
   `metrics-and-validation.md` still cannot be run as bare `pnpm test:e2e`. The
   document now says this; adding the script is another task, and the inventory
   is right that it should not be added before the narrowness is fixed.
3. **`geekom`'s `CertDomains` was never re-checked** after the tailnet toggle was
   enabled. The runbook now says to check rather than assume. Resolving it needs
   host access this task does not have.
4. **The renewal timer is still not installed on `depr`.** Documented in four
   places; fixing it is a host action, not a document change.
5. **Stale prose inside two test files** (`rewalk-crash-safety.test.ts:17,29,238,
   407` and `flood-closure.test.ts:600`) still names `Profile.takeMailboxRewalk()`
   and describes the delete-before-the-walk shape as current. Those are test
   files — out of scope here, and correctly bucketed FIX NOW as RI-47.
6. **`apps/relay/relay`**, the untracked binary matching no commit, is still in
   the tree (RI-48). Deleting it is a tree change, not a document change.
7. **`metrics-and-validation.md`'s "Required measurements" table** still cites
   evidence sources ("CLI E2E report", "Go race test") that name no file. Left
   as found; correcting it is a docpack question, not a contradiction with the
   tree.

---

## 7. Routing audit

- `graph_used`: **no** — *not relevant*. Every target was named by the dispatch
  or by the T1 inventory as an exact `file:line`; there was no "where does X
  live" question for the graph to answer, and no code was navigated structurally.
- `wiki_used`: **partial** — `keryx wiki check-links` was run as required
  (19 pages, 38 internal links, **0 broken**). The wiki's knowledge pages were
  not read: this task reconciles requirement documents and flow journals against
  the tree, and the authoritative sources for that are the flow packages and the
  code, both read directly.
- `ctx_used`: **yes** — `keryx ctx rg` for every search, `keryx ctx run` for
  every command (the Go shutdown tests, `pnpm --filter @echolet/cli test:e2e`,
  `npx vitest list`, `pnpm lint`, `git log`, directory listings) and
  `keryx ctx read` for large raw outputs. Raw logs under
  `.metaproject/data/gdctx/`.
- `raw_rg_used`: **no**. No bare `rg` or `grep` ran over project code at any
  point.

**Mutation experiment.** The single mutation in §2.4 was applied to a `cp -R`
copy of `apps/` in the session scratchpad, with a symlink to the real
`packages/`. The repository tree was never modified, and the copy was deleted.

## 8. Files written

- This report.
- `dispatches/003-T7-docs-result.json`.
- The six documents and one flow journal listed in §1.
- `.metaproject/data/gdctx/raw/…` and `.metaproject/data/gdctx/artifacts/…`,
  created automatically by the routed `keryx ctx` invocations.
