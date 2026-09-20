# Echolet CLI: npm package, ~/.echolet storage and deployment

Status: draft
Source: user description / docs/requirements/echolet-cli/

## Problem
Currently, deploying and using Echolet requires cloning the repository and manual developer operations. Setting up user identities, storing keys securely across multiple stations, launching web interfaces, and running a self-hosted repeater need a turnkey, globally installable package (\`npm install -g echolet\`).

## Expected Outcome
1. Globally installable NPM package \`@echolet/cli\` / \`echolet\` exposing the \`echolet\` binary.
2. Isolated storage engine in \`~/.echolet/\` with \`0700\`/\`0600\` permissions.
3. Operator CLI suite: \`station\` (setup, start, stop, status, open), \`repeater\` (setup with Docker default, start, stop, status, logs), \`profile\` (list, switch, export, delete), \`contact\` (list, add, verify).
4. Layered Dispatcher ensuring all 8 existing protocol commands and 79 Vitest suites remain 100% working.
5. Dynamic resolution (\`ECHOLET_CLI_PATH\`) in \`apps/web/src/server/cliBridge.ts\` so web stations run out of flat NPM installs.
6. Cross-platform background daemon management (Unix signals + Windows \`taskkill\`).

## Out of Scope
- Mobile client app changes.
- Modifications to core cryptographic algorithms (Double Ratchet, Ed25519/X25519).
- Modifying the underlying protocol command signatures or formats.
