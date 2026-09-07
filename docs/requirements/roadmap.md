# Requirements Package Roadmap
Version: 0.1.0

## Purpose

This index tracks implementation-facing requirements packages. It complements the broader [Echolet roadmap](../PLAN-05_ROADMAP.md); package status describes documentation maturity, not runtime completion.

## Packages

| Package | Status | Capability | Runtime state |
|---|---|---|---|
| [Echolet CLI prototype](echolet-cli-prototype/README.md) | spec ready | Two computer clients exchange encrypted text through the local relay and recover after restart | Partially implemented prerequisites; CLI, relay v2 allocation, and end-to-end flow are planned |

## Ordering

Implement the CLI prototype before returning to mobile delivery work. It isolates the relay/session integration from mobile platform constraints and provides a reproducible proof that two independent persisted clients can communicate.
