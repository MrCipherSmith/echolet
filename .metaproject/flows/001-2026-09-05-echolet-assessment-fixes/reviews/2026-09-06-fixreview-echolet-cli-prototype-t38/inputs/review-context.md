# T38 managed fix review — shared reviewer context

Flow: `001`, project root `/Users/Goodea/goodea/projects/echolet`.
Repository is on unborn `main`: no commits, no remote, every file untracked.
**An empty `git diff` does not mean an empty change set.** Review the working tree
against the finding evidence and the implementation reports, not against git.

## What this review must decide

The T28 review returned `REQUEST_CHANGES` with twelve findings. Flow tasks
T33-T36 and T39 implemented fixes; T37 re-ran the full verification matrix and
passed. Your job is **not** to re-run the tests. It is to judge, per finding,
whether the fix is real, complete and free of new defects.

For every finding in your assigned set you must return an explicit disposition:

| Disposition | Meaning |
|---|---|
| `fixed` | The root cause is addressed; the described failure can no longer occur. |
| `partially-fixed` | The reported symptom is gone but part of the class remains reachable. |
| `not-fixed` | The defect is still reachable. |
| `fixed-with-new-risk` | Fixed, but the fix introduces a new defect you are reporting. |

A disposition without concrete evidence (file:line, control-flow argument, or a
bounded probe) is not acceptable. Say what you actually checked.

**Report any NEW defect introduced by a fix**, at any severity, including
defects outside your finding set that you encounter in the changed code.

## Original findings (canonical)

`.metaproject/flows/001-2026-09-05-echolet-assessment-fixes/reviews/2026-09-06-path-echolet-cli-prototype-t28/consolidated-findings.json`

Twelve findings: 4 blocker, 7 major, 1 minor. The independent T28 verifier
confirmed 10, refuted 0, and could not verify F-003 and F-008 for lack of
deterministic hooks. Both have since been made deterministically reproducible
and fixed.

## Thirteenth finding, discovered during T37

**F-013 (blocker).** `apps/cli/src/commands/cli.ts` used Node `parseArgs` with
`strict: true`, which rejects any option value beginning with `-`. `identity_id`
is base64url, so roughly one identity in 64 begins with `-` and could not be
messaged at all; a `--text` beginning with `-` was also rejected. This is what
made the workspace suite intermittently red. Fixed in T39 by
`inlineStringOptionValues`, which rewrites `--<declared string option> <value>`
into the inline `--opt=value` form while keeping `strict: true`.

## Implementation reports

- `t33-implementation-report.md` — F-001, F-002, F-003, F-008 (CLI, plus an additive `packages/session-node` prekey-rotation capability)
- `t34-implementation-report.md` — F-004, F-005, F-006, F-007 (relay)
- `t35-implementation-report.md` — F-009, F-010, F-011 and the handed-over T34-I-003 (relay + CLI transport)
- `t39-implementation-report.md` — F-013 (CLI argument parsing)
- `t37-verification-report.md` — the verification matrix, attempt 2 first, attempt 1 preserved as superseded history

## Worker-reported concerns requiring an explicit disposition

These were raised by the implementers themselves and deliberately not silently
dropped. Each needs a judgement in this review.

| ID | Severity | Concern |
|---|---|---|
| `T34-I-001` | major | `BackfillDeviceMailboxBindings` runs from `NewRouter` on every start, idempotent and log-on-failure, but re-scans `device_record:*` each time with no completion marker. |
| `T34-I-002` | minor | See `001-T34-implement-result.json`. |
| `T34-I-003` | minor | Body limits were hand-chosen; handed to T35 and implemented as `cfg.MaxMessageBytes + 64 KiB`. Confirm the derivation is sound. |
| `T35-I-001` | minor | `ECHOLET_MAX_MESSAGE_BYTES` and the 1 MiB poll budget are independent settings with no enforced relationship; above ~1 MiB the relay would deliver envelopes the current CLI cannot read. Unreachable at the default 262144. |
| `T33-I2` | info | Prekey retention policy after rotation: superseded `pre:<n>` records are retained so in-flight PreKey sessions still resolve. Is unbounded retention acceptable for the prototype? |
| `T33-I3` | info | `PersistenceError` also covers "nested transaction" and "store closed" cases. |
| `T33-I4` | info | The F-008 concurrency barrier is test-only instrumentation on `EncryptedSqliteStore.prototype.transaction`. |
| `T39-Q1` | info | A fully successful send to a real identity whose base64url begins with `-` cannot be built deterministically, because `identity_id` derives from a generated key. Coverage instead proves the value reaches the trust layer verbatim plus end-to-end success for the same command shape. Is that boundary adequate? |

## Non-negotiable review criteria

1. **No test was weakened to make a fix pass.** The orchestrator verified by
   mtime in every wave that tests were written before the implementation and not
   edited afterwards, and T37 hash-verified 38 test files with 0 mismatches and
   zero skip/only/todo markers. Confirm independently for the code you review:
   a fix that required loosening an assertion is a finding.
2. **No strict schema was loosened to make a fix pass.** T35 widened the poll
   response `next_cursor` from always-null to `string|null`; the orchestrator
   required it stay a closed union on a `.strict()` object with no `.optional()`,
   no passthrough and no `any`, and unknown fields still rejected on both sides
   of the wire. Verify that, and verify the Go and TypeScript contracts agree.
3. **No secret leakage.** Confirm that plaintext message bodies, ciphertext,
   profile store keys, private key material and HTTP request bodies are not
   written to logs, diagnostics or error output by the new code. The persisted
   publication bundle (F-001) and the poll byte-budget code (F-009) are the
   places to look hardest.
4. **Exit-code contract intact.** 0 success, 2 input/configuration, 3
   trust/protocol, 4 temporary relay/network, 5 local persistence. F-003 added
   the exit-5 path and F-013 touched argument parsing; verify neither widened
   nor narrowed the others.
5. **Prototype scope respected.** This is a local computer CLI prototype. Do not
   raise findings demanding production hardening, mobile support, deployment or
   external audit; those are explicitly out of scope. Do raise anything that
   breaks the documented prototype contract.

## Output

Return a `subagent-result` whose `findings` array carries one entry per assigned
finding with its disposition and evidence, plus any new defects. The first line
of your final response must be `STATUS:`.
