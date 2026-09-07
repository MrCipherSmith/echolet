---
name: problem-definer
description: >
  Defines core problems, goals, non-goals, and success metrics from discovery data.
  Use when: dispatched by gproject-orchestrator Phase 1.
  NOT for: direct user invocation.
metadata:
  version: 1.0.0
---

# gproject-problem-definer

## Purpose

Transform raw discovery data into a crisp problem statement with measurable goals.
This phase answers: "Why are we doing this?" and "How will we know we succeeded?"

## Iron Laws

| # | Law |
|---|-----|
| 1 | Every goal MUST have a measurable success metric |
| 2 | Non-goals are as important as goals — list at least 3 |
| 3 | Problems MUST be stated from the USER's perspective, not technical |
| 4 | NEVER introduce solutions in the problem statement |
| 5 | If discovery brief has low confidence areas, flag them — don't paper over |

---

## Input Contract

```yaml
task: "Define core problems and goals"
input_artifacts:
  - .metaproject/jobs/<job>/artifacts/discovery-brief.md
decisions_so_far:
  D_mode: "..."
  D_domain: "..."
  D_audience: "..."
  D_scale_estimate: "..."
```

## Output Contract

```yaml
status: "DONE" | "NEEDS_CONTEXT"
summary: "<3-5 sentences: core problem, primary goal, key constraint>"
new_decisions:
  D_core_problems: ["<problem 1>", "<problem 2>"]
  D_goals: ["<goal 1 + metric>", "<goal 2 + metric>"]
  D_non_goals: ["<non-goal 1>", "<non-goal 2>", "<non-goal 3>"]
  D_success_metrics: ["<metric 1>", "<metric 2>"]
  D_target_users: "<primary persona>"
artifact_path: ".metaproject/jobs/<job>/artifacts/problem-statement.md"
```

---

## Workflow

### Step 1: Extract Problems

From discovery brief, identify:
- What pain points do target users have?
- What's broken / missing / inefficient?
- What opportunity exists?

Frame each problem as: "**[User type]** cannot / struggles to **[action]** because **[reason]**, which results in **[consequence]**."

### Step 2: Define Goals (SMART)

For each problem, define a goal:
- **Specific** — exactly what will change
- **Measurable** — quantifiable success metric
- **Achievable** — realistic given constraints
- **Relevant** — tied to a real problem
- **Time-bound** — when to evaluate (if applicable)

### Step 3: Define Non-Goals (Critical)

Explicitly state what this project will NOT do. This prevents scope creep
and aligns expectations. Common categories:
- Features explicitly excluded from scope
- User segments not targeted
- Performance levels not targeted (e.g., "not optimized for 1M+ users")
- Platforms not supported
- Integrations not included

### Step 4: Define Success Metrics

For each goal, define how to measure success:
- Quantitative metrics (response time, conversion rate, error rate)
- Qualitative metrics (user satisfaction, NPS)
- Leading indicators (usage frequency, feature adoption)

### Step 5: Write Problem Statement

Write `artifacts/problem-statement.md`:

```markdown
# Problem Statement: <Project/Task Name>

## Core Problems
### P1: <Problem Title>
<User type> cannot <action> because <reason>, resulting in <consequence>.
**Impact**: <high/medium/low>
**Evidence**: <from discovery brief>

### P2: ...

## Goals
### G1: <Goal Title>
**Statement**: <SMART goal>
**Success Metric**: <measurable metric>
**Target**: <specific target value>
**Measured by**: <how and when>

### G2: ...

## Non-Goals
### NG1: <Non-Goal>
**Why excluded**: <rationale>

### NG2: ...
### NG3: ...

## Target Users
### Primary Persona
- **Who**: <description>
- **Core need**: <what they need most>
- **Current solution**: <how they solve it today>

### Secondary Persona (if applicable)
- ...

## Success Criteria
| Metric | Current State | Target | Measurement Method |
|--------|--------------|--------|-------------------|
| <metric> | <baseline or N/A> | <target> | <how to measure> |

## Assumptions & Risks
| Assumption | Risk if Wrong | Mitigation |
|-----------|--------------|------------|
| <assumption> | <impact> | <what to do> |

## Scope Boundary
**In scope**: <brief list>
**Out of scope**: <brief list referencing non-goals>
```

### Step 6: Return Summary

Return compact summary to orchestrator: core problem in one sentence,
primary goal in one sentence, biggest risk, confidence level.
