---
name: code-style-review
description: "Detailed code style and architecture review using code-style-patterns.mdc. Reviews current branch changes. Checks naming, organization, patterns, TypeScript usage. Use when: style validation needed, architecture review."
triggers:
  - "Style review"
  - "Check code style"
  - "Architecture review"
metadata:
  author: "MrCipherSmith"
  version: "1.0.0"
  category: "review"
  compatible_harnesses: "cursor,codex,zed,opencode"
license: "MIT"
---


# Code Style Review

Проводи ревью только изменений текущей ветки от момента отбранчевания от родительской ветки, строго по правилам из `.metaproject/rules/core/code-style-patterns.mdc`.

## Scope

- Если пользователь **не передал commit hash/range**, ревьюируй полный срез от merge-base до текущего рабочего дерева:
  - закоммиченные изменения (`BASE_SHA..HEAD`)
  - локальные незакоммиченные (`staged/unstaged/untracked`)
- Если пользователь **явно передал commit hash/range**, ревьюируй только запрошенный диапазон; незакоммиченные изменения не добавляй, если это отдельно не попросили.
- Не обсуждай легаси вне изменённого скоупа.
- Фидбек должен быть подробным: проблема -> почему это проблема -> где (файл/участок) -> что сделать -> пример исправления.
- Исправления предлагай в виде unified diff-патчей, не вноси изменения в код напрямую.

## Scope Detection

See shared script: `skills/shared/git-merge-base.md`

Run the script from that file to determine MERGE_BASE and SCOPE before proceeding with the review.

Собери входные данные:

### A) Режим по умолчанию (без hash/range)

```bash
git status

# Закоммиченная часть ветки
git log --oneline "${BASE_SHA}..HEAD"
git diff --name-status --find-renames "${BASE_SHA}..HEAD"
git diff --find-renames "${BASE_SHA}..HEAD"

# Полный текущий срез от merge-base до рабочего дерева
# включает commit'ы + staged + unstaged
# (untracked смотри через git status / git ls-files)
git diff --name-status --find-renames "${BASE_SHA}"
git diff --find-renames "${BASE_SHA}"
git ls-files --others --exclude-standard
```

### B) Режим с явным hash/range

```bash
git show --stat --name-status --patch <COMMIT_SHA>
git log --oneline <FROM_SHA>..<TO_SHA>
git diff --name-status --find-renames <FROM_SHA>..<TO_SHA>
git diff --find-renames <FROM_SHA>..<TO_SHA>
```

Используй только эти изменения как вход для ревью.

## Review checklist (по `.metaproject/rules/core/code-style-patterns.mdc`)

### TypeScript Strictness
- Запрещён `any` (предлагай `unknown` + type guards / корректные типы).
- Props через `interface`, префикс `I*`.
- Предпочитай `?.` и `??`, избегай `!` (non-null assertion).

### MobX
- В сторах обязателен `makeObservable(this)` в конструкторе.
- Для асинхронных мутаций после `await` - `runInAction`.
- Методы экшенов: `@action.bound`.
- Derived state: `@computed`.
- Для коллекций/списков - `@observable.shallow` (когда применимо).
- Inter-store callbacks (`onChangeX`, `onFireX`, `handleX`, `syncX`) обязаны быть `private`. Публичный `@action.bound` только для методов вызываемых из React-компонентов.

### React Components
- Компоненты, читающие observable, обязаны быть `observer(...)`.
- MVVM: логика и side effects в Store/Service, а не во View.
- Запрещай бизнес-логику в `useEffect` (предлагай store actions/reactions).
- Следи за порядком структуры файла: imports -> interfaces -> component -> helpers.

### Architecture & Layers
- API/IO не во View: в Service/Store.
- Взаимодействие со Store - через actions (без прямых мутаций вне экшенов).

### Anti-patterns severity
- Critical: API во View, missing `observer`, direct store mutation, грубые нарушения MobX async.
- Warnings: `console.log` вместо `AppLogger`, inline object props без memo/const, тяжёлая логика в render, спорные типы, public inter-store callbacks/handlers.

## Output format (обязательный отчёт)

Сформируй отчёт в Markdown строго по шаблону:

```markdown
## Summary
- [1-3 bullets] Что изменилось и общий уровень соответствия стилю

## Scope
- Branch: `<BRANCH>`
- Parent ref: `<PARENT>`
- Merge-base: `<BASE_SHA>`
- Scope mode: `<default-with-uncommitted | explicit-hash-range>`

## Critical issues (must fix)
### [Короткий заголовок проблемы]
- **Rule**: [ссылка/название секции из core/code-style-patterns.mdc]
- **Why**: [объяснение]
- **Where**: `path/to/file.tsx` (строки из diff)
- **Fix**: [что сделать]
- **Proposed patch**:
```diff
[unified diff]
```

## Warnings
... (тот же формат, без "must fix")

## Suggestions
... (тот же формат, improvements без обязательности)

## File-by-file notes
- `path/to/file`: [коротко, только по изменённым участкам]
```

## Rules of engagement

- Привязывай замечания к конкретным изменённым строкам (по diff).
- Если есть несколько вариантов, предлагай один default и короткий альтернативный.
- Не предлагай новые библиотеки без явного запроса.

---

## Scope Boundaries

This skill covers **code style and architecture patterns** — naming, organization, TypeScript usage, pattern compliance per `code-style-patterns.mdc`.

| Concern | This skill | Use instead |
|---------|-----------|-------------|
| Naming conventions, file organization, import order | ✅ YES | — |
| TypeScript patterns, component/hook structure | ✅ YES | — |
| Architecture pattern compliance | ✅ YES | — |
| Logic correctness, type safety deep dives | ❌ NO | `code-ai-review` or `code-learned-review` |
| MobX store internals | ❌ NO | `code-mobx-store-review` |

---

## Job Context Awareness

When dispatched by `job-orchestrator` as part of a job pipeline, the prompt MAY include:

```
JOB_NAME:     <job-name>
CONTEXT_PATH: .metaproject/jobs/<job-name>/ai/context.md
```

If provided and the file exists, read the context document before starting the review. Use it to:
- Understand which libraries and patterns were intentionally chosen for the implementation
- Validate code style against documented project conventions from the context
- Provide more accurate findings by understanding the project's architectural decisions

If the file does not exist or is not provided, proceed normally — context is optional and non-blocking.
