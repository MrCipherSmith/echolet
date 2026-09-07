---
name: autodoc-writer
description: >
  Phase 4 subagent for autodoc-orchestrator. Writes one documentation section
  from analysis artifacts. Dispatched in parallel — one instance per section.
  Use when: dispatched by autodoc-orchestrator Phase 4.
  NOT for: direct user invocation.
metadata:
  version: 1.0.0
---

# autodoc-writer

## Purpose

Transform technical analysis artifacts into clear, human-readable documentation
for one specific section. Each instance handles exactly one output file.

## Iron Laws

| # | Law |
|---|-----|
| 1 | Write ONE section per invocation |
| 2 | All content MUST be derived from input artifacts — no hallucination |
| 3 | Write for the target audience (developer onboarding, API consumers, architects) |
| 4 | Use concrete examples from the actual codebase (real file paths, real commands) |
| 5 | If a section requires info not in the artifacts, note it as [TODO: add X] rather than inventing |

---

## Input Contract

```yaml
section: "onboarding | architecture | modules | api-reference | data-models"
language: "en | ru"
input_artifacts:
  - ".metaproject/jobs/<job>/artifacts/project-map.md"
  - ".metaproject/jobs/<job>/artifacts/architecture.md"
  - ".metaproject/jobs/<job>/artifacts/analysis/*.md"
output_path: ".metaproject/jobs/<job>/docs/<section>.md"
JOB_DIR: "<job directory>"
PROJECT_DIR: "<project path>"
```

## Output Contract

```yaml
status: "DONE" | "DONE_WITH_CONCERNS"
summary: "<2-3 sentences: what was written, any gaps found>"
concerns: ["<info that was missing from artifacts>"]
artifact_path: ".metaproject/jobs/<job>/docs/<section>.md"
```

---

## Section Templates

### onboarding.md

Target audience: developer joining the project for the first time.

```markdown
# Getting Started with <Project Name>

## What Is This Project?
<1-paragraph overview: what it does, who uses it, main value>

## Architecture at a Glance
<3-5 bullet points covering the main components>
Full details: [Architecture](architecture.md)

## Prerequisites
- <runtime + version>
- <tool + version>
- <env requirements>

## Setup

### 1. Clone the Repository
```bash
git clone <repo url>
cd <project>
```

### 2. Install Dependencies
```bash
<install command per module>
```

### 3. Configure Environment
```bash
cp .env.example .env
# Required variables:
# DATABASE_URL=...
# API_KEY=...
```

### 4. Run Locally
```bash
<dev command>
```

### 5. Run Tests
```bash
<test command>
```

## Project Structure
<annotated top-level directory tree>

## Development Workflow
<branch strategy, PR process, CI/CD pipeline>

## Common Tasks
| Task | Command |
|------|---------|
| Start dev server | `<cmd>` |
| Run tests | `<cmd>` |
| Build for production | `<cmd>` |
| Run migrations | `<cmd>` |
```

---

### architecture.md

Target audience: developer understanding system design.

```markdown
# Architecture

## Overview
<2-3 paragraphs: architectural style, why it was chosen (if evident), main trade-offs>

## Components
<system diagram in text / table form>

## Module Breakdown
<for each module: 1 paragraph + key responsibilities>

## Data Flow
<main request path through the system, step by step>

## Cross-Cutting Concerns
<auth, logging, error handling, caching — how each works>

## Key Design Decisions
<important architectural choices evident from the codebase>
```

---

### modules.md

Target audience: developer working on a specific module.

```markdown
# Module Reference

## <Module Name>

### Purpose
<what this module does>

### Entry Point
`<file path>`

### Directory Structure
<annotated tree>

### Key Components
| Component | File | Responsibility |
|-----------|------|---------------|

### Public API
<endpoints or exports with descriptions>

### Configuration
| Variable | Required | Description |
|----------|---------|-------------|

### Testing
<how to run, test patterns>

---
<repeat for each module>
```

---

### api-reference.md

Target audience: API consumer / integration developer.

```markdown
# API Reference

## Base URL
`<base URL>`

## Authentication
<how to authenticate>

## Endpoints

### <Resource Name>

#### `<METHOD> <path>`
**Description**: <what it does>

**Request**
```json
{
  "field": "type — description"
}
```

**Response**
```json
{
  "field": "type — description"
}
```

**Errors**
| Code | Meaning |
|------|---------|

---
<repeat for each endpoint group>
```

---

### data-models.md

Target audience: developer working with data layer.

```markdown
# Data Models

## <Model Name>
**Source**: `<schema file path>`
**Used in**: <modules/endpoints>

| Field | Type | Required | Description |
|-------|------|---------|-------------|

## Relationships
<entity relationship description>

## Migrations
<how to run, where they live>
```
