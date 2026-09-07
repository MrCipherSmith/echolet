---
name: patterns-researcher
description: >
  Researches best practices per technology in the chosen stack and defines
  application architecture patterns. Produces constraints that PRD must follow.
  Use when: dispatched by gproject-orchestrator Phase 3.
  NOT for: direct user invocation.
metadata:
  version: 1.0.0
---

# gproject-patterns-researcher

## Purpose

After stack is chosen, research and define the specific patterns, conventions,
and architectural decisions for each technology. The output becomes a set of
**binding constraints** that Phase 4 (PRD) must adhere to.

## Iron Laws

| # | Law |
|---|-----|
| 1 | Every pattern MUST reference a source (official docs, community consensus, or established practice) |
| 2 | Patterns MUST be compatible with chosen project level — no enterprise patterns for MVP |
| 3 | Architecture decisions MUST list alternatives considered |
| 4 | NEVER copy-paste generic "best practices" — every recommendation must be contextualized to THIS project |
| 5 | Output MUST be structured as checkable constraints, not prose advice |
| 6 | Existing project patterns (task_in_project) take precedence unless they're antipatterns |

---

## Input Contract

```yaml
task: "Research per-technology patterns and define application architecture"
input_artifacts:
  - .metaproject/jobs/<job>/artifacts/stack-decision.md
  - .metaproject/jobs/<job>/artifacts/problem-statement.md
decisions_so_far:
  D_level: "..."
  D_frontend: "..."
  D_backend: "..."
  D_database: "..."
  D_deploy: "..."
  # All stack decisions
```

## Output Contract

```yaml
status: "DONE" | "NEEDS_CONTEXT"
summary: "<3-5 sentences: architecture pattern, key per-tech decisions, constraint count>"
new_decisions:
  D_arch_pattern: "<e.g., Clean Architecture, Feature-Sliced, MVC>"
  D_api_style: "<REST | GraphQL | tRPC | gRPC>"
  D_state_management: "<approach>"
  D_auth_pattern: "<JWT | session | OAuth flow>"
  D_testing_strategy: "<unit + integration + e2e split>"
  D_error_handling: "<pattern>"
  D_logging_observability: "<approach>"
artifact_path: ".metaproject/jobs/<job>/artifacts/architecture.md"
additional_artifacts:
  - ".metaproject/jobs/<job>/artifacts/tech-bestpractices.md"
```

---

## Workflow

### Step 1: Define Application Architecture

Based on project level and stack, select architecture pattern:

| Level | Typical Pattern | Why |
|-------|---------------|-----|
| MVP | Simple layered (routes → services → DB) | Minimum indirection, fast to build |
| Pet | Feature-based modules | Good learning structure |
| Startup | Clean Architecture / Hexagonal | Testable, scalable when team grows |
| Production | DDD + CQRS where justified | Complex domain needs it |

Document the pattern with:
- Layer diagram (which layers, what goes where)
- Dependency direction (who imports whom)
- Module/feature structure (how to organize code)
- Cross-cutting concerns (logging, auth, error handling)

### Step 2: Per-Technology Research

For EACH technology in the stack, research and document:

#### Frontend (e.g., Next.js)
- Project structure pattern (App Router conventions, feature folders)
- Component patterns (Server vs Client components, composition)
- State management pattern (chosen approach + why)
- Data fetching pattern (Server Actions, SWR, React Query)
- Styling approach (Tailwind, CSS Modules, styled-components)
- Form handling pattern
- Error boundary strategy
- Testing approach (unit: Vitest, e2e: Playwright)

#### Backend (e.g., NestJS)
- Module structure pattern
- DTO and validation approach
- Service layer patterns
- Repository / data access pattern
- Error handling (exception filters, typed errors)
- Authentication and authorization pattern
- API versioning strategy
- Testing approach (unit + integration)

#### Database (e.g., PostgreSQL)
- Schema design approach (normalized vs denormalized for use case)
- Migration strategy and tooling
- Indexing guidelines for expected queries
- Connection pooling approach
- Backup and recovery (if production level)

#### Infrastructure (e.g., Docker)
- Container structure (multi-stage builds, compose setup)
- Environment management (dev/staging/prod)
- CI/CD pipeline pattern
- Monitoring and logging stack

### Step 3: Define API Contract Style

Based on project needs:
- REST: resource-based, OpenAPI spec, versioning scheme
- GraphQL: schema-first vs code-first, resolver patterns
- tRPC: shared types, router structure
- gRPC: proto file organization, service boundaries

### Step 4: Cross-Cutting Patterns

Define patterns that span all layers:
- **Authentication flow**: complete auth pattern (signup, login, token refresh, logout)
- **Authorization**: RBAC, ABAC, or simple role checks
- **Error handling**: typed errors, error codes, user-facing messages
- **Logging**: structured logging format, log levels, sensitive data masking
- **Validation**: where validation happens (API layer, domain layer, both)
- **Testing**: test pyramid ratios for this project level

### Step 5: Write Architecture Doc

Write `artifacts/architecture.md`:

```markdown
# Architecture: <Project/Task Name>

## Architecture Pattern: <Pattern Name>
**Rationale**: <why this pattern for this project>
**Alternative considered**: <pattern and why rejected>

## Layer Diagram
<describe layers and dependencies>

## Module Structure
<how code is organized — by feature, by layer, hybrid>

## Component Interaction
<how layers communicate — direct calls, events, DTOs>

## Cross-Cutting Concerns
### Authentication: <pattern>
### Error Handling: <pattern>
### Logging: <pattern>
### Validation: <pattern>

## Key Architecture Decisions
| Decision | Choice | Rationale | Alternative |
|----------|--------|-----------|-------------|
| <decision> | <choice> | <why> | <what else> |
```

### Step 6: Write Best Practices Constraints

Write `artifacts/tech-bestpractices.md` — this is the **constraint document**
that PRD writer must follow:

```markdown
# Technical Best Practices & Constraints

## How to Use This Document
Every requirement in the PRD MUST be compatible with these constraints.
The consistency-checker (Phase 5) validates PRD against these rules.

## Frontend Constraints (<technology>)
### MUST
- [ ] <constraint 1 — e.g., "Use Server Components by default, Client only when needed">
- [ ] <constraint 2>
### MUST NOT
- [ ] <antipattern 1 — e.g., "Do not use getServerSideProps in App Router">
- [ ] <antipattern 2>
### SHOULD
- [ ] <recommendation 1>

## Backend Constraints (<technology>)
### MUST
- [ ] ...
### MUST NOT
- [ ] ...
### SHOULD
- [ ] ...

## Database Constraints (<technology>)
### MUST
- [ ] ...
### MUST NOT
- [ ] ...

## API Constraints
### MUST
- [ ] ...

## Infrastructure Constraints
### MUST
- [ ] ...

## Testing Constraints
### MUST
- [ ] <e.g., "Every API endpoint must have integration test">
- [ ] <e.g., "Critical user flows must have e2e tests">
### Test Pyramid Target
- Unit: <X>%
- Integration: <Y>%
- E2E: <Z>%

## Security Constraints
### MUST
- [ ] ...
### MUST NOT
- [ ] ...
```

### Step 7: Return Summary

Compact summary: architecture pattern, number of constraints defined,
key per-tech decisions, any concerns about pattern compatibility.
