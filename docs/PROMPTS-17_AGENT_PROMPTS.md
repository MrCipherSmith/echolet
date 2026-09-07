# Echolet: Ready-to-Use Prompts for Weak Models (PROMPTS-17)

## 1. Назначение документа
Этот документ содержит готовые copy-paste промпты для слабой или бесплатной модели. Они заточены под первые задачи Echolet MVP и используют уже созданные спецификации.

Каждый промпт должен применяться отдельно. Нельзя объединять 3-5 задач в один большой запрос.

---

## 2. Общий базовый префикс
Этот префикс нужно добавлять почти к каждому prompt:

```text
Работай строго в рамках проекта Echolet MVP.

Главные документы-источники истины:
1. PROTOCOL-07_MVP_MESSAGE_FLOW.md
2. THREAT-08_MODEL.md
3. API-11_JSON_SCHEMAS.md
4. ARCH-09_REPOSITORY_STRUCTURE.md
5. TASKS-10_IMPLEMENTATION_BACKLOG.md
6. STACK-14_TECH_DECISIONS.md
7. PLAYBOOK-12_WEAK_MODEL_EXECUTION.md

Правила:
- Выполняй только одну задачу
- Не меняй архитектуру
- Не меняй JSON contracts
- Не упрощай security behavior
- Не добавляй новые библиотеки без необходимости
- В конце перечисли измененные файлы и способ проверки
```

---

## 3. Prompt для A-001 — root workspace

```text
Работай строго в рамках проекта Echolet MVP.

Главные документы-источники истины:
1. ARCH-09_REPOSITORY_STRUCTURE.md
2. TASKS-10_IMPLEMENTATION_BACKLOG.md
3. STACK-14_TECH_DECISIONS.md
4. BOOTSTRAP-15_REPO_INIT_GUIDE.md

Выполни только задачу A-001 из TASKS-10_IMPLEMENTATION_BACKLOG.md.

Нужно:
- создать root workspace файлы
- подготовить package.json
- подготовить pnpm-workspace.yaml
- подготовить .gitignore
- подготовить .editorconfig

Ограничения:
- не создавать код приложений
- не добавлять лишние пакеты
- не менять структуру монорепы

В результате:
- покажи список созданных файлов
- кратко объясни содержимое
- укажи, как проверить workspace
```

---

## 4. Prompt для A-003 — base tsconfig

```text
Работай строго в рамках проекта Echolet MVP.

Документы:
1. ARCH-09_REPOSITORY_STRUCTURE.md
2. TASKS-10_IMPLEMENTATION_BACKLOG.md
3. STACK-14_TECH_DECISIONS.md
4. BOOTSTRAP-15_REPO_INIT_GUIDE.md

Выполни только задачу A-003.

Нужно:
- создать tsconfig.base.json
- подготовить базовые tsconfig.json для TypeScript packages
- сделать так, чтобы конфиг был пригоден для monorepo

Нельзя:
- создавать runtime code
- добавлять нестандартные path aliases без необходимости
- включать настройки, которые противоречат простому workspace setup

В конце:
- перечисли файлы
- покажи ключевые compiler options
- опиши, как проверить `tsc --noEmit`
```

---

## 5. Prompt для B-001 — protocol constants

```text
Работай строго в рамках проекта Echolet MVP.

Документы:
1. PROTOCOL-07_MVP_MESSAGE_FLOW.md
2. API-11_JSON_SCHEMAS.md
3. ARCH-09_REPOSITORY_STRUCTURE.md
4. TASKS-10_IMPLEMENTATION_BACKLOG.md
5. STACK-14_TECH_DECISIONS.md

Выполни только задачу B-001.

Нужно:
- создать protocolVersion.ts
- создать limits.ts
- создать errorCodes.ts
- экспортировать константы из packages/protocol

Ограничения:
- брать значения только из спецификаций
- не придумывать новые error codes
- не писать validators или schemas в этой задаче

В конце:
- перечисли файлы
- перечисли экспортируемые константы
- опиши минимальную проверку
```

---

## 6. Prompt для B-004 — validateDeviceRecord

```text
Работай строго в рамках проекта Echolet MVP.

Документы:
1. PROTOCOL-07_MVP_MESSAGE_FLOW.md
2. API-11_JSON_SCHEMAS.md
3. THREAT-08_MODEL.md
4. ARCH-09_REPOSITORY_STRUCTURE.md
5. TASKS-10_IMPLEMENTATION_BACKLOG.md
6. STACK-14_TECH_DECISIONS.md

Выполни только задачу B-004.

Нужно:
- реализовать validateDeviceRecord
- использовать zod schema
- вернуть понятный typed result
- добавить минимум 1 happy-path test и 2 invalid tests

Нельзя:
- проверять криптографическую подпись в этой задаче
- расширять JSON contract
- менять shape DeviceRecord

В конце:
- перечисли измененные файлы
- кратко объясни поведение validator
- перечисли тестовые кейсы
```

---

## 7. Prompt для C-002 — canonical JSON serializer

```text
Работай строго в рамках проекта Echolet MVP.

Документы:
1. PROTOCOL-07_MVP_MESSAGE_FLOW.md
2. THREAT-08_MODEL.md
3. ARCH-09_REPOSITORY_STRUCTURE.md
4. TASKS-10_IMPLEMENTATION_BACKLOG.md
5. STACK-14_TECH_DECISIONS.md

Выполни только задачу C-002.

Нужно:
- реализовать deterministic canonical JSON serializer
- удалять поле signature
- сортировать ключи ASCII-порядком
- возвращать стабильную строку
- добавить unit tests

Нельзя:
- использовать нестабильную JSON-магическую библиотеку
- менять protocol rules
- добавлять подпись или verify в этой задаче

В конце:
- перечисли файлы
- опиши алгоритм
- перечисли тест-кейсы стабильности
```

---

## 8. Prompt для C-012 — deriveMailboxId

```text
Работай строго в рамках проекта Echolet MVP.

Документы:
1. PROTOCOL-07_MVP_MESSAGE_FLOW.md
2. THREAT-08_MODEL.md
3. ARCH-09_REPOSITORY_STRUCTURE.md
4. TASKS-10_IMPLEMENTATION_BACKLOG.md
5. STACK-14_TECH_DECISIONS.md

Выполни только задачу C-012.

Нужно:
- реализовать deriveMailboxId
- использовать SHA-256 по правилу из protocol doc
- вернуть значение в base64url
- покрыть unit tests

Нельзя:
- придумывать новый format string
- хранить salt на сервере
- менять формулу derivation

В конце:
- перечисли файлы
- напиши точную формулу derivation
- опиши тесты на детерминизм
```

---

## 9. Prompt для D-008 — contactsRepository

```text
Работай строго в рамках проекта Echolet MVP.

Документы:
1. ARCH-09_REPOSITORY_STRUCTURE.md
2. TASKS-10_IMPLEMENTATION_BACKLOG.md
3. STACK-14_TECH_DECISIONS.md

Выполни только задачу D-008.

Нужно:
- реализовать contactsRepository
- поддержать getById, list, insert, update, delete или softDelete
- написать repository tests

Ограничения:
- не смешивать repository с UI logic
- не добавлять сетевые вызовы
- не хранить seed или private keys в contacts repository

В конце:
- перечисли файлы
- перечисли поддерживаемые операции
- опиши тесты
```

---

## 10. Prompt для F-005 — health endpoint

```text
Работай строго в рамках проекта Echolet MVP.

Документы:
1. ARCH-09_REPOSITORY_STRUCTURE.md
2. TASKS-10_IMPLEMENTATION_BACKLOG.md
3. STACK-14_TECH_DECISIONS.md
4. BOOTSTRAP-15_REPO_INIT_GUIDE.md

Выполни только задачу F-005.

Нужно:
- реализовать health endpoint в apps/relay
- использовать chi router
- вернуть простой JSON success response
- добавить минимальный test или manual verification note

Нельзя:
- начинать писать message handlers
- смешивать health endpoint с business logic

В конце:
- перечисли файлы
- покажи expected response shape
- опиши способ проверки curl
```

---

## 11. Prompt для H-002 — publish device record handler

```text
Работай строго в рамках проекта Echolet MVP.

Документы:
1. PROTOCOL-07_MVP_MESSAGE_FLOW.md
2. API-11_JSON_SCHEMAS.md
3. THREAT-08_MODEL.md
4. ARCH-09_REPOSITORY_STRUCTURE.md
5. TASKS-10_IMPLEMENTATION_BACKLOG.md
6. STACK-14_TECH_DECISIONS.md

Выполни только задачу H-002.

Нужно:
- реализовать handler POST /v1/device-records/publish
- принять JSON строго по контракту
- провалидировать schema
- вызвать service layer
- вернуть success/error envelope

Нельзя:
- писать storage access прямо из handler
- менять JSON response format
- пропускать invalid payloads

В конце:
- перечисли файлы
- опиши request/response
- опиши negative cases
```

---

## 12. Prompt для I-001 — relayApi.ts

```text
Работай строго в рамках проекта Echolet MVP.

Документы:
1. PROTOCOL-07_MVP_MESSAGE_FLOW.md
2. API-11_JSON_SCHEMAS.md
3. ARCH-09_REPOSITORY_STRUCTURE.md
4. TASKS-10_IMPLEMENTATION_BACKLOG.md
5. STACK-14_TECH_DECISIONS.md

Выполни только задачу I-001.

Нужно:
- создать typed relay API client для mobile app
- поддержать endpoints MVP
- нормализовать success/error envelope

Нельзя:
- смешивать API client с UI state
- захардкодить конкретный экранный сценарий
- менять API contracts

В конце:
- перечисли файлы
- покажи какие методы API client экспортирует
- опиши обработку ошибок
```

---

## 13. Prompt для J-006 — createChatMessage

```text
Работай строго в рамках проекта Echolet MVP.

Документы:
1. PROTOCOL-07_MVP_MESSAGE_FLOW.md
2. API-11_JSON_SCHEMAS.md
3. ARCH-09_REPOSITORY_STRUCTURE.md
4. TASKS-10_IMPLEMENTATION_BACKLOG.md

Выполни только задачу J-006.

Нужно:
- реализовать createChatMessage
- строго следовать ChatMessage schema
- принимать только необходимые входные поля
- генерировать message_id и created_at_ms
- покрыть unit tests

Нельзя:
- шифровать сообщение в этой задаче
- писать в базу в этой задаче
- добавлять transport metadata в plaintext schema

В конце:
- перечисли файлы
- опиши inputs и output
- перечисли тесты
```

---

## 14. Prompt для K-001 — mailbox poll cycle

```text
Работай строго в рамках проекта Echolet MVP.

Документы:
1. PROTOCOL-07_MVP_MESSAGE_FLOW.md
2. THREAT-08_MODEL.md
3. API-11_JSON_SCHEMAS.md
4. ARCH-09_REPOSITORY_STRUCTURE.md
5. TASKS-10_IMPLEMENTATION_BACKLOG.md

Выполни только задачу K-001.

Нужно:
- реализовать runMailboxPollCycle
- строго следовать challenge -> sign -> poll -> process -> ack flow
- использовать deriveMailboxId
- не пропускать signature step

Нельзя:
- читать mailbox без challenge
- смешивать UI state с orchestration
- игнорировать ack stage

В конце:
- перечисли файлы
- опиши последовательность шагов
- укажи как протестировать happy path и failure path
```

---

## 15. Prompt для review-pass

```text
Проверь реализацию задачи <ID> в проекте Echolet MVP.

Документы-источники:
1. PROTOCOL-07_MVP_MESSAGE_FLOW.md
2. THREAT-08_MODEL.md
3. API-11_JSON_SCHEMAS.md
4. ARCH-09_REPOSITORY_STRUCTURE.md
5. TASKS-10_IMPLEMENTATION_BACKLOG.md
6. STACK-14_TECH_DECISIONS.md
7. PLAYBOOK-12_WEAK_MODEL_EXECUTION.md

Проверь только:
- соответствует ли код задаче <ID>
- не нарушены ли JSON contracts
- не нарушены ли security assumptions
- есть ли минимальные тесты
- нет ли лишнего рефакторинга

Верни результат строго в формате:
- OK / NOT OK
- проблемы
- минимальные исправления
- какие файлы затронуты
```

---

## 16. Prompt для fix-pass

```text
Исправь только замечания по задаче <ID> в проекте Echolet MVP.

Документы-источники:
1. PROTOCOL-07_MVP_MESSAGE_FLOW.md
2. THREAT-08_MODEL.md
3. API-11_JSON_SCHEMAS.md
4. ARCH-09_REPOSITORY_STRUCTURE.md
5. TASKS-10_IMPLEMENTATION_BACKLOG.md
6. STACK-14_TECH_DECISIONS.md

Нужно:
- внести только минимальные исправления
- не рефакторить соседние модули
- не менять публичные контракты

В конце:
- перечисли исправленные пункты
- перечисли измененные файлы
- кратко опиши как исправления проверены
```

---

## 17. Как использовать этот документ
Рекомендуемый режим:

1. выбрать следующую задачу из `TASKS-10_IMPLEMENTATION_BACKLOG.md`;
2. взять ближайший готовый prompt из этого файла;
3. при необходимости слегка адаптировать только блок `Нужно`;
4. запустить отдельный review-pass;
5. при замечаниях — отдельный fix-pass.

---

## 18. Итог
Этот документ превращает спецификации Echolet в операционный набор команд для слабой модели.

Смысл простой:

* не просить модель думать широко;
* просить ее делать точно;
* каждую задачу изолировать;
* каждую реализацию перепроверять отдельно.
