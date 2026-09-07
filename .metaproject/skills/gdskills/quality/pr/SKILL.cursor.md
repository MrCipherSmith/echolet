---
name: pr
description: "Use when opening a pull request for the current branch."
triggers:
  - "/pr"
  - "Create PR"
  - "Open pull request"
  - "Create pull request"
  - "Make PR"
metadata:
  author: "MrCipherSmith"
  version: "1.0.0"
  category: "workflow"
  compatible_harnesses: "cursor,codex,zed,opencode,claude"
license: "MIT"
---

# Smart PR Creation

Create a well-documented GitHub Pull Request from current branch.

## Workflow

### Phase 1: Gather Context
Run in parallel:
1. `git status` — check for uncommitted changes
2. `git branch --show-current` — current branch name
3. `git log --oneline main..HEAD` (or master) — all commits in this branch
4. `git diff main...HEAD --stat` — changed files summary

### Phase 2: Pre-checks
- If there are uncommitted changes → ask if the user wants to commit first
- If branch is not pushed → push it with `-u origin`
- If already on main/master → error: "Create a feature branch first"

### Phase 3: Analyze Changes
Analyze ALL commits and changes (not just the latest):
- `git diff main...HEAD` for the full diff
- Understand the scope: new feature, bugfix, refactor, etc.

### Phase 4: Generate & Create PR
Generate structured PR:
- **Title**: short, under 70 chars, descriptive
- **Body**: Summary + Changes + Test plan

```bash
gh pr create --title "title" --body "$(cat <<'EOF'
## Summary
<bullet points>

## Changes
<key changes by area>

## Test plan
<how to verify>
EOF
)"
```

### Phase 5: Report
Return the PR URL to the user.

## Arguments

- `/pr` — create PR to default branch (main/master)
- `/pr --draft` — create as draft PR
- `/pr --base <branch>` — target specific base branch
- `/pr <title>` — use provided title instead of generating one

## Rules

- NEVER create empty PRs
- Always analyze ALL commits, not just the last one
- If the branch has linked GitHub issues, reference them in the body
- Ask user for confirmation before creating if there are 10+ commits
