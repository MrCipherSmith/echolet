# Echolet: Task Pack for Tasks 31-60 (TASKPACK-20)

> Порядок исполнения обновлён flow 001: сначала G0 из [DELIVERY-13](DELIVERY-13_SPRINT_PLAN.md) и проверка [RFC-18](RFC-18_CRYPTO_SELECTION.md). Номера задач сохранены для трассируемости, но выбор библиотеки J-001 выполняется на G0, а не после остальных пакетов. До закрытия G0 разрешены только изолированные feasibility harness/исправления безопасности и документов; основная реализация messaging ждёт доказательств. Текущая готовность — [STATUS_CURRENT](STATUS_CURRENT.md).

## 1. Назначение документа
Этот документ продолжает `TASKPACK-19_FIRST_30_TASKS.md` и покрывает следующие 30 атомарных задач Echolet MVP. На этом этапе проект выходит из уровня foundation и переходит к:

* завершению `client-db`;
* onboarding use-cases;
* relay foundation;
* relay storage;
* relay handlers;
* client relay integration.

Этот набор задач особенно важен, потому что здесь слабая модель часто начинает путать слои. Поэтому каждый task pack остается строго изолированным.

---

## 2. Правила использования
Для каждого task pack обязательно:

1. выполнить только его;
2. прогнать review-pass;
3. при необходимости прогнать fix-pass;
4. только потом идти дальше.

Источники истины для всех задач:

* `PROTOCOL-07_MVP_MESSAGE_FLOW.md`
* `API-11_JSON_SCHEMAS.md`
* `THREAT-08_MODEL.md`
* `ARCH-09_REPOSITORY_STRUCTURE.md`
* `TASKS-10_IMPLEMENTATION_BACKLOG.md`
* `STACK-14_TECH_DECISIONS.md`
* `PLAYBOOK-12_WEAK_MODEL_EXECUTION.md`

---

## 3. TP-031 = D-005 outbox schema

### Цель
Описать logical schema для исходящей очереди.

### Зависимости
TP-027, TP-029.

### Файлы
* `packages/client-db/src/schema/outbox.ts`

### Шаги
1. Описать поля для outbox item.
2. Включить `message_id`, `conversation_id`, `recipient_identity_id`, `status`, `attempt_count`, `next_retry_at_ms`, `created_at_ms`, `updated_at_ms`.
3. Экспортировать схему.

### Проверка
* схема покрывает retry/backoff use-case.

---

## 4. TP-032 = D-006 receipts schema

### Цель
Описать logical schema для receipts.

### Зависимости
TP-011.

### Файлы
* `packages/client-db/src/schema/receipts.ts`

### Проверка
* можно хранить `receipt_id`, `message_id`, `status`, `created_at_ms`.

---

## 5. TP-033 = D-007 relayConfig schema

### Цель
Описать logical schema для конфигурации relay.

### Файлы
* `packages/client-db/src/schema/relayConfig.ts`

### Проверка
* можно сохранить `relay_base_url`, `relay_fingerprint`, `is_default`, timestamps.

---

## 6. TP-034 = D-008 contactsRepository
Ссылка на уже описанный task из `TASKPACK-19_FIRST_30_TASKS.md`, но теперь его нужно довести до кода.

### Цель
Реализовать CRUD repository для контактов.

### Файлы
* `packages/client-db/src/repositories/contactsRepository.ts`
* tests

### Проверка
* `getById`, `list`, `insert`, `update`, `delete/softDelete` работают.

---

## 7. TP-035 = D-009 messagesRepository

### Цель
Реализовать repository сообщений.

### Файлы
* `packages/client-db/src/repositories/messagesRepository.ts`
* tests

### Шаги
1. Реализовать insert/get/listByConversation/updateStatus.
2. Добавить dedup-safe lookup по `message_id`.

### Проверка
* можно получить историю диалога;
* duplicate insert по `message_id` не создает неконтролируемый дубль, если выбрана guard-логика.

---

## 8. TP-036 = D-010 sessionsRepository

### Цель
Реализовать repository для session state.

### Файлы
* `packages/client-db/src/repositories/sessionsRepository.ts`
* tests

### Проверка
* session state можно сохранить и загрузить по ключу `local_device_id + remote_device_id`.

---

## 9. TP-037 = D-011 outboxRepository

### Цель
Реализовать repository для исходящей очереди.

### Проверка
* можно выбирать pending/retry items;
* можно обновлять `attempt_count` и `next_retry_at_ms`.

---

## 10. TP-038 = D-012 receiptsRepository

### Цель
Реализовать repository для receipts.

### Проверка
* receipt можно сохранить и найти по `receipt_id` или `message_id`.

---

## 11. TP-039 = D-013 relayConfigRepository

### Цель
Реализовать repository конфигурации relay.

### Проверка
* можно сохранить default relay config и загрузить его обратно.

---

## 12. TP-040 = E-001 createIdentityProfile

### Цель
Собрать onboarding use-case создания identity profile.

### Зависимости
TP-017..TP-023, repositories и secure storage abstraction должны быть готовы.

### Файлы
* `packages/client-core/src/identity/createIdentityProfile.ts`
* tests

### Шаги
1. Сгенерировать seed.
2. Derive identity key pair.
3. Generate device id and device key pair.
4. Generate callsign.
5. Собрать `Signed Device Record`.
6. Сохранить seed в secure storage abstraction.
7. Сохранить profile metadata в db.

### Запрещено
* сохранять seed в обычную БД;
* пропускать подписание `DeviceRecord`.

### Проверка
* use-case возвращает profile object;
* seed оказывается только в secure storage mock.

---

## 13. TP-041 = E-002 loadIdentityProfile

### Цель
Загрузить локальный identity profile.

### Проверка
* profile читается из db + secure storage abstraction без утечки секретов в return shape.

---

## 14. TP-042 = E-003 exportQrContact

### Цель
Собрать QR payload контакта строго по spec.

### Файлы
* `packages/client-core/src/contacts/exportQrContact.ts`
* tests

### Проверка
* output shape совпадает с `ContactQrPayload`;
* вложенный `device_record` остается валидным.

---

## 15. TP-043 = E-004 importQrContact

### Цель
Импортировать QR payload и провалидировать его.

### Шаги
1. Провалидировать QR payload schema.
2. Проверить `device_record` schema.
3. Проверить подпись `device_record`.
4. Вычислить safety number.
5. Вернуть draft contact для подтверждения пользователем.

### Проверка
* invalid QR payload отклоняется;
* неподписанный или битый `device_record` отклоняется.

---

## 16. TP-044 = E-005 verifyContact

### Цель
Пометить контакт как verified после подтверждения пользователя.

### Проверка
* `trust_state` меняется только явным действием.

---

## 17. TP-045 = E-006 importInvite

### Цель
Реализовать import remote invite без автоматического доверия.

### Проверка
* invite import не ставит `verified` автоматически;
* identity fingerprint показывается пользователю.

---

## 18. TP-046 = F-001 relay main bootstrap

### Цель
Поднять минимальный relay server process.

### Файлы
* `apps/relay/cmd/relay/main.go`

### Шаги
1. Загрузить config.
2. Создать logger.
3. Собрать router.
4. Запустить HTTP server.

### Проверка
* сервер стартует локально без crash.

---

## 19. TP-047 = F-002 relay config loader

### Цель
Реализовать typed config loader через env.

### Файлы
* `apps/relay/internal/config/config.go`
* tests при возможности

### Проверка
* можно прочитать обязательные env vars;
* есть sane defaults для dev.

---

## 20. TP-048 = F-003 structured logger

### Цель
Создать `slog`-based logger.

### Проверка
* logger можно инжектить в server dependencies;
* нет logging secrets по умолчанию.

---

## 21. TP-049 = F-004 HTTP router

### Цель
Собрать `chi` router и route registration.

### Проверка
* routes могут подключаться через отдельные handler modules.

---

## 22. TP-050 = F-005 health endpoint
Повторно зафиксированный task как часть этого taskpack для непрерывности выполнения.

### Проверка
* `GET /health` возвращает `200` и JSON envelope.

---

## 23. TP-051 = F-006 request id middleware

### Цель
Добавить request id middleware.

### Проверка
* каждый запрос получает request id в context/response headers, если такая стратегия выбрана.

---

## 24. TP-052 = F-007 recover middleware

### Цель
Защитить relay от panic crash на уровне HTTP handler chain.

### Проверка
* panic внутри test handler возвращает controlled error response.

---

## 25. TP-053 = F-008 rate limit middleware

### Цель
Добавить базовый rate limiting middleware.

### Проверка
* частые запросы начинают получать controlled rejection.

---

## 26. TP-054 = G-001 deviceRecord repo

### Цель
Реализовать Badger repo для device records.

### Файлы
* `apps/relay/internal/storage/badger/device_record_repo.go`
* tests

### Проверка
* запись/чтение по `device_id` работает.

---

## 27. TP-055 = G-002 prekey repo

### Цель
Реализовать Badger repo для prekey bundles.

### Проверка
* bundle можно сохранить и получить по `identity_id`.

---

## 28. TP-056 = G-003 mailbox repo

### Цель
Реализовать Badger repo для mailbox envelopes.

### Проверка
* можно добавлять envelope, list batch, ack/remove items.

---

## 29. TP-057 = G-004 challenge repo

### Цель
Реализовать repo для mailbox challenges.

### Проверка
* challenge можно создать, получить, удалить/инвалидировать.

---

## 30. TP-058 = H-001 deviceRecord service

### Цель
Реализовать service layer для publish device record.

### Шаги
1. Принять validated DTO.
2. Проверить signature.
3. Сохранить через repo.
4. Вернуть service result.

### Проверка
* invalid signature отклоняется;
* valid record сохраняется.

---

## 31. TP-059 = H-002 publish device record handler

### Цель
Реализовать `POST /v1/device-records/publish`.

### Проверка
* handler принимает valid JSON;
* вызывает service;
* возвращает spec-compliant envelope.

---

## 32. TP-060 = H-003 prekey service

### Цель
Реализовать service layer для publish/get prekey bundle.

### Проверка
* valid bundle сохраняется;
* invalid bundle/signature отклоняется;
* get bundles возвращает данные по `identity_id`.

---

## 33. Итог
После задач 31-60 проект должен иметь:

* завершенный `client-db` фундамент;
* onboarding and contact use-cases;
* relay process с middleware и storage;
* первые production-shaped service/handler слои.

До завершения и приемки этого taskpack нельзя переходить к полноценному mailbox message flow и e2e messaging demo.
