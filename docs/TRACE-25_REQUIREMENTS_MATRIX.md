# Echolet: Requirements Traceability Matrix (TRACE-25)

## 1. Назначение документа
Этот документ связывает требования Echolet между уровнями:

* требование;
* документ-источник;
* задачи реализации;
* тесты/acceptance;
* demo evidence.

Он нужен для того, чтобы можно было ответить на вопрос: "где это требование описано, чем реализуется и как проверяется?"

---

## 2. Формат матрицы

Колонки:

* `Req ID`
* `Требование`
* `Источник`
* `Реализация`
* `Тест/Acceptance`
* `Demo Evidence`

---

## 3. Матрица требований

| Req ID | Требование | Источник | Реализация | Тест/Acceptance | Demo Evidence |
| :--- | :--- | :--- | :--- | :--- | :--- |
| R-001 | Пользователь может создать identity из seed | `SEC-01_IDENTITY.md`, `PROTOCOL-07_MVP_MESSAGE_FLOW.md` | `E-001`, `L-002`, `L-003` | `N-001`, `M3/M5 acceptance` | onboarding on client A |
| R-002 | Identity Public Key является главным идентификатором | `SEC-01_IDENTITY.md` | protocol types, contact logic | protocol review, contact acceptance | profile summary / QR payload |
| R-003 | Callsign является UX alias, а не proof of identity | `SEC-01_IDENTITY.md`, `THREAT-08_MODEL.md` | `E-004`, `E-005`, UI trust state | security acceptance checklist | contact verification screen |
| R-004 | DeviceRecord должен быть подписан identity key | `PROTOCOL-07_MVP_MESSAGE_FLOW.md`, `THREAT-08_MODEL.md` | `C-010`, `C-011`, `H-001`, `H-002` | `N-008`, M2 acceptance | publish device record log |
| R-005 | PreKey Bundle должен публиковаться и запрашиваться через relay | `PROTOCOL-07_MVP_MESSAGE_FLOW.md` | `H-003`, `H-004`, `H-005`, `I-003`, `I-004` | `N-003`, M2/M3 acceptance | terminal event `bundle fetched` |
| R-006 | Первая session создается через prekey bootstrap, а не ad-hoc encryption | `PROTOCOL-07_MVP_MESSAGE_FLOW.md`, `RFC-18_CRYPTO_SELECTION.md` | `J-001`, `J-002`, `J-003` | M3 acceptance | first encrypted send |
| R-007 | Текстовые сообщения должны быть E2EE | `SEC-01_IDENTITY.md`, `PROTOCOL-07_MVP_MESSAGE_FLOW.md` | `J-007`, `J-008`, `H-007`, `I-005` | `N-005`, M4 acceptance | relay has no plaintext |
| R-008 | Relay хранит только ciphertext envelope | `REP-02_REPEATER_NODE.md`, `PROTOCOL-07_MVP_MESSAGE_FLOW.md` | `G-003`, `H-006`, `H-007` | M4 acceptance, security acceptance | relay log/storage inspection |
| R-009 | Mailbox требует challenge-response | `SEC-01_IDENTITY.md`, `PROTOCOL-07_MVP_MESSAGE_FLOW.md`, `THREAT-08_MODEL.md` | `C-013`, `H-008..H-011`, `I-006..I-008`, `K-001` | `N-006`, `N-009`, security acceptance | invalid poll denied |
| R-010 | Expired challenge отклоняется | `PROTOCOL-07_MVP_MESSAGE_FLOW.md`, `THREAT-08_MODEL.md` | `H-008`, `H-010`, `K-001` | `N-009` | failed invalid mailbox access |
| R-011 | Duplicate messages не должны дублироваться в истории | `PROTOCOL-07_MVP_MESSAGE_FLOW.md`, `THREAT-08_MODEL.md` | `D-009`, `K-004` | M4 acceptance | repeated envelope does not duplicate UI |
| R-012 | Broken ciphertext не должен валить polling loop | `THREAT-08_MODEL.md` | `J-008`, `K-002`, `K-003`, `K-005` | `N-011`, hardening acceptance | continued poll after bad item |
| R-013 | Seed не хранится в обычной DB | `SEC-01_IDENTITY.md`, `THREAT-08_MODEL.md` | `E-001`, secure storage adapter, `L-003` | security acceptance | dev inspection / no seed in db |
| R-014 | QR import должен требовать подтверждения пользователя | `STORY-04_USER_SCENARIOS.md`, `PROTOCOL-07_MVP_MESSAGE_FLOW.md` | `E-004`, `E-005`, `L-004` | M3/M5 acceptance | verified contact flow |
| R-015 | Relay должен ограничивать oversized payload | `PROTOCOL-07_MVP_MESSAGE_FLOW.md`, `THREAT-08_MODEL.md`, `OPS-23_LOCAL_ENV_VARS.md` | `H-007`, `M-003` | `N-010`, security acceptance | oversized request rejected |
| R-016 | Relay должен очищать expired data по TTL | `REP-02_REPEATER_NODE.md`, `PROTOCOL-07_MVP_MESSAGE_FLOW.md` | `H-012`, `M-004` | hardening acceptance | cleanup demo/log |
| R-017 | Отправитель должен получать `delivered` receipt | `PROTOCOL-07_MVP_MESSAGE_FLOW.md` | `J-011`, `J-012`, `M-002` | `N-007`, M4 acceptance | status becomes delivered |
| R-018 | Terminal должен показывать реальные diagnostics events | `APP-03_MOBILE_CLIENT.md`, `RUNBOOK-22_DEMO_DAY.md` | `M-008`, `L-007` | M5 acceptance | terminal screen live during demo |
| R-019 | Система должна быть реализуема по атомарным задачам | `TASKS-10_IMPLEMENTATION_BACKLOG.md`, `PLAYBOOK-12_WEAK_MODEL_EXECUTION.md` | `TASKPACK-19`, `TASKPACK-20`, `TASKPACK-21` | process review | execution by task packs |
| R-020 | MVP demo должен проходить без ручного изменения базы или кода | `RUNBOOK-22_DEMO_DAY.md`, `TEST-16_ACCEPTANCE_CHECKLIST.md` | весь e2e stack | final MVP acceptance | full live demo |

---

## Дополнительные gates после оценки проекта

| Req ID | Требование | Источник | Реализация / работа | Evidence сейчас |
|---|---|---|---|---|
| R-021 | Криптобиблиотека проходит inbound/outbound trust rejection и mobile feasibility до основной реализации | RFC-18, DELIVERY-13 G0 | flow 001 T7/T9/T10/T17 | Community spike выявил bypass; официальный Node reference проверяет trust rejection, atomic persistence и SIGKILL recovery. Mobile feasibility остаётся открытым gate |
| R-022 | Непроверенная демонстрация не доступна release-пользователям | APP-03, OPS-23 | flow 001 T13 | MessagingScreen component regression tests |
| R-023 | Сравнительные обещания защиты метаданных требуют доказательств | SEC-01, THREAT-08 | flow 001 T5 | Необоснованное обещание удалено; identity остаётся видимой в envelope |
| R-024 | Независимая проверка предшествует sensitive-use пилоту | PLAN-05, PILOT-29 | flow 001 T11 | pending |
| R-025 | Продолжение развития опирается на результаты ограниченного пилота | PILOT-29 | flow 001 T12 | pending; критерии предложены, исследование не выполнено |
| R-026 | Только один текущий статус с датированными доказательствами | STATUS_CURRENT, STATUS-28 | flow 001 T8 | Старые status entrypoints перенаправляют на STATUS_CURRENT |

## 4. Как обновлять матрицу
Матрицу нужно обновлять, если меняется хотя бы одно из:

* новое требование;
* изменение протокола;
* изменение acceptance criteria;
* появление нового taskpack;
* новый demo evidence path.

---

## 5. Быстрые правила чтения матрицы

### Если нужно понять, где реализуется требование
Смотри колонку `Реализация`.

### Если нужно понять, как требование проверяется
Смотри колонку `Тест/Acceptance`.

### Если нужно понять, что показать на demo
Смотри колонку `Demo Evidence`.

---

## 6. Итог
Эта матрица превращает Echolet из набора документов в трассируемую систему требований.

Теперь на каждый важный вопрос можно ответить не общими словами, а связкой:

* где требование сформулировано;
* где оно реализуется;
* каким тестом оно подтверждается;
* как его показать на demo.
