# Acceptance criteria

- AC1: The flooding closure is chosen by a written design task that names what it closes, what it does not close, and why the alternatives were rejected.
- AC2: Against the real relay binary, the probe that previously wedged a mailbox with 4 self-published identities and 49 maximum-size envelopes no longer prevents delivery of a legitimate message, and the new attacker cost is measured and stated. If the result is a bound rather than a closure, it is reported as a bound and not as a fix.
- AC3: A legitimate two-party exchange, offline delivery, byte-identical exact retry and deduplication all still pass on the real relay after the change, with no pre-existing test weakened, skipped or deleted.
- AC4: A relay reachable on a non-loopback address serves HTTPS, and the CLI completes the full acceptance scenario against it from a different machine.
- AC5: The operator console drives a local CLI, shows profiles, queues, history, rejections and relay health, and never receives, stores or transmits a store key or private key material. This is demonstrated by evidence, not asserted.
- AC6: The console displays, on its own surface, that this is an unaudited prototype not suitable for sensitive communication.
- AC7: Two relay instances run on the user's servers, and a deployment runbook reproduces them from a clean host.
- AC8: Documentation states what remains untrue after this flow: no independent cryptographic audit, no mobile client, no user-demand evidence.
