# Echolet CLI Prototype Requirements Package
Version: 0.2.3

## Purpose and status

This package defines the next implementable Echolet prototype: two independent command-line clients on computers exchange end-to-end encrypted text through the existing local Go relay, retain history, and continue after process restart.

**Status: implemented and locally verified as a computer technical prototype, as of commit `c302485` (2026-09-07); the tree has since moved to `c5fde09`.** Relay v2 allocation over the network path, the CLI client, and the complete two-process networked scenario are implemented, and the acceptance evidence exists. Independently re-measured on `c302485` by the flow 002 verification: `pnpm typecheck` clean, `pnpm test` **293/293 across 50 files** (which includes all six files under `apps/cli/test/e2e/`), and `go -C apps/relay test ./...` green untagged, with `-race`, and with `-race -tags relayv2`, **0 data races** in all three. Measurements: [`t10-verification-report-r3.md`](../../../.metaproject/flows/002-2026-09-07-echolet-close-the-flood-class-operator-c/t10-verification-report-r3.md); the earlier flow 001 baseline: [`t55-final-verification.md`](../../../.metaproject/flows/001-2026-09-05-echolet-assessment-fixes/t55-final-verification.md); dispositions: [`t56-final-dispositions.md`](../../../.metaproject/flows/001-2026-09-05-echolet-assessment-fixes/t56-final-dispositions.md); the first wave's summary: [`final-change-report.md`](../../../.metaproject/flows/001-2026-09-05-echolet-assessment-fixes/final-change-report.md).

**What `test:e2e` actually runs.** As of flow 003 T28, `pnpm --filter @echolet/cli test:e2e` is `vitest run test/e2e` — the whole directory, repointed rather than renamed because the name already said what it should do. `apps/cli/test/e2e/` holds **six files and 29 tests** (`two-process` 3, `flood-closure` 9, `init-relay-url` 9, `rewalk-crash-safety` 4, `relay-tls` 3, `publication-claimability` 1), and all six now run under `test:e2e` itself, not only under the plain `test` script that already reached them. Measured here twice on `c5fde09`: **6 files, 29 tests, all passed**, real wall-clock **4m52.6s** (vitest-internal 291.5s) on a clean run; a first run measured **3m30.0s** with one transient failure in `flood-closure.test.ts`'s largest scenario that did not reproduce on retry with identical code, so it is not attributed to this change. No file needed to be excluded from the repoint. There is still **no root `test:e2e` script**; `pnpm test:e2e` at the repository root fails.

### What changed in flow 002, and may now be claimed

- **The mailbox flooding class is closed for delivery, and it is closed as a bound rather than as an elimination.** Measured by the independent verifier on the real relay at `c302485`: an attacker's 4 self-published identities and 49 maximum-size envelopes (12.23 MB uploaded over 53 requests) **no longer wedge the mailbox** — the legitimate message is delivered in **2 polls / 17 pages**, and three ordinary polls afterwards cost 4 pages. Read this precisely: the attacker can still publish identities and still enqueue the envelopes, and the recipient still pays a **one-time** walk over them. What is closed is the **amplification across polls** — the durable read position means the poison is never re-read — which is what made the wedge permanent. The per-flood cost is bounded, not zero.
- **The contact-import re-walk is crash-safe.** Swept by the verifier across **32 interruption configurations** (SIGINT and SIGKILL, at both minimum and maximum ciphertext size, inside the page request, inside acceptance, and around the acknowledgement) with **zero lost messages and zero duplicates**; the completed re-walk is not repeated.
- **The relay serves HTTPS with no silent downgrade.** Set only one of the two TLS variables, or point either at a missing, malformed or mismatched file, and it exits non-zero at startup naming the offender rather than serving plain HTTP.
- **An operator TUI exists** and drives the local CLI. It was demonstrated, not asserted, against a real relay with a real store key in the environment: the key appears in no rendered frame, and the console imports no profile, store or crypto module.
- **The relay stops cleanly on SIGTERM and SIGINT** (commit `a2f07bb`, landed after the measurements above). It previously installed no signal handler at all and `docker stop` reported `Exited (2)`, so an ordinary operator stop looked like a crash to any supervisor keying off exit status. It now closes its listeners, drains requests already in flight for up to five seconds, closes Badger and exits 0; a store close that fails still exits 1, deliberately. Pinned by four tests in `apps/relay/internal/server/process_shutdown_test.go` (re-run here, 4/4 pass) and measured on both hosts as `.State.ExitCode` 2 → 0. What this does **not** guarantee: nothing tracks handler goroutines past the drain deadline, so "no handler outlives the store" is still an argument rather than a guarantee. The other half of this caveat is **closed**: both escalation paths now have tests — `TestRelayExitsZeroWhenTheDrainDeadlineIsExceeded` and `TestRelayExitsZeroOnASecondSignalDuringShutdown` in `apps/relay/internal/server/process_shutdown_escalation_test.go`, added in `7af8492`, green here under `-count=1`.

### What that status still does **not** mean

Everything in Non-goals below remains untouched, and none of it is softened by the above:

- **no independent cryptographic audit** — the reviews and verifications on record are internal agentic ones;
- **no mobile client** — `apps/mobile` is untouched;
- **no evidence of user demand** — no interviews, no pilot;
- **no production deployment and no production-readiness claim**;
- **no safety for sensitive communication.** This is an unaudited prototype;
- **the pinned `@signalapp/libsignal-client@0.102.0` is not a permanent decision.**

Open limitations carried forward, documented rather than fixed:

- **One published bundle serves exactly one first-contact sender.** After the first sender claims a recipient's bundle, a second distinct sender receives `PREKEY_BUNDLE_UNAVAILABLE`; rotation exists in the runtime but has no CLI entry point.
- **`ECHOLET_MAX_STORAGE_BYTES` is declared and enforced nowhere**, and there is no per-mailbox occupancy cap, so a flood still consumes relay disk without limit.
- **Identity creation is free.** `POST /v1/device-records/publish` is still unauthenticated; minting identities no longer wedges a mailbox, but nothing bounds how many distinct senders one mailbox accumulates.
- The residuals in [`t16-implementation-report.md`](../../../.metaproject/flows/002-2026-09-07-echolet-close-the-flood-class-operator-c/t16-implementation-report.md) §8 (R-1…R-6, including stale prose in two test files and unserialised concurrent polls on one profile) and the findings in [`t10-verification-report-r3.md`](../../../.metaproject/flows/002-2026-09-07-echolet-close-the-flood-class-operator-c/t10-verification-report-r3.md) §7 (T10R3V-F-001…F-004).
- **`CleanupService` sweeps nothing, and the interval is no longer offered as a setting.** `CleanupService.runCleanup()` is still two `slog.Debug` calls and does no work; the three fields the constructor stores (`mailboxRepo`, `challengeRepo`, `mailboxTTL`) are still never read. **Retention is the store's own TTL** — Badger expires mailbox records at `ECHOLET_MAILBOX_TTL_HOURS` — **and needs no sweep interval.** Two of the three halves of this limitation are therefore closed rather than carried: the ticker is stoppable and inside the shutdown sequence since `18afa36` (`stop`/`stopped` channels under a mutex, `Stop()` waits for the goroutine to return, and `cmd/relay/main.go` calls it on all four store-closing paths, pinned by `TestCleanupServiceStopEndsItsTickerGoroutine` and `TestRelayStopsTheCleanupServiceBeforeClosingStorage`); and `apps/relay/internal/service` does now hold a test file (`cleanup_service_stop_test.go`, added in `7af8492`). `ECHOLET_CLEANUP_INTERVAL_SECONDS` was removed from the operator-facing surface in flow 003 T28 — both compose files, `run-relay.sh` and all three env examples — because a dial that turns nothing is worse than no dial. What stays open: the empty body, and the fact that `internal/config/config.go` still declares the field with `envDefault:"60"`, so the variable would still be read if an environment set it. Retiring the field is a Go change and belongs to a task with tests.
- **No package declares a `lint` script, so `pnpm lint` at the root runs nothing.** The root `package.json` declares `"lint": "pnpm -r lint"`, none of the seven workspace packages defines one, and the command exits 0 printing `None of the selected packages has a "lint" script`. The lint leg of the quality matrix is **vacuous, not green** — which is the mechanical cause of the recorded finding that the strict health adapter cannot execute ESLint: there is no ESLint to execute. Open.

**AC4 is now established; AC7 is not.** On 2026-09-07 the tailnet owner enabled HTTPS Certificates and `depr` was switched to the TLS path: it serves HTTPS on its tailnet address `100.100.188.64:8443` with a real Let's Encrypt certificate for `depr.tail5a88fb.ts.net`, and the full acceptance scenario ran against `https://depr.tail5a88fb.ts.net:8443` from a second machine with no tunnel, forward, proxy or shim — `/health` 200 with `ssl_verify_result=0` against the system trust store, plain HTTP to that port answered `400`. Evidence: [`t11-tls-report.md`](../../../.metaproject/flows/002-2026-09-07-echolet-close-the-flood-class-operator-c/t11-tls-report.md).

Two clauses that used to be carried here are **no longer true and have been removed rather than repeated**:

- **`geekom` is no longer on loopback plain HTTP.** It was switched to the TLS path on the same day, with a Let's Encrypt certificate for `geekom.tail5a88fb.ts.net` (issuer `YE1`, valid to 6 December 2026), published on its tailnet address, and `tailscale cert` needed no `sudo`: [`t11-geekom-tls-report.md`](../../../.metaproject/flows/002-2026-09-07-echolet-close-the-flood-class-operator-c/t11-geekom-tls-report.md). Re-verified read-only in flow 003 T28 with a single unauthenticated `GET /health` to each host, no `-k`: `https://geekom.tail5a88fb.ts.net:8443/health` and `https://depr.tail5a88fb.ts.net:8443/health` both **200 with `ssl_verify_result=0`** against the system trust store. **Both relays serve HTTPS.** The recorded reason for holding AC7 open — that HTTPS was served by one relay of two — therefore no longer holds; whether AC7 is formally closed is a flow-002 record decision and is not made by this document.
- **Certificate renewal is installed on both hosts.** `geekom` renews through an enabled, lingering user-scope `systemd` timer ([`t11-geekom-tls-report.md`](../../../.metaproject/flows/002-2026-09-07-echolet-close-the-flood-class-operator-c/t11-geekom-tls-report.md) §8); `depr` renews through a root-scope timer built from the repository's own committed units, enabled and active, its service run three times end to end with `0/SUCCESS` and no Let's Encrypt request ([`t14-renewal-report.md`](../../../.metaproject/flows/003-2026-09-07-echolet-residuals-and-tui/t14-renewal-report.md)). Both certificates still expire 6 December 2026; nothing now depends on a person remembering to renew them. The timer state itself was not re-checked from a host in this pass — that needs shell access this task did not use — so it rests on those two reports.

Still carried forward, and re-verified here: hot reload on renewal has an automated test but has **never been exercised on `depr`** (T14 deliberately made no Let's Encrypt request — the serial was identical before and after); and **`docker-compose.yml` cannot perform the TLS switch** — `deploy/relay/docker-compose.yml:77` still hard-requires `ECHOLET_HOST_DATA_DIR` with no named-volume branch, so only `run-relay.sh` can move a relay whose store lives in `echolet-relay-data`.

Verification requires **Node 22.13+**; on Node 22.12 and below `node:sqlite` is missing and most CLI suites fail to collect in a way indistinguishable from a broken implementation. Note that a login shell (`bash -lc`) on the development machine may itself start Node 22.12.

## Document index

- [Product requirements](prd.md)
- [Technical specification](specification.md)
- [Implementation plan](implementation-plan.md)
- [Metrics and validation](metrics-and-validation.md)
- [Runbook: reproduce the prototype from a clean checkout](runbook.md)
- [Deployment runbook: stand a relay up on a tailnet host](deployment-runbook.md)
- [Contact card schema](schemas/contact-card.schema.json)
- [Client configuration schema](schemas/client-config.schema.json)
- [Relay v2 exchange schema](schemas/relay-v2.schema.json)

## Scope

- two separate local client profiles and processes;
- explicit out-of-band contact trust;
- Signal bundle v2 publication and atomic one-time-prekey claim;
- encrypted durable session, inbox, outbox, and history state;
- send, poll, decrypt, acknowledge, retry, and restart behavior;
- a deterministic local demo and automated end-to-end test.

## Non-goals

- mobile applications or a graphical interface;
- groups, media, push notifications, multi-device synchronization, or public discovery;
- public deployment, production operations, a security audit, or a production-readiness claim;
- a permanent decision to use `@signalapp/libsignal-client` outside this prototype.

## Related modules and evidence

- [Current project status](../../STATUS_CURRENT.md)
- [Signal bundle v2 protocol](../../PROTOCOL-30_SIGNAL_BUNDLE_V2.md)
- [MVP message flow](../../PROTOCOL-07_MVP_MESSAGE_FLOW.md)
- [JSON API contracts](../../API-11_JSON_SCHEMAS.md)
- [Identity rules](../../SEC-01_IDENTITY.md)
- [Threat model](../../THREAT-08_MODEL.md)
- [Relay design](../../REP-02_REPEATER_NODE.md)
- [Crypto selection RFC](../../RFC-18_CRYPTO_SELECTION.md)
- [Existing Node session reference](../../../packages/session-node/README.md)

## Scope extensions approved during implementation

Two changes go beyond the scope above and were made only because the user was shown the measured cost and chose them explicitly:

- **sender authentication on `POST /v1/messages/send`** — the sender's envelope is signed over a versioned transcript and verified against their already-published, root-signed device record;
- **a per-sender unacknowledged-envelope quota** (default 16 live envelopes per sender per recipient mailbox).

Both add production-shaped security to a route the prototype's scope excluded. They are recorded as approved extensions, not as scope the wave grew into on its own.

## Implementation entry point

The plan below is retained as the record of how the prototype was built; the work it describes is done. Start reading at the [technical specification](specification.md) for the contract as shipped, and at the [change report](../../../.metaproject/flows/001-2026-09-05-echolet-assessment-fixes/final-change-report.md) for what remains open.
