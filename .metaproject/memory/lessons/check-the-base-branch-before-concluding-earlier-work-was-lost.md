# Check the base branch before concluding earlier work was lost

Version: 0.2.0
Type: lesson
Status: accepted
Confidence: high

## Summary

T17 concluded that T16's watchdog fix "was never committed", because
`apps/cli/test/childProcessTimeouts.ts` was absent and
`apps/cli/src/commands/cli.test.ts` still held its original `15000` literal. Both
observations were true and the conclusion was wrong: the worktree's base was 30
commits behind `origin/main`, where the fix had landed long before. Compare
against the remote before reporting that work is missing.

## Details

**What happened.** A worktree was created from commit `23a17aa`. T16's report said
its changes were "staged in the working tree for review", so their absence looked
like confirmation that they had been lost. The checks run were all local:
`ls apps/cli/test`, a search for the literal, `git status --short` (clean). None of
them touch the remote, so none of them could reveal that `origin/main` was 30
commits ahead and already contained the fix — and, further along, contained
`T40`'s extension of it to `test/e2e/` as well.

**Consequences that had to be undone.** A whole change was built on the stale
base: seven test files edited, a new constants module created, two commits made.
The push was then blocked by the pre-push gate — not for the reason it looked
like, but because the gate script list itself lives in the tree and the stale base
lacked two of the four scripts. That block was the first signal of the real
problem. The branch had to be reset to `origin/main` and the work reduced to the
genuine delta.

**The check that would have caught it,** before any editing:

```bash
git fetch origin
git rev-list --left-right --count origin/main...HEAD    # behind / ahead
git ls-tree --name-only origin/main <path-you-think-is-missing>
```

**Two secondary lessons.**

- **A pre-push gate that fails on a missing gate script may be reporting a stale
  base, not a damaged tree.** The suggested remedy (`git checkout -- scripts/gate`)
  cannot help when the script was never in this base at all.
- **The measurement work was not wasted, only re-scoped.** Everything measured
  stayed valid; what changed was what the diff needed to be. Comparing against the
  remote first would have aimed it correctly from the start — see
  [[test-harness-ceilings-are-derived-from-a-measured-worst-case-times-about-2-2]]
  for what the surviving delta turned out to be.

## Provenance

- Source: T17 investigation (`003-T17-tests`), correcting its own finding F-005
- Link: `.metaproject/flows/003-2026-09-07-echolet-residuals-and-tui/t17-e2e-contention-report.md` §0
- Created: 2026-09-09
- Updated: 2026-09-09

## Related Scopes

- Module: repository process
- Entity: git worktree base
- Files: scripts/gate/, apps/cli/test/childProcessTimeouts.ts
- Skills: flow

## Tags

process, git, worktree, stale-base, push-gate, self-correction

## Changelog

- 0.1.0 - Initial version, replacing an incorrect historical-context entry that claimed T16's fix was never committed.
