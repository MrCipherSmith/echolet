# T11 — Upgrade report: both relays moved to `a2f07bb`, and the clean-shutdown fix proven on the real hosts

Date: 2026-09-07 (upgrade 18:29–18:39 UTC)
Source tree: `a2f07bb` — *fix(relay): exit cleanly on SIGTERM and SIGINT*.
Previous deployment: `c302485` (see [t11-deployment-report.md](t11-deployment-report.md)).
Scope: **write**, on both hosts. One image loaded, one container replaced and one
directory created per host. No `sudo`. No firewall change. No Tailscale change.
No `tailscale cert`. No source, test or committed deployment artifact was edited.
Neither `echolet-relay-data` volume was deleted, and neither was recreated.

---

## 0. The headline

| | `geekom` | `depr` |
|---|---|---|
| `docker stop` → container exit code, **before** (`c302485`) | **2** | **2** |
| `docker stop` → container exit code, **after** (`a2f07bb`) | **0** | **0** |
| `docker stop` wall time, before | 234 ms | 221 ms |
| `docker stop` wall time, after | 273 ms | 217 ms |
| `envelopeId` before the upgrade | `7c45d9b1-c37e-414e-aadd-0b4484868a63` | `de6ca08b-d863-4475-a16f-06b39e837b9b` |
| same `--message-id` **after** the upgrade | **same id** | **same id** |
| recipient poll after the upgrade | `received: 0` | `received: 0` |
| Committed artifacts sufficient? | **yes**, `run-relay.sh` unmodified | **yes** |

Both relays now run `echolet-relay:20260907-a2f07bb`, healthy, on `127.0.0.1:8443`
only, on the same `echolet-relay-data` volume they had before.

---

## 1. The image

Built on this Mac (arm64) for **linux/amd64** by the committed
`deploy/relay/build-image.sh`, cross-compiled by the Dockerfile's
`--platform=$BUILDPLATFORM` build stage.

```sh
./deploy/relay/build-image.sh --mirror gcr --tag 20260907-a2f07bb \
  --save <scratch>/echolet-relay-a2f07bb.tar
```

```
==> built echolet-relay:20260907-a2f07bb
    id=sha256:6ffb8103c7059f54e5eb61d406a0287012d5d2cf846b77ab65eac4817f01ade1
    arch=linux/amd64
    size=21331213 bytes
-rw-------  1 Goodea  wheel  21650944  <scratch>/echolet-relay-a2f07bb.tar
==> sha256 of the tarball (compare it after transfer):
2f0dc46de75a2f2659e569130ff51432cbd1e466ca6019341bf998792a53d944
```

`--mirror gcr` again, for the same rate-limit reason recorded last time; it swaps
only the registry host in front of two **digest-pinned** base images.

### `--tag` was passed explicitly, and why that is not hiding anything

Left to itself the script would have produced **`20260907-a2f07bb-dirty`**, because
`git status --porcelain` over the *whole* repository is non-empty. What it is
non-empty with is two generated Metaproject files:

```
 M .metaproject/data/gdgraph/artifacts/module-map.json
 M .metaproject/data/gdgraph/artifacts/summary.md
```

Neither enters the build. The narrow checks over the build context are both empty:

```
git status --porcelain -- apps/relay packages     ->  (no output)
git diff --stat HEAD -- apps packages             ->  (no output)
```

So the image *is* reproducible from `a2f07bb`, and the tag says so. `--tag` is a
committed, supported flag of the committed script — nothing was edited to get
this. **This is the third time the coarse dirty check has produced a misleading
tag** (T11 §1, T11 §6 AC7 reason 3, here). It is recorded again in §7 rather than
quietly worked around each time.

### Transfer and identity

```sh
gzip -c <scratch>/echolet-relay-a2f07bb.tar | ssh geekom 'gunzip | docker load'
gzip -c <scratch>/echolet-relay-a2f07bb.tar | ssh depr   'gunzip | docker load'
```

```
Loaded image: echolet-relay:20260907-a2f07bb   (geekom)
Loaded image: echolet-relay:20260907-a2f07bb   (depr)
```

**Image `.Id` legitimately differs across the `docker save`/`load` boundary** —
the same config re-serialisation artifact §1 of the deployment report explains.
The identity checks that mean something all match:

| | this Mac | `geekom` | `depr` |
|---|---|---|---|
| image `.Id` | `sha256:6ffb8103…` | `sha256:83497194…` | `sha256:83497194…` |
| `.RootFS.Layers` | *(4 layers, below)* | identical | identical |
| **sha256 of `/usr/local/bin/relay`** | **`be8bbb90d22e8f5760cf455173f9428809949a330b51906783b733133db92195`** | **same** | **same** |

```
["sha256:6f09edfb3f6d7173733adc8eec8ea00626550dc6fc2dcf07d40e13f5c1e907c4",
 "sha256:01d699b3f2d8ec7adf5b88b76f78164e517fa482e16eedb752f87aae724c6921",
 "sha256:d0be64d795aee6e10ed3ef19c7988fd4515a8064e682a34a64a8d95defc1a149",
 "sha256:5f70bf18a086007016e948b04aed3b82103a36bea41755b6cddfaf10ace3c6ef"]
```

Layers 1, 2 and 4 are byte-identical to the `c302485` image; **only layer 3, the
one carrying `/usr/local/bin/relay`, changed** (`d0be64d7…` here vs `eca0e899…`
before). That is exactly the shape a one-file Go change should produce, and it is
a second, independent confirmation that this image differs from the deployed one
in the binary and nothing else.

The binary hash also moved as expected:

| Source | sha256 of `/usr/local/bin/relay` |
|---|---|
| `c302485` (what was running) | `317e05d5e5350aa5b043b2c7520de9942d7b2107068c230f997adc3a8eb7c1e4` |
| `a2f07bb` (what is running now) | `be8bbb90d22e8f5760cf455173f9428809949a330b51906783b733133db92195` |

The hash was taken the same way on all three machines, with the image's own
busybox and **`--entrypoint`**, so nothing accidentally starts a relay:

```sh
docker run --rm --entrypoint /bin/sh echolet-relay:20260907-a2f07bb \
  -c 'sha256sum /usr/local/bin/relay'
```

`--rm` also disposes of the anonymous volume the image's `VOLUME` line creates;
the volume counts in §6 confirm none leaked.

---

## 2. Before state, captured before anything was touched

| | `geekom` | `depr` |
|---|---|---|
| Container id | `54c62aeff9b776275ddb06c3ce42598bf5236ba77fca94e6024e4d248557be2b` | `b53a950c08f7c963091e2968b371d536f0a53ec42993b452e7d2e2d6ec23076a` |
| Image (tag) | `echolet-relay:20260907-c302485-dirty` | same |
| Image id | `sha256:c887eb4562801aac4307189a24a801468e104447b17522312bf6002c9f43c0de` | same |
| `StartedAt` | `2026-09-07T17:41:56.556797Z` | `2026-09-07T17:34:43.418324Z` |
| `RestartCount` | `0` | `0` |
| Docker health | `healthy` | `healthy` |
| `/health` | `{"ok":true,"data":{"status":"healthy","uptime_ms":2940357}}` | `{"ok":true,"data":{"status":"healthy","uptime_ms":3377206}}` |
| Volume | `echolet-relay-data` → `/var/lib/docker/volumes/echolet-relay-data/_data` | same |
| Callsign | `RPT-GEEKOM-01` | `RPT-DEPR-01` |
| Published | `127.0.0.1:8443->8443/tcp` | same |
| `ss -ltn` | one socket, `127.0.0.1:8443` | one socket, `127.0.0.1:8443` |
| Docker engine | client/server `29.3.0`, compose `v5.1.0` | client/server `29.1.3`, compose `2.40.3` |
| `~/echolet-deploy` | absent | absent |
| Totals (for stray detection) | 33 containers, 866 volumes (856 dangling) | 8 containers, 4 volumes (0 dangling) |

`geekom`'s 856 dangling volumes are **pre-existing and unrelated** — they belong
to other workloads on that host (`carlson-*`, `deprecated-*`, `helyx-*`, and
hundreds of anonymous ones). They were counted, not touched; the count is the
baseline the §6 comparison is made against.

Both containers carried the **old, unlabelled** shape: the four
`org.opencontainers.image.*` labels from the Dockerfile and **no
`echolet.tls` label**, because they were started by a bespoke `docker run`
before `run-relay.sh` had an insecure mode.

---

## 3. The upgrade — the committed artifacts did it, unmodified

**This is the answer to "are the artifacts the previous task added good enough":
yes, on both hosts, with no edit and no workaround.** The whole host-side
procedure is §6.5 of the deployment runbook, executed verbatim.

```sh
# operator's machine
scp -r deploy/relay/. <host>:echolet-deploy/

# host
cd ~/echolet-deploy
cp env/insecure-loopback.env.example env/insecure-loopback.env
sed -i 's|^ECHOLET_IMAGE=.*|ECHOLET_IMAGE=echolet-relay:20260907-a2f07bb|' env/insecure-loopback.env
sed -i 's|^ECHOLET_NODE_CALLSIGN=.*|ECHOLET_NODE_CALLSIGN=RPT-GEEKOM-01|'   env/insecure-loopback.env   # RPT-DEPR-01 on depr
./run-relay.sh env/insecure-loopback.env --print     # read the command first
./run-relay.sh env/insecure-loopback.env
```

Exactly the **two values** the template promises, and the second is only a name.
Everything else — `ECHOLET_BIND_ADDR=127.0.0.1`, the acknowledgement string,
`ECHOLET_DATA_VOLUME=echolet-relay-data`, every bound — was already correct in the
committed example.

`--print` first, as the template instructs. The command it printed is the same
hardening the old container had, plus the label the old one lacked:

```
# MODE: INSECURE LOOPBACK — plain HTTP, published on 127.0.0.1:8443 only, no TLS.
docker run -d --name echolet-relay --restart unless-stopped --user 10001:10001 \
  --read-only --tmpfs /tmp:size=16m,mode=1777 --security-opt no-new-privileges:true \
  --cap-drop ALL --log-driver json-file --log-opt max-size=20m --log-opt max-file=5 \
  --label echolet.tls=disabled-insecure-loopback-only \
  -p 127.0.0.1:8443:8443 -v echolet-relay-data:/var/lib/echolet \
  -e ECHOLET_HTTP_ADDR=0.0.0.0:8443 -e ECHOLET_DATA_DIR=/var/lib/echolet \
  -e ECHOLET_LOG_LEVEL=info -e ECHOLET_NODE_CALLSIGN=RPT-GEEKOM-01 \
  -e ECHOLET_MAILBOX_TTL_HOURS=168 -e ECHOLET_MAX_MESSAGE_BYTES=262144 \
  -e ECHOLET_MAX_MAILBOX_BATCH=100 -e ECHOLET_MAX_UNACKED_ENVELOPES_PER_SENDER=16 \
  -e ECHOLET_RATE_LIMIT_PER_MINUTE=120 -e ECHOLET_CHALLENGE_TTL_SECONDS=60 \
  -e ECHOLET_CLEANUP_INTERVAL_SECONDS=60 -e ECHOLET_MAX_STORAGE_BYTES=2147483648 \
  echolet-relay:20260907-a2f07bb
```

`-v echolet-relay-data:/var/lib/echolet` is the line the whole state proof rests
on, and it is the *existing* volume: `run-relay.sh`'s replace path is
`docker stop` + `docker rm` (never `rm -v`), which the file's own comment calls
out. It printed the loud banner, replaced the container and started it:

```
==> replacing existing container echolet-relay
############################################################
## INSECURE MODE: the relay will serve PLAIN HTTP, no TLS. ##
## Published on 127.0.0.1:8443 — loopback only.
...
==> started echolet-relay from echolet-relay:20260907-a2f07bb on 127.0.0.1:8443
```

### After state

| | `geekom` | `depr` |
|---|---|---|
| Container id | `1d9cfc0d7523109c166a136f3090ed270e857bdb21015f549cc91f2ec8e16dbd` | `0979ea6dcd952585e765facd7f9486e82c07be4753944e1c5ec6b9ac9d2164af` |
| Image | `echolet-relay:20260907-a2f07bb` (`sha256:83497194…`) | same |
| `StartedAt` | `2026-09-07T18:36:11.977241Z` | `2026-09-07T18:37:16.406934Z` |
| `RestartCount` | `0` | `0` |
| Health | `healthy` (second poll, ≈10 s) | `healthy` (second poll, ≈10 s) |
| `echolet.tls` label | `disabled-insecure-loopback-only` **(new)** | same |
| Volume | `echolet-relay-data`, **same source path** | same |
| Binary in the running container | `be8bbb90…` | `be8bbb90…` |
| `ss -ltn` | one socket, `127.0.0.1:8443` | one socket, `127.0.0.1:8443` |

The relay states its own scheme, unchanged by the upgrade:

```
time=2026-09-07T18:36:12.160Z level=INFO msg="Starting relay server" addr=0.0.0.0:8443 scheme=http tls_cert_file="" tls_key_file=""
```

And the confinement still holds, checked from this Mac over the tailnet **after**
the upgrade:

```
100.116.255.111:8443 -> http_code 000, curl exit 7 (connection refused)
100.100.188.64:8443  -> http_code 000, curl exit 7 (connection refused)
```

### The compose path was validated but deliberately not exercised

`docker-compose.insecure-loopback.yml` renders correctly on both hosts against
the same env file — `docker compose --env-file env/insecure-loopback.env -f
docker-compose.insecure-loopback.yml config` exits `0` with no stderr and
resolves `image: echolet-relay:20260907-a2f07bb`, `container_name:
echolet-relay`, `host_ip: 127.0.0.1`, `published: "8443"`, and both labels
including `echolet.insecure_ack`.

It was **not** used to perform the swap, because using it would have churned the
container a second time for no added evidence. **One thing about it is therefore
still unverified and should not be assumed:** `docker volume inspect
echolet-relay-data --format '{{json .Labels}}'` returns `null` on both hosts —
the volume predates compose and carries none of compose's own labels. Whether
`compose up -d` adopts such a volume silently, warns, or refuses is untested
here. Anyone taking the compose branch of runbook §10 on these two hosts is
taking an unproven step; `run-relay.sh` is the proven one.

---

## 4. The fix, proven on the real hosts

`docker stop echolet-relay`, run against the **old** container immediately before
the swap and against the **new** container immediately after, on each host.

### Before — `c302485`, the defect

```
geekom:  image before stop: echolet-relay:20260907-c302485-dirty
         docker_stop_command_exit=0
         docker_stop_wall_ms=234
         container_exit_code=2  oom=false  finished=2026-09-07T18:36:10.011066Z
         ps_status=Exited (2) Less than a second ago

depr:    image before stop: echolet-relay:20260907-c302485-dirty
         docker_stop_command_exit=0
         docker_stop_wall_ms=221
         container_exit_code=2  oom=false  finished=2026-09-07T18:36:51.662386Z
         ps_status=Exited (2) Less than a second ago
```

### After — `a2f07bb`, the fix

```
geekom:  image before stop: echolet-relay:20260907-a2f07bb
         docker_stop_command_exit=0
         docker_stop_wall_ms=273
         container_exit_code=0  oom=false  finished=2026-09-07T18:36:18.788132Z
         ps_status=Exited (0) Less than a second ago

depr:    image before stop: echolet-relay:20260907-a2f07bb
         docker_stop_command_exit=0
         docker_stop_wall_ms=217
         container_exit_code=0  oom=false  finished=2026-09-07T18:37:34.832434Z
         ps_status=Exited (0) Less than a second ago
```

**`Exited (2)` → `Exited (0)` on both hosts.** The whole stop is ~220–270 ms of
wall time either way, which is the point: the fix costs nothing measurable and
buys a truthful exit status. Docker's grace period is 10 s and never came near
being used.

### One precision that matters, because the task's phrasing invites the wrong reading

**`docker stop` the *command* returned `0` in all four runs, before and after.**
It always does — it reports whether *it* succeeded in stopping the container, not
how the process died. The number that was `2` and is now `0` is the
**container's** exit status, `.State.ExitCode`, which is what `docker ps` renders
as `Exited (N)` and what `restart: on-failure`, `restart: unless-stopped` and any
supervisor keying off exit status actually read. Both are recorded above so the
distinction is not lost; the defect and its fix live in the second one.

### The relay now narrates its own shutdown

Nothing at all appeared in the old relay's log on a stop — it was killed by the
signal before it ran a line of shutdown code. The new one logs the sequence
T17 §2.2 describes, in order:

```
time=2026-09-07T18:36:18.770Z level=INFO msg="Shutdown signal received; draining in-flight requests" signal=terminated drain_timeout=5s
time=2026-09-07T18:36:18.771Z level=INFO msg="In-flight requests drained"
time=2026-09-07T18:36:18.785Z level=INFO msg="Storage closed"
```

Signal to `Storage closed`: **15 ms on `geekom`**, 7 ms on `depr`. The drain
returned in about 1 ms because nothing was in flight, and Badger's close is the
rest. `"Storage closed"` is the line the old build could never print, and it is
the difference between a clean stop and an abandoned data directory.

### Then started again, healthy

```
geekom:  start_exit=0 -> Up 5 seconds (healthy)
         {"ok":true,"data":{"status":"healthy","uptime_ms":5724}}
depr:    start_exit=0 -> Up 14 seconds (healthy)
         {"ok":true,"data":{"status":"healthy","uptime_ms":14054}}
```

and through the SSH forward from this Mac, `{"ok":true,…}` on both.

---

## 5. State survived the upgrade — proven with data, not health

The evidence is an **exact retry with an explicit `--message-id`, issued before
the container was replaced and repeated after it**, using the real built
`apps/cli/dist/cli.js` from this Mac through an SSH local forward
(`18443` → `geekom`, `18444` → `depr`). Two fresh throwaway profiles per host;
each 32-byte store key generated with `crypto.randomBytes(32)` straight into an
environment variable of the one process that ran the whole sequence, never
written to a file, never printed, and gone with that process.

### `geekom`

```
### P4 alice sends with explicit --message-id  (BEFORE the upgrade)
{"ok":true,"data":{"messageId":"d0f632da-ed37-4601-950e-4a24e11c7b4d",
                   "envelopeId":"7c45d9b1-c37e-414e-aadd-0b4484868a63","status":"delivered"}}
### P5 bob poll                       {"ok":true,"data":{"received":1,"more":false,"rejected":[]}}
### P6 bob poll again                 {"ok":true,"data":{"received":0,"more":false,"rejected":[]}}

--- container replaced: c302485 -> a2f07bb, same echolet-relay-data volume ---

### P7 alice sends the SAME --message-id   (AFTER the upgrade)
{"ok":true,"data":{"messageId":"d0f632da-ed37-4601-950e-4a24e11c7b4d",
                   "envelopeId":"7c45d9b1-c37e-414e-aadd-0b4484868a63","status":"delivered"}}
### P8 bob poll                       {"ok":true,"data":{"received":0,"more":false,"rejected":[]}}
```

### `depr`

```
### P4  {"messageId":"2c3e50bd-9f9f-4207-9e23-0cc8b8bc01ef",
         "envelopeId":"de6ca08b-d863-4475-a16f-06b39e837b9b","status":"delivered"}
### P5  {"received":1,...}     ### P6  {"received":0,...}

--- container replaced: c302485 -> a2f07bb, same echolet-relay-data volume ---

### P7  {"messageId":"2c3e50bd-9f9f-4207-9e23-0cc8b8bc01ef",
         "envelopeId":"de6ca08b-d863-4475-a16f-06b39e837b9b","status":"delivered"}   <- SAME
### P8  {"received":0,...}
```

**`envelopeId` `7c45d9b1-…` and `de6ca08b-…` were issued by a relay built from
`c302485` and returned by a relay built from `a2f07bb`.** The second relay is a
different process, from a different image, with a different binary — the only
thing the two share is the named volume. Replaying that id can only come from
ciphertext stored on that volume before the swap, and `received: 0` can only come
from the dedup record stored beside it.

This is a strictly stronger claim than the restart-survival check T11 already
made, and it is the reason the task asked for data rather than `/health`. A green
`/health` after an upgrade says a relay is running. These four lines say **this
relay's state is the previous relay's state.**

Steps P0–P3 (init, publish, contact export/import) ran fully on both hosts before
P4 and all returned `exit=0`; the identifiers they printed are public protocol
identifiers belonging to throwaway profiles that no longer exist. Every profile
directory was removed at the end of its run.

---

## 6. No strays

Counted against the §2 baseline, on each host, after everything:

| | `geekom` before | `geekom` after | `depr` before | `depr` after |
|---|---|---|---|---|
| Containers (all) | 33 | **33** | 8 | **8** |
| Volumes (all) | 866 | **866** | 4 | **4** |
| Dangling volumes | 856 | **856** | 0 | **0** |
| Containers named `echolet*` | 1 | **1** | 1 | **1** |
| Volumes named `echolet*` | 1 (`echolet-relay-data`) | **1, the same one** | 1 | **1, the same one** |

Zero net change on both. Specifically:

- **No stray relay was started.** Every `docker run` against the image that was
  not meant to be the relay passed `--entrypoint /bin/sh`, which is the lesson
  T11 §8 problem 1 recorded. There was one such run per machine, for the binary
  hash, each with `--rm`.
- **No anonymous volume leaked.** `--rm` disposes of the volume the image's
  `VOLUME ["/var/lib/echolet"]` line creates; the counts above confirm it. No
  `docker create`/`docker cp` was used this time — that was the other stray
  source last time.
- **`alpine:3.22` was not pulled**, and nothing else was pulled onto either host.
- On this Mac, two `ssh -L` processes I started were left idle after failing to
  bind (the T11 forwards on `18443`/`18444` were still up and were reused); both
  were killed. The two pre-existing forwards were left as found.

### Two things that are new on each host, deliberately, and how to remove them

1. **`echolet-relay:20260907-c302485-dirty` is still present** on both hosts. It
   was not created by this task and it is what makes runbook §11 a thirty-second
   rollback — §10 explicitly says to keep the previous image until the new one is
   verified. Remove it with `docker rmi echolet-relay:20260907-c302485-dirty`
   once this deployment has been running long enough to trust.
2. **`~/echolet-deploy` now exists on each host**, containing the committed
   `deploy/relay/` tree plus a generated `env/insecure-loopback.env`. It did not
   exist before; runbook §6.5 prescribes it, and without it there is no
   `run-relay.sh` on the host to roll back with. **It contains no secret** — the
   file holds an image tag, a callsign, a loopback address and bounds, and the
   template's own header states that nothing in it may ever become a secret.
   Remove with `rm -rf ~/echolet-deploy` if the host is meant to hold nothing.

Full teardown is otherwise unchanged from t11-deployment-report.md §9, with the
new tag substituted.

---

## 7. Problems and surprises

1. **`build-image.sh`'s dirty check fired again, for the third time, on files
   that never enter the build.** Two generated `.metaproject/data/gdgraph/`
   artifacts made the whole-repository `git status --porcelain` non-empty, so the
   default tag would have been `20260907-a2f07bb-dirty` for an image that is
   exactly reproducible from `a2f07bb`. Worked around with the script's own
   `--tag` flag and the narrow build-context check, which is fine once and a
   smell three times. **The fix is one line**: check
   `git status --porcelain -- apps/relay` — the actual build context, which is
   what `CONTEXT` in the same script already points at — rather than the whole
   repository. Out of scope here (no committed artifact may be edited), so it is
   recorded, again.
2. **The compose path is validated but unproven against an existing volume.**
   `compose config` is clean on both hosts, but `echolet-relay-data` carries
   `null` labels and compose's adoption behaviour for such a volume was not
   tested. Described in §3 rather than implied to work.
3. **"`docker stop` returns exit 2" is not literally true and never was.** The
   command returns `0`; the *container* exited `2`. Both numbers are recorded in
   §4 so the next reader does not chase the wrong one. The defect, the fix and
   the consequence for restart policies are all real — only the phrasing was
   loose, in the original finding and in this task's brief.
4. **The old containers carried no `echolet.tls` label.** They predate
   `run-relay.sh`'s insecure mode, so
   `docker ps --filter label=echolet.tls=disabled-insecure-loopback-only`
   matched nothing before this upgrade and matches both relays now. Anyone who
   wrote monitoring against that filter between the two deployments got an empty
   result from a healthy fleet.
5. **Nothing failed.** Both hosts completed every step first time; the rollback
   branch built into the upgrade script was never taken.
6. **AC4 is untouched and remains blocked**, exactly as before: the relays serve
   plain HTTP on loopback, the tailnet's HTTPS Certificates toggle is still off,
   and nothing in this report is evidence for AC4. This upgrade changes the
   relay's shutdown behaviour and nothing about its listener.

---

## 8. Redaction

- **No store key, private key, plaintext message body or HTTP request body
  appears anywhere in this report.** The four demo store keys were generated with
  `crypto.randomBytes(32)` directly into environment variables of the two
  scenario processes, were never written to a file, never printed, and are gone
  with those processes.
- The message text used for the retry proof was a synthetic sentinel written for
  this purpose; it is not reproduced, and the CLI's `send` output contains only
  identifiers.
- The identifiers quoted — `identity_id`, `device_id`, `profile_id`, `bundleId`,
  `messageId`, `envelopeId` — are public protocol identifiers belonging to
  throwaway profiles that were deleted at the end of each run.
- No `sudo` was run on either host. No firewall port was opened. No non-loopback
  address was bound. No Tailscale setting was read or written. No
  `echolet-relay-data` volume was deleted.

---

## 9. Current state

| | `geekom` | `depr` |
|---|---|---|
| Container | `echolet-relay`, `Up (healthy)` | `echolet-relay`, `Up (healthy)` |
| Image | `echolet-relay:20260907-a2f07bb` | same |
| Relay binary | `be8bbb90d22e8f5760cf455173f9428809949a330b51906783b733133db92195` | same |
| Published on | `127.0.0.1:8443` only | `127.0.0.1:8443` only |
| Scheme | `http` (no TLS, deliberate) | `http` (no TLS, deliberate) |
| Label | `echolet.tls=disabled-insecure-loopback-only` | same |
| Volume | `echolet-relay-data` (carried over) | `echolet-relay-data` (carried over) |
| Callsign | `RPT-GEEKOM-01` | `RPT-DEPR-01` |
| `/health` | `{"ok":true,"data":{"status":"healthy",…}}` | `{"ok":true,"data":{"status":"healthy",…}}` |
| Reachable off-host | no — connection refused | no — connection refused |
| Clean stop proven | **yes, `Exited (0)`** | **yes, `Exited (0)`** |
| State survived the upgrade | **yes, same `envelopeId`** | **yes, same `envelopeId`** |
| Rollback image on host | `20260907-c302485-dirty` | same |
| Upgrade artifacts on host | `~/echolet-deploy` | `~/echolet-deploy` |

---

## Routing audit

- `graph_used`: **no** — *not relevant*. No structural "where does X live / what
  breaks if I change Y" question arose; no repository code was navigated or
  changed. The authoritative sources were named directly by the task.
- `wiki_used`: **no** — *not relevant*. This was operating two servers against a
  written runbook, not understanding architecture or a recorded decision. The
  in-repo sources (`deploy/relay/*`, `deployment-runbook.md` §6.5/§7.5/§9/§10,
  the two prior flow reports) were read directly.
- `ctx_used`: **partial**. `keryx ctx rg` for every in-repo search and
  `keryx ctx run` for every in-repo command (`git log`, `git status`, the image
  build). Remote host output arrives over SSH from another machine and cannot be
  routed through gdctx, so it was captured to session scratch files and read from
  there — the same objective, a different mechanism.
- `raw_rg_used`: **no** over project code. Three commands carried a `keryx:raw`
  escape marker with a stated reason: two local `ps`/`grep` over this Mac's own
  process list, and one bounded `grep` over `docker compose config` output on the
  remote hosts. None searched project code.

## Files written

- This report — the only intended write inside the repository.
- `.metaproject/data/gdctx/raw/…` and `.metaproject/data/gdctx/artifacts/…` —
  created automatically by the routed `keryx ctx` invocations.
- Scratch outside the repository: `before-state.sh`, `before-geekom.txt`,
  `before-depr.txt`, `upgrade.sh`, `run-geekom.log`, `run-depr.log`,
  `echolet-relay-a2f07bb.tar` in the session scratchpad; two throwaway profile
  directories under `/tmp/echolet-t11u-*`, both removed.
- On each host: `~/echolet-deploy/` (§6).

**No source file, no test file and no committed deployment artifact was changed.
No `sudo` was run on either host.**
