# Echolet: Acceptance Checklist & Demo Verification (TEST-16)

## 1. Назначение документа
Этот документ задает единые критерии приемки для Echolet MVP. Его задача — убрать ситуацию, когда команда считает функцию "готовой", потому что код написан, но не может доказать, что сценарий реально работает.

Документ нужен для:

* проверки milestone'ов;
* приемки отдельных модулей;
* финальной демонстрации MVP;
* работы со слабой моделью, которой нужны четкие yes/no критерии.

---

## 2. Главный принцип приемки
Любой результат считается принятым только если одновременно выполнены 4 условия:

* **код существует**;
* **контракт соблюден**;
* **поведение проверено**;
* **нет security regression**.

Если хотя бы один пункт не выполнен, задача или milestone не принимается.

---

## 3. Уровни приемки

### 3.1. Уровень 1 — File/Module Acceptance
Проверяется отдельный файл, validator, repository, handler или use-case.

### 3.2. Уровень 2 — Flow Acceptance
Проверяется законченный сценарий, например `publish prekey bundle` или `mailbox poll`.

### 3.3. Уровень 3 — Milestone Acceptance
Проверяется группа завершенных сценариев.

### 3.4. Уровень 4 — MVP Demo Acceptance
Проверяется весь продуктовый сценарий от onboarding до delivery receipt.

---

## 4. Базовый checklist для любой задачи
Перед приемкой любой задачи нужно ответить `да/нет` на каждый пункт.

### 4.1. Структура
* Файлы лежат в правильных местах по `ARCH-09_REPOSITORY_STRUCTURE.md`.
* Не создано дублирующих типов вне `packages/protocol`, если тип уже существует.
* Не добавлено лишних зависимостей.

### 4.2. Контракт
* Реализация соответствует `PROTOCOL-07_MVP_MESSAGE_FLOW.md`.
* JSON shape соответствует `API-11_JSON_SCHEMAS.md`.
* Имена сущностей совпадают с зафиксированной терминологией.

### 4.3. Проверка
* Есть минимум один happy-path test или четкая ручная проверка.
* Есть минимум один negative-path test, если код связан с protocol/security.
* Поведение воспроизводимо локально.

### 4.4. Безопасность
* Не ослаблены подписи, challenge-response или validation.
* Не логируются seed, private keys, plaintext body.
* Нет новых очевидных дыр из `THREAT-08_MODEL.md`.

---

## 5. Acceptance checklist для M1 — Contracts Locked

### Milestone scope
Соответствует milestone `M1` из `DELIVERY-13_SPRINT_PLAN.md`.

### Должно быть готово
* workspace структура;
* `packages/protocol`;
* protocol constants;
* все основные types;
* все основные schemas;
* validators на core objects.

### Проверки
* `DeviceRecord`, `PreKeyBundle`, `MailboxEnvelope`, `ChatMessage`, `Receipt` описаны как TS types.
* Для каждого из этих объектов есть runtime validation.
* Есть error codes из `PROTOCOL-07_MVP_MESSAGE_FLOW.md`.
* Есть tests на invalid payload для как минимум трех critical объектов.

### Не принимается, если
* shape одного и того же объекта отличается между файлами;
* часть контрактов существует только в docs и не отражена в коде;
* validators принимают payload без обязательных полей.

---

## 6. Acceptance checklist для M2 — Relay Accepts Identity Data

### Должно быть готово
* crypto helpers для identity/signature/mailbox id;
* relay skeleton;
* relay repos;
* `POST /v1/device-records/publish`;
* `POST /v1/prekeys/publish`;
* `GET /v1/prekeys/:identityId`.

### Проверки
* relay запускается локально;
* `GET /health` отвечает успешно;
* valid `device_record` публикуется;
* invalid `device_record` отклоняется;
* valid `prekey_bundle` публикуется;
* invalid signature в bundle отклоняется;
* опубликованный bundle можно запросить обратно.

### Ручной demo сценарий
1. Запустить relay.
2. Отправить валидный `device_record`.
3. Получить `ok: true`.
4. Отправить валидный `prekey_bundle`.
5. Получить `ok: true`.
6. Получить bundle по `identityId`.

### Не принимается, если
* handlers ходят напрямую в storage без service layer;
* relay принимает invalid JSON или invalid signature как valid;
* bundle fetch возвращает shape, отличный от API spec.

---

## 7. Acceptance checklist для M3 — First Secure Session

До приёмки обязательны конкретная версия библиотеки и G0 evidence по [RFC-18](RFC-18_CRYPTO_SELECTION.md): inbound/outbound trust rejection, ответы и одновременная отправка, delayed/replay/tamper, перезапуск с устойчивым сохранением session/outbox без повторного использования ключей. Node spike отдельно от evidence двух телефонов. Установленная версия community candidate с воспроизведённым inbound trust bypass не считается принятой.

Development-only messaging guard — временное ограничение прототипа, а не выполнение M3. Нельзя убрать guard на основании только зелёных unit tests. Независимый review и допуск к пилоту проверяются отдельно по [PILOT-29](PILOT-29_VALIDATION_PLAN.md).


### Должно быть готово
* onboarding use-cases;
* QR contact exchange;
* relay API client;
* fetch prekey bundle;
* session bootstrap adapter;
* session persistence.

### Проверки
* клиент создает identity profile;
* QR payload экспортируется по spec;
* contact import требует подтверждения;
* bundle контакта можно получить и провалидировать;
* создается outbound session;
* входящая сторона может создать inbound session.

### Не принимается, если
* контакт доверяется только по callsign;
* bootstrap сессии работает без `PreKey Bundle`;
* библиотека для session layer заменена на ad-hoc encryption.

---

## 8. Acceptance checklist для M4 — End-to-End Message Delivery

### Должно быть готово
* create chat message;
* encrypt outgoing message;
* send envelope;
* mailbox challenge;
* mailbox poll;
* decrypt incoming envelope;
* ack mailbox;
* delivered receipt.

### Проверки
* plaintext сообщение превращается в ciphertext;
* relay получает только envelope/ciphertext;
* mailbox не читается без challenge-response;
* получатель успешно расшифровывает сообщение;
* ack удаляет или корректно помечает envelope;
* отправитель получает `delivered` receipt.

### Обязательный e2e сценарий
1. Пользователь A онлайн.
2. Пользователь B имеет контакт A.
3. Пользователь B отправляет сообщение A.
4. Envelope сохраняется на relay.
5. Пользователь A выполняет mailbox poll.
6. A расшифровывает сообщение.
7. A отправляет `delivered` receipt.
8. B получает обновленный статус.

### Не принимается, если
* plaintext body уходит на relay;
* mailbox poll работает без challenge signature;
* duplicate `message_id` создает дубли в локальной истории;
* decrypt failure валит polling loop.

---

## 9. Acceptance checklist для M5 — Demo-Ready MVP

### Должно быть готово
* основные mobile screens;
* terminal diagnostics;
* retry/backoff;
* TTL cleanup;
* quota/rate limiting;
* negative tests по P0/P1 угрозам.

### Проверки
* onboarding можно пройти с UI;
* QR contact exchange выполняется через UI;
* отправка сообщения выполняется через UI;
* terminal показывает реальные события;
* relay quota и size limits реально работают;
* expired challenge отклоняется;
* malformed payload не ломает client process.

### Не принимается, если
* demo возможен только через ручные DB edits;
* terminal рисует фейковые статусы;
* UI содержит дублирующую protocol-логику;
* P0 issue остается открытой.

---

## 10. Security-specific acceptance checklist
Этот раздел обязателен для любой приемки после M2.

### 10.1. Seed и ключи
* Seed не хранится в обычной SQLite/JSON БД.
* Private keys не пишутся в логи.
* Export seed в clipboard отсутствует в MVP.

### 10.2. Identity и contact trust
* Callsign не используется как proof of identity.
* Подписи `device_record` проверяются.
* Подписи `prekey_bundle` проверяются.

### 10.3. Mailbox auth
* `mailbox/challenge` генерирует одноразовый challenge.
* `mailbox/poll` без валидной подписи не работает.
* expired challenge отклоняется.
* replayed challenge не дает повторный доступ.

### 10.4. Message processing
* malformed ciphertext не валит приложение;
* duplicate message не создает duplicate UI entries;
* oversized payload отклоняется на relay.

---

## 11. Manual verification script для финального demo

### Подготовка
* Запустить relay локально.
* Подготовить два клиента: A и B.
* Очистить их локальные базы.

### Сценарий
1. На A создать новую identity.
2. На A опубликовать device record и prekeys.
3. На B создать identity.
4. На B импортировать контакт A по QR.
5. На B получить prekey bundle A.
6. На B отправить первое сообщение A.
7. Убедиться, что relay получил envelope, а не plaintext.
8. На A выполнить mailbox poll.
9. Убедиться, что сообщение видно в UI и расшифровано.
10. Проверить, что B получил `delivered` receipt.
11. Попробовать невалидный mailbox poll без подписи и убедиться, что доступ отклонен.
12. Попробовать oversized payload и убедиться, что relay отвечает ошибкой.

### Финальный expected result
Все 12 шагов проходят без ручного изменения базы или кода.

---

## 12. Regression checklist после каждого большого изменения
После любой нетривиальной доработки нужно быстро проверить:

* publish device record все еще работает;
* publish/fetch prekey bundle все еще работает;
* mailbox challenge/poll/ack все еще работает;
* одно сообщение все еще доставляется end-to-end;
* delivered receipt все еще приходит;
* seed и plaintext не начали случайно логироваться.

---

## 13. Acceptance result format
Результат приемки всегда должен фиксироваться в одном формате:

```text
Acceptance target: <task / flow / milestone>
Status: PASS / FAIL

Checked items:
- ...
- ...

Failures:
- ...

Evidence:
- test names
- manual steps
- screenshots/log references if needed

Decision:
- accepted / rejected
```

---

## 14. Итог
Этот документ делает приемку Echolet бинарной и проверяемой.

Правильный вопрос теперь не "кажется ли это готовым", а "прошло ли это checklist без нарушений protocol и security baseline".
