# T11 — TLS report: `depr` serves HTTPS on its tailnet address, and AC4 is established

Date: 2026-09-07 (19:29–19:45 UTC)
Source tree: `4346e2b`, clean. No source, test or committed deployment artifact was changed.
Relay image: unchanged — `echolet-relay:20260907-a2f07bb`, the image already on the host.
Scope: **write**, on `depr` only. One certificate pair, one directory (`/etc/echolet/tls`),
one non-committed env file (`~/echolet-deploy/env/depr.env`) and one container replacement.
`geekom` was not touched in any way — not written, not read, not probed.

---

## 0. The headline

| | before | after |
|---|---|---|
| Published on | `127.0.0.1:8443` | **`100.100.188.64:8443`** (`depr`'s tailnet IPv4) |
| Scheme, as the relay states it | `scheme=http tls_cert_file="" tls_key_file=""` | **`scheme=https tls_cert_file=/etc/echolet/tls/cert.pem tls_key_file=/etc/echolet/tls/key.pem`** |
| `echolet.tls` label | `disabled-insecure-loopback-only` | **`enabled`** |
| Reachable from this Mac | no — connection refused | **yes — `https://depr.tail5a88fb.ts.net:8443/health` = 200, `ssl_verify_result=0`, no `-k`** |
| Certificate | none | **Let's Encrypt, CN=`depr.tail5a88fb.ts.net`, issuer `C=US, O=Let's Encrypt, CN=YE2`, valid `Sep 7 18:35:38 2026 GMT` → `Dec 6 18:35:37 2026 GMT`** |
| Data | volume `echolet-relay-data` | **the same volume, same mountpoint, not recreated** |
| Committed artifacts sufficient? | — | **`run-relay.sh`: yes, unmodified. `docker-compose.yml`: NO — see §3.2** |
| Full acceptance scenario from this Mac over HTTPS | not possible | **passed, every step** |
| **AC4** | blocked | **met — §8** |

`tailscale status --json` on `depr` reports `CertDomains: ["depr.tail5a88fb.ts.net"]`.
Deployment-runbook §3.1, the blocker for this whole flow, is satisfied.

---

## 1. Before state, captured before anything was touched

```
id=0979ea6dcd952585e765facd7f9486e82c07be4753944e1c5ec6b9ac9d2164af
image=echolet-relay:20260907-a2f07bb
imageid=sha256:83497194b1e213f5b6cc795d0ff5eafdb33e0101579b7295fadad04ac0d077c4
started=2026-09-07T18:37:37.879980178Z
restarts=0
health=healthy
status=running
labels={"echolet.tls":"disabled-insecure-loopback-only", …}
mounts=[{"Destination":"/var/lib/echolet","Name":"echolet-relay-data","Source":"/var/lib/docker/volumes/echolet-relay-data/_data","Type":"volume","RW":true}]
ports={"8443/tcp":[{"HostIp":"127.0.0.1","HostPort":"8443"}]}
```

```
echolet-relay  echolet-relay:20260907-a2f07bb  Up 52 minutes (healthy)  127.0.0.1:8443->8443/tcp
LISTEN 0 4096 127.0.0.1:8443 0.0.0.0:*
{"ok":true,"data":{"status":"healthy","uptime_ms":3129371}}
time=2026-09-07T18:37:38.066Z level=INFO msg="Starting relay server" addr=0.0.0.0:8443 scheme=http tls_cert_file="" tls_key_file=""
```

| | value |
|---|---|
| Volume | `echolet-relay-data` → `/var/lib/docker/volumes/echolet-relay-data/_data`, created `2026-09-07T17:34:43Z`, `Labels: null` |
| Images on host | `echolet-relay:20260907-a2f07bb`, `echolet-relay:20260907-c302485-dirty` (rollback) |
| Totals (stray baseline) | 8 containers, 4 volumes, 0 dangling |
| `/etc/echolet` | absent |
| `/var/lib/echolet` | absent |
| `~/echolet-deploy` | present, from the upgrade task |
| `sudo -n` | passwordless, confirmed |
| `tailscale ip -4` | `100.100.188.64` |
| Docker / compose | `29.1.3` / `2.40.3+ds1-0ubuntu1~24.04.1` |
| **`CertDomains`** | **`["depr.tail5a88fb.ts.net"]`** |

The host's copy of the deployment tree is byte-identical to the repository's, so
what ran on `depr` is exactly the committed artifact:

```
b9140d0476745b9c84ed85a0e72ec027db78c37af41f6269ffe5bbacdcdc6eb4  deploy/relay/run-relay.sh          (repo)
b9140d0476745b9c84ed85a0e72ec027db78c37af41f6269ffe5bbacdcdc6eb4  ~/echolet-deploy/run-relay.sh      (depr)
70c857a7c960c33411bee060ccb6c0da7545a3fa0caf9752bb58b5a191976f63  docker-compose.yml                 (both)
ba09148ced7fd5397b0027663ee3c9d84a08b5011182db2dcd821c5067c05263  env/depr.env.example               (both)
```

---

## 2. The certificate

Issued **once**. No speculative issuance, no retry, no second certificate for the
same name.

```sh
# on depr, as ubuntu (passwordless sudo)
sudo mkdir -p /etc/echolet/tls
sudo tailscale cert \
  --cert-file /etc/echolet/tls/cert.pem \
  --key-file  /etc/echolet/tls/key.pem \
  depr.tail5a88fb.ts.net

sudo chown 10001:10001 /etc/echolet/tls/cert.pem /etc/echolet/tls/key.pem
sudo chmod 0644 /etc/echolet/tls/cert.pem
sudo chmod 0600 /etc/echolet/tls/key.pem
```

```
Wrote public cert to /etc/echolet/tls/cert.pem
Wrote private key to /etc/echolet/tls/key.pem
cert_exit=0

-rw-r--r-- 1 10001 10001 4833 Sep  7 19:34 cert.pem
-rw------- 1 10001 10001  227 Sep  7 19:34 key.pem
```

Exactly the ownership and modes deployment-runbook §4 prescribes: readable by the
container's uid 10001 **by ownership**, and the key not world-readable.

### Public metadata (the key itself is never read, printed, copied or committed)

```
subject=CN = depr.tail5a88fb.ts.net
issuer=C = US, O = Let's Encrypt, CN = YE2
notBefore=Sep  7 18:35:38 2026 GMT
notAfter=Dec  6 18:35:37 2026 GMT
serial=0583D38AB74143B5369C686A76F9F923A7D2
X509v3 Subject Alternative Name: DNS:depr.tail5a88fb.ts.net
chain length: 4 certificates
key type line: -----BEGIN EC PRIVATE KEY-----     (227 bytes, mode 600, owner 10001:10001)
```

**The private key was never displayed, never copied off `depr`, and appears
nowhere in this report or in any scratch file.** Only its size, mode and owner
were recorded, and the single `-----BEGIN EC PRIVATE KEY-----` header line, to
confirm the file is what `tailscale cert` says it is.

---

## 3. The switch — committed artifacts, existing volume

### 3.1 `run-relay.sh` did it, unmodified

The env file (`env/depr.env`, **not committed**, exactly as the template's own
header prescribes) is the committed `env/depr.env.example` with three lines
changed:

```diff
17c17
< ECHOLET_IMAGE=echolet-relay:REPLACE_WITH_BUILT_TAG
---
> ECHOLET_IMAGE=echolet-relay:20260907-a2f07bb
28c28
< ECHOLET_BIND_ADDR=REPLACE_WITH_TAILSCALE_IPV4
---
> ECHOLET_BIND_ADDR=100.100.188.64
42c42
< ECHOLET_HOST_DATA_DIR=/var/lib/echolet
---
> ECHOLET_DATA_VOLUME=echolet-relay-data
```

The first two are the two values §1.1 of the runbook says a host must supply. The
third is the one deviation from the template and it is deliberate: **the existing
state lives in the named volume `echolet-relay-data`**, and the task required it
to survive. `run-relay.sh` accepts exactly one of `ECHOLET_DATA_VOLUME` and
`ECHOLET_HOST_DATA_DIR` and refuses both — so setting the volume and removing the
host path is the supported way to say "TLS, on the volume I already have". No
data was migrated, copied or destroyed.

`--print` first, as the runbook instructs, so the command could be read before
anything ran:

```
docker run -d --name echolet-relay --restart unless-stopped --user 10001:10001 \
  --read-only --tmpfs /tmp:size=16m,mode=1777 --security-opt no-new-privileges:true \
  --cap-drop ALL --log-driver json-file --log-opt max-size=20m --log-opt max-file=5 \
  --label echolet.tls=enabled \
  -p 100.100.188.64:8443:8443 \
  -v /etc/echolet/tls:/etc/echolet/tls:ro \
  -v echolet-relay-data:/var/lib/echolet \
  -e ECHOLET_HTTP_ADDR=0.0.0.0:8443 \
  -e ECHOLET_TLS_CERT_FILE=/etc/echolet/tls/cert.pem \
  -e ECHOLET_TLS_KEY_FILE=/etc/echolet/tls/key.pem \
  -e ECHOLET_TLS_RELOAD_INTERVAL_SECONDS=60 \
  -e ECHOLET_DATA_DIR=/var/lib/echolet -e ECHOLET_LOG_LEVEL=info \
  -e ECHOLET_NODE_CALLSIGN=RPT-DEPR-01 -e ECHOLET_MAILBOX_TTL_HOURS=168 \
  -e ECHOLET_MAX_MESSAGE_BYTES=262144 -e ECHOLET_MAX_MAILBOX_BATCH=100 \
  -e ECHOLET_MAX_UNACKED_ENVELOPES_PER_SENDER=16 -e ECHOLET_RATE_LIMIT_PER_MINUTE=120 \
  -e ECHOLET_CHALLENGE_TTL_SECONDS=60 -e ECHOLET_CLEANUP_INTERVAL_SECONDS=60 \
  -e ECHOLET_MAX_STORAGE_BYTES=2147483648 \
  echolet-relay:20260907-a2f07bb
print_exit=0
```

Then, unmodified:

```sh
cd ~/echolet-deploy && ./run-relay.sh env/depr.env
```

```
==> replacing existing container echolet-relay
7eef4c4e222af88d48823fbddb3de52cd3aaaa18814ee47406bf5d6083611deb
==> started echolet-relay from echolet-relay:20260907-a2f07bb on 100.100.188.64:8443
==> scheme: https. Confirm the relay agrees:
    docker logs echolet-relay | grep 'Starting relay server'
    expect:  scheme=https tls_cert_file=/etc/echolet/tls/cert.pem
run_relay_exit=0
```

The replace path is `docker stop` + `docker rm`, never `rm -v`: the volume is
untouched, and §7 proves it with data rather than with the absence of a flag.

### 3.2 Finding: `docker-compose.yml` **cannot** perform this switch

The compose file hard-requires a host bind mount and has no notion of a named
volume:

```
$ docker compose --env-file env/depr.env -f docker-compose.yml config
error while interpolating services.relay.volumes.[]: required variable
ECHOLET_HOST_DATA_DIR is missing a value: set ECHOLET_HOST_DATA_DIR, e.g. /var/lib/echolet
compose_config_exit=1
```

So of the two committed start artifacts, **only `run-relay.sh` can put a TLS
relay on an existing named volume.** The compose path would require either
editing `docker-compose.yml` (out of scope, and a real change) or migrating the
Badger store from `echolet-relay-data` into `/var/lib/echolet` — i.e. destroying
the continuity this task exists to prove. This is reported, not worked around.
It is the same asymmetry the loopback path already has (`docker-compose.insecure-loopback.yml`
hardcodes the volume); the TLS compose file simply never gained the choice
`run-relay.sh` offers.

---

## 4. After state on `depr`

```
id=7eef4c4e222af88d48823fbddb3de52cd3aaaa18814ee47406bf5d6083611deb
image=echolet-relay:20260907-a2f07bb
imageid=sha256:83497194b1e213f5b6cc795d0ff5eafdb33e0101579b7295fadad04ac0d077c4
started=2026-09-07T19:36:22.318727808Z
restarts=0
health=healthy
status=running
tls_label=enabled
mounts=[{"Destination":"/etc/echolet/tls","Mode":"ro","RW":false,"Source":"/etc/echolet/tls","Type":"bind"},
        {"Destination":"/var/lib/echolet","Name":"echolet-relay-data",
         "Source":"/var/lib/docker/volumes/echolet-relay-data/_data","Type":"volume","RW":true}]
ports={"8443/tcp":[{"HostIp":"100.100.188.64","HostPort":"8443"}]}
readonly=true  user=10001:10001  capdrop=["ALL"]  secopt=["no-new-privileges:true"]
```

The relay states its own scheme — the line runbook §7 says is the one that matters:

```
time=2026-09-07T19:36:22.480Z level=INFO msg="BadgerDB opened" dir=/var/lib/echolet
time=2026-09-07T19:36:22.482Z level=INFO msg="Cleanup service started" interval_sec=60
time=2026-09-07T19:36:22.482Z level=INFO msg="Starting relay server" addr=0.0.0.0:8443 scheme=https tls_cert_file=/etc/echolet/tls/cert.pem tls_key_file=/etc/echolet/tls/key.pem
```

One socket, on the tailnet address and nowhere else — and the loopback the relay
used to occupy is now empty:

```
LISTEN 0 4096 100.100.188.64:8443 0.0.0.0:*

$ curl -sS --max-time 5 http://127.0.0.1:8443/health          # on depr itself
curl: (7) Failed to connect to 127.0.0.1 port 8443 … Couldn't connect to server
curl_exit=7
```

Volume identity, unchanged across the switch:

```
name=echolet-relay-data mountpoint=/var/lib/docker/volumes/echolet-relay-data/_data created=2026-09-07T17:34:43Z
```

`created=17:34:43` predates both the upgrade (18:37) and this switch (19:36):
the container was replaced three times, the volume never.

Stray count against the §1 baseline: **8 containers, 4 volumes, 0 dangling —
identical.** One `echolet-relay` container, one `echolet-relay-data` volume.
Every diagnostic run of the image passed `--entrypoint /bin/sh` with `--rm`, so
no second relay was ever started and no anonymous volume leaked.

---

## 5. HTTPS from this Mac — no `-k`, anywhere, at any point

```sh
curl -sS --max-time 10 https://depr.tail5a88fb.ts.net:8443/health
```

```json
{"ok":true,"data":{"status":"healthy","uptime_ms":57730}}
```

```
http_code=200 ssl_verify_result=0 scheme=HTTPS remote_ip=100.100.188.64 remote_port=8443
```

`ssl_verify_result=0` is curl's own statement that the chain validated against
the system trust store. `remote_ip=100.100.188.64` is the tailnet address, not a
tunnel endpoint.

### The chain as presented, and how it verifies

```
Certificate chain
 0 s:CN=depr.tail5a88fb.ts.net
   i:C=US, O=Let's Encrypt, CN=YE2
   a:PKEY: EC, (prime256v1); sigalg: ecdsa-with-SHA384
   v:NotBefore: Sep  7 18:35:38 2026 GMT; NotAfter: Dec  6 18:35:37 2026 GMT
 1 s:C=US, O=Let's Encrypt, CN=YE2
   i:C=US, O=ISRG, CN=Root YE
 2 s:C=US, O=ISRG, CN=Root YE
   i:C=US, O=Internet Security Research Group, CN=ISRG Root X2
 3 s:C=US, O=Internet Security Research Group, CN=ISRG Root X2
   i:C=US, O=Internet Security Research Group, CN=ISRG Root X1

Protocol : TLSv1.3
Cipher   : TLS_AES_128_GCM_SHA256
Verify return code: 0 (ok)
X509v3 Subject Alternative Name: DNS:depr.tail5a88fb.ts.net
```

A real Let's Encrypt certificate for the MagicDNS name, chaining to a public
root, terminated by the relay process itself.

### The certificate is bound to the name, not the address

```sh
curl -sS --max-time 10 https://100.100.188.64:8443/health
```
```
curl: (60) SSL: no alternative certificate subject name matches target ipv4 address '100.100.188.64'
curl_exit=60
```

Correct, and worth recording: an IP URL cannot match a MagicDNS certificate, so
the CLI must dial the name — which is what runbook §9 says and what the scenario
in §6 does.

---

## 6. No silent downgrade

Three independent checks. The relay answers plain HTTP on that port **with a
refusal from its TLS listener**, never with the API.

```sh
$ curl -sS --max-time 10 http://depr.tail5a88fb.ts.net:8443/health
Client sent an HTTP request to an HTTPS server.
```

```sh
$ printf 'GET /health HTTP/1.1\r\nHost: depr.tail5a88fb.ts.net\r\nConnection: close\r\n\r\n' \
    | nc -w 5 depr.tail5a88fb.ts.net 8443 | head -5
HTTP/1.0 400 Bad Request

Client sent an HTTP request to an HTTPS server.
```

An unencrypted request on the socket gets `400` and nothing else. No health
payload, no API surface, no fallback listener. The relay logged both probes:

```
time=2026-09-07T19:37:24.770Z level=INFO msg="http: TLS handshake error from 172.17.0.1:53514: client sent an HTTP request to an HTTPS server"
time=2026-09-07T19:37:25.211Z level=INFO msg="http: TLS handshake error from 172.17.0.1:53524: client sent an HTTP request to an HTTPS server"
```

And the client-side refusal is intact — the CLI will not be pointed at plain HTTP
on a non-loopback host:

```sh
node dist/cli.js init --relay-url "http://depr.tail5a88fb.ts.net:8443" …
{"ok":false,"error":{"code":"INVALID_CONFIGURATION"}}   exit=2
```

**No `-k`, no `--insecure`, no `--cacert`, no `NODE_TLS_REJECT_UNAUTHORIZED`, at
any point in this task.** Every TLS connection made here — curl, `openssl
s_client`, the CLI's own `fetch`, and the shim in §7.2 — validated the chain.

---

## 7. State survived the switch

Two independent proofs, one of them entirely over direct HTTPS.

### 7.1 A bundle published **before** the switch, claimed **after** it over HTTPS

At 19:32 UTC, over the plain-HTTP loopback relay through an SSH forward, a
throwaway identity `pre-c` published its prekey bundle and was never claimed:

```
### pre-c init      {"ok":true,"data":{"profile_id":"fac2ae1c-…","identity_id":"TUTR44CV1muD8Fej2YJdBJb8UMk7YqKTsFCLdOctYPI","device_id":"8f0580a3-3926-50da-8894-c608772ad3d2","contact_count":0}}
### pre-c publish   {"ok":true,"data":{"stored":true,"bundleId":"c4bd8d26-82d8-4c59-b6eb-812612646f24","claimable":true}}
```

At 19:38 UTC, **after** the switch, `alice` — a profile that has only ever spoken
to `https://depr.tail5a88fb.ts.net:8443` — imported `pre-c`'s card and sent to it.
A first-contact send must claim the recipient's published bundle from the relay:

```
PRE_SWITCH_CID=TUTR44CV1muD8Fej2YJdBJb8UMk7YqKTsFCLdOctYPI
{"identity_id":"TUTR44CV1muD8Fej2YJdBJb8UMk7YqKTsFCLdOctYPI","device_id":"8f0580a3-3926-50da-8894-c608772ad3d2",
 "device_pubkey":"GxlfkayQsIC2F-yakTdfRAi5FM0tvVw-NGglwrJn008","signal_identity_key":"BTKUmkAH_iK16hjVTzrSBAOcpy1YI4qL0aIG8GdMEvF4"}
{"ok":true,"data":{"trusted":true}}                                          exit=0
{"ok":true,"data":{"messageId":"8e23a5cf-8c47-43f7-9e57-960d8110139d",
                   "envelopeId":"99ebff31-caef-46b1-8eee-be16f5bace71","status":"delivered"}}  exit=0
```

The device record and the claimable bundle behind that `delivered` were written
to the store by the **plain-HTTP** relay process and served by the **HTTPS** one.
This proof travelled over direct, verified TLS end to end.

### 7.2 The same `--message-id` returns the same `envelopeId` across the switch

The task asked for exactly this, and it needs one honest disclosure about how it
was obtained.

**The obstacle.** A profile's relay URL is fixed at `init` and there is no
supported way to repoint it (runbook §9: "`--relay-url` exists only on `init`").
Before the switch, the only endpoint that existed was the relay's loopback HTTP
listener, reachable from this Mac solely through an SSH forward, so the profile
that writes the "before" envelope necessarily carries
`http://127.0.0.1:18444`. After the switch that endpoint is gone. Editing
`config.json` by hand is documented as unsupported and untested, so it was not
used.

**What was done instead.** The profile's URL was kept literally true by a
19-line local shim (`net` + `tls`, in `/tmp`, source in the scratchpad) that
accepts the profile's loopback connection on this Mac and carries the bytes to
`depr.tail5a88fb.ts.net:8443` over a **real TLS connection with
`rejectUnauthorized` at its default `true`** and the MagicDNS name as SNI. It is
not a verification bypass — a bad chain makes it fail exactly as curl without
`-k` does — and it is used **only** for this continuity artifact. The AC4
scenario in §8 does not involve it at all: those profiles dial
`https://depr.tail5a88fb.ts.net:8443` directly.

Both halves ran inside **one** process, so the throwaway store keys existed only
in that process's environment.

```
===== BEFORE THE SWITCH (SSH forward → plain-HTTP loopback relay) =====
### X0 health   {"ok":true,"data":{"status":"healthy","uptime_ms":3501688}}
### X1 xa init  {"ok":true,"data":{"profile_id":"fa1c33fe-…","identity_id":"9NiWfbfrIY2jgRI5JqAsoU9ZSdHpbaWfFEyXjd-iUWs","device_id":"a5b0dd28-3d81-5da5-b724-720ea8d81c83","contact_count":0}}
    xb init     {"ok":true,"data":{"profile_id":"2887cf65-…","identity_id":"7lHpdaoDYWcnaLzVaNZ15NvbfVaWQthLaBP5S0tgr5Q","device_id":"8623a0d7-5abf-5c6e-b11f-4c36b5ebfbb1","contact_count":0}}
### X2 publish  {"stored":true,"bundleId":"a774a735-6c7a-473f-ae5d-cc8aab6817cf","claimable":true}
                {"stored":true,"bundleId":"70486554-7ffe-4fa8-8615-ed4feaa73d88","claimable":true}
### X3 export + import both ways: {"trusted":true} / {"trusted":true}
XBID=7lHpdaoDYWcnaLzVaNZ15NvbfVaWQthLaBP5S0tgr5Q
XMID=031de76a-78f6-46ec-88f1-28ebd159913e
### X4 xa send --message-id $XMID
{"ok":true,"data":{"messageId":"031de76a-78f6-46ec-88f1-28ebd159913e",
                   "envelopeId":"a4362bd3-726f-4228-b6bf-192a4eb85eda","status":"delivered"}}
### X5 xb poll        {"received":1,"more":false,"rejected":[]}
### X6 xb poll again  {"received":0,"more":false,"rejected":[]}

===== THE SWITCH =====
### X7 SSH forward to depr closed
### X8 ./run-relay.sh env/depr.env  →  started on 100.100.188.64:8443, scheme=https
### X9 https://depr.tail5a88fb.ts.net:8443/health from this Mac, first attempt:
        {"ok":true,"data":{"status":"healthy","uptime_ms":917}}

===== AFTER THE SWITCH =====
### X11 health through the verifying shim   {"ok":true,"data":{"status":"healthy","uptime_ms":4140}}
### X12 xa sends the SAME --message-id
{"ok":true,"data":{"messageId":"031de76a-78f6-46ec-88f1-28ebd159913e",
                   "envelopeId":"a4362bd3-726f-4228-b6bf-192a4eb85eda","status":"delivered"}}   <- SAME
### X13 xb poll   {"received":0,"more":false,"rejected":[]}                                     <- dedup record survived
```

**`envelopeId` `a4362bd3-726f-4228-b6bf-192a4eb85eda` was issued by a relay
serving plain HTTP on `127.0.0.1` and returned, unchanged, by a relay serving
HTTPS on `100.100.188.64`.** Different container, different listener, different
scheme; the only thing they share is `echolet-relay-data`. Replaying that id can
come only from ciphertext stored on that volume before the switch, and
`received: 0` only from the dedup record stored beside it.

---

## 8. AC4 — the full acceptance scenario, from this Mac, over direct HTTPS

> **AC4:** *A relay reachable on a non-loopback address serves HTTPS, and the CLI
> completes the full acceptance scenario against it from a different machine.*

**Client:** this Mac, the real built `apps/cli/dist/cli.js` (1 053 482 bytes,
built from `4346e2b`), Node **v26.5.0** (the default non-login interpreter;
`bash -lc` here starts v22.12.0, which lacks `node:sqlite`).
**Relay:** `depr`, `100.100.188.64:8443`, HTTPS terminated by the relay process.
**Relay URL:** `https://depr.tail5a88fb.ts.net:8443` — no tunnel, no forward, no
shim, no proxy. Two fresh profiles in a `mktemp -d`; each 32-byte store key
generated with `crypto.randomBytes(32)` straight into an environment variable of
the single scenario process, never written to a file, never printed, and gone
with that process. Every CLI invocation is a separate process, so every step also
exercises client-side restart recovery.

```
### 0. /health over HTTPS from this Mac (no -k)
{"ok":true,"data":{"status":"healthy","uptime_ms":101964}}

### 1. alice init --relay-url https://depr.tail5a88fb.ts.net:8443
{"ok":true,"data":{"profile_id":"20989ba0-bfcf-4284-92bc-cbf780bff33f","identity_id":"FTK4_-4oD8gmyTDWpyaZ7wKDCKHw-mUgieAC1as-GTo","device_id":"a5a4e296-1252-58b8-8e45-d40f244ab9c0","contact_count":0}}
exit=0

### 2. bob init
{"ok":true,"data":{"profile_id":"6b463b56-8d63-4cfe-ad98-63870a69a9a1","identity_id":"RsG3cEAH9PveLSFxyTOwjAwwgPCbgFCG8lEI-JOShgY","device_id":"993e4d4f-2b2b-5ead-9619-7b94992590fb","contact_count":0}}
exit=0

### 3. alice relay publish
{"ok":true,"data":{"stored":true,"bundleId":"dd6fa402-554c-41e8-80ba-77e11e2e5aa5","claimable":true}}
exit=0

### 4. bob relay publish
{"ok":true,"data":{"stored":true,"bundleId":"e0741a65-8bef-42e4-9c5e-00a9b42a7783","claimable":true}}
exit=0

### 5. contact export (both)
{"ok":true,"data":{"exported":true}}   exit=0
{"ok":true,"data":{"exported":true}}   exit=0

### 6. alice contact import <- bob's card
{"identity_id":"RsG3cEAH9PveLSFxyTOwjAwwgPCbgFCG8lEI-JOShgY","device_id":"993e4d4f-2b2b-5ead-9619-7b94992590fb","device_pubkey":"B8pRtmNfF82kqph4NSbEYKHZ4xNBlbf0jcY6EdOXiJY","signal_identity_key":"BZS04H0LmoVdRgGq8fAUqE0ShWm2PESqf3RHfRXnRCod"}
{"ok":true,"data":{"trusted":true}}    exit=0

### 7. bob contact import <- alice's card
{"identity_id":"FTK4_-4oD8gmyTDWpyaZ7wKDCKHw-mUgieAC1as-GTo","device_id":"a5a4e296-1252-58b8-8e45-d40f244ab9c0","device_pubkey":"-zKoSW3XPVuYPf4cPx5rc4ULoYf04RN4LLzQt5h0ZnY","signal_identity_key":"BS9pwveeD9SAXCN9I8irb9ucMTaCuszEyszj3F_Krttd"}
{"ok":true,"data":{"trusted":true}}    exit=0

BID=RsG3cEAH9PveLSFxyTOwjAwwgPCbgFCG8lEI-JOShgY
AID=FTK4_-4oD8gmyTDWpyaZ7wKDCKHw-mUgieAC1as-GTo

### 8. OFFLINE DELIVERY — alice sends while bob has never polled
{"ok":true,"data":{"messageId":"66c3d1e4-8240-4f66-8610-13ffb860c494","envelopeId":"3837e475-4b66-4e75-a77a-89e3d9d2cd95","status":"delivered"}}
exit=0

### 9. bob poll (collects what was queued while he was offline)
{"ok":true,"data":{"received":1,"more":false,"rejected":[]}}
exit=0

### 10. REPLY in the other direction — bob sends
{"ok":true,"data":{"messageId":"75f1810d-eb63-4887-93d5-edf138083b51","envelopeId":"867f77c1-23f9-48fd-8c09-6b695893b612","status":"delivered"}}
exit=0

### 11. alice poll
{"ok":true,"data":{"received":1,"more":false,"rejected":[]}}
exit=0

MID=20e81982-d45e-4114-97fa-03276ef0ad3d

### 12. EXACT RETRY #1 (explicit --message-id)
{"ok":true,"data":{"messageId":"20e81982-d45e-4114-97fa-03276ef0ad3d","envelopeId":"724fbc99-51db-41f2-8c7a-22f2a58105f0","status":"delivered"}}
exit=0

### 13. EXACT RETRY #2 (byte-identical, same --message-id)
{"ok":true,"data":{"messageId":"20e81982-d45e-4114-97fa-03276ef0ad3d","envelopeId":"724fbc99-51db-41f2-8c7a-22f2a58105f0","status":"delivered"}}
exit=0

### 14. bob poll (the retried message arrives exactly once)
{"ok":true,"data":{"received":1,"more":false,"rejected":[]}}
exit=0

### 15. DEDUPLICATION — bob poll again
{"ok":true,"data":{"received":0,"more":false,"rejected":[]}}
exit=0
```

Steps 12 and 13 are the same command twice with the same `--message-id`; both
answer with `envelopeId` **`724fbc99-51db-41f2-8c7a-22f2a58105f0`**. The stored
ciphertext is replayed, not re-encrypted. Step 15 confirms the receiver
deduplicates.

### Histories (plaintext stripped before printing — see §10)

```
### 16. alice history --with BID
{"ok": true, "count": 3, "entries": [
 {"sequence":1,"messageId":"66c3d1e4-8240-4f66-8610-13ffb860c494","direction":"outbound","createdAtMs":1788809889072,"plaintextChars":52},
 {"sequence":2,"messageId":"75f1810d-eb63-4887-93d5-edf138083b51","direction":"inbound", "createdAtMs":1788809891086,"plaintextChars":55},
 {"sequence":3,"messageId":"20e81982-d45e-4114-97fa-03276ef0ad3d","direction":"outbound","createdAtMs":1788809893550,"plaintextChars":40}]}

### 17. bob history --with AID
{"ok": true, "count": 3, "entries": [
 {"sequence":1,"messageId":"66c3d1e4-8240-4f66-8610-13ffb860c494","direction":"inbound", "createdAtMs":1788809889072,"plaintextChars":52},
 {"sequence":2,"messageId":"75f1810d-eb63-4887-93d5-edf138083b51","direction":"outbound","createdAtMs":1788809891086,"plaintextChars":55},
 {"sequence":3,"messageId":"20e81982-d45e-4114-97fa-03276ef0ad3d","direction":"inbound", "createdAtMs":1788809893550,"plaintextChars":40}]}
```

| sequence | messageId | alice | bob |
|---|---|---|---|
| 1 | `66c3d1e4-8240-4f66-8610-13ffb860c494` | outbound | inbound |
| 2 | `75f1810d-eb63-4887-93d5-edf138083b51` | inbound | outbound |
| 3 | `20e81982-d45e-4114-97fa-03276ef0ad3d` | outbound | inbound |

Same ids, inverted directions, matching sequences and timestamps.

### The documented failure path, unchanged over TLS

```
### 19. carol init (a stranger), then carol -> bob
{"ok":true,"data":{"profile_id":"16ebbde8-fdd1-48fa-89ca-37b9d4970e7f","identity_id":"p85jKFm9Bt_KZRkds3IKnwRUVw3dHC64KhFJkhXX6SE","device_id":"1e64f48a-df15-596e-991c-78939421a191","contact_count":0}}  exit=0
{"ok":false,"error":{"code":"CONTACT_NOT_TRUSTED"}}   exit=3
```

---

## 9. The relay stored and logged no plaintext

Every body in this task carried the synthetic sentinel `T11TLSPROOF`, planted so
the store and the logs could be searched without reproducing a message. The
search ran **inside a throwaway container with the volume mounted read-only**,
with `--entrypoint /bin/sh` so no second relay could start:

```sh
docker run --rm --entrypoint /bin/sh -v echolet-relay-data:/data:ro \
  echolet-relay:20260907-a2f07bb -c '…'
```

**Storage layout** — Badger pre-allocates a sparse value log, so allocated blocks
are what matter and apparent sizes are meaningless:

```
/data/000001.sst  allocated=56K  apparent=54788
/data/000002.sst  allocated=4K   apparent=502
/data/000003.sst  allocated=60K  apparent=59607
/data/000003.vlog allocated=4K   apparent=20
/data/000004.vlog allocated=4K   apparent=2147483646
/data/00001.mem   allocated=48K  apparent=134217728
/data/DISCARD     allocated=4K   apparent=1048576
/data/KEYREGISTRY allocated=4K   /data/LOCK 4K   /data/MANIFEST 4K
-- total allocated: 196 KiB --
```

**Result** — the first 32 MiB of every file was scanned, ~170× the largest
allocated extent, for the sentinel, both Cyrillic substrings and the retry token:

```
/data/000001.sst  sentinel=0 cyrillic_greeting=0 retry_token=0 cyrillic_word=0
/data/000002.sst  sentinel=0 cyrillic_greeting=0 retry_token=0 cyrillic_word=0
/data/000003.sst  sentinel=0 cyrillic_greeting=0 retry_token=0 cyrillic_word=0
/data/000003.vlog sentinel=0 …   /data/000004.vlog sentinel=0 …   /data/00001.mem sentinel=0 …
/data/DISCARD, /data/KEYREGISTRY, /data/LOCK, /data/MANIFEST: all 0
TOTAL_MATCHES=0
```

**Container log: 5 lines, in total, for the whole TLS deployment** — three boot
lines and the two handshake refusals my own downgrade probes caused. Zero
sentinel matches, zero Cyrillic matches, zero occurrences of `PRIVATE KEY`. The
relay logs the certificate **paths** and never their contents, exactly as
documented.

*Caveat, stated as it was last time:* this is a bounded head-scan justified by
the allocated-block figures (196 KiB of real bytes, written sequentially from
offset 0), not an exhaustive sweep of the 2 GiB sparse value log. A full
recursive grep over that file was not attempted; the previous task measured it at
over 20 minutes without completing.

---

## 10. Redaction

- **No private key, no store key, no plaintext body and no HTTP request body
  appears anywhere in this report.** The certificate's private key was never
  read, never printed, never copied off `depr`; only its size (227 bytes), mode
  (`0600`), owner (`10001:10001`) and its `-----BEGIN EC PRIVATE KEY-----` header
  line were recorded.
- Every demo store key was generated with `crypto.randomBytes(32)` directly into
  an environment variable of the process that used it, never written to a file,
  never printed, and is gone with that process.
- No message body is reproduced. `history --json` returns a `plaintext` field per
  entry; both history blocks in §8 were passed through a filter that keeps
  `sequence`, `messageId`, `direction`, `createdAtMs` and replaces the body with
  its character count **before printing**. The only body-derived strings named
  here are the synthetic sentinel `T11TLSPROOF` and the search tokens, planted to
  make §9 possible without quoting a message.
- The identifiers quoted — `identity_id`, `device_id`, `device_pubkey`,
  `signal_identity_key`, `profile_id`, `bundleId`, `messageId`, `envelopeId`,
  and the certificate's serial — are public protocol identifiers and public
  certificate metadata, belonging to throwaway profiles that have been deleted.

---

## 11. What failed, what was awkward, and what is still open

1. **`docker-compose.yml` cannot perform this deployment** (§3.2). It hard-requires
   `ECHOLET_HOST_DATA_DIR` and has no `ECHOLET_DATA_VOLUME` branch, so the TLS
   compose path cannot adopt an existing named volume. `run-relay.sh` can, and
   did. Reported, not worked around; fixing it means editing a committed artifact,
   which was out of scope.
2. **The certificate-renewal timer was NOT installed.** Deployment-runbook §4's
   `echolet-cert-renew.{service,timer}` are not on `depr`. The certificate expires
   **Dec 6 2026 18:35:37 GMT**; without the timer nothing renews it and the relay
   will keep serving an expired certificate until someone re-runs `tailscale cert`
   (the relay does hot-reload the pair within `ECHOLET_TLS_RELOAD_INTERVAL_SECONDS=60`,
   so a manual renewal needs no restart). This was outside the task's step list
   and adds host state beyond it; the commands are in §12 and should be run before
   this deployment is left unattended for three months.
3. **Hot reload on renewal was deliberately not exercised.** Testing it means
   re-issuing the certificate, and Let's Encrypt rate-limits duplicates at roughly
   5 per week for the same name. The reload path is therefore still unproven on
   this host — recorded as a gap rather than risked for a demonstration.
4. **The exact-retry-across-the-switch proof needed a local TLS shim** (§7.2),
   because the CLI fixes a profile's relay URL at `init` and offers no supported
   way to repoint it. The shim validates the chain (no bypass) and is used only
   for that one artifact; §7.1 gives the same conclusion over direct HTTPS with no
   shim at all. The underlying limitation is a product one and is worth a note in
   the runbook: **there is no supported way to carry a profile across a relay's
   scheme/address change.**
5. **A first attempt at the pre-switch continuity data was orphaned.** Its
   throwaway store keys lived only in that process, so those profiles could not be
   reused after the switch and the sequence was re-run inside a single process.
   What it left in the relay's store: three device records, three published
   bundles and one delivered envelope (`ceb7ff02-859d-4f43-9938-79e210da68b8`,
   already polled and acked). All expire under the 168 h retention cap; nothing was
   deleted to tidy it away, because deleting relay state was not permitted here.
   Its identity `pre-c` is the one §7.1 then used productively.
6. **The first plaintext-scan script had a shell bug** (`grep -c` returning 1 with
   `|| echo 0` produced two lines and broke the arithmetic), and it was re-run.
   Both runs agree on the files scanned; §9 quotes the corrected run.
7. **`tailscale` is not on this Mac's PATH**, so runbook §8's
   `tailscale status | grep -E 'geekom|depr'` could not be run here. Reachability
   is established more directly instead: curl reached `remote_ip=100.100.188.64`
   over the tailnet and completed a TLS 1.3 handshake with a verified chain.
8. **The SSH forward `18444 → depr:127.0.0.1:8443` was closed** as part of the
   switch: its target no longer exists. The forward `18443 → geekom` was left
   exactly as found and `geekom` was not touched in any way.
9. **Nothing else failed.** The certificate issued on the first attempt,
   `run-relay.sh` started the TLS relay on the first attempt, and HTTPS health
   answered from this Mac on the first poll (`uptime_ms: 917`).

---

## 12. Teardown and rollback

**Roll back to the loopback-only deployment** (the state before this task), on
`depr`, no `sudo` needed for these two lines:

```sh
cd ~/echolet-deploy
./run-relay.sh env/insecure-loopback.env      # already present, ECHOLET_IMAGE=echolet-relay:20260907-a2f07bb
docker ps --filter name=echolet-relay --format '{{.Status}}\t{{.Ports}}'
# expect: Up N seconds (healthy)  127.0.0.1:8443->8443/tcp
```

The volume is untouched by either direction, so the state crosses back exactly as
it crossed forward.

**Roll back to the previous image**, keeping TLS:

```sh
sed -i 's|^ECHOLET_IMAGE=.*|ECHOLET_IMAGE=echolet-relay:20260907-c302485-dirty|' env/depr.env
./run-relay.sh env/depr.env
```
(but see runbook §11: rolling back past the transcript change breaks new clients.)

**Remove the TLS deployment entirely:**

```sh
docker rm -f echolet-relay
sudo rm -rf /etc/echolet                 # the certificate pair and nothing else
rm -f ~/echolet-deploy/env/depr.env      # not committed; holds no secret
# the data volume is deliberately NOT removed:
#   docker volume rm echolet-relay-data  # DESTROYS all relay state — only if you mean it
```

**Install the renewal timer** (the open item from §11.2), on `depr`:

```sh
cd ~/echolet-deploy
sudo cp systemd/echolet-cert-renew.service /etc/systemd/system/
sudo cp systemd/echolet-cert-renew.timer   /etc/systemd/system/
sudo systemctl edit echolet-cert-renew.service   # Environment=ECHOLET_TLS_HOSTNAME=depr.tail5a88fb.ts.net
sudo systemctl daemon-reload
sudo systemctl enable --now echolet-cert-renew.timer
```

**On this Mac:** nothing to clean up. The throwaway profile directories
(`/tmp/echolet-tls-*`) were removed, the TLS shim was stopped, the `depr` SSH
forward was closed, and no image, container or file was created outside the
session scratchpad and this report.

---

## 13. Current state

| | `depr` |
|---|---|
| Container | `echolet-relay`, `7eef4c4e2229…`, `Up (healthy)`, `RestartCount=0` |
| Image | `echolet-relay:20260907-a2f07bb` (`sha256:83497194…`), unchanged |
| Published on | **`100.100.188.64:8443`** — the tailnet address, not loopback |
| Scheme | **`https`**, certificate and key read from `/etc/echolet/tls`, mounted read-only |
| Certificate | Let's Encrypt `CN=depr.tail5a88fb.ts.net`, issuer `CN=YE2`, `Sep 7 2026 → Dec 6 2026` |
| Label | `echolet.tls=enabled` |
| Volume | `echolet-relay-data`, created `17:34:43Z`, carried across three container generations |
| Callsign | `RPT-DEPR-01` |
| `/health` from this Mac | `{"ok":true,"data":{"status":"healthy",…}}`, `http_code=200`, `ssl_verify_result=0` |
| Plain HTTP on that port | `400 Bad Request` — "Client sent an HTTP request to an HTTPS server." |
| Strays | none: 8 containers / 4 volumes / 0 dangling, identical to the baseline |
| Renewal timer | **not installed** (§11.2) |

`geekom` is untouched and still runs its loopback-only relay; nothing in this
task read or wrote it.

---

## 14. AC4 — the verdict

> **AC4:** *A relay reachable on a non-loopback address serves HTTPS, and the CLI
> completes the full acceptance scenario against it from a different machine.*

**AC4 is met.** The evidence, clause by clause:

| Clause | Evidence |
|---|---|
| *reachable on a non-loopback address* | Published on `100.100.188.64:8443`; `ss -ltn` shows that single socket and nothing on loopback; `curl http://127.0.0.1:8443` on `depr` itself is refused (§4). Reached from this Mac at `remote_ip=100.100.188.64` (§5). |
| *serves HTTPS* | The relay process terminates TLS: `scheme=https tls_cert_file=/etc/echolet/tls/cert.pem tls_key_file=/etc/echolet/tls/key.pem` in its own startup line (§4). Real Let's Encrypt chain, TLS 1.3, `Verify return code: 0 (ok)`, `ssl_verify_result=0`, **no `-k` anywhere** (§5). No SSH tunnel and no reverse proxy is in the path. |
| *no silent downgrade* | Plain HTTP on the same port returns `HTTP/1.0 400` + "Client sent an HTTP request to an HTTPS server", from the TLS listener, never from the API (§6). |
| *the CLI completes the full acceptance scenario* | init ×2, publish ×2, export/import both ways, offline delivery, reply, byte-identical exact retry returning `envelopeId` `724fbc99-51db-41f2-8c7a-22f2a58105f0` twice, deduplication to `received: 0`, mirrored histories on both sides, and the `CONTACT_NOT_TRUSTED`/exit 3 failure path — all `exit=0` where success was expected (§8). |
| *from a different machine* | The clients ran on this Mac with the real built `dist/cli.js` on Node v26.5.0; the relay ran on `depr`. The relay URL was `https://depr.tail5a88fb.ts.net:8443` — direct, over the tailnet, with no forward, tunnel or shim in the path. |
| *the relay saw no plaintext* | 0 sentinel matches across the whole store and a 5-line log (§9). |
| *state survived the switch* | A pre-switch bundle claimed post-switch over direct HTTPS (§7.1), and the same `--message-id` returning `envelopeId` `a4362bd3-726f-4228-b6bf-192a4eb85eda` before and after (§7.2). |

**What AC4 still does not make true.** Everything in deployment-runbook §14
stands: this is an unaudited prototype, tailnet-only, with no mTLS and no client
authentication — TLS authenticates the *server* to the client and encrypts the
wire, nothing more. `ECHOLET_MAX_STORAGE_BYTES` is still enforced nowhere,
identity creation is still free, and the first walk of a very large flood is still
slow. AC4 is one acceptance criterion, not a readiness claim. And `geekom` is
still on the loopback-only path: this report establishes AC4 on `depr`, one relay,
which is what AC4 asks for.

---

## Routing audit

- `graph_used`: **no** — *not relevant*. No structural "where does X live / what
  breaks if I change Y" question arose; no repository code was navigated or
  changed. The authoritative sources were named directly by the task.
- `wiki_used`: **no** — *not relevant*. This was operating one server against a
  written runbook. The in-repo sources (`deployment-runbook.md` §2–§8, §12–§14,
  `runbook.md` §4–§10 and its HTTPS section, `deploy/relay/run-relay.sh`,
  `docker-compose.yml`, `env/depr.env.example`, and the two prior T11 reports)
  were read directly and in full.
- `ctx_used`: **partial**. `keryx ctx run` for local commands (`git log`,
  `node --version`, the `dist/cli.js` check) and `keryx ctx rg` for the one
  in-repo code search (`relay_url` handling in `apps/cli/src`). Remote host output
  arrives over SSH from another machine and cannot be routed through gdctx, so it
  was captured to session scratch files and read from there — the same objective
  by a different mechanism.
- `raw_rg_used`: **no** over project code. Commands carrying a `keryx:raw` escape
  marker with a stated reason: remote host output over SSH, `grep` inside a
  container on the remote host, this Mac's own process list, and the live CLI /
  TLS transcripts that had to be captured verbatim for this report. None searched
  project code.

## Files written

- This report — the only write inside the repository.
- `.metaproject/data/gdctx/raw/…` and `.metaproject/data/gdctx/artifacts/…` —
  created automatically by the routed `keryx ctx` invocations.
- On `depr`: `/etc/echolet/tls/{cert.pem,key.pem}` and
  `~/echolet-deploy/env/depr.env` (not committed, holds no secret).
- Scratch outside the repository, in the session scratchpad: `before-depr.sh`,
  `before-depr.txt`, `issue-cert.sh`, `prep-env.sh`, `pre-switch.sh`,
  `cross-switch.sh`, `tls-proxy.js`, `scenario-https.sh`, `verify-mac.sh`,
  `after-depr.sh`, `plaintext-scan.sh`, `plaintext-scan2.sh` and their logs.
  Throwaway profile directories under `/tmp/echolet-tls-*`, all removed.

**No source file, no test file and no committed deployment artifact was changed.
`geekom` was not touched. The `echolet-relay-data` volume was not deleted and not
recreated.**
