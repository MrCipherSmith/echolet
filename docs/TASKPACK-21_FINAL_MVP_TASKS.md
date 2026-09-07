# Echolet: Final Task Pack to First End-to-End MVP Demo (TASKPACK-21)

> Порядок исполнения обновлён flow 001: сначала G0 из [DELIVERY-13](DELIVERY-13_SPRINT_PLAN.md) и проверка [RFC-18](RFC-18_CRYPTO_SELECTION.md). Номера задач сохранены для трассируемости, но выбор библиотеки J-001 выполняется на G0, а не после остальных пакетов. До закрытия G0 разрешены только изолированные feasibility harness/исправления безопасности и документов; основная реализация messaging ждёт доказательств. Текущая готовность — [STATUS_CURRENT](STATUS_CURRENT.md).

## 1. Назначение документа
Этот документ завершает цепочку `TASKPACK-19_FIRST_30_TASKS.md` и `TASKPACK-20_NEXT_30_TASKS.md`. Он покрывает последние атомарные задачи, необходимые для первого полного e2e demo Echolet MVP.

На этом этапе задача уже не в построении foundation, а в соединении всех слоев в один рабочий сценарий:

* relay handlers;
* client relay API;
* session adapter wiring;
* create/encrypt/send flow;
* mailbox challenge/poll/ack flow;
* decrypt/store/receipt flow;
* mobile screens для demo;
* acceptance и negative tests.

---

## 2. Definition of success
Этот taskpack считается завершенным только если проходит полный сценарий из `RUNBOOK-22_DEMO_DAY.md`:

1. A создает identity;
2. A публикует device record и prekeys;
3. B добавляет A через QR;
4. B отправляет первое зашифрованное сообщение;
5. A забирает его через mailbox poll;
6. A отправляет `delivered` receipt;
7. B видит статус `delivered`.

Без этого taskpack не считается закрытым, даже если большая часть файлов уже написана.

---

## 3. Правила использования
Каждую задачу выполнять отдельно. После каждой задачи:

1. сделать review-pass;
2. при необходимости fix-pass;
3. зафиксировать handoff summary.

Источники истины:

* `PROTOCOL-07_MVP_MESSAGE_FLOW.md`
* `THREAT-08_MODEL.md`
* `API-11_JSON_SCHEMAS.md`
* `ARCH-09_REPOSITORY_STRUCTURE.md`
* `TASKS-10_IMPLEMENTATION_BACKLOG.md`
* `TEST-16_ACCEPTANCE_CHECKLIST.md`
* `RFC-18_CRYPTO_SELECTION.md`
* `RUNBOOK-22_DEMO_DAY.md`

---

## 4. TP-061 = H-004 publish prekeys handler

### Цель
Реализовать `POST /v1/prekeys/publish`.

### Зависимости
TP-060, relay router, prekey repo.

### Файлы
* `apps/relay/internal/api/handlers/prekeys_publish.go`
* возможно updates в router/service files
* tests

### Шаги
1. Принять request body по контракту.
2. Провалидировать schema.
3. Передать в prekey service.
4. Вернуть success/error envelope.

### Запрещено
* писать storage logic внутри handler;
* менять response shape.

### Проверка
* valid bundle returns `ok: true`;
* invalid bundle returns controlled error.

---

## 5. TP-062 = H-005 get prekeys handler

### Цель
Реализовать `GET /v1/prekeys/:identityId`.

### Проверка
* handler возвращает spec-compliant bundles list;
* unknown identity returns controlled not-found behavior.

---

## 6. TP-063 = H-006 mailbox service

### Цель
Реализовать core service для mailbox operations.

### Шаги
1. Реализовать `storeEnvelope`.
2. Реализовать `listEnvelopes`.
3. Реализовать `ackEnvelopes`.
4. Соблюсти batch limits и TTL rules.

### Проверка
* envelopes сохраняются и читаются batch'ами;
* ack удаляет или помечает записи согласно repo semantics.

---

## 7. TP-064 = H-007 send message handler

### Цель
Реализовать `POST /v1/messages/send`.

### Шаги
1. Принять `MailboxEnvelope`.
2. Провалидировать schema.
3. Проверить размер и TTL.
4. Передать в mailbox service.
5. Вернуть `accepted + relayed`.

### Проверка
* valid envelope accepted;
* oversized payload rejected;
* malformed envelope rejected.

---

## 8. TP-065 = H-008 challenge service

### Цель
Реализовать service для mailbox challenge lifecycle.

### Шаги
1. Создать challenge.
2. Сохранить challenge в repo.
3. Проверить expiration.
4. Реализовать invalidate/consume behavior.

### Проверка
* challenge создается одноразовым;
* expired challenge невалиден.

---

## 9. TP-066 = H-009 mailbox challenge handler

### Цель
Реализовать `POST /v1/mailbox/challenge`.

### Проверка
* valid request returns `challenge_id`, `nonce`, `expires_at_ms`;
* malformed request rejected.

---

## 10. TP-067 = H-010 mailbox poll handler

### Цель
Реализовать `POST /v1/mailbox/poll`.

### Шаги
1. Принять poll request.
2. Проверить challenge existence and TTL.
3. Проверить signature.
4. Проверить device ownership/identity association.
5. Вернуть mailbox batch.

### Проверка
* valid poll returns envelopes;
* invalid signature rejected;
* expired challenge rejected;
* reused challenge rejected.

---

## 11. TP-068 = H-011 mailbox ack handler

### Цель
Реализовать `POST /v1/mailbox/ack`.

### Проверка
* valid ack подтверждает batch;
* invalid signature rejected;
* repeated ack безопасен.

---

## 12. TP-069 = H-012 cleanup service

### Цель
Реализовать фоновую очистку TTL-expired данных.

### Проверка
* expired challenges удаляются;
* expired envelopes удаляются;
* cleanup job можно запускать вручную в тесте.

---

## 13. TP-070 = I-001 relay API client

### Цель
Создать typed client для mobile-side relay API.

### Файлы
* `apps/mobile/src/services/relayApi.ts`
* возможно `packages/client-core/src/relay/*`

### Шаги
1. Описать методы для всех MVP endpoints.
2. Нормализовать success/error envelope.
3. Централизовать HTTP calls.

### Проверка
* API client умеет вызывать все endpoints по типам;
* ошибки парсятся централизованно.

---

## 14. TP-071 = I-002 publishDeviceRecord use-case

### Цель
Реализовать client-side publish device record.

### Проверка
* use-case отправляет `device_record` на relay;
* response корректно обрабатывается.

---

## 15. TP-072 = I-003 publishPreKeyBundle use-case

### Цель
Реализовать client-side publish prekey bundle.

### Проверка
* valid bundle публикуется;
* response сохраняется/логируется корректно.

---

## 16. TP-073 = I-004 fetchPreKeyBundles use-case

### Цель
Реализовать запрос bundle'ов контакта.

### Проверка
* bundle fetch работает;
* response проходит local validation before use.

---

## 17. TP-074 = I-005 sendEnvelope use-case

### Цель
Реализовать client-side отправку `MailboxEnvelope`.

### Проверка
* valid envelope отправляется;
* relay response обновляет message state.

---

## 18. TP-075 = I-006 createMailboxChallenge use-case

### Цель
Реализовать client-side вызов `mailbox/challenge`.

### Проверка
* use-case получает challenge payload и возвращает его orchestration layer.

---

## 19. TP-076 = I-007 pollMailbox use-case

### Цель
Реализовать client-side вызов `mailbox/poll`.

### Проверка
* valid signature path returns envelopes;
* API errors correctly mapped.

---

## 20. TP-077 = I-008 ackMailbox use-case

### Цель
Реализовать client-side вызов `mailbox/ack`.

### Проверка
* ack request отправляется и обрабатывается корректно.

---

## 21. TP-078 = J-001 choose concrete session library

### Цель
Сделать короткий decision spike и зафиксировать конкретный runtime package по `RFC-18_CRYPTO_SELECTION.md`.

### Важно
Эта задача не для слабой модели без supervision.

### Проверка
* есть зафиксированное решение;
* есть короткий spike-proof: create session -> encrypt -> decrypt.

---

## 22. TP-079 = J-002 createOutboundSession adapter

### Цель
Реализовать outbound session initialization через выбранный adapter.

### Проверка
* session создается из local identity/device и remote prekey bundle.

---

## 23. TP-080 = J-003 createInboundSession adapter

### Цель
Реализовать inbound session initialization.

### Проверка
* inbound side может поднять session из первого incoming ciphertext/bootstrap context.

---

## 24. TP-081 = J-004 saveSession

### Цель
Сохранять serialized session state в sessions repository.

### Проверка
* serialized session записывается и читается обратно.

---

## 25. TP-082 = J-005 loadSession

### Цель
Загружать session state из repository.

### Проверка
* existing session корректно восстанавливается;
* missing session обрабатывается предсказуемо.

---

## 26. TP-083 = J-006 createChatMessage
Уже подготовленный task из prompt pack, теперь реализуется в коде.

### Проверка
* создается plaintext object строго по contract.

---

## 27. TP-084 = J-007 encryptOutgoingMessage

### Цель
Шифровать `ChatMessage` через существующую session.

### Шаги
1. Сериализовать plaintext message.
2. Передать bytes в session adapter.
3. Вернуть ciphertext + transport-compatible wrapper.

### Проверка
* ciphertext получается non-empty;
* plaintext не уходит в transport layer.

---

## 28. TP-085 = J-008 decryptIncomingEnvelope

### Цель
Дешифровать incoming envelope и вернуть plaintext domain object.

### Проверка
* valid ciphertext decrypts;
* broken ciphertext returns controlled error, not crash.

---

## 29. TP-086 = J-009 queueOutgoingMessage

### Цель
Класть исходящее сообщение в outbox и связывать его с local message record.

### Проверка
* message state становится `queued`;
* outbox item создается.

---

## 30. TP-087 = J-010 markMessageRelayed

### Цель
Обновлять message status после успешного relay acceptance.

### Проверка
* статус меняется на `relayed`.

---

## 31. TP-088 = J-011 markMessageDelivered

### Цель
Обновлять message status после receipt `delivered`.

### Проверка
* статус меняется на `delivered`.

---

## 32. TP-089 = J-012 processReceipt

### Цель
Обработать входящий receipt и обновить локальное состояние.

### Проверка
* valid receipt updates target message;
* duplicate receipt не ломает состояние.

---

## 33. TP-090 = K-001 runMailboxPollCycle

### Цель
Собрать orchestration challenge -> sign -> poll -> process -> ack.

### Шаги
1. Вычислить mailbox id.
2. Запросить challenge.
3. Подписать challenge string.
4. Выполнить poll.
5. Передать envelopes на обработку.
6. Ack успешных envelopes.

### Проверка
* полный cycle проходит happy path.

---

## 34. TP-091 = K-002 processMailboxBatch

### Цель
Обработать batch envelopes без падения на одном плохом элементе.

### Проверка
* good envelopes продолжают обрабатываться, даже если один broken.

---

## 35. TP-092 = K-003 quarantineEnvelope

### Цель
Изолировать poisoned envelope после лимита неудачных попыток.

### Проверка
* envelope помечается отдельно и перестает ломать polling loop.

---

## 36. TP-093 = K-004 dedup by message_id

### Цель
Не допускать дублирования сообщения в локальной истории.

### Проверка
* повторный envelope с тем же `message_id` не создает второй visible message.

---

## 37. TP-094 = K-005 poisoned envelope retry limit

### Цель
Ограничить число попыток обработки broken envelopes.

### Проверка
* после лимита envelope quarantine'ится.

---

## 38. TP-095 = L-001 app navigation skeleton

### Цель
Собрать минимальную навигацию mobile demo app.

### Проверка
* доступны onboarding, contacts, chats, terminal, settings.

---

## 39. TP-096 = L-002 onboarding screen

### Цель
Подключить create identity flow к UI.

### Проверка
* пользователь может создать identity через экран.

---

## 40. TP-097 = L-003 seed backup screen

### Цель
Показать seed confirmation step.

### Проверка
* seed display контролируем и не логируется;
* пользователь должен явно подтвердить backup step.

---

## 41. TP-098 = L-004 contacts screen

### Цель
Подключить QR export/import и verified contacts view.

### Проверка
* контакт можно экспортировать и импортировать через UI.

---

## 42. TP-099 = L-005 chat list screen

### Цель
Показать список диалогов.

### Проверка
* новый диалог появляется после отправки/получения сообщения.

---

## 43. TP-100 = L-006 chat screen

### Цель
Подключить send message flow и отображение статусов.

### Проверка
* сообщение отправляется из UI;
* статус меняется `queued -> relayed -> delivered`.

---

## 44. TP-101 = L-007 terminal screen

### Цель
Показать реальные diagnostics events.

### Проверка
* terminal отображает фактические события: publish, bundle fetch, challenge, poll, decrypt, receipt.

---

## 45. TP-102 = L-008 settings screen

### Цель
Показать relay config и security settings.

### Проверка
* relay config читается и обновляется из UI без обхода core layers.

---

## 46. TP-103 = M-001 retry/backoff for outbox

### Цель
Добавить retry policy для исходящей очереди.

### Проверка
* network failure увеличивает `attempt_count` и двигает `next_retry_at_ms`.

---

## 47. TP-104 = M-002 send delivered receipt on successful decrypt

### Цель
Автоматически отправлять `delivered` receipt после успешной обработки сообщения.

### Проверка
* decrypt success triggers receipt generation and send path.

---

## 48. TP-105 = M-003 relay quotas

### Цель
Ограничить storage abuse на relay.

### Проверка
* quota exceed returns controlled error.

---

## 49. TP-106 = M-004 relay TTL cleanup job

### Цель
Реализовать периодический cleanup expired data.

### Проверка
* expired envelopes and challenges disappear after cleanup.

---

## 50. TP-107 = M-005 prekey refill threshold check

### Цель
Напомнить или инициировать refresh prekeys при падении count ниже threshold.

### Проверка
* low prekey count обнаруживается корректно.

---

## 51. TP-108 = M-006 biometric lock integration

### Цель
Подключить biometric lock в mobile app.

### Проверка
* app lock работает или корректно деградирует в dev.

---

## 52. TP-109 = M-007 manual purge conversation

### Цель
Реализовать ручную очистку локальной истории диалога.

### Проверка
* conversation local messages удаляются без ломания identity/session layer.

---

## 53. TP-110 = M-008 terminal diagnostics store

### Цель
Сделать единый diagnostics store для terminal UI.

### Проверка
* события можно записывать и отображать централизованно.

---

## 54. TP-111 = N-001 e2e create identity

### Цель
Написать/собрать e2e проверку identity creation.

### Проверка
* сценарий green.

---

## 55. TP-112 = N-002 e2e publish device record
### Проверка
* publish device record path green.

## 56. TP-113 = N-003 e2e publish/fetch prekeys
### Проверка
* publish and fetch bundle green.

## 57. TP-114 = N-004 e2e import contact via QR
### Проверка
* QR import and verification flow green.

## 58. TP-115 = N-005 e2e first encrypted message
### Проверка
* first encrypted message reaches recipient.

## 59. TP-116 = N-006 e2e mailbox poll and ack
### Проверка
* challenge/poll/ack flow green.

## 60. TP-117 = N-007 e2e delivered receipt
### Проверка
* sender sees delivered status.

## 61. TP-118 = N-008 negative invalid signature rejected
### Проверка
* invalid signature paths rejected on relay/client.

## 62. TP-119 = N-009 negative expired challenge rejected
### Проверка
* expired challenge path red as expected.

## 63. TP-120 = N-010 negative oversize payload rejected
### Проверка
* oversize request rejected by relay.

## 64. TP-121 = N-011 negative decrypt failure quarantined
### Проверка
* broken envelope не валит polling and gets quarantined after retry limit.

---

## 65. Финальный acceptance gate
Taskpack `TASKPACK-21_FINAL_MVP_TASKS.md` считается выполненным только если одновременно соблюдены все условия:

* пройдены `M4` и `M5` из `TEST-16_ACCEPTANCE_CHECKLIST.md`;
* пройден сценарий из `RUNBOOK-22_DEMO_DAY.md`;
* P0 issues отсутствуют;
* relay не видит plaintext;
* mailbox без challenge-response не читается;
* duplicate messages не появляются в обычном happy path.

---

## 66. Что делать после завершения этого taskpack
После завершения этого taskpack проект считается дошедшим до первого полного MVP demo. Следующие шаги уже относятся не к первоначальной реализации, а к:

* polishing;
* stabilization;
* better device management;
* improved metrics;
* future RFCs beyond MVP.
