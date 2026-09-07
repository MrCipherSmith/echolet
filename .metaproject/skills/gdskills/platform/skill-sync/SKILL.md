---
name: skill-sync
description: Use when sync exported runtime skills to configured local runtimes only when explicitly enabled.
---

# skill-sync

## Purpose

Sync exported runtime skills to configured local runtimes only when explicitly enabled.

## When To Use

- sync skills
- install runtime skills
- global skill sync

## Workflow

1. Read configured runtime targets.
2. Validate runtime skill packages before sync.
3. Sync only selected skills and report changed files.

## Local-First Rules

1. Start from `.metaproject/index.md` and `.metaproject/skills/catalog.md`.
2. Prefer project-local skills under `.metaproject/project-skills` and `.metaproject/skills/gdskills`.
3. Use `gdgraph`, `gdctx`, `gdwiki`, Code Health, and Documentation Memory when they provide narrower context.
4. Treat external/global skills only as explicit fallback when local Metaproject does not provide the capability.
5. Verify conclusions against source files before reporting or editing.
