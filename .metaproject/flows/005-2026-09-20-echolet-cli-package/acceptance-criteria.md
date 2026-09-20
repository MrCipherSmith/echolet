# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: Global paths module manages ~/.echolet with 0700 directory permissions and 0600 for store.key files.
- AC2: Daemon lifecycle manager supports start/stop/status with PID files and cross-platform process termination (SIGTERM on Unix, taskkill on Windows).
- AC3: CLI Layered Dispatcher intercepts station, repeater, profile, contact commands while preserving 100% of the existing protocol commands and tests.
- AC4: apps/web/src/server/cliBridge.ts resolves CLI via ECHOLET_CLI_PATH and fallback cascading paths.
- AC5: echolet station setup and start run interactive profile creation and launches the web client.
- AC6: echolet repeater setup configures local repeater defaulting to Docker container deployment.
- AC7: All 79 existing Vitest test suites in apps/cli continue to pass without error.
- AC8: Package builds and prepares web-dist and dist files for NPM publishing.
