# Echolet CLI Prototype Metrics and Validation
Version: 0.1.1

## Gate

The prototype is accepted only when every required check below passes on the same revision. Partial results are recorded as failures rather than averaged into a score.

## Automated checks

```sh
pnpm typecheck
pnpm test
go -C apps/relay test -race ./...
pnpm --filter @echolet/cli test:e2e
```

The CLI commands and `test:e2e` script are planned surfaces. Add them in P0-04 and P0-09 before claiming this gate.

## Required measurements

| Metric | Threshold | Evidence source |
|---|---:|---|
| Clean end-to-end runs | 3/3 pass | CLI E2E report |
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
