# Echolet CLI Prototype Implementation Plan
Version: 0.1.1

## Delivery rule

Implement in dependency order and keep every change behind tests. A task is complete only when its acceptance evidence is recorded. Do not connect the guarded mobile demo to this path.

## Work breakdown

| ID | Work | Depends on | Completion evidence |
|---|---|---|---|
| P0-01 | Add protocol types and shared valid/invalid fixtures for relay v2 publish and idempotent claim | — | TypeScript schema tests and Go fixture tests agree, including native-signature checks at the client boundary |
| P0-02 | Add immutable relay v2 model/repository, permanent OTK uniqueness indexes, and expiry handling | P0-01 | Repository tests cover byte-identical publish, conflicts across bundle/key IDs, expiry, and restart persistence |
| P0-03 | Add atomic claim service, persisted claim-result replay, and HTTP handlers | P0-02 | `go test -race` proves one winner from 20 claim IDs and exact replay after lost response |
| P0-04 | Add `apps/cli` package, strict config loading, profile initialization, and secret redaction | P0-01 | Config/schema tests and wrong-key restart tests pass |
| P0-05 | Add signed-bundle contact export/import and explicit Signal identity trust persistence | P0-04 | Both peers pin before messaging; changed/bad signatures reject without mutation |
| P0-06 | Add typed relay client with timeouts and structured errors | P0-03, P0-04 | HTTP contract tests cover publish, claim, send, challenge, poll, and ack |
| P0-07 | Integrate `SignalClient` send/bootstrap with durable outbox retry | P0-05, P0-06 | First send, ambiguous send, exact retry, and restart tests pass |
| P0-08 | Integrate poll/decrypt/history/ack state machine | P0-06, P0-07 | Offline receive, ack retry, duplicate, tamper, and restart tests pass |
| P0-09 | Add isolated two-process end-to-end harness and developer runbook | P0-08 | Three consecutive clean runs pass without database/code edits |
| P0-10 | Run final verification, documentation review, and bounded security review | P0-09 | All gates in metrics-and-validation pass; limitations remain explicit |

## Implementation details by wave

### Wave 1 — Contracts and relay allocation

Complete P0-01 through P0-03. Preserve v1 routes. Store the exact signed v2 bundle, reserve OTK indexes, and consume its availability bit in Badger transactions. The relay validates Echolet root/device bindings; official libsignal native SPK/Kyber validation remains at the Node client boundary and receives dedicated shared fixtures. Persist claim results for idempotent recovery after a response is lost.

### Wave 2 — Profile and trust

Complete P0-04 and P0-05. Reuse existing identity helpers and encrypted store boundaries. Keep the database key outside the profile. Contact import is the only operation allowed to create Echolet trust.

### Wave 3 — Transport and runtime

Complete P0-06 through P0-08. Keep network code outside `SignalClient`. Model outbox and inbox transitions explicitly so retries after uncertain results never cause re-encryption or a second decrypt commit.

### Wave 4 — Proof and review

Complete P0-09 and P0-10. The harness starts a temporary relay and two child CLI processes with separate profile directories and keys. It exercises offline delivery and restarts rather than calling library methods directly in one process.

## Suggested file ownership

- Protocol contracts/fixtures: `packages/protocol`.
- Relay v2 persistence and HTTP: `apps/relay`.
- CLI orchestration and transport: `apps/cli`.
- Session primitives: `packages/session-node`; extend only when a required durable state transition is missing.
- Documentation evidence: this package and the active managed flow through Keryx CLI.

## Stop conditions

Pause implementation and record the failing evidence if native libsignal cannot run on the target development host, the Go and TypeScript signature implementations cannot agree on the existing transcript, atomic claim cannot be demonstrated under the race detector, or restart tests reveal unrecoverable session divergence. Do not hide these failures with a second cryptographic implementation.

## Definition of done

All specification acceptance criteria pass, the current status document links the evidence, and a reviewer can reproduce the local two-client scenario from a clean checkout. This completes a technical prototype only; product crypto selection, audit, mobile feasibility, and pilot gates remain open.
