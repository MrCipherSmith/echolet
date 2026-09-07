# Tasks

Task definitions live here; task **statuses** live in flow.json and are managed
only via `keryx flow task done <id> <taskId>`.

These four are created by `keryx flow init` as a default checklist. Add your
own with `keryx flow task add`; a scaffold row your plan supersedes is closed
with `--disposition skipped --reason "<why>"`, not left open.

| ID | Kind | Title |
|----|------|-------|
| T1 | context | Collect remaining context |
| T2 | implement | Implement per plan |
| T3 | test | Add/adjust tests and make them pass |
| T4 | review | Self-review and prepare draft PR |

## CLI prototype tasks

| ID | Kind | Title |
|----|------|-------|
| T22 | implement | Implement separate relay v2 publication and atomic one-time prekey claims with JS-Go fixtures |
| T31 | implement | Align relay v2 publish response with typed CLI contract |
| T32 | implement | Register v2 published devices for mailbox authorization |
| T23 | implement | Implement CLI profile configuration and mutually pinned contact cards |
| T24 | implement | Integrate CLI relay transport and durable send retry |
| T25 | implement | Implement CLI poll decrypt history and ack state machine |
| T30 | implement | Implement CLI command entrypoint and exit/error contract |
| T26 | test | Verify isolated two-process offline restart and idempotency scenario |
| T27 | verify | Run full prototype verification and Code Health gates |
| T28 | review | Independently review CLI prototype implementation |
| T29 | docs | Update prototype status and write change report |

## T28 review fix tasks

Fix wave for the twelve `REQUEST_CHANGES` findings recorded in
`reviews/2026-09-06-path-echolet-cli-prototype-t28/consolidated-findings.json`
(4 blocker, 7 major, 1 minor; 10 independently confirmed, F-003 and F-008
recorded as unverifiable for lack of deterministic hooks, none refuted).

| ID | Kind | Title | Findings |
|----|------|-------|----------|
| T33 | implement | Fix CLI publish retry confirmation persistence mapping and concurrent send | F-001, F-002, F-003, F-008 |
| T34 | implement | Fix relay mailbox immutability expiry request bounds and identity-scoped auth | F-004, F-005, F-006, F-007 |
| T35 | implement | Fix poll response capacity and relay rate limiting | F-009, F-010, F-011 |
| T36 | test | Pin typed unknown-sender rejection regression | F-012 |
| T37 | verify | Re-run full prototype verification after review fixes | full T27 matrix |
| T38 | review | Run managed fix review and close F-001 through F-012 dispositions | all |

Every implementation task runs RED tests from an independent `tests-creator`
worker first, then a separate `task-implementer`; the implementer never accepts
its own work. T29 documentation depends on a clean T38.

## Second remediation round

Added after the T38 fix review and the T42 verification found further defects.

| ID | Kind | Title | Findings |
|----|------|-------|----------|
| T39 | implement | Fix CLI option-value parsing for base64url identities and leading-dash text | F-013 |
| T40 | test | Repair and re-anchor fix-wave regression tests; add RED tests for confirmed T38 findings | T38-TP-001/002/003, MC10 gap, plus RED for HL-N-001, BE-R-001, HL-N-002 |
| T41 | implement | Fix confirmed T38 findings: poison-envelope wedge, unbounded identifier strings, cursor signal, docstring | HL-N-001, BE-R-001, HL-N-002, SEC-R-001 |
| T42 | verify | Re-run the full verification matrix after the T40/T41 round | — |
| T43 | test | Give the CLI suite deterministic timeout headroom | T42-F-001 |
| T44 | context | Diagnose the second-sender prekey claim failure | T44-001/002/003 |
| T45 | implement | Report exhausted prekey and no-op republish honestly | T44-001, T44-002 |

**Record correction — dispatch artifacts are crossed against T40/T41.** The
orchestrator created these two tasks in the order test-then-implement, so T40 is
the TEST task and T41 the IMPLEMENT task, but the dispatch artifacts were named
the other way round. The work itself was done correctly and by separate workers;
only the artifact names are inverted. To read the record:

- task **T40** (test work) is documented by `dispatches/001-T41-tests.json` and
  `dispatches/001-T41-tests-result.json`;
- task **T41** (implementation) is documented by `dispatches/001-T40-implement.json`,
  `dispatches/001-T40-implement-result.json` and `t40-implementation-report.md`.

The `dependsOn` direction was also inverted when first set and has been corrected
through the CLI to `T41 depends on T40`. This note exists so the final change
report does not inherit the mistake.
