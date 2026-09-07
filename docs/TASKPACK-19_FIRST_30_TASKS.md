# Echolet: Task Pack for the First 30 Atomic Tasks (TASKPACK-19)

> Порядок исполнения обновлён flow 001: сначала G0 из [DELIVERY-13](DELIVERY-13_SPRINT_PLAN.md) и проверка [RFC-18](RFC-18_CRYPTO_SELECTION.md). Номера задач сохранены для трассируемости, но выбор библиотеки J-001 выполняется на G0, а не после остальных пакетов. До закрытия G0 разрешены только изолированные feasibility harness/исправления безопасности и документов; основная реализация messaging ждёт доказательств. Текущая готовность — [STATUS_CURRENT](STATUS_CURRENT.md).

## 1. Назначение документа
Этот документ разворачивает первые задачи из `TASKS-10_IMPLEMENTATION_BACKLOG.md` в максимально конкретный формат для слабой модели.

Каждый task pack содержит:

* цель;
* зависимости;
* входы;
* файлы;
* пошаговые действия;
* что запрещено делать;
* expected output;
* проверку.

---

## 2. Как использовать task pack
Брать только один task pack за раз. После выполнения:

1. запускать review-pass из `PROMPTS-17_AGENT_PROMPTS.md`;
2. при необходимости делать fix-pass;
3. только после этого переходить к следующему task pack.

---

## 3. TP-001 = A-001 Root workspace

### Цель
Создать корневой workspace для монорепы.

### Зависимости
Нет.

### Входы
* `ARCH-09_REPOSITORY_STRUCTURE.md`
* `STACK-14_TECH_DECISIONS.md`
* `BOOTSTRAP-15_REPO_INIT_GUIDE.md`

### Файлы
* `package.json`
* `pnpm-workspace.yaml`
* `.gitignore`
* `.editorconfig`

### Шаги
1. Создать root `package.json`.
2. Добавить `private: true`.
3. Добавить `packageManager: pnpm@10`.
4. Добавить базовые scripts.
5. Создать `pnpm-workspace.yaml`.
6. Добавить в workspace `apps/*` и `packages/*`.
7. Создать `.gitignore` для Node, Expo, Go, SQLite, `.env`.
8. Создать `.editorconfig`.

### Запрещено
* создавать приложения;
* добавлять зависимости для business logic;
* менять структуру монорепы.

### Expected output
Есть рабочий workspace root.

### Проверка
* `pnpm install` не падает синтаксически;
* файлы созданы в корне.

---

## 4. TP-002 = A-002 Create repo directories

### Цель
Создать каркас каталогов.

### Зависимости
TP-001.

### Файлы
Только директории.

### Шаги
1. Создать `apps/mobile`.
2. Создать `apps/relay`.
3. Создать `packages/protocol`.
4. Создать `packages/crypto-core`.
5. Создать `packages/client-db`.
6. Создать `packages/client-core`.

### Проверка
* структура совпадает с `ARCH-09_REPOSITORY_STRUCTURE.md`.

---

## 5. TP-003 = A-003 Base tsconfig

### Цель
Сделать единый TS base config.

### Зависимости
TP-001.

### Файлы
* `tsconfig.base.json`
* будущие `tsconfig.json` в TS packages

### Шаги
1. Создать `tsconfig.base.json`.
2. Выставить `strict: true`.
3. Выставить `noEmit: false` или оставить под package-level control.
4. Выставить `moduleResolution`, совместимое с workspace.
5. Подготовить package-level `tsconfig.json` как thin extends.

### Проверка
* `tsc --noEmit` проходит в пустом TS package.

---

## 6. TP-004 = B-001 Protocol constants

### Цель
Создать protocol constants.

### Зависимости
TP-001, TP-003.

### Файлы
* `packages/protocol/src/constants/protocolVersion.ts`
* `packages/protocol/src/constants/limits.ts`
* `packages/protocol/src/constants/errorCodes.ts`

### Шаги
1. Создать package `@echolet/protocol`, если еще не создан.
2. Добавить constants files.
3. Вынести значения только из docs.
4. Экспортировать constants из `index.ts`.

### Запрещено
* inventing new limits;
* писать validators в этой задаче.

### Проверка
* constants импортируются из одного entrypoint.

---

## 7. TP-005 = B-002 DeviceRecord type

### Цель
Описать TS type `DeviceRecord`.

### Зависимости
TP-004.

### Файлы
* `packages/protocol/src/types/deviceRecord.ts`

### Шаги
1. Описать поля по `API-11_JSON_SCHEMAS.md`.
2. Экспортировать type.
3. Подключить export в `index.ts`.

### Проверка
* type содержит все обязательные поля.

---

## 8. TP-006 = B-003 DeviceRecord schema

### Цель
Описать runtime schema `DeviceRecord`.

### Зависимости
TP-005.

### Файлы
* `packages/protocol/src/schemas/deviceRecordSchema.ts`

### Шаги
1. Использовать `zod`.
2. Проверить `type === device_record`.
3. Проверить `version === 1`.
4. Проверить обязательные поля.

### Проверка
* valid object passes schema;
* missing field fails schema.

---

## 9. TP-007 = B-004 validateDeviceRecord

### Цель
Сделать удобный validator wrapper.

### Зависимости
TP-006.

### Файлы
* `packages/protocol/src/validators/validateDeviceRecord.ts`
* test file рядом

### Шаги
1. Импортировать schema.
2. Реализовать typed validation function.
3. Вернуть safe structured result.
4. Добавить tests.

### Проверка
* 1 happy-path test;
* 2 invalid tests.

---

## 10. TP-008 = B-005 PreKeyBundle type/schema/validator

### Цель
Реализовать полный contract для `PreKeyBundle`.

### Зависимости
TP-004.

### Файлы
* `packages/protocol/src/types/preKeyBundle.ts`
* `packages/protocol/src/schemas/preKeyBundleSchema.ts`
* `packages/protocol/src/validators/validatePreKeyBundle.ts`
* tests

### Шаги
1. Описать signed prekey type.
2. Описать one-time prekeys array.
3. Описать schema.
4. Добавить validator.
5. Добавить tests.

### Проверка
* valid bundle passes;
* missing signed_prekey fails;
* invalid one_time_prekeys shape fails.

---

## 11. TP-009 = B-006 MailboxEnvelope type/schema/validator
Следовать той же структуре, что и TP-008, но для `MailboxEnvelope`.

### Проверка
* valid envelope passes;
* missing ciphertext fails;
* invalid timestamps fail if schema checks include them.

---

## 12. TP-010 = B-007 ChatMessage type/schema/validator
Следовать той же структуре, что и TP-008, но для `ChatMessage`.

---

## 13. TP-011 = B-008 Receipt type/schema/validator
Следовать той же структуре, что и TP-008, но для `Receipt`.

---

## 14. TP-012 = B-009 Relay API request/response types

### Цель
Описать TS types для всех MVP API endpoints.

### Зависимости
TP-004..TP-011.

### Файлы
* `packages/protocol/src/types/relayApi.ts`
* `packages/protocol/src/schemas/relayApiSchema.ts`
* tests при необходимости

### Проверка
* все request/response shapes из `API-11_JSON_SCHEMAS.md` отражены в коде.

---

## 15. TP-013 = C-001 base64url helpers

### Цель
Сделать encode/decode helpers.

### Зависимости
TP-001.

### Файлы
* `packages/crypto-core/src/encoding/base64url.ts`
* tests

### Проверка
* roundtrip test passes.

---

## 16. TP-014 = C-002 canonical JSON serializer

### Цель
Реализовать deterministic canonical JSON.

### Зависимости
TP-013.

### Файлы
* `packages/crypto-core/src/signatures/canonicalJson.ts`
* tests

### Проверка
* identical objects serialize identically;
* field `signature` is excluded.

---

## 17. TP-015 = C-003 sign canonical JSON
### Цель
Подписывать каноническую JSON-строку.

### Зависимости
TP-014.

### Проверка
* valid signature created;
* output encoding is base64url.

---

## 18. TP-016 = C-004 verify canonical JSON
### Цель
Проверять подпись канонической JSON-строки.

### Зависимости
TP-015.

### Проверка
* valid signature verifies;
* modified payload fails verification.

---

## 19. TP-017 = C-005 generateSeed
### Цель
Генерировать 24-word mnemonic.

### Зависимости
TP-001.

### Проверка
* seed contains 24 words;
* output type stable.

---

## 20. TP-018 = C-006 deriveIdentityKeyPair
### Цель
Получать стабильный identity key pair из seed.

### Проверка
* same seed -> same keypair;
* different seed -> different keypair.

---

## 21. TP-019 = C-007 generateCallsign
### Цель
Сгенерировать UX callsign из identity public key и suffix rules.

### Проверка
* output matches expected format.

---

## 22. TP-020 = C-008 generateDeviceId
### Цель
Генерировать `device_id`.

### Проверка
* valid UUID-like or agreed format;
* uniqueness in tests.

---

## 23. TP-021 = C-009 generateDeviceKeyPair
### Цель
Создавать keypair устройства.

### Проверка
* keypair shape valid.

---

## 24. TP-022 = C-010 signDeviceRecord
### Цель
Подписывать `DeviceRecord` identity key'ем.

### Проверка
* signature added;
* verify function accepts signed record.

---

## 25. TP-023 = C-011 verifyDeviceRecord
### Цель
Проверять signature `DeviceRecord`.

### Проверка
* untouched record verifies;
* modified record fails.

---

## 26. TP-024 = C-012 deriveMailboxId
### Цель
Реализовать mailbox id derivation по точной формуле из `PROTOCOL-07_MVP_MESSAGE_FLOW.md`.

### Проверка
* deterministic output;
* base64url format.

---

## 27. TP-025 = C-013 signMailboxChallenge
### Цель
Подписывать challenge string точно по spec.

### Проверка
* generated signature valid for exact string format;
* changed nonce breaks verification.

---

## 28. TP-026 = C-014 safetyNumber helper
### Цель
Генерировать short safety number для подтверждения контакта.

### Проверка
* одинаковая пара identity keys дает одинаковый safety number;
* формат читаем пользователем.

---

## 29. TP-027 = D-001 db adapter abstraction
### Цель
Создать минимальную DB abstraction для client-db.

### Проверка
* другие repositories могут использовать единый adapter interface.

---

## 30. TP-028 = D-002 contacts schema
### Цель
Описать logical schema для contacts.

### Проверка
* поля соответствуют contact use-cases.

---

## 31. TP-029 = D-003 messages schema
### Цель
Описать logical schema для messages.

### Проверка
* есть поля для direction, status, ciphertext, plaintext_body, timestamps.

---

## 32. TP-030 = D-004 sessions schema
### Цель
Описать logical schema для sessions.

### Проверка
* можно сохранить serialized session state и связать его с identity/device pair.

---

## 33. Итог
Эти первые 30 task pack'ов закрывают фундамент проекта:

* workspace;
* protocol contracts;
* crypto helpers;
* начало client storage.

Пока они не выполнены и не приняты, нельзя переходить к полноценной relay API и messaging orchestration.
