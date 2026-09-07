# Echolet: Specification Change Control (CHANGE-24)

## 1. Назначение документа
Этот документ описывает, как менять спецификации Echolet без разрушения согласованности между docs, backlog, кодом и тестами.

Он особенно важен при работе со слабой моделью, потому что такие модели склонны:

* самовольно менять контракты;
* переименовывать сущности;
* “улучшать” JSON shape;
* добавлять новые assumptions без обновления документации.

---

## 2. Главный принцип
Изменение спецификации допустимо только как управляемое действие, а не как побочный эффект написания кода.

Правильный порядок:

1. обнаружить необходимость изменения;
2. зафиксировать change proposal;
3. оценить impact;
4. обновить docs;
5. обновить backlog/taskpacks/tests;
6. только потом менять код.

Запрещенный порядок:

1. поменять код;
2. потом объяснить, что “так лучше”.

---

## 3. Какие изменения считаются значимыми
Значимым считается любое изменение, которое затрагивает хотя бы одно из:

* JSON contract;
* security behavior;
* entity naming;
* repository structure;
* acceptance criteria;
* threat model assumptions;
* backlog dependencies.

---

## 4. Change categories

### C1 — Editorial
Примеры:

* исправление формулировки;
* улучшение ясности текста;
* выравнивание терминологии без изменения смысла.

Такое изменение можно делать быстро, но оно все равно должно не противоречить остальным документам.

### C2 — Structural
Примеры:

* перенос раздела;
* уточнение task order;
* изменение repository path при сохранении behavior.

Требует проверки зависимых документов.

### C3 — Contract change
Примеры:

* новое поле в JSON schema;
* изменение request/response shape;
* изменение mailbox id formula.

Требует обновления всех зависимых docs, tasks и tests до изменения кода.

### C4 — Security change
Примеры:

* изменение challenge-response flow;
* ослабление signature checks;
* изменение trust model.

Такие изменения нельзя делать слабой моделью без человека или сильной модели-куратора.

---

## 5. Обязательный формат change proposal
Перед значимым изменением должен быть короткий блок:

```text
Change ID: CHG-YYYYMMDD-XX
Type: C1 / C2 / C3 / C4
Reason:
- ...

Affected docs:
- ...

Affected code areas:
- ...

Affected tests:
- ...

Risk:
- low / medium / high

Decision:
- approved / rejected
```

---

## 6. Документы, которые чаще всего требуют совместного обновления

### Если меняется JSON contract
Нужно проверить и при необходимости обновить:

* `PROTOCOL-07_MVP_MESSAGE_FLOW.md`
* `API-11_JSON_SCHEMAS.md`
* `TASKS-10_IMPLEMENTATION_BACKLOG.md`
* `TASKPACK-*`
* `TEST-16_ACCEPTANCE_CHECKLIST.md`

### Если меняется security behavior
Нужно проверить и при необходимости обновить:

* `THREAT-08_MODEL.md`
* `SEC-01_IDENTITY.md`
* `PROTOCOL-07_MVP_MESSAGE_FLOW.md`
* `RFC-18_CRYPTO_SELECTION.md`
* acceptance and negative tests docs

### Если меняется repo structure
Нужно проверить и при необходимости обновить:

* `ARCH-09_REPOSITORY_STRUCTURE.md`
* `BOOTSTRAP-15_REPO_INIT_GUIDE.md`
* `TASKS-10_IMPLEMENTATION_BACKLOG.md`
* `PROMPTS-17_AGENT_PROMPTS.md`

---

## 7. Change approval rules

### 7.1. Что может менять слабая модель без approval
Только `C1` editorial changes, если они не меняют смысл.

### 7.2. Что требует approval
* любой `C2`
* любой `C3`
* любой `C4`

Approval должен давать человек или сильная модель, acting as architect/reviewer.

---

## 8. Red flags
Изменение должно быть автоматически остановлено, если слабая модель:

* добавляет новые JSON поля без proposal;
* переименовывает `DeviceRecord`, `PreKey Bundle`, `Mailbox Envelope`;
* меняет mailbox challenge string;
* ослабляет mandatory validation;
* заменяет выбранную library на другую;
* меняет acceptance criteria “по ходу”.

---

## 9. Minimal change workflow for weak models
Если изменение все же нужно и его делает слабая модель, workflow такой:

1. сначала только перечислить proposed changes;
2. не менять код;
3. после approval обновить docs;
4. после docs update обновить tests/taskpacks;
5. только потом править code.

---

## 10. Definition of controlled change
Изменение считается контролируемым, только если:

* есть reason;
* есть список affected docs;
* есть список affected code areas;
* обновлены acceptance criteria;
* обновлены taskpacks или backlog, если нужно.

---

## 11. Итог
Этот документ нужен, чтобы Echolet не расползался по версиям спецификаций и не превращался в набор несовместимых решений.

Правило одно: сначала осознанное изменение спецификации, потом код. Не наоборот.

## CHG-20260906-001 — Assessment remediation

Status: applied documentation corrections; runtime/product acceptance remains open.

- Reason: unsupported metadata claim, contradictory transport/auth descriptions and delivery order, historical readiness duplicated across status files.
- Contract: preserve HTTP JSON wire behavior; document exact existing device-signed create/poll/ack requests and ownership rules. Atomic challenge consumption fixes implementation of single-use semantics without widening the API.
- Security: comparative metadata-privacy promise removed. Prototype session engine and installed community candidate are not accepted for production. Mobile demo is fail-closed outside explicit development opt-in.
- Planning: G0 and independent review move before dependent delivery/pilot; PILOT-29 records a hypothesis and pending metrics, not completed research.
- Affected docs: SEC-01, REP-02, APP-03, STORY-04, PLAN-05, PROTOCOL-07, THREAT-08, API-11, DELIVERY-13, STACK-14, RFC-18, OPS-23, BOARD-27, TEST-16, status entrypoints and linked taskpack prerequisites.
- Evidence: [flow 001](../.metaproject/flows/001-2026-09-05-echolet-assessment-fixes/description.md), [current status](STATUS_CURRENT.md), [crypto blocker report](../.metaproject/flows/001-2026-09-05-echolet-assessment-fixes/crypto-report.md).

Only dated executable evidence can close runtime acceptance. No production release, sensitive-use approval or market-validation result is implied.

## 2026-09-06 — Official session reference

- Scope: isolated `packages/session-node`, pinned official libsignal 0.102.0 and encrypted atomic SQLite state/outbox. Existing mobile/relay v1 is unchanged.
- Decision: advance official runtime evaluation after rejecting community trust bypass; Node evidence is not mobile G0 acceptance.
- Contracts: `TransactionalStore` commits state and outbox before returning ciphertext; remote identity must be explicitly pinned. Native PreKeyBundle is in-process reference only. Future wire migration requires a versioned schema including Kyber and signed identity/device binding.
- Affected docs: RFC-18, STACK-14, TRACE-25, STATUS_CURRENT, package README, flow official-session-spec.md and verification report.
- Tests: persistent sessions, explicit trust rejection, replay/tamper, exact retries, transaction rollback/concurrency, process SIGKILL and Unicode content-id regression.

## 2026-09-06 — Signal wire v2 contract

- Add strict independent SignalPreKeyBundleV2 schema and fixed signing transcript; preserve v1.
- Bind root-signed DeviceRecord to device-signed full native bundle; expected identity/device supplied by trusted caller, no automatic trust on import.
- Add Node export/verified import and JSON roundtrip/negative signature tests.
- Direct-exchange one-time prekey only; no relay allocation or mobile readiness claim. See PROTOCOL-30 and flow signal-wire-v2-spec.md.
