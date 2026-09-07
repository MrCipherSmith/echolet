# Echolet: MVP Implementation Backlog (TASKS-10)

> Порядок исполнения обновлён flow 001: сначала G0 из [DELIVERY-13](DELIVERY-13_SPRINT_PLAN.md) и проверка [RFC-18](RFC-18_CRYPTO_SELECTION.md). Номера задач сохранены для трассируемости, но выбор библиотеки J-001 выполняется на G0, а не после остальных пакетов. До закрытия G0 разрешены только изолированные feasibility harness/исправления безопасности и документов; основная реализация messaging ждёт доказательств. Текущая готовность — [STATUS_CURRENT](STATUS_CURRENT.md).

## 1. Назначение документа
Этот документ разбивает Echolet MVP на атомарные задачи. Каждая задача должна быть достаточно маленькой, чтобы ее могла реализовать даже слабая модель без архитектурных догадок.

Формат каждой задачи:

* `ID`
* `Цель`
* `Файлы`
* `Шаги`
* `Проверка`

Все задачи упорядочены по зависимостям. Их нельзя брать в случайном порядке.

---

## 2. Этап A — Workspace и базовая структура

### A-001. Создать корневой workspace
**Цель:** подготовить monorepo-структуру.

**Файлы:**
* `package.json`
* `pnpm-workspace.yaml`
* `.gitignore`
* `.editorconfig`

**Шаги:**
1. Создать root `package.json`.
2. Добавить workspace-конфиг.
3. Добавить базовые scripts-заглушки.
4. Добавить `.gitignore` для Node, Expo, Go, SQLite, env-файлов.

**Проверка:**
* workspace команды запускаются без синтаксических ошибок.

### A-002. Создать папки монорепы
**Цель:** создать минимальный каркас директорий.

**Файлы:** только директории.

**Шаги:**
1. Создать `apps/mobile`.
2. Создать `apps/relay`.
3. Создать `packages/protocol`.
4. Создать `packages/crypto-core`.
5. Создать `packages/client-db`.
6. Создать `packages/client-core`.

**Проверка:**
* структура совпадает с `ARCH-09_REPOSITORY_STRUCTURE.md`.

### A-003. Настроить TypeScript base config
**Цель:** зафиксировать единые настройки TS.

**Файлы:**
* `tsconfig.base.json`
* package-level `tsconfig.json`

**Шаги:**
1. Создать базовый tsconfig.
2. Подключить его в TS-пакетах.
3. Проверить, что алиасы не ломают импорт.

**Проверка:**
* `tsc --noEmit` проходит для пустых пакетов.

---

## 3. Этап B — Protocol package

### B-001. Создать protocol constants
**Цель:** зафиксировать protocol version, лимиты и error codes.

**Файлы:**
* `packages/protocol/src/constants/protocolVersion.ts`
* `packages/protocol/src/constants/limits.ts`
* `packages/protocol/src/constants/errorCodes.ts`

**Шаги:**
1. Добавить `PROTOCOL_VERSION = 1`.
2. Добавить лимиты из `PROTOCOL-07_MVP_MESSAGE_FLOW.md`.
3. Добавить перечисление error codes.

**Проверка:**
* константы импортируются без циклических зависимостей.

### B-002. Описать тип `DeviceRecord`
**Файлы:**
* `packages/protocol/src/types/deviceRecord.ts`

**Шаги:**
1. Описать TS type по спеке.
2. Экспортировать type.

**Проверка:**
* type покрывает все обязательные поля.

### B-003. Описать схему `DeviceRecord`
**Файлы:**
* `packages/protocol/src/schemas/deviceRecordSchema.ts`

**Шаги:**
1. Создать runtime schema.
2. Проверить `type`, `version`, обязательные поля.

**Проверка:**
* valid payload проходит;
* invalid payload отклоняется.

### B-004. Реализовать `validateDeviceRecord`
**Файлы:**
* `packages/protocol/src/validators/validateDeviceRecord.ts`
* `packages/protocol/src/validators/validateDeviceRecord.test.ts`

**Шаги:**
1. Обернуть schema в удобную функцию.
2. Вернуть typed result.
3. Написать тесты.

**Проверка:**
* 1 happy-path тест;
* 2 invalid tests.

### B-005. Описать тип и схему `PreKeyBundle`
**Файлы:**
* `packages/protocol/src/types/preKeyBundle.ts`
* `packages/protocol/src/schemas/preKeyBundleSchema.ts`
* `packages/protocol/src/validators/validatePreKeyBundle.ts`

**Шаги:**
1. Описать структуру signed prekey.
2. Описать one-time prekeys.
3. Добавить validator.

**Проверка:**
* валидный bundle принимается;
* истекший `expires_at_ms` отклоняется validator'ом, если проверка реализована на runtime layer.

### B-006. Описать тип и схему `MailboxEnvelope`
### B-007. Описать тип и схему `ChatMessage`
### B-008. Описать тип и схему `Receipt`
### B-009. Описать relay API request/response types

Для задач B-006..B-009 применять тот же шаблон:

* type;
* schema;
* validator;
* happy-path test;
* invalid-path test.

---

## 4. Этап C — Crypto core

### C-001. Реализовать base64url helpers
**Файлы:**
* `packages/crypto-core/src/encoding/base64url.ts`
* тесты рядом

**Шаги:**
1. encode bytes -> base64url.
2. decode base64url -> bytes.
3. Проверить roundtrip.

**Проверка:**
* roundtrip test passes.

### C-002. Реализовать canonical JSON serializer
**Файлы:**
* `packages/crypto-core/src/signatures/canonicalJson.ts`

**Шаги:**
1. Удалять поле `signature`.
2. Сортировать ключи по ASCII.
3. Возвращать стабильную строку.

**Проверка:**
* одинаковый объект всегда сериализуется одинаково.

### C-003. Реализовать подпись canonical JSON
### C-004. Реализовать verify canonical JSON

### C-005. Реализовать генерацию seed
**Файлы:**
* `packages/crypto-core/src/identity/generateSeed.ts`

**Шаги:**
1. Использовать надежный RNG.
2. Вернуть массив/строку из 24 слов.

**Проверка:**
* результат содержит 24 слова.

### C-006. Реализовать deriveIdentityKeyPair
### C-007. Реализовать generateCallsign
### C-008. Реализовать generateDeviceId
### C-009. Реализовать generateDeviceKeyPair
### C-010. Реализовать signDeviceRecord
### C-011. Реализовать verifyDeviceRecord
### C-012. Реализовать deriveMailboxId
### C-013. Реализовать signMailboxChallenge
### C-014. Реализовать safetyNumber helper

Для задач C-006..C-014 действуют те же правила:

* одна функция на файл;
* unit test обязательно;
* failure test, если применимо.

---

## 5. Этап D — Client DB

### D-001. Создать db adapter abstraction
**Файлы:**
* `packages/client-db/src/db.ts`

**Цель:** спрятать конкретную SQLite-библиотеку за простым интерфейсом.

### D-002. Описать schema `contacts`
### D-003. Описать schema `messages`
### D-004. Описать schema `sessions`
### D-005. Описать schema `outbox`
### D-006. Описать schema `receipts`
### D-007. Описать schema `relayConfig`

### D-008. Реализовать `contactsRepository`
### D-009. Реализовать `messagesRepository`
### D-010. Реализовать `sessionsRepository`
### D-011. Реализовать `outboxRepository`
### D-012. Реализовать `receiptsRepository`
### D-013. Реализовать `relayConfigRepository`

Для задач D-008..D-013:

**Шаги:**
1. Описать интерфейс.
2. Реализовать CRUD.
3. Написать repository tests.

---

## 6. Этап E — Client core identity and contacts

### E-001. Реализовать `createIdentityProfile`
**Файлы:**
* `packages/client-core/src/identity/createIdentityProfile.ts`

**Шаги:**
1. Вызвать seed generation.
2. Derive identity keys.
3. Generate device id and keys.
4. Generate callsign.
5. Создать `Signed Device Record`.
6. Сохранить результат через secure storage + db repositories.

**Проверка:**
* profile создается end-to-end в unit/integration test.

### E-002. Реализовать `loadIdentityProfile`
### E-003. Реализовать `exportQrContact`
### E-004. Реализовать `importQrContact`
### E-005. Реализовать `verifyContact`
### E-006. Реализовать `importInvite`

---

## 7. Этап F — Relay server foundation

### F-001. Создать `main.go` и bootstrap config
### F-002. Реализовать config loader
### F-003. Реализовать structured logger
### F-004. Реализовать HTTP router
### F-005. Реализовать health endpoint
### F-006. Реализовать request id middleware
### F-007. Реализовать recover middleware
### F-008. Реализовать rate limit middleware

Каждая задача должна включать тест или ручную проверку curl.

---

## 8. Этап G — Relay storage

### G-001. Реализовать `device_record_repo.go`
### G-002. Реализовать `prekey_repo.go`
### G-003. Реализовать `mailbox_repo.go`
### G-004. Реализовать `challenge_repo.go`

Для каждой задачи:

* создать интерфейс;
* создать Badger implementation;
* покрыть тестом запись/чтение/удаление.

---

## 9. Этап H — Relay services and handlers

### H-001. Реализовать `device_record_service.go`
### H-002. Реализовать handler `POST /v1/device-records/publish`
### H-003. Реализовать `prekey_service.go`
### H-004. Реализовать handler `POST /v1/prekeys/publish`
### H-005. Реализовать handler `GET /v1/prekeys/:identityId`
### H-006. Реализовать `mailbox_service.go`
### H-007. Реализовать handler `POST /v1/messages/send`
### H-008. Реализовать `challenge_service.go`
### H-009. Реализовать handler `POST /v1/mailbox/challenge`
### H-010. Реализовать handler `POST /v1/mailbox/poll`
### H-011. Реализовать handler `POST /v1/mailbox/ack`
### H-012. Реализовать `cleanup_service.go`

---

## 10. Этап I — Client relay integration

### I-001. Реализовать `relayApi.ts`
**Файлы:**
* `apps/mobile/src/services/relayApi.ts`

**Шаги:**
1. Создать typed HTTP client.
2. Поддержать все endpoints MVP.
3. Нормализовать API errors.

### I-002. Реализовать `publishDeviceRecord`
### I-003. Реализовать `publishPreKeyBundle`
### I-004. Реализовать `fetchPreKeyBundles`
### I-005. Реализовать `sendEnvelope`
### I-006. Реализовать `createMailboxChallenge`
### I-007. Реализовать `pollMailbox`
### I-008. Реализовать `ackMailbox`

---

## 11. Этап J — Sessions and messaging

### J-001. Выбрать и зафиксировать crypto session library
**Цель:** выбрать одну библиотеку для bootstrap + ratchet.

**Проверка:**
* decision записан в README модуля.

### J-002. Реализовать adapter `createOutboundSession`
### J-003. Реализовать adapter `createInboundSession`
### J-004. Реализовать `saveSession`
### J-005. Реализовать `loadSession`
### J-006. Реализовать `createChatMessage`
### J-007. Реализовать `encryptOutgoingMessage`
### J-008. Реализовать `decryptIncomingEnvelope`
### J-009. Реализовать `queueOutgoingMessage`
### J-010. Реализовать `markMessageRelayed`
### J-011. Реализовать `markMessageDelivered`
### J-012. Реализовать `processReceipt`

---

## 12. Этап K — Mailbox orchestration

### K-001. Реализовать `runMailboxPollCycle`
**Шаги:**
1. Вычислить mailbox id.
2. Запросить challenge.
3. Подписать challenge.
4. Запросить envelopes.
5. Передать batch в processor.
6. Отправить ack для успешных envelope.

### K-002. Реализовать `processMailboxBatch`
### K-003. Реализовать `quarantineEnvelope`
### K-004. Реализовать dedup по `message_id`
### K-005. Реализовать poisoned-envelope retry limit

---

## 13. Этап L — Mobile UI

### L-001. Создать app navigation skeleton
### L-002. Создать `OnboardingScreen.tsx`
### L-003. Создать `SeedBackupScreen.tsx`
### L-004. Создать `ContactsScreen.tsx`
### L-005. Создать `ChatListScreen.tsx`
### L-006. Создать `ChatScreen.tsx`
### L-007. Создать `TerminalScreen.tsx`
### L-008. Создать `SettingsScreen.tsx`

Для каждого экрана:

* сначала заглушка;
* потом подключение одного use case;
* потом тест/ручная проверка render без crash.

---

## 14. Этап M — Reliability and hardening

### M-001. Реализовать retry/backoff для outbox
### M-002. Реализовать receipt send on successful decrypt
### M-003. Реализовать relay quotas
### M-004. Реализовать relay TTL cleanup job
### M-005. Реализовать prekey refill threshold check
### M-006. Реализовать app biometric lock integration
### M-007. Реализовать manual purge conversation
### M-008. Реализовать terminal diagnostics store

---

## 15. Этап N — Тесты и интеграция

### N-001. Написать e2e: create identity
### N-002. Написать e2e: publish device record
### N-003. Написать e2e: publish and fetch prekey bundle
### N-004. Написать e2e: import contact via QR
### N-005. Написать e2e: first encrypted message
### N-006. Написать e2e: mailbox poll and ack
### N-007. Написать e2e: delivered receipt
### N-008. Написать negative test: invalid signature rejected
### N-009. Написать negative test: expired challenge rejected
### N-010. Написать negative test: oversize payload rejected
### N-011. Написать negative test: decrypt failure quarantined

---

## 16. Правила выполнения backlog

### 16.1. Один task = один commit или один PR-sized change
Не объединять 10 задач в одну реализацию.

### 16.2. Каждый task должен завершаться проверкой
Если невозможно автоматизировать тест, нужна четкая ручная проверка.

### 16.3. Нельзя перескакивать зависимости
Например, нельзя делать `J-007 encryptOutgoingMessage`, пока не готовы типы, session adapter и outbox storage.

---

## 17. Минимальный путь до первого demo
Если нужно как можно быстрее получить рабочий demo flow, брать задачи в таком порядке:

1. `A-001..A-003`
2. `B-001..B-009`
3. `C-001..C-014`
4. `D-001..D-013`
5. `E-001..E-005`
6. `F-001..F-008`
7. `G-001..G-004`
8. `H-001..H-011`
9. `I-001..I-008`
10. `J-001..J-012`
11. `K-001..K-005`
12. `L-001..L-006`
13. `N-001..N-007`

Это и будет минимальный путь до первой сквозной демонстрации MVP.
