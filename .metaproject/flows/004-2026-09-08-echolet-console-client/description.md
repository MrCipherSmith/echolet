# Echolet: the console becomes a client

## What the user asked for

To register and write to someone — "прям зарегистрироваться, и написать кому-то" — using the console as a real client, with convenient registration, correspondence, and an address book. They have a live prototype: two relays on the tailnet serving real TLS, and a second user simulated in a container on `depr`.

## Why it does not work today

The console can observe a profile and cannot be used to do any of it:

- **Registration** is four separate CLI invocations plus a card file exchanged by hand, none of which the console can start.
- **Sending** does not exist in the console at all. The bridge that would spawn it puts the plaintext body in the child's argv (`cli-bridge.ts:90`, `"--text", request.text`), where `ps` shows it to every process on the machine.
- **The address book** does not exist. Contacts live in the profile, and the console has no key to read the store, so it cannot enumerate them without the CLI's help.

## Scope

A computer CLI prototype. Not a mobile app, not a production messenger, not an audited system. No relay change, no wire-format change, no protocol schema change.

## The design this wave implements

`t35-console-client-design.md` in flow 003. It costs two things deliberately, and one is held for the user:

1. **`send` takes the body on stdin** instead of `--text`. This removes plaintext from argv, which is a strengthening, and changes a shipped command's interface, which is a cost.
2. **`doctor` enumerates correspondents**, because the console cannot read the store itself and must not hold the key.
3. **Held, not decided:** the design proposes removing two panes (`health`, `rejections`) and one key. That is a removal of function and belongs to the user, not to this flow. Nothing in the acceptance criteria depends on it.

## What must not be lost

Everything flows 002 and 003 paid for, listed in AC6, plus a new one the design supplies: operator-typed bytes enter a frame for the first time, and the guarantee that no escape sequence can reach a frame must survive that.
