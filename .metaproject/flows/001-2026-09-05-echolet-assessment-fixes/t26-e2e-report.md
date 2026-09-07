# T26 real relay and CLI end-to-end evidence
Version: 0.1.0

Implemented the accepted CLI prototype's networked proof using one reusable scenario repeated across three fresh relay databases, two independent profile directories and two independent environment-only store keys per run. Every CLI action starts a new Node process. The harness imports no runtime for session setup or message processing; its sole store import reads native state for equality assertions.

## Changes

- `apps/cli/test/e2e/two-process.test.ts`: real compiled Go relay, exact-byte loopback forwarding proxy, separate CLI children, bounded startup/execution/teardown, fresh temporary state, automatic cleanup.
- `apps/cli/src/commands/cli.ts`: optional `send --message-id <uuid>` retains the random default and enables exact user-directed retry across processes; malformed IDs reject before runtime/network access.
- `apps/cli/package.json`: `test:e2e` script.
- `apps/relay/internal/storage/repository/mailbox_repo.go`: an empty mailbox returns an allocated empty slice, serialized as `[]`. This fixes the proven mismatch with the strict TS response contract. Parent explicitly accepted this scope extension.

## RED and GREEN

The first real integration run reached mutual trust and both v2 publications, then all three cases failed because send rejected the new retry flag (exit2 rather than expected network failure4). Evidence: `.metaproject/data/gdctx/raw/2026-09-06T11-57-02-836Z_run.log`.

After the flag addition, runs reached receiver ack recovery; the relay emitted `envelopes:null` for the emptied mailbox and strict client validation rejected it. Evidence: `.metaproject/data/gdctx/raw/2026-09-06T11-57-45-904Z_run.log`. The relay now emits `[]`; no TS validation or E2E assertions were weakened.

Focused command: `pnpm --filter @echolet/cli test:e2e`.

Result: **3/3 clean real runs PASS**, 41.29 seconds. Evidence: `.metaproject/data/gdctx/raw/2026-09-06T12-00-40-906Z_run.log`.

Each run proves:

- mutual contact-card import and v2 HTTP publication before first send;
- offline Bob delivery followed by a fresh Bob process decrypting the first message;
- proxy forwards and accepts send, drops its response, then a fresh Alice retries the same message ID with byte-identical serialized envelope/ciphertext and no second claim;
- proxy drops a successful ack response; a fresh Bob preserves history/native state and retries the pending ack;
- exact ciphertext redelivery under another envelope ID is acknowledged without native-session advancement or a duplicate history entry;
- Bob replies through the relay and Alice decrypts; both encrypted histories survive command-process restarts with exactly two chronological entries;
- changed ciphertext under the received message ID fails with no ack or history insertion;
- relay traffic, captured relay logs, relay data files and non-history CLI outputs contain no known plaintext/store-key markers.

## Regression verification

- `keryx test run --strict`: normalized PASS, 68.541 seconds. Raw workspace totals **82 tests**, including CLI37 (34 prior plus3 E2E). Its three E2E cases also passed again. The normalized report's count2 is an aggregation artifact; actual per-package counts are recorded in `.metaproject/data/gdctx/raw/2026-09-06T12-02-51-210Z_rg.log`.
- `pnpm typecheck`: all seven workspace packages PASS; `.metaproject/data/gdctx/raw/2026-09-06T12-01-38-532Z_run.log`.
- Standalone strict TypeScript check of the E2E file: PASS. This explicitly checks the file outside the package's src-only tsconfig include.
- `GOCACHE="$PWD/.gocache" go -C apps/relay test -race -tags=relayv2 -timeout=90s ./...`: PASS after the relay fix; `.metaproject/data/gdctx/raw/2026-09-06T12-01-35-426Z_run.log`.
- Graph rebuilt:70 nodes,104 edges; no cycles.
- Required health command returned PASS97 but skipped requested eslint/TypeScript sources. Direct compiler checks above supply actual type evidence. Lint remains unavailable. Full normalized workspace testing was used because changed-test routing is already proven incompatible with this recursive workspace runner.

## Limits

This is a local Node/Go technical prototype. The test exercises command-process restart and deliberate response loss; it does not establish mobile behavior, product demand, public deployment safety or an independent crypto audit. Relay marker scanning is a bounded leakage assertion, not a complete metadata/security audit. Temporary profile keys and plaintext are neither persisted in reports nor rendered by assertions. No commits, flow state, frozen acceptance criteria or mobile files were changed.

Routing: graph_used=yes; wiki_used=previous index/draft plus accepted spec; ctx_used=yes; raw_rg_used=no.
