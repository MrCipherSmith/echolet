# Echolet CLI Prototype Requirements Package
Version: 0.1.1

## Purpose and status

This package defines the next implementable Echolet prototype: two independent command-line clients on computers exchange end-to-end encrypted text through the existing local Go relay, retain history, and continue after process restart.

**Status: implemented and locally verified as a computer technical prototype (2026-09-07).** Relay v2 allocation over the network path, the CLI client, and the complete two-process networked scenario are implemented, and the acceptance evidence exists: 162 workspace tests green across four full unfiltered executions, `go -C apps/relay test ./...` green untagged, with `-race` and under the `relayv2` tag, and the two-process end-to-end scenario green 3/3 (offline delivery, restart, exact retry, ack recovery). Measurements: [`t55-final-verification.md`](../../../.metaproject/flows/001-2026-09-05-echolet-assessment-fixes/t55-final-verification.md); dispositions: [`t56-final-dispositions.md`](../../../.metaproject/flows/001-2026-09-05-echolet-assessment-fixes/t56-final-dispositions.md); the wave's summary: [`final-change-report.md`](../../../.metaproject/flows/001-2026-09-05-echolet-assessment-fixes/final-change-report.md).

What that status does **not** mean. Everything in Non-goals below remains untouched: no mobile delivery, no production deployment, no external cryptographic audit, no user pilot. Evidence covers one macOS arm64 machine and one working tree; `main` is unborn with no commit and no remote, so no result can be pinned to a commit hash. Two limitations are open and documented rather than fixed: **mailbox flooding is bounded, not eliminated** — a self-published sender can still wedge a victim's mailbox for up to the 168 h retention cap, at a measured cost of 4 self-published identities and 49 maximum-size envelopes — and **one published bundle serves exactly one first-contact sender**. Both are stated in full in [specification.md](specification.md) and in the change report.

Verification requires **Node 22.13+**; on Node 22.12 and below `node:sqlite` is missing and most CLI suites fail to collect in a way indistinguishable from a broken implementation.

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
