---
name: push
description: "Use when pushing the current branch to the remote, especially when upstream tracking or safety checks are needed."
triggers:
  - "/push"
  - "Push changes"
  - "Push to remote"
  - "Push branch"
metadata:
  author: "MrCipherSmith"
  version: "1.0.0"
  category: "workflow"
  compatible_harnesses: "cursor,codex,zed,opencode,claude"
license: "MIT"
---

# Smart Push

Push current branch to remote with safety checks.

## Workflow

### Phase 1: Pre-flight
Run in parallel where possible:
1. `git status` — check for uncommitted changes
2. `git branch -vv` — check current branch and tracking info
3. `git log @{upstream}..HEAD --oneline 2>/dev/null` — commits to push

### Phase 2: Safety Checks
- If there are uncommitted changes → warn and ask if they want to commit first
- If on `main` or `master` → warn and ask for confirmation
- If branch has no upstream → use `git push -u origin <branch>`

### Phase 3: Push
- Normal case: `git push`
- No upstream: `git push -u origin $(git branch --show-current)`
- NEVER use `--force` unless the user explicitly says "force push"

### Phase 4: Confirm
Show result: confirm push success with commit count.

## Arguments

- `/push` — standard push
- `/push --force` — force push (only when explicitly requested, warn if main/master)
- `/push origin <branch>` — push to specific remote/branch

## Rules

- NEVER force push to main/master without double confirmation
- NEVER use `--no-verify`
- If push is rejected (non-fast-forward), suggest `git pull --rebase` first
