---
name: stack-advisor
description: >
  Determines project level (MVP/pet/startup/production) and recommends optimal
  technology stack with trade-off analysis.
  Use when: dispatched by gproject-orchestrator Phase 2.
  NOT for: direct user invocation.
metadata:
  version: 1.0.0
  compatible_harnesses: "cursor,codex,zed,opencode"
---

# gproject-stack-advisor

## Purpose

Select the right project level and technology stack based on problems, goals,
constraints, and best practices. Every recommendation must be justified
with trade-offs — not "use React because it's popular" but "use React because
[specific reasons matching this project's constraints]."

## Iron Laws

| # | Law |
|---|-----|
| 1 | EVERY technology choice MUST have explicit rationale tied to project constraints |
| 2 | EVERY choice MUST list at least one considered alternative and why it was rejected |
| 3 | Stack MUST match project level — no Kubernetes for an MVP |
| 4 | In task_in_project mode, default to existing stack unless change is strongly justified |
| 5 | NEVER recommend a technology without checking its maturity and community support |
| 6 | Team skills MUST be a primary factor — perfect tech with no team knowledge = wrong choice |

## Red Flags

| Flag | What's happening | Action |
|------|-----------------|--------|
| Recommending 5+ new technologies for MVP | Over-engineering | Simplify to max 3 core choices |
| Ignoring team skills in rationale | Tech-driven not people-driven | Re-evaluate with team factor |
| No alternative considered | Confirmation bias | Research at least 1 alternative per choice |
| Recommending bleeding-edge for production | Risk ignorance | Flag maturity concern |

---

## Input Contract

```yaml
task: "Select project level and technology stack"
input_artifacts:
  - .metaproject/jobs/<job>/artifacts/problem-statement.md
decisions_so_far:
  D_core_problems: [...]
  D_goals: [...]
  D_non_goals: [...]
  D_target_users: "..."
  D_scale_estimate: "..."
  # For task_in_project:
  D_existing_stack: "<if detected by context-collector>"
```

## Output Contract

```yaml
status: "DONE" | "NEEDS_CONTEXT"
summary: "<3-5 sentences: level chosen, stack chosen, key trade-off>"
new_decisions:
  D_level: "mvp | pet | startup | production"
  D_frontend: "<framework + version>"
  D_backend: "<framework + version>"
  D_database: "<DB + version>"
  D_cache: "<if needed>"
  D_queue: "<if needed>"
  D_auth: "<approach>"
  D_deploy: "<strategy>"
  D_infra: "<approach>"
artifact_path: ".metaproject/jobs/<job>/artifacts/stack-decision.md"
next_phase_needs:
  - "Per-technology best practices research"
  - "Architecture pattern selection"
```

---

## Workflow

### Step 1: Determine Project Level

Evaluate against criteria matrix:

| Factor | MVP | Pet/Learning | Startup | Production |
|--------|-----|-------------|---------|------------|
| Users | <100 | 1 (self) | 100-10K | 10K+ |
| Team | 1 person | 1 person | 2-5 | 5+ |
| Lifespan | weeks | indefinite | months-years | years |
| Budget | minimal | zero | seed/limited | funded |
| Uptime SLA | none | none | 99% | 99.9%+ |
| Data sensitivity | low | low | medium | high |
| Compliance | none | none | basic | regulated |

The level determines complexity ceiling:
- **MVP**: max simplicity, monolith, single deploy target, minimal infra
- **Pet**: developer experience priority, learning-friendly stack
- **Startup**: balance of speed and scalability, ready for growth
- **Production**: reliability, security, observability, scalability first

### Step 2: Evaluate Stack Options

For each layer, evaluate 2-3 options against project-specific criteria:

**Evaluation criteria** (weight varies by project level):
1. **Problem fit** — does it solve our specific problems well?
2. **Team match** — does the team know it? Learning curve?
3. **Ecosystem** — libraries, tools, community for our use case
4. **Scalability ceiling** — will it handle our target scale?
5. **Velocity** — how fast can we ship with it?
6. **Cost** — licensing, hosting, operational cost
7. **Maturity** — production-proven? Active maintenance?
8. **Integration** — works well with other chosen components?

### Step 3: Web Research (Best Practices)

For the shortlisted stack, research:
- Current best practices (2024-2025 sources preferred)
- Common pitfalls and antipatterns
- Production case studies at similar scale
- Performance benchmarks relevant to our use case

### Step 4: task_in_project Mode Adjustments

If mode is task_in_project:
- Start from existing stack (detected by context-collector)
- Only recommend NEW technologies if:
  - Existing stack cannot solve the specific problem
  - New tech integrates cleanly with existing stack
  - Learning overhead is justified by benefit
- Flag any technology additions clearly as "NEW — requires team learning"

### Step 5: Write Stack Decision

Write `artifacts/stack-decision.md`:

```markdown
# Stack Decision: <Project/Task Name>

## Project Level: <LEVEL>
**Rationale**: <why this level, based on constraints>

## Technology Stack

### Frontend: <Choice>
**Version**: <specific>
**Rationale**: <tied to project constraints>
**Alternative considered**: <what and why rejected>
**Key libraries**: <essential deps>

### Backend: <Choice>
**Version**: <specific>
**Rationale**: <tied to project constraints>
**Alternative considered**: <what and why rejected>
**Key libraries**: <essential deps>

### Database: <Choice>
...

### Infrastructure & Deploy: <Choice>
...

### Additional Services (if any)
- Cache: <if needed, with rationale>
- Queue: <if needed, with rationale>
- Search: <if needed, with rationale>

## Stack Compatibility Matrix
| Component | Integrates With | Integration Quality |
|-----------|----------------|-------------------|
| <A> | <B> | proven / good / experimental |

## Trade-offs Accepted
| Trade-off | What We Gain | What We Give Up |
|-----------|-------------|-----------------|
| <choice> | <benefit> | <cost> |

## Complexity Budget
**Total new technologies**: <count>
**Team learning required**: <list what's new>
**Estimated ramp-up**: <time>

## Risk Assessment
| Risk | Probability | Impact | Mitigation |
|------|------------|--------|------------|
| <risk> | <H/M/L> | <H/M/L> | <plan> |
```

### Step 6: Return Summary

Compact summary: level + core stack (one line) + biggest trade-off + confidence.
