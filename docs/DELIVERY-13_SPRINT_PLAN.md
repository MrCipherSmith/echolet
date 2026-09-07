# Echolet: Delivery Plan, Milestones & Readiness Gates (DELIVERY-13)

## 1. Назначение документа
Этот документ превращает backlog и protocol-spec в управляемый delivery plan. Он нужен, чтобы проект можно было вести по неделям, не теряя реализационную дисциплину.

Документ рассчитан на MVP delivery в режиме:

* 1-2 инженера;
* активное использование AI-моделей;
* необходимость держать scope под контролем;
* высокий приоритет на security baseline, а не на широту функций.

---

## 2. Главный delivery-принцип
Каждая стадия должна завершаться **демонстрируемым результатом**, а не только набором файлов.

Недостаточно сказать “реализовали prekeys”.
Нужно доказать:

* какие сценарии теперь работают;
* какие тесты покрывают поведение;
* какие риски закрыты;
* какие ограничения остаются.

---

## 3. Общий план по волнам

### Gate G0 — Session и mobile feasibility (первый приоритет)
До продолжения основного messaging/UI выполнить фазу 0 [PLAN-05](PLAN-05_ROADMAP.md) и [RFC-18](RFC-18_CRYPTO_SELECTION.md): конкретная библиотека/версия, два физических телефона, восстановление сессии после перезапуска, задержанные/повторные сообщения, матрица foreground/background/terminated/offline. Провести независимый review архитектуры безопасности. Для уже написанного прототипа gate выполняется сейчас; существующий код не означает его прохождение. Результаты пока не приложены.

### Wave 0. Foundation
Результат:

* есть монорепа;
* есть структура проекта;
* есть protocol types и validators.

### Wave 1. Identity and Relay Bootstrap
Результат:

* клиент создает identity;
* репитер принимает device record;
* репитер принимает prekey bundle.

### Wave 2. Contact Exchange and Session Bootstrap
Результат:

* QR contact exchange работает;
* клиент получает bundle контакта;
* создается первая session.

### Wave 3. Messaging MVP
Результат:

* одно устройство отправляет сообщение;
* второе получает его через mailbox poll;
* отправляется `delivered` receipt.

### Wave 4. Reliability and Hardening
Результат:

* retry/backoff есть;
* oversized payload отклоняется;
* challenge replay отклоняется;
* poisoned payload не ломает polling.

### Wave 5. Demo-Ready Mobile Flow
Результат:

* onboarding экран;
* contacts экран;
* chat экран;
* terminal diagnostics;
* полный demo flow с двух клиентов.

---

## 4. План по неделям

## Week 0 — Feasibility gate G0

Первый timebox: 5 рабочих дней на session spike и mobile delivery matrix. Если времени недостаточно, записать blocker и новый объем эксперимента; не считать gate пройденным по истечении срока. Разрешены минимальные contracts и test harness, необходимые spike. Выбор библиотеки переносится сюда из Week 6.

Выход: evidence по RFC-18, фактический режим доставки для каждой целевой платформы, независимый review ключей/сессий/метаданных, решение proceed/rework/stop.

Недели ниже — условная последовательность после G0, а не обещание десятинедельного срока.

## Week 1 — Workspace and Protocol Contracts

### Цели недели
* создать каркас монорепы;
* зафиксировать protocol constants;
* реализовать типы, схемы и validators.

### Задачи
* `A-001..A-003`
* `B-001..B-009`

### Deliverables
* структура директорий готова;
* `packages/protocol` экспортирует все MVP-типы;
* validators покрыты тестами.

### Readiness gate
Неделя считается завершенной только если:

* все domain objects из `API-11_JSON_SCHEMAS.md` представлены типами и validators;
* negative tests существуют минимум для `DeviceRecord`, `PreKeyBundle`, `MailboxEnvelope`;
* нет дублирующих типов вне `packages/protocol`.

### Основные риски
* модель начнет копировать типы вручную в другие пакеты;
* schema и docs начнут расходиться.

### Митигации
* жесткий review на каждый protocol task;
* запрет на работу над `client-core` до завершения gate.

---

## Week 2 — Crypto and Local Storage

### Цели недели
* реализовать helpers для encoding/signatures/mailbox id;
* подготовить локальный клиентский storage.

### Задачи
* `C-001..C-014`
* `D-001..D-013`

### Deliverables
* есть стабильный canonical JSON serializer;
* есть mailbox id derivation;
* есть repositories для contacts/messages/sessions/outbox/receipts.

### Readiness gate
* все crypto helpers имеют unit tests;
* `deriveMailboxId` соответствует `PROTOCOL-07_MVP_MESSAGE_FLOW.md`;
* repository tests проходят на локальном adapter.

### Основные риски
* самодельная и нестабильная сериализация подписываемых объектов;
* хранение секретов не в secure storage, а в обычной БД.

### Митигации
* отдельный review-pass на crypto tasks;
* hard stop, если seed попадает в db schema.

---

## Week 3 — Relay Foundation and Persistence

### Цели недели
* поднять Go relay skeleton;
* реализовать config, logger, router, middleware;
* реализовать Badger repositories.

### Задачи
* `F-001..F-008`
* `G-001..G-004`

### Deliverables
* relay стартует локально;
* есть health endpoint;
* есть storage layer для device records, prekeys, mailbox, challenges.

### Readiness gate
* `apps/relay` запускается без runtime crash;
* каждый repo имеет happy-path test;
* rate limit и recover middleware подключены.

### Основные риски
* API handlers начнут писать логику напрямую в storage;
* не будет четкой сервисной границы.

### Митигации
* запрет на прямой вызов storage из handlers;
* code review по `ARCH-09_REPOSITORY_STRUCTURE.md`.

---

## Week 4 — Relay API Contracts in Code

### Цели недели
* реализовать все MVP handlers на репитере.

### Задачи
* `H-001..H-012`

### Deliverables
* publish device record работает;
* publish/get prekeys работает;
* send message работает;
* mailbox challenge/poll/ack работает;
* cleanup service заготовлен.

### Readiness gate
* каждый endpoint соответствует `API-11_JSON_SCHEMAS.md`;
* error codes соответствуют `PROTOCOL-07_MVP_MESSAGE_FLOW.md`;
* invalid signature и oversize payload отклоняются.

### Основные риски
* слабая модель захочет менять JSON ради удобства Go-кода;
* challenge logic будет реализована слишком упрощенно.

### Митигации
* использовать copy-paste contracts из `API-11_JSON_SCHEMAS.md`;
* отдельно ревьюить `mailbox challenge` flow.

---

## Week 5 — Client Identity, Contacts and Relay Integration

### Цели недели
* реализовать onboarding use-cases;
* реализовать QR exchange;
* подключить relay API client.

### Задачи
* `E-001..E-006`
* `I-001..I-008`

### Deliverables
* клиент создает identity profile;
* может экспортировать/импортировать QR-contact;
* может публиковать device record и prekey bundle;
* может запрашивать bundle контакта.

### Readiness gate
* contact import требует явного подтверждения;
* relay API client нормализует ошибки;
* published bundle можно получить обратно и провалидировать.

### Основные риски
* логика контактов начнет доверять callsign;
* модель начнет хранить seed в обычном store.

### Митигации
* security review на onboarding и contacts;
* ручная проверка storage paths.

---

## Week 6 — Sessions and Messaging Core

### Цели недели
* интегрировать библиотеку и версию, подтвержденные gate G0;
* создать outbound/inbound session adapters;
* реализовать шифрование, дешифрование и outbox state.

### Задачи
* `J-001..J-012`

### Deliverables
* первая сессия создается;
* исходящее сообщение шифруется;
* входящее envelope дешифруется;
* локальные статусы сообщений обновляются.

### Readiness gate
* gate G0 пройден, библиотека/версия и device evidence зафиксированы по RFC-18;
* plaintext не отправляется на relay;
* decrypt failure обрабатывается безопасно.

### Основные риски
* регрессии ранее проверенной библиотечной интеграции;
* смешивание plaintext и ciphertext логики;
* отсутствие idempotency по `message_id`.

### Митигации
* повторить проверки G0 при смене библиотеки, версии или native bridge;
* review на `decryptIncomingEnvelope` и `processReceipt`.

---

## Week 7 — Mailbox Polling and End-to-End Flow

### Цели недели
* реализовать mailbox orchestration;
* соединить send/poll/ack/delivered receipt в один e2e flow.

### Задачи
* `K-001..K-005`
* `N-001..N-007`

### Deliverables
* полный e2e сценарий работает локально;
* `delivered` receipt приходит обратно;
* duplicate `message_id` не дублирует сообщение в UI/БД.

### Readiness gate
* demo flow от нового пользователя до доставки сообщения проходит;
* mailbox без challenge не читается;
* ack удаляет или помечает envelope корректно.

### Основные риски
* polling loop ломается на одном плохом envelope;
* ack и dedup реализованы непоследовательно.

### Митигации
* negative tests на poisoned envelope;
* отдельная проверка quarantine behavior.

---

## Week 8 — Mobile UI and Demo Readiness

### Цели недели
* подключить экраны к use-cases;
* собрать demo-путь без глубокого polish.

### Задачи
* `L-001..L-008`

### Deliverables
* onboarding screen;
* contacts screen;
* chat list;
* chat screen;
* terminal diagnostics;
* settings screen.

### Readiness gate
* пользователь может пройти сценарий без работы через devtools;
* terminal показывает реальные события, а не фейковые статусы;
* ни один экран не содержит собственной protocol-логики.

### Основные риски
* UI начнет дублировать client-core;
* появятся фейковые статусы вместо фактической телеметрии.

### Митигации
* UI review только на wiring и presentation;
* terminal events — только из diagnostics store.

---

## Week 9 — Hardening Week

### Цели недели
* закрыть базовые abuse/security/reliability дыры.

### Задачи
* `M-001..M-008`
* `N-008..N-011`

### Deliverables
* retry/backoff;
* TTL cleanup;
* quota/rate limiting;
* negative tests на invalid signature, expired challenge, oversize payload, decrypt failure.

### Readiness gate
* threat model P0-угрозы покрыты минимальными митигациями;
* нет известных crash loops на mailbox processing;
* relay не принимает oversized payload.

### Основные риски
* hardening оставят “на потом”;
* demo работает, но security baseline дырявый.

### Митигации
* P0 issues блокируют переход к demo-ready статусу.

---

## Week 10 — Buffer and Documentation Freeze

### Цели недели
* починить найденные дефекты;
* добить недостающие тесты;
* обновить docs под фактическую реализацию.

### Deliverables
* все critical defects закрыты;
* docs и код не расходятся;
* можно передавать проект следующей команде или модели.

### Readiness gate
* есть reproducible demo setup;
* есть список известных ограничений MVP;
* handoff docs актуальны.

---

## 5. Milestones

### M1 — Contracts Locked
Готово, когда завершены `A` и `B`.

### M2 — Relay Accepts Identity Data
Готово, когда завершены `C`, `F`, `G`, `H-001..H-005`.

### M3 — First Secure Session
Готово, когда завершены `E`, `I`, `J`.

### M4 — End-to-End Message Delivery
Готово, когда завершены `K` и `N-001..N-007`.

### M5 — Demo-Ready MVP
Готово, когда завершены `L`, `M`, `N` и закрыты P0 issues.

---

## 6. Go / No-Go gates

### Gate A: Before Relay API implementation
Нельзя начинать `H-*`, пока не готовы:

* protocol types;
* validators;
* error codes;
* storage repos.

### Gate B: Before Session implementation
Нельзя начинать `J-*`, пока не готовы:

* identity profile creation;
* contact import;
* publish/get prekey bundle;
* client db repositories.

### Gate C: Before UI polish
Нельзя делать polish и “красоту”, пока не готовы:

* send message;
* mailbox poll;
* decrypt incoming;
* delivered receipt.

---

## 7. Приоритизация дефектов

### P0
Блокируют продолжение delivery:

* seed leakage;
* invalid signature accepted;
* mailbox readable without challenge;
* plaintext reaches relay;
* reproducible crash on malformed payload.

### P1
Нужно исправить до demo-ready:

* duplicate messages in common flows;
* missing retry/backoff;
* terminal shows false statuses;
* relay cleanup does not work.

### P2
Можно перенести после MVP demo:

* minor UI inconsistencies;
* non-critical naming cleanup;
* optional telemetry improvements.

---

## 8. Риски проекта в целом

### 8.1. Scope creep
Риск: команда попытается добавить BLE, media, onion, push до завершения text MVP.

Митигация:
* BLE, media и onion — отложенный backlog после решения по пилоту; проверка фоновой доставки и решение о необходимости push входят в G0, даже если реализация push отложена.

### 8.2. Free-model drift
Риск: слабая модель начнет перепридумывать архитектуру.

Митигация:
* обязательное использование `PLAYBOOK-12_WEAK_MODEL_EXECUTION.md`.

### 8.3. Crypto indecision
Риск: слишком долго выбирать bootstrap/session library.

Митигация:
* решение принимается рано, до основного messaging implementation.

### 8.4. UI-first temptation
Риск: проект будет выглядеть красиво, но не иметь надежного e2e flow.

Митигация:
* основной UI идет после milestone `M4`; минимальный device harness для G0 делается раньше.

---

## 9. Что считать успешным MVP
Echolet MVP считается успешно доставленным, если выполняется полный сценарий:

1. Пользователь A создает identity.
2. Пользователь A публикует device record и prekeys на своем relay.
3. Пользователь B добавляет A как контакт через QR.
4. Пользователь B отправляет первое защищенное текстовое сообщение.
5. Пользователь A забирает его через mailbox poll.
6. Пользователь B получает `delivered` receipt.
7. Relay не видит plaintext.
8. Mailbox нельзя прочитать без challenge-response.

Если хоть один из этих пунктов не работает, MVP не считается завершенным.

---

## 10. Gate перед пилотом

Demo-ready не равен pilot-ready. До набора 5–10 пар пройти независимую проверку реализованного security-critical пути, устранить блокирующие замечания и приложить mobile delivery evidence. Критерии, сбор данных и решение о продолжении — в [PILOT-29](PILOT-29_VALIDATION_PLAN.md). Результаты пользовательского исследования пока отсутствуют.

## 11. Итог
Этот delivery plan нужен, чтобы Echolet строился как инженерный продукт, а не как набор красивых, но несвязанных идей.

Правильная последовательность:

* session/mobile feasibility и ранний security review (G0);
* contracts;
* crypto and storage;
* relay;
* client use-cases;
* e2e messaging;
* UI;
* hardening.
