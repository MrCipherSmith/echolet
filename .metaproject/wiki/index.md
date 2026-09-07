# Project Wiki

Version: 0.1.0

## Purpose

This is the local project knowledge base. It stores knowledge that should
outlive a single task: architecture, domain models, business rules, user
scenarios, components, services, integrations, and known decisions.

Read this index first. Do not read every page unless necessary.

## Page Types

- `architecture` - system or module architecture
- `domain-model` - entities, invariants, relationships
- `business-rule` - business constraints and decisions
- `user-scenario` - user workflows and expected outcomes
- `component` - UI/component behavior and ownership
- `service` - backend/service responsibility and APIs
- `integration` - external systems and contracts
- `decision` - known decisions and ADR-like records

## Create A Page

```bash
keryx wiki new <type> <slug> --title "<title>"
keryx wiki collect
keryx wiki index
```

## Pages

<!-- keryx:wiki-index:begin -->
<!-- generated: 2026-09-06T09:23:58.999Z | pages: 16 -->

### Architecture

- [Project Map](architecture/project-map.md) (draft) - Deterministic map of 56 code files, 0 assets, and 72 import edges across 24 top-level modules. Enrich each module page with the gdwiki skill.
- [Quality Map](architecture/quality-map.md) (draft) - Generated from Code Health: gate pass, score 97, 2 findings.
- [Testing Map](architecture/testing-map.md) (draft) - generatedAt: 2026-09-06T09:22:42.514Z

### Domain Model

_No pages yet._

### Business Rule

_No pages yet._

### User Scenario

_No pages yet._

### Component

    - [apps/mobile/src/screens](components/apps-mobile-src-screens.md) (draft)
    - [apps/mobile/src/services](components/apps-mobile-src-services.md) (draft)
    - [packages/client-core/src/identity](components/packages-client-core-src-identity.md) (draft)
    - [packages/client-core/src/sessions](components/packages-client-core-src-sessions.md) (draft)
  - [packages/client-db/src](components/packages-client-db-src.md) (draft)
    - [packages/crypto-core/src/identity](components/packages-crypto-core-src-identity.md) (draft)
    - [packages/crypto-core/src/mailbox](components/packages-crypto-core-src-mailbox.md) (draft)
    - [packages/crypto-core/src/session](components/packages-crypto-core-src-session.md) (draft)
    - [packages/crypto-core/src/signatures](components/packages-crypto-core-src-signatures.md) (draft)
    - [packages/protocol/src/constants](components/packages-protocol-src-constants.md) (draft)
    - [packages/protocol/src/types](components/packages-protocol-src-types.md) (draft)
    - [packages/protocol/src/validators](components/packages-protocol-src-validators.md) (draft)
  - [packages/session-node/src](components/packages-session-node-src.md) (draft)

### Service

_No pages yet._

### Integration

_No pages yet._

### Decision

_No pages yet._
<!-- keryx:wiki-index:end -->
