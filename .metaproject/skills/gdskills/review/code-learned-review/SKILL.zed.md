---
name: code-learned-review
description: "Reviews the current branch against conventions this project learned from its own pull-request comments, recorded in a local project skill. Ships with an empty checklist: the content comes from `keryx review learn`, never from the tool. Use when: a project has a learned review skill and wants its own accumulated conventions applied."
triggers:
  - "learned review"
  - "review with our conventions"
  - "review using what we learned"
metadata:
  author: "keryx"
  version: "2.0.0"
  category: "review"
  compatible_harnesses: "cursor,codex,zed,opencode"
license: "MIT"
---

# Learned Code Review (current branch only)

## What this skill is, and what it is not

This skill carries **no review conventions of its own**. It is a mechanism with
an empty checklist, and the checklist is filled in by the project that installs
it.

What it applies is a **project skill** under
`.metaproject/project-skills/<module>/<skill>/SKILL.md`, whose `Review Lessons`,
`Review Checklist` and `Anti-patterns` sections were written from pull-request
comments left by the people that project named. Point a second project at
different reviewers and its learned skill diverges from the first. That is the
intended behaviour: there is no single correct checklist, and shipping one would
mean shipping one team's opinions to everybody.

If this project has no learned skill yet, **say so and stop**. An empty learned
review is not a generic review; use `review-orchestrator` for that.

## Workflow

Copy this checklist and track progress:

```
Learned Review Progress:
- [ ] Step 1: Read .metaproject/review-learning.config.json — which skill is this project's?
- [ ] Step 2: Read that project skill; if it has no lessons, stop and say so
- [ ] Step 3: Determine parent branch and calculate merge-base
- [ ] Step 4: Collect git diff (committed + local changes)
- [ ] Step 5: Apply the learned checklist, lesson by lesson
- [ ] Step 6: Report each finding with the learned lesson it rests on
- [ ] Step 7: Feed new pull-request comments back with `keryx review learn`
```

## Mandatory rules

1. **Default scope (no commit hash/range given)**: the review covers **all**
   changes on the current branch from the merge-base with its parent branch —
   committed (`BASE_SHA..HEAD`) and local uncommitted (staged/unstaged/untracked).
2. **Explicit commit hash/range**: review only the requested range; do not add
   local uncommitted changes unless asked separately.
3. **The checklist is the project's, not this file's**: every finding cites a
   line in the project skill named by
   `.metaproject/review-learning.config.json`. A finding with nothing behind it
   there is a generic finding and belongs to the reviewer that owns it —
   `review-logic`, `review-architecture`, `review-security-code`.
4. **Result**: a detailed report with an explanation per finding and a concrete
   fix (a minimal patch where the fix is obvious).

## Where the checklist comes from

```bash
# 1. Which local skill does this project teach, from which repository,
#    and whose comments count?
cat .metaproject/review-learning.config.json

# 2. The comments themselves, collected once per round and kept on disk.
keryx review comments collect --repo <owner/repo> --pr <n> --sha <head-sha>

# 3. The join: configured authors only, read from the record above, never
#    re-fetched. Writes a proposal and changes nothing.
keryx review learn --pr <n>

# 4. The only writer. Bumps the skill version, appends to skill-changelog.md,
#    and refuses any target outside .metaproject/project-skills/.
keryx skills learn apply .metaproject/data/gdskills/proposals/<id>.json
```

An author the config does not name contributes nothing — their text reaches no
proposal and no `SKILL.md`. A project with no config file does not learn, and
that is a supported state rather than an error.

## Scope Detection

See shared script: `skills/shared/git-merge-base.md`

Run the script from that file to determine MERGE_BASE and SCOPE before
proceeding with the review.

## Commands to assemble the review slice

### A) Default mode (no hash/range from the user)

```bash
git status

# The committed part of the branch
git log --oneline "${BASE_SHA}..HEAD"
git diff --stat "${BASE_SHA}..HEAD"
git diff --name-status "${BASE_SHA}..HEAD"
git diff "${BASE_SHA}..HEAD"

# The full current slice from merge-base to the working tree:
# commits + staged + unstaged
# (untracked files via git status / git ls-files)
git diff --stat "${BASE_SHA}"
git diff --name-status "${BASE_SHA}"
git diff "${BASE_SHA}"
git ls-files --others --exclude-standard
```

### B) Explicit hash/range mode

```bash
git show --stat --name-status --patch <COMMIT_SHA>
git log --oneline <FROM_SHA>..<TO_SHA>
git diff --stat <FROM_SHA>..<TO_SHA>
git diff --name-status <FROM_SHA>..<TO_SHA>
git diff <FROM_SHA>..<TO_SHA>
```

## How to review

Work the learned checklist one lesson at a time against the diff. For each
lesson in the project skill, ask whether the diff contains the situation the
lesson describes, and record the answer either way — a lesson that never matches
anything is a lesson worth retiring, and only a review that checked it can say
so.

Three rules govern the application, and they are the same three whatever the
lessons say:

- **A lesson is evidence, not authority.** It records that somebody objected to
  something once. If the diff has a reason the objection does not apply here, the
  reason wins and the finding is not raised.
- **Do not generalise a lesson past its text.** A lesson about one function is
  about that shape of function. Widening it into a rule about a layer, a module
  or a language is inventing a convention the project never agreed to.
- **Do not attribute.** The record says a comment was left. Reporting a finding
  as what a particular person would want turns a checklist back into a persona,
  which is the defect this skill exists to remove.

## Output format

```markdown
## Verdict

<APPROVE / APPROVE WITH SUGGESTIONS / REQUEST CHANGES / COMMENT> + the 1-3 most
important points.

## Review scope (current branch only)

- Branch: `<BRANCH>`
- Parent ref: `<PARENT>`
- Merge-base: `<BASE_SHA>`
- Scope mode: `<default-with-uncommitted | explicit-hash-range>`
- Commits (merge-base..HEAD): <N>
- Changed files: <list or count>

## Learned checklist applied

- Project skill: `<module>/<skill>` version `<x.y.z>`
- Lessons checked: <N>
- Lessons that matched: <N>

## Findings

<findings, grouped by the learned lesson each rests on>

## Findings with no learned lesson behind them

<either empty, or listed separately and routed to the reviewer that owns them>

## Suggested fixes (patches)

<minimal unified diffs for the obvious ones>
```

### Required shape of each finding

- **Severity**: `blocker` / `major` / `minor`
- **Learned lesson**: the line from the project skill this rests on
- **Location**: file path + the relevant hunk from the diff
- **Problem**: what is wrong
- **Why it matters**: correctness / testability / conventions / maintainability
- **Suggested fix**: what specifically to do, without widening scope
- **Optional patch**: a unified diff when the fix is simple

Example patch block:

```diff
diff --git a/path/file.ts b/path/file.ts
index 0000000..1111111 100644
--- a/path/file.ts
+++ b/path/file.ts
@@ -1,3 +1,3 @@
-const x = 1;
+const x = 2;
```

---

## Scope Boundaries

This skill covers **review against this project's own learned conventions**,
following `code-review-learned-profile.mdc`. It has no opinions of its own.

| Concern                                                        | This skill | Use instead              |
| -------------------------------------------------------------- | ---------- | ------------------------ |
| This project's accumulated review conventions                  | ✅ YES     | —                        |
| General AI review (broader quality, performance, UX)           | ❌ NO      | `code-ai-review`         |
| MobX store internals (actions, computed, reactions)            | ❌ NO      | `code-mobx-store-review` |
| Pure style/naming/architecture pattern audit                   | ❌ NO      | `code-style-review`      |
| Logic correctness with no learned lesson behind it             | ❌ NO      | `review-logic`           |

---

## Job Context Awareness

When dispatched by `job-orchestrator` as part of a job pipeline, the prompt MAY
include:

```
JOB_NAME:     <job-name>
CONTEXT_PATH: .metaproject/jobs/<job-name>/ai/context.md
```

If provided and the file exists, read the context document before starting the
review. Use it to:

- Understand which libraries and patterns were intentionally chosen for the
  implementation
- Avoid flagging correct library usage as issues
- Provide more accurate findings by understanding the project's architectural
  decisions

If the file does not exist or is not provided, proceed normally — context is
optional and non-blocking.
