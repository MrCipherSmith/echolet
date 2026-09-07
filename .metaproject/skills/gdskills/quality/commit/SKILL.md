---
name: commit
description: "Use when committing code changes and a well-structured conventional commit message is needed, with optional amend or selective staging."
triggers:
  - "/commit"
  - "Commit changes"
  - "Commit this"
  - "Save changes"
metadata:
  author: "MrCipherSmith"
  version: "1.0.0"
  category: "workflow"
  compatible_harnesses: "cursor,codex,zed,opencode,claude"
license: "MIT"
---

# Smart Commit

Create well-structured git commits from current changes.

## Workflow

### Phase 1: Analyze Changes
1. Run `git status` and `git diff --staged` and `git diff` to understand all changes
2. Run `git log --oneline -5` to match the repo's commit message style
3. Check for conventional commit patterns in history

### Phase 2: Stage Files
If nothing is staged, intelligently stage relevant files:
- Stage modified and new files that are part of the logical change
- **NEVER** stage `.env`, credentials, secrets, or large binary files
- Prefer `git add <specific files>` over `git add -A`
- Ask the user before staging untracked files that look unrelated to recent work

### Phase 3: Generate Commit Message
Analyze the diff and generate a concise commit message:
- First line: `<type>(<scope>): <description>` (under 72 chars)
- Types: `feat:`, `fix:`, `refactor:`, `test:`, `docs:`, `chore:`, `style:`, `perf:`
- Optional body: explain "why" not "what" (the diff shows "what")
- **NEVER** add "Co-Authored-By" or any co-authorship lines

### Phase 4: Commit
Create the commit using heredoc format:
```bash
git commit -m "$(cat <<'EOF'
type(scope): description
EOF
)"
```

### Phase 5: Verify
Show the result: `git log --oneline -1` and `git status`

## Arguments

- `/commit` — auto-generate message from diff
- `/commit <message>` — use provided message as-is
- `/commit --amend` — amend the last commit (only when explicitly requested)
- `/commit -a` — stage all modified files before committing

## Rules

- NEVER use `--no-verify` or skip hooks
- NEVER add Co-Authored-By lines
- If pre-commit hook fails: fix the issue, re-stage, create a NEW commit (don't amend)
- Follow existing commit message conventions in the repository
