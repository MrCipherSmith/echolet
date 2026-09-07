# Echolet CLI Prototype Runbook
Version: 0.1.1

Copyable commands for reproducing the computer CLI prototype from a clean
checkout. This is the manual reproduction that
[metrics-and-validation.md](metrics-and-validation.md) requires; every command
below was executed against the real relay binary and the real `dist/cli.js`, and
the observed output is quoted as-is.

`RUNBOOK-22_DEMO_DAY.md` describes a different, unbuilt product — the mobile MVP
with QR contact exchange on emulators or devices. It does not apply here.

## Prerequisites

- **Node 22.13+.** Node 22.12 lacks `node:sqlite`; under it most CLI suites fail
  to collect in a way that looks exactly like broken code. Verified on 26.5.0.
- Go 1.26+, pnpm 10+.
- `pnpm install --frozen-lockfile` and `pnpm --filter @echolet/cli build` once.

## 1-3. Directories, keys, relay

Each profile owns an encrypted database whose 32-byte key lives only in the
environment — never in the profile directory and never printed by a command.

```sh
D=$(mktemp -d /tmp/echolet-demo-XXXXXX)
P=$PWD                                    # repository root
CLI="$P/apps/cli/dist/cli.js"
PORT=18099; URL="http://127.0.0.1:$PORT"
export AKEY=$(node -e 'process.stdout.write(require("crypto").randomBytes(32).toString("base64url"))')
export BKEY=$(node -e 'process.stdout.write(require("crypto").randomBytes(32).toString("base64url"))')

GOCACHE="$P/.gocache" go -C "$P/apps/relay" build -o "$D/relay" ./cmd/relay
ECHOLET_HTTP_ADDR="127.0.0.1:$PORT" ECHOLET_DATA_DIR="$D/relay-data" "$D/relay" >"$D/relay.log" 2>&1 &
curl -s "$URL/health"
```

```json
{"ok":true,"data":{"status":"healthy","uptime_ms":180}}
```

Two shell helpers keep the rest readable. Every invocation is a **separate
process**, so every step below also exercises restart recovery:

```sh
a() { ECHOLET_E2E_KEY="$AKEY" node "$CLI" "$@" --profile "$D/alice" --json; }
b() { ECHOLET_E2E_KEY="$BKEY" node "$CLI" "$@" --profile "$D/bob"   --json; }
```

## 4. Initialize both profiles and exchange contact cards

```sh
a init --relay-url "$URL" --store-key-env ECHOLET_E2E_KEY
b init --relay-url "$URL" --store-key-env ECHOLET_E2E_KEY
a contact export --out "$D/alice-card.json"
b contact export --out "$D/bob-card.json"
a contact import --from "$D/bob-card.json"   --yes
b contact import --from "$D/alice-card.json" --yes
```

Import prints the four identifiers the specification requires a human to check
before trust is recorded, and is the **only** operation that creates Echolet
trust. Ciphertext arriving later never creates or replaces it:

```json
{"identity_id":"hbRYeNqVnWC74METcY57-eDEk-V9qNQ6Qzuz6RpsIYQ",
 "device_id":"733d80b0-e7e2-5e6c-ba84-0bcd96a373ea",
 "device_pubkey":"nps4f_aW9mNX62tZs5M0oqAWtn05cWtn9gCw0gM1JHA",
 "signal_identity_key":"BQdNjP6tbN00N3eS6DNpmKp_MDFDeDa4MFuUO1QW-t8i"}
```

Drop `--yes` to confirm interactively; the prompt settles on a completed line.

Capture the identity ids for the messaging steps:

```sh
BID=$(node -e "process.stdout.write(JSON.parse(require('fs').readFileSync('$D/bob-card.json','utf8')).signal_bundle.device_record.identity_id)")
AID=$(node -e "process.stdout.write(JSON.parse(require('fs').readFileSync('$D/alice-card.json','utf8')).signal_bundle.device_record.identity_id)")
```

## 5. Publish both bundles

```sh
a relay publish
b relay publish
```

```json
{"ok":true,"data":{"stored":true,"bundleId":"1e8648b5-43cc-4a77-981a-de491e7b0cc4","claimable":true}}
```

`claimable` reports whether the published bundle can still be claimed. A
republish after the bundle has been claimed answers `claimable: false` rather
than a bare success — see the limitation in §11.

## 6. Offline delivery

Bob simply does not poll. Nothing else is required to make him "offline".

```sh
a send --to "$BID" --text "Привет, Боб. Это первое сообщение через Echolet."
b poll
```

```json
{"ok":true,"data":{"messageId":"4ba942f0-...","envelopeId":"94a6f678-...","status":"delivered"}}
{"ok":true,"data":{"received":1,"more":false,"rejected":[]}}
```

`more` is the relay's remaining-work signal; `rejected` carries only
`{envelopeId, code}` for envelopes that were permanently unacceptable, so one bad
envelope cannot block the rest of the batch.

## 7. Reply

```sh
b send --to "$AID" --text "Привет, Алиса. Ответ получен и расшифрован."
a poll
```

## 8. Ambiguous send and byte-identical exact retry

Supply `--message-id` and repeat the command. This is what a client does when it
never learned whether the first send arrived:

```sh
MID=$(node -e 'process.stdout.write(require("crypto").randomUUID())')
a send --to "$BID" --text "RETRY_PROOF пример сообщения" --message-id "$MID"
a send --to "$BID" --text "RETRY_PROOF пример сообщения" --message-id "$MID"
```

Both answer with the **same `envelopeId`** — the stored ciphertext is replayed,
not re-encrypted:

```json
{"ok":true,"data":{"messageId":"0dea9038-...","envelopeId":"56ddfb4c-4e69-487b-b005-6559db27df7c","status":"delivered"}}
{"ok":true,"data":{"messageId":"0dea9038-...","envelopeId":"56ddfb4c-4e69-487b-b005-6559db27df7c","status":"delivered"}}
```

The receiver deduplicates, and a second poll finds nothing:

```sh
b poll   # {"received":1,...}
b poll   # {"received":0,...}
```

## 9. Histories and message-id comparison

```sh
a history --with "$BID"
b history --with "$AID"
```

The same `messageId` appears as `outbound` on one side and `inbound` on the
other, with matching sequences. Plaintext is readable **only** here, on the
owner's explicit request; it never crosses the relay API.

## 10. Confirm the relay never saw the plaintext

```sh
grep -rl "первое сообщение" "$D/relay-data" | wc -l   # 0
grep -c  "первое сообщение" "$D/relay.log"            # 0
```

## Failure paths worth demonstrating

An unknown sender is refused with a typed error and exit 3, without touching the
recipient's state:

```sh
export CKEY=$(node -e 'process.stdout.write(require("crypto").randomBytes(32).toString("base64url"))')
ECHOLET_E2E_KEY="$CKEY" node "$CLI" init --relay-url "$URL" --store-key-env ECHOLET_E2E_KEY --profile "$D/carol" --json
ECHOLET_E2E_KEY="$CKEY" node "$CLI" send --to "$BID" --text "unsolicited" --profile "$D/carol" --json
```

```json
{"ok":false,"error":{"code":"CONTACT_NOT_TRUSTED"}}
```

Exit codes: `0` success, `2` input/configuration, `3` trust/protocol, `4`
temporary relay/network, `5` local persistence.

## Serving HTTPS (required for any non-loopback relay)

Everything above runs on loopback plain HTTP, which the CLI accepts. It refuses a
**non-loopback** relay URL that is not HTTPS (§Configuration in
[specification.md](specification.md)), so a relay reachable from another machine
must terminate TLS. The relay reads a certificate pair from disk; it never
requests, renews or generates one.

| Variable | Meaning |
|---|---|
| `ECHOLET_TLS_CERT_FILE` | PEM certificate chain |
| `ECHOLET_TLS_KEY_FILE` | PEM private key for that certificate |
| `ECHOLET_TLS_RELOAD_INTERVAL_SECONDS` | how often a handshake may re-read the pair to notice a renewal (default `60`, `0` = every handshake) |
| `ECHOLET_HTTP_ADDR` | the one listen address, for HTTPS as well as HTTP |

**Both or neither.** Setting exactly one, or pointing either at a file that is
missing, malformed or mismatched, makes the relay exit non-zero at startup with
the offending variable or path named. It never falls back to plain HTTP: a relay
that came up unprotected after the operator asked for TLS would look healthy
while carrying every envelope in the clear.

On the tailnet the pair comes from `tailscale cert`, which issues a real Let's
Encrypt certificate for a MagicDNS name with no public DNS record and no inbound
port opened:

```sh
sudo tailscale cert --cert-file /etc/echolet/cert.pem --key-file /etc/echolet/key.pem <host>.<tailnet>.ts.net
sudo chmod 600 /etc/echolet/key.pem
ECHOLET_HTTP_ADDR="0.0.0.0:8443" \
ECHOLET_TLS_CERT_FILE=/etc/echolet/cert.pem \
ECHOLET_TLS_KEY_FILE=/etc/echolet/key.pem \
ECHOLET_DATA_DIR=/var/lib/echolet ./relay
```

Clients then use `--relay-url https://<host>.<tailnet>.ts.net:8443`. The
certificate must be issued for the **name the client dials**; an IP address in the
URL will not match a MagicDNS certificate.

**Renewal needs no restart.** Re-running `tailscale cert` (or a timer that does)
rewrites the two files in place; the running relay notices the new bytes — by
content digest, not modification time — and serves the renewed certificate. If a
read lands mid-rewrite the last good pair keeps serving and a warning is logged,
so a renewal cannot become an outage. Only the two paths are ever logged, never
the contents.

For a local HTTPS run without Tailscale, the relay module ships a self-signed
generator for development and tests only:

```sh
go -C apps/relay run ./internal/devcert/gencert --out /tmp/echolet-tls --hosts localhost,127.0.0.1
```

## 11. What this runbook does not establish

Reproducing every step above demonstrates the local computer technical
prototype and nothing more. It does not establish production security, safe use
for sensitive communication, mobile delivery, deployment readiness, an
independent cryptographic audit, user demand, or permanent suitability of the
pinned `@signalapp/libsignal-client@0.102.0`.

Two limitations are visible from this runbook and are documented rather than
fixed:

- **One published bundle serves exactly one first-contact sender.** After a
  first sender claims a recipient's bundle, a second distinct sender receives
  `PREKEY_BUNDLE_UNAVAILABLE`, and a republish reports `claimable: false`.
  Explicit rotation exists in the runtime but has no CLI entry point, which is a
  deliberate frozen-surface decision.
- **The mailbox flooding class is closed for delivery as a bound, not
  eliminated as an attack.** Re-measured on the real relay at commit `c302485`
  by the flow 002 verification: 4 self-published identities and 49
  maximum-size envelopes (12.23 MB over 53 requests) no longer wedge the
  mailbox — the legitimate message is delivered in 2 polls / 17 pages, and
  three ordinary polls afterwards cost 4 pages. The attacker can still publish
  identities and enqueue the envelopes, because device-record publication is
  itself unauthenticated, and the recipient still pays that walk **once**; what
  is closed is the amplification across polls. Relay disk consumption is still
  unbounded (`ECHOLET_MAX_STORAGE_BYTES` is enforced nowhere).

See [STATUS_CURRENT.md](../../STATUS_CURRENT.md) and the flow's final change
report for the complete list.
