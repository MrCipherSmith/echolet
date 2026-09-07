---
name: db-migrate
description: "Use when creating, applying, rolling back, or checking the status of database migrations."
triggers:
  - "/db-migrate"
  - "Create migration"
  - "Run migrations"
  - "Migration status"
  - "Rollback migration"
metadata:
  author: "MrCipherSmith"
  version: "1.0.0"
  category: "database"
  compatible_harnesses: "cursor,codex,zed,opencode,claude"
license: "MIT"
---

# Database Migration

Create, apply, and manage database migrations.

## Arguments

- `/db-migrate create <name>` — create new migration
- `/db-migrate apply` — apply pending migrations
- `/db-migrate status` — show migration status
- `/db-migrate rollback` — rollback last migration

## Workflow

### Step 1: Detect ORM/Migration Tool
Search for: `prisma/schema.prisma`, `ormconfig.*`, `data-source.ts`, `knexfile.*`, `.sequelizerc`, `drizzle.config.ts`, `alembic.ini`, `migrations/` with raw SQL.

### Step 2: Execute Command

**Create:**

| Tool | Command |
|------|---------|
| Prisma | `npx prisma migrate dev --name <name>` |
| TypeORM | `npx typeorm migration:generate -n <name>` |
| Knex | `npx knex migrate:make <name>` |
| Sequelize | `npx sequelize-cli migration:generate --name <name>` |
| Drizzle | `npx drizzle-kit generate:migration --name <name>` |
| Alembic | `alembic revision --autogenerate -m "<name>"` |

**Apply / Status / Rollback** — analogous commands per tool.

### Step 3: If Creating — Help Write Migration
1. Ask what schema changes are needed (or infer from context)
2. For schema-based ORMs — edit schema first, then generate
3. For code-based migrations — generate template and fill in up/down
4. Review generated migration before applying

### Step 4: Apply & Verify
1. Show migration SQL preview if possible
2. Apply migration
3. Verify with status command

## Rules

- ALWAYS show migration content before applying in production
- ALWAYS confirm before rollback operations
- NEVER apply to production without explicit confirmation
- For destructive operations (drop table, remove column), double-warn
- If ORM can't be detected, ask the user
