# Echolet Documentation Index

This repository's project documentation is stored in `docs/`.

Start with [current readiness](STATUS_CURRENT.md). Specifications describe target behavior; they do not certify that behavior is implemented.

## Source of truth

- Current implementation readiness and dated evidence: [STATUS_CURRENT](STATUS_CURRENT.md).
- MVP transport and dependency decisions: [STACK-14](STACK-14_TECH_DECISIONS.md).
- Wire contracts and authentication: [PROTOCOL-07](PROTOCOL-07_MVP_MESSAGE_FLOW.md) and [API-11](API-11_JSON_SCHEMAS.md); both must stay synchronized with client and relay code.
- Security boundaries: [THREAT-08](THREAT-08_MODEL.md) and [SEC-01](SEC-01_IDENTITY.md).
- Product validation gates: [PILOT-29](PILOT-29_VALIDATION_PLAN.md).
- Active remediation: [flow 001](../.metaproject/flows/001-2026-09-05-echolet-assessment-fixes/description.md).

If documents conflict, record the conflict and verify the owning contract or implementation. Do not silently treat a plan or historical PASS as runtime evidence.

## Core specifications

- `SEC-01_IDENTITY.md` - identity, authentication, and security rules
- `PROTOCOL-07_MVP_MESSAGE_FLOW.md` - MVP protocol flows and message lifecycle
- `API-11_JSON_SCHEMAS.md` - JSON schemas and API contracts
- `ARCH-09_REPOSITORY_STRUCTURE.md` - repository layout and module boundaries
- `THREAT-08_MODEL.md` - threat model and security assumptions

## Product and implementation planning

- `PLAN-05_ROADMAP.md` - roadmap and milestone direction
- `DELIVERY-13_SPRINT_PLAN.md` - milestone plan and delivery gates
- `TASKS-10_IMPLEMENTATION_BACKLOG.md` - implementation backlog
- `TASKPACK-19_FIRST_30_TASKS.md` - first implementation task pack
- `TASKPACK-20_NEXT_30_TASKS.md` - second implementation task pack
- `TASKPACK-21_FINAL_MVP_TASKS.md` - final MVP task pack
- `BOARD-27_EXECUTION_ORDER.md` - recommended execution order

## Runtime and operational guides

- `BOOTSTRAP-15_REPO_INIT_GUIDE.md` - local bootstrap and repository setup
- `OPS-23_LOCAL_ENV_VARS.md` - local environment variables and config
- `RUNBOOK-22_DEMO_DAY.md` - demo-day sequence and checks
- `TEST-16_ACCEPTANCE_CHECKLIST.md` - acceptance checklist
- `CHECK-26_SECURITY_REVIEW_SCRIPT.md` - security review steps before demo

## Supporting references

- `APP-03_MOBILE_CLIENT.md` - mobile client specification
- `REP-02_REPEATER_NODE.md` - relay/repeater specification
- `STACK-14_TECH_DECISIONS.md` - locked tech decisions
- `RFC-18_CRYPTO_SELECTION.md` - crypto library selection notes
- `TECH-06_ADDENDUM.md` - technical addendum
- `STORY-04_USER_SCENARIOS.md` - user stories and UX flows
- `TRACE-25_REQUIREMENTS_MATRIX.md` - requirements traceability matrix
- `PROMPTS-17_AGENT_PROMPTS.md` - prompt pack for execution workflows
- `PLAYBOOK-12_WEAK_MODEL_EXECUTION.md` - execution playbook for weak models
- `CHANGE-24_SPEC_CHANGE_CONTROL.md` - spec change control

## Status snapshots

- `STATUS.md`
- `STATUS_CURRENT.md`
- `STATUS_FINAL.md`
- `STATUS_IMPLEMENTATION.md`
- `STATUS-28_MVP_PROGRESS_TEMPLATE.md`

- Signal wire v2 и цепочка доверия: [PROTOCOL-30](PROTOCOL-30_SIGNAL_BUNDLE_V2.md).
