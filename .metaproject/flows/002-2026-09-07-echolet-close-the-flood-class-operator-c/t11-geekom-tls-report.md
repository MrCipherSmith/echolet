# T11 — TLS report: `geekom` serves HTTPS on its tailnet address, and its certificate renews itself

Date: 2026-09-07 (20:36–20:48 UTC)
Source tree: HEAD `da24daa`. No source file, no test file and no committed
deployment artifact was changed. The working tree's uncommitted RED test files
from other in-flight tasks were not read, run or touched.
Relay image: unchanged — `echolet-relay:20260907-a2f07bb`, already on the host.
Scope: **write**, on `geekom` only — one certificate pair in `~/echolet-tls`,
one new Docker volume, one non-committed env file, one container replacement,
and one user-scope systemd timer. `depr` was read exactly once, over HTTPS, and
not touched.

---

## 0. The headline

| | before | after |
|---|---|---|
| Published on | `127.0.0.1:8443` | **`100.116.255.111:8443`** (`geekom`'s tailnet IPv4) |
| Scheme, as the relay states it | `scheme=http tls_cert_file="" tls_key_file=""` | **`scheme=https tls_cert_file=/etc/echolet/tls/cert.pem tls_key_file=/etc/echolet/tls/key.pem`** |
| `echolet.tls` label | `disabled-insecure-loopback-only` | **`enabled`** |
| Reachable from this Mac | no — connection refused | **yes — `https://geekom.tail5a88fb.ts.net:8443/health` = 200, `ssl_verify_result=0`, no `-k`** |
| Certificate | none | **Let's Encrypt, `CN=geekom.tail5a88fb.ts.net`, issuer `C=US, O=Let's Encrypt, CN=YE1`, valid `Sep 7 19:39:58 2026 GMT` → `Dec 6 19:39:57 2026 GMT`** |
| `tailscale cert` needed sudo? | — | **no. Ran as `altsay`, exit 0, first attempt** |
| Certificate reaches uid 10001 | — | **named volume `echolet-relay-tls`, `cert 0644`, **`key 0600`**, both owned `10001:10001`. Never world-readable, no host root** |
| Data | volume `echolet-relay-data` | **the same volume, same mountpoint, `created=2026-09-07T17:41:42Z`, not recreated** |
| Committed artifact sufficient? | — | **`run-relay.sh`: yes, unmodified, no bespoke `docker run`. `docker-compose.yml`: NO — §3.3** |
| **Certificate renewal** | none anywhere in this fleet | **automated — an enabled, active, lingering `systemctl --user` timer, run once end to end, exit 0 (§8)** |

`tailscale debug prefs` on `geekom` reports `OperatorUser: altsay`;
`tailscale status --json` reports `CertDomains: ["geekom.tail5a88fb.ts.net"]`.
Deployment-runbook §3.1 is satisfied on this host too.

**This is the first host in the fleet whose certificate renews itself.** `depr`
still has none (`t11-tls-report.md` §11.2).

---

## 1. Before state, captured before anything was touched

```
id=1d9cfc0d7523109c166a136f3090ed270e857bdb21015f549cc91f2ec8e16dbd
image=echolet-relay:20260907-a2f07bb
imageid=sha256:83497194b1e213f5b6cc795d0ff5eafdb33e0101579b7295fadad04ac0d077c4
created=2026-09-07T18:36:11.89480626Z
started=2026-09-07T18:36:19.341631746Z
restarts=0
health=healthy
status=running
user=10001:10001  readonly=true  restartpolicy=unless-stopped
labels={"echolet.tls":"disabled-insecure-loopback-only", …}
mounts=[{"Destination":"/var/lib/echolet","Name":"echolet-relay-data",
         "Source":"/var/lib/docker/volumes/echolet-relay-data/_data","Type":"volume","RW":true}]
ports={"8443/tcp":[{"HostIp":"127.0.0.1","HostPort":"8443"}]}
```

```
echolet-relay  echolet-relay:20260907-a2f07bb  Up 2 hours (healthy)  127.0.0.1:8443->8443/tcp
LISTEN 0 4096 127.0.0.1:8443 0.0.0.0:*
{"ok":true,"data":{"status":"healthy","uptime_ms":7207241}}
time=2026-09-07T18:36:19.499Z level=INFO msg="Starting relay server" addr=0.0.0.0:8443 scheme=http tls_cert_file="" tls_key_file=""
```

| | value |
|---|---|
| Volume | `echolet-relay-data` → `/var/lib/docker/volumes/echolet-relay-data/_data`, created `2026-09-07T17:41:42Z`, `Labels: null` |
| Images on host | `echolet-relay:20260907-a2f07bb`, `echolet-relay:20260907-c302485-dirty` (rollback) |
| Totals (stray baseline) | **33 containers, 866 volumes, 856 dangling**, 1 `echolet*` container, 1 `echolet*` volume |
| `/etc/echolet` | absent |
| `/var/lib/echolet` | absent |
| `~/echolet-deploy` | present, from the upgrade task |
| `sudo -n true` | **`sudo: a password is required`, exit 1** — password-gated, as documented |
| `tailscale ip -4` | `100.116.255.111` |
| Docker / compose | `29.3.0` / `v5.1.0` |
| **`CertDomains`** | **`["geekom.tail5a88fb.ts.net"]`** |
| **`OperatorUser`** | **`altsay`** |
| `loginctl show-user altsay` | **`Linger=yes`** — already set, before this task |
| `systemctl --user is-system-running` | **`running`** |
| `crontab -l` | present, 5 active entries belonging to other workloads (`helyx-*`, `deprecated-*`) — **not touched** |

`geekom`'s 856 dangling volumes are pre-existing and belong to unrelated
workloads. They were counted, never touched.

The host's copy of the deployment tree is byte-identical to the repository's,
before and after:

```
b9140d0476745b9c84ed85a0e72ec027db78c37af41f6269ffe5bbacdcdc6eb4  run-relay.sh              (repo == geekom)
70c857a7c960c33411bee060ccb6c0da7545a3fa0caf9752bb58b5a191976f63  docker-compose.yml        (repo == geekom)
90f8912622ee9a4aeca6ede5d80ccb40b63cafe4ca5910a6ab35e586b2d02974  env/geekom.env.example    (repo == geekom)
```

---

## 2. The certificate — issued as `altsay`, no sudo, one attempt

The task's premise held. **`tailscale cert` worked for the unprivileged
operator, first attempt, exit 0.** No sudo was run on `geekom` at any point in
this task.

```sh
# on geekom, as altsay — NO sudo
mkdir -p ~/echolet-tls && chmod 0700 ~/echolet-tls
tailscale cert \
  --cert-file ~/echolet-tls/cert.pem \
  --key-file  ~/echolet-tls/key.pem \
  geekom.tail5a88fb.ts.net
```

```
drwx------ 2 altsay altsay 4096 Sep  7 20:37 /home/altsay/echolet-tls
Wrote public cert to /home/altsay/echolet-tls/cert.pem
Wrote private key to /home/altsay/echolet-tls/key.pem
cert_exit=0

-rw-r--r-- 1 altsay altsay 4837 Sep  7 20:38 cert.pem
-rw------- 1 altsay altsay  227 Sep  7 20:38 key.pem
key.pem  size=227  mode=600  owner=1000:1000
cert.pem size=4837 mode=644  owner=1000:1000
```

The script refuses to run if a pair already exists, so a re-run cannot burn the
duplicate-issuance budget by accident. It was issued **once**.

### Public metadata (the key itself is never read, printed, copied or committed)

```
subject=CN = geekom.tail5a88fb.ts.net
issuer=C = US, O = Let's Encrypt, CN = YE1
notBefore=Sep  7 19:39:58 2026 GMT
notAfter=Dec  6 19:39:57 2026 GMT
serial=05A82BF9667A1EFEE1709DAAD9EF83F0F15B
X509v3 Subject Alternative Name: DNS:geekom.tail5a88fb.ts.net
chain length: 4 certificates
key type line: -----BEGIN EC PRIVATE KEY-----   (227 bytes, mode 600)
```

Note the intermediate: `geekom`'s is **`CN=YE1`**, `depr`'s is `CN=YE2`. Both are
Let's Encrypt intermediates and both chain to a public root; the two hosts simply
drew different ones.

`notBefore` (19:39:58) precedes the `tailscale cert` invocation (20:38) by about
an hour, because `tailscaled` had already fetched and cached this certificate.
The command returned the cached pair rather than issuing a second one — which is
the behaviour that makes the daily renewal timer in §8 cheap.

**The private key was never displayed, never copied off `geekom`, and appears
nowhere in this report or in any scratch file.** Only its size, mode, owner and
its single `-----BEGIN EC PRIVATE KEY-----` header line were recorded.

---

## 3. The permissions problem, and the route through it

### 3.1 The problem

The container runs as uid **10001**. `altsay` is uid **1000** and cannot `chown`
to 10001 without root, and `altsay`'s sudo is password-gated. The runbook's §4
recipe — `sudo chown 10001:10001 /etc/echolet/tls/*` — is therefore unavailable
on this host. Making the key world-readable to work around it was not an option
and was not done.

### 3.2 The route: a named volume, populated by a throwaway root container

The Docker daemon already runs as root, so a container started with `--user 0`
can write into a named Docker volume and `chown` inside it — **with no host root
and no sudo**. The host's own copy of the pair stays owned by `altsay` at
`0600`; only the volume copy is owned by 10001.

```sh
docker run --rm --user 0 --entrypoint /bin/sh \
  -v ~/echolet-tls:/src:ro -v echolet-relay-tls:/dst \
  echolet-relay:20260907-a2f07bb -c '
    cp /src/cert.pem /dst/cert.pem
    cp /src/key.pem  /dst/key.pem
    chown 10001:10001 /dst/cert.pem /dst/key.pem
    chmod 0644 /dst/cert.pem
    chmod 0600 /dst/key.pem'
```

```
-rw-r--r--  1 10001 10001 4837 Sep  7 20:39 cert.pem
-rw-------  1 10001 10001  227 Sep  7 20:39 key.pem
populate_exit=0
```

Read back as the relay's own uid, before the relay was ever pointed at it:

```
docker run --rm --user 10001:10001 --entrypoint /bin/sh -v echolet-relay-tls:/etc/echolet/tls:ro …
cert readable: yes
key  readable: yes
key header: -----BEGIN EC PRIVATE KEY-----
cert sha256: 6d25a68f5e1dd883c63b1e35833b78752e22b58b8a88cfeeb5732ad25a816669
readback_exit=0
```

**The key is `0600`, owned by the container's uid, and world-readable at no point
on either side of the mount.** Both diagnostic runs passed `--entrypoint
/bin/sh` and `--rm`, so no second relay was started and no anonymous volume
leaked.

Alternatives considered and rejected:

- **`chown` the host files to 10001 from inside a root container.** Works, but
  then `altsay` could no longer rewrite them, and `tailscale cert` opens the
  paths for writing — it would break renewal, which is the whole point of §8.
- **Run the relay as uid 1000.** Would make the key readable, and make
  `echolet-relay-data` (owned 10001) unreadable. Non-starter.
- **Loosen the key's mode.** Explicitly forbidden, and correctly so.

The chosen shape has a second virtue: it is exactly what the renewal script must
do anyway, so renewal and first install run the same code path.

### 3.3 The committed `run-relay.sh` sufficed, unmodified

`ECHOLET_TLS_DIR` is interpolated straight into `-v "${ECHOLET_TLS_DIR}:/etc/echolet/tls:ro"`,
and Docker reads a non-path there as a **named volume**. So the committed script
mounts the TLS volume with no edit and no bespoke `docker run`. The env file is
the committed `env/geekom.env.example` with four lines changed:

```diff
18c18
< ECHOLET_IMAGE=echolet-relay:REPLACE_WITH_BUILT_TAG
---
> ECHOLET_IMAGE=echolet-relay:20260907-a2f07bb
27c27
< ECHOLET_BIND_ADDR=REPLACE_WITH_TAILSCALE_IPV4
---
> ECHOLET_BIND_ADDR=100.116.255.111
39c39
< ECHOLET_TLS_DIR=/etc/echolet/tls
---
> ECHOLET_TLS_DIR=echolet-relay-tls
44c44
< ECHOLET_HOST_DATA_DIR=/var/lib/echolet
---
> ECHOLET_DATA_VOLUME=echolet-relay-data
```

The first two are the two values the template says a host must supply. The other
two are the deviations this host requires, and both are supported branches of the
committed script: `ECHOLET_DATA_VOLUME` is `run-relay.sh`'s own named-volume
branch (it accepts exactly one of the two and refuses both), and
`ECHOLET_TLS_DIR` holding a volume name is the same mechanism applied to the
certificate mount.

`--print` first, as the runbook instructs — nothing was started by this:

```
docker run -d --name echolet-relay --restart unless-stopped --user 10001:10001 \
  --read-only --tmpfs /tmp:size=16m,mode=1777 --security-opt no-new-privileges:true \
  --cap-drop ALL --log-driver json-file --log-opt max-size=20m --log-opt max-file=5 \
  --label echolet.tls=enabled \
  -p 100.116.255.111:8443:8443 \
  -v echolet-relay-tls:/etc/echolet/tls:ro \
  -v echolet-relay-data:/var/lib/echolet \
  -e ECHOLET_HTTP_ADDR=0.0.0.0:8443 \
  -e ECHOLET_TLS_CERT_FILE=/etc/echolet/tls/cert.pem \
  -e ECHOLET_TLS_KEY_FILE=/etc/echolet/tls/key.pem \
  -e ECHOLET_TLS_RELOAD_INTERVAL_SECONDS=60 \
  -e ECHOLET_DATA_DIR=/var/lib/echolet -e ECHOLET_LOG_LEVEL=info \
  -e ECHOLET_NODE_CALLSIGN=RPT-GEEKOM-01 -e ECHOLET_MAILBOX_TTL_HOURS=168 \
  -e ECHOLET_MAX_MESSAGE_BYTES=262144 -e ECHOLET_MAX_MAILBOX_BATCH=100 \
  -e ECHOLET_MAX_UNACKED_ENVELOPES_PER_SENDER=16 -e ECHOLET_RATE_LIMIT_PER_MINUTE=120 \
  -e ECHOLET_CHALLENGE_TTL_SECONDS=60 -e ECHOLET_CLEANUP_INTERVAL_SECONDS=60 \
  -e ECHOLET_MAX_STORAGE_BYTES=2147483648 \
  echolet-relay:20260907-a2f07bb
print_exit=0
```

Then, unmodified:

```sh
cd ~/echolet-deploy && ./run-relay.sh env/geekom.env
```

```
==> replacing existing container echolet-relay
2207fce6eb29cc2dbcde814ab20a7587e8d97d100226018fba012851972ce250
==> started echolet-relay from echolet-relay:20260907-a2f07bb on 100.116.255.111:8443
==> scheme: https. Confirm the relay agrees:
    docker logs echolet-relay | grep 'Starting relay server'
    expect:  scheme=https tls_cert_file=/etc/echolet/tls/cert.pem
run_relay_exit=0
```

`ECHOLET_INSECURE_LOOPBACK_ONLY` is absent from `env/geekom.env` entirely, so the
script took its default TLS branch. The replace path is `docker stop` + `docker
rm`, never `rm -v`: the data volume is untouched, and §7 proves that with data
rather than with the absence of a flag.

### Finding: `docker-compose.yml` still cannot perform this switch

Re-checked on `geekom`, and it fails the same way it failed on `depr`:

```
$ docker compose --env-file env/geekom.env -f docker-compose.yml config
error while interpolating services.relay.volumes.[]: required variable
ECHOLET_HOST_DATA_DIR is missing a value: set ECHOLET_HOST_DATA_DIR, e.g. /var/lib/echolet
compose_config_exit=1
```

Known and already documented (`t11-tls-report.md` §3.2, deployment-runbook §6).
It would also have no way to express the named TLS volume, since it hardcodes a
host bind for the certificate directory too. Reported, not worked around.

---

## 4. After state on `geekom`

```
id=2207fce6eb29cc2dbcde814ab20a7587e8d97d100226018fba012851972ce250
image=echolet-relay:20260907-a2f07bb
imageid=sha256:83497194b1e213f5b6cc795d0ff5eafdb33e0101579b7295fadad04ac0d077c4
started=2026-09-07T20:41:12.586657673Z
restarts=0
health=healthy
status=running
tls_label=enabled
user=10001:10001  readonly=true  capdrop=["ALL"]  secopt=["no-new-privileges:true"]
mounts=[{"Destination":"/var/lib/echolet","Name":"echolet-relay-data",
         "Source":"/var/lib/docker/volumes/echolet-relay-data/_data","Type":"volume","RW":true},
        {"Destination":"/etc/echolet/tls","Name":"echolet-relay-tls","Mode":"ro","RW":false,
         "Source":"/var/lib/docker/volumes/echolet-relay-tls/_data","Type":"volume"}]
ports={"8443/tcp":[{"HostIp":"100.116.255.111","HostPort":"8443"}]}
```

The relay states its own scheme — the line runbook §7 says is the one that
matters:

```
time=2026-09-07T20:41:12.752Z level=INFO msg="BadgerDB opened" dir=/var/lib/echolet
time=2026-09-07T20:41:12.753Z level=INFO msg="Cleanup service started" interval_sec=60
time=2026-09-07T20:41:12.753Z level=INFO msg="Starting relay server" addr=0.0.0.0:8443 scheme=https tls_cert_file=/etc/echolet/tls/cert.pem tls_key_file=/etc/echolet/tls/key.pem
```

One socket, on the tailnet address and nowhere else:

```
echolet-relay  echolet-relay:20260907-a2f07bb  Up About a minute (healthy)  100.116.255.111:8443->8443/tcp
LISTEN 0 4096 100.116.255.111:8443 0.0.0.0:*
```

Volume identity, unchanged across the switch:

```
data: name=echolet-relay-data mountpoint=/var/lib/docker/volumes/echolet-relay-data/_data created=2026-09-07T17:41:42Z
tls:  name=echolet-relay-tls  mountpoint=/var/lib/docker/volumes/echolet-relay-tls/_data  created=2026-09-07T20:39:03Z
```

`created=17:41:42` predates both the upgrade (18:36) and this switch (20:41): the
container has been replaced three times, the data volume never.

### Strays

| | baseline (§1) | after |
|---|---|---|
| Containers (all) | 33 | **33** |
| Volumes (all) | 866 | **867** |
| Dangling volumes | 856 | **856** |
| Containers named `echolet*` | 1 | **1** (`echolet-relay`) |
| Volumes named `echolet*` | 1 | **2** (`echolet-relay-data`, `echolet-relay-tls`) |

The **+1 volume is `echolet-relay-tls`, created deliberately** — it is the
mechanism §3.2 describes, and the design requires it. Nothing else changed: no
stray container, no dangling volume, no image pulled. Every diagnostic run of the
image used `--entrypoint /bin/sh` with `--rm`.

---

## 5. HTTPS from this Mac — no `-k`, anywhere, at any point

```sh
curl -sS --max-time 10 https://geekom.tail5a88fb.ts.net:8443/health
```

```json
{"ok":true,"data":{"status":"healthy","uptime_ms":94666}}
```

```
http_code=200 ssl_verify_result=0 scheme=HTTPS remote_ip=100.116.255.111 remote_port=8443
```

`ssl_verify_result=0` is curl's own statement that the chain validated against
the system trust store. `remote_ip=100.116.255.111` is the tailnet address, not
a tunnel endpoint. The very first HTTPS poll after the switch answered
`uptime_ms: 161`.

### The chain as presented, and how it verifies

```
Certificate chain
 0 s:CN=geekom.tail5a88fb.ts.net
   i:C=US, O=Let's Encrypt, CN=YE1
   a:PKEY: EC, (prime256v1); sigalg: ecdsa-with-SHA384
   v:NotBefore: Sep  7 19:39:58 2026 GMT; NotAfter: Dec  6 19:39:57 2026 GMT

subject=CN=geekom.tail5a88fb.ts.net
issuer=C=US, O=Let's Encrypt, CN=YE1
notBefore=Sep  7 19:39:58 2026 GMT
notAfter=Dec  6 19:39:57 2026 GMT
serial=05A82BF9667A1EFEE1709DAAD9EF83F0F15B
X509v3 Subject Alternative Name: DNS:geekom.tail5a88fb.ts.net

Protocol  : TLSv1.3
Cipher    : TLS_AES_128_GCM_SHA256
Verify return code: 0 (ok)
```

### The certificate is bound to the name, not the address

```sh
curl -sS --max-time 10 https://100.116.255.111:8443/health
```
```
curl: (60) SSL: no alternative certificate subject name matches target ipv4 address '100.116.255.111'
curl_exit=60
```

Correct: an IP URL cannot match a MagicDNS certificate, so the CLI must dial the
name. Recorded because it is the failure a first-time operator will hit.

---

## 6. No silent downgrade

Three independent checks, and the loopback the relay used to occupy is now empty.

```sh
$ curl -sS --max-time 10 http://geekom.tail5a88fb.ts.net:8443/health
Client sent an HTTP request to an HTTPS server.
```

```sh
$ printf 'GET /health HTTP/1.1\r\nHost: geekom.tail5a88fb.ts.net\r\nConnection: close\r\n\r\n' \
    | nc -w 5 geekom.tail5a88fb.ts.net 8443 | head -5
HTTP/1.0 400 Bad Request

Client sent an HTTP request to an HTTPS server.
```

An unencrypted request on the socket gets `400` from the TLS listener and nothing
else: no health payload, no API surface, no fallback listener.

**And plain HTTP on loopback no longer answers at all** — on `geekom` itself:

```sh
$ curl -sS --max-time 5 http://127.0.0.1:8443/health
curl: (7) Failed to connect to 127.0.0.1 port 8443 after 0 ms: Couldn't connect to server
curl_exit=7
```

`ss -ltn` agrees: the only socket is `100.116.255.111:8443`. The relay logged both
of my downgrade probes and nothing else:

```
time=2026-09-07T20:42:48.085Z level=INFO msg="http: TLS handshake error from 100.64.189.22:64439: client sent an HTTP request to an HTTPS server"
time=2026-09-07T20:42:48.176Z level=INFO msg="http: TLS handshake error from 100.64.189.22:64444: client sent an HTTP request to an HTTPS server"
```

**No `-k`, no `--insecure`, no `--cacert`, no `NODE_TLS_REJECT_UNAUTHORIZED`, at
any point in this task.** Every TLS connection made here — curl, `openssl
s_client`, the CLI's own `fetch`, and the shim in §7.1 — validated the chain.

---

## 7. State survived the switch

Two independent proofs. Both ran inside single processes, so the throwaway store
keys existed only in those processes' environments and were never written to a
file.

### 7.1 The same `--message-id` returns the same `envelopeId` across the switch

This is the proof the task asked for, and it needs the same honest disclosure
`depr` needed. A profile's relay URL is fixed at `init` and there is no supported
way to repoint it, so the profile that writes the "before" envelope necessarily
carries `http://127.0.0.1:18443` — the SSH forward that was the only way to reach
`geekom`'s loopback relay from this Mac. After the switch that endpoint is gone.

The profile's URL was kept literally true by a 22-line local shim (`net` + `tls`,
in the session scratchpad) that accepts the loopback connection on this Mac and
carries the bytes to `geekom.tail5a88fb.ts.net:8443` over a **real TLS connection
with `rejectUnauthorized` at its default `true`** and the MagicDNS name as SNI.
It rejects an unauthorized peer explicitly (`if (!up.authorized) destroy`). It is
not a verification bypass — a bad chain makes it fail exactly as curl without
`-k` does — and it is used only for this one artifact. §7.2 reaches the same
conclusion over direct HTTPS with no shim at all.

```
===== BEFORE THE SWITCH (SSH forward → plain-HTTP loopback relay) =====
### G0 health   {"ok":true,"data":{"status":"healthy","uptime_ms":7474355}}
### G1 xa init  {"ok":true,"data":{"profile_id":"de59e786-…","identity_id":"ajEc-iEysavWFk_4HiNkbNwe9sBlpoFXYXU7tJJQWmQ","device_id":"eb0723b5-0652-5fe2-8e0e-f4613c65f52b","contact_count":0}}
    xb init     {"ok":true,"data":{"profile_id":"decf7994-…","identity_id":"hAeK9owYJNKf0AagLeP7K-rNLdw6D5meonP8Xo6BRnY","device_id":"31767eee-24a5-586d-a20c-e583f694df07","contact_count":0}}
    pre-g init  {"ok":true,"data":{"profile_id":"6b21af82-…","identity_id":"4J_ymq5E7fGCT_MUsWYfAqqmK3p79NpnjX1rNsfo1kI","device_id":"7e9bb800-b177-5f6e-a15f-a5b14bba8a52","contact_count":0}}
### G2 publish  {"stored":true,"bundleId":"276db0ad-a4a2-4ddf-a5a6-1edc62a89e86","claimable":true}   (xa)
                {"stored":true,"bundleId":"9122ec72-09af-4cb1-a87b-808e50c84bd3","claimable":true}   (xb)
                {"stored":true,"bundleId":"3037a0dd-51f3-4dcf-9957-3de1c9ca8746","claimable":true}   (pre-g)
### G3 export + import both ways: {"trusted":true} / {"trusted":true}
XBID=hAeK9owYJNKf0AagLeP7K-rNLdw6D5meonP8Xo6BRnY
XMID=8d6cc94c-5f06-4bb9-820b-47685bf40573
### G4 xa send --message-id $XMID
{"ok":true,"data":{"messageId":"8d6cc94c-5f06-4bb9-820b-47685bf40573",
                   "envelopeId":"201a419d-144d-44a3-9150-ab49b2edf328","status":"delivered"}}
### G5 xb poll        {"received":1,"more":false,"rejected":[]}
### G6 xb poll again  {"received":0,"more":false,"rejected":[]}

===== THE SWITCH =====
### G7 SSH forward 18443 → geekom:127.0.0.1:8443 closed
### G8 ./run-relay.sh env/geekom.env  →  started on 100.116.255.111:8443, scheme=https
### G9 https://geekom.tail5a88fb.ts.net:8443/health from this Mac, first attempt:
        {"ok":true,"data":{"status":"healthy","uptime_ms":161}}

===== AFTER THE SWITCH =====
### G11 health through the verifying shim   {"ok":true,"data":{"status":"healthy","uptime_ms":6438}}
### G12 xa sends the SAME --message-id
{"ok":true,"data":{"messageId":"8d6cc94c-5f06-4bb9-820b-47685bf40573",
                   "envelopeId":"201a419d-144d-44a3-9150-ab49b2edf328","status":"delivered"}}   <- SAME
### G13 xb poll   {"received":0,"more":false,"rejected":[]}                                     <- dedup record survived
```

**`envelopeId` `201a419d-144d-44a3-9150-ab49b2edf328` was issued by a relay
serving plain HTTP on `127.0.0.1` and returned, unchanged, by a relay serving
HTTPS on `100.116.255.111`.** Different container, different listener, different
scheme; the only thing they share is `echolet-relay-data`. Replaying that id can
come only from ciphertext stored on that volume before the switch, and
`received: 0` only from the dedup record stored beside it.

### 7.2 A bundle published before the switch, claimed after it over direct HTTPS

`xa` published bundle `276db0ad-a4a2-4ddf-a5a6-1edc62a89e86` **before** the
switch and nobody ever claimed it. After the switch, a fresh profile that has
only ever spoken to `https://geekom.tail5a88fb.ts.net:8443` — no shim, no
forward, no tunnel — imported `xa`'s card and sent to it. A first-contact send
must claim the recipient's published bundle from the relay:

```
### C1 mac3 init --relay-url https://geekom.tail5a88fb.ts.net:8443
{"ok":true,"data":{"profile_id":"00c350f8-…","identity_id":"6MGc0xjUMhGr5_J5yFkj41rYhIYY-pVxriEE0YhET24","device_id":"a172d73f-1f6b-58bd-8804-3bbd0b850070","contact_count":0}}  exit=0
### C2 mac3 relay publish   {"ok":true,"data":{"stored":true,"bundleId":"8f2b4b48-674b-41c9-80e2-ef233a2bd94d","claimable":true}}  exit=0
### C3 mac3 contact import <- xa's card
{"identity_id":"ajEc-iEysavWFk_4HiNkbNwe9sBlpoFXYXU7tJJQWmQ","device_id":"eb0723b5-0652-5fe2-8e0e-f4613c65f52b","device_pubkey":"yM_hMY8DzZi9DcUKDdat9vcLG5Gii0_DlnBNvSbwrZ0","signal_identity_key":"BenXQErrvSMRNhhLAbJjji9xueIe4ESv_KAiBDxQ8TB3"}
{"ok":true,"data":{"trusted":true}}   exit=0
### C4 mac3 -> xa   (claims xa's PRE-SWITCH bundle)
{"ok":true,"data":{"messageId":"10acdd85-c5e0-4279-81a3-17e115bd759e",
                   "envelopeId":"ccfdb616-7604-420f-8a78-26f7051bb349","status":"delivered"}}   exit=0
```

The device record and the claimable bundle behind that `delivered` were written
to the store by the **plain-HTTP** relay process and served by the **HTTPS** one.
This proof travelled over direct, verified TLS end to end.

---

## 8. Certificate renewal — automated, and proven to run

**Renewal on `geekom` is genuinely automated.** This is the thing `depr` still
lacks.

### 8.1 Why the committed units could not be used

`deploy/relay/systemd/echolet-cert-renew.{service,timer}` are written for a
root-owned layout and every one of their assumptions fails on this host:

| The committed unit needs | On `geekom` |
|---|---|
| Install into `/etc/systemd/system` | root — **unavailable** |
| `sudo systemctl edit` / `daemon-reload` / `enable` | root — **unavailable** |
| Write `/etc/echolet/tls/{cert,key}.pem` | root — **unavailable**, and that directory does not exist here |
| `chown 10001:10001` on the host | root — **unavailable** |
| Nothing about the Docker volume | the relay reads the pair from `echolet-relay-tls`, so rewriting a host path alone would never reach the container |

The committed units were left untouched. Nothing in `deploy/` was edited.

### 8.2 What is available to an unprivileged operator here, and what was chosen

Three candidates were examined against the before-state:

1. **`systemctl --user` timer** — `systemctl --user is-system-running` = `running`,
   and `loginctl show-user altsay` already reports **`Linger=yes`**, which was set
   before this task by another workload. Lingering means the user manager starts
   at boot and runs timers with no login session. **Chosen.**
2. **cron** — available (`/usr/bin/crontab`, 5 active entries). Rejected: the
   crontab belongs to unrelated workloads (`helyx-*`, `deprecated-*`, a
   FLOW-024 watchdog history), it has no journal, no `Persistent=true` catch-up
   after downtime, and no status surface. Editing a shared crontab that another
   system owns is the riskier change.
3. **A sidecar container with a restart policy** — rejected: it would add a
   second long-lived container to a host that must end with exactly one.

### 8.3 What was installed

Three files, all under `altsay`'s home, none in the repository and none in
`~/echolet-deploy` (so the host's copy of the committed tree stays byte-identical
to the repo):

```
/home/altsay/echolet-cert-renew/renew-cert.sh                     (0755)
/home/altsay/.config/systemd/user/echolet-cert-renew.service
/home/altsay/.config/systemd/user/echolet-cert-renew.timer
```

The timer mirrors the committed one (`OnCalendar=daily`,
`RandomizedDelaySec=6h`, `Persistent=true`). The service is the committed unit's
logic minus everything that needed root, plus the one step the committed unit
does not have and this deployment requires — **pushing the new bytes into the
volume the container actually reads**:

```sh
# ~/echolet-cert-renew/renew-cert.sh  (abridged)
IMG="$(docker inspect echolet-relay --format '{{.Config.Image}}')"   # follows upgrades
before="$(sha256sum "$DIR/cert.pem" | cut -d' ' -f1)"

/usr/bin/tailscale cert --cert-file "$DIR/cert.pem" --key-file "$DIR/key.pem" "$ECHOLET_TLS_HOSTNAME"
chmod 0644 "$DIR/cert.pem"; chmod 0600 "$DIR/key.pem"

docker run --rm --user 0 --entrypoint /bin/sh -v "$DIR":/src:ro -v "$VOL":/dst "$IMG" -c "
  cp /src/cert.pem /dst/cert.pem.new; cp /src/key.pem /dst/key.pem.new
  chown 10001:10001 /dst/cert.pem.new /dst/key.pem.new
  chmod 0644 /dst/cert.pem.new; chmod 0600 /dst/key.pem.new
  mv /dst/cert.pem.new /dst/cert.pem; mv /dst/key.pem.new /dst/key.pem"
```

Three deliberate choices in that script:

- **No `restart`, of the container or anything else.** The relay re-reads the
  pair by content digest within `ECHOLET_TLS_RELOAD_INTERVAL_SECONDS=60`. A
  renewal that restarted the relay would turn a routine event into the outage the
  reloader exists to prevent — the same reasoning the committed unit's comment
  gives.
- **Write to `.new` then `mv`.** `mv` within the volume is a rename, so a reader
  never sees a half-written file. The relay's documented behaviour on a
  mid-rewrite read is to keep the last good pair and log a warning; this makes
  that path unlikely to be needed at all.
- **The image is read from the running container**, not pinned. A relay upgrade
  cannot silently leave renewal pointing at a deleted tag. (There is a hardcoded
  fallback if the container is absent.)

### 8.4 Proof that it runs

```
$ systemctl --user list-timers echolet-cert-renew.timer --all
NEXT                        LEFT  LAST PASSED  UNIT                      ACTIVATES
Tue 2026-09-08 03:58:28 UTC  7h   -    -       echolet-cert-renew.timer  echolet-cert-renew.service

$ systemctl --user is-enabled echolet-cert-renew.timer   ->  enabled
$ systemctl --user is-active  echolet-cert-renew.timer   ->  active
$ ls -l ~/.config/systemd/user/timers.target.wants/
echolet-cert-renew.timer -> /home/altsay/.config/systemd/user/echolet-cert-renew.timer
$ loginctl show-user altsay   ->  State=active  Linger=yes
```

And it was **run once, end to end, for real**:

```
$ systemctl --user start echolet-cert-renew.service      start_exit=0

● echolet-cert-renew.service - Renew the Echolet relay's tailnet TLS certificate (unprivileged, user scope)
     Active: inactive (dead) since Mon 2026-09-07 20:44:27 UTC
TriggeredBy: ● echolet-cert-renew.timer
    Process: 2001938 ExecStart=/home/altsay/echolet-cert-renew/renew-cert.sh (code=exited, status=0/SUCCESS)

Starting echolet-cert-renew.service …
Public cert unchanged at /home/altsay/echolet-tls/cert.pem
Private key unchanged at /home/altsay/echolet-tls/key.pem
echolet-cert-renew: no change (certificate still current); notAfter=Dec  6 19:39:57 2026 GMT; volume digest=6d25a68f5e1dd883c63b1e35833b78752e22b58b8a88cfeeb5732ad25a816669
Finished echolet-cert-renew.service …
```

**No Let's Encrypt request was made.** The serial is identical before and after
the run — `05A82BF9667A1EFEE1709DAAD9EF83F0F15B` both times — which is exactly the
"a no-op while the certificate has plenty of life left" behaviour the committed
unit's comment relies on, now demonstrated rather than assumed. The duplicate
budget was not touched by proving the timer works.

The volume was rewritten by the run and the relay kept serving throughout:

```
volume after the run:
-rw-r--r-- 1 10001 10001 4837 Sep  7 20:44 cert.pem
-rw------- 1 10001 10001  227 Sep  7 20:44 key.pem
cert sha256: 6d25a68f5e1dd883c63b1e35833b78752e22b58b8a88cfeeb5732ad25a816669
key readable by 10001: yes

relay: restarts=0  started=2026-09-07T20:41:12.586657673Z  health=healthy
strays: containers_all=33  volumes_all=867  dangling=856   (unchanged)
```

### 8.5 The new bytes reach the path the container sees

The task's requirement, checked directly against the **running** container rather
than inferred:

```
$ docker exec echolet-relay sha256sum /etc/echolet/tls/cert.pem
6d25a68f5e1dd883c63b1e35833b78752e22b58b8a88cfeeb5732ad25a816669  /etc/echolet/tls/cert.pem
$ docker exec echolet-relay ls -ln /etc/echolet/tls
-rw-r--r--  1 10001 10001 4837 Sep  7 20:44 cert.pem
-rw-------  1 10001 10001  227 Sep  7 20:44 key.pem
```

Timestamp `20:44` is the renewal run's write, not the `20:39` install — so the
running relay's mount namespace sees what the renewal script wrote, at the same
inode, with the right ownership and the key still `0600`. That is the link the
committed unit never had on this host, and it is now closed.

### 8.6 What is still not proven, honestly

**The relay's in-process reloader has still never been exercised on either
host.** Proving it means making the certificate content actually change, which
means re-issuing, and Let's Encrypt rate-limits duplicates at roughly five per
week for one name. §8.5 proves the *delivery* half (new bytes, new mtime, correct
owner and mode, visible inside the running container); the *pickup* half rests on
`apps/cli/test/e2e/relay-tls.test.ts` ("picks up a renewed certificate without a
restart") and on the code, not on an observation from this host. Recorded as a
gap rather than risked for a demonstration — the same call `depr` made, for the
same reason.

Two further limits worth stating plainly:

- **A reboot was not performed**, so "the timer comes back after a reboot" rests
  on `Linger=yes` + the `timers.target.wants` symlink being present, which is the
  documented mechanism, not on an observed boot.
- The first *real* renewal will happen around early December 2026. Until then
  every daily run is the no-op §8.4 shows.

---

## 9. Redaction

- **No private key, no store key, no plaintext body and no HTTP request body
  appears anywhere in this report.** The certificate's private key was never
  read, never printed, never copied off `geekom`; only its size (227 bytes), mode
  (`0600`), owner, and its `-----BEGIN EC PRIVATE KEY-----` header line were
  recorded. The container's log contains zero occurrences of `PRIVATE KEY`; the
  relay logs the certificate *paths* and never their contents.
- Every demo store key was generated with `crypto.randomBytes(32)` directly into
  an environment variable of the process that used it, never written to a file,
  never printed, and is gone with that process. An earlier draft of the
  pre-switch script would have persisted the keys to a scratch file so a second
  process could reuse the profiles; it was discarded unrun, and the whole
  before/after sequence was restructured into one process instead.
- No message body is reproduced. The bodies used were the synthetic sentinels
  `GEEKOMTLSPROOF before` and `GEEKOMTLSPROOF claim2`, written for this task.
- The identifiers quoted — `identity_id`, `device_id`, `device_pubkey`,
  `signal_identity_key`, `profile_id`, `bundleId`, `messageId`, `envelopeId`, and
  the certificate's serial — are public protocol identifiers and public
  certificate metadata, belonging to throwaway profiles that have been deleted.
- `env/geekom.env` on the host holds an image tag, a tailnet address, a volume
  name, a callsign and bounds. It contains no secret and, per the template's own
  header, may never come to.

---

## 10. What failed, what was awkward, and what is still open

1. **The first attempt at the direct-HTTPS claim proof failed, twice, and the
   second failure destroyed the artifact it was testing.** The first send
   (`mac -> pre-g`) returned `{"ok":false,"error":{"code":"UNAUTHORIZED_MAILBOX_ACCESS"}}`,
   exit 3, because I had `init`ed the sender but never run `relay publish` — the
   relay will not accept a mailbox deposit from a device it has no record of.
   That is correct relay behaviour and my scripting error. **But the retry, with
   the sender properly published, then returned
   `{"ok":false,"error":{"code":"PREKEY_BUNDLE_UNAVAILABLE"}}`** — because the
   *failed* first send had already claimed and consumed `pre-g`'s one-time
   bundle. **The claim is not rolled back when the subsequent mailbox deposit
   fails.** That is a genuine observation about the relay worth recording: a
   failed first-contact send can burn the recipient's claimable bundle. The proof
   was completed with `xa`'s pre-switch bundle, which was still unclaimed (§7.2);
   no re-issuance of anything was needed.
2. **The relay's certificate hot-reload is still unproven on a real host** —
   §8.6. Delivery into the container's path is proven; pickup is not.
3. **`docker-compose.yml` still cannot perform this deployment** (§3.3),
   re-confirmed on `geekom`. Unchanged finding, unchanged file.
4. **`pkill`/`pgrep` in the switch script misfired on macOS.** The status line
   printed a `pgrep` usage error instead of a count. The forward *was* closed —
   independently confirmed afterwards (`ps aux | grep 'ssh .*-L'` → none) — but
   the script's own confirmation line was useless. Cosmetic; recorded because the
   transcript in §7.1 shows the error.
5. **The SSH forward `18443 → geekom:127.0.0.1:8443` is closed and gone.** Its
   target no longer exists after the switch. It was closed deliberately as part
   of the switch, exactly as `depr`'s `18444` forward was. There are now **no SSH
   forwards to either host on this Mac** — neither is needed any more, since both
   relays are reachable directly over the tailnet on HTTPS.
6. **The runbook's §4 recipe does not work on this host** and now has a second,
   materially different route (§3.2 and §8.3). Neither the runbook nor the
   committed systemd units were edited — that would be a committed artifact — so
   this report is currently the only place the unprivileged route is written
   down. Worth folding into `deployment-runbook.md` §4 as a "hosts without root"
   branch, and into `deploy/relay/systemd/` as a user-scope variant.
7. **`~/echolet-tls` on `geekom` is mode `0700`, but `~/echolet-cert-renew` is
   `0775`** (the default umask). Only the key's own `0600` matters for secrecy
   and the key is not in that directory — but the asymmetry is noted rather than
   quietly left.
8. **Nothing else failed.** The certificate issued on the first attempt without
   sudo, the volume populated on the first attempt, `run-relay.sh` started the
   TLS relay on the first attempt, HTTPS health answered from this Mac on the
   first poll (`uptime_ms: 161`), and the renewal service succeeded on its first
   run.

---

## 11. Teardown and rollback

**Roll back to the loopback-only deployment** (the state before this task), on
`geekom`, no sudo needed:

```sh
cd ~/echolet-deploy
./run-relay.sh env/insecure-loopback.env    # already present, ECHOLET_IMAGE=echolet-relay:20260907-a2f07bb
docker ps --filter name=echolet-relay --format '{{.Status}}\t{{.Ports}}'
# expect: Up N seconds (healthy)  127.0.0.1:8443->8443/tcp
```

The data volume is untouched by either direction, so state crosses back exactly
as it crossed forward. Reaching it from this Mac then needs the forward again:
`ssh -o ExitOnForwardFailure=yes -f -N -L 18443:127.0.0.1:8443 geekom`.

**Roll back to the previous image**, keeping TLS:

```sh
sed -i 's|^ECHOLET_IMAGE=.*|ECHOLET_IMAGE=echolet-relay:20260907-c302485-dirty|' env/geekom.env
./run-relay.sh env/geekom.env
```
(but see runbook §11: rolling back past the transcript change breaks new clients.)

**Stop and remove the renewal automation** (no sudo):

```sh
systemctl --user disable --now echolet-cert-renew.timer
rm -f ~/.config/systemd/user/echolet-cert-renew.{service,timer}
systemctl --user daemon-reload
rm -rf ~/echolet-cert-renew
```

**Remove the TLS deployment entirely** (no sudo anywhere):

```sh
docker rm -f echolet-relay
docker volume rm echolet-relay-tls        # the certificate pair inside the volume
rm -rf ~/echolet-tls                      # the host copy of the pair
rm -f  ~/echolet-deploy/env/geekom.env    # not committed; holds no secret
# the data volume is deliberately NOT removed:
#   docker volume rm echolet-relay-data   # DESTROYS all relay state — only if you mean it
```

**On this Mac:** nothing to clean up. The throwaway profile directories under
`/tmp/echolet-geekom-*` were removed, the TLS shim was stopped, the `geekom` SSH
forward was closed, and no image, container or file was created outside the
session scratchpad and this report.

**Give `depr` the same renewal.** `depr` has passwordless sudo, so the committed
units work there as written — runbook §4's five lines, unchanged. `depr` reads
its pair from `/etc/echolet/tls` (a host bind mount), so it needs no
volume-refresh step and the committed unit is sufficient. That remains open; this
task did not touch `depr`.

---

## 12. Current state

| | `geekom` | `depr` (read-only comparison) |
|---|---|---|
| Container | `echolet-relay`, `2207fce6eb29…`, `Up (healthy)`, `RestartCount=0` | unchanged, untouched |
| Image | `echolet-relay:20260907-a2f07bb` (`sha256:83497194…`) | same |
| Published on | **`100.116.255.111:8443`** — tailnet address, not loopback | `100.100.188.64:8443` |
| Scheme | **`https`**, pair read from `/etc/echolet/tls`, mounted read-only | `https` |
| Certificate source | **named volume `echolet-relay-tls`** (no host root needed) | host bind `/etc/echolet/tls` (root) |
| Certificate | Let's Encrypt `CN=geekom.tail5a88fb.ts.net`, issuer `CN=YE1`, **`Sep 7 2026 → Dec 6 2026`** | `CN=YE2`, `Sep 7 2026 → Dec 6 2026` |
| Label | `echolet.tls=enabled` | `echolet.tls=enabled` |
| Data volume | `echolet-relay-data`, created `17:41:42Z`, carried across three container generations | its own, carried |
| Callsign | `RPT-GEEKOM-01` | `RPT-DEPR-01` |
| `/health` from this Mac | `200`, `ssl_verify_result=0`, `remote_ip=100.116.255.111` | `200`, `ssl_verify_result=0`, `remote_ip=100.100.188.64` |
| Plain HTTP on that port | `400 Bad Request` — "Client sent an HTTP request to an HTTPS server." | same |
| Plain HTTP on loopback | **gone — `curl exit 7`, no socket** | gone |
| **Renewal** | **AUTOMATED — `systemctl --user` timer, enabled + active, lingering, next `2026-09-08 03:58 UTC`, run once with exit 0** | **NONE — still expires 6 Dec 2026 with nothing to renew it** |
| Strays | 33 containers / 867 volumes / 856 dangling — **+1 volume, the TLS volume, by design**; one `echolet-relay` container | untouched |
| Sudo used | **none** | none by this task |

Both relays in the fleet now serve HTTPS on their tailnet addresses. `depr` was
read exactly once, over HTTPS (`http_code=200 ssl_verify_result=0
remote_ip=100.100.188.64`), and was otherwise not contacted, not logged into and
not modified.

---

## 13. The renewal question, answered plainly

**On `geekom`: renewal IS automated.** A `systemctl --user` timer, owned by
`altsay`, enabled and active, under a user manager that lingers, scheduled daily
with a 6-hour jitter and `Persistent=true`. It was executed once end to end and
exited `0`, it rewrote the certificate pair inside the Docker volume the relay
reads, the running container sees those bytes at `/etc/echolet/tls`, it did not
restart the relay, and it made no Let's Encrypt request (the serial is unchanged).
No root was needed for any of it, at install or at run time.

The one thing that remains unproven is the relay's *own* reloader picking up
genuinely new content, because forcing that means re-issuing into a rate limit
(§8.6). Delivery is proven; pickup is covered by an automated test and by code
reading, not by an observation on this host.

**On `depr`: renewal is still NOT automated**, unchanged from `t11-tls-report.md`
§11.2. Its certificate expires **6 December 2026** and nothing on that host
renews it. The commands are in §11; they are five lines and they need the
passwordless sudo `depr` already has.

---

## Routing audit

- `graph_used`: **no** — *not relevant*. No structural "where does X live / what
  breaks if I change Y" question arose; no repository code was navigated or
  changed. The authoritative sources were named directly by the task.
- `wiki_used`: **no** — *not relevant*. This was operating one server against a
  written runbook. The in-repo sources (`deployment-runbook.md` §3.1–§6,
  `runbook.md` §1–§8, `deploy/relay/run-relay.sh`,
  `deploy/relay/env/geekom.env.example`,
  `deploy/relay/systemd/echolet-cert-renew.{service,timer}`, and the three prior
  T11 reports) were read directly.
- `ctx_used`: **partial**. `keryx ctx rg` for the in-repo searches (the CLI flag
  shapes in `runbook.md`, the `geekom` references in the deployment report) and
  `keryx ctx run` for a local command. Remote host output arrives over SSH from
  another machine and cannot be routed through gdctx, so it was captured to
  session scratch files and read from there — the same objective by a different
  mechanism.
- `raw_rg_used`: **no** over project code. Commands carrying a `keryx:raw` escape
  marker with a stated reason: remote host output over SSH, this Mac's own
  process list, heading-offset extraction from two large in-repo reports so only
  the relevant sections were read, and the live CLI / TLS transcripts that had to
  be captured verbatim for this report. None searched project code.

## Files written

- This report — the only write inside the repository.
- `.metaproject/data/gdctx/raw/…` and `.metaproject/data/gdctx/artifacts/…` —
  created automatically by the routed `keryx ctx` invocations.
- On `geekom`: `~/echolet-tls/{cert.pem,key.pem}`,
  `~/echolet-deploy/env/geekom.env` (not committed, holds no secret),
  `~/echolet-cert-renew/renew-cert.sh`,
  `~/.config/systemd/user/echolet-cert-renew.{service,timer}` and the
  `timers.target.wants` symlink, plus the Docker volume `echolet-relay-tls`.
- Scratch outside the repository, in the session scratchpad: `before-geekom.sh`,
  `issue-cert.sh`, `populate-tls-volume.sh`, `prep-env.sh`, `cross-switch.sh`,
  `tls-shim.js`, `claim-proof.sh`, `claim-proof2.sh`, `verify-mac.sh`,
  `after-geekom.sh`, `install-renewal.sh`, `prove-renewal.sh`, `final-check.sh`,
  their logs, and `pg-card.json`. Throwaway profile directories under
  `/tmp/echolet-geekom-*`, all removed.

**No source file, no test file and no committed deployment artifact was changed.
No `sudo` was run on `geekom`. `depr` was read once over HTTPS and not otherwise
touched. The `echolet-relay-data` volume was not deleted and not recreated.**
