# Echolet: RFC on Crypto Session Library Selection (RFC-18)

## Исполняемый reference runtime — 2026-09-06

Добавлен отдельный Node-only пакет [session-node](../packages/session-node/README.md) на официальном `@signalapp/libsignal-client@0.102.0`. Он проверяет явное закрепление удалённой identity, библиотечные сессии и атомарное сохранение состояния вместе с outbox в зашифрованной SQLite. Это следующий кандидат для собственного мобильного bridge; в React Native пакет не импортируется. Подробности и ограничения: [спецификация](../.metaproject/flows/001-2026-09-05-echolet-assessment-fixes/official-session-spec.md).

Это уточняет прежний приоритет TS-кандидата: установленная community-реализация отклонена, дальнейший путь исследуется на официальном runtime. Готовый сторонний RN wrapper также не принят — [проверка bridge](../.metaproject/flows/001-2026-09-05-echolet-assessment-fixes/mobile-libsignal-feasibility.md). Мобильная совместимость, управление ключом базы, привязка Signal identity к подписанному DeviceRecord и независимый аудит остаются открытыми.

Современный libsignal требует Kyber prekeys: существующий wire bundle v1 нельзя считать совместимым с reference API. Его миграция требует отдельной версии и согласованного изменения схем/relay/клиента через CHANGE-24. Запрет ниже означает запрет неявной несовместимой подмены v1, а не запрет обоснованной версии протокола. Native-типы, видимые в Node reference, не являются публичным mobile adapter contract.

## Проверка кандидата — 2026-09-06

Установленный `@privacyresearch/libsignal-protocol-typescript@0.0.16` **не допускается к интеграции без устранения и независимой проверки дефекта**: `processV3` не ожидает асинхронный результат `isTrustedIdentity`; входящее prekey-сообщение расшифровывается даже при `async () => false`.

[Отчёт](../.metaproject/flows/001-2026-09-05-echolet-assessment-fixes/crypto-report.md) и [исполняемый spike](../.metaproject/flows/001-2026-09-05-echolet-assessment-fixes/spike/libsignal.cjs) фиксируют работоспособные Node-сценарии и воспроизведённый blocker. `VERIFIED_WITH_SECURITY_BLOCKER` означает воспроизведение дефекта, не PASS криптографической приёмки. Hermes/iOS/Android и durable crash recovery не подтверждены. Библиотечный путь и G0 остаются открытыми.

## 1. Назначение документа
Этот RFC фиксирует ограничения и процедуру выбора по самому опасному открытому вопросу MVP: какую библиотеку использовать для bootstrap/session слоя вместо попытки написать собственный `X3DH + Double Ratchet`.

Цель документа:

* выбрать один конкретный путь;
* зафиксировать, что именно делает библиотека, а что остается нашей ответственностью;
* убрать для слабой модели пространство для самодельной криптографии.

---

## 2. Контекст
Echolet MVP уже зафиксировал следующие требования:

* identity — `Ed25519`;
* `Signed Device Record` и `PreKey Bundle` подписываются;
* первая secure session не должна строиться вручную;
* сообщения должны идти как E2EE payload поверх relay mailbox;
* mailbox и protocol contracts реализуются отдельно от session internals.

Главная проблема: слабая модель почти наверняка сломает безопасность, если ей дать задачу "реализуй X3DH и Double Ratchet" напрямую.

Поэтому решение должно быть максимально pragmatic.

---

## 3. Варианты

### Вариант A — Самодельная реализация X3DH + Double Ratchet
**Статус:** запрещено.

Причины отказа:
* слишком высокий риск ошибок;
* слабая модель с высокой вероятностью сломает security semantics;
* невозможно быстро и надежно проверить корректность.

### Вариант B — Использовать зрелую Signal-compatible библиотеку в TypeScript
**Статус:** предпочтительный.

Плюсы:
* сохраняется JS/TS-интеграция;
* проще связать с `client-core`;
* меньше собственного crypto-кода.

Минусы:
* ecosystem quality неоднородна;
* часть библиотек плохо поддерживается.

### Вариант C — Использовать нативную Signal-compatible библиотеку через bridge/wrapper
**Статус:** допустимый fallback.

Плюсы:
* потенциально более зрелый crypto runtime;
* лучше для mobile production later.

Минусы:
* выше сложность интеграции;
* хуже для быстрого MVP;
* сложнее для слабой модели.

---

## 4. Решение RFC

### 4.1. Принятое ограничение и неподтвержденная гипотеза
Для MVP принимается следующий путь:

* **Гипотеза кандидата:** сначала оценить поддерживаемую Signal-compatible библиотеку в TypeScript через adapter layer. Конкретный пакет, версия и совместимость с мобильным runtime этим RFC не подтверждены.
* **Fallback decision:** если в процессе bootstrap окажется, что выбранная TS-библиотека нестабильна или несовместима с Expo/prebuild, перейти на native-compatible wrapper, не меняя protocol contracts.

### 4.2. Конкретное практическое правило
В коде Echolet session layer всегда должен быть скрыт за узким интерфейсом `packages/client-core/src/sessions/*`.

Это значит:

* остальной проект не зависит напрямую от конкретной crypto library;
* замена библиотеки не ломает UI, relay API и protocol types;
* слабая модель видит только adapter API, а не crypto internals.

---

## 5. Locked architecture for session layer

### 5.1. Что библиотека обязана решать
Выбранная Signal-compatible library должна покрывать:

* bootstrap первой сессии на основе prekeys;
* хранение session state;
* encrypt;
* decrypt;
* поддержку inbound/outbound session initialization.

### 5.2. Что библиотека не должна решать за нас
Следующие вещи остаются ответственностью Echolet-кода:

* JSON contracts;
* `DeviceRecord`;
* `PreKey Bundle` wire shape;
* mailbox challenge/poll/ack;
* relay API;
* retries;
* receipts;
* terminal diagnostics;
* local repositories и orchestration.

---

## 6. Session adapter contract
Независимо от выбранной библиотеки, проект должен использовать один и тот же adapter contract.

### 6.1. Обязательные интерфейсы

```ts
type SessionBootstrapInput = {
  localIdentityId: string
  localDeviceId: string
  remoteIdentityId: string
  remoteDeviceId: string
  remoteBundle: unknown
}

type SessionEncryptInput = {
  sessionId: string
  plaintext: Uint8Array
}

type SessionDecryptInput = {
  sessionId?: string
  ciphertext: Uint8Array
}
```

### 6.2. Обязательные функции
В `packages/client-core/src/sessions/` должны существовать:

* `createOutboundSession.ts`
* `createInboundSession.ts`
* `encryptWithSession.ts` или `encryptOutgoingMessage.ts`
* `decryptWithSession.ts` или `decryptIncomingEnvelope.ts`
* `saveSession.ts`
* `loadSession.ts`

### 6.3. Главное правило
Ни один экран, ни один UI hook, ни один relay handler не должен импортировать crypto library напрямую. Только session adapter.

---

## 7. Data mapping rules

### 7.1. DeviceRecord -> library identity mapping
Echolet mapping обязан быть явным:

* `identity_id` — глобальный identity reference;
* `device_id` — device reference;
* `device_pubkey` — device-level public key material;
* `PreKey Bundle` — материал для bootstrap сессии.

### 7.2. Bundle mapping
Если конкретная Signal-compatible library использует свою внутреннюю форму `preKey`, `signedPreKey`, `identityKey`, то преобразование MUST происходить внутри adapter layer.

Слабая модель не должна менять внешний Echolet JSON contract под внутренние типы библиотеки.

---

## 8. Candidate evaluation checklist
Перед окончательным закреплением конкретной библиотеки человек или сильная модель должны проверить:

### 8.1. API suitability
* можно ли создать outbound session из prekey bundle;
* можно ли создать inbound session из первого ciphertext;
* можно ли сериализовать и сохранять session state.

### 8.2. Runtime suitability
* работает ли библиотека в RN/Expo-friendly окружении;
* не требует ли неподъемного количества native glue уже на MVP;
* нет ли очевидной заброшенности проекта.

### 8.3. Security suitability
* библиотека не выглядит экспериментальной;
* не требует самодельного ratchet-кода вокруг себя;
* не заставляет упрощать prekey semantics.

---

## 9. Decision workflow

Выполняется в gate G0 до основной messaging/UI разработки, а не на Week 6. Срок первого spike — 5 рабочих дней, не автоматический критерий успеха. Смена runtime или библиотеки требует повторной проверки.

### Шаг 1
Выбрать один основной кандидат TS Signal-compatible library.

### Шаг 2
Сделать минимальный spike только на:

* create outbound session;
* encrypt;
* decrypt;
* serialize и reload session state после перезапуска на двух физических телефонах;
* двусторонние ответы, delayed/out-of-order и duplicate delivery без повторного отображения;
* восстановление после отсутствия сети;
* матрица foreground/background/terminated с моделью телефона, ОС и режимом уведомлений.

### Шаг 3
Проверить spike по checklist из раздела 8.

### Шаг 4
Если spike успешен — зафиксировать библиотеку в `STACK-14_TECH_DECISIONS.md` и коде.

### Шаг 5
Если spike неуспешен — не переписывать архитектуру, а переходить к native-wrapper fallback через тот же adapter contract.

---

## 10. Что запрещено после принятия RFC
После принятия RFC запрещено:

* смешивать две session библиотеки одновременно;
* писать частично свою ratchet-логику;
* менять внешний `PreKey Bundle` contract под удобство библиотеки;
* шифровать message body простым symmetric key без prekey/bootstrap semantics;
* пускать crypto-specific types наружу из adapter layer.

---

## 11. Acceptance criteria для crypto selection
Crypto selection считается закрытой только если есть:

* конкретное имя пакета, версия, license, источник и дата проверки поддержки;
* один выбранный library path и evidence совместимости с целевыми iOS/Android;
* реализованный adapter contract;
* spike или тест, где:
  - создается outbound session,
  - создается inbound session,
  - первое сообщение шифруется,
  - второе устройство его расшифровывает,
  - session state сериализуется и загружается обратно.

Дополнительно приложить команды/сборки, результаты на двух физических телефонах, негативные сценарии, ограничения и независимый review ключей, состояния и bootstrap. Автотесты в Node не заменяют device evidence. Пока этих материалов нет, gate G0 открыт и выбор библиотеки считается гипотезой, а не решением.

---

## 12. Рекомендация для команды
Для MVP самая безопасная организационная стратегия такая:

* слабая модель не трогает выбор библиотеки;
* сильная модель или человек делает один короткий spike;
* после этого слабая модель реализует только adapter/wiring и tests.

---

## 13. Итог
Этот RFC не выбирает самодельную криптографию. Он выбирает дисциплину:

* одна session library;
* один adapter contract;
* нулевая свобода для слабой модели в crypto internals;
* сохранение стабильных protocol contracts независимо от runtime implementation.

## Wire-контракт v2

Версионированная привязка Signal key к Echolet identity/device описана в [PROTOCOL-30](PROTOCOL-30_SIGNAL_BUNDLE_V2.md). Она отделена от v1; relay/mobile интеграция остаётся следующим этапом.
