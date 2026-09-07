---
name: feature-dev
description: "Use when taking a feature from idea or GitHub issue all the way to a merge-ready PR in one guided workflow."
triggers:
  - "/feature-dev"
  - "Develop feature"
  - "Build feature"
  - "Implement feature"
  - "Feature from scratch"
metadata:
  author: "MrCipherSmith"
  version: "2.0.0"
  category: "workflow"
  compatible_harnesses: "cursor,codex,zed,opencode,claude"
license: "MIT"
---

<SUBAGENT-STOP>
If you were dispatched as a subagent to execute a specific task, skip this skill entirely.
This skill is for interactive feature development sessions only.
Proceed directly with your assigned task.
</SUBAGENT-STOP>

# Feature Development (7-Phase)

End-to-end feature development workflow from idea to merge-ready PR.

## Arguments

- `/feature-dev <description>` — start from a text description
- `/feature-dev #<issue>` — start from a GitHub issue
- `/feature-dev --resume` — resume interrupted feature-dev (checks for existing worktree/branch)

## 8-Phase Architecture

> **Rules always loaded:** `tdd-workflow.mdc`, `implementation-doc-mandate.mdc`, `error-handling.mdc`
> **Sub-agents used:** `tests-creator` (before implement), `code-verifier` (after implement)

### Phase 1: REQUIREMENTS + SPEC

1. Parse input (description or GitHub issue via `gh issue view`)
2. Clarify ambiguities — ask the user up to 3 questions max
3. Produce the **Implementation Spec** (per `implementation-doc-mandate.mdc`):
   - **What**: feature description in 2-3 sentences
   - **Why**: user value / business reason
   - **Scope**: what's in, what's explicitly out
   - **Acceptance criteria**: testable bullet points
   - **Approach**: which files will change, key design decisions
   - **Test strategy**: framework, which scenarios will be covered
4. **Save spec** to `.feature-spec.md` in project root (add to .gitignore if not already)
5. **Get user confirmation before proceeding**

### Phase 2: DESIGN

1. Research the codebase:
   - Find related modules via search tools
   - Read neighboring implementations for patterns
   - **Detect test framework** (package.json, existing test files) — needed for tests-creator
2. Produce implementation plan:
   - Files to create/modify (with brief description of changes)
   - Dependencies or packages needed
   - Data model changes if any
   - Estimated complexity: S / M / L
3. Load relevant rules from `.metaproject/rules/core/` based on what will be built:
   - Always: `tdd-workflow.mdc`, `error-handling.mdc`, `solid-principles.mdc`
   - API/service code: `api-contracts.mdc`, `clean-architecture.mdc`
   - Database: `database-patterns.mdc`
   - Async: `async-patterns.mdc`
   - Security-sensitive: `security-baseline.mdc`
4. **Get user confirmation on the plan**

### Phase 3: PREPARE

1. Create a feature branch: `wt switch -c feat/<name>`
2. Install any new dependencies

### Phase 4: TESTS-CREATOR (TDD — RED phase)

**Run before writing any implementation code.**

1. For each group of acceptance criteria, invoke `tests-creator`:
   - Input: acceptance criteria from Phase 1 spec + target files from Phase 2 plan
   - tests-creator detects framework and generates failing test stubs
   - tests-creator commits the stubs and verifies RED state
2. Confirm test stubs are in place and failing before proceeding to Phase 5

### Phase 5: IMPLEMENT (TDD — GREEN phase)

1. Implement changes file by file, following the plan from Phase 2
2. Goal: make the failing tests from Phase 4 GREEN
3. Follow existing code patterns and loaded rules
4. After each file group, run quick inline check: `npx tsc --noEmit` (type errors only)
5. Commit with conventional message after each logical chunk

### Phase 6: VERIFY (code-verifier gate)

Run `code-verifier` on the full diff:

```
Invoke: skills/orchestration/code-verifier/SKILL.md
Input:  codebase_path=<project_root>, scope=changed, base_branch=<base>
```

- `gate: PASS` → proceed to Phase 7
- `gate: FAIL` → fix findings, re-run code-verifier (max 2 cycles)
- Still FAIL after 2 cycles → report blocker to user, stop

### Phase 7: REVIEW (Self)

1. Launch the `review-orchestrator` skill on own changes
2. Or run a focused self-review:
   - `git diff main...HEAD` — review the full diff
   - Check for: TODOs left behind, console.logs, hardcoded values
   - Verify all acceptance criteria from Phase 1 spec
3. Fix any findings (max 2 review-fix cycles)
4. Re-run `code-verifier` after any fixes

### Phase 8: DELIVER + CHANGE REPORT

1. Push branch
2. Create PR:
   - Link to issue if applicable
   - Include acceptance criteria checklist
   - Add test plan and code-verifier results
3. **Produce Change Report** (per `implementation-doc-mandate.mdc`):
   - Files created/modified with descriptions
   - Test count and results
   - code-verifier gate result
   - Acceptance criteria checklist (checked off)
   - Commits list
4. Print Change Report to user
5. Report PR URL to user

## Status Updates

At each phase transition, report progress:
```
✅ Phase 1: Requirements confirmed
🔄 Phase 2: Designing implementation...
```

## Rules

- ALWAYS get user confirmation after Phase 1 (requirements + spec) and Phase 2 (design)
- Phases 4-7 are autonomous — no user interaction needed
- If stuck for >3 attempts on any step, report the blocker and ask user
- NEVER skip Phase 4 (tests-creator) even if user says "skip tests" — this is TDD, not optional testing
- NEVER skip Phase 6 (code-verifier) — it is the quality gate, not a suggestion
- NEVER commit broken code (code-verifier gate must pass before PR)
- Keep commits atomic: one commit per logical chunk, not one giant commit
- ALWAYS produce the Change Report in Phase 8 — even if the PR was not created

## Red Flags — Stop and re-read this skill if you are thinking:

| Rationalization | Why it's wrong |
|---|---|
| "Requirements are clear enough, I'll skip the design phase" | Skipping design means discovering mismatches after code is written, not before |
| "The user already approved this approach verbally, no need to document" | Undocumented approval is invisible to reviewers and future agents; it doesn't exist |
| "Tests can be written after — implementation first to check if the approach works" | Writing tests after implementation makes you test what you built, not what was required |
| "This phase isn't needed for such a straightforward feature" | Every skipped phase is a deferred bug report |
| "I understand the requirements, confirmation is just a formality" | The confirmation step exists to catch the gap between what you understood and what was meant |

**The three constraints that hold the pipeline together:** no implementation before the spec is written and confirmed; no implementation code before tests-creator has generated failing stubs; no delivery without a passing code-verifier gate and a Change Report.
