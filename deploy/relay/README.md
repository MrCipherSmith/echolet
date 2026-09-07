# deploy/relay

Deployment artifacts for the Echolet relay. **The procedure lives in
[`docs/requirements/echolet-cli-prototype/deployment-runbook.md`](../../docs/requirements/echolet-cli-prototype/deployment-runbook.md)**;
this file only says what each artifact is.

| File | What it is |
|---|---|
| `build-image.sh` | Builds `apps/relay/Dockerfile` for a target platform and optionally saves a `docker load` tarball. Never pushes, never ssh's, never touches a server. |
| `docker-compose.yml` | One relay service, parameterised entirely by an env file. No `build:` stanza — the hosts have no Go toolchain and no checkout. |
| `run-relay.sh` | The plain-`docker run` equivalent, reading the same env file, for a host without the compose plugin. |
| `env/geekom.env.example`, `env/depr.env.example` | Per-host configuration. Copy to `*.env` and fill in the image tag and the host's tailnet address. |
| `systemd/echolet-cert-renew.{service,timer}` | Daily `tailscale cert` refresh. Contains no restart: the running relay reloads a renewed pair on its own. |

Three rules that the files enforce and this table cannot:

1. **No secret ever lives here.** The certificate and private key are produced by
   `tailscale cert` on the host, referenced by path, and mounted **read-only**.
   The key is never copied, never baked into an image and never committed.
2. **Never publish on `0.0.0.0`.** Docker's port DNAT runs before ufw, so a
   `0.0.0.0` publish is reachable on every interface of a host whose firewall
   denies the port. `ECHOLET_BIND_ADDR` must be the host's tailnet address;
   `run-relay.sh` refuses anything else.
3. **Relay and CLI roll together.** The mailbox ack/poll transcript changed and
   the change is breaking — see §0 of the deployment runbook before upgrading
   anything.
