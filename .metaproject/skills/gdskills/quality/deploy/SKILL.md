---
name: deploy
description: "Use when deploying to any environment (staging, production) or when a deployment pipeline needs to run."
triggers:
  - "/deploy"
  - "Deploy to"
  - "Push to production"
  - "Deploy staging"
  - "Ship it"
metadata:
  author: "MrCipherSmith"
  version: "1.0.0"
  category: "ops"
  compatible_harnesses: "cursor,codex,zed,opencode,claude"
license: "MIT"
---

# Deploy

Automated deployment pipeline with pre-flight checks.

## Arguments

- `/deploy` — deploy to staging (default)
- `/deploy production` — deploy to production (requires confirmation)
- `/deploy --skip-tests` — skip test phase
- `/deploy --dry-run` — show what would happen without executing
- `/deploy <env> --rollback` — rollback to previous version

## Workflow

### Phase 1: Detect Project Type & Deploy Target
1. Read `package.json`, `docker-compose.yml`, `Dockerfile`, `vercel.json`, `railway.json`, `ecosystem.config.js`, `Makefile`
2. Detect stack: Node/Bun/Python/Go/Docker
3. Detect deploy target: Docker Compose, PM2, SSH, Vercel, Railway, custom script
4. Determine environment from argument (default: staging)

### Phase 2: Pre-flight Checks
Run in parallel where possible:
1. **Git status**: working tree clean (warn if dirty)
2. **Branch check**: correct branch for target env (production → main/master)
3. **Tests**: `npm test` / `pytest` / `go test ./...` (skip with `--skip-tests`)
4. **Lint**: `npm run lint` if available
5. **Type-check**: `npx tsc --noEmit` if TypeScript
6. **Build**: `npm run build` / `docker build`

If any check fails → stop and report.

### Phase 3: Deploy

| Target | Command |
|--------|---------|
| Docker Compose | `docker compose build && docker compose up -d` |
| PM2 | `pm2 reload ecosystem.config.js --env <env>` |
| SSH | `ssh <host> "cd <path> && git pull && npm install && npm run build && pm2 reload all"` |
| Vercel | `vercel --prod` or `vercel` (preview) |
| Custom | `npm run deploy:<env>` or `make deploy` |

### Phase 4: Post-deploy Verification
1. Health check: curl the health endpoint
2. Check logs for startup errors
3. Report: deployed version, environment, status

## Rules

- ALWAYS require explicit confirmation for production deploys
- NEVER deploy with failing tests (unless `--skip-tests`)
- NEVER deploy from dirty working tree without warning
- Show summary before deploying: branch, env, target, version
- If deploy target can't be detected, ask the user
