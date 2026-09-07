# Echolet CLI Prototype PRD
Version: 0.1.1

## Problem

Echolet has separately tested relay and Node session building blocks, but it does not yet prove the smallest complete product behavior. There is no computer client that connects the strict Signal wire contract to the relay, and no reproducible test in which two independent persisted clients exchange messages and survive restart.

## Goal

Produce a local technical prototype that proves or disproves the integration path before any mobile or product UX work resumes. A reviewer must be able to start one relay, initialize Alice and Bob as separate profiles, exchange trusted contact records, send encrypted text while either side may be offline, restart both processes, and read the same conversation state without editing code or databases.

## Users

- an Echolet developer implementing protocol and persistence integration;
- a reviewer reproducing the prototype from documented commands;
- a security reviewer examining trust, allocation, retry, and persistence boundaries.

## Functional requirements

| ID | Requirement |
|---|---|
| FR-01 | The CLI creates an isolated profile with a stable Echolet identity, device record, and encrypted local store. |
| FR-02 | A user exports a public contact card and imports a peer card through a local file, with explicit confirmation of Echolet identity, device, and Signal identity identifiers. Import pins the Signal identity before either side sends or decrypts. |
| FR-03 | The client publishes a signed Signal bundle v2 to a versioned relay endpoint. |
| FR-04 | The relay atomically allocates a published bundle containing a one-time prekey to at most one claim ID, supports replay of that exact claim after a lost response, and never reconstructs or resigns the bundle. |
| FR-05 | A sender validates the claimed bundle against the already trusted contact before approving the Signal identity and establishing a session. |
| FR-06 | The sender commits advanced session state and exact ciphertext to the outbox before network transmission; retries reuse those bytes. |
| FR-07 | The relay stores only the envelope and ciphertext required by the existing mailbox protocol. |
| FR-08 | The receiver authenticates mailbox access, decrypts inside a durable transaction, records history, and acknowledges only after commit. |
| FR-09 | `history` shows durable sent and received messages for a selected contact without relay access. |
| FR-10 | Closing and restarting a client preserves identity, trust, sessions, outbox, inbox, and history. |
| FR-11 | A scripted demo runs two profiles through initialization, trust, publication, offline send, poll, reply, restart, retry, and history checks. |

## Quality requirements

| ID | Requirement |
|---|---|
| QR-01 | No seed, private key, database encryption key, or plaintext message appears in relay storage or normal command logs. |
| QR-02 | Profile writes are atomic; a process failure before commit leaves no partial session/message state. |
| QR-03 | Network calls have explicit timeouts and structured error codes. |
| QR-04 | Contracts are runtime-validated on both TypeScript and Go boundaries using shared JSON fixtures. |
| QR-05 | The prototype runs on the currently evidenced host class: Node 22.13+ with a compatible libsignal native prebuild and the local Go relay. |

## Success criteria

- The automated two-client scenario passes three consecutive clean runs.
- A message queued while the receiver is offline is decrypted after the receiver starts.
- After sender restart, an uncertain send retries byte-for-byte without advancing the session twice.
- After receiver restart, history still contains the committed message and duplicate delivery does not add another entry.
- Twenty concurrent claims of one bundle produce exactly one successful allocation.
- The relay database and captured relay requests contain no plaintext test message.
- Workspace TypeScript checks, Node tests, Go tests with the race detector, schema validation, and the prototype end-to-end suite pass.

## Risks

- `@signalapp/libsignal-client@0.102.0` is AGPL-3.0-only, outside-Signal use is unsupported upstream, and its API may change. It is a pinned prototype dependency and requires a separate product decision before broader development.
- The existing Node encrypted SQLite snapshot does not prevent rollback to an older valid file and is not a production-scale storage design.
- One published v2 bundle currently provides only one one-time prekey. The prototype can support the Alice/Bob proof, but prekey pool replenishment is a later capability.
- A successful computer prototype does not prove mobile background delivery, public deployment safety, independent security review, or user demand.

## Recommendation

Implement this package as the next engineering milestone. Stop after the validation gate and review the evidence before expanding scope. Success justifies a product-grade crypto/runtime decision and later client UX work; failure should be fixed at the relay/session boundary while the system is still small.
