# Project Memory

Version: 0.2.0

## Purpose

Long-term project memory: lessons learned, decisions, constraints, known
mistakes, historical context, and reusable patterns. Markdown is the source of
truth; `keryx memory index` optionally builds a disposable generated catalog
for inspection. Search scans canonical Markdown directly and does not depend on
the catalog.

## Entry Types

- `lesson` (`lessons/`)
- `decision` (`decisions/`)
- `constraint` (`constraints/`)
- `known-mistake` (`known-mistakes/`)
- `historical-context` (`historical-context/`)
- `pattern` (`patterns/`)
- `task-note` (`task-notes/`)
- `review-note` (`review-notes/`)
- `incident` (`incidents/`)
- `migration-note` (`migration-notes/`)
- `integration-note` (`integration-notes/`)

## Usage

```bash
keryx memory new lesson --title "<title>"
keryx memory index [--embeddings]
keryx memory search "<query>" --status accepted [--save-report]
keryx memory transition <path> --to accepted --reason "<reason>"
```

Default search is pure and never writes a report. Only `accepted`, current,
scoped, bounded projections influence skills; `draft` entries are advisory.
