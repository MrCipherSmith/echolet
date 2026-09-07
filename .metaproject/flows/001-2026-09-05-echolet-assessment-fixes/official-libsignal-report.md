# Official libsignal feasibility

Date: 2026-09-06. Package: `@signalapp/libsignal-client@0.102.0`, pinned in isolated `spike-official/package.json` and integrity-locked in its package-lock. Source repository: signalapp/libsignal; package license metadata AGPL-3.0-only. Installed with npm --ignore-scripts into isolated flow folder, no application dependencies changed by spike.

Maintainer source: https://github.com/signalapp/libsignal and https://github.com/signalapp/libsignal/tree/main/node. APIs verified against exact installed dist declarations and executed native package. Official repository documents external use as unsupported and APIs subject to change; this package is an implementation candidate with Echolet-owned integration, not a vendor support agreement.

Run from project root:

```sh
node .metaproject/flows/001-2026-09-05-echolet-assessment-fixes/spike-official/spike.mjs
```

Result: PASS on Node v26.5.0, darwin arm64. Ten checks: mandatory Kyber/PQ prekey bootstrap; reply; serialized key/session state JSON reload; out-of-order; duplicate rejection; crossed sends; tamper rejection followed by successful untampered retry; rejecting outbound prekey trust; rejecting asynchronous inbound prekey trust without state mutation; rejecting established outbound trust. Unlike old community candidate, asynchronous inbound false trust is respected.

Executable evidence: `.metaproject/data/gdctx/artifacts/2026-09-06T07-51-53-137Z_run.md`.

## API and durable store contract

Operations are async. Both local and remote ProtocolAddress are explicit. Ciphertext uses numeric type 3 PreKey and 2 Whisper plus serialized opaque bytes. PreKeyBundle requires registration and numeric device/key IDs, identity public key, EC signed prekey and mandatory signed Kyber prekey; the old Echolet bundle is not wire-compatible.

Opaque library records serialize/deserialize to bytes. Store local private identity, registration id, explicit approved remote PublicKey keyed full ProtocolAddress, SessionRecord, PreKeyRecord, SignedPreKeyRecord, KyberPreKeyRecord and used Kyber tuple `(kyber id, signed prekey id, base public key)`. Plain structural adapters must implement getIdentityKeyPair in addition to getIdentityKey (base abstract class normally supplies it).

Every decrypt/bootstrap/encrypt should operate in one serialized durable transaction across all library callback stores. Commit send session state and exact ciphertext outbox together before network; retry reuses stored ciphertext without calling encrypt. Commit receive state and inbox receipt together before ack. Trust approval must be explicit and bind actual trusted Echolet contact identity to Signal device identity in future integration.

## Limits and next implementation

This successful spike is Node-only, with native host prebuild and synthetic local participants. JSON reload is not power-loss persistence or encrypted storage. No phones, relay wire integration, independent audit or product pilot are claimed. The next concrete step is a reusable Node reference adapter with encrypted transactional persistence and fault/restart tests, preserving the mobile guard until genuine native bridge/device evidence exists.


## Implemented reusable reference package

The follow-up is now implemented in `packages/session-node`, rather than left as a spike. SignalClient owns official key initialization, explicit remote approvals, bootstrap, encrypt/decrypt, exact durable retry and authenticated message-id binding. It uses the parent-owned EncryptedSqliteStore via the shared transaction contract. No mobile import, relay wire migration or original crypto replacement was performed.

Ownership: this worker created `package.json`, `tsconfig.json`, `src/index.ts`, `src/SignalClient.ts`, `src/SignalClient.test.ts`, `README.md`; installed the exact official dependency into the pnpm workspace, updating `pnpm-lock.yaml`. Parent owns `src/store.ts`, `src/EncryptedSqliteStore.ts` and its tests. Isolated spike files remain under `spike-official` with separate lockfile.

### Current executable results

- Package tests: 17 passed (10 SignalClient integration cases, 7 parent-owned storage cases), artifact `2026-09-06T08-01-55-303Z_run.md` under `.metaproject/data/gdctx/artifacts`.
- Package TypeScript typecheck: passed, artifact `2026-09-06T08-01-56-858Z_run.md`.
- Actual child-process SIGKILL after encrypt commit and before sending: reopened store returns exactly the same ciphertext and peer decrypts it.
- Actual SIGKILL before transaction commit: no ciphertext returned; reopened store has no retry entry; fresh encryption decrypts correctly without lost session progression.
- Other integration evidence: close/reopen stable identity, bidirectional/delayed/crossed messages, replay and tamper rejection, rejected inbound unknown or changed key, rejected outbound unknown/revoked trust, transaction rollback on failed send and receive, concurrent sends without lost state, refusal of same-id/different-content.

The crash harness transpiles the actual TypeScript source using the existing TypeScript dev dependency into a temporary folder, runs a real Node child against real encrypted SQLite, and kills that child. It does not simulate a phone or power-loss storage hardware.

### Review correction

Independent review found that hashing raw UTF-8 text could merge distinct lone UTF-16 surrogates while encrypted JSON preserves them. Regression first reproduced failure (`2026-09-06T08-01-42-956Z_run.md`), then passed with a fix: outbox contentHash now hashes the exact authenticated encoded `{messageId,body}` bytes also passed to signalEncrypt. Different content under the same ID rejects, identical retries reuse exact ciphertext, and decrypted original text is preserved. No ratchet/cryptographic algorithm was reimplemented.

### Workflow and remaining limits

Generic dispatch `dispatches/official-session.json` passed `subagent-dispatch` validation. The issue-oriented task-implementer-input schema does not apply without a real GitHub issue and branch; orchestrator explicitly authorized the validated generic flow-worker dispatch instead of fabricated values. Initial RED was missing SignalClient module; final GREEN uses actual native libsignal and SQLite.

Reference limits remain: no real phones/native bridge, no existing Echolet wire integration, no security audit, no user pilot. Single prekey generation, key rotation/replenishment, explicit contact reset, inbox/outbox retention and acknowledgement retry API remain follow-up integration work. The README states these limitations. External use remains unsupported by libsignal upstream; Echolet owns compatibility and maintenance.

Routing: graph_used=prior affected/find navigation; wiki_used=empty index read; ctx_used=read/search/run; raw_rg_used=no. Testing context read before work. No graph claim about newly added files is made; orchestrator rebuilds before relying on final graph.
