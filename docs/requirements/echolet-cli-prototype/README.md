# Echolet CLI Prototype Requirements Package
Version: 0.2.0

## Purpose and status

This package defines the next implementable Echolet prototype: two independent command-line clients on computers exchange end-to-end encrypted text through the existing local Go relay, retain history, and continue after process restart.

**Status: implemented and locally verified as a computer technical prototype, as of commit `c302485` (2026-09-07).** Relay v2 allocation over the network path, the CLI client, and the complete two-process networked scenario are implemented, and the acceptance evidence exists. Independently re-measured on `c302485` by the flow 002 verification: `pnpm typecheck` clean, `pnpm test` **293/293 across 50 files**, `pnpm --filter @echolet/cli test:e2e` **3/3**, and `go -C apps/relay test ./...` green untagged, with `-race`, and with `-race -tags relayv2`, **0 data races** in all three. Measurements: [`t10-verification-report-r3.md`](../../../.metaproject/flows/002-2026-09-07-echolet-close-the-flood-class-operator-c/t10-verification-report-r3.md); the earlier flow 001 baseline: [`t55-final-verification.md`](../../../.metaproject/flows/001-2026-09-05-echolet-assessment-fixes/t55-final-verification.md); dispositions: [`t56-final-dispositions.md`](../../../.metaproject/flows/001-2026-09-05-echolet-assessment-fixes/t56-final-dispositions.md); the first wave's summary: [`final-change-report.md`](../../../.metaproject/flows/001-2026-09-05-echolet-assessment-fixes/final-change-report.md).

### What changed in flow 002, and may now be claimed

- **The mailbox flooding class is closed for delivery, and it is closed as a bound rather than as an elimination.** Measured by the independent verifier on the real relay at `c302485`: an attacker's 4 self-published identities and 49 maximum-size envelopes (12.23 MB uploaded over 53 requests) **no longer wedge the mailbox** — the legitimate message is delivered in **2 polls / 17 pages**, and three ordinary polls afterwards cost 4 pages. Read this precisely: the attacker can still publish identities and still enqueue the envelopes, and the recipient still pays a **one-time** walk over them. What is closed is the **amplification across polls** — the durable read position means the poison is never re-read — which is what made the wedge permanent. The per-flood cost is bounded, not zero.
- **The contact-import re-walk is crash-safe.** Swept by the verifier across **32 interruption configurations** (SIGINT and SIGKILL, at both minimum and maximum ciphertext size, inside the page request, inside acceptance, and around the acknowledgement) with **zero lost messages and zero duplicates**; the completed re-walk is not repeated.
- **The relay serves HTTPS with no silent downgrade.** Set only one of the two TLS variables, or point either at a missing, malformed or mismatched file, and it exits non-zero at startup naming the offender rather than serving plain HTTP.
- **An operator TUI exists** and drives the local CLI. It was demonstrated, not asserted, against a real relay with a real store key in the environment: the key appears in no rendered frame, and the console imports no profile, store or crypto module.

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

Two acceptance criteria of flow 002 are **not** fully established: the "different machine" half of AC4 (verified for HTTPS, not for a cross-machine run — loopback cannot establish it), and AC7's deployment, which is blocked on enabling HTTPS Certificates for the tailnet (see §3.1 of the [deployment runbook](deployment-runbook.md)).

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
