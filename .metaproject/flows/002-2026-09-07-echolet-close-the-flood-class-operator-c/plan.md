# Implementation plan

Three waves, in an order the user fixed: nothing becomes reachable from outside
its host until the flooding class is closed and TLS is in place.

## Wave 1 — close the flood class

The mechanism, established by measurement in flow 001: permanently-unacceptable
envelopes at the head of a mailbox fill every page of the client's **bounded
16-page** drain walk, so a legitimate message behind them is never reached and
expires. The per-sender quota of 16 bounds one identity, but identities are free,
so 4 of them still fill the walk.

Candidate closures, to be judged by a design task before anything is written:

1. **Make the drain walk cover the mailbox rather than a fixed 16 pages.** If the
   client can always walk to the end, poison cannot hide a legitimate message —
   it only costs the recipient extra round-trips. Combined with the existing
   per-sender quota this converts a delivery-blocking attack into a bandwidth
   one, and messages still arrive. This is the cheapest candidate and touches no
   trust model.
2. **Make identity minting costly** — proof-of-work on `/v1/device-records/publish`.
   IP rate-limiting alone is not a closure: it is bypassed by changing address.
   Note the cost also falls on every legitimate first-time user.
3. **Recipient authorisation** — the relay accepts envelopes only from senders
   the recipient allowed. Closes the class completely and matches the product's
   own mutual-contact model, but the relay learns the contact graph, which
   contradicts SEC-01.

The design task must pick one with reasons, state what it does *not* close, and
be measured against the same probe that produced the 4-identity / 49-envelope
figure. A closure that only moves the number is a bounded mitigation and must be
reported as such, exactly as the last round was.

## Wave 2 — TLS and the operator console

4. Serve non-loopback relay URLs over HTTPS. The CLI already refuses plain HTTP
   for non-loopback hosts, so this is a precondition for any remote relay, not a
   nicety.
5. Build the operator console: a local web UI over the local CLI. It shows
   profiles, contacts, outbox and inbox state, history, rejected envelopes and
   relay health, and can drive `init`, `contact`, `relay publish`, `send` and
   `poll`. It runs on the operator's machine, invokes the same `dist/cli.js`, and
   never receives, stores or transmits a store key or private key.
6. The console states on its own surface that this is an unaudited prototype.
   A document nobody opens is not a warning.

## Wave 3 — deployment

7. Stand up two relay instances on the user's servers with TLS, bounded
   retention and the configuration recorded rather than typed from memory.
8. Verify from a third machine that the CLI completes the full acceptance
   scenario against a remote relay — contact exchange, publish, offline delivery,
   reply, exact retry, deduplication — and that the flooding probe now fails.
9. Write the deployment runbook alongside the existing reproduction runbook.

## Alternatives rejected

A browser client holding keys server-side was rejected by the user: it would
make the relay able to read all traffic, which is the opposite of what the
prototype demonstrates. A libsignal-WASM browser client was rejected for this
wave as a multi-day rebuild of the client and its entire evidence base.
