# Testing Context

generatedAt: 2026-09-09T09:35:06.144Z

## Frameworks

- vitest

## Scripts

- `gate:selftest`: `sh scripts/gate/selftest.sh`
- `test`: `pnpm -r test`
- `test:go`: `sh scripts/gate/go-tests.sh`

## Configs

- apps/cli/tsconfig.json
- apps/cli/vitest.config.ts
- apps/mobile/tsconfig.json
- packages/client-core/tsconfig.json
- packages/client-db/tsconfig.json
- packages/crypto-core/tsconfig.json
- packages/protocol/tsconfig.json
- packages/session-node/tsconfig.json
- tsconfig.base.json

## Test Files

- apps/cli/src/commands/cli.dashOptionValues.test.ts
- apps/cli/src/commands/cli.doctorContacts.test.ts
- apps/cli/src/commands/cli.doctorOffline.test.ts
- apps/cli/src/commands/cli.processFailures.test.ts
- apps/cli/src/commands/cli.relayErrorCodes.test.ts
- apps/cli/src/commands/cli.sendEmptyText.test.ts
- apps/cli/src/commands/cli.sendStdin.test.ts
- apps/cli/src/commands/cli.senderQuota.test.ts
- apps/cli/src/commands/cli.test.ts
- apps/cli/src/runtime/config.test.ts
- apps/cli/src/runtime/inbound.batchIsolation.test.ts
- apps/cli/src/runtime/inbound.pollBatchSize.test.ts
- apps/cli/src/runtime/inbound.pollProgress.test.ts
- apps/cli/src/runtime/inbound.readMark.test.ts
- apps/cli/src/runtime/inbound.test.ts
- apps/cli/src/runtime/outbound.claimResidual.test.ts
- apps/cli/src/runtime/outbound.concurrentSend.test.ts
- apps/cli/src/runtime/outbound.publicationPool.test.ts
- apps/cli/src/runtime/outbound.publicationPrecondition.test.ts
- apps/cli/src/runtime/outbound.publish.test.ts
- apps/cli/src/runtime/outbound.senderAuthentication.test.ts
- apps/cli/src/runtime/outbound.test.ts
- apps/cli/src/runtime/profile.publicationPool.test.ts
- apps/cli/src/runtime/profile.test.ts
- apps/cli/src/transport/relayClient.claimable.test.ts
- apps/cli/src/transport/relayClient.loopbackHostname.test.ts
- apps/cli/src/transport/relayClient.pollCapacity.test.ts
- apps/cli/src/transport/relayClient.prekeyUnavailable.test.ts
- apps/cli/src/transport/relayClient.protocolMirror.test.ts
- apps/cli/src/transport/relayClient.responseBoundDerivation.test.ts
- apps/cli/src/transport/relayClient.senderQuota.test.ts
- apps/cli/src/transport/relayClient.sizeSymmetry.test.ts
- apps/cli/src/transport/relayClient.test.ts
- apps/cli/src/tui/cli-bridge.sendStdin.test.ts
- apps/cli/src/tui/cli-bridge.test.ts
- apps/cli/src/tui/failure-text.test.ts
- apps/cli/src/tui/history-pane.readable.test.ts
- apps/cli/src/tui/history-pane.test.ts
- apps/cli/src/tui/mailbox-pane.test.ts
- apps/cli/src/tui/main.argvEscape.test.ts
- apps/cli/src/tui/main.processDriven.test.ts
- apps/cli/src/tui/main.registration.processDriven.test.ts
- apps/cli/src/tui/main.sendChild.test.ts
- apps/cli/src/tui/modal-host.test.ts
- apps/cli/src/tui/profiles-pane.rosterClaim.test.ts
- apps/cli/src/tui/profiles-pane.setup.test.ts
- apps/cli/src/tui/profiles-pane.test.ts
- apps/cli/src/tui/shell-chrome.input.test.ts
- apps/cli/src/tui/shell-chrome.legend.test.ts
- apps/cli/src/tui/shell-chrome.overflow.test.ts
- apps/cli/src/tui/shell-chrome.recency.test.ts
- apps/cli/src/tui/shell-chrome.test.ts
- apps/cli/src/tui/tui-shell.exitClassMatrix.test.ts
- apps/cli/src/tui/tui-shell.externalText.test.ts
- apps/cli/src/tui/tui-shell.externalTextViewport.test.ts
- apps/cli/src/tui/tui-shell.input.test.ts
- apps/cli/src/tui/tui-shell.inputTrustExclusion.test.ts
- apps/cli/src/tui/tui-shell.inputViewport.test.ts
- apps/cli/src/tui/tui-shell.keystrokeDispatch.test.ts
- apps/cli/src/tui/tui-shell.outcomeEscape.test.ts
- apps/cli/src/tui/tui-shell.registration.test.ts
- apps/cli/src/tui/tui-shell.singleFlight.test.ts
- apps/cli/src/tui/tui-shell.smallViewport.test.ts
- apps/cli/src/tui/tui-shell.storeTruth.test.ts
- apps/cli/src/tui/tui-shell.submitSingleFlight.test.ts
- apps/cli/src/tui/tui-shell.test.ts
- apps/cli/src/tui/tui-shell.trustViewport.test.ts
- apps/cli/src/tui/tui-shell.wayOut.test.ts
- apps/cli/src/tui/tui.keyMaterial.test.ts
- apps/cli/test/e2e/console-real-cli.test.ts
- apps/cli/test/e2e/flood-closure.test.ts
- apps/cli/test/e2e/init-relay-url.test.ts
- apps/cli/test/e2e/prekey-pool-replenishment.test.ts
- apps/cli/test/e2e/publication-claimability.test.ts
- apps/cli/test/e2e/relay-tls.test.ts
- apps/cli/test/e2e/rewalk-crash-safety.test.ts
- apps/cli/test/e2e/two-process.test.ts
- apps/mobile/src/screens/MessagingScreen.test.mjs
- packages/client-core/src/identity/createIdentityProfile.test.ts
- packages/client-core/src/identity/createSignedPreKeyBundle.test.ts

- ... 11 more

## CI

- none

## Conventions

- AGENTS.md: For commands, search, diff, test logs, lint/build output, and large file reads that can produce long output, use the Metaproject gdctx skill by default before loading raw command output into context.
- AGENTS.md: For creating, changing, debugging, reviewing, or running tests, use the Metaproject testing skill and read .metaproject/data/testing/context.md before broad test search or raw logs.
- CLAUDE.md: For commands, search, diff, test logs, lint/build output, and large file reads that can produce long output, use the Metaproject gdctx skill by default before loading raw command output into context.
- CLAUDE.md: For creating, changing, debugging, reviewing, or running tests, use the Metaproject testing skill and read .metaproject/data/testing/context.md before broad test search or raw logs.
- docs/API-11_JSON_SCHEMAS.md: is specified in [PROTOCOL-30](PROTOCOL-30_SIGNAL_BUNDLE_V2.md); only the request
- docs/API-11_JSON_SCHEMAS.md: [specification](requirements/echolet-cli-prototype/specification.md).
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

## Recommendations

- No CI test workflow detected. Add CI gate separately from local Metaproject hooks.
