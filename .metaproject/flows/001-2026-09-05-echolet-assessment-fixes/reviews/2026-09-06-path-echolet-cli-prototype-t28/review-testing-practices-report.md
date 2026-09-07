STATUS: DONE

# Testing practices review

One minor finding. Four isolated mutations executed; three killed and one survived. Canonical selected files remained unchanged.

## Mutation table

| Mutation | Baseline | Mutated nearest suite | Outcome |
|---|---|---|---|
| confirmation | 6/6 green | 5 passed, 1 failed; exit 1 | killed |
| inbound-trusted-peer | 10/10 green | 10 passed, 0 failed; exit 0 | survived |
| duplicate-content | 10/10 green | 9 passed, 1 failed; exit 1 | killed |
| poll-minimum | 3/3 green | 2 passed, 1 failed; exit 1 | killed |

Copied CLI tree; symlinked existing dependencies, mutated only local runtime sources one at a time; captured all stdout/stderr in memory; restored each local file before next mutation.

The initial confirmation baseline could not resolve relative package imports and loaded zero tests. It was repaired in a fresh copy before its mutation; the repaired baseline passed6/6.

Four-gate budget. Other modules and additional schema predicates were not exhaustively enumerated or mutated;21 other if-sites in profile/inbound/config were omitted. No prior-round gates were supplied.

## [F-001] Unknown-sender rejection test does not pin the explicit CONTACT_NOT_TRUSTED guard.

- Severity: minor
- Location: `apps/cli/src/runtime/inbound.test.ts:167`
- Impact: Deleting the dedicated missing-contact guard still leaves the nearest suite green: the later decode of a missing value rejects, satisfying rejects.toThrow. A future edit can remove the intended typed trust rejection unnoticed, although the current mutant still fails closed.
- Evidence: Isolated deletion of inbound.ts:50 ran inbound.test.ts with exit0 and10/10 tests passing; unmodified baseline also10/10. Test at inbound.test.ts:167 only asserts rejects.toThrow. Removing confirmation, duplicate-hash and batch-minimum gates in the same bounded pass caused1 focused failure each, demonstrating the harness detects real assertion failures.
- Fix: Assert the public rejection code CONTACT_NOT_TRUSTED for the unknown-sender fixture, while retaining unchanged-state and no-ack assertions. Keep changed-device and malformed-data cases distinct so each names its own intended failure.

## Checked and cleared

- Contact confirmation can be ignored without test detection. Deleted the false-confirmation guard at profile.ts:105 in the temporary copy: baseline6/6 green; mutant5 passed/1 failed.
- Duplicate ciphertext content binding is not tested. Deleted inbound.ts:63 hash-conflict guard: baseline10/10 green; mutant9 passed/1 failed.
- The minimum polling batch size is merely schema decoration. Removed min(1) from poll_batch_size: baseline3/3 green; mutant2 passed/1 failed.
- Networked E2E silently substitutes in-process session setup. two-process.test.ts spawns actual CLI command processes and local Go relay, exchanges contact cards, and observes network requests; native snapshots are read only for assertions. Test validates offline send, lost response, restart, ack recovery and replay.
- Runtime tests can escape to arbitrary external services. Inbound/outbound provide explicit fetch boundary fakes whose unrecognized routes throw; process/E2E servers bind dynamically allocated loopback ports and include cleanup/deadlines.
- Failed mutation assertions leak fixture material into review artifacts. All subprocess stdout/stderr was captured in memory; only exit codes and aggregate counts were emitted/persisted. No raw failing assertion logs or request bodies were saved.

## Limits

- Initial profile baseline in first temporary copy loaded0 tests due to absent relative packages path. This was a harness problem, corrected with a packages dependency symlink in a fresh copy; successful6-test baseline and red mutation then ran.
- No full regressions were repeated; T27 supplies broad verification evidence.
- Canonical6 selected source/test files were hashed before/after and unchanged; temporary CLI copies were removed. Other canonical sources were only read via dependencies; parent retains full canonical hashes.
- Related-test intelligence returned none for inbound, so the explicit colocated suite was selected after graph/context routing.

Routing: graph_used: inbound test affected; wiki_used: index (testing page unavailable); ctx_used: read/rg and safe in-memory mutation capture; raw_rg_used: no.
