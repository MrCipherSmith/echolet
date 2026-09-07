# Echolet: MVP Progress Status Template (STATUS-28)

## 1. Назначение документа
Этот документ задает единый шаблон статуса прогресса для Echolet MVP. Он нужен для:

* handoff между сессиями;
* еженедельного статуса команды;
* отчетов слабой модели после выполнения задачи;
* отслеживания blockers и следующего шага.

Шаблон должен быть коротким, но достаточно структурированным, чтобы не терять контекст.

---

## Правило источника истины

Актуальный статус ведётся только в [STATUS_CURRENT.md](STATUS_CURRENT.md). Этот файл — шаблон, а не evidence готовности. Каждый PASS должен ссылаться на датированный запуск; отдельно указывать исторический результат, текущее выполнение и непроведённую проверку. Unit tests не подтверждают прохождение mobile/pilot/security gates.

## 2. Шаблон статуса после одной задачи

```text
Task ID: <ID>
Status: done / in_review / blocked

What was implemented:
- ...

Files changed:
- path/to/file
- path/to/file

Checks performed:
- unit test ...
- manual verification ...

Acceptance result:
- PASS / FAIL

Issues found:
- none / ...

Next recommended task:
- <ID>
```

---

## 3. Шаблон daily status

```text
Date: <YYYY-MM-DD>
Current milestone: <M1/M2/M3/M4/M5>

Completed today:
- <task id> <short result>
- <task id> <short result>

In progress:
- <task id>

Blocked:
- <task id> because ...

Acceptance checks passed today:
- ...

Risks / concerns:
- ...

Next task:
- <task id>
```

---

## 4. Шаблон milestone status

```text
Milestone: <M1/M2/M3/M4/M5>
Status: not_started / in_progress / ready_for_acceptance / accepted / blocked

Completed requirements:
- R-...
- R-...

Completed task ranges:
- TASKPACK-... items ...

Acceptance evidence:
- tests ...
- manual flow ...

Open blockers:
- ...

P0 issues:
- none / ...

Decision:
- continue implementation
- run acceptance
- blocked until fix
```

---

## 5. Шаблон pre-demo status

```text
Demo target date: <YYYY-MM-DD>
Demo status: green / yellow / red

Working flows:
- onboarding
- publish device record
- publish prekeys
- QR contact import
- first encrypted message
- mailbox poll
- delivered receipt

Not ready:
- ...

Security review status:
- PASS / FAIL / pending

Runbook readiness:
- complete / incomplete

Known risks for demo:
- ...

Go / No-Go:
- GO
- NO-GO because ...
```

---

## 6. Как использовать шаблон слабой модели
После каждого task execution слабая модель должна возвращать хотя бы формат из раздела 2.

После завершения каждой 3-5 задач или рабочего дня нужно собирать формат из раздела 3.

Перед acceptance milestone использовать формат из раздела 4.

Перед live demo использовать формат из раздела 5.

---

## 7. Что запрещено в статусах
В статусах нельзя писать расплывчатые формулировки:

* "почти готово"
* "вроде работает"
* "скорее всего норм"
* "осталось немного"

Нужно писать только проверяемые формулировки:

* какой task выполнен;
* какой тест прошел;
* какой blocker есть;
* какой следующий шаг.

---

## 8. Итог
Этот шаблон нужен, чтобы прогресс Echolet был управляемым и передаваемым, особенно если над ним работают несколько сессий или разные модели.

Короткое правило:

* каждый task заканчивается status block;
* каждый milestone заканчивается milestone status;
* каждый demo начинается с pre-demo status.
