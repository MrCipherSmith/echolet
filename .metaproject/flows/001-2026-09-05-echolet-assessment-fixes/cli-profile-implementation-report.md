# CLI profile implementation report
Version: 0.1.0

Task: T23. Agent: task-implementer 1.3.0. Date: 2026-09-06.

Implemented the reviewed profile/config/contact APIs in `apps/cli`, with workspace dependencies and typecheck/test scripts. No CLI commands or transport were added. The existing nine tests were unchanged.

Configuration rejects unknown fields, invalid limits, non-loopback HTTP, URL credentials and malformed/noncanonical store keys. Public configuration is written exclusively through a complete temporary file; an existing configuration is never overwritten. Missing databases for existing profiles and wrong decryption keys fail closed.

An encrypted metadata record retains the root seed and exact signed DeviceRecord. Native identity creation and metadata creation share one transaction. Contact validation uses the strict wire schema and the existing verified importer, including native signatures, before explicit confirmation of all four public identifiers. Contact metadata and native trust pins commit together using a transaction-scoped adapter around the existing SignalClient API. Confirmation runs outside the database transaction, and its input is an immutable copy. A conflicting contact cannot replace the stored pin. Summary/diagnostics return a public-field allowlist.

## Evidence

- RED: focused command failed because config/profile modules were absent; `.metaproject/data/gdctx/raw/2026-09-06T10-40-29-116Z_run.log`.
- GREEN: all nine focused tests pass; `.metaproject/data/gdctx/raw/2026-09-06T10-43-55-615Z_run.log`.
- One repair: readStoreKey initially returned Buffer; corrected to an owned Uint8Array without changing the test.
- CLI and full workspace typecheck pass (seven packages); `.metaproject/data/gdctx/raw/2026-09-06T10-44-11-027Z_run.log`.
- `keryx test run --strict`: normalized PASS; actual workspace log contains 54 passing tests (protocol 8, client-db 1, crypto-core 4, client-core 2, session-node 24, mobile 6, CLI 9). The normalized count of 2 is an aggregation artifact, not the number of test cases.
- Mandatory changed-test command failed because root-relative test paths were forwarded into each recursive package command, where protocol found no files. Full normalized workspace execution passed instead.
- Graph rebuilt: 60 nodes, 83 edges; no cycles.
- Mandatory health command returned PASS/99 but skipped both requested eslint and TypeScript sources. Direct typecheck provides the actual type evidence. `pnpm lint` reports no package has a lint script; lint is unavailable.

## Limits and ownership

Files created: apps/cli/package.json, apps/cli/tsconfig.json, apps/cli/src/runtime/config.ts, apps/cli/src/runtime/profile.ts. pnpm-lock.yaml gained the CLI importer. Existing dependencies were reused; no packages were downloaded during successful installation. The first offline installation failed because metadata was not cached.

No commits, flow-state edits, relay/protocol edits, production or mobile claims. Independent reviewer/verifier acceptance remains the parent flow's responsibility. The callback API deliberately throws/rejects to match the supplied tests and existing session APIs; configuration/profile-specific rejections have named error classes. This new CLI module has no matching generated project skill yet.

Routing: graph_used=yes (affected, build, cycles); wiki_used=yes (index and session module draft); ctx_used=yes (commands, reads, searches); raw_rg_used=no.
