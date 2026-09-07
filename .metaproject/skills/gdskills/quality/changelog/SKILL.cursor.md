---
name: changelog
description: "Use when generating a changelog, release notes, or summarizing what changed between tags, versions, or date ranges."
triggers:
  - "/changelog"
  - "Generate changelog"
  - "What changed since"
  - "Release notes"
  - "What's new"
metadata:
  author: "MrCipherSmith"
  version: "1.0.0"
  category: "workflow"
  compatible_harnesses: "cursor,codex,zed,opencode,claude"
license: "MIT"
---

# Changelog Generator

Generate structured changelog from git history.

## Arguments

- `/changelog` — latest tag to HEAD
- `/changelog v1.0..v2.0` — between tags
- `/changelog --since 2024-01-01` — since date
- `/changelog --output <file>` — write to file
- `/changelog --prepend` — prepend to existing CHANGELOG.md
- `/changelog --format compact` — one-liner per change

## Workflow

### Step 1: Determine Range
1. `git tag --sort=-version:refname` — list recent tags
2. Default: from latest tag to HEAD
3. Between tags or since date if specified

### Step 2: Collect Commits
```bash
git log <range> --pretty=format:"%H|%s|%an|%ad" --date=short
```

### Step 3: Parse & Classify

| Prefix | Section |
|--------|---------|
| feat: | Features |
| fix: | Bug Fixes |
| perf: | Performance |
| refactor: | Refactoring |
| docs: | Documentation |
| test: | Tests |
| chore: | Maintenance |
| BREAKING CHANGE | Breaking Changes |

Extract scope, PR references `(#123)`, issue references `fixes #456`.

### Step 4: Enrich (optional)
If `gh` CLI available: fetch PR titles for merge commits, get authors and labels.

### Step 5: Generate Output

```markdown
# Changelog

## [v1.3.0] - 2024-03-15

### Breaking Changes
- **auth**: Remove deprecated OAuth1 support (#234)

### Features
- **api**: Add batch processing endpoint (#220)

### Bug Fixes
- **db**: Fix connection pool leak under load (#228)
```

## Rules

- Deduplicate identical commit messages
- Skip merge commits (use PR title instead)
- If no conventional commits found, fall back to plain list by date
- Breaking changes always go first
- One line per change
