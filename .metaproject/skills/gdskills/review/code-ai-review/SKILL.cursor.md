---
name: code-ai-review
description: "Performs strict AI code review following code-review-ai-assistant.mdc standards. Reviews current branch changes from merge-base by default, including both committed and local uncommitted changes. Use when: code review requested, checking branch changes, reviewing implementation quality."
triggers:
  - "Code review"
  - "Review my changes"
  - "Check this code"
  - "Review code"
metadata:
  author: "MrCipherSmith"
  version: "1.0.0"
  category: "review"
  compatible_harnesses: "cursor,codex,zed,opencode"
license: "MIT"
---


# Code AI Review (только текущая ветка)

## Workflow

Copy this checklist and track progress:

```
Code Review Progress:
- [ ] Step 1: Determine parent branch and calculate merge-base
- [ ] Step 2: Collect git diff (committed + local changes)
- [ ] Step 3: Identify changed files and categorize
- [ ] Step 4: Review each file following standards
- [ ] Step 5: Document findings with severity and location
- [ ] Step 6: Generate report with patches
```

## Scope Boundaries
This skill focuses on:
- Correctness and logic bugs
- Type safety and TypeScript contract violations
- Security and null-safety issues
- Error handling completeness
- Performance anti-patterns

This skill does NOT duplicate:
- MobX store-specific patterns → covered by code-mobx-store-review
- Naming/formatting/import organization → covered by code-style-review
- Architecture opinions and persona-specific insights → covered by code-learned-review

## Главное правило: скоуп ревью

Ревьюй только изменения, внесённые в текущей ветке с момента её ответвления от родительской.

- Если пользователь **не передал commit hash/range**, включай **весь срез ветки от merge-base до рабочего дерева**:
  - закоммиченные (`BASE_SHA..HEAD`)
  - локальные незакоммиченные (`staged/unstaged/untracked`)
- Если пользователь **явно передал commit hash/range**, ревьюй только запрошенный диапазон; локальные незакоммиченные изменения не добавляй, если это отдельно не попросили.
- Не ревьюй не связанные с веткой части репозитория.

## Scope Detection

See shared script: `skills/shared/git-merge-base.md`

Run the script from that file to determine MERGE_BASE and SCOPE before proceeding with the review.

## Команды, чтобы собрать “срез” для ревью

### A) Режим по умолчанию (пользователь НЕ дал hash/range)

```bash
git status

# Закоммиченная часть ветки
git log --oneline "${BASE_SHA}..HEAD"
git diff --stat "${BASE_SHA}..HEAD"
git diff --name-status "${BASE_SHA}..HEAD"
git diff "${BASE_SHA}..HEAD"

# Полный текущий срез от merge-base до рабочего дерева:
# включает commit'ы + staged + unstaged
# (untracked смотри через git status / git ls-files)
git diff --stat "${BASE_SHA}"
git diff --name-status "${BASE_SHA}"
git diff "${BASE_SHA}"
git ls-files --others --exclude-standard
```

### B) Режим с явным hash/range

```bash
# Примеры:
git show --stat --name-status --patch <COMMIT_SHA>
git log --oneline <FROM_SHA>..<TO_SHA>
git diff --stat <FROM_SHA>..<TO_SHA>
git diff --name-status <FROM_SHA>..<TO_SHA>
git diff <FROM_SHA>..<TO_SHA>
```

## Правила ревью (обязательно)

Ты обязан следовать стандарту ревью из `.metaproject/rules/core/code-review-ai-assistant.mdc`:

- Structure output as: short summary -> structured findings by category -> concrete suggestions / optional patches.
- Prioritize correctness and safety over style.
- Avoid noise; focus on actionable, high-signal findings.
- Do not request large refactors unless explicitly asked.

## Формат вывода (шаблон подробного отчёта)

Пиши ревью по структуре ниже:

```markdown
## Краткое резюме
<1-3 предложения: что сделано и общий вердикт (OK / needs work).>

## Скоуп ревью (только текущая ветка)
- Ветка: `<BRANCH>`
- Parent ref: `<PARENT>`
- Merge-base: `<BASE_SHA>`
- Режим скоупа: `<default-with-uncommitted | explicit-hash-range>`
- Коммиты (merge-base..HEAD): <N>
- Изменённые файлы: <список или количество>

## Находки
### Correctness
<находки>

### Types & Safety
<находки>

### Architecture & State
<находки>

### Readability & Style
<находки>

### Performance
<находки>

### UX/UI
<находки>

### A11y
<находки>

### Tests
<находки>

## Предложенные исправления (patches)
<минимальные, точечные диффы для самых очевидных фиксов>
```

### Формат каждой находки (обязательно)

Для каждой находки укажи:

- **Severity**: `blocker` / `major` / `minor`
- **Location**: file path + relevant lines/hunk (from the diff)
- **Problem**: what is wrong
- **Why it matters**: correctness/safety/perf/maintainability impact
- **Suggested fix**: concrete change
- **Optional patch**: provide a minimal unified diff when straightforward

Пример блока патча:

```diff
diff --git a/path/file.ts b/path/file.ts
index 0000000..1111111 100644
--- a/path/file.ts
+++ b/path/file.ts
@@ -1,3 +1,3 @@
-const x = 1;
+const x = 2;
```

---

## Scope Boundaries

This skill covers **general AI code quality review** following `code-review-ai-assistant.mdc`.

| Concern | This skill | Use instead |
|---------|-----------|-------------|
| Types, safety, architecture, readability, performance, tests | ✅ YES | — |
| MobX store internals (actions, computed, reactions, async) | ⚠️ surface-level only | `code-mobx-store-review` for deep store analysis |
| Review against this project's own learned conventions | ❌ NO | `code-learned-review` |
| Pure style/naming/pattern audit | ❌ NO | `code-style-review` |

---

## Job Context Awareness

When dispatched by `job-orchestrator` as part of a job pipeline, the prompt MAY include:

```
JOB_NAME:     <job-name>
CONTEXT_PATH: .metaproject/jobs/<job-name>/ai/context.md
```

If provided and the file exists, read the context document before starting the review. Use it to:
- Understand which libraries and patterns were intentionally chosen for the implementation
- Avoid flagging correct library usage as issues (e.g., if context documents the API pattern)
- Provide more accurate findings by understanding the project's architectural decisions
- Reference context when justifying suggestions

If the file does not exist or is not provided, proceed normally — context is optional and non-blocking.
