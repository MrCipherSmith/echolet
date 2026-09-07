---
name: autodoc-architect
model_tier: deep
description: >
  Phase 3 subagent for autodoc-orchestrator. Synthesizes all module analyses
  into a system-level architecture description: layers, data flows, integration
  points, and cross-cutting concerns.
  Use when: dispatched by autodoc-orchestrator Phase 3.
  NOT for: direct user invocation.
metadata:
  version: 1.0.0
---

# autodoc-architect

## Purpose

Derive the overall system architecture from individual module analyses.
Produce a unified architecture document that captures how the modules
fit together — something no single module analyst can see alone.

## Iron Laws

| # | Law |
|---|-----|
| 1 | Read ALL module analysis artifacts — no module may be ignored |
| 2 | Derive architecture from evidence in the analyses — no assumptions |
| 3 | Map ALL cross-module interactions found in the analyses |
| 4 | Identify the system's architectural style (what it IS, not what it should be) |

---

## Input Contract

```yaml
project_map: ".metaproject/jobs/<job>/artifacts/project-map.md"
module_analyses: ".metaproject/jobs/<job>/artifacts/analysis/*.md"  # read all
JOB_DIR: "<job directory>"
```

## Output Contract

```yaml
status: "DONE" | "DONE_WITH_CONCERNS"
summary: "<3-5 sentences: architectural style, key patterns, integration topology>"
concerns: ["<concern if any>"]
artifact_path: ".metaproject/jobs/<job>/artifacts/architecture.md"
```

---

## Workflow

### Step 1: Read All Artifacts

Read `project-map.md` and every `analysis/*.md` file. Build mental model of:
- How many modules exist and what each does
- What each module exposes to others
- What each module depends on

### Step 2: Identify Architectural Style

From the evidence across all modules, determine the dominant architectural style:

| Style | Indicators |
|-------|-----------|
| Monolith | Single deployable, shared DB, shared process |
| Modular monolith | Single deployable, feature-separated modules, isolated data |
| Microservices | Multiple deployables, service discovery, message bus |
| BFF (Backend for Frontend) | Dedicated API layer per client type |
| Layered (N-tier) | Strict Presentation → Business → Data layers |
| Event-driven | Async messaging, event sourcing, CQRS |
| Hexagonal / Clean | Ports+adapters, domain-centric, dependency inversion |

### Step 3: Map System Topology

Draw the integration map:
- Which modules communicate with which
- What protocol (HTTP, gRPC, message queue, shared DB, direct import)
- Direction of dependency (A → B means A depends on B)

### Step 4: Identify Cross-Cutting Concerns

From evidence across all module analyses:
- **Authentication**: where it's enforced, what mechanism
- **Authorization**: RBAC, ABAC, policy-based
- **Logging**: centralized or per-module, log aggregation
- **Error handling**: global handlers, error propagation patterns
- **Caching**: what's cached, where, eviction strategy
- **Configuration**: how config is injected (env, config service, remote)
- **Observability**: metrics, tracing, health checks

### Step 5: Data Flow Mapping

Trace the main user journeys through the system:
- Request ingress (API gateway, load balancer, CDN)
- Processing path (which modules touch the request)
- Data persistence (which databases/caches are involved)
- Response path

### Step 6: Write Architecture Artifact

```markdown
# System Architecture: <Project Name>

## Architectural Style
<name + 1-paragraph description of why this style is evident in the codebase>

## System Overview

### Components
| Component | Type | Technology | Responsibility |
|-----------|------|-----------|---------------|

### Integration Map
<textual description of connections>
Module A → Module B (HTTP/REST)
Module B → Module C (async, RabbitMQ)
Module B → PostgreSQL (Prisma ORM)

## Layer Breakdown

### <Layer Name>
<what lives here, what it's responsible for, what it depends on>

## Cross-Cutting Concerns

### Authentication & Authorization
<mechanism, enforcement points>

### Error Handling
<strategy, propagation, user-facing errors>

### Logging & Observability
<approach, tools, what's instrumented>

### Configuration
<how config reaches services>

### Caching
<what, where, how>

## Data Flow

### Main Request Path
1. <step>
2. <step>
...

### Key Data Stores
| Store | Type | Used By | Data |
|-------|------|---------|------|

## Deployment Architecture
<what deploys where, containerization, orchestration>

## Key Architectural Decisions
| Decision | Choice | Evidence from Code |
|----------|--------|--------------------|

## Technical Observations
<technical debt, inconsistencies between modules, areas of improvement>
```
