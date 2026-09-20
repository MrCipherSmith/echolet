# Echolet CLI Package
Version: 1.0.0

## Purpose
This package defines the requirements, architecture, and specifications for the global `echolet` CLI, enabling users to easily install, configure, and manage Echolet stations and repeaters via NPM.

## Status
Status: spec ready

## Document Index
- [README.md](./README.md) - This document.
- [prd.md](./prd.md) - Product Requirements Document.
- [specification.md](./specification.md) - Technical architecture and CLI specifications.

## Scope
- Global CLI installation via NPM (`npm install -g echolet`).
- Secure storage architecture in `~/.echolet/` (0700 permissions).
- High-level operator commands (`station`, `repeater`, `profile`, `contact`).
- Layered Dispatcher for backward compatibility with protocol commands.
- Deployment of Echolet repeater (Docker as default, Tailscale Mesh).

## Non-goals
- Changes to the core Double Ratchet cryptographic implementation.
- Breaking changes to existing protocol commands (`init`, `send`, `poll`, `history`).

## Related Modules
- `apps/cli` - The core CLI implementation.
- `apps/web` - The React web client.
- `apps/relay` - The Go-based repeater/relay server.
