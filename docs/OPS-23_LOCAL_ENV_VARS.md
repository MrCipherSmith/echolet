# Echolet: Local Environment Variables & Config Reference (OPS-23)

## 1. Назначение документа
Этот документ фиксирует локальные переменные окружения и конфигурационные значения для Echolet MVP. Его задача — убрать догадки о том, какие env/config нужны для запуска relay и mobile в dev-среде.

Документ покрывает:

* relay env vars;
* mobile config values;
* dev defaults;
* обязательные и необязательные переменные;
* правила хранения локальных конфигов.

---

## 2. Общие правила

### 2.1. Секреты
В MVP локальная dev-среда должна минимизировать количество секретов. Если секрет не нужен, его не надо вводить.

### 2.2. Источники конфигурации
* relay читает config из env vars;
* mobile app читает dev config из app config / env adapter;
* seed, private keys и session state НЕ являются env vars.

### 2.3. Имена
Все relay env vars используют префикс `ECHOLET_`.

---

## 3. Relay env vars

## 3.1. Обязательные для локального запуска

### `ECHOLET_HTTP_ADDR`
* **Назначение:** адрес и порт HTTP сервера relay.
* **Пример:** `:8081`
* **Required:** yes

### `ECHOLET_DATA_DIR`
* **Назначение:** директория для хранения BadgerDB и runtime data.
* **Пример:** `./.data/relay`
* **Required:** yes

## 3.2. Рекомендуемые для локального запуска

### `ECHOLET_LOG_LEVEL`
* **Назначение:** уровень логирования.
* **Пример:** `debug`
* **Default:** `info`

### `ECHOLET_NODE_CALLSIGN`
* **Назначение:** человекочитаемое имя локального relay.
* **Пример:** `RPT-LOCAL-01`
* **Default:** `RPT-LOCAL-DEV`

### `ECHOLET_MAX_STORAGE_BYTES`
* **Назначение:** лимит хранилища relay.
* **Пример:** `2147483648`
* **Default:** `2147483648`

### `ECHOLET_MAX_MESSAGE_BYTES`
* **Назначение:** максимальный размер одного envelope.
* **Пример:** `262144`
* **Default:** `262144`

### `ECHOLET_MAILBOX_TTL_HOURS`
* **Назначение:** TTL сообщений в часах.
* **Пример:** `168`
* **Default:** `168`

### `ECHOLET_CHALLENGE_TTL_SECONDS`
* **Назначение:** TTL mailbox challenge.
* **Пример:** `60`
* **Default:** `60`

### `ECHOLET_MAX_MAILBOX_BATCH`
* **Назначение:** максимальный batch envelopes в одном poll.
* **Пример:** `100`
* **Default:** `100`

### `ECHOLET_RATE_LIMIT_PER_MINUTE`
* **Назначение:** базовый лимит запросов в минуту на dev relay.
* **Пример:** `120`
* **Default:** `120`

### `ECHOLET_CLEANUP_INTERVAL_SECONDS`
* **Назначение:** интервал cleanup job.
* **Пример:** `60`
* **Default:** `60`

---

## 4. Relay `.env.local` пример

```env
ECHOLET_HTTP_ADDR=:8081
ECHOLET_DATA_DIR=./.data/relay
ECHOLET_LOG_LEVEL=debug
ECHOLET_NODE_CALLSIGN=RPT-LOCAL-DEV
ECHOLET_MAX_STORAGE_BYTES=2147483648
ECHOLET_MAX_MESSAGE_BYTES=262144
ECHOLET_MAILBOX_TTL_HOURS=168
ECHOLET_CHALLENGE_TTL_SECONDS=60
ECHOLET_MAX_MAILBOX_BATCH=100
ECHOLET_RATE_LIMIT_PER_MINUTE=120
ECHOLET_CLEANUP_INTERVAL_SECONDS=60
```

---

## 5. Mobile config values

В MVP mobile app обычно получает config через app config, expo extra fields или отдельный config module. Не все из этого должны быть env vars системы. Главное — чтобы значения шли через единый adapter.

## 5.1. Обязательные mobile config values

### `ECHOLET_RELAY_BASE_URL`
* **Назначение:** базовый URL relay.
* **Пример:** `http://127.0.0.1:8081`
* **Required:** yes

### `ECHOLET_RELAY_FINGERPRINT`
* **Назначение:** relay fingerprint или placeholder для dev pinning strategy.
* **Пример:** `local-dev-relay`
* **Required:** recommended

## 5.2. Полезные dev config values

### `ECHOLET_APP_ENV`
* **Назначение:** режим окружения.
* **Пример:** `development`
* **Default:** `development`

### `ECHOLET_ENABLE_TERMINAL`
* **Назначение:** включить terminal screen и diagnostics.
* **Пример:** `true`
* **Default:** `true`

### `ECHOLET_ENABLE_MANUAL_MAILBOX_POLL`
* **Назначение:** разрешить кнопку ручного poll для demo/debug.
* **Пример:** `true`
* **Default:** `true`

### `ECHOLET_DISABLE_BIOMETRIC_LOCK`
* **Назначение:** отключить biometric lock для dev среды, если нужно.
* **Пример:** `true`
* **Default:** `false`

---

## 6. Mobile `.env.local` пример

```env
ECHOLET_APP_ENV=development
ECHOLET_RELAY_BASE_URL=http://127.0.0.1:8081
ECHOLET_RELAY_FINGERPRINT=local-dev-relay
ECHOLET_ENABLE_TERMINAL=true
ECHOLET_ENABLE_MANUAL_MAILBOX_POLL=true
ECHOLET_DISABLE_BIOMETRIC_LOCK=true
```

---

## 7. Конфиг-адаптеры, которые должны существовать

### 7.1. Relay
В `apps/relay/internal/config/config.go` должен быть один typed config struct, который:

* читает все env vars;
* выставляет defaults;
* валидирует обязательные поля.

### 7.2. Mobile
В `apps/mobile/src/services/config.ts` или аналогичном модуле должен быть один config adapter, который:

* читает значения из Expo env/app config;
* валидирует обязательные ключи;
* экспортирует готовый объект config.

Слабая модель не должна читать env vars из разных мест приложения напрямую.

---

## 8. Что нельзя хранить в env vars
Нельзя хранить в env vars:

* seed phrase;
* identity private key;
* device private key;
* serialized session state;
* plaintext messages.

Эти данные относятся к runtime secret storage, а не к app/server config.

---

## 9. Dev defaults и рекомендации

### 9.1. Локальные порты
Рекомендуемый локальный порт relay:

* `8081` — чтобы не конфликтовать с типичными `3000`, `8080`, `5432` и т.д.

### 9.2. Data directories
Рекомендуемые локальные директории:

* relay data: `./.data/relay`
* тестовые tmp dirs: `./.tmp/*`

### 9.3. Логи
Для dev use-case рекомендуется:

* `debug` для relay during local setup;
* `info` для repeatable demo.

---

## 10. Validation checklist
Перед запуском локальной среды проверить:

* `ECHOLET_HTTP_ADDR` задан;
* `ECHOLET_DATA_DIR` существует или может быть создан;
* `ECHOLET_RELAY_BASE_URL` совпадает с relay портом;
* размерные лимиты не противоречат `PROTOCOL-07_MVP_MESSAGE_FLOW.md`;
* TTL challenge и TTL mailbox заданы в разумных значениях.

---

## 11. Частые ошибки

### Ошибка 1. Использовать `localhost` на мобильном устройстве
Если mobile app идет на реальном телефоне, `localhost` будет указывать на телефон, а не на локальный relay на компьютере. Нужно использовать доступный IP хоста.

### Ошибка 2. Разные лимиты в docs и env defaults
Если env defaults расходятся со спецификацией, слабая модель начинает писать код под разные правила. Нужно держать лимиты согласованными.

### Ошибка 3. Чтение env прямо в use-case коде
Это ломает testability и создает хаос. Конфиг читается только через config adapter.

---

## 12. Итог
Этот документ превращает локальную настройку Echolet из набора догадок в воспроизводимую dev-конфигурацию.

Правило простое:

* env vars только для app/server config;
* секреты — только в secure runtime storage;
* mobile и relay читают конфиг через один typed adapter каждый.

## Development messaging containment (flow 001)

`EXPO_PUBLIC_ECHOLET_ENABLE_UNSAFE_DEMO=true` explicitly enables the unvalidated messaging demo **only when the React Native build has `__DEV__ === true`**. Missing/false values disable it; release builds remain disabled even with the opt-in. This is a public build flag, never a secret or a security credential. Expo can inline this exact public environment variable; other build setups must explicitly provide it. Restart/rebuild after changing it.

The enabled screen always discloses demo status. Use synthetic text and disposable development identities only: this session implementation is not the production ratchet, and its state/history is memory-only. Do not use this switch as a production rollout mechanism. The release gate is removed only after session/contact and security acceptance evidence is recorded in `STATUS_CURRENT.md`.
