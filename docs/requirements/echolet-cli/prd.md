# Echolet CLI PRD
Version: 1.0.0

## Problem
Currently, setting up an Echolet station or a repeater requires cloning the repository, installing dependencies, and running developer scripts. This poses a high barrier to entry for end users who want a secure, private communication tool without needing to be developers.

## Goal
Transform Echolet into a globally installable CLI application via NPM, providing intuitive commands for users to generate cryptographic profiles, launch a local web client, manage contacts, and easily deploy a private repeater (via Docker or Tailscale) with zero manual configuration.

## Users
- Privacy-conscious individuals needing secure comms.
- Node.js/NPM users comfortable with basic CLI tools.
- Operators who want to host a private repeater for their friends/family.

## Requirements
1. **Global Installation**: Must be installable via `npm install -g echolet`.
2. **Secure Defaults**: All data must reside in `~/.echolet` with `0700` permissions. Master keys must have `0600` permissions.
3. **Operator CLI**: Must provide high-level commands for station setup, profile management, and contact verification.
4. **Repeater Deployment**: Must offer an interactive setup wizard that defaults to Docker (so Go is not required for NPM users).
5. **Backward Compatibility**: Existing protocol commands and Vitest tests must remain untouched.

## Success Criteria
- A user can install Echolet, create a profile, and start the web UI using fewer than 3 commands.
- The 79 existing CLI tests pass without modification.
- A user can deploy a repeater securely via Docker with a single command.

## Risks
- **NPM Path Resolution**: Flat installation might break relative paths (e.g., `cliBridge.ts` looking for `../../cli/dist/cli.js`).
- **Platform Differences**: Node's daemon process management and signal sending (`SIGTERM`) differ between Unix and Windows.

## Recommendation
Implement a Layered Dispatcher in the CLI to preserve the old protocol parser, update `cliBridge.ts` to use cascading resolution (`ECHOLET_CLI_PATH`), and use `taskkill` on Windows for stopping background services. Bundle web assets securely in the NPM package.
