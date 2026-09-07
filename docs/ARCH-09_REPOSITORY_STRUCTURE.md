# Echolet: Repository Structure & Module Boundaries (ARCH-09)

## 1. Назначение документа
Этот документ задает точную структуру проекта Echolet MVP. Его цель — сделать репозиторий предсказуемым, чтобы даже слабая модель могла реализовывать задачи без архитектурных догадок.

Документ отвечает на вопросы:

* какие приложения и пакеты есть в монорепе;
* где должен жить каждый тип кода;
* какие зависимости разрешены между модулями;
* какие папки создавать в первую очередь;
* как именовать файлы, типы, сервисы и тесты.

---

## 2. Архитектурный принцип
MVP должен быть реализован как **monorepo** с тремя верхнеуровневыми зонами:

* `apps/` — исполняемые приложения;
* `packages/` — переиспользуемые библиотеки и типы;
* `docs/` — спецификации, RFC и проектная документация.

В рабочем репозитории текущие `.md` файлы могут лежать в корне, но для реализации рекомендуется постепенно переносить их в `docs/` без изменения содержимого.

---

## 3. Рекомендуемая структура репозитория

```text
echolet/
  apps/
    mobile/
      src/
        app/
        screens/
        components/
        features/
        services/
        state/
        hooks/
        utils/
        assets/
      app.json
      package.json
      tsconfig.json
    relay/
      cmd/
        relay/
          main.go
      internal/
        api/
        config/
        crypto/
        logging/
        middleware/
        model/
        relay/
        storage/
        service/
        validation/
      migrations/
      go.mod
      go.sum
      Dockerfile
  packages/
    protocol/
      src/
        constants/
        schemas/
        types/
        validators/
      package.json
      tsconfig.json
    crypto-core/
      src/
        identity/
        device/
        mailbox/
        encoding/
        signatures/
      package.json
      tsconfig.json
    client-db/
      src/
        schema/
        repositories/
        migrations/
      package.json
      tsconfig.json
    client-core/
      src/
        identity/
        contacts/
        sessions/
        messages/
        mailbox/
        relay/
        diagnostics/
      package.json
      tsconfig.json
    ui-kit/
      src/
        theme/
        components/
        icons/
      package.json
      tsconfig.json
  docs/
    specs/
    plans/
    rfc/
  scripts/
  .editorconfig
  .gitignore
  package.json
  pnpm-workspace.yaml
  README.md
```

---

## 4. Назначение верхнеуровневых директорий

### 4.1. `apps/mobile`
Здесь находится React Native клиент.

Зона ответственности:

* экраны;
* навигация;
* UI-компоненты приложения;
* mobile-specific glue code;
* вызовы `client-core`.

Там НЕ должно быть:

* бизнес-логики криптографии в raw виде;
* копий domain schemas;
* логики валидации протокола, дублирующей `packages/protocol`.

### 4.2. `apps/relay`
Здесь находится Go-репитер.

Зона ответственности:

* HTTP/transport API;
* конфигурация узла;
* хранилище mailbox и prekeys;
* rate limiting;
* TTL cleanup;
* relay-local observability.

### 4.3. `packages/protocol`
Единый источник истины для JSON-схем, типов и валидаторов протокола в TypeScript.

Зона ответственности:

* types для request/response;
* schemas для domain objects;
* runtime validators;
* constants protocol version.

### 4.4. `packages/crypto-core`
Обертки над криптографией и encode/decode функциями.

Там должны жить:

* derivation identity;
* подписи device records;
* mailbox id derivation;
* canonical JSON signing helpers;
* safety number helpers.

### 4.5. `packages/client-db`
Единый слой локального хранилища клиента.

### 4.6. `packages/client-core`
Основная бизнес-логика клиента без UI.

Там должны жить:

* onboarding use cases;
* contact import/export;
* session bootstrap;
* outbox/inbox processing;
* mailbox poll orchestration;
* receipts and retries.

### 4.7. `packages/ui-kit`
Опционально. Если UI начнет расти, сюда можно выносить повторяемые визуальные примитивы.

---

## 5. Детальная структура `apps/mobile`

```text
apps/mobile/src/
  app/
    navigation/
    providers/
  screens/
    OnboardingScreen.tsx
    SeedBackupScreen.tsx
    ContactsScreen.tsx
    ChatListScreen.tsx
    ChatScreen.tsx
    TerminalScreen.tsx
    SettingsScreen.tsx
  components/
    AppShell.tsx
    StatusPill.tsx
    MessageBubble.tsx
    DeviceBadge.tsx
    TerminalEventRow.tsx
  features/
    onboarding/
    contacts/
    chat/
    terminal/
    settings/
  services/
    secureStorage.ts
    relayApi.ts
    qr.ts
    clock.ts
  state/
    useSessionStore.ts
    useSettingsStore.ts
    useDiagnosticsStore.ts
  hooks/
    useMailboxPoll.ts
    useRelayHealth.ts
  utils/
    formatCallsign.ts
    formatFingerprint.ts
```

### 5.1. Правило распределения кода
* `screens/` — композиция UI и вызов feature hooks.
* `components/` — тупые презентационные компоненты.
* `features/` — UI-oriented orchestration.
* `services/` — инфраструктурные адаптеры.
* `state/` — UI state, а не бизнес-логика протокола.

---

## 6. Детальная структура `apps/relay`

```text
apps/relay/
  cmd/relay/main.go
  internal/
    api/
      handlers/
      router/
      dto/
    config/
      config.go
    crypto/
      verify.go
      mailbox.go
    logging/
      logger.go
    middleware/
      rate_limit.go
      request_id.go
      recover.go
    model/
      device_record.go
      prekey_bundle.go
      mailbox_envelope.go
      api_error.go
    relay/
      node.go
    service/
      device_record_service.go
      prekey_service.go
      mailbox_service.go
      challenge_service.go
      cleanup_service.go
    storage/
      badger/
        device_record_repo.go
        prekey_repo.go
        mailbox_repo.go
        challenge_repo.go
    validation/
      schema.go
      signatures.go
```

### 6.1. Dependency rules for relay
Разрешенные зависимости:

* `api/handlers -> service`
* `service -> storage`, `validation`, `crypto`, `model`
* `storage -> model`
* `middleware -> logging`, `config`

Запрещено:

* `storage -> api`
* `model -> service`
* `api -> storage` напрямую, минуя service layer

---

## 7. Детальная структура `packages/protocol`

```text
packages/protocol/src/
  constants/
    protocolVersion.ts
    limits.ts
    errorCodes.ts
  types/
    deviceRecord.ts
    preKeyBundle.ts
    mailboxEnvelope.ts
    chatMessage.ts
    receipt.ts
    relayApi.ts
  schemas/
    deviceRecordSchema.ts
    preKeyBundleSchema.ts
    mailboxEnvelopeSchema.ts
    chatMessageSchema.ts
    receiptSchema.ts
    relayApiSchema.ts
  validators/
    validateDeviceRecord.ts
    validatePreKeyBundle.ts
    validateMailboxEnvelope.ts
    validateApiRequest.ts
    validateApiResponse.ts
```

### 7.1. Главный принцип
Если структура описана в `PROTOCOL-07_MVP_MESSAGE_FLOW.md`, она должна иметь отражение в `packages/protocol`.

---

## 8. Детальная структура `packages/crypto-core`

```text
packages/crypto-core/src/
  identity/
    generateSeed.ts
    deriveIdentityKeyPair.ts
    generateCallsign.ts
    safetyNumber.ts
  device/
    generateDeviceId.ts
    generateDeviceKeyPair.ts
    signDeviceRecord.ts
    verifyDeviceRecord.ts
  mailbox/
    deriveMailboxId.ts
    signMailboxChallenge.ts
    verifyMailboxChallenge.ts
  signatures/
    canonicalJson.ts
    signCanonicalJson.ts
    verifyCanonicalJson.ts
  encoding/
    base64url.ts
    utf8.ts
```

### 8.1. Запреты
* Не писать самодельный crypto primitive, если есть надежная библиотека.
* Не смешивать encoding helpers с UI utility functions.

---

## 9. Детальная структура `packages/client-core`

```text
packages/client-core/src/
  identity/
    createIdentityProfile.ts
    loadIdentityProfile.ts
  contacts/
    exportQrContact.ts
    importQrContact.ts
    importInvite.ts
    verifyContact.ts
  relay/
    publishDeviceRecord.ts
    publishPreKeyBundle.ts
    fetchPreKeyBundles.ts
    sendEnvelope.ts
    createMailboxChallenge.ts
    pollMailbox.ts
    ackMailbox.ts
  sessions/
    createOutboundSession.ts
    createInboundSession.ts
    loadSession.ts
    saveSession.ts
  messages/
    createChatMessage.ts
    encryptOutgoingMessage.ts
    decryptIncomingEnvelope.ts
    queueOutgoingMessage.ts
    markMessageRelayed.ts
    markMessageDelivered.ts
    processReceipt.ts
  mailbox/
    runMailboxPollCycle.ts
    processMailboxBatch.ts
    quarantineEnvelope.ts
  diagnostics/
    recordTerminalEvent.ts
    listTerminalEvents.ts
```

### 9.1. Правило use-case first
`client-core` должен состоять из use-case функций, а не из больших бесформенных service-классов. Слабой модели проще собирать систему из коротких функций с явными входами и выходами.

---

## 10. Детальная структура `packages/client-db`

```text
packages/client-db/src/
  schema/
    contacts.ts
    messages.ts
    sessions.ts
    outbox.ts
    receipts.ts
    relayConfig.ts
  repositories/
    contactsRepository.ts
    messagesRepository.ts
    sessionsRepository.ts
    outboxRepository.ts
    receiptsRepository.ts
    relayConfigRepository.ts
  migrations/
    001_init.ts
```

### 10.1. Репозитории MUST
Каждый repository MUST иметь минимальный набор операций:

* `getById`
* `list`
* `insert`
* `update`
* `delete` или `softDelete`, если нужно

---

## 11. Naming conventions

### 11.1. TypeScript
* типы: `PascalCase`
* функции: `camelCase`
* React components: `PascalCase`
* константы: `UPPER_SNAKE_CASE`
* файлы функций: имя функции, например `deriveMailboxId.ts`

### 11.2. Go
* package names: lowercase
* filenames: `snake_case.go`
* exported types/functions: `PascalCase`
* internal helpers: `camelCase`

### 11.3. Domain words
Один термин — одно написание во всем проекте:

* `PreKey Bundle`
* `Signed Device Record`
* `Mailbox Envelope`
* `Home Base`
* `receipt`
* `challenge`

Нельзя в одном месте писать `prekeyBundle`, а в другом `pre_key_set`, если речь об одном и том же объекте.

---

## 12. Module boundaries and dependency matrix

| Модуль | Может зависеть от | Не должен зависеть от |
| :--- | :--- | :--- |
| `apps/mobile` | `client-core`, `client-db`, `protocol`, `crypto-core`, `ui-kit` | `apps/relay` |
| `apps/relay` | собственные internal-пакеты | `apps/mobile` |
| `packages/client-core` | `protocol`, `crypto-core`, `client-db` | `apps/mobile`, `apps/relay` |
| `packages/client-db` | db adapter libs | `apps/mobile`, `apps/relay` |
| `packages/protocol` | schema/validation libs | UI и storage |
| `packages/crypto-core` | crypto libs | UI, screens |

---

## 13. Точные правила расположения файлов

### 13.1. Куда класть новый domain type
Любой новый domain type сначала добавляется в `packages/protocol/src/types`.

### 13.2. Куда класть runtime validation
Любая runtime validation для protocol objects идет в `packages/protocol/src/validators`.

### 13.3. Куда класть криптографические helpers
Только в `packages/crypto-core`.

### 13.4. Куда класть HTTP client для relay
В `apps/mobile/src/services/relayApi.ts` или в `packages/client-core/relay`, если он нужен вне UI.

### 13.5. Куда класть экран
Только в `apps/mobile/src/screens`.

---

## 14. Минимальный bootstrap order для репозитория
Если проект стартует с нуля, папки и файлы нужно создавать в таком порядке:

1. корневой workspace config;
2. `packages/protocol`;
3. `packages/crypto-core`;
4. `packages/client-db`;
5. `packages/client-core`;
6. `apps/relay`;
7. `apps/mobile`;
8. CI/test scripts;
9. UI polishing.

Это нужно, чтобы сначала зафиксировать domain contracts, а уже потом писать UI и transport glue.

---

## 15. Обязательные корневые скрипты
В корневом `package.json` SHOULD быть команды:

* `typecheck`
* `lint`
* `test`
* `test:unit`
* `test:protocol`
* `mobile:start`
* `relay:dev`

Если команда использует `pnpm`, все команды MUST запускаться из workspace root.

---

## 16. Test layout

### 16.1. TypeScript packages
Тесты располагаются рядом с файлами или в `__tests__`, но стиль должен быть единым на весь пакет.

Рекомендуемый вариант для слабой модели:

* colocated tests, например `deriveMailboxId.test.ts` рядом с `deriveMailboxId.ts`.

### 16.2. Go relay
Тесты SHOULD лежать рядом с кодом в виде `*_test.go`.

---

## 17. Logging layout

### 17.1. Клиент
UI-terminal события не должны напрямую зависеть от консольного лога. Нужен отдельный diagnostics store.

### 17.2. Relay
Логирование должно быть структурированным:

* `request_id`
* `route`
* `error_code`
* `duration_ms`

Запрещено логировать plaintext payload и секреты.

---

## 18. Правила для слабой модели

### 18.1. Один слой за раз
Слабой модели нельзя давать задачу, затрагивающую одновременно:

* UI;
* криптографию;
* API;
* базу данных.

Правильно — давать одну задачу на один слой.

### 18.2. Один файл = одна основная ответственность
Если файл начинает делать больше одной вещи, его надо разделить.

### 18.3. Не копировать типы вручную
Если тип уже есть в `packages/protocol`, его нужно импортировать, а не переписывать заново.

---

## 19. Итог
Если команда соблюдает этот документ, репозиторий будет:

* предсказуемым;
* удобным для пошаговой реализации;
* устойчивым к дублированию логики;
* понятным даже модели, которая не умеет держать большую архитектуру в голове.
