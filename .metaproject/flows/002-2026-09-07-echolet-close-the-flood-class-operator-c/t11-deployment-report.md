# T11 — Deployment report: two relays on `geekom` and `depr`, and a real two-machine exchange

Date: 2026-09-07 (deployment 17:31–17:55 UTC)
Source tree: `c302485`. The image's build context (`apps/relay`) is clean against HEAD; the working tree's only modifications are documentation and flow metadata (see "The `-dirty` tag" below).
Scope: **write**. Two containers, one named volume and one image were created on each host. Nothing else on either host was written, installed, enabled or configured. No `sudo` was used on either host. No Tailscale setting was touched and no `tailscale cert` was run. No firewall rule was added. No source file and no test file in the repository was changed.

---

## 0. What was actually decided, and why the prepared artifacts were not used verbatim

The tailnet's **HTTPS Certificates** toggle is off (`CertDomains: null` on both hosts — see [t11-host-recon.md](t11-host-recon.md) §G0), the admin console is unreachable from this network, and the relay does not degrade to plain HTTP: with `ECHOLET_TLS_CERT_FILE`/`ECHOLET_TLS_KEY_FILE` set and no certificate on disk it exits non-zero at startup. The user chose port **8443** and **deployment without TLS on each host's loopback** rather than wait for the toggle.

That choice makes both prepared start paths unusable **as written**, and neither may be edited under this task's constraints:

| Artifact | Why it could not be used as-is |
|---|---|
| `deploy/relay/docker-compose.yml` | Hard-codes `ECHOLET_TLS_CERT_FILE` / `ECHOLET_TLS_KEY_FILE` in `environment:` and requires `ECHOLET_TLS_DIR` as a `?`-marked mandatory bind mount. With no certificate pair, the relay it starts exits at startup. |
| `deploy/relay/run-relay.sh` | `require ECHOLET_TLS_DIR` fails hard, and it always passes the two TLS env vars. It also `require`s a non-loopback `ECHOLET_BIND_ADDR` — correctly, since on the intended deployment the bind address *is* the access control. |

So the container was started with a plain `docker run` that **reproduces `run-relay.sh`'s hardening line for line** — `--user 10001:10001`, `--read-only`, `--tmpfs /tmp:size=16m,mode=1777`, `--security-opt no-new-privileges:true`, `--cap-drop ALL`, `--restart unless-stopped`, json-file logging capped at `20m`×`5` — and differs from it in exactly three deliberate places:

1. **no TLS env vars at all** (both-or-neither: omitting both is the documented way to get plain HTTP);
2. **`-p 127.0.0.1:8443:8443`** instead of the tailnet IPv4, so the relay is reachable only from the host itself;
3. **`-v echolet-relay-data:/var/lib/echolet`** — a named Docker volume instead of a `/var/lib/echolet` bind mount, because creating and `chown`ing that path needs root and `geekom`'s `altsay` has password-gated `sudo`.

Together those three keep the whole deployment inside the `docker` group on both hosts. Nothing in `/etc`, nothing in `/var/lib` outside Docker's own tree, no systemd unit, no firewall change.

**The relay confirms the scheme in its own startup line**, which is the cleanest possible evidence that TLS is off deliberately rather than by accident:

```
time=2026-09-07T17:41:42.648Z level=INFO msg="Starting relay server" addr=0.0.0.0:8443 scheme=http tls_cert_file="" tls_key_file=""
```

---

## 1. The image

Built on this Mac (arm64) for **linux/amd64**, cross-compiled by the Dockerfile's `--platform=$BUILDPLATFORM` build stage — no emulation.

```sh
./deploy/relay/build-image.sh --mirror gcr --save <scratch>/echolet-relay.tar
```

`--mirror gcr` was passed because the same rate-limit conditions the script's header records still apply; it changes only the registry host in front of the two **digest-pinned** base images, so the resulting image is byte-identical to a Docker Hub build.

```
==> built echolet-relay:20260907-c302485-dirty
    id=sha256:4f2957eec2ed754d4275dec67fdf662ad66ae2124fea4e369289f372478a9389
    arch=linux/amd64
    size=21310733 bytes
==> saving to <scratch>/echolet-relay.tar
-rw-------  1 Goodea  wheel  21630464  <scratch>/echolet-relay.tar
==> sha256 of the tarball (compare it after transfer):
cc315ee2b18021c82b6fca02f9c07572de880ffe99d668df57f94706fb0acce2
```

**Tag: `echolet-relay:20260907-c302485-dirty`.**

### The `-dirty` tag, and what it does and does not mean here

`build-image.sh` appends `-dirty` when `git status --porcelain` is non-empty anywhere in the repository. It is non-empty at `c302485`, but **only in documentation and flow metadata**:

```
 M .metaproject/flows/002-…/flow.json
 M .metaproject/flows/002-…/journal.md
 M docs/STATUS_CURRENT.md
 M docs/requirements/echolet-cli-prototype/README.md
 M docs/requirements/echolet-cli-prototype/deployment-runbook.md
 M docs/requirements/echolet-cli-prototype/runbook.md
?? .metaproject/flows/002-…/dispatches/002-T10-verify-r3-result.json
?? .metaproject/flows/002-…/t10-verification-report-r3.md
```

**The build context is clean.** `git status --porcelain -- apps/relay` and `git diff --stat HEAD -- apps packages` are both empty, so every byte the Dockerfile copies is exactly what `git checkout c302485` produces. Together with the two digest-pinned base images, this image **is** reproducible from `c302485` — the `-dirty` suffix here is a false alarm raised by edits to files that never enter the build.

That is worth recording precisely because the script's own header argues the opposite case, and it is right to: `-dirty` is not a warning to silence. In this instance the check is coarser than the claim it is protecting, and the narrower check (`git status --porcelain -- apps/relay`) was run and came back clean. Anyone reproducing this image should re-run that narrower check rather than trust the tag either way.

### Transfer, and how identity was verified on each host

```sh
gzip -c <scratch>/echolet-relay.tar | ssh geekom 'gunzip | docker load'
gzip -c <scratch>/echolet-relay.tar | ssh depr   'gunzip | docker load'
```

```
Loaded image: echolet-relay:20260907-c302485-dirty     (geekom)
Loaded image: echolet-relay:20260907-c302485-dirty     (depr)
```

`docker image inspect --format '{{.Id}}'`:

| Where | Image `.Id` |
|---|---|
| this Mac | `sha256:4f2957eec2ed754d4275dec67fdf662ad66ae2124fea4e369289f372478a9389` |
| `geekom` | `sha256:c887eb4562801aac4307189a24a801468e104447b17522312bf6002c9f43c0de` |
| `depr` | `sha256:c887eb4562801aac4307189a24a801468e104447b17522312bf6002c9f43c0de` |

**The two hosts match each other exactly. The Mac's id differs, and that difference is an artifact of `docker save`/`docker load`, not of the image.** The `.Id` is the digest of the image *config blob*, and this Mac's engine (Docker Desktop/OrbStack 28.4.0 client, 29.4.0 server) exports an OCI-format config which the hosts' engines re-serialise into the classic Docker schema on load, producing a different config digest for the same image. Three independent content checks confirm the image itself is identical everywhere:

**a. All four filesystem layer digests are identical on all three machines.** These are content hashes of the uncompressed layer tars, so equality here means the container filesystem is bit-for-bit the same:

```
["sha256:6f09edfb3f6d7173733adc8eec8ea00626550dc6fc2dcf07d40e13f5c1e907c4",
 "sha256:01d699b3f2d8ec7adf5b88b76f78164e517fa482e16eedb752f87aae724c6921",
 "sha256:eca0e899485974d19e28a372ec82864ab871f5a82848a076879cba05f96bdea1",
 "sha256:5f70bf18a086007016e948b04aed3b82103a36bea41755b6cddfaf10ace3c6ef"]
```

**b. The image `.Config` (entrypoint, env, user, exposed ports, volumes, labels, healthcheck) is byte-identical** — `diff` of the Mac's and `geekom`'s `{{json .Config}}` reports no difference.

**c. The relay binary extracted from the image hashes the same on all three:**

```sh
cid=$(docker create echolet-relay:20260907-c302485-dirty)
docker cp "$cid:/usr/local/bin/relay" ./relay-check
docker rm "$cid"
sha256sum ./relay-check
```

| Where | sha256 of `/usr/local/bin/relay` |
|---|---|
| this Mac | `317e05d5e5350aa5b043b2c7520de9942d7b2107068c230f997adc3a8eb7c1e4` |
| `geekom` | `317e05d5e5350aa5b043b2c7520de9942d7b2107068c230f997adc3a8eb7c1e4` |
| `depr` | `317e05d5e5350aa5b043b2c7520de9942d7b2107068c230f997adc3a8eb7c1e4` |

**Both hosts run the same binary, built from this tree, for linux/amd64.** Use `.RootFS.Layers` — not `.Id` — when comparing an image across a `docker save`/`load` boundary between engines with different image stores.

---

## 2. Exact commands run on each host

Identical on both except the callsign. Delivered over SSH as `ssh <host> 'bash -s' -- <image> <callsign> < start-relay.sh`.

```sh
docker volume create echolet-relay-data

docker run -d \
  --name echolet-relay \
  --restart unless-stopped \
  --user 10001:10001 \
  --read-only \
  --tmpfs /tmp:size=16m,mode=1777 \
  --security-opt no-new-privileges:true \
  --cap-drop ALL \
  --log-driver json-file --log-opt max-size=20m --log-opt max-file=5 \
  -p 127.0.0.1:8443:8443 \
  -v echolet-relay-data:/var/lib/echolet \
  -e ECHOLET_HTTP_ADDR=0.0.0.0:8443 \
  -e ECHOLET_DATA_DIR=/var/lib/echolet \
  -e ECHOLET_LOG_LEVEL=info \
  -e ECHOLET_NODE_CALLSIGN=RPT-GEEKOM-01 \        # RPT-DEPR-01 on depr
  -e ECHOLET_MAILBOX_TTL_HOURS=168 \
  -e ECHOLET_MAX_MESSAGE_BYTES=262144 \
  -e ECHOLET_MAX_MAILBOX_BATCH=100 \
  -e ECHOLET_MAX_UNACKED_ENVELOPES_PER_SENDER=16 \
  -e ECHOLET_RATE_LIMIT_PER_MINUTE=120 \
  -e ECHOLET_CHALLENGE_TTL_SECONDS=60 \
  -e ECHOLET_CLEANUP_INTERVAL_SECONDS=60 \
  -e ECHOLET_MAX_STORAGE_BYTES=2147483648 \
  echolet-relay:20260907-c302485-dirty
```

`ECHOLET_NODE_CALLSIGN` and every bound above are the values the host env templates already carry; the two bounds the flood closure sized against each other (`ECHOLET_MAX_UNACKED_ENVELOPES_PER_SENDER=16`, `ECHOLET_MAX_MAILBOX_BATCH=100`) are **identical on both hosts**, as required.

The named volume is created empty and Docker seeds it from the image's `/var/lib/echolet`, which the Dockerfile already `chown`s to `10001:10001` — so a `--user 10001:10001` container owns its data directory with no host-side `chown` and no root.

### `geekom`

```
f84087dede5cb0fb5876dabe38e4d026e93dfa05418d1de10b4274b6d36d5d8a
--- docker ps ---
echolet-relay echolet-relay:20260907-c302485-dirty Up 3 seconds (health: starting) 127.0.0.1:8443->8443/tcp
--- health ---
{"ok":true,"data":{"status":"healthy","uptime_ms":3015}}
--- ss 8443 ---
LISTEN 0      4096                     127.0.0.1:8443       0.0.0.0:*
```

### `depr`

```
b53a950c08f7c963091e2968b371d536f0a53ec42993b452e7d2e2d6ec23076a
--- docker ps ---
echolet-relay echolet-relay:20260907-c302485-dirty Up 3 seconds (health: starting) 127.0.0.1:8443->8443/tcp
--- health ---
{"ok":true,"data":{"status":"healthy","uptime_ms":3042}}
--- ss 8443 ---
LISTEN 0      4096                     127.0.0.1:8443       0.0.0.0:*
```

### Health, current, from each host

```
geekom:  {"ok":true,"data":{"status":"healthy","uptime_ms":613924}}
depr:    {"ok":true,"data":{"status":"healthy","uptime_ms":1050469}}
```

Docker's own healthcheck agrees on both: `Up N minutes (healthy)`. The `HEALTHCHECK` in the image tries HTTPS first and falls back to HTTP, so it succeeds here on the fallback arm — worth knowing, because on a TLS deployment a green healthcheck is proving something different.

### The loopback binding is real, checked from off-host

From this Mac, over the tailnet, to each host's tailnet IPv4:

```
100.116.255.111:8443 -> http_code 000, curl exit 7 (connection refused)
100.100.188.64:8443  -> http_code 000, curl exit 7 (connection refused)
```

Refused, not filtered — nothing is listening on the tailnet address. `ss -ltn` on each host shows a single `127.0.0.1:8443` socket. Docker's published-port DNAT is evaluated before ufw's INPUT chain, so this binding — not a firewall rule — is what confines the relay, exactly as `run-relay.sh` and `docker-compose.yml` both warn.

---

## 3. Restart survival (`geekom`)

Performed in the middle of the live scenario, so the "prior state is intact" claim is made against state the scenario itself had just written.

```
-- volume before:
echolet-relay-data /var/lib/docker/volumes/echolet-relay-data/_data local
-- docker stop echolet-relay
echolet-relay Exited (2) Less than a second ago
-- docker start echolet-relay
echolet-relay Up 4 seconds (health: starting)
-- health on the host after restart:
{"ok":true,"data":{"status":"healthy","uptime_ms":4023}}
```

and through the tunnel from this Mac:

```
{"ok":true,"data":{"status":"healthy","uptime_ms":6079}}
```

The container's own log shows the two boots against the same volume:

```
time=2026-09-07T17:41:42.648Z level=INFO msg="BadgerDB opened" dir=/var/lib/echolet
time=2026-09-07T17:41:42.648Z level=INFO msg="Cleanup service started" interval_sec=60
time=2026-09-07T17:41:42.648Z level=INFO msg="Starting relay server" addr=0.0.0.0:8443 scheme=http tls_cert_file="" tls_key_file=""
time=2026-09-07T17:41:56.711Z level=INFO msg="BadgerDB opened" dir=/var/lib/echolet
time=2026-09-07T17:41:56.711Z level=INFO msg="Cleanup service started" interval_sec=60
time=2026-09-07T17:41:56.711Z level=INFO msg="Starting relay server" addr=0.0.0.0:8443 scheme=http tls_cert_file="" tls_key_file=""
```

**Health answering after a restart proves only that a relay is running.** The evidence that the *data* survived is steps 20 and 21 of the scenario below: the same `--message-id` retried **after** the restart returns the **same `envelopeId`** issued before it, and the recipient's next poll still receives `0`. Both answers can only come from the relay's stored ciphertext and its dedup record, and both were written before the stop. The volume persisted.

**One finding: `docker stop` reports `Exited (2)`, not `Exited (0)`.** The relay does not exit cleanly on SIGTERM. Nothing was lost — Badger's data survived intact, as steps 20–21 show — but a non-zero exit on an ordinary stop is a real rough edge: it makes `restart: unless-stopped` / `on-failure` policies and any supervisor that keys off exit status treat a normal operator stop as a crash. Not fixed here (no source change permitted under this task); recorded for the flow.

---

## 4. The two-machine exchange

### How the remote relay was reached, and why

The CLI **refuses a non-loopback relay URL that is not HTTPS**. That refusal is the product working, and it was not bypassed. It was confirmed live at the end of the scenario:

```sh
node dist/cli.js init --relay-url "http://100.116.255.111:8443" --store-key-env ECHOLET_E2E_KEY --profile <p> --json
```
```json
{"ok":false,"error":{"code":"INVALID_CONFIGURATION"}}
```
exit `2`.

So the remote relay was brought onto this Mac's own loopback with an SSH local forward:

```sh
ssh -N -L 18443:127.0.0.1:8443 geekom     # geekom's relay  -> http://127.0.0.1:18443
ssh -N -L 18444:127.0.0.1:8443 depr       # depr's relay    -> http://127.0.0.1:18444
```

(The task's example used local port `8443`; `18443`/`18444` were used instead only to avoid colliding with anything on this Mac and to run both tunnels at once. It is the same construction — a loopback listener on this machine forwarding into SSH.)

Both CLI profiles then addressed `http://127.0.0.1:18443`, which the CLI accepts because it *is* loopback. **Every byte between this Mac and `geekom` travelled inside the SSH connection.** That is SSH's encryption, not the relay's — see §6.

### Setup

- Relay: `geekom`, the container above, reached through the tunnel.
- Client: this Mac, real built `apps/cli/dist/cli.js`, Node v26.5.0 (the default non-login interpreter; `bash -lc` here starts v22.12.0, which lacks `node:sqlite`).
- Two profiles, `alice` and `bob`, in a fresh `mktemp -d`. Each profile's 32-byte store key was generated fresh with `crypto.randomBytes(32)` into a shell variable and **never written to a file, never printed and never recorded here**. Every CLI invocation is a separate process, so each step also exercises restart recovery on the client side.
- The volume on `geekom` was recreated empty immediately before this run, so the transcript below is one clean, uninterrupted run.

### Transcript (observed JSON, verbatim except where marked)

```
### 0. /health through the SSH tunnel (relay is on geekom)
{"ok":true,"data":{"status":"healthy","uptime_ms":9017}}

### 1. alice init --relay-url http://127.0.0.1:18443
{"ok":true,"data":{"profile_id":"090d185d-198e-455c-9334-e3606275f32e","identity_id":"I2Qhnk8Z38iclE-sUlFTz-pmSGXgWLD4tklF8rA4gJQ","device_id":"b84203a7-65a0-5720-97b2-9f95e7d4802d","contact_count":0}}
exit=0

### 2. bob init --relay-url http://127.0.0.1:18443
{"ok":true,"data":{"profile_id":"b06c23c9-2f71-4cd9-9231-aa6c121f49a3","identity_id":"m9H-5O9mPoXvDyhQDTDx7ghemOy3eikx02otly4G9-o","device_id":"287a3452-603d-56f0-937b-b5a6ac60cc61","contact_count":0}}
exit=0

### 3. alice relay publish
{"ok":true,"data":{"stored":true,"bundleId":"24e4d903-3511-4981-9369-e1e9945069bc","claimable":true}}
exit=0

### 4. bob relay publish
{"ok":true,"data":{"stored":true,"bundleId":"4f9beece-5ed0-4fce-a92f-c782cc4dae92","claimable":true}}
exit=0

### 5. contact export (both)
{"ok":true,"data":{"exported":true}}
exit=0
{"ok":true,"data":{"exported":true}}
exit=0

### 6. alice contact import <- bob's card
{"identity_id":"m9H-5O9mPoXvDyhQDTDx7ghemOy3eikx02otly4G9-o","device_id":"287a3452-603d-56f0-937b-b5a6ac60cc61","device_pubkey":"gtardnjC7KHw2x_YaiI7nU2g3bReGeav1eQhAP49ye8","signal_identity_key":"BSwl3yxox8JxLMVmK4ZZFii1sDiDUuNPLTI1hMCrAvZU"}
{"ok":true,"data":{"trusted":true}}
exit=0

### 7. bob contact import <- alice's card
{"identity_id":"I2Qhnk8Z38iclE-sUlFTz-pmSGXgWLD4tklF8rA4gJQ","device_id":"b84203a7-65a0-5720-97b2-9f95e7d4802d","device_pubkey":"V4rHwmTF-TzSOfpjrsdXuVKl9H7TUFKWz8lIaBgp9Og","signal_identity_key":"Bauoh865lNDTj482QfZxnyUvsp76ZQk5sKD1am375DlH"}
{"ok":true,"data":{"trusted":true}}
exit=0

BID=m9H-5O9mPoXvDyhQDTDx7ghemOy3eikx02otly4G9-o
AID=I2Qhnk8Z38iclE-sUlFTz-pmSGXgWLD4tklF8rA4gJQ
```

The four identifiers each `contact import` prints are the ones a human is required to compare before trust is recorded, and import is the only operation that creates Echolet trust. The values printed above are public identifiers, not key material.

```
### 8. offline delivery: alice sends while bob has never polled
{"ok":true,"data":{"messageId":"2cfce0df-05df-46e1-9865-92c6579c4c75","envelopeId":"c0f53704-1c11-40c4-a3e2-6f1745215249","status":"delivered"}}
exit=0

### 9. bob poll (collects the message queued while he was offline)
{"ok":true,"data":{"received":1,"more":false,"rejected":[]}}
exit=0

### 10. reply in the other direction: bob sends
{"ok":true,"data":{"messageId":"db0da775-899e-4774-834f-e9793c03e2b4","envelopeId":"d5e71bb9-3ca1-423d-b3c5-864bd48e8ea8","status":"delivered"}}
exit=0

### 11. alice poll
{"ok":true,"data":{"received":1,"more":false,"rejected":[]}}
exit=0

MID=1077f94a-9f7c-4628-8560-75e4a6892552

### 12. exact retry #1 (explicit --message-id)
{"ok":true,"data":{"messageId":"1077f94a-9f7c-4628-8560-75e4a6892552","envelopeId":"bf73a372-374e-4971-b651-1dbc4819b897","status":"delivered"}}
exit=0

### 13. exact retry #2 (byte-identical, same --message-id) - expect the SAME envelopeId
{"ok":true,"data":{"messageId":"1077f94a-9f7c-4628-8560-75e4a6892552","envelopeId":"bf73a372-374e-4971-b651-1dbc4819b897","status":"delivered"}}
exit=0

### 14. bob poll (the retried message arrives exactly once)
{"ok":true,"data":{"received":1,"more":false,"rejected":[]}}
exit=0

### 15. bob poll again (deduplication - expect received 0)
{"ok":true,"data":{"received":0,"more":false,"rejected":[]}}
exit=0
```

Steps 12 and 13 are the same command run twice with the same `--message-id`; both answer with **`envelopeId` `bf73a372-374e-4971-b651-1dbc4819b897`**. The stored ciphertext is replayed, not re-encrypted. Step 15 confirms the receiver deduplicates: the second poll receives `0`.

```
### 16. alice history --with BID   (plaintext STRIPPED before printing — see §7)
{
 "ok": true, "count": 3,
 "entries": [
  {"sequence":1,"messageId":"2cfce0df-05df-46e1-9865-92c6579c4c75","direction":"outbound","createdAtMs":1788802913276,"plaintextChars":67},
  {"sequence":2,"messageId":"db0da775-899e-4774-834f-e9793c03e2b4","direction":"inbound", "createdAtMs":1788802913891,"plaintextChars":57},
  {"sequence":3,"messageId":"1077f94a-9f7c-4628-8560-75e4a6892552","direction":"outbound","createdAtMs":1788802914518,"plaintextChars":40}
 ]
}

### 17. bob history --with AID   (plaintext STRIPPED)
{
 "ok": true, "count": 3,
 "entries": [
  {"sequence":1,"messageId":"2cfce0df-05df-46e1-9865-92c6579c4c75","direction":"inbound", "createdAtMs":1788802913276,"plaintextChars":67},
  {"sequence":2,"messageId":"db0da775-899e-4774-834f-e9793c03e2b4","direction":"outbound","createdAtMs":1788802913891,"plaintextChars":57},
  {"sequence":3,"messageId":"1077f94a-9f7c-4628-8560-75e4a6892552","direction":"inbound", "createdAtMs":1788802914518,"plaintextChars":40}
 ]
}
```

Every `messageId` appears on both sides with **inverted directions and matching sequences and timestamps**:

| sequence | messageId | alice | bob |
|---|---|---|---|
| 1 | `2cfce0df-05df-46e1-9865-92c6579c4c75` | outbound | inbound |
| 2 | `db0da775-899e-4774-834f-e9793c03e2b4` | inbound | outbound |
| 3 | `1077f94a-9f7c-4628-8560-75e4a6892552` | outbound | inbound |

```
### 18. RESTART SURVIVAL: docker stop / docker start on geekom     (output in §3)

### 19. /health through the tunnel after restart
{"ok":true,"data":{"status":"healthy","uptime_ms":6079}}

### 20. PERSISTENCE PROOF: the SAME exact retry, after the restart
{"ok":true,"data":{"messageId":"1077f94a-9f7c-4628-8560-75e4a6892552","envelopeId":"bf73a372-374e-4971-b651-1dbc4819b897","status":"delivered"}}
exit=0

### 21. bob poll after restart (dedup record survived - expect received 0)
{"ok":true,"data":{"received":0,"more":false,"rejected":[]}}
exit=0

### 22. new traffic still works after restart: bob sends, alice polls
{"ok":true,"data":{"messageId":"0be5ecc9-263d-44d0-9ce5-9d3300a73295","envelopeId":"07491873-eeae-4b54-a7a3-312af7427408","status":"delivered"}}
exit=0
{"ok":true,"data":{"received":1,"more":false,"rejected":[]}}
exit=0

### 23. histories after restart (plaintext STRIPPED) — both sides, 4 entries, still mirrored
alice: 1 outbound / 2 inbound / 3 outbound / 4 inbound  (0be5ecc9-263d-44d0-9ce5-9d3300a73295, 1788802923170)
bob:   1 inbound  / 2 outbound / 3 inbound  / 4 outbound

### 24. CLI refusal check: plain HTTP to a NON-loopback host
{"ok":false,"error":{"code":"INVALID_CONFIGURATION"}}
exit=2
```

Step 20 is the load-bearing one: the identical `envelopeId` `bf73a372-…` comes back **after** the container was stopped and started, which it can only do by reading ciphertext written to the named volume before the stop. Step 21 shows the dedup record survived with it.

### `depr` was independently exercised too

`depr` is not merely a healthy port. Through its own tunnel (`localhost:18444`), two further fresh profiles completed init → publish → card exchange → offline delivery → reply:

```
### D0. /health on depr through the tunnel
{"ok":true,"data":{"status":"healthy","uptime_ms":687835}}
### D1. carol init / dave init
{"ok":true,"data":{"profile_id":"3ba25b88-7086-4fd3-a807-621cd6faeb06","identity_id":"7YW4a8Yw2ReEQa_atN6gBRVO0jEFIjj-ikd5xI9to3A","device_id":"c1c1e9c3-4434-5bc3-b6a5-da7b11c26f6d","contact_count":0}}
{"ok":true,"data":{"profile_id":"47f7f01f-549e-484c-bba6-52ca00d050a6","identity_id":"qOk-VGFbRljnSfOCRWFwZQo8uNu5vGYCIwp48EDsp9o","device_id":"31eb8523-b4e9-577e-8e88-ab97bc507008","contact_count":0}}
### D2. publish both
{"ok":true,"data":{"stored":true,"bundleId":"9867e78c-f734-4b2b-a016-3b621fe3a23c","claimable":true}}
{"ok":true,"data":{"stored":true,"bundleId":"4ec9a4ce-5703-48c9-b0ca-298a00e39705","claimable":true}}
### D4. carol -> dave (offline delivery), dave polls
{"ok":true,"data":{"messageId":"78e51a5b-9382-4a9a-94fd-b6f82864cf4b","envelopeId":"04bef256-3763-416b-bf63-cb6f314b7c19","status":"delivered"}}
{"ok":true,"data":{"received":1,"more":false,"rejected":[]}}
### D5. dave -> carol, carol polls
{"ok":true,"data":{"messageId":"fc8f46ba-1b41-4e10-98e9-7207e5790b02","envelopeId":"baa552b1-7512-4d1d-af90-1fee13b1f46e","status":"delivered"}}
{"ok":true,"data":{"received":1,"more":false,"rejected":[]}}
```

---

## 5. The relay never saw the plaintext

Each message body carried a deliberately planted, non-sensitive sentinel token (`T11PROOF`) so the relay's storage and logs could be searched without reproducing any message. The search was run **inside a throwaway container** with the data volume mounted **read-only**, because the volume lives under `/var/lib/docker` and neither host was to be touched with `sudo`:

```sh
docker run --rm --entrypoint /bin/sh -v echolet-relay-data:/data:ro echolet-relay:<tag> -c '…'
```

The `--entrypoint /bin/sh` is mandatory: the image's `ENTRYPOINT` is the relay itself, so without it the arguments are handed to the relay and a second relay starts (see §8, problem 1).

**Storage layout.** BadgerDB pre-allocates a sparse value log, so apparent sizes are meaningless and allocated blocks are what matter:

`geekom`, `du -k` per file vs `wc -c`:

```
/data/000001.sst   allocated=32K  apparent=29573
/data/000001.vlog  allocated=4K   apparent=20
/data/000002.vlog  allocated=4K   apparent=2147483646
/data/00002.mem    allocated=4K   apparent=134217728
/data/DISCARD      allocated=4K   apparent=1048576
/data/KEYREGISTRY  allocated=4K   apparent=28
/data/LOCK         allocated=4K   apparent=2
/data/MANIFEST     allocated=4K   apparent=30
```

Total allocated for the whole directory: **64 KiB** on `geekom`, 56 KiB on `depr`. Everything beyond that is a filesystem hole.

**Result.** The first 32 MiB of every file — a thousand times the largest allocated extent, so covering every real byte Badger has written — was scanned on both hosts:

| Host | Sentinel matches in relay data | Sentinel matches in container log | Total log lines |
|---|---|---|---|
| `geekom` | **0** | **0** | 6 |
| `depr` | **0** | **0** | 3 |

A per-file breakdown on `geekom` also searched for a Cyrillic substring of the first message body: `0` in every file, including `000001.sst` and `00002.mem` where the envelope bytes actually live.

The log counts are worth reading twice. **`geekom`'s entire log for the whole scenario is six lines** — three per boot, and both boots are quoted in §3. The relay logs no request line, no envelope id, no body, nothing per-request at `info`. There is no plaintext in the logs because there is almost nothing in the logs.

**Caveat, stated plainly.** A full recursive `grep -r` over the directory *including* the 2 GiB sparse value log was attempted first on both hosts and did not complete — busybox `grep` reading through overlayfs on a loaded host was still running after 20 minutes and was cancelled. The evidence above is a bounded head-scan, justified by the allocated-block figures rather than by a full sweep. It is sound for this data set (64 KiB of real bytes, written sequentially from offset 0) but it is a bounded scan, not an exhaustive one.

---

## 6. What this establishes, and what it does not

### Established

- **Two relay instances are running on the user's own servers**, `geekom` and `depr`, from the same image built from this tree, each with its own persistent named volume and its own callsign, each answering `/health` with `{"ok":true,…}` and each reported `healthy` by Docker's own healthcheck.
- **A message genuinely crossed between two machines through a relay running on a remote server.** The relay process ran on `geekom`; the two clients ran on this Mac. Offline delivery, a reply in the other direction, a byte-identical exact retry answering with the same `envelopeId` twice, deduplication to `received: 0`, and mirrored histories on both sides all completed against that remote relay with the real built `dist/cli.js`.
- **State survives a container restart.** The same `--message-id` retried after `docker stop`/`docker start` returned the same `envelopeId` from before the stop, and the recipient's poll still deduplicated to `0`.
- **The relay stored and logged no plaintext**, within the bound described in §5.
- **The CLI's refusal of plain HTTP to a non-loopback host was confirmed, not circumvented.** `INVALID_CONFIGURATION`, exit `2`.

### **Not** established — AC4

> **AC4:** *A relay reachable on a non-loopback address serves HTTPS, and the CLI completes the full acceptance scenario against it from a different machine.*

**Nothing in this report is evidence for AC4, and it must not be cited as such.** AC4 requires the **relay itself** to terminate TLS on a **non-loopback address**. Here:

- the relay is bound to `127.0.0.1` on each host and is provably unreachable from any other machine (connection refused from this Mac to both tailnet IPv4 addresses);
- the relay serves **plain HTTP** — it says so itself: `scheme=http tls_cert_file="" tls_key_file=""`;
- the confidentiality of the traffic between this Mac and `geekom` is **SSH's**, provided by the `ssh -L` tunnel. It is not the relay's TLS, and an SSH tunnel is not a substitute for it. The relay's own TLS path — certificate loading, the both-or-neither startup check, hot reload on renewal, chain validation by a client dialling the MagicDNS name — was exercised **not at all**.

AC4 remains blocked on exactly one thing, unchanged from the reconnaissance: **HTTPS Certificates are disabled for tailnet `tail5a88fb.ts.net`** (`CertDomains: null` on both hosts). That is a toggle in the Tailscale admin console (DNS → HTTPS Certificates → Enable), owned by the tailnet owner, and it cannot be set over SSH. Until it is set, `tailscale cert` fails, there is no certificate pair, and the relay — correctly — refuses to start rather than serving envelopes in the clear.

### Partially established — AC7

> **AC7:** *Two relay instances run on the user's servers, and a deployment runbook reproduces them from a clean host.*

The first clause is **met**: two instances are running on the user's two servers.

The second clause is **not yet met by the committed runbook**, for three reasons that are all recorded rather than papered over:

1. **The runbook and both start artifacts describe a TLS deployment.** `docker-compose.yml` and `run-relay.sh` cannot start what is running today; `run-relay.sh` refuses a loopback bind address by design and hard-fails on the missing `ECHOLET_TLS_DIR`. Reproducing this deployment means the `docker run` in §2, which is not committed anywhere. Either the runbook gains a documented no-TLS loopback variant, or this deployment is treated as a stopgap that the TLS one replaces.
2. **`deployment-runbook.md` §4 does not mention enabling HTTPS Certificates in the admin console** — the reconnaissance already proposed the addendum and it is still not applied.
3. **The image tag reads `-dirty`, which will confuse the next operator.** The build context itself is clean and the image *is* reproducible from `c302485` (§1), but the tag says otherwise because `build-image.sh` checks the whole repository rather than `apps/relay`. A runbook step that says "build the image and put the tag in the env file" will therefore hand every future deployment a tag that looks unreproducible. Either commit the doc/flow edits before building, or narrow the script's dirty check to the build context.

The deployment shape itself is a genuine improvement worth carrying into the runbook regardless of TLS: **it needs no `sudo` on either host**, which the runbook's `/etc/echolet` + `/var/lib/echolet` + systemd-timer shape does. On `geekom`, whose `altsay` has password-gated `sudo`, the runbook as written cannot be executed unattended at all; this one can.

---

## 7. Redaction

- **No store key, private key or HTTP request body appears anywhere in this report.** Both demo store keys were generated fresh with `crypto.randomBytes(32)` directly into shell variables inside the scenario process, were never written to a file, and are gone with that process.
- **No message body is reproduced.** `history --json` returns a `plaintext` field per entry; every history block in §4 was passed through a filter that keeps `sequence`, `messageId`, `direction`, `createdAtMs` and replaces the body with its character count before printing. The raw history JSON stayed in the scratch directory and is not quoted.
- The only body-derived string named here is the synthetic sentinel `T11PROOF`, planted specifically to make the §5 search possible without quoting a message.
- The identifiers that *are* quoted — `identity_id`, `device_id`, `device_pubkey`, `signal_identity_key`, `profile_id`, `bundleId`, `messageId`, `envelopeId` — are public protocol identifiers and public keys, and they belong to throwaway demo profiles that exist only in a `/tmp` directory on this Mac.

---

## 8. Problems hit

1. **A stray relay was started against a throwaway anonymous volume, twice.** The first plaintext-search attempt ran `docker run --rm -v echolet-relay-data:/data:ro <image> sh -c '…'` **without `--entrypoint`**. The image's `ENTRYPOINT` is `/usr/local/bin/relay`, so `sh -c …` was passed to the relay as arguments, ignored, and a **second relay started**. Its logs (`BadgerDB opened dir=/var/lib/echolet`) looked alarming, but the data volume was mounted at `/data`, not at `/var/lib/echolet`, and the Dockerfile's `VOLUME ["/var/lib/echolet"]` gave that second relay a fresh **anonymous** volume. **The production volume was never opened by a second writer and was never at risk.** Both stray containers were stopped and removed, and the four empty dangling volumes left behind (two per host — the others came from the `docker create`/`docker cp` binary-hash check) were verified empty and removed. Both hosts now show exactly one container from this image and exactly one `echolet` volume, `echolet-relay-data`. **Lesson: any `docker run` against this image that is not meant to start the relay must pass `--entrypoint`.**
2. **The exhaustive plaintext grep did not complete.** Badger's 2 GiB sparse value log made a full `grep -r` run for over 20 minutes on both hosts before being cancelled. Mitigated with the bounded head-scan justified by allocated-block sizes; the limitation is stated in §5 rather than hidden.
3. **`docker stop` yields exit code 2.** The relay does not exit cleanly on SIGTERM. No data loss, but see §3 — it is a real rough edge for supervisors and restart policies.
4. **The image `.Id` differs between this Mac and the hosts.** A `docker save`/`docker load` config re-serialisation artifact, not an image difference; resolved by comparing `.RootFS.Layers`, `.Config` and the extracted binary's sha256, all of which match exactly (§1).
5. **Neither committed start artifact could be used.** `docker-compose.yml` and `run-relay.sh` both hard-require TLS, and editing them was out of scope for this task. Documented in §0 with the exact three-line delta from `run-relay.sh`'s behaviour.
6. **`alpine:3.22` was pulled onto both hosts** by one diagnostic command that listed dangling volume contents. It is the same digest as the relay image's own runtime base (`sha256:1435830…`), so no new layer was added — only a tag reference. Removal is optional and listed in §9.
7. **AC4 remains blocked** by the tailnet HTTPS Certificates toggle, exactly as the reconnaissance predicted. Nothing on either host can fix it.

Nothing was worked around by weakening a client-side check. The one refusal encountered — plain HTTP to a non-loopback host — was recorded as a passing check, not routed around.

---

## 9. Teardown — exact commands

Everything created is reversible. Run per host (`geekom`, `depr`); no `sudo` is needed for any of it.

```sh
# 1. stop and remove the container
docker stop echolet-relay
docker rm   echolet-relay

# 2. remove the data volume (DESTROYS all relay state: bundles, mailboxes, dedup records)
docker volume rm echolet-relay-data

# 3. remove the image
docker rmi echolet-relay:20260907-c302485-dirty

# 4. optional — only if it was not already wanted on this host.
#    Same digest as the relay image's runtime base; harmless to keep.
docker rmi alpine:3.22

# 5. verify nothing is left
docker ps -a  --filter name=echolet-relay
docker volume ls --filter name=echolet
docker images    echolet-relay
ss -ltn | grep 8443          # expect no output
```

On this Mac:

```sh
# close the two SSH forwards
pkill -f 'ssh .*-L 18443:127.0.0.1:8443 geekom'
pkill -f 'ssh .*-L 18444:127.0.0.1:8443 depr'

# demo profiles and cards (throwaway, /tmp only)
rm -rf /tmp/echolet-t11-* /tmp/echolet-t11b-*

# local image and transfer tarball
docker rmi echolet-relay:20260907-c302485-dirty
rm -f <scratch>/echolet-relay.tar
```

**Nothing was created outside Docker on either host.** No `/etc/echolet`, no `/var/lib/echolet`, no systemd unit, no ufw rule, no Tailscale change, no file in either user's home directory. Teardown is these commands and nothing else.

---

## 10. Current state at the time of writing

| | `geekom` | `depr` |
|---|---|---|
| Container | `echolet-relay`, `Up (healthy)` | `echolet-relay`, `Up (healthy)` |
| Image | `echolet-relay:20260907-c302485-dirty` | same |
| Published on | `127.0.0.1:8443` | `127.0.0.1:8443` |
| Scheme | `http` (no TLS, deliberate) | `http` (no TLS, deliberate) |
| Volume | `echolet-relay-data` | `echolet-relay-data` |
| Callsign | `RPT-GEEKOM-01` | `RPT-DEPR-01` |
| `/health` | `{"ok":true,"data":{"status":"healthy","uptime_ms":613924}}` | `{"ok":true,"data":{"status":"healthy","uptime_ms":1050469}}` |
| Reachable off-host | no — connection refused | no — connection refused |
| Restart-survival proven | **yes** (§3, and scenario steps 20–21) | not exercised |
| Two-machine exchange | **yes**, full scenario | init/publish/exchange/send/poll both ways |

Both SSH forwards from this Mac are still open. They carry nothing when idle and close with the `pkill` lines above.

---

## Routing audit

- `graph_used`: **no** — *not relevant*. Nothing here was a structural "where does X live / what breaks if I change Y" question; no repository code was navigated or changed. The one code fact needed (that `ECHOLET_NODE_CALLSIGN` has a default and TLS is both-or-neither) came from a routed search, not from graph navigation.
- `wiki_used`: **no** — *not relevant*. The task was operating two servers against a written runbook, not understanding architecture, domain behaviour or a recorded decision. The authoritative in-repo sources — `docs/requirements/echolet-cli-prototype/runbook.md`, `deployment-runbook.md`, `deploy/relay/*` and `apps/relay/Dockerfile` — were read directly and in full.
- `ctx_used`: **partial**. `keryx ctx run` and `keryx ctx rg` were used for the in-repo command and search (`git log`, the config lookup; audits under `.metaproject/data/gdctx/`). Remote host output could not be routed through gdctx — it arrives over SSH from another machine — so it was captured to the session scratchpad and to background task files and read from there, achieving the same objective (no raw flood into context) by a different mechanism.
- `raw_rg_used`: **no** over project code. Two remote commands were run with a `keryx:raw` escape marker and a stated reason: both were `grep` **inside a container on a remote host**, searching a Docker volume and `docker logs`, neither of which `keryx ctx rg` can reach.

## Files written

- This report — the only intended write inside the repository.
- `.metaproject/data/gdctx/raw/…` and `.metaproject/data/gdctx/artifacts/…` — created automatically by the routed `keryx ctx run` / `keryx ctx rg` invocations. Tool-managed audit artifacts; no project content changed.
- Scratch outside the repository: `start-relay.sh`, `scenario.sh`, `scenario2.sh`, `depr-probe.sh`, their output logs, `echolet-relay.tar`, `relay-local`, `cfg-local.json`, `cfg-geekom.json` in the session scratchpad, and throwaway profile directories under `/tmp/echolet-t11*`.

**No source file and no test file was changed. No `sudo` was run on either host.**
