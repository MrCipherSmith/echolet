# Echolet: MVP Execution Order (BOARD-27)

## 1. Назначение документа
Этот документ — короткая операционная карта проекта. Он нужен не для архитектуры, а для ежедневной работы: что делать сейчас, в каком порядке, и что нельзя трогать раньше времени.

Если все остальные документы — это полная система координат, то этот файл — маршрут по ней.

---

## 2. Главный принцип
Первый приоритет — gate G0 из [DELIVERY-13](DELIVERY-13_SPRINT_PLAN.md): session-library spike на двух телефонах, background/terminated/offline delivery matrix и независимый review архитектуры безопасности. Минимальный harness и contracts допустимы для самого spike. Пока gate открыт, не расширять messaging/UI. Затем строить снизу вверх:

1. contracts;
2. crypto helpers;
3. storage;
4. relay foundation;
5. relay API;
6. client use-cases;
7. session wiring;
8. mailbox orchestration;
9. UI;
10. hardening;
11. demo.

Если перескочить через шаг, слабая модель почти гарантированно начнет компенсировать пробелы выдуманным кодом.

---

## 3. Что делать прямо сейчас

Сначала проверить evidence G0 по [RFC-18](RFC-18_CRYPTO_SELECTION.md). Это относится и к уже существующему прототипу; отсутствие evidence означает открытый gate.

### Если кодовая база еще не инициализирована
Идти по порядку:

1. `BOOTSTRAP-15_REPO_INIT_GUIDE.md`
2. `TASKPACK-19_FIRST_30_TASKS.md`
3. `TASKPACK-20_NEXT_30_TASKS.md`
4. `TASKPACK-21_FINAL_MVP_TASKS.md`

### Если репозиторий уже поднят
Проверить, какой milestone уже реально закрыт:

* если не закрыт `M1` — вернуться к protocol/contracts;
* если не закрыт `M2` — делать relay foundation и identity publishing;
* если не закрыт `M3` — делать contacts и session bootstrap;
* если не закрыт `M4` — делать mailbox/message flow;
* если не закрыт `M5` — делать UI, hardening и acceptance.

---

## 4. Ежедневный порядок действий

## Шаг 1. Определить текущий active milestone
Использовать:

* `DELIVERY-13_SPRINT_PLAN.md`
* `TEST-16_ACCEPTANCE_CHECKLIST.md`

Вопрос: какой milestone еще не принят?

---

## Шаг 2. Выбрать ровно одну следующую атомарную задачу
Использовать:

* `TASKS-10_IMPLEMENTATION_BACKLOG.md`
* соответствующий `TASKPACK-*`

Нельзя брать 3-5 задач сразу.

---

## Шаг 3. Проверить зависимости задачи
Перед началом спросить:

* все ли prerequisites завершены;
* есть ли нужные типы;
* есть ли нужные repositories / handlers / adapters.

Если зависимость не готова, текущую задачу брать нельзя.

---

## Шаг 4. Дать задачу модели по prompt-шаблону
Использовать:

* `PROMPTS-17_AGENT_PROMPTS.md`
* `PLAYBOOK-12_WEAK_MODEL_EXECUTION.md`

---

## Шаг 5. Сделать отдельный review-pass
Даже если задача маленькая.

Использовать:

* review template из `PROMPTS-17_AGENT_PROMPTS.md`

---

## Шаг 6. При необходимости сделать fix-pass
Не совмещать implementation, review и fix в одном заходе.

---

## Шаг 7. Проставить acceptance для задачи
Использовать:

* `TEST-16_ACCEPTANCE_CHECKLIST.md`

Если задача protocol/security critical — acceptance обязателен.

---

## Шаг 8. Записать status/handoff
После каждой завершенной задачи зафиксировать:

* task id;
* какие файлы изменены;
* что реализовано;
* как проверено;
* какой следующий task.

Для этого использовать `STATUS-28_MVP_PROGRESS_TEMPLATE.md`.

---

## 5. Жесткий execution order по фазам

## Phase 0 — Feasibility

Документы: [RFC-18](RFC-18_CRYPTO_SELECTION.md), [DELIVERY-13](DELIVERY-13_SPRINT_PLAN.md).

Stop condition: нельзя продолжать основную session/UI интеграцию без конкретной проверенной библиотеки, device evidence и review архитектуры безопасности.

## Phase A — Bootstrap and contracts
Документы:

* `BOOTSTRAP-15_REPO_INIT_GUIDE.md`
* `TASKPACK-19_FIRST_30_TASKS.md`

Stop condition:

* нельзя идти дальше, пока не закрыт `M1`.

---

## Phase B — Storage and onboarding foundation
Задачи:

* завершение `client-db`
* identity profile creation
* QR export/import draft

Stop condition:

* нельзя делать relay message flow, пока identity/contact base не готов.

---

## Phase C — Relay foundation and API
Документы:

* `TASKPACK-20_NEXT_30_TASKS.md`

Stop condition:

* нельзя делать e2e messaging, пока не работают publish device record / publish prekeys / get prekeys.

---

## Phase D — Session and messaging core
Документы:

* `RFC-18_CRYPTO_SELECTION.md`
* `TASKPACK-21_FINAL_MVP_TASKS.md`

Stop condition:

* нельзя делать polished UI, пока не работает create session -> encrypt -> send -> poll -> decrypt.

---

## Phase E — UI wiring
Документы:

* `TASKPACK-21_FINAL_MVP_TASKS.md`

Stop condition:

* нельзя считать MVP demo-ready, пока UI не проходит полный сценарий без ручных хакающих действий.

---

## Phase F — Hardening and demo
Документы:

* `TEST-16_ACCEPTANCE_CHECKLIST.md`
* `RUNBOOK-22_DEMO_DAY.md`
* `CHECK-26_SECURITY_REVIEW_SCRIPT.md`

Stop condition:

* нельзя объявлять MVP готовым, пока не закрыты P0 issues и не пройден security review; до пилота нужна независимая проверка реализации и gates [PILOT-29](PILOT-29_VALIDATION_PLAN.md).

---

## 6. Что нельзя делать раньше времени

### Нельзя делать красивый UI раньше protocol/contracts
Причина: получится витрина без рабочей основы.

### Нельзя делать media/file flows раньше text MVP
Причина: это почти всегда ломает scope и сроки.

### Нельзя делать onion routing раньше relay-first messaging
Причина: без working mailbox and session model это только усложнение.

### Нельзя менять docs “по ходу кодинга” без change control
Использовать `CHANGE-24_SPEC_CHANGE_CONTROL.md`.

---

## 7. Быстрый decision tree

### Вопрос: что делать следующим?

* Если нет evidence G0 -> `RFC-18` + `DELIVERY-13` (минимальный harness, два телефона, mobile matrix, review)
* Если G0 закрыт и нет workspace -> `BOOTSTRAP-15`
* Если нет protocol types/validators -> `TASKPACK-19`
* Если нет relay publish/fetch flows -> `TASKPACK-20`
* Если нет e2e message delivery -> `TASKPACK-21`
* Если e2e работает, но нет доказательств -> `TEST-16` + `RUNBOOK-22`
* Если demo близко -> `CHECK-26_SECURITY_REVIEW_SCRIPT.md`

---

## 8. Ежедневный минимальный checklist
Каждый рабочий цикл должен заканчиваться ответом на 5 вопросов:

1. Какой task id был завершен?
2. Какой acceptance check был пройден?
3. Появилось ли отклонение от docs?
4. Есть ли новый риск или blocker?
5. Какой следующий task брать завтра?

---

## 9. Итог
Этот документ нужен, чтобы команда и модели не тонули в большом наборе спецификаций.

Если коротко:

* бери один task;
* проверяй зависимости;
* делай implementation -> review -> fix -> acceptance;
* не прыгай вперед;
* не трогай scope beyond MVP.
