# Close the flood class, add an operator console, deploy two relays

## Problem

Flow 001 delivered a verified local CLI prototype but left one class open by an
explicit, measured decision: the mailbox flooding wedge is **bounded, not
eliminated**. On the real relay at default configuration, 4 self-published
identities and 49 maximum-size envelopes (~12.85 MB, under 30 s, inside the
120/min rate limit) wedge a recipient's mailbox for up to the 168 h retention
cap, needing only the victim's mailbox id. The root enabler is that
`POST /v1/device-records/publish` is itself unauthenticated, so an identity costs
one free request.

On loopback that is academic. The user now wants relays running on two servers
and a web surface for testing, which makes it live: anyone who learns a mailbox
id could deny delivery to that recipient for a week.

## Expected outcome

1. The flooding class is closed — not bounded further — and the closure is
   measured on the real relay binary, not argued.
2. Non-loopback relay URLs are served over HTTPS, as the specification already
   requires and the current deployment does not provide.
3. An operator console gives a browser view over a **local** CLI: profiles,
   queues, history, rejections and relay health, for driving and observing the
   prototype during testing.
4. Two relay instances run on the user's servers, reachable by the console and
   the CLI, with a recorded runbook for standing them up again.

## Scope

Relay authorisation and abuse resistance, TLS termination, a local operator
console, and deployment of two relay instances to servers the user controls.

## Out of scope

- Mobile applications; `apps/mobile` stays as it is.
- A browser messaging client. The console drives a local CLI and never holds or
  transports key material — the decision recorded on 2026-09-07 was explicitly
  an operator console rather than a server-side-keys web client, because the
  latter would destroy the end-to-end property the prototype exists to show.
- Public launch, marketing, onboarding of people outside a known test group.
- An independent cryptographic audit. Deploying to servers does not create one,
  and nothing in this flow may be reported as if it did.

## Constraints

- **Order is fixed by user decision:** close the flood class and enable TLS
  before any relay becomes reachable from outside the machine it runs on.
- The prototype remains unaudited. Every participant in testing must be told
  that in the console itself, not only in a document.
- `@signalapp/libsignal-client@0.102.0` and `node:sqlite` are native to Node, so
  no browser can run the client crypto. That is why the console is a console.
- Server credentials are never pasted into the assistant's context. Access is by
  SSH key already present on the operator's machine.
