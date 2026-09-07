# Echolet CLI prototype — agent handoff

Snapshot time: 2026-09-06 12:52 (Asia/Muscat)

## Resume here

- Project root: `/Users/Goodea/goodea/projects/echolet`
- Git: unborn `main`, no commits, no remote; every project file is currently untracked. Do not infer an empty change set from `git diff`.
- Managed flow: `001`, directory `.metaproject/flows/001-2026-09-05-echolet-assessment-fixes`, status `in-progress`.
- Before any repository action, read `.metaproject/index.md`. Route all work through `.metaproject/skills/gdskills/orchestration/flow-orchestrator/SKILL.md` and change flow state only with `keryx flow ...`.
- Use `keryx ctx rg`, never bare `rg`/`grep`; use `keryx ctx` for bounded command and log output; use `apply_patch` for edits.
- Never edit `flow.json` or frozen `acceptance-criteria.md` directly.
- User requested autonomous implementation and subagent management. No product/mobile implementation is part of the CLI prototype wave.

First commands for the next agent:

```bash
cd /Users/Goodea/goodea/projects/echolet
cat .metaproject/index.md
keryx flow status 001
keryx ctx read .metaproject/flows/001-2026-09-05-echolet-assessment-fixes/HANDOFF-CLI-PROTOTYPE-2026-09-06.md --mode full
```

## What the user asked for

Implement the approved computer CLI prototype through `flow-orchestrator`, with the primary agent orchestrating subagents. The prototype is two separate local CLI profiles/processes exchanging E2EE text through the local Go relay, with explicit contact trust, offline delivery, restart, exact retry, deduplication, acknowledgement recovery and encrypted history. Mobile apps, GUI, public deployment, production readiness, user pilot and external cryptographic audit are out of this wave.

Requirements package: `docs/requirements/echolet-cli-prototype/`.

## Flow state at snapshot

- Completed: 27 of 38 current tasks.
- Prototype implementation and verification completed: T22, T23, T24, T25, T26, T27, T30, T31, T32.
- T28 managed review is marked done with `REQUEST_CHANGES`; its schema-valid result and report are durable.
- Added durable fix tasks: T33-T36, followed by T37 full verification and T38 managed fix review. T29 now depends on T38.
- Older product-level tasks T9-T12 remain open intentionally: production session/mobile device evidence, external security review and user pilot. They are not proof obligations for the CLI prototype.
- PR: none. Flow must stay `in-progress`; it cannot be transitioned to implemented/done without a PR merged into the recorded base branch.

## Implemented prototype

### Relay v2 and mailbox integration

- Strict additive Signal bundle v2 publish/claim API with immutable raw bundle bytes.
- Permanent one-time-prekey tuple/public-key reservations.
- Atomic allocation under contention and exact selector-bound replay.
- Publish response returns the exact `bundle_id` required by the typed CLI client.
- Successful v2 publication atomically persists a verified DeviceRecord used by mailbox authorization; idempotent backfill works and conflicts do not replace the record.
- Empty mailbox poll now serializes `envelopes: []`, matching the strict TypeScript contract.

Primary implementation paths:

- `apps/relay/internal/model/signal_prekey_bundle_v2.go`
- `apps/relay/internal/validation/signal_prekey_bundle_v2.go`
- `apps/relay/internal/storage/repository/signal_prekey_bundle_v2.go`
- `apps/relay/internal/service/signal_prekey_bundle_v2.go`
- `apps/relay/internal/api/handler/signal_prekey_bundle_v2.go`
- `apps/relay/internal/storage/repository/mailbox_repo.go`

### CLI profile, transport and runtime

- Runnable Node 22.13+ ESM binary in `apps/cli/dist/cli.js` built from `apps/cli/src/commands/cli.ts`.
- Commands: `init`, `contact export`, `contact import`, `relay publish`, `send`, `poll`, `history`, `doctor`.
- Strict argument handling; stable exit codes `0/2/3/4/5`; exactly one JSON object on stdout; fixed redacted errors.
- Encrypted profile/session/inbox/outbox/history state backed by `packages/session-node` and official `@signalapp/libsignal-client` pinned to `0.102.0`.
- Explicit mutually pinned contact cards and native identity verification.
- Durable byte-identical outbound retry via caller-supplied optional `--message-id`.
- Atomic decrypt/native-state/inbox/history/pending-ack commit; post-commit ack; restart ack retry without a second decrypt.
- Exact redelivery deduplication and bidirectional encrypted history.

Primary implementation paths:

- `apps/cli/src/commands/cli.ts`
- `apps/cli/src/runtime/config.ts`
- `apps/cli/src/runtime/profile.ts`
- `apps/cli/src/runtime/outbound.ts`
- `apps/cli/src/runtime/inbound.ts`
- `apps/cli/src/runtime/history.ts`
- `apps/cli/src/transport/relayClient.ts`
- `apps/cli/test/e2e/two-process.test.ts`

## Verification evidence before review fixes

T27 ran all checks independently and did not stop early:

| Check | Result |
|---|---|
| `pnpm install --frozen-lockfile` | PASS |
| CLI production build | PASS |
| Workspace typecheck | PASS, 7 packages |
| CLI process contract tests | PASS, 6/6 |
| Workspace tests | PASS, 82/82 |
| Independent real E2E | PASS, 3/3 clean runs |
| Go untagged suite | PASS |
| Uncached `go test -race -count=1 -tags=relayv2 ./...` | PASS |
| `keryx test run --strict` | PASS |
| Graph rebuild/cycles | 70 nodes, 104 edges, 0 cycles |
| Wiki links | 19 pages, 38 links, 0 broken |
| `keryx health run --strict` | exit 0, WARN, score 92 |

Health warning detail: seven P2 complexity findings; the health adapter skips ESLint/TypeScript and does not associate the direct tests. Direct typecheck and tests above passed. Lint scripts are not configured. This is a technical prototype gate, not a production security claim.

Evidence:

- `t26-e2e-report.md`
- `t27-verification-report.md`
- `dispatches/001-T26-e2e-result.json`
- `dispatches/001-T27-verify-result.json`

## T28 managed review

Managed review directory:

`.metaproject/flows/001-2026-09-05-echolet-assessment-fixes/reviews/2026-09-06-path-echolet-cli-prototype-t28/`

Final ingested package:

`.metaproject/flows/001-2026-09-05-echolet-assessment-fixes/reviews/2026-09-06-ingest-echolet-cli-prototype-t28/`

The repository has no commit, so the review uses an explicit Keryx path scope. Scope retained 98 relevant files. Roles completed sequentially under separate validated contracts because agent thread limits prevented five simultaneous actors:

- `review-logic`: 3 major.
- `review-backend`: 1 blocker, 1 major.
- `review-security-code`: 2 blockers.
- `review-highload`: 1 blocker, 3 major.
- `review-testing-practices`: 1 minor; isolated mutation pass killed 3/4 mutations and changed no canonical file.

An independent `review-verifier` actor completed all 12 claims: 10 confirmed, 0 refuted, 2 unverifiable (`F-003`, `F-008`), 0 unchecked. The coordinator ingested the result into the final managed review package. The report scanner no longer blocks the report; it retains two heuristic warnings. T28 result passed the `subagent-result` schema and T28 is done in the flow.

Canonical preliminary set: `consolidated-findings.json` (12 findings: 4 blocker, 7 major, 1 minor).

| ID | Sev | Problem | Intended fix direction |
|---|---|---|---|
| F-001 | major | Relay publish retry regenerates bundle ID while reusing the reserved OTK | Persist and retry the exact signed publication bundle; separate fresh allocation |
| F-002 | major | Interactive confirmation waits for stdin EOF after a complete line | Read one bounded line and settle on newline/EOF |
| F-003 | major | SQLite failures after profile open are remapped to trust/protocol exit 3 | Typed persistence errors preserved to `PERSISTENCE_FAILURE`, exit 5 |
| F-004 | blocker | Existing mailbox envelope ID is silently overwritten by changed content | Transactional identical replay or HTTP 409 conflict; never replace |
| F-005 | major | Relay retains/returns expired envelopes for seven days | Validate expiry, bounded remaining TTL, filter expired entries before limit |
| F-006 | blocker | V1 bodies are unbounded and `size_bytes` is trusted instead of actual ciphertext bytes | Bound request bodies/fields and verify actual encoded/decoded byte size |
| F-007 | blocker | Mailbox authorization looks up device UUID globally before checking identity | Resolve by immutable mailbox identity + device UUID binding |
| F-008 | blocker | Concurrent same-ID sends can append duplicate history and replace outbox envelope | Recheck/return existing outbox inside the same transaction |
| F-009 | major | Valid poll batch can exceed the CLI 1 MiB response bound and cannot drain | Shared aggregate byte budget plus bounded batch/pagination progress |
| F-010 | major | Rate limiter holds global mutex while executing downstream handler | Unlock after quota decision and before handler/rejection write |
| F-011 | major | Rate key includes source port and buckets never expire | Normalize host and prune idle buckets; define proxy handling |
| F-012 | minor | Unknown-sender test only asserts generic throw and misses typed trust guard | Assert `CONTACT_NOT_TRUSTED` plus unchanged state/no ack |

Reviewer artifacts:

- `review-logic-result.json` / `review-logic-report.md`
- `review-backend-result.json` / `review-backend-report.md`
- `review-security-code-result.json` / `review-security-code-report.md`
- `review-highload-result.json` / `review-highload-report.md`
- `review-testing-practices-result.json` / `review-testing-practices-report.md`
- `consolidated-findings.json`
- `finding-map.json`
- `inputs/verification-input.json`
- `inputs/verifier-dispatch.json`

Independent verifier evidence:

- Empirically confirmed in one bounded synthetic Go probe: F-004 overwrite, F-005 expired return, F-006 declared-size bypass, F-007 duplicate-device misselection, F-010 global limiter lock, F-011 source-port bypass.
- Source/site checks completed for all findings.
- F-001 repeated publish and F-002 newline confirmation were empirically confirmed with bounded CLI probes.
- F-003 persistence classification and F-008 concurrent-send outcome remain `unverifiable`; their source paths are recorded but deterministic fault/scheduling hooks were not available.
- Temporary probe artifacts were removed with `apply_patch`; canonical sources/tests remained unchanged.

## Exact next work

1. Execute T33: CLI retry/interactive/persistence/concurrent-send fixes for F-001, F-002, F-003, F-008.
2. Execute T34: relay mailbox integrity/auth/request-bound fixes for F-004, F-005, F-006, F-007.
3. Execute T35: poll capacity and rate-limiter fixes for F-009, F-010, F-011.
4. Execute T36: typed unknown-sender regression for F-012.
5. For every code task, run local `tests-creator` first and validate its RED result, then independent `task-implementer`; do not let the implementer self-accept.
6. Execute T37 with the complete T27 verification matrix after all fixes.
7. Execute T38 as a managed fix review and record explicit dispositions/evidence for every F-001..F-012.
8. Only after a clean T38 review, update `docs/STATUS_CURRENT.md`, the requirements package status, flow journal and final prototype change report, then close T29.

## Documentation corrections still required in T29

`docs/STATUS_CURRENT.md` is stale for this wave. It currently says the repository is absent and relay v2/CLI are still next gates. Update it to say:

- git exists on unborn `main`, with no commits and no remote;
- computer CLI technical prototype is implemented and locally verified;
- relay v2 network path and two-process E2E are implemented;
- review findings/fix verification status accurately reflect the final fix round;
- mobile, production deployment, external audit and user pilot remain unimplemented/unproven.

`docs/requirements/echolet-cli-prototype/README.md` still says `spec ready` and the networked CLI is planned. Update only after the review fix gates are complete.

## Safety and reporting boundaries

- Do not print profile keys, private key material, ciphertext, HTTP request bodies or non-explicit-history plaintext into reports/logs.
- Loopback HTTP is development-only; non-loopback relay URLs require HTTPS.
- `@signalapp/libsignal-client@0.102.0` remains a prototype choice, not a permanent architecture/security approval.
- Internal agent review is not an independent external cryptographic audit.
- Passing local tests does not establish mobile behavior, production operations, user demand or safe sensitive use.

## Routing audit at snapshot

- `graph_used: yes`
- `wiki_used: yes`
- `ctx_used: yes`
- `raw_rg_used: no`
