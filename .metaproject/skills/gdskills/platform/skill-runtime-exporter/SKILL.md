---
name: skill-runtime-exporter
description: Use when export canonical skills to runtime-compatible Codex or Claude artifacts.
---

# skill-runtime-exporter

## Purpose

Export canonical skills to runtime-compatible Codex or Claude artifacts.

## When To Use

- export skill
- runtime skill
- codex skill

## Workflow

1. Read canonical skill packages.
2. Remove management-only files from runtime exports.
3. Keep runtime `SKILL.md` concise with references, scripts, and assets as needed.

## Local-First Rules

1. Start from `.metaproject/index.md` and `.metaproject/skills/catalog.md`.
2. Prefer project-local skills under `.metaproject/project-skills` and `.metaproject/skills/gdskills`.
3. Use `gdgraph`, `gdctx`, `gdwiki`, Code Health, and Documentation Memory when they provide narrower context.
4. Treat external/global skills only as explicit fallback when local Metaproject does not provide the capability.
5. Verify conclusions against source files before reporting or editing.
