# Development demo containment

Date: 2026-09-06. Authorized by user request to fix assessment findings.

## Problem
Mobile imports simplified sessions directly and labels itself a secure messenger. Sessions are memory-only; static bootstrap and reset can repeat message key material. This is not a production ratchet.

## Change
Prevent mounting the demo messaging component except in a development build with explicit EXPO_PUBLIC_ECHOLET_ENABLE_UNSAFE_DEMO=true. Missing build flag fails closed. Display a persistent demo-only explanation when enabled; release builds cannot enable it through env alone. Rename product readiness labels. Preserve demo source without modifying crypto internals.

## Acceptance
- Release/unknown build denies demo even if opt-in is true.
- Development without explicit true opt-in denies demo.
- Only development plus explicit opt-in mounts demo and displays warning.
- Full typecheck and existing tests continue passing.

## Verification
Vitest server rendering with mocked native primitives verifies the actual MessagingScreen entry under environment combinations. This is a component gate test, not real-device or crypto validation.
