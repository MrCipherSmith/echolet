---
name: project-discovery
description: >
  Collects and structures initial project information from multiple sources.
  Use when: dispatched by gproject-orchestrator Phase 0.
  NOT for: direct user invocation — always called through orchestrator.
metadata:
  version: 1.0.0
  compatible_harnesses: "cursor,codex,zed,opencode"
---

# gproject-discovery

## Purpose

Gather raw project information from all available sources, structure it into
a unified discovery brief. This is the foundation — every downstream decision
depends on the quality of discovery.

## Iron Laws

| # | Law |
|---|-----|
| 1 | NEVER assume information not explicitly provided or discovered |
| 2 | ALWAYS distinguish facts from assumptions — label each |
| 3 | If a critical area has no data, return NEEDS_CONTEXT — don't fill gaps with guesses |
| 4 | Web research MUST cite sources |
| 5 | Codebase analysis MUST reference actual file paths |

---

## Input Contract

```yaml
task: "Collect project discovery data"
mode: "new_project" | "task_in_project"
user_input: "<original user request text>"
uploaded_docs: [<file paths if any>]
repo_path: "<path if task_in_project>"
interview_results: "<from interview skill, if already run>"
```

## Output Contract

```yaml
status: "DONE" | "NEEDS_CONTEXT"
summary: "<3-5 sentences: what was found, key gaps, confidence level>"
new_decisions:
  D_mode: "new_project | task_in_project"
  D_domain: "<business domain>"
  D_audience: "<target users>"
  D_scale_estimate: "<rough scale: personal/team/startup/enterprise>"
artifact_path: ".metaproject/jobs/<job>/artifacts/discovery-brief.md"
```

If NEEDS_CONTEXT:
```yaml
status: "NEEDS_CONTEXT"
questions:
  - id: "Q1"
    text: "<question>"
    options:
      A: "<option>"
      B: "<option>"
      C: "<option>"
      D: "<option>"
    why: "<why this matters for downstream phases>"
```

---

## Workflow

### Step 1: Parse User Input

Extract from the user's original request:
- What they want to build/implement
- Any constraints mentioned (budget, timeline, team size)
- Any technical preferences mentioned
- Target audience / users mentioned

### Step 2: Source-Specific Collection

#### Mode: new_project

1. **User input analysis** — extract all explicit and implied requirements
2. **Uploaded documents** — parse any attached files (briefs, notes, mockups, transcripts)
3. **Web research** — search for:
   - Similar products / competitors (max 5)
   - Market context and trends
   - Common technical approaches for this type of project
4. **Gap identification** — list what's missing for confident decision-making

#### Mode: task_in_project

1. **User input analysis** — extract the specific task/feature request
2. **Codebase scan** (via context-collector) — gather:
   - Project structure (directories, key files)
   - Technology stack (package.json, requirements.txt, Dockerfile, etc.)
   - Architecture patterns in use
   - Existing documentation (README, docs/, ADRs)
   - Related code areas (files likely affected by this task)
3. **Existing docs** — parse project documentation for context
4. **Web research** — best practices for the specific task within the detected stack
5. **Gap identification** — what's unclear about the existing codebase or requirements

### Step 3: Structure Discovery Brief

Write `artifacts/discovery-brief.md` with this structure:

```markdown
# Discovery Brief: <Project/Task Name>

## Source Summary
- User input: <what was provided>
- Documents analyzed: <list>
- Codebase scanned: <yes/no, scope>
- Web research: <topics covered>

## Project/Task Description
<Clear 2-3 paragraph description of what needs to be built/done>

## Key Facts (confirmed)
- <fact 1> [source: user input / document / codebase]
- <fact 2> [source: ...]

## Assumptions (need validation)
- <assumption 1> — confidence: high/medium/low
- <assumption 2> — confidence: ...

## Stakeholders & Users
- Primary users: <who>
- Secondary users: <who>
- Stakeholders: <who decides>

## Existing Context (task_in_project only)
- Tech stack: <detected>
- Architecture: <detected patterns>
- Related components: <list with file paths>
- Existing patterns to follow: <list>

## Competitive / Market Context (new_project only)
- Similar products: <list with brief notes>
- Differentiators mentioned: <list>
- Market trends: <relevant>

## Constraints Identified
- Budget: <if mentioned>
- Timeline: <if mentioned>
- Team: <size, skills if mentioned>
- Technical: <any mentioned constraints>

## Open Questions
- <question 1> — impacts: <which downstream decisions>
- <question 2> — impacts: ...

## Confidence Assessment
- Overall completeness: <high/medium/low>
- Areas needing more data: <list>
```

### Step 4: Return Summary to Orchestrator

Compose compact summary (3-5 sentences) covering:
- What the project/task is about
- Key constraints discovered
- Confidence level
- Critical gaps that need resolution
