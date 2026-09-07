---
name: claude-md-management
description: "Use when saving session learnings, coding patterns, conventions, or commands discovered during work into CLAUDE.md files."
triggers:
  - "/revise-claude-md"
  - "Update claude md"
  - "Save learnings"
  - "Update project instructions"
  - "Add to CLAUDE.md"
metadata:
  author: "MrCipherSmith"
  version: "1.0.0"
  category: "configuration"
  compatible_harnesses: "cursor,codex,zed,opencode,claude"
license: "MIT"
---

# CLAUDE.md Management

Capture session insights and persist them into the appropriate CLAUDE.md file.

## Arguments

- `/revise-claude-md` — analyze session and propose updates
- `/revise-claude-md "specific thing"` — add a specific entry
- `/revise-claude-md --auto` — apply without asking (for pipelines)

## Workflow

### Step 1: Collect Session Insights
Analyze the current conversation for:
- Coding patterns discovered or established
- Project conventions learned (naming, structure, testing)
- Build/deploy commands that work
- Gotchas and pitfalls encountered
- Architecture decisions made
- Tool configurations set up

### Step 2: Read Current CLAUDE.md Files
1. Project-level: `<project-root>/CLAUDE.md`
2. User-level: `~/.claude/CLAUDE.md`
3. Project-specific user-level: `~/.claude/projects/<project-path>/CLAUDE.md`

### Step 3: Classify Each Insight

| Type | Target |
|------|--------|
| Project conventions, build commands | `<project>/CLAUDE.md` |
| Global preferences, workflow rules | `~/.claude/CLAUDE.md` |
| Project-specific personal notes | `~/.claude/projects/<path>/CLAUDE.md` |

### Step 4: Propose Changes
Present diff preview:
```
📝 Proposed CLAUDE.md updates:

[project] CLAUDE.md:
+ ## Build Commands
+ - `npm run dev` — start dev server on port 3000

[global] ~/.claude/CLAUDE.md:
+ ## Preferences
+ - Always use conventional commits
```

### Step 5: Apply (after user approval)
1. Edit existing sections or append new sections
2. Keep organized with clear `##` headers
3. Avoid duplication — merge with existing
4. Remove outdated entries if contradicted

## Formatting Rules for CLAUDE.md

- Use `##` headers for sections
- Use `-` bullet lists for items
- Keep entries concise (1 line each)
- Group by: Commands, Conventions, Architecture, Gotchas
- No frontmatter in CLAUDE.md files
- CLAUDE.md should be practical — commands you run, not documentation

## Rules

- ALWAYS show proposed changes before applying
- NEVER remove existing entries without explanation
- NEVER add entries that duplicate what's already there
- Keep CLAUDE.md files under 100 lines
- Prefer project-level for project-specific things
