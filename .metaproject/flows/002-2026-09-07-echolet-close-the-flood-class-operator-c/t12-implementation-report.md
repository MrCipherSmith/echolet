# T12 — Prepare the deployment artifacts (deploy nothing)

Flow: `002-2026-09-07-echolet-close-the-flood-class-operator-c`
Dispatch: `002-T12-deploy-prep` · result file `dispatches/002-T12-implement-result.json`
Date: 2026-09-07 · Node v26.5.0 (`/opt/homebrew/bin/node`) · Go 1.26.1 · darwin/arm64
Docker 28.4.0 client / 29.4.0 engine (OrbStack, linux/arm64 VM)
Criterion: AC7 (wave 3, plan item 9) — the artifact half. The "two relay
instances run" half is T11's.

---

## 0. What this task did, in one paragraph

It produced everything T11 needs and executed none of it. A container image
definition for the relay (multi-stage, both base images pinned by digest, static
binary, non-root, read-only rootfs), a compose file plus a plain-`docker run`
equivalent driven by per-host env templates, a systemd timer for certificate
renewal, and a deployment runbook. The image was **built locally for both
architectures and started in four configurations**, including the exact
`linux/amd64` artifact the two servers will run: it serves HTTPS, answers
`/health` against a verified chain, refuses a half-configured TLS pair, and
reports `healthy` to Docker. **No server was contacted.** No `ssh`, no
`tailscale cert`, no push to any registry, no `git commit`. **No existing
source, test or configuration file was modified** — the single permitted
exception is one added link line in
`docs/requirements/echolet-cli-prototype/README.md`, verified as a one-line diff
(§6).

---

## 1. The image

`apps/relay/Dockerfile` — build context is `apps/relay`, **not** the repository
root. The Go module `echolet/apps/relay` has no `replace` directive pointing
outside itself, so nothing above that directory is needed, and keeping the
context there keeps `node_modules/`, `.gocache/` (≈1 GB) and the whole pnpm
workspace out of the build.

| Decision | Value | Why |
|---|---|---|
| Builder | `golang:1.26.1-alpine3.22` @ `sha256:07e91d24f633…` | `go.mod` declares `go 1.26.1`; the toolchain is pinned to the exact version the module was tested against. |
| Runtime | `alpine:3.22` @ `sha256:14358309a308…` | see below. |
| Base pinning | digest, with a `--build-arg` override for the **host** only | A floating `golang:1.26-alpine` makes a rebuild non-reproducible, which defeats a runbook. Changing the digest is a deliberate, recorded change; changing the registry in front of it is not. |
| Cross-compile | build stage on `$BUILDPLATFORM`, `GOARCH=$TARGETARCH` | Both servers are x86_64 and the operator's machine is arm64. Go cross-compiles, so `--platform linux/amd64` costs nothing and needs no QEMU. |
| `CGO_ENABLED=0`, `-trimpath`, `-ldflags='-s -w -buildid='` | — | Static binary (badger, chi and the rest are pure Go) and the two things that otherwise make two builds of identical source differ. |
| User | `10001:10001`, non-root | The certificate pair and data directory are chowned to this uid on the host rather than making the private key world-readable. |
| Filesystem | `read_only: true` + `tmpfs /tmp`, `cap_drop: ALL`, `no-new-privileges` | The relay writes only to its data directory. |

**Why Alpine and not distroless-static.** The container `HEALTHCHECK` needs an
HTTPS client and distroless has no binaries at all. The cost is ~8 MB and a
shell; the benefit is that `docker ps` answers "is it actually serving?", which
is the first question an operator asks. The Dockerfile says so at the point of
the decision, and names the one-line change to switch. Final image: **21.3 MB**
(amd64), of which 12.1 MB is the relay binary.

The healthcheck dials loopback with `--no-check-certificate` and this is
deliberate, not sloppiness: the certificate is issued for the host's MagicDNS
name, so a loopback probe cannot validate it. It is a **liveness** check. The
check that validates the chain is the one from a second tailnet machine, and the
runbook makes that the step that matters.

`apps/relay/.dockerignore` excludes `.cache/`, `.data/` (a local relay data
directory — it holds envelope ciphertext and would otherwise land in an image
layer), the stray 18 MB `relay` binary, and `*.pem` / `*.key` / `*.crt`. The last
three are belt and braces over `.gitignore`: a build context is not a commit,
and `.gitignore` does not govern it.

### A registry problem worth recording

Docker Hub pulls from this machine's daemon **hang indefinitely** — no error, no
progress, on `docker pull`, `buildx imagetools inspect` and `load metadata`
alike. `public.ecr.aws` answered `toomanyrequests`. `mirror.gcr.io` served the
**same digests** and the build went through. Hence the `GO_IMAGE` /
`RUNTIME_IMAGE` build args and `build-image.sh --mirror gcr|ecr`: the digest is
the pin, the host in front of it is not, and a deployment that cannot be rebuilt
on a bad Docker Hub day is a deployment you do not control. The digests were
resolved independently from the Docker Hub registry API before any mirror was
used, and `mirror.gcr.io` returned identical ones.

---

## 2. Run recipes

| File | What |
|---|---|
| `deploy/relay/docker-compose.yml` | One service, **no `build:` stanza** (the hosts have no Go toolchain and no checkout), parameterised entirely by an env file. |
| `deploy/relay/run-relay.sh` | The plain-`docker run` equivalent reading the *same* env file. Ubuntu's `docker.io` package ships the engine **without** the compose plugin, and a runbook whose first host command may not exist is not a runbook. |
| `deploy/relay/env/geekom.env.example`, `env/depr.env.example` | Per-host. Two values to fill in: the image tag and the host's tailnet IPv4. |
| `deploy/relay/build-image.sh` | Builds and optionally `docker save`s a tarball. Never pushes, never `ssh`s, never touches a server. |
| `deploy/relay/systemd/echolet-cert-renew.{service,timer}` | Daily `tailscale cert` refresh, with the chown/chmod the container uid needs. |
| `deploy/relay/README.md` | What each artifact is; the procedure lives in the runbook. |

The full T8 TLS surface is wired: `ECHOLET_TLS_CERT_FILE`,
`ECHOLET_TLS_KEY_FILE`, `ECHOLET_TLS_RELOAD_INTERVAL_SECONDS`,
`ECHOLET_HTTP_ADDR` (fixed at `0.0.0.0:8443` **inside** the container; the host
side of the mapping is what varies), plus `ECHOLET_DATA_DIR` and every bound the
relay declares, restated so the deployed configuration is recorded rather than
implied.

**The certificate pair is mounted `:ro` and referenced only by path.** No env
file, compose file, script or image contains key material, and none may ever.

### The decision that matters most in these files

**`ECHOLET_BIND_ADDR` must be the host's tailnet address, never `0.0.0.0`.**
Docker publishes ports with its own DNAT rules, evaluated *before* ufw's INPUT
chain: a container published on `0.0.0.0` is reachable on every interface of a
host whose firewall denies the port. `depr` has an active ufw and it would not
help. On this deployment the bind address **is** the access control, so
`run-relay.sh` refuses `0.0.0.0` outright, the compose `ports:` entry carries the
requirement in its `:?` error message, and the env templates ship the field as a
`REPLACE_WITH_TAILSCALE_IPV4` placeholder that `run-relay.sh` also refuses.

`geekom`'s firewall state could not be read without sudo, which changes nothing
here — the bind address is what is relied on, not the firewall.

### systemd unit: no restart, on purpose

`echolet-cert-renew.service` re-runs `tailscale cert` over the same two paths and
fixes ownership. It contains **no** `systemctl restart` and no `docker restart`.
The running relay picks up a renewed pair within
`ECHOLET_TLS_RELOAD_INTERVAL_SECONDS`, detected by content digest rather than
mtime, and keeps the last good pair if a read lands mid-rewrite. A unit that
restarted the relay would turn a routine renewal into precisely the outage the
reloader exists to prevent.

---

## 3. The runbook

`docs/requirements/echolet-cli-prototype/deployment-runbook.md`, styled after the
existing `runbook.md`: numbered sections, copyable blocks, quoted output.

Sections: §0 the breaking change · §1 target hosts and the ufw/DNAT trap · §2
build · §3 transfer (`docker save | ssh … docker load`, with a digest-comparable
tarball alternative) · §4 `tailscale cert` and renewal · §5 data directory · §6
configure and start (compose *and* the `run-relay.sh` fallback) · §7 verify on
the host · §8 **verify from a second tailnet machine** · §9 point a CLI profile
at it · §10 upgrade · §11 rollback · §12 where logs, data, certificates and
recipes live · §13 teardown · §14 what this does not establish.

It states in its own header that it was **prepared, not executed**.

Three things the runbook says that cost something to say:

- **`--relay-url` exists only on `init`.** There is no supported way to repoint an
  existing profile; editing `<profile>/config.json` works and requires a
  `relay publish` afterwards, but it is unsupported and untested. Verified by
  reading `apps/cli/src/commands/cli.ts:88,176` and
  `apps/cli/src/runtime/config.ts:23-27` rather than assumed.
- **"If you need `-k`, stop and fix the certificate."** `tailscale cert` issues a
  real Let's Encrypt certificate, so the system trust store validates it; a
  verification that skips validation proves nothing, and the CLI will not skip it
  either way.
- **`docker logs` shows the certificate *paths* and never their contents.**
  Quoted from the actual startup line observed locally.

### §0 — the migration warning, stated first

The ack/poll transcript gained a `v2` form carrying `read_through`, and a relay
serving the old transcript and a client built after the change **do not
interoperate** (`403 INVALID_SIGNATURE` on the second page of every walk). The
runbook puts this before everything else and says three things:

1. **Roll the relay and the CLI together**, from the same tree.
2. **On these two fresh hosts it costs nothing** — no old data, no old client, no
   deployed peer. That is exactly why the flow's order puts the protocol change
   before the deployment.
3. **If a relay ever does have existing data**, both safe options are cheap: do
   nothing (the chunked, idempotent backfill is in the relay code and gives
   pre-index envelopes positions in their existing key order, on first touch), or
   wipe the data directory — acceptable on a prototype where nothing outlives the
   168 h retention cap. The wipe command is given with an explicit "this deletes
   undelivered envelopes, there is no undo".

Rollback carries the mirror-image warning, plus the honest detail that an older
relay ignores the newer ordering index and re-offers messages from the head of
the mailbox — re-offered, not lost, and the client deduplicates.

### §14 — limitations

Unaudited prototype, not suitable for sensitive communication, and deploying to
servers does not create an audit. Tailnet-only: the tailnet is the access
control, TLS authenticates the server and not the client, there is no mTLS. No
mobile client. No user-demand evidence. Then the residual the closure left, each
with its measured figure: the first walk of a very large flood still costs
roughly an hour (a **bound**, reported as a bound);
`ECHOLET_MAX_STORAGE_BYTES` is declared and enforced nowhere and no code path
watches the disk for you; identity creation is free because
`POST /v1/device-records/publish` is still unauthenticated; and one published
bundle still serves exactly one first-contact sender.

---

## 4. What was verified locally

Everything below ran on the operator's machine against containers. **No server
was contacted.**

| # | Check | Result |
|---|---|---|
| 1 | `build-image.sh --platform linux/arm64` | image `sha256:68dfb525dcec…`, **20 664 866 B**, `linux/arm64` |
| 2 | `build-image.sh --platform linux/amd64 --save …` — **the artifact the servers will run** | image `sha256:c7cb5c7b203a…`, **21 310 733 B**, `linux/amd64`; tarball 21 630 464 B, sha256 `f475cdddfb66…` |
| 3 | image internals | `uid=10001(echolet)`, `/usr/local/bin/relay` mode `r-xr-xr-x` root-owned, 12 124 286 B; `ssl_client` present for the healthcheck |
| 4 | amd64 binary is really amd64 | `uname -m` → `x86_64`; ELF header `7f 45 4c 46 02` (ELF64) |
| 5 | plain-HTTP start, `/health` | `{"ok":true,"data":{"status":"healthy","uptime_ms":1036}}`; log line `scheme=http` |
| 6 | HTTPS start with a **read-only** mounted pair, `--read-only`, `--cap-drop ALL`, `no-new-privileges`, uid 10001 | `/health` **200 over a verified chain** (`curl --cacert`, SNI `relay.test`) |
| 7 | plaintext to the TLS port | `Client sent an HTTP request to an HTTPS server.` — never the API in the clear |
| 8 | startup log in TLS mode | `scheme=https tls_cert_file=/etc/echolet/tls/cert.pem tls_key_file=/etc/echolet/tls/key.pem` — paths only |
| 9 | half-configured pair (cert, no key) | exits non-zero naming **both** variables |
| 10 | TLS pair pointing at absent files | exits non-zero naming the path: `tlsx: read certificate /etc/echolet/tls/absent.pem: … no such file or directory` |
| 11 | container `HEALTHCHECK` | both the HTTP and the HTTPS container report `healthy`, probe exit code 0 |
| 12 | `docker compose config` with **both** env files | valid for `geekom` and `depr` |
| 13 | `run-relay.sh` guard: placeholder left in the env file | refused — `ECHOLET_BIND_ADDR still holds the placeholder 'REPLACE_WITH_TAILSCALE_IPV4'` |
| 14 | `run-relay.sh` guard: `ECHOLET_BIND_ADDR=0.0.0.0` | refused — *"would publish the relay on every interface"* |
| 15 | `run-relay.sh` real start, HTTPS, host bind-mounted data dir | `/health` 200 over the verified chain |
| 16 | `bash -n` on both scripts | clean |
| 17 | secret scan over every new file | no PEM block, no key, no certificate content |

Relay binary sha256 inside each image, for T11 to compare after transfer:
`cf0f05bc30d9…` (arm64), `ceac79696ca4…` (amd64).

All verification containers and volumes were removed afterwards.

### What was NOT verified, stated plainly

- **Byte-for-byte reproducibility was not measured.** The inputs that make it
  possible are in place (digest-pinned bases, `-trimpath`, `-buildid=`,
  `-mod=readonly` against the committed `go.sum`); two independent builds were
  not diffed.
- **No `tailscale cert` was run**, so the real Let's Encrypt chain was never
  served. Checks 6 and 15 used the relay module's own `devcert` generator with an
  explicit trust anchor: that proves the serving and mounting mechanics, not the
  public chain.
- **The healthcheck was observed on linux/arm64 and amd64 under emulation**, not
  on Ubuntu 24.04 x86_64 hardware.
- **`docker compose` was validated with `config`, not by running it.** The
  container it describes was exercised through the `run-relay.sh` equivalent,
  which builds the same flags.
- **Bind mounts behaved as macOS/OrbStack maps them.** On the Linux hosts the
  `chown 10001:10001` in §4 and §5 of the runbook is load-bearing and untested.

---

## 5. Exactly what T11 still has to do

Per host, in order. Nothing below has been run.

1. `./deploy/relay/build-image.sh --platform linux/amd64 --save out/echolet-relay.tar`
   on the operator's machine. Prefer a clean tree so the tag is not `-dirty`.
2. `docker save … | ssh <user>@<host> 'docker load'` — no sudo needed, both users
   are in the `docker` group.
3. On the host, with sudo (**password on `geekom`**, passwordless on `depr`):
   `tailscale cert` into `/etc/echolet/tls/{cert,key}.pem`, then
   `chown 10001:10001`, `chmod 0644` / `0600`.
4. `mkdir -p /var/lib/echolet && chown -R 10001:10001 && chmod 0700`.
5. Copy `deploy/relay/` to the host, `cp env/<host>.env.example env/<host>.env`,
   and fill in **two** values: `ECHOLET_IMAGE` (the tag from step 1) and
   `ECHOLET_BIND_ADDR` (`tailscale ip -4` on that host — never `0.0.0.0`).
6. `docker compose --env-file env/<host>.env -f docker-compose.yml up -d`, or
   `./run-relay.sh env/<host>.env` if the compose plugin is absent.
7. Confirm `scheme=https` in `docker logs` and `(healthy)` in `docker ps`.
8. Install and enable the renewal timer, setting `ECHOLET_TLS_HOSTNAME` in a
   drop-in.
9. **From a second tailnet machine**, `curl -sS https://<host>.tail5a88fb.ts.net:8443/health`
   with no `-k`, then the full acceptance scenario with a CLI profile
   `init`ed at that URL. This is the half of AC4 and AC7 that only T11 can close.

Two open decisions T11 owns, deliberately left open here:

- **Port.** The artifacts use `8443` throughout. Nothing listens on 80 or 443 on
  either host, so `443` is available if preferred; it would change one value in
  each env file and every client URL.
- **Whether `depr`'s ufw should also deny the port.** It is defence in depth
  behind the bind address, not a substitute for it, and reading the current rules
  needs sudo.

---

## 6. Files created

Every file below is **new**. No existing source, test or configuration file was
modified.

| File | What |
|---|---|
| `apps/relay/Dockerfile` | multi-stage, digest-pinned bases, cross-compiling, non-root, healthchecked |
| `apps/relay/.dockerignore` | keeps `.cache/`, `.data/`, the stray binary and any PEM out of the build context |
| `deploy/relay/docker-compose.yml` | one service, env-file-parameterised, `:ro` certificate mount, hardened |
| `deploy/relay/run-relay.sh` | the same container via plain `docker run`, with the `0.0.0.0` and placeholder guards |
| `deploy/relay/build-image.sh` | build + optional `docker save`; never pushes, never `ssh`s |
| `deploy/relay/env/geekom.env.example` | `geekom` configuration; two placeholders to fill |
| `deploy/relay/env/depr.env.example` | `depr` configuration; two placeholders to fill |
| `deploy/relay/systemd/echolet-cert-renew.service` | `tailscale cert` refresh + ownership; **no restart** |
| `deploy/relay/systemd/echolet-cert-renew.timer` | daily, randomised, `Persistent=true` |
| `deploy/relay/README.md` | what each artifact is, and the three rules the files enforce |
| `docs/requirements/echolet-cli-prototype/deployment-runbook.md` | the runbook |
| `.metaproject/flows/002-…/t12-implementation-report.md` | this file |

**One line in one existing file**, the permitted exception:

```diff
 - [Runbook: reproduce the prototype from a clean checkout](runbook.md)
+- [Deployment runbook: stand a relay up on a tailnet host](deployment-runbook.md)
```

`git diff --stat docs/requirements/echolet-cli-prototype/README.md` →
`1 file changed, 1 insertion(+)`.

The other modified paths in `git status` (`apps/relay/cmd/relay/main.go`,
`apps/relay/internal/config/config.go`, `apps/cli/test/e2e/flood-closure.test.ts`,
`docs/requirements/echolet-cli-prototype/runbook.md`, and the flow's own
`flow.json` / `journal.md`) belong to T7, T8 and T10 and were **read only** by
this task. T10's measurements are unaffected: no file it could be measuring was
touched.

No `git commit` was made. No workspace test suite was run — T10 owns the
machine's test resources.

---

## 7. Routing audit

- `graph_used`: **no** — `not-relevant`. Every path was either named by the
  dispatch, quoted from the T7/T8 reports, or a new file.
- `wiki_used`: **partial** — the authoritative sources were the flow's
  `description.md`, `plan.md`, `acceptance-criteria.md` and `journal.md`, the T7
  report (§5 migration, §6 residuals) and the T8 report (§1 configuration, §3
  reload, §6 operator steps), all read in full, plus the existing `runbook.md`
  for style.
- `ctx_used`: **yes** — `keryx ctx rg` for every code search, `keryx ctx read`
  and `keryx ctx run` for compact reads and long-output commands.
- `raw_rg_used`: **no**. Raw `cat`/`sed`/`tail` were used, each with an explicit
  `# keryx:raw` marker, only where byte-exact output was load-bearing: registry
  **digests** (a compacted digest is a useless digest), docker build/verification
  logs, and `git diff` output quoted in this report.

## 8. Integrity

No private key, certificate content, store key, plaintext or ciphertext was
logged, printed, or written into any artifact by this task. The only certificate
material that existed was a self-signed development pair under the session
scratchpad, generated by the relay module's own `devcert` command and never
copied into the repository or into an image. Certificate and key **paths** appear
in configuration, in one startup log line and in the runbook; contents never do.
Both scripts and every new file were scanned for PEM blocks and key-shaped
strings and came back clean. No server was contacted, no registry was pushed to,
and no `git commit` was made.
