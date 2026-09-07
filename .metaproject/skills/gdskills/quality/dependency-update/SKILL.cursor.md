---
name: dependency-update
description: "Use when checking for outdated packages or upgrading dependencies with compatibility verification."
triggers:
  - "/dependency-update"
  - "Update dependencies"
  - "Upgrade packages"
  - "Check outdated"
  - "Update npm packages"
metadata:
  author: "MrCipherSmith"
  version: "1.0.0"
  category: "maintenance"
  compatible_harnesses: "cursor,codex,zed,opencode,claude"
license: "MIT"
---

# Dependency Update

Safely update project dependencies with compatibility checks.

## Arguments

- `/dependency-update` — check and propose updates
- `/dependency-update --patch` — only patch updates (safe)
- `/dependency-update --minor` — patch + minor
- `/dependency-update --all` — all including major
- `/dependency-update --dry-run` — show what would update
- `/dependency-update <package>` — update specific package

## Workflow

### Step 1: Check Outdated
```bash
npm outdated --json
```

### Step 2: Classify by Risk

| Type | Risk | Action |
|------|------|--------|
| Patch (1.0.0 → 1.0.1) | Low | Batch update |
| Minor (1.0.0 → 1.1.0) | Medium | Update & test |
| Major (1.0.0 → 2.0.0) | High | One-by-one with tests |

### Step 3: Present Update Plan
Show grouped list with risk levels. Get user confirmation.

### Step 4: Execute

**Patch (batch):** `npm update`

**Minor (batch):** `npm install pkg1@latest pkg2@latest && npm test`

**Major (one at a time):**
1. Check changelog/migration guide
2. `npm install <package>@latest`
3. Run lint + type-check + tests
4. If fails (max 2 fix tries) → rollback
5. If passes → commit: `chore(deps): update <package> to v<version>`

### Step 5: Post-update Verification
```bash
npm run lint && npx tsc --noEmit && npm test && npm run build
```

### Step 6: Report
```
✅ Updated: 15 packages (10 patch, 4 minor, 1 major)
⚠️ Skipped: 2 packages (tests fail)
📋 Commits: 3
```

## Rules

- NEVER update all major versions at once — one by one
- ALWAYS run tests after each major update
- Rollback if tests fail
- Commit each group separately
- Respect pinned versions
- Check peer dependency warnings
