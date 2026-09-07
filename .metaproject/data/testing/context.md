# Testing Context

generatedAt: 2026-09-06T09:22:42.514Z

## Frameworks

- vitest

## Scripts

- `test`: `pnpm -r test`

## Configs

- apps/mobile/tsconfig.json
- packages/client-core/tsconfig.json
- packages/client-db/tsconfig.json
- packages/crypto-core/tsconfig.json
- packages/protocol/tsconfig.json
- packages/session-node/tsconfig.json
- tsconfig.base.json

## Test Files

- apps/mobile/src/screens/MessagingScreen.test.mjs
- packages/client-core/src/identity/createIdentityProfile.test.ts
- packages/client-core/src/identity/createSignedPreKeyBundle.test.ts
- packages/client-db/src/index.test.ts
- packages/crypto-core/src/mailbox/auth.test.ts
- packages/crypto-core/src/session/session.test.ts
- packages/protocol/src/types/signalPreKeyBundleV2.test.ts
- packages/protocol/src/validators/validateDeviceRecord.test.ts
- packages/session-node/src/EncryptedSqliteStore.test.ts
- packages/session-node/src/SignalClient.test.ts
- packages/session-node/src/wire.test.ts


## CI

- none

## Conventions

- AGENTS.md: For commands, search, diff, test logs, lint/build output, and large file reads that can produce long output, use the Metaproject gdctx skill by default before loading raw command output into context.
- AGENTS.md: For creating, changing, debugging, reviewing, or running tests, use the Metaproject testing skill and read .metaproject/data/testing/context.md before broad test search or raw logs.
- CLAUDE.md: For commands, search, diff, test logs, lint/build output, and large file reads that can produce long output, use the Metaproject gdctx skill by default before loading raw command output into context.
- CLAUDE.md: For creating, changing, debugging, reviewing, or running tests, use the Metaproject testing skill and read .metaproject/data/testing/context.md before broad test search or raw logs.
- docs/API-11_JSON_SCHEMAS.md: 5. Есть ли negative test на invalid payload.
- docs/APP-03_MOBILE_CLIENT.md: Echolet: Frontend & Mobile Client Specification (APP-03)
- docs/ARCH-09_REPOSITORY_STRUCTURE.md: mobile-specific glue code;
- docs/ARCH-09_REPOSITORY_STRUCTURE.md: 8. CI/test scripts;
- docs/ARCH-09_REPOSITORY_STRUCTURE.md: `test:protocol`
- docs/ARCH-09_REPOSITORY_STRUCTURE.md: 16. Test layout
- docs/ARCH-09_REPOSITORY_STRUCTURE.md: Тесты располагаются рядом с файлами или в `__tests__`, но стиль должен быть единым на весь пакет.
- docs/ARCH-09_REPOSITORY_STRUCTURE.md: colocated tests, например `deriveMailboxId.test.ts` рядом с `deriveMailboxId.ts`.
- docs/ARCH-09_REPOSITORY_STRUCTURE.md: Тесты SHOULD лежать рядом с кодом в виде `*_test.go`.
- docs/BOARD-27_EXECUTION_ORDER.md: `TEST-16_ACCEPTANCE_CHECKLIST.md`
- docs/BOARD-27_EXECUTION_ORDER.md: Использовать `CHANGE-24_SPEC_CHANGE_CONTROL.md`.
- docs/BOARD-27_EXECUTION_ORDER.md: Если e2e работает, но нет доказательств -> `TEST-16` + `RUNBOOK-22`
- docs/BOOTSTRAP-15_REPO_INIT_GUIDE.md: "test": "pnpm -r test",
- docs/BOOTSTRAP-15_REPO_INIT_GUIDE.md: "vitest": "3.x"
- docs/BOOTSTRAP-15_REPO_INIT_GUIDE.md: "test": "vitest run"
- docs/BOOTSTRAP-15_REPO_INIT_GUIDE.md: `go test ./...` внутри `apps/relay`
- docs/CHANGE-24_SPEC_CHANGE_CONTROL.md: Echolet: Specification Change Control (CHANGE-24)
- docs/CHANGE-24_SPEC_CHANGE_CONTROL.md: 5. обновить backlog/taskpacks/tests;
- docs/CHANGE-24_SPEC_CHANGE_CONTROL.md: Требует обновления всех зависимых docs, tasks и tests до изменения кода.
- docs/CHANGE-24_SPEC_CHANGE_CONTROL.md: Affected tests:
- docs/CHANGE-24_SPEC_CHANGE_CONTROL.md: `TEST-16_ACCEPTANCE_CHECKLIST.md`
- docs/CHANGE-24_SPEC_CHANGE_CONTROL.md: acceptance and negative tests docs
- docs/CHANGE-24_SPEC_CHANGE_CONTROL.md: 4. после docs update обновить tests/taskpacks;
- docs/CHANGE-24_SPEC_CHANGE_CONTROL.md: Affected docs: SEC-01, REP-02, APP-03, STORY-04, PLAN-05, PROTOCOL-07, THREAT-08, API-11, DELIVERY-13, STACK-14, RFC-18, OPS-23, BOARD-27, TEST-16, status entrypoints and linked taskpack prerequisites.
- docs/CHANGE-24_SPEC_CHANGE_CONTROL.md: Affected docs: RFC-18, STACK-14, TRACE-25, STATUS_CURRENT, package README, flow official-session-spec.md and verification report.
- docs/CHANGE-24_SPEC_CHANGE_CONTROL.md: Tests: persistent sessions, explicit trust rejection, replay/tamper, exact retries, transaction rollback/concurrency, process SIGKILL and Unicode content-id regression.

## Recommendations

- No CI test workflow detected. Add CI gate separately from local Metaproject hooks.
