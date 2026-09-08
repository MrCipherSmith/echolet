# Echolet CLI Prototype Metrics and Validation
Version: 0.1.3

## Gate

The prototype is accepted only when every required check below passes on the same revision. Partial results are recorded as failures rather than averaged into a score.

## Automated checks

```sh
pnpm typecheck
pnpm test
go -C apps/relay test -race ./...
pnpm --filter @echolet/cli test:e2e
```

**As of flow 003 T28, the fourth command is the whole end-to-end suite.**
`pnpm --filter @echolet/cli test:e2e` is `vitest run test/e2e` — the directory,
repointed rather than renamed because the script's name already said what it
should run. **Re-measured on `23a17aa`:** `apps/cli/test/e2e/` now holds
**seven files and 30 tests** (`two-process` 3, `flood-closure` 9,
`init-relay-url` 9, `rewalk-crash-safety` 4, `relay-tls` 3,
`publication-claimability` 1, `prekey-pool-replenishment` 1, added by flow 003
T26 after this figure was first written); all seven now run under the fourth
command itself. This script is **not reliably green**, and the figure depends
on host load: an independent verification (`t25-verification-report-r2.md`
§1, §3.1, finding R2-004) measured a clean idle run at **exit 0, 7 files, 30
tests, 30 passed, real wall-clock 885.14s**, and a contended run on the same
host at **exit 143, 11 of 30 tests failed**, every failure an `E2E child
timeout` (the suites' own 30s-per-child bound, not vitest's) — `vitest.config.ts`
sets no pool limit, so all seven process-spawning files start at once. A
further re-run here, made while two other flow-003 agents were actively
editing `apps/cli` concurrently, reproduced the same load-sensitivity rather
than the idle figure: **exit 1, 4 of 30 tests failed** (two `flood-closure`,
one `two-process`, one `publication-claimability`), all `E2E child timeout` or
a 90s test timeout, real wall-clock 774.46s. **The wall-clock figure that
describes a clean, idle run is 885.14s (14m45s), not 4m52.6s** — the earlier
figure was correct when it was written, for six files, but the suite has
since grown by one file that alone costs on the order of 500s. An earlier run
at 3m30.0s with one transient failure in `flood-closure.test.ts` that did not
reproduce on retry remains recorded as historical, pre-T26, observed
flakiness rather than a gate regression. These same seven files are
*also* reached by the second command, `pnpm test` — its default
`include` was never narrowed — so the gate now exercises them twice under two
different scripts; that redundancy is accepted rather than removed, because
narrowing `pnpm test`'s scope was not this task's decision to make. There is
**no root `test:e2e` script** — the fourth command still works only with
`--filter @echolet/cli`.

The CLI commands and the `test:e2e` script existed as planned surfaces when this
document was written; both are implemented now, and the fourth command now runs
what its name says. Any evidence recorded against this gate must name the
script, the files and the test count rather than a bare figure.

`pnpm lint` is deliberately absent from the list above, and should stay absent
until it means something: the root script is `pnpm -r lint`, no workspace package
declares a `lint` script, and the command exits 0 having run nothing.

## Required measurements

| Metric | Threshold | Evidence source |
|---|---:|---|
| Clean two-process scenario iterations (`test/e2e/two-process.test.ts`) | 3/3 pass | CLI E2E report; this is one of six e2e files |
| Concurrent claim winners | exactly 1 of at least 20 | Go race test |
| Lost-response claim retries | same bundle bytes for same claim ID | Go integration test |
| Reused OTK publications | 100% rejected across changed IDs, expiry, and restart | Go repository test |
| Offline delivery | 1/1 delivered after receiver start | CLI E2E report |
| Sender restart exact retry | ciphertext bytes identical | outbox integration test |
| Receiver duplicate history entries | 0 | inbox/history integration test |
| Known plaintext marker in relay DB/logs | 0 occurrences | E2E inspection step |
| Invalid contract cases rejected | 100% fixture corpus | TypeScript and Go fixture tests |
| Required Markdown versions and links | 100% | docpack verification |

## Manual reproduction

Delivered: [runbook.md](runbook.md) carries the copyable commands, each executed
against the real relay binary and the real `dist/cli.js` with the observed output
quoted. Its numbered sections map one-to-one onto the requirements below.

The runbook must provide copyable commands that:

1. create temporary relay, Alice, and Bob directories;
2. provide separate 32-byte store keys through environment variables;
3. start the relay and verify `/health`;
4. initialize both profiles and exchange exported contact files;
5. publish both v2 bundles;
6. stop Bob, send from Alice, then start Bob and poll;
7. reply from Bob, restart Alice, and poll;
8. force an ambiguous send response and prove byte-identical retry;
9. print both histories and compare message IDs;
10. inspect relay artifacts for a unique plaintext marker and find none.

## Negative cases

- changed DeviceRecord field after signing;
- changed bundle field after device signing;
- expired bundle, OTK reuse under another bundle/key ID, and a claim after another winner;
- lost claim response followed by same-ID replay and changed-selector conflict;
- untrusted contact or changed pinned Signal identity;
- mailbox poll with invalid signature or replayed challenge;
- malformed ciphertext and duplicate envelope;
- oversized envelope;
- missing, malformed, and incorrect database key;
- termination before and after local commit.

## Evidence format

```text
Acceptance target: echolet-cli-prototype
Revision: <git revision or working-tree identifier>
Environment: <OS, architecture, Node, pnpm, Go, libsignal package>
Status: PASS | FAIL
Checks: <command and result list>
Metrics: <measured values>
Failures: <remaining failures>
Artifacts: <paths to logs/reports>
Decision: accepted as technical prototype | rejected
```

## Claims allowed after a pass

Allowed: “Two local computer CLI clients exchanged encrypted text through the Echolet relay and recovered from the tested restarts.”

Not established by this gate: production security, safe use for sensitive communication, mobile delivery, public deployment readiness, independent audit completion, user demand, or permanent suitability of the pinned libsignal dependency.
