# deploy/relay

Deployment artifacts for the Echolet relay. **The procedure lives in
[`docs/requirements/echolet-cli-prototype/deployment-runbook.md`](../../docs/requirements/echolet-cli-prototype/deployment-runbook.md)**;
this file only says what each artifact is.

| File | What it is |
|---|---|
| `build-image.sh` | Builds `apps/relay/Dockerfile` for a target platform and optionally saves a `docker load` tarball. Never pushes, never ssh's, never touches a server. |
| `docker-compose.yml` | **The production file.** One relay service over TLS, parameterised entirely by an env file. No `build:` stanza — the hosts have no Go toolchain and no checkout. |
| `run-relay.sh` | The plain-`docker run` equivalent, reading the same env file, for a host without the compose plugin. Also carries the insecure loopback mode (below). |
| `env/geekom.env.example`, `env/depr.env.example` | Per-host TLS configuration. Copy to `*.env` and fill in the image tag and the host's tailnet address. |
| `docker-compose.insecure-loopback.yml` | **Plain HTTP, 127.0.0.1 only.** The stopgap shape that is actually running on both hosts today, because the tailnet's HTTPS Certificates toggle is off. Never a fallback — see below. |
| `env/insecure-loopback.env.example` | Configuration for that stopgap. Host-agnostic apart from the callsign. |
| `systemd/echolet-cert-renew.{service,timer}` | Daily `tailscale cert` refresh. Contains no restart: the running relay reloads a renewed pair on its own. |

Four rules that the files enforce and this table cannot:

1. **No secret ever lives here.** The certificate and private key are produced by
   `tailscale cert` on the host, referenced by path, and mounted **read-only**.
   The key is never copied, never baked into an image and never committed.
2. **Never publish on `0.0.0.0`.** Docker's port DNAT runs before ufw, so a
   `0.0.0.0` publish is reachable on every interface of a host whose firewall
   denies the port. `ECHOLET_BIND_ADDR` must be the host's tailnet address;
   `run-relay.sh` refuses anything else.
3. **Plain HTTP is an opt-in, never a fallback.** A missing or malformed
   certificate on the TLS path is still a hard startup failure and must stay
   one. The insecure path is reached only by setting
   `ECHOLET_INSECURE_LOOPBACK_ONLY=yes-plain-http-on-loopback-only`, and it is
   confined to loopback by construction: `run-relay.sh` refuses any
   `ECHOLET_BIND_ADDR` other than `127.0.0.1` or `[::1]` while it is set and
   names the offending value, and
   `docker-compose.insecure-loopback.yml` hardcodes the literal `127.0.0.1` in
   its `ports:` line so there is no variable to get wrong. Both label the
   container `echolet.tls=disabled-insecure-loopback-only`, and the relay
   announces the result in its own first log line
   (`scheme=http tls_cert_file="" tls_key_file=""`).
4. **Relay and CLI roll together.** The mailbox ack/poll transcript changed and
   the change is breaking — see §0 of the deployment runbook before upgrading
   anything.

### The two modes, side by side

| | TLS (`docker-compose.yml`, `run-relay.sh` with `ECHOLET_TLS_DIR`) | Insecure loopback (`docker-compose.insecure-loopback.yml`, or `run-relay.sh` with the acknowledgement) |
|---|---|---|
| Published on | the host's tailnet address | `127.0.0.1` only, enforced |
| Reachable from another machine | yes, directly | no — only through `ssh -L` |
| Wire confidentiality | the relay's TLS | SSH's, if a tunnel is used; none otherwise |
| Certificate missing | **hard startup failure**, unchanged | there is no certificate |
| Needs `sudo` on the host | yes (`tailscale cert`, `/etc/echolet`, `/var/lib/echolet`) | **no** — named Docker volume, `docker` group only |
| Data | host bind mount `ECHOLET_HOST_DATA_DIR` | named volume `ECHOLET_DATA_VOLUME` |
| Blocked today by | HTTPS Certificates toggle (runbook §3.1) | nothing |
| Evidence for AC4 | yes | **no** |

Hardening is identical in both: read-only root filesystem, `/tmp` tmpfs, uid
10001, `no-new-privileges`, all capabilities dropped, `restart: unless-stopped`,
json-file logs capped at 5 × 20 MB.
