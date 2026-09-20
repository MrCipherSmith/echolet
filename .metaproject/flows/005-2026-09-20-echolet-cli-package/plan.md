# Plan

## Phases & Strategy

### Phase 1: Core Storage & Daemon Runtime (Parallelizable)
- Task T1: Implement \`apps/cli/src/runtime/globalPaths.ts\` for \`~/.echolet\` hierarchy, profile resolution, and permission enforcement (0700/0600).
- Task T2: Implement \`apps/cli/src/runtime/daemon.ts\` for PID-based background daemon execution, logging, and cross-platform termination (Unix/Windows).
- Task T3: Update \`apps/web/src/server/cliBridge.ts\` to support \`ECHOLET_CLI_PATH\` environment variable and cascading resolution.

### Phase 2: Operator Command Modules (Parallelizable)
- Task T4: Implement \`apps/cli/src/operator/profile.ts\` for profile listing, switching, export, and deletion.
- Task T5: Implement \`apps/cli/src/operator/contact.ts\` for contact listing, card addition, and verification.
- Task T6: Implement \`apps/cli/src/operator/station.ts\` for station interactive setup, start/stop/status/open.
- Task T7: Implement \`apps/cli/src/operator/repeater.ts\` for repeater Docker/Native setup, start/stop/status/logs.

### Phase 3: Layered Dispatcher & CLI Integration
- Task T8: Wire up Layered Dispatcher in \`apps/cli/src/commands/cli.ts\` preserving protocol commands and testing backwards compatibility.

### Phase 4: NPM Packaging & Verification
- Task T9: Configure \`apps/cli/package.json\` with binary definition, build scripts, web-dist bundling, and run full Vitest verification suite.

## Model Adaptability
- Subagents for T1, T2, T3: \`flash\` (Fast, highly accurate for scoped filesystem/runtime modules).
- Subagents for T4, T5, T6, T7: \`flash\` (Fast, interactive operator logic).
- Subagent for T8 (Layered Dispatcher): \`pro\` / \`inherit\` (High reasoning needed to avoid breaking 79 strict Vitest suites).
- Verification & Review: \`inherit\`.
