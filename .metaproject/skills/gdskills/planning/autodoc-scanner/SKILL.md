---
name: autodoc-scanner
description: >
  Phase 1 subagent for autodoc-orchestrator. Scans project structure,
  detects stack, identifies module boundaries, entry points, and dependencies.
  Use when: dispatched by autodoc-orchestrator Phase 1.
  NOT for: direct user invocation.
metadata:
  version: 1.0.0
---

# autodoc-scanner

## Purpose

Produce a complete structural map of the project that downstream analysts
and writers can rely on without re-scanning the codebase.

## Iron Laws

| # | Law |
|---|-----|
| 1 | Scan file tree — do NOT read full file contents (use directory listings and targeted reads of package.json, tsconfig, Makefile, etc.) |
| 2 | Detect module boundaries from directory structure and build config, not from code semantics |
| 3 | Always list entry points (main files, index files, app bootstraps) |
| 4 | Return module list in `next_phase_hints.modules[]` — orchestrator uses this to spawn analysts |

---

## Input Contract

```yaml
PROJECT_DIR: "<absolute path>"
CONFIG:
  scope: "full | backend | frontend | <custom path>"
  language: "en | ru | both"
  existing_docs: "<path or null>"
```

## Output Contract

```yaml
status: "DONE" | "NEEDS_CONTEXT"
summary: "<3-5 sentences: project type, module count, stack summary>"
next_phase_hints:
  modules:
    - slug: "backend"
      path: "<absolute path>"
      type: "backend | frontend | shared | mobile | infra | other"
      language: "TypeScript | Python | Go | ..."
      framework: "NestJS | Express | React | ..."
      entry_points: ["<file>"]
    - slug: "frontend"
      path: "<absolute path>"
      ...
  has_api: true | false
  has_schemas: true | false
  has_tests: true | false
artifact_path: ".metaproject/jobs/<job>/artifacts/project-map.md"
```

---

## Workflow

### Step 1: Project Tree Scan

Read top-level directory structure. Identify:
- Build/package files: `package.json`, `pyproject.toml`, `go.mod`, `Cargo.toml`, `pom.xml`, `Makefile`
- Workspace configs: `nx.json`, `turbo.json`, `lerna.json`, `pnpm-workspace.yaml`
- Entry points: `main.*`, `index.*`, `app.*`, `server.*`, `cmd/`
- Config files: `tsconfig.json`, `vite.config.*`, `webpack.config.*`, `docker-compose.yml`
- Existing documentation: `README.md`, `docs/`, `CONTRIBUTING.md`

### Step 2: Module Boundary Detection

From the directory structure and workspace config, identify module boundaries:

```
Monorepo (nx/turbo/lerna) → each package/app is a module
Single repo → detect by: apps/, packages/, src/modules/, src/features/
Backend indicators: api/, server/, backend/, services/
Frontend indicators: web/, client/, frontend/, ui/
Shared/lib indicators: lib/, shared/, common/, packages/
```

For each detected module, read its `package.json` or equivalent to extract:
- Name, description
- Dependencies (framework detection)
- Scripts (build, test, dev commands)

### Step 3: Stack Detection

For each module, determine:

| Signal | Detected |
|--------|---------|
| `"next"` in deps | Next.js (React, SSR) |
| `"@nestjs/core"` | NestJS (Node backend) |
| `"fastapi"` in pyproject | FastAPI (Python backend) |
| `"react"` in deps (no next) | React SPA |
| `"vue"` | Vue.js |
| `go.mod` exists | Go |
| `Cargo.toml` | Rust |
| `prisma/` dir | Prisma ORM |
| `migrations/` dir | SQL database |
| `swagger` / `openapi` files | REST API with spec |
| `*.proto` files | gRPC |
| `graphql/` or `*.graphql` | GraphQL |

### Step 4: Entry Points

For each module, find entry point files:
- Node: `main.ts`, `index.ts`, `app.ts`, `server.ts`
- Python: `main.py`, `app.py`, `__main__.py`
- Go: `cmd/*/main.go`, `main.go`
- Frontend: `main.tsx`, `_app.tsx`, `App.tsx`, `index.html`

### Step 5: API + Schema Detection

```
has_api = true IF:
  - `swagger.json` / `openapi.yaml` found
  - `*.proto` files found
  - `@nestjs/swagger` in deps
  - FastAPI app detected
  - Express router files found at `routes/` or `*.routes.ts`

has_schemas = true IF:
  - `prisma/schema.prisma` found
  - `migrations/` directory found
  - `models/` directory with *.py or *.ts files
  - `*.graphql` schema files found
```

### Step 6: Write project-map.md

```markdown
# Project Map: <Project Name>

## Overview
- **Type**: monorepo | single-repo
- **Modules**: <N>
- **Languages**: <list>
- **Has API**: yes | no
- **Has DB schemas**: yes | no

## Modules

### <Module Name> (`<path>`)
- **Type**: backend | frontend | shared
- **Language**: <lang>
- **Framework**: <framework + version>
- **Entry point**: `<file>`
- **Key dependencies**: <list>
- **Build command**: `<cmd>`
- **Dev command**: `<cmd>`

## Project Structure (condensed)
<top-2-level directory tree>

## Existing Documentation
<list of found docs, or "none">

## Detected Integrations
<databases, queues, external APIs, auth providers>
```
