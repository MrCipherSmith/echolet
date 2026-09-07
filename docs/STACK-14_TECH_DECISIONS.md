# Echolet: Tech Stack Decisions & Locked Dependencies (STACK-14)

## Уточнение session runtime — 2026-09-06

Официальный `@signalapp/libsignal-client@0.102.0` используется в отдельном [Node reference package](../packages/session-node/README.md): явное доверие identity, атомарные state/outbox, encrypted SQLite и crash/restart tests. Это не выбор готового mobile production stack. См. [RFC-18](RFC-18_CRYPTO_SELECTION.md) для границ reference, необходимой версии wire bundle и непройденных mobile gates. Старый community-кандидат остаётся отклонённым.

## 1. Назначение документа
Этот документ фиксирует конкретный технологический стек Echolet MVP. Его цель — убрать самую опасную зону для слабой модели: бесконечный выбор библиотек и произвольную замену компонентов.

После принятия этого документа правило такое:

* слабая модель не выбирает стек;
* слабая модель реализует код внутри уже выбранного стека;
* любое отклонение от документа должно быть осознанным решением, а не импровизацией.

---

## 2. Главный принцип выбора стека
Для MVP стек выбирается по трем критериям:

* минимальная двусмысленность реализации;
* стабильные mature-библиотеки;
* низкая когнитивная нагрузка для моделей и небольших команд.

Из-за этого некоторые модные или более "идеологически чистые" решения сознательно не выбраны.

---

## 3. Locked stack overview

### 3.1. Монорепа и package manager
* **Monorepo:** `pnpm workspace`
* **Node.js:** `22 LTS`
* **Package manager:** `pnpm 10`
* **TypeScript:** `5.8.x`

### 3.2. Мобильный клиент
* **Framework:** `React Native 0.79.x`
* **Expo:** `Expo SDK 53` только как runtime/dev tooling, с готовностью перейти на prebuild/bare workflow
* **Navigation:** `@react-navigation/native` + stack navigator
* **State:** `zustand`
* **Async server state:** `@tanstack/react-query`
* **Forms:** без отдельного form framework на MVP, использовать controlled state
* **Styling:** `nativewind` для utility styles + локальные style objects там, где это проще
* **Local DB:** `expo-sqlite` для MVP
* **Secure storage:** `expo-secure-store`
* **Biometrics:** `expo-local-authentication`
* **QR scanning:** `expo-camera`
* **QR generation:** библиотека уровня `react-native-qrcode-svg`

### 3.3. Протокол и shared packages
* **Runtime validation:** `zod`
* **ID generation:** `uuid`
* **Encoding helpers:** собственные thin wrappers поверх platform APIs

### 3.4. Криптография
Для MVP фиксируется следующий pragmatic stack:

* **Identity signatures:** `tweetnacl`
* **Hashing / misc crypto helpers:** `@noble/hashes`
* **Mnemonic generation:** `bip39`
* **Session protocol:** production implementation пока не выбрана; требуется одна проверенная библиотека через adapter. Установленная `@privacyresearch/libsignal-protocol-typescript@0.0.16` не допущена к интеграции — см. проверку ниже.

Важно:

* слабая модель НЕ должна придумывать X3DH самостоятельно;
* слабая модель НЕ должна писать собственный Double Ratchet;
* если выбранная Signal-compatible библиотека оказывается технически непригодной, решение о замене принимает человек или сильная модель, а не бесплатная модель.

### 3.5. Репитер
* **Language:** `Go 1.24.x`
* **Router:** `chi`
* **Config:** `caarlos0/env/v11`
* **Structured logging:** `log/slog`
* **Storage:** `BadgerDB v4`
* **UUIDs:** `google/uuid`
* **Testing:** стандартный `testing` + при необходимости `httptest`

### 3.6. Quality tooling
* **Lint (TS):** `eslint`
* **Format:** `prettier`
* **Unit tests (TS):** `vitest`
* **Unit tests (Go):** стандартный `go test`

---

## 4. Почему выбран именно этот стек

### 4.1. Почему `pnpm`
* хорошо работает с монорепой;
* быстрый;
* предсказуемый lockfile;
* удобен для packages/apps структуры.

### 4.2. Почему `zod`
* readable runtime schemas;
* удобно для слабой модели;
* легко выводить TS types;
* хорошо подходит для JSON contract-first разработки.

### 4.3. Почему `tweetnacl`
* простой API;
* достаточно mature;
* подходит для `Ed25519`-подписей;
* минимальный cognitive overhead.

### 4.4. Почему `expo-sqlite` и `expo-secure-store`
* быстрее завести MVP;
* понятные API;
* позволяют не застрять на раннем native plumbing.

### 4.5. Почему `chi` + `slog`
* минималистичный и понятный серверный стек;
* низкий барьер для ручного контроля API;
* хорош для четкой структуры handlers/services/middleware.

---

## 5. Точные решения по mobile stack

### 5.1. React Native strategy
MVP строится как RN-приложение с расчетом на возможность `expo prebuild`, если понадобится нативная библиотека, которая не работает в fully managed режиме.

Правило:

* пока можно — жить в Expo-friendly режиме;
* как только crypto/session library или OS integration требует большего контроля — переходить в prebuild/bare без переписывания архитектуры.

### 5.2. UI architecture
* экраны — только orchestration;
* бизнес-логика — в `packages/client-core`;
* локальное хранение — в `packages/client-db`;
* runtime validation — в `packages/protocol`.

### 5.3. Styling policy
`nativewind` разрешен, но не должен скрывать бизнес-логику и не должен становиться источником хаоса. Если компоненту проще иметь обычный `StyleSheet`, использовать `StyleSheet`.

---

## 6. Точные решения по crypto

### 6.1. Identity layer
Использовать:

* `bip39` — для mnemonic generation;
* `tweetnacl` — для `Ed25519`-подписей;
* `@noble/hashes/sha256` — для mailbox id и вспомогательных derivations.

### 6.2. Canonical signing
Канонизация JSON не делегируется библиотеке. Для нее реализуется собственная маленькая deterministic helper-функция в `packages/crypto-core`, но подпись и verify выполняются на mature crypto primitives.

### 6.3. Session library decision

**Проверка 2026-09-06:** изолированный [исполняемый spike](../.metaproject/flows/001-2026-09-05-echolet-assessment-fixes/spike/libsignal.cjs) воспроизвёл в установленной community-библиотеке `@privacyresearch/libsignal-protocol-typescript@0.0.16` принятие входящего сообщения при асинхронном отказе `isTrustedIdentity`. Базовый Node round-trip не компенсирует этот дефект. Этот кандидат нельзя интегрировать неизменённым. [Отчёт и границы проверки](../.metaproject/flows/001-2026-09-05-echolet-assessment-fixes/crypto-report.md).

Native libsignal остаётся кандидатом для собственного React Native bridge, а не подтверждённым готовым решением. Требуются проверка поддержки/лицензии, identity/device mapping, async adapter, устойчивое защищённое хранение и реальные mobile tests. Статус G0: **open**.

Для session/bootstrap слоя допустим только один из вариантов:

1. зрелая TS-реализация libsignal-compatible протокола;
2. thin wrapper над нативной библиотекой, если TS-библиотека окажется нестабильной.

На MVP нельзя:

* писать custom ratchet;
* подменять session layer на ad-hoc symmetric encryption;
* упрощать prekeys до "одного публичного ключа без bootstrap semantics".

---

## 7. Точные решения по relay

### 7.1. API style
Репитер использует:

* `HTTP JSON API`
* `chi`
* TLS в deployment-конфигурации

На локальной разработке допустим HTTP без TLS, но протокольные контракты должны быть одинаковы.

### 7.2. Storage layout
`BadgerDB` используется для:

* device records;
* prekey bundles;
* mailbox envelopes;
* mailbox challenges;
* abuse counters.

### 7.3. Cleanup model
Cleanup job должен быть встроен в relay-process и запускаться периодически по ticker, а не через внешний cron как обязательную зависимость MVP.

---

## 8. Точные версии и зависимости, которые SHOULD быть зафиксированы

## 8.1. Root JS deps
Пример целевого набора:

```json
{
  "devDependencies": {
    "typescript": "5.8.x",
    "eslint": "9.x",
    "prettier": "3.x",
    "vitest": "3.x"
  },
  "engines": {
    "node": ">=22"
  },
  "packageManager": "pnpm@10"
}
```

## 8.2. Shared package deps

```json
{
  "dependencies": {
    "zod": "4.x",
    "uuid": "11.x",
    "tweetnacl": "1.0.x",
    "bip39": "3.x",
    "@noble/hashes": "1.x"
  }
}
```

## 8.3. Mobile deps

```json
{
  "dependencies": {
    "react": "19.x",
    "react-native": "0.79.x",
    "expo": "53.x",
    "zustand": "5.x",
    "@tanstack/react-query": "5.x",
    "@react-navigation/native": "7.x",
    "expo-sqlite": "~15.x",
    "expo-secure-store": "~14.x",
    "expo-local-authentication": "~16.x",
    "expo-camera": "~16.x",
    "nativewind": "4.x",
    "react-native-qrcode-svg": "6.x"
  }
}
```

## 8.4. Go deps

```text
github.com/go-chi/chi/v5
github.com/caarlos0/env/v11
github.com/dgraph-io/badger/v4
github.com/google/uuid
```

---

## 9. Что запрещено использовать без отдельного решения
Следующие технологии запрещены для спонтанного добавления слабой моделью:

* `Redux Toolkit`
* `MobX`
* `WatermelonDB`
* `Prisma`
* `NestJS`
* `Gin`
* `protobuf`/`gRPC`
* `libp2p` как обязательный transport внутри MVP API слоя
* самодельные криптобиблиотеки
* ORM в relay для MVP

Причина: они либо увеличивают сложность, либо уводят реализацию от already-defined relay-first MVP.

---

## 10. Что можно заменить в будущем
Эти компоненты считаются replaceable после MVP:

* `expo-sqlite` -> более мощный storage слой;
* HTTP API -> libp2p transport adapter;
* managed Expo-friendly flow -> prebuild/bare;
* session library -> более зрелая binding-реализация.

Но на MVP их менять нельзя без явного redesign pass.

---

## 11. Decision log

### D-001. JSON instead of protobuf
Решение: JSON.

Причина:
* проще дебажить;
* проще слабой модели;
* быстрее дойти до e2e working flow.

### D-002. HTTP relay instead of full libp2p transport
Решение: HTTP JSON relay.

Причина:
* меньше неопределенности;
* проще тестировать;
* не мешает позже добавить другой transport.

### D-003. Expo-friendly MVP instead of native-first setup
Решение: начать Expo-friendly, но не зависеть концептуально от managed-only режима.

Причина:
* быстрее старт;
* сохраняется путь к более низкому уровню контроля.

### D-004. One session library only
Решение: одна библиотека на весь проект.

Причина:
* нельзя допускать несовместимые crypto flows между устройствами.

---

## 12. Checklist перед началом реализации
Перед кодингом любой модели нужно проверить:

1. Есть ли уже выбранная библиотека для этой зоны.
2. Не добавляет ли задача новый стек без необходимости.
3. Не дублирует ли библиотека то, что уже зафиксировано.
4. Не ломает ли выбор documents `PROTOCOL-07`, `THREAT-08`, `ARCH-09`.

---

## 13. Итог
Этот документ нужен, чтобы слабая модель не тратила 40% effort на лишние tech decisions.

Правило простое:

* стек уже выбран;
* если задача не требует нового решения, ничего нового не выбирается;
* сначала совместимость и предсказуемость, потом красота и расширяемость.
