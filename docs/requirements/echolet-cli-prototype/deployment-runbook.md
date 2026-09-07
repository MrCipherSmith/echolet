# Echolet Relay Deployment Runbook
Version: 0.1.0

Copyable commands for standing up a relay on a tailnet host, and for standing it
up again on a clean one. Companion to
[runbook.md](runbook.md), which reproduces the **local** prototype; that document
is the one to read first, and every command here assumes the relay it describes.

**Status of this document: prepared, not yet executed.** Everything below was
written and the artifacts it references were built and exercised **locally**, in
containers on the operator's machine. No server has been contacted, no
`tailscale cert` has been run, and no image has been pushed anywhere. Deploying
is the next task, and it is gated behind the verification of the flooding
closure by explicit decision: nothing becomes reachable from outside its host
until the closure is verified.

## Before anything else — read §0

§0 is a breaking change. Deploying without it is how you get two relays that a
client cannot talk to, or a mailbox that silently delivers nothing.

---

## 0. The one breaking change, and what it means for ordering

The mailbox ack/poll **signed transcript** gained a `v2` form carrying a
`read_through` position. The relay verifies `v1` when the field is absent and
`v2` when it is present; the CLI sends the position on every page after the
first.

**A relay serving the old transcript and a client built after this change do not
interoperate.** The poll answers `403 INVALID_SIGNATURE`, loudly, on the second
page of every walk. The consequences, in order of how likely you are to hit
them:

1. **Roll the relay and the client together.** Build the relay image and the CLI
   from the *same* tree. Do not upgrade one host's relay and leave the other on
   an older image while the same CLI talks to both.
2. **On a fresh host this costs nothing.** Both target hosts have never run a
   relay, so there is no old data, no old client and no deployed peer. This is
   precisely why the flow's order puts the protocol change before the
   deployment; landing it after two relays are serving would break every
   deployed client at once.
3. **If a relay ever *does* have existing data**, you have two safe options and
   they are both cheap:
   - **Do nothing.** The backfill is in the relay code, not in a step you can
     forget. Envelopes stored before the ordering index existed are given
     positions in their existing key order, on first touch, in chunks, and
     idempotently. A mailbox is not reshuffled and nothing is lost.
   - **Wipe the data directory.** On a prototype deployment this is acceptable
     and often simpler: nothing in a mailbox lives longer than the 168 h
     retention cap anyway.
     ```sh
     docker stop echolet-relay
     sudo rm -rf /var/lib/echolet/*        # destroys undelivered envelopes
     sudo chown -R 10001:10001 /var/lib/echolet
     docker start echolet-relay
     ```
     Do this only deliberately. It deletes envelopes that have not been
     delivered yet, and there is no undo.

What is **not** affected: identities, contact cards, and the local encrypted
client stores. Nothing in a profile directory has to change.

---

## 1. Target hosts

| | `geekom.tail5a88fb.ts.net` | `depr.tail5a88fb.ts.net` |
|---|---|---|
| OS / arch | Ubuntu 24.04, x86_64 | Ubuntu 24.04, x86_64 |
| Resources | 16 cores, 27 GiB | 4 cores, 7.6 GiB |
| Login | `altsay` | `ubuntu` |
| `sudo` | **needs a password** | passwordless |
| Docker | present, usable **without** sudo | present, usable **without** sudo |
| Firewall | state not readable without sudo | **ufw active** |
| Callsign | `RPT-GEEKOM-01` | `RPT-DEPR-01` |

Neither host has Go, Node, a checkout or a reverse proxy, and nothing listens on
80 or 443. The image is therefore built on the operator's machine and carried
over; `sudo` is needed on the host only for `tailscale cert` and the two
directories.

### The one thing that will bite you

**Docker's published-port DNAT is evaluated before ufw's INPUT chain.** A
container published on `0.0.0.0` is reachable on every interface of a host whose
firewall denies the port — `depr`'s active ufw would not save you. Publishing on
the host's **tailnet address** is what keeps the relay on the tailnet, and on
this deployment it is the only thing that does. `deploy/relay/run-relay.sh`
refuses `0.0.0.0` outright for this reason.

---

## 2. Build the image (operator's machine)

The relay ships as a container image built from `apps/relay/Dockerfile`:
multi-stage, both base images pinned by digest, CGO disabled, `-trimpath`, a
static binary on Alpine, running as uid 10001 with a read-only root filesystem
and every capability dropped.

```sh
cd <repository root>
./deploy/relay/build-image.sh --platform linux/amd64 --save out/echolet-relay.tar
```

Both servers are x86_64, so `linux/amd64` is the default and correct target even
on an arm64 laptop: the build stage runs on the *build* platform and
cross-compiles, so this needs no emulation.

The script prints the tag it produced — `echolet-relay:<YYYYMMDD>-<short-sha>`,
with `-dirty` appended if the tree had uncommitted changes. **A `-dirty` tag is
a warning worth heeding**: an image built from an uncommitted tree cannot be
reproduced from the repository, which is the one thing this runbook exists to
guarantee. Commit first when you can.

If Docker Hub is rate-limiting (`toomanyrequests`, or a `load metadata` step
that never finishes), use a mirror that serves the *same digests*:

```sh
./deploy/relay/build-image.sh --platform linux/amd64 --mirror gcr --save out/echolet-relay.tar
```

## 3. Carry it to the host

There is no registry. `docker save | ssh … docker load` is the whole transport,
and it needs no sudo because both users are in the `docker` group.

```sh
HOST=geekom.tail5a88fb.ts.net; USER_AT=altsay      # depr: ubuntu@depr.tail5a88fb.ts.net
docker save echolet-relay:<tag> | gzip | ssh "$USER_AT@$HOST" 'gunzip | docker load'
ssh "$USER_AT@$HOST" 'docker images echolet-relay'
```

Slow link, or you want the transfer to be resumable and checkable? Use the
tarball `--save` wrote and compare its digest on both ends:

```sh
shasum -a 256 out/echolet-relay.tar
scp out/echolet-relay.tar "$USER_AT@$HOST:/tmp/"
ssh "$USER_AT@$HOST" 'sha256sum /tmp/echolet-relay.tar && docker load -i /tmp/echolet-relay.tar && rm /tmp/echolet-relay.tar'
```

## 4. Obtain the certificate (on the host, once per host)

`tailscale cert` issues a real Let's Encrypt certificate for the host's MagicDNS
name. No public DNS record is created and no inbound port is opened.

```sh
ssh "$USER_AT@$HOST"

sudo mkdir -p /etc/echolet/tls
sudo tailscale cert \
  --cert-file /etc/echolet/tls/cert.pem \
  --key-file  /etc/echolet/tls/key.pem \
  "$(hostname).tail5a88fb.ts.net"

# The relay runs as uid 10001 inside the container and reads these two files
# through a read-only bind mount. Give it read access to the key by ownership,
# not by making the key world-readable.
sudo chown 10001:10001 /etc/echolet/tls/cert.pem /etc/echolet/tls/key.pem
sudo chmod 0644 /etc/echolet/tls/cert.pem
sudo chmod 0600 /etc/echolet/tls/key.pem
```

On `geekom` these four commands are the only ones that will ask for a password.

**Never copy `key.pem` off the host.** It is generated there, read there, and
renewed there. It does not belong in the repository, in an image, in an env
file, or in a chat window.

### Renewal, without a restart

Re-running `tailscale cert` rewrites the same two paths. The **running** relay
notices the new bytes — by content digest, not modification time — within
`ECHOLET_TLS_RELOAD_INTERVAL_SECONDS` and serves the renewed certificate. If a
read lands mid-rewrite, the last good pair keeps serving and a warning is
logged, so a renewal cannot become an outage.

Install the timer that does it:

```sh
sudo cp deploy/relay/systemd/echolet-cert-renew.service /etc/systemd/system/
sudo cp deploy/relay/systemd/echolet-cert-renew.timer   /etc/systemd/system/
sudo systemctl edit echolet-cert-renew.service   # add: Environment=ECHOLET_TLS_HOSTNAME=<host>.tail5a88fb.ts.net
sudo systemctl daemon-reload
sudo systemctl enable --now echolet-cert-renew.timer
sudo systemctl start echolet-cert-renew.service && systemctl status echolet-cert-renew.service --no-pager
```

The unit deliberately contains no `restart`. A renewal that restarted the relay
would turn a routine event into the outage the reloader exists to prevent.

## 5. Data directory (on the host, once per host)

```sh
sudo mkdir -p /var/lib/echolet
sudo chown -R 10001:10001 /var/lib/echolet
sudo chmod 0700 /var/lib/echolet
```

This holds the Badger store: envelope **ciphertext**, device records, mailbox
ordering and read marks. It never holds a plaintext body and never holds a
client's key.

## 6. Configure and start

Copy the host's env template, fill in two values, and start. Nothing in the env
file is a secret and nothing in it may become one — the certificate and key are
referenced by path and mounted read-only.

```sh
cd deploy/relay
cp env/geekom.env.example env/geekom.env       # or env/depr.env.example

tailscale ip -4                                 # on the host: 100.x.y.z
$EDITOR env/geekom.env
#   ECHOLET_IMAGE=echolet-relay:<tag from §2>
#   ECHOLET_BIND_ADDR=100.x.y.z                 <- the host's tailnet address, NEVER 0.0.0.0
```

Then, on the host, with `deploy/relay/` copied over (`scp -r deploy/relay
"$USER_AT@$HOST":~/echolet-deploy`):

```sh
docker compose version && \
  docker compose --env-file env/geekom.env -f docker-compose.yml up -d
```

Ubuntu's `docker.io` package ships the engine without the compose plugin. If
`docker compose version` is not found, the plain-`docker run` equivalent reads
the same env file and produces the same container:

```sh
./run-relay.sh env/geekom.env            # add --print to see the command first
```

Repeat for `depr` with `env/depr.env`. Keep the bounds identical on both hosts:
two relays that disagree about retention or maximum message size make every
cross-relay observation ambiguous.

## 7. Verify on the host

```sh
docker ps --filter name=echolet-relay --format '{{.Status}}'
# Up 40 seconds (healthy)

docker logs echolet-relay | tail -5
# ... msg="Starting relay server" addr=0.0.0.0:8443 scheme=https
#     tls_cert_file=/etc/echolet/tls/cert.pem tls_key_file=/etc/echolet/tls/key.pem
```

`scheme=https` is the line that matters. The relay **never** falls back to plain
HTTP: set only one of the two TLS variables, or point either at a file that is
missing, malformed or mismatched, and it exits non-zero at startup naming the
offending variable or path. Verified in the container:

```text
ERROR Failed to load config error="ECHOLET_TLS_CERT_FILE and ECHOLET_TLS_KEY_FILE
must be set together: set both to serve HTTPS, or neither to serve plain HTTP.
Refusing to start rather than silently serving plain HTTP with TLS half configured"
```

The container's own health probe dials loopback and does not validate the chain,
because the certificate is issued for the MagicDNS name and this probe is a
liveness check. The check that matters is the next one.

## 8. Verify from a second tailnet machine

This is the one that proves the deployment, and it is a **different machine** —
the operator's laptop, or the other relay host.

```sh
tailscale status | grep -E 'geekom|depr'         # both must be reachable
curl -sS https://geekom.tail5a88fb.ts.net:8443/health
curl -sS https://depr.tail5a88fb.ts.net:8443/health
```

```json
{"ok":true,"data":{"status":"healthy","uptime_ms":41208}}
```

No `-k`, no `--cacert`: the certificate is a real Let's Encrypt one and the
system trust store validates it. **If you need `-k`, stop and fix the
certificate** — a client that skips validation proves nothing about the
deployment, and the CLI will not skip it for you.

Two checks worth the extra seconds:

```sh
# The chain, and the name it was issued for.
echo | openssl s_client -connect geekom.tail5a88fb.ts.net:8443 \
  -servername geekom.tail5a88fb.ts.net 2>/dev/null \
  | openssl x509 -noout -subject -issuer -dates

# Plain HTTP to the same port is answered by the TLS listener, never by the API.
curl -sS http://geekom.tail5a88fb.ts.net:8443/health
# Client sent an HTTP request to an HTTPS server.
```

## 9. Point a CLI profile at the deployed relay

The relay URL is fixed at `init` time and must name the host the certificate was
issued for. **An IP address will not match a MagicDNS certificate**, and the CLI
refuses a non-loopback URL that is not HTTPS (exit 2, `INVALID_CONFIGURATION`).

```sh
D=$(mktemp -d /tmp/echolet-remote-XXXXXX)
CLI="<repo>/apps/cli/dist/cli.js"
URL="https://geekom.tail5a88fb.ts.net:8443"
export AKEY=$(node -e 'process.stdout.write(require("crypto").randomBytes(32).toString("base64url"))')

a() { ECHOLET_E2E_KEY="$AKEY" node "$CLI" "$@" --profile "$D/alice" --json; }
a init --relay-url "$URL" --store-key-env ECHOLET_E2E_KEY
a relay publish
```

From here the full acceptance scenario is exactly §4–§10 of
[runbook.md](runbook.md) with `$URL` pointing at the remote relay: contact
export/import, publish, offline delivery, reply, byte-identical exact retry,
deduplication, both histories.

**`--relay-url` exists only on `init`.** There is no command that repoints an
existing profile, deliberately — the profile's device record is published to a
particular relay and moving it is not a supported operation. Use a fresh profile
per relay. Editing `<profile>/config.json`'s `relay_url` by hand does work and
requires a `relay publish` afterwards, but it is unsupported and untested.

## 10. Upgrade

Roll the relay and the CLI together (§0). Keep the previous image on the host
until the new one is verified — that is what makes §11 a thirty-second
operation.

```sh
# operator's machine
./deploy/relay/build-image.sh --platform linux/amd64 --save out/echolet-relay.tar
docker save echolet-relay:<new-tag> | gzip | ssh "$USER_AT@$HOST" 'gunzip | docker load'

# host
$EDITOR env/geekom.env                  # ECHOLET_IMAGE=echolet-relay:<new-tag>
docker compose --env-file env/geekom.env -f docker-compose.yml up -d
# or: ./run-relay.sh env/geekom.env

docker ps --filter name=echolet-relay --format '{{.Status}}'
curl -sS https://geekom.tail5a88fb.ts.net:8443/health     # from another machine
```

The data directory is a host bind mount, so replacing the container never
touches it. The upgrade is a container swap of a few seconds; in-flight requests
fail and clients retry, which is exactly the behaviour the retry and
deduplication paths exist for.

## 11. Rollback

```sh
$EDITOR env/geekom.env                  # ECHOLET_IMAGE=echolet-relay:<previous-tag>
docker compose --env-file env/geekom.env -f docker-compose.yml up -d
docker ps --filter name=echolet-relay --format '{{.Status}}'
```

Two honest caveats, because a rollback that surprises you is worse than none:

- **Rolling back past the transcript change breaks new clients** (§0), in the
  same way and for the same reason as rolling forward without them. Roll the CLI
  back too, from the same tree.
- **The ordering index the newer relay wrote is additive.** An older relay
  ignores those keys and serves from the primary records as it always did;
  nothing is corrupted. What it does not do is honour the read marks, so a
  recipient re-walks from the head of its mailbox. Messages are re-offered, not
  lost — and the client deduplicates.

Rolling back the *data* is not a supported operation. There is no snapshot and
no export; the relay holds nothing that is not either re-sendable or expiring
within 168 h.

## 12. Where things live

| What | Where | Notes |
|---|---|---|
| Relay logs | `docker logs echolet-relay` | json-file driver, capped at 5 × 20 MB per host by the env file. Paths of the certificate pair are logged; **contents never are**. |
| Log files on disk | `/var/lib/docker/containers/<id>/<id>-json.log` | needs sudo to read directly; `docker logs` does not. |
| Relay data | `/var/lib/echolet` on the host | Badger store, uid 10001, mode 0700. Envelope ciphertext, device records, ordering index, read marks. |
| Certificate pair | `/etc/echolet/tls/{cert.pem,key.pem}` | written by `tailscale cert`, mounted **read-only** into the container. |
| Compose / run recipes | `deploy/relay/` in the repository | `docker-compose.yml`, `run-relay.sh`, `env/*.env.example`, `systemd/`. |
| Image definition | `apps/relay/Dockerfile` | build context is `apps/relay`, not the repository root. |
| Renewal timer | `systemctl status echolet-cert-renew.timer` | `journalctl -u echolet-cert-renew` for its history. |

Client-side, nothing changes: the profile directory, its encrypted store and the
`ECHOLET_E2E_KEY`-style store key stay entirely on the operator's machine. **No
key material of any kind exists on either server.**

## 13. Teardown

```sh
docker compose --env-file env/geekom.env -f docker-compose.yml down
# or: docker rm -f echolet-relay
sudo rm -rf /var/lib/echolet /etc/echolet
sudo systemctl disable --now echolet-cert-renew.timer
sudo rm -f /etc/systemd/system/echolet-cert-renew.{service,timer}
sudo systemctl daemon-reload
```

`tailscale cert` leaves nothing else on the host to clean up.

---

## 14. What this deployment does not establish

Running two relays on a tailnet does not change what the Echolet prototype is.
Everything in this section is true **after** a successful deployment.

- **This is an unaudited prototype and it is not suitable for sensitive
  communication.** There has been no independent cryptographic audit, and
  deploying to servers does not create one. Every participant in testing must be
  told this.
- **Tailnet only.** There is no public DNS record, no inbound port and no
  intention of either. The tailnet is the access control: anything that can
  reach the port can speak to the API. TLS authenticates the *server* to the
  client and encrypts the wire; it does not authenticate the client. There is no
  mTLS.
- **No mobile client.** `apps/mobile` is untouched.
- **No evidence of user demand.** Nobody outside a known test group is invited,
  and the deployment is not a launch.

And the residual the flooding closure explicitly left, restated because a
deployed relay is where it stops being academic:

- **The first walk of a very large flood is still slow.** Delivery is no longer
  blocked — a legitimate message behind a flood now arrives — but the recipient
  still downloads every poison envelope once, bounded by its own rate limit. The
  measured 4-identity / 49-envelope flood costs about 19 s of polling, paid once.
  The extreme case in the design (10 801 envelopes, ~2.8 GB) still makes the
  *first* walk take on the order of an hour. Durable read positions mean the
  victim resumes rather than restarts, so an hour of polling now delivers where
  an hour used to deliver nothing — but an hour against a 24 h message lifetime
  is not comfortable margin. **This is a bound, and it is reported as a bound.**
- **`ECHOLET_MAX_STORAGE_BYTES` is declared and enforced nowhere.** There is no
  per-mailbox occupancy cap either. A flood still fills the relay's disk without
  limit, and a reachable relay is where that becomes a live availability class
  rather than a local curiosity. Watch `df -h /var/lib/echolet`; there is no
  code path that will watch it for you.
- **Identity creation is free.** `POST /v1/device-records/publish` is still
  unauthenticated. Minting identities no longer *wedges* a mailbox — that is what
  the closure fixed, and it is measured — but nothing bounds the number of
  distinct senders in one mailbox, and nothing bounds the disk they consume.
- **One published bundle serves exactly one first-contact sender.** Unchanged
  from the local prototype; see §11 of [runbook.md](runbook.md).

See [STATUS_CURRENT.md](../../STATUS_CURRENT.md) and the flow's change report
for the complete list.
