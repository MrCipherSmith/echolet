---
name: autodoc-orchestrator
description: >
  Autonomous reverse-engineering documentation pipeline — scans an existing codebase
  and produces comprehensive developer documentation without user involvement after initial setup.
  Use when the user provides a repo path, asks to document existing code, or wants
  onboarding docs, an API reference, or an architecture overview generated automatically.
  NOT for: writing new PRDs or planning new features (use gproject-orchestrator).
triggers:
  - "autodoc"
  - "автодок"
  - "document this codebase"
  - "generate docs for my project"
  - "reverse engineer documentation"
  - "задокументируй кодовую базу"
  - "сгенерируй документацию проекта"
metadata:
  version: 1.0.0
---

<!-- SUBAGENT-STOP: If you are a subagent dispatched by another orchestrator, HALT.
     Return STATUS: BLOCKED — autodoc-orchestrator must run as top-level agent only. -->

# autodoc-orchestrator

## Purpose

Thin orchestrator that drives a 5-phase autonomous documentation pipeline.
Takes an existing codebase as input, dispatches specialized subagents to scan,
analyze, and write documentation, and produces a complete documentation package
with no human gates.

---

## Execution metrics (opt-in)

When a USER runs this orchestrator directly (not as a dispatched subagent), at
the start ask "Collect execution statistics for this run? (yes/no)" per
`.metaproject/rules/core/execution-metrics.md`. If yes, append the
`## Execution Metrics` section at the end and save it under the run's artifact
dir (`.metaproject/data/gdwiki/metrics/` or the docs output dir). Never ask or
emit it when dispatched as a subagent.

## Iron Laws

| # | Law |
|---|-----|
| 1 | Orchestrator NEVER reads or summarizes code itself — only subagents do |
| 2 | Orchestrator NEVER writes documentation content — only subagents do |
| 3 | Every phase MUST produce artifact files before proceeding |
| 4 | Phase 2 analysts run in PARALLEL — one per detected module/domain |
| 5 | Phase 4 writers run in PARALLEL — one per documentation section |
| 6 | Subagents receive ONLY artifacts listed in their dispatch contract |
| 7 | If a subagent returns NEEDS_CONTEXT, resolve autonomously before re-dispatching |

---

## Pipeline Overview

```
Phase 0  Interview (if needed)      → collect project path + focus areas
Phase 1  autodoc-scanner            → artifacts/project-map.md
Phase 2  autodoc-analyst × N        → artifacts/analysis/<module>.md  [parallel]
Phase 3  autodoc-architect          → artifacts/architecture.md
Phase 4  autodoc-writer × N         → docs/<section>.md               [parallel]
Phase 5  autodoc-assembler          → docs/README.md + docs/index.md
```

---

## Phase 0: Initialization

### Job Directory Setup

1. Create `jobs/autodoc-<slugified-project-name>/`
2. Create subdirectories: `artifacts/`, `artifacts/analysis/`, `docs/`, `ai/`
3. Initialize `state.json`

### Input Assessment

Evaluate what the user provided:

```
SUFFICIENT — proceed directly to Phase 1 if ALL of:
  ✓ Project directory path (absolute) is provided
  ✓ Path exists and contains code files

NEEDS_INPUT — ask questions if ANY of:
  ✗ No project path given
  ✗ Multiple repos mentioned without clear scope
  ✗ User specified unusual focus (e.g., "only the auth module")
```

### Interview (only when NEEDS_INPUT)

Ask ONLY what is missing. Maximum 4 questions, always with options:

```
I need a few details to get started:

1. Project path?
   ○ Type the absolute path to the project root

2. Which parts to document? (default: everything)
   A) Full project — backend + frontend + shared
   B) Backend only
   C) Frontend only
   D) Specific path — [type it]

3. Output language?
   A) English (default)
   B) Russian
   C) Both

4. Existing docs to incorporate? (default: none)
   ○ Path to existing docs/README, or skip
```

Save answers to `state.json.config`.

---

## Dispatch Protocol

Every subagent dispatch follows this contract:

```
Agent({
  description: "<phase>: <task>",
  prompt: |
    ## Your Role
    You are <agent_role>. Load skill: skills/<skill-name>/SKILL.md

    ## Task
    <specific task>

    ## Input Artifacts
    <list of file paths to read>

    ## Job Context
    JOB_DIR: <absolute path to job directory>
    PROJECT_DIR: <absolute path to project>
    CONFIG: <from state.json.config>

    ## Output Contract
    1. Write artifact to: <output path>
    2. Return ONLY:
       STATUS: DONE | DONE_WITH_CONCERNS | NEEDS_CONTEXT
       summary: (3-5 sentences)
       concerns: (if DONE_WITH_CONCERNS)
       questions: (if NEEDS_CONTEXT — with A/B/C/D options)
       next_phase_hints: (key findings for orchestrator routing)
})
```

### Status Handling

```
STATUS: DONE
  → Save summary to state.json.phase_summaries
  → Proceed to next phase

STATUS: DONE_WITH_CONCERNS
  → Log concerns in state.json
  → Proceed (documentation pipeline continues; concerns noted in final report)

STATUS: NEEDS_CONTEXT
  → IF resolvable autonomously (file exists, can be read):
      → Dispatch context-collector or read file directly
      → Re-dispatch subagent with answer
  → IF requires user input:
      → Ask user with A/B/C/D options
      → Re-dispatch with answer
  → Max 2 resolution rounds per phase
```

---

## Phase 1: Project Scanning

**Subagent**: `autodoc-scanner`
**Input**: `PROJECT_DIR`, `CONFIG`
**Output**: `artifacts/project-map.md`

After completion, parse `next_phase_hints.modules[]` from the scanner's response.
This list drives how many parallel analysts to launch in Phase 2.

---

## Phase 2: Deep Analysis (Parallel)

**Subagent**: `autodoc-analyst` — one instance per module from project-map
**Input**: `artifacts/project-map.md` + module path
**Output**: `artifacts/analysis/<module-slug>.md`

Launch ALL analysts simultaneously:
```
Agent × N in parallel, one per module:
  module: frontend  → artifacts/analysis/frontend.md
  module: backend   → artifacts/analysis/backend.md
  module: shared    → artifacts/analysis/shared.md
  ...
```

Wait for ALL to complete before Phase 3.

---

## Phase 3: Architecture Synthesis

**Subagent**: `autodoc-architect`
**Input**: `artifacts/project-map.md` + ALL `artifacts/analysis/*.md`
**Output**: `artifacts/architecture.md`

---

## Phase 4: Documentation Writing (Parallel)

**Subagent**: `autodoc-writer` — one instance per documentation section

Determine sections from Phase 3 output and CONFIG. Standard sections:

| Section | Output file | Always? |
|---------|------------|---------|
| Onboarding | `docs/onboarding.md` | Yes |
| Architecture overview | `docs/architecture.md` | Yes |
| Module reference | `docs/modules.md` | Yes |
| API reference | `docs/api-reference.md` | Only if APIs detected |
| Data models | `docs/data-models.md` | Only if schemas detected |

Launch ALL writers simultaneously. Wait for ALL to complete.

---

## Phase 5: Assembly

**Subagent**: `autodoc-assembler`
**Input**: ALL `docs/*.md` + `artifacts/architecture.md` + `artifacts/project-map.md`
**Output**: `docs/README.md` + `docs/index.md`

The assembler creates the main entry-point document with links to all sections,
a brief project overview, and a quick-start section.

---

## State Resumption

Check for interrupted jobs on start:

```
IF jobs/autodoc-*/state.json exists AND status == "in_progress":
  → Show: "Found interrupted autodoc job: <name> at Phase <N>"
  → Ask: A) Resume  B) Start fresh  C) Show state
```

---

## Output Structure

```
jobs/autodoc-<project>/
├── state.json                    # Pipeline state
├── artifacts/
│   ├── project-map.md            # Phase 1
│   └── analysis/                 # Phase 2
│       ├── frontend.md
│       ├── backend.md
│       └── <module>.md
├── docs/                         # Final documentation
│   ├── README.md                 # Main entry point (Phase 5)
│   ├── index.md                  # Navigation index (Phase 5)
│   ├── onboarding.md             # Phase 4
│   ├── architecture.md           # Phase 4
│   ├── modules.md                # Phase 4
│   ├── api-reference.md          # Phase 4 (if applicable)
│   └── data-models.md            # Phase 4 (if applicable)
└── ai/
    └── context.md                # Internal context snapshot
```

---

## Final Report

After Phase 5, present to user:

```
autodoc complete for: <project name>

Documentation generated:
  ✓ docs/README.md         — main entry point
  ✓ docs/onboarding.md     — setup + dev workflow
  ✓ docs/architecture.md   — system architecture
  ✓ docs/modules.md        — module reference
  ✓ docs/api-reference.md  — API contracts
  ✓ docs/data-models.md    — data schemas

Modules analyzed: <N> (<list>)
Concerns: <none | list>

Full docs: jobs/autodoc-<name>/docs/
```

---

## state.json Template

```json
{
  "job_name": "autodoc-<slug>",
  "created_at": "<ISO>",
  "current_phase": 0,
  "status": "in_progress",
  "config": {
    "project_dir": null,
    "scope": "full",
    "language": "en",
    "existing_docs": null
  },
  "detected_modules": [],
  "detected_sections": [],
  "phase_summaries": {},
  "concerns": [],
  "history": []
}
```
