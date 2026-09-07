---
name: reviewer-skill-creator
model_tier: standard
description: |
  Use when asked to create a project-local reviewer for review-orchestrator, usually
  from an existing source: a rules file, a review profile, a conventions doc, a
  team's written review standard. Scaffolds the package under
  .metaproject/project-skills/review/<name>/, records where the source came from
  so drift is detectable later, writes the reviewer against the orchestrated review
  contract, and confirms the orchestrator can see it.
  NOT for: editing a bundled reviewer keryx ships (those live in the source tree and
  change through a PR), and NOT for creating an ordinary entity project-skill
  (entity-skill-creator).
triggers:
  - "create a reviewer"
  - "new reviewer for review-orchestrator"
  - "make a reviewer from this profile"
  - "создай ревьюера"
  - "создай нового ревьюера на основании"
metadata:
  author: "MrCipherSmith"
  version: "1.0.0"
  category: "core"
  compatible_harnesses: "cursor,codex,zed,opencode,claude"
license: "MIT"
---

# Reviewer Skill Creator

Turn a written review standard into a reviewer the orchestrator will dispatch.

The request usually arrives as one sentence — *"create a reviewer for
review-orchestrator based on `<path>/rules/core/some-profile.mdc`"* — and it names two
things: a **destination** (the review lane) and a **source** (a file someone
else maintains). Both matter, and the second is the one that is usually
mishandled.

---

## Where it goes, and why there

```
.metaproject/skills/gdskills/review/<name>/     <- reviewers keryx ships
.metaproject/project-skills/review/<name>/      <- reviewers this project defines
```

The parallel is the whole convention. A project reviewer is a project-skill whose
**module is `review`**; nothing else marks it, and `keryx review reviewers`
finds it by that alone. Anyone who knows where bundled reviewers live knows where
these go.

---

## Workflow

```
reviewer-skill-creator Progress:
- [ ] Step 1: Read the source in full, and say what it is
- [ ] Step 2: Scaffold the package, recording the source
- [ ] Step 3: Write the reviewer against the orchestrated contract
- [ ] Step 4: De-personalise
- [ ] Step 5: Verify, and confirm the orchestrator sees it
```

### Step 1 — read the source in full, and say what it is

Read the whole file before writing anything. A review profile is usually not
organised as a reviewer: it is a list of rules, or a transcript of preferences,
or a checklist mixed with examples from one specific repository.

Sort what you find into three piles, out loud, in your reply:

- **Method** — a way of establishing something. *Delete the gate and see whether
  the suite stays green. Measure the rendered width. Read the producer at a
  pinned SHA.* This is the valuable pile and it transfers.
- **Convention** — a rule true of the source's own codebase. *Stores go in
  `src/*/store.ts`.* Keep it only if it is true of THIS project; verify, do not
  assume.
- **Persona** — one person's voice, catchphrases, verdict vocabulary, and habits
  of address. This pile is dropped whole. See Step 4.

If the source is mostly the third pile, say so and stop. A reviewer distilled
from someone's tone reviews tone.

### Step 2 — scaffold the package, recording the source

```bash
keryx skills create "<short target>" \
  --module review \
  --name <reviewer-name> \
  --note "<one line: what this reviewer is for>" \
  --origin <path to the source file>
```

Three fields, three different jobs, and mixing them is the recorded failure mode:

- `<short target>` is a **routing key** — a path, a symbol, or a short concept.
  `keryx skills route` matches queries against it. Never a sentence.
- `--note` is the prose. It renders under Purpose and touches nothing that routes.
- `--origin` is the source file's path, stored verbatim and hashed. This is what
  makes the next question answerable.

**Always pass `--origin` when a source file exists.** The source is maintained
somewhere else and will move on; without the hash, a reviewer built from last
month's version reads as current forever, and nobody finds out until its findings
disagree with the standard it claims to encode. With it,
`keryx review reviewers` reports `drift: changed` the moment the file differs.

Quote the path if it starts with `~` and you want it stored that way; an
unquoted `~` is expanded by the shell before keryx sees it. Either is fine —
both resolve — but the stored form is what a human reads later.

### Step 3 — write the reviewer against the orchestrated contract

The scaffold is a generic entity-skill template. Replace its body. A reviewer
that does not conform is handled by the Sub-Agent Report Quality Gate exactly as
a bundled one would be — local authorship is not evidence.

Required, all of it in `SKILL.md`:

- **Scope** — what this reviewer owns, and explicitly what it does not. Name the
  neighbouring reviewers that own the excluded parts. A lane that does not say
  where it stops duplicates three others.
- **Checklist** — the method pile from Step 1, as checks that can be performed.
- **Severity** — do **not** write a rubric. Point at
  `review-orchestrator/SKILL.md` → **Severity (canonical)** and add one table
  saying where this reviewer's recurring conditions land under it. Ten private
  rubrics feeding one sort produce a ranking that means ten things at once.
- **Shared laws** — copy the three verbatim from the orchestrator: no
  unreproducible harm claim above `info`, never flag the theoretical, one finding
  per class.
- **Class scope** — `blocker` and `major` carry every site holding the shape and
  the enumeration method that found them.
- **Orchestrated Review Contract** — return `REVIEW_RESULT` per
  `reviewer-finding.schema.json`, with a finding-id prefix of your own.

If the source's method needs a command to be worth anything — a mutation, a
measurement, a probe — say so as an iron law, and say what the finding is worth
without it. A method nobody runs is a preference.

### Step 4 — de-personalise

Keep the method. Drop the person.

Strip names and handles, catchphrases, verdict vocabulary, forms of address, and
anything whose meaning depends on knowing the author. A rule that reads as one
person's taste will be followed as taste; the same rule stated as a procedure
with a stated reason will be followed as a procedure.

This is not politeness, it is transferability, and keryx enforces the same line
on its shipped tree: `bundled-eval.ts` fails a bundled skill that names the
reviewer it was learned from or reuses their phrases. Project-skills are not
scanned by that check — which makes this step your responsibility rather than
the gate's.

For every rule you keep, write the **reason** beside it. A reason survives being
transplanted into a codebase the author never saw; an assertion does not.

### Step 5 — verify, and confirm the orchestrator sees it

```bash
keryx skills verify review/<reviewer-name>
keryx review reviewers
```

The second is the one that matters: it is the same call
`review-orchestrator` makes, so its output is proof the reviewer will be
dispatched rather than a hope. Check the row shows your reviewer with
`drift: clean`.

Then say, in your reply, which of the three piles from Step 1 you kept, which you
dropped, and what you could not verify against this project.

---

## Iron Laws

1. **`--origin` whenever a source file exists.** A reviewer built from a file
   nobody can trace back is a reviewer nobody can update.
2. **The target is a routing key, the note is the prose.** A sentence in the
   target produces a skill that matches no query and verifies as permanently
   stale. This is a recorded failure, not a hypothetical.
3. **No private severity rubric.** Point at the canonical one.
4. **Drop the persona, keep the method, state the reason.**
5. **Do not claim the reviewer is wired until `keryx review reviewers` shows
   it.** Creating files is not registration, and registration is not discovery.

---

## Refreshing a reviewer whose source moved on

`keryx review reviewers` reporting `drift: changed` means the source file differs
from what was imported. It does **not** mean the reviewer is wrong.

Re-read the source, diff it against what the skill encodes, and then decide per
change: fold it in, or record in the skill why this project deliberately differs.
Re-run Step 2's command with the same `--name` to re-record the hash once the
skill matches the source again.

A deliberate divergence that is written down is a decision. The same divergence
undocumented is drift that will be silently "fixed" by whoever refreshes next.

---

## Scope Boundaries

| Concern | This skill | Use instead |
|---|---|---|
| Create a project-local reviewer | YES | — |
| Refresh one whose origin drifted | YES | — |
| Create an entity/module project-skill | NO | `entity-skill-creator` |
| Change a reviewer keryx ships | NO | edit `src/gdskills/bundled/skills/review/` and open a PR |
| Update a skill from review findings | NO | `entity-skill-learner`, `keryx skills learn` |
| Decide which reviewers a round dispatches | NO | `review-orchestrator` |
