# Echolet Relay Deployment Runbook
Version: 0.5.1

Copyable commands for standing up a relay on a tailnet host, and for standing it
up again on a clean one. Companion to
[runbook.md](runbook.md), which reproduces the **local** prototype; that document
is the one to read first, and every command here assumes the relay it describes.

**Status of this document: executed on both hosts. Both relays serve TLS, both
certificates renew themselves — but the two hosts renew by different mechanisms,
and §4.1 says plainly why.**

- **`depr` is on the TLS path.** Since 2026-09-07 19:36 UTC it publishes HTTPS on
  its tailnet address `100.100.188.64:8443`, with a real Let's Encrypt
  certificate for `depr.tail5a88fb.ts.net` terminated by the relay process
  itself. Recorded in
  [`t11-tls-report.md`](../../../.metaproject/flows/002-2026-09-07-echolet-close-the-flood-class-operator-c/t11-tls-report.md).
  **Renewal is installed**: the committed `systemd/` units, verbatim, as a
  root-scope timer — §4.1.
- **`geekom` is on the TLS path too.** Since 2026-09-07 20:41 UTC it publishes
  HTTPS on `100.116.255.111:8443` for `geekom.tail5a88fb.ts.net`. It differs from
  `depr` in two ways that matter operationally: its certificate pair lives in a
  **named Docker volume** (`echolet-relay-tls`) rather than in `/etc/echolet/tls`,
  and its renewal is a **`systemctl --user` timer**, because that host's operator
  has no usable root. Recorded in
  [`t11-geekom-tls-report.md`](../../../.metaproject/flows/002-2026-09-07-echolet-close-the-flood-class-operator-c/t11-geekom-tls-report.md).
  The original two-host loopback deployment, which both hosts have now left, is
  recorded in
  [`t11-deployment-report.md`](../../../.metaproject/flows/002-2026-09-07-echolet-close-the-flood-class-operator-c/t11-deployment-report.md).

**The committed `deploy/relay/systemd/` units work as written on `depr` and are
unusable as written on `geekom`.** They assume a root install into
`/etc/systemd/system`, a root-owned `/etc/echolet/tls`, a root `chown` to uid
10001, and they know nothing about a Docker volume. Every one of those
assumptions holds on `depr` and fails on `geekom`. §4.1 gives both routes. Do
not copy the five-line recipe onto a host without checking which case it is.

No image has been pushed to a registry; both hosts were loaded from a `docker
save` tarball as §3 describes.

**Which path to follow.**

- **§2 → §3 → §3.1 → §4 → §5 → §6 → §7 → §8** is the TLS path. It is the
  intended production route and it is **no longer blocked**: HTTPS Certificates
  are enabled for the tailnet and both hosts completed this path end to end.
  `depr` took it as written. `geekom` took the **no-root variant** in §4.1, which
  needs no `sudo` at any point.
- **§2 → §3 → §6.5 → §7.5** is the loopback-only path. **Neither host runs it any
  more.** It needs no certificate, no `sudo` on the host and no firewall change,
  and it publishes plain HTTP on `127.0.0.1` and nowhere else. It is a
  deliberate second path, not a fallback, and it never establishes AC4 (§7.5).

Both target hosts were surveyed, read-only, before any of this: every fact in §1
and in §1.1 was observed on the hosts on 2026-09-07 by the reconnaissance
recorded in
[`t11-host-recon.md`](../../../.metaproject/flows/002-2026-09-07-echolet-close-the-flood-class-operator-c/t11-host-recon.md).

## Before anything else — read §0, then check §3.1

§0 is a breaking change. Deploying without it is how you get two relays that a
client cannot talk to, or a mailbox that silently delivers nothing.

§3.1 is a prerequisite that lives in the Tailscale admin console, not on the
hosts. It **is satisfied now** — the tailnet owner enabled HTTPS Certificates on
2026-09-07 and `depr` issued a certificate on the first attempt — but check it
anyway before you build an image, because it is a tailnet-wide setting that can
be turned off again: `tailscale cert` fails without it, and **the relay has no
plain-HTTP fallback to degrade to** — a missing or malformed certificate is a
hard startup failure, by design, and nothing in §6.5 changes that. If §3.1 is
ever off again and you need a relay running anyway, go to **§6.5**, which is a
different thing you ask for explicitly, not a softer version of §6.

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

Every value in this table was observed on the hosts on 2026-09-07 by the
read-only survey in
[`t11-host-recon.md`](../../../.metaproject/flows/002-2026-09-07-echolet-close-the-flood-class-operator-c/t11-host-recon.md).
It is a record, not an expectation: you do not need to re-discover any of it.

| | `geekom.tail5a88fb.ts.net` | `depr.tail5a88fb.ts.net` |
|---|---|---|
| OS / arch | Ubuntu 24.04.4 LTS, x86_64 → `linux/amd64` | Ubuntu 24.04.4 LTS, x86_64 → `linux/amd64` |
| Resources | 16 cores, 27 GiB, 580 G free on `/` | 4 cores, 7.6 GiB, 49 G free on `/` |
| Login | `altsay` | `ubuntu` |
| `sudo` | **needs a password** (`sudo -n` refuses) | passwordless (`(ALL) NOPASSWD: ALL`) |
| Docker | 29.3.0, usable **without** sudo | 29.1.3, usable **without** sudo |
| `docker compose` v2 | **present**, v5.1.0 | **present**, 2.40.3 (from `docker.io`) |
| Tailscale | 1.102.2, `Running`, MagicDNS | 1.102.3, `Running`, MagicDNS |
| Tailnet IPv4 → `ECHOLET_BIND_ADDR` | **`100.116.255.111`** | **`100.100.188.64`** |
| Ports 443 / 8443 | **both free** | **both free** |
| Firewall | ufw active; ruleset not readable without sudo | ufw active, `Anywhere on tailscale0 ALLOW IN` |
| Clock | NTP-synced, UTC, stratum 1 | NTP-synced, UTC, stratum 2 |
| Existing echolet artefact *(at survey time)* | **none** — no container, image, unit, process, `/etc/echolet` or `/var/lib/echolet` | **none**, same |
| Callsign | `RPT-GEEKOM-01` | `RPT-DEPR-01` |

That last row is a record of the survey, taken before the deployment. **Both
hosts now run one `echolet-relay` container each on the TLS path**, both against
the named volume `echolet-relay-data`, and neither has `/var/lib/echolet`. What
they no longer have in common:

| | `geekom` | `depr` |
|---|---|---|
| Certificate pair | named volume `echolet-relay-tls` | host directory `/etc/echolet/tls` |
| `/etc/echolet` on the host | absent | present, root-owned, files owned `10001:10001` |
| Renewal timer | `systemctl --user`, owned by `altsay`, lingering | `systemctl`, root, `/etc/systemd/system` |
| `sudo` used, ever | none | yes, throughout |

A genuinely clean host matches the survey row as written; neither of these two
does any more.

Neither host has Go, Node (as a build toolchain), a checkout or an active
reverse proxy, and nothing listens on 80, 443 or 8443. The image is therefore
built on the operator's machine and carried over. On a host with usable root,
`sudo` is needed only for `tailscale cert`, the two directories and the renewal
timer; on a host without it, §4.1's no-root variant needs none at all, because
the Docker daemon is already root.

### 1.1 What the survey settled, so you do not re-check it

**Two values, and only two, must be supplied per host** — both templates carry
correct defaults for everything else:

| Variable | `geekom` | `depr` |
|---|---|---|
| `ECHOLET_IMAGE` | `echolet-relay:<tag from §2>` | the **same** tag |
| `ECHOLET_BIND_ADDR` | `100.116.255.111` | `100.100.188.64` |

**Operator ergonomics differ, capability does not.** `geekom`'s `altsay` has
password-gated `sudo`, so every privileged step there (§4, §5, the timer) needs
an **interactive** session — a non-interactive `ssh geekom 'sudo …'` will fail
rather than prompt. `depr`'s `ubuntu` is `NOPASSWD: ALL`, so `depr` can be
scripted end to end.

Ruled out by the survey — none of these is a step, and none needs re-checking:

- **No `ufw allow 8443` on either host.** Docker's published-port DNAT is
  evaluated before ufw's INPUT chain, so a ufw rule would neither grant nor deny
  the relay's port; the bind address is the access control. `depr` additionally
  already allows `Anywhere on tailscale0`.
- **No compose install.** Both hosts have the v2 plugin (see §6).
- **No `usermod -aG docker`.** Both users are already in the group.
- **No port-conflict remediation.** 443 and 8443 are free on both. (`geekom`
  listens on 9443, which is not 8443.)
- **No time-sync work.** Both clocks are NTP-synchronised in UTC, so certificate
  validity will not be affected by skew.
- **No Go or Node toolchain on a host.** The image is built on the operator's
  machine and `docker load`ed.

What the survey could **not** settle, and where it gets settled instead:
`geekom`'s ufw/nftables ruleset (needs interactive sudo — resolve with one
`sudo ufw status verbose` while you are at the prompt for §4; assessed impact
none, for the DNAT reason above), whether `tailscale cert` actually succeeds
once §3.1 is done (first real test is §4 on one host), and the tailnet ACL
(settled by §8 from a second machine).

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

One caveat you will hit on this repository: `build-image.sh` appends `-dirty`
when **anything anywhere** in the tree is uncommitted, but the Dockerfile's
build context is only `apps/relay`. Documentation edits therefore produce a
`-dirty` tag on an image that *is* reproducible. Do not silence the suffix —
run the narrower check and record its result next to the tag:

```sh
git status --porcelain -- apps/relay        # empty => the build context is clean
git diff --stat HEAD -- apps packages       # empty => nothing the image copies changed
```

The two relays running today are tagged `echolet-relay:20260907-c302485-dirty`
and both checks above were empty at `c302485`.

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

## 3.1 Prerequisite: HTTPS Certificates must be enabled for the tailnet

**Check this before §4. It cannot be fixed on the host, and every step from §4
onward depends on it. It is satisfied now** — the tailnet owner enabled it on
2026-09-07 and `depr` issued a certificate on the first attempt — **but it is a
tailnet-wide setting that someone can turn off again, so re-run the check rather
than trusting this paragraph.**

`tailscale cert` can only issue a certificate for a name the tailnet has
authorised the node to request. If the tailnet does not have **HTTPS
Certificates** enabled, there is no such name, and no amount of host
configuration substitutes for it.

**How to detect it.** On each host, read the `CertDomains` field of the
Tailscale client's own status:

```sh
tailscale status --json | jq .CertDomains
# want: [ "geekom.tail5a88fb.ts.net" ]   (or "depr.tail5a88fb.ts.net" on depr)
# blocked: null
```

`CertDomains` is the field the Tailscale client populates with the names it is
permitted to issue certificates for. `null` means HTTPS Certificates are not
enabled for this tailnet. It was `null` on both `geekom` and `depr` when they
were first surveyed on 2026-09-07 — one tailnet, one setting, both hosts blocked
at once. **After the tailnet owner enabled the toggle later that day, `depr`
reports `CertDomains: ["depr.tail5a88fb.ts.net"]`** and issuance succeeded.
`geekom` was not re-checked, because the setting is tailnet-wide and `geekom` was
deliberately not touched; run the command there before §4 rather than assuming.

**What it looks like if you skip the check.** `sudo tailscale cert` in §4 fails
and writes no `cert.pem` and no `key.pem`. The relay refuses to start without
both: it **never degrades to plain HTTP**, so the container does not come up at
all and §7's `scheme=https` line never appears. The failure surfaces two steps
after its cause, on the host, after the image has already been built and
carried over.

**The fix, and who can perform it.** Tailscale **admin console** → **DNS** →
**HTTPS Certificates** → *Enable*. It is a toggle, performed by the tailnet
owner (the tailnet owner for `tail5a88fb.ts.net`), and it **cannot be
done over SSH** — no command on either host can enable it. This is the step that
was performed on 2026-09-07 and that unblocked the TLS path. Re-run the
`tailscale status --json` check above afterwards and require the host's MagicDNS
name to be listed before continuing to §4.

One honest limit on this check: `CertDomains: null` is a reliable *negative*
signal, but a non-null value is not a guarantee that issuance will succeed —
an ACL or tailnet policy could still refuse. The first real test is §4 on one
host, and that is the right place to discover it.

## 4. Obtain the certificate (on the host, once per host)

`tailscale cert` issues a real Let's Encrypt certificate for the host's MagicDNS
name. No public DNS record is created and no inbound port is opened.

**Do §3.1 first.** These commands fail with no certificate written if HTTPS
Certificates are not enabled for the tailnet.

On `geekom` this must be an **interactive** session: `altsay`'s `sudo` asks for
a password, so a piped `ssh geekom 'sudo …'` fails rather than prompting. On
`depr` the same commands run non-interactively.

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

That reload path is covered by an automated test
(`apps/cli/test/e2e/relay-tls.test.ts`, "picks up a renewed certificate without a
restart"), but it has **never been exercised on either host**: doing so means
re-issuing the certificate, and Let's Encrypt rate-limits duplicates for one name
at roughly five per week. Treat hot reload on both hosts as unproven rather than
as demonstrated. What *is* proven on both hosts is the other half — that a
renewal's bytes land at the path the running container reads (§4.1).

### 4.1 Renewal is installed on both hosts, by two different mechanisms

**Both hosts renew themselves. They do not do it the same way, and an operator
must know which host is which before touching either.** The difference is not
taste: it follows from whether the host's operator has usable root.

| | `depr` | `geekom` |
|---|---|---|
| Operator's `sudo` | passwordless | **password-gated** — unusable from a non-interactive session |
| Certificate pair lives in | `/etc/echolet/tls` on the host, bind-mounted `:ro` | named volume `echolet-relay-tls` |
| Timer scope | **system** — `/etc/systemd/system`, run as root | **user** — `~/.config/systemd/user`, run as `altsay`, `Linger=yes` |
| Uses the committed units? | **yes, byte-for-byte** (`sha256 2711142b…` / `c18f0395…`) plus a per-host drop-in | **no** — see below |
| Schedule | `OnCalendar=daily`, `RandomizedDelaySec=6h`, `Persistent=true` | identical |
| Restarts the relay? | **no** | **no** |
| Status command | `systemctl status echolet-cert-renew.timer` | `systemctl --user status echolet-cert-renew.timer` |
| History | `journalctl -u echolet-cert-renew` | `journalctl --user -u echolet-cert-renew` |

Everything an operator normally cares about is the same on both hosts — unit
name, schedule, the no-restart guarantee, and the shape of the status output. The
only thing that differs is the `--user` flag. That is the uniformity that was
worth having; forcing `geekom`'s volume layout onto `depr` (or the reverse) would
have meant restructuring a running TLS relay for symmetry alone, and was
deliberately not done.

**On `depr` — the committed units, unmodified.** They were installed verbatim;
the only per-host value is supplied by a drop-in, which is what
`systemctl edit` writes:

```sh
cd ~/echolet-deploy      # or deploy/relay/ in a checkout
sudo install -m 0644 -o root -g root systemd/echolet-cert-renew.service /etc/systemd/system/
sudo install -m 0644 -o root -g root systemd/echolet-cert-renew.timer   /etc/systemd/system/

# the per-host value; `sudo systemctl edit echolet-cert-renew.service` writes the same file
sudo mkdir -p /etc/systemd/system/echolet-cert-renew.service.d
printf '[Service]\nEnvironment=ECHOLET_TLS_HOSTNAME=%s\n' "$(hostname).tail5a88fb.ts.net" \
  | sudo tee /etc/systemd/system/echolet-cert-renew.service.d/10-hostname.conf

sudo systemctl daemon-reload
sudo systemctl enable --now echolet-cert-renew.timer
sudo systemctl start echolet-cert-renew.service   # prove it once, end to end
systemctl status echolet-cert-renew.service --no-pager
```

Why this is enough on `depr`, and why no volume-refresh step is needed: the
container's TLS mount is a **directory bind mount of the same host directory**,
so `/etc/echolet/tls/cert.pem` on the host and inside the container are the same
inode (verified: `ino=2177654` on both sides). A write by the unit *is* a write
to the path the relay reads. There is nothing in between that could fail.

**On `geekom` — the committed units cannot be used, and were not.** Each of their
assumptions fails there: no root to install into `/etc/systemd/system`, no root
to `daemon-reload` or `enable`, no `/etc/echolet` at all, no root to `chown` to
uid 10001, and — decisively — the relay reads its pair from the Docker volume
`echolet-relay-tls`, so rewriting a host path would never reach the container.
The equivalent there is a `systemctl --user` timer running a small script under
`~/echolet-cert-renew/`, which re-runs `tailscale cert` into `~/echolet-tls`
(mode `0700`) and then pushes the pair into the volume with a throwaway
`--user 0` container — the Docker daemon is already root, so the host needs no
privilege:

```sh
docker run --rm --user 0 --entrypoint /bin/sh \
  -v ~/echolet-tls:/src:ro -v echolet-relay-tls:/dst "$IMG" -c '
    cp /src/cert.pem /dst/cert.pem.new; cp /src/key.pem /dst/key.pem.new
    chown 10001:10001 /dst/cert.pem.new /dst/key.pem.new
    chmod 0644 /dst/cert.pem.new; chmod 0600 /dst/key.pem.new
    mv /dst/cert.pem.new /dst/cert.pem; mv /dst/key.pem.new /dst/key.pem'
```

`$IMG` is read from the running container rather than pinned, so a relay upgrade
cannot leave renewal pointing at a deleted tag. The full script and its install
are in
[`t11-geekom-tls-report.md`](../../../.metaproject/flows/002-2026-09-07-echolet-close-the-flood-class-operator-c/t11-geekom-tls-report.md)
§8.

**Neither unit contains a `restart`, of the relay or of anything else.** A
renewal that restarted the relay would turn a routine event into the outage the
reloader exists to prevent.

**A daily run costs nothing while the certificate is fresh.** `tailscale cert`
answers `Public cert unchanged` / `Private key unchanged` and makes no Let's
Encrypt request; the certificate serial is identical before and after. Proven on
both hosts, so proving the timer works does not spend the duplicate budget.

**What renewal does *not* yet prove, on either host:**

- **The relay's in-process reloader has never picked up genuinely new certificate
  content on a real host.** Forcing that means re-issuing into the duplicate rate
  limit. Delivery to the container's path is proven on both hosts; *pickup* rests
  on the automated test and on the code.
- **Neither host has been rebooted since its timer was installed.** "The timer
  comes back after a reboot" rests on the documented mechanism — the
  `timers.target.wants` symlink on `depr`, that plus `Linger=yes` on `geekom` —
  not on an observed boot.
- The first *real* renewal on either host falls around early December 2026.
  Every run before then is the no-op above.

One wart worth knowing: the committed `.service` carries
`[Install] WantedBy=multi-user.target`. Do not `systemctl enable` the *service*;
enable only the **timer**. The service is `TriggeredBy=` the timer and should
show `disabled` in `systemctl status`, which is correct, not a mistake.

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

Both addresses are already known (§1.1): `100.116.255.111` on `geekom`,
`100.100.188.64` on `depr`. `tailscale ip -4` is the way to confirm one, not to
discover it. `run-relay.sh` hard-fails on a leftover `REPLACE_WITH_*`
placeholder and on `0.0.0.0`; `docker-compose.yml` catches an *unset* variable
but not a wrong bind address, so read that line twice or start through
`run-relay.sh`.

`run-relay.sh` also wants exactly one of `ECHOLET_HOST_DATA_DIR` (a host path,
this path) and `ECHOLET_DATA_VOLUME` (a named Docker volume, the §6.5 path), and
refuses if both are set. The TLS templates set the first and leave the second
empty; leave them that way here.

**Known limitation — `docker-compose.yml` cannot start a TLS relay on an
existing named volume.** Its data mount is
`"${ECHOLET_HOST_DATA_DIR:?…}:/var/lib/echolet"` and it has no
`ECHOLET_DATA_VOLUME` branch at all, so `docker compose config` fails outright
(`required variable ECHOLET_HOST_DATA_DIR is missing a value`) when the store
lives in a named volume rather than a host directory. That is exactly the
situation on a host that first ran the §6.5 loopback path, whose data is in
`echolet-relay-data`. **Of the two committed start artifacts, only
`run-relay.sh` can perform that switch**, and it is what was used on `depr`
(`t11-tls-report.md` §3.1–§3.2). The alternative — migrating the Badger store
out of the volume into `/var/lib/echolet` — destroys the continuity the switch
is supposed to preserve. This is reported, not worked around; the compose file
is unchanged.

Then, on the host, with `deploy/relay/` copied over (`scp -r deploy/relay
"$USER_AT@$HOST":~/echolet-deploy`):

```sh
docker compose version && \
  docker compose --env-file env/geekom.env -f docker-compose.yml up -d
```

Ubuntu's `docker.io` package can ship the engine without the compose plugin.
**On these two hosts that caveat does not apply** — the survey found the v2
plugin on both (`geekom` v5.1.0, `depr` 2.40.3 from `docker.io` itself), so the
compose path above works and `run-relay.sh` is a fallback, not a requirement.
On a genuinely clean host where `docker compose version` is not found, the
plain-`docker run` equivalent reads the same env file and produces the same
container:

```sh
./run-relay.sh env/geekom.env            # add --print to see the command first
```

Repeat for `depr` with `env/depr.env`. Keep the bounds identical on both hosts:
two relays that disagree about retention or maximum message size make every
cross-relay observation ambiguous.

## 6.5 The loopback-only path — plain HTTP, `127.0.0.1`, no certificate

**This is what is running on `geekom` today.** (`depr` was moved to the TLS path
of §6 on 2026-09-07 and no longer runs this one.) Follow §2, §3 and then this
section, and a clean host ends up in exactly the same state as `geekom`.

### Why it exists, and what it is not

This path exists for a host that has no certificate pair to mount — because §3.1
is off, or because nobody can run §4's `sudo` there yet, which is `geekom`'s
situation. The relay does not degrade to plain HTTP when a certificate is
missing: it exits non-zero at startup, and that behaviour is deliberate and
unchanged. So on such a host §6 cannot start anything at all.

This section is the explicit alternative. It is **not** a fallback:

- Nothing in §6 falls through to here. A missing or malformed certificate on the
  TLS path is still a hard startup failure.
- Reaching this path requires setting
  `ECHOLET_INSECURE_LOOPBACK_ONLY=yes-plain-http-on-loopback-only` — the exact
  string, or `run-relay.sh` refuses and prints the value it got.
- It is confined to loopback **structurally**, not by convention.
  `run-relay.sh` refuses any `ECHOLET_BIND_ADDR` other than `127.0.0.1` or
  `[::1]` while the acknowledgement is set, naming the offending value;
  `docker-compose.insecure-loopback.yml` does not read `ECHOLET_BIND_ADDR` at
  all — it hardcodes the literal `127.0.0.1` in its `ports:` line, so there is
  no variable to mistype. This matters because Docker's published-port DNAT is
  evaluated before ufw's INPUT chain: on both hosts the publish address is the
  access control, and no firewall rule would rescue a wrong one.
- The container is labelled `echolet.tls=disabled-insecure-loopback-only`, and
  the relay says it in its own first log line.

It also happens to need **no `sudo` at all**, because the data directory is a
named Docker volume seeded from the image's already-`chown`ed
`/var/lib/echolet` rather than a host path that must be created and `chown`ed.
On `geekom`, whose `altsay` has password-gated `sudo`, that is the difference
between a scriptable deployment and an interactive one.

### Configure and start

On the host, with `deploy/relay/` copied over
(`scp -r deploy/relay "$USER_AT@$HOST":~/echolet-deploy`):

```sh
cd ~/echolet-deploy
cp env/insecure-loopback.env.example env/insecure-loopback.env
$EDITOR env/insecure-loopback.env
#   ECHOLET_IMAGE=echolet-relay:<tag from §2>
#   ECHOLET_NODE_CALLSIGN=RPT-GEEKOM-01        <- RPT-DEPR-01 on depr
# everything else is already correct, including ECHOLET_BIND_ADDR=127.0.0.1
```

Two values per host, and the second is only a name. Then either path:

```sh
./run-relay.sh env/insecure-loopback.env --print    # read the command first
./run-relay.sh env/insecure-loopback.env
```

```sh
docker compose --env-file env/insecure-loopback.env \
  -f docker-compose.insecure-loopback.yml up -d
```

Both hosts have the compose v2 plugin (§1), so either works; the two produce the
same container, with the same hardening §6 applies — read-only root filesystem,
`/tmp` tmpfs, uid 10001, `no-new-privileges`, all capabilities dropped,
`restart: unless-stopped`, json-file logs capped at 5 × 20 MB.

`run-relay.sh` prints a banner before it starts anything:

```text
############################################################
## INSECURE MODE: the relay will serve PLAIN HTTP, no TLS. ##
## Published on 127.0.0.1:8443 — loopback only.
## Nothing off this host can reach it. Anything on this    ##
## host can read every request in the clear.               ##
############################################################
```

### What the refusal looks like

Point it at the host's tailnet address and it stops, before creating anything:

```sh
$ ./run-relay.sh env/insecure-loopback.env      # with ECHOLET_BIND_ADDR=100.100.188.64
REFUSING TO START.
ECHOLET_INSECURE_LOOPBACK_ONLY serves PLAIN HTTP, so it is confined to loopback.
ECHOLET_BIND_ADDR=100.100.188.64 is not a loopback address.
Allowed in this mode: 127.0.0.1 or [::1] — nothing else, not a tailnet address.
To publish on 100.100.188.64, unset ECHOLET_INSECURE_LOOPBACK_ONLY and deploy with TLS.
$ echo $?
2
```

Two neighbouring refusals, for the same reason:

```text
ECHOLET_INSECURE_LOOPBACK_ONLY is set to 'true', which is not a recognised value.
It must be exactly:  yes-plain-http-on-loopback-only
Leave it unset for the normal TLS deployment. There is no third mode.

ECHOLET_TLS_DIR=/etc/echolet/tls is set while ECHOLET_INSECURE_LOOPBACK_ONLY is on.
Choose one: TLS, or plain HTTP on loopback.
```

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

## 7.5 Verify the loopback-only deployment

```sh
docker ps --filter name=echolet-relay --format '{{.Status}}\t{{.Ports}}'
# Up 40 seconds (healthy)	127.0.0.1:8443->8443/tcp

docker inspect echolet-relay --format '{{index .Config.Labels "echolet.tls"}}'
# disabled-insecure-loopback-only

docker logs echolet-relay 2>&1 | grep 'Starting relay server'
# ... msg="Starting relay server" addr=0.0.0.0:8443 scheme=http
#     tls_cert_file="" tls_key_file=""

ss -ltn | grep 8443
# LISTEN 0  4096  127.0.0.1:8443  0.0.0.0:*        <- one socket, loopback only

curl -sS http://127.0.0.1:8443/health
# {"ok":true,"data":{"status":"healthy","uptime_ms":41208}}
```

`scheme=http tls_cert_file="" tls_key_file=""` is the line that matters here, in
the same way `scheme=https` is the line that matters in §7. The relay states its
own scheme; you never have to infer it. Note that the image's `HEALTHCHECK`
tries HTTPS first and falls back to HTTP, so a green healthcheck on this path
succeeded on the fallback arm — it is proving something weaker than a green
healthcheck on the TLS path.

**Confirm the confinement from a second machine**, which is the check that
actually establishes it:

```sh
curl -sS --max-time 5 -o /dev/null -w '%{http_code}\n' http://100.116.255.111:8443/health
# 000, curl exit 7 — connection refused
```

Refused, not filtered: nothing is listening on the tailnet address.

### Restart survival

```sh
docker stop echolet-relay && docker start echolet-relay
sleep 5 && curl -sS http://127.0.0.1:8443/health
```

Health answering after a restart proves only that a relay is running. The check
that proves the **data** survived is a byte-identical exact retry with the same
`--message-id` from §9: it must answer with the `envelopeId` issued before the
stop, and the recipient's next poll must still receive `0`. Both answers can only
come from stored ciphertext and a stored dedup record.

`docker stop` reports `Exited (0)`. The relay handles SIGTERM and SIGINT, closes
its listeners, drains requests already in flight for up to five seconds, closes
Badger and then exits 0, so a supervisor keying off exit status reads an operator
stop as a stop. (Before `a2f07bb` it installed no signal handler and exited 2;
that was measured as `.State.ExitCode` 2 → 0 on both hosts during the upgrade.)

### Reaching this relay from another machine — SSH local forward

The relay is on loopback, so nothing dials it across the network. Bring it onto
the client machine's own loopback instead:

```sh
# on the client machine
ssh -N -L 18443:127.0.0.1:8443 geekom &     # geekom's relay -> http://127.0.0.1:18443
ssh -N -L 18444:127.0.0.1:8443 depr &       # depr's relay   -> http://127.0.0.1:18444

curl -sS http://127.0.0.1:18443/health
```

Then point a CLI profile at `http://127.0.0.1:18443` and run the full §9
scenario. The CLI accepts it because it *is* loopback; it would refuse
`http://100.116.255.111:8443` with exit 2 `INVALID_CONFIGURATION`, and that
refusal is the product working — do not route around it.

Close the forwards when you are done:

```sh
pkill -f 'ssh .*-L 18443:127.0.0.1:8443 geekom'
pkill -f 'ssh .*-L 18444:127.0.0.1:8443 depr'
```

### What this path establishes, and what it does not

**Establishes.** A relay process running on a remote server, on a persistent
volume, surviving a container restart; and a genuine two-machine exchange — the
clients run on one machine, the relay runs on another, and messages cross
between them through it. Offline delivery, replies, exact retry, deduplication
and mirrored histories are all real results against a remote relay.

**Does not establish AC4**, and must never be cited for it:

> **AC4:** *A relay reachable on a non-loopback address serves HTTPS, and the
> CLI completes the full acceptance scenario against it from a different
> machine.*

On this path the relay is bound to `127.0.0.1` and is provably unreachable from
any other machine, and it serves **plain HTTP** — it says so itself. **The
confidentiality on the wire is SSH's, not the relay's.** An SSH tunnel is a
transport substitute, not a TLS substitute: the relay's own TLS path —
certificate loading, the both-or-neither startup check, hot reload on renewal,
chain validation by a client dialling the MagicDNS name — is exercised **not at
all**. AC4 needs §3.1, §4, §6, §7 and §8, in that order.

**AC4 is now established, by the TLS path on `depr`, not by this one.** On
2026-09-07 `depr` completed §3.1 → §4 → §6 → §7 → §8 and the full acceptance
scenario ran from a second machine against
`https://depr.tail5a88fb.ts.net:8443` with no tunnel, forward, proxy or shim:
`/health` answered 200 with `ssl_verify_result=0` against the system trust store
and `remote_ip=100.100.188.64`; plain HTTP to that port answered
`HTTP/1.0 400 Bad Request`. Evidence:
[`t11-tls-report.md`](../../../.metaproject/flows/002-2026-09-07-echolet-close-the-flood-class-operator-c/t11-tls-report.md).
That changes nothing about this section: the §6.5 path is still not evidence for
AC4 and must still never be cited for it.

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

**It must be an ORIGIN — scheme, host and port only.** A relay URL carrying a
path or a query (`https://host:8443/echolet`, `https://host:8443/?token=…`) is
refused by `init` with the same exit 2 `INVALID_CONFIGURATION`, and nothing is
written. A bare origin and a root path (`https://host:8443`,
`https://host:8443/`) are both accepted. Until finding T10-F-003 `init` accepted
a path, wrote the profile, and every later relay command on it exited 5
`PERSISTENCE_FAILURE` — a local-storage code for a mistake on the command line.

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

**On the §6.5 loopback path** the URL is instead the local end of the SSH
forward — `http://127.0.0.1:18443` — and everything else in this section is
unchanged. The CLI accepts it because it is loopback. It will refuse
`http://100.116.255.111:8443` with exit 2 `INVALID_CONFIGURATION`, and that
refusal is a passing check, not an obstacle: do not route around it.

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

On the §6.5 path the two host commands are instead:

```sh
$EDITOR env/insecure-loopback.env       # ECHOLET_IMAGE=echolet-relay:<new-tag>
docker compose --env-file env/insecure-loopback.env \
  -f docker-compose.insecure-loopback.yml up -d
# or: ./run-relay.sh env/insecure-loopback.env
curl -sS http://127.0.0.1:8443/health   # on the host, or through the SSH forward
```

The data survives the swap either way — a host bind mount on the TLS path, a
named volume on the loopback path; replacing the container touches neither.
`docker compose ... down` **without** `-v`, and `run-relay.sh`'s
stop-and-replace, both leave the volume intact; only an explicit
`docker volume rm` or `down -v` destroys it. The upgrade is a container swap of
a few seconds; in-flight requests fail and clients retry, which is exactly the
behaviour the retry and deduplication paths exist for.

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
| Relay data (TLS path, §5) | `/var/lib/echolet` on the host | Badger store, uid 10001, mode 0700. Envelope ciphertext, device records, ordering index, read marks. |
| Relay data (loopback path, §6.5) | named volume `echolet-relay-data` | Same store. `docker volume inspect echolet-relay-data` for its path; reading it directly needs sudo, `docker run --rm --entrypoint /bin/sh -v echolet-relay-data:/data:ro <image>` does not. |
| Certificate pair (`depr`) | `/etc/echolet/tls/{cert.pem,key.pem}` | written by `tailscale cert`, mounted **read-only** into the container as a directory bind — host path and container path are the same inode. Absent on the §6.5 path. |
| Certificate pair (`geekom`) | named volume `echolet-relay-tls` | Host copy in `~altsay/echolet-tls` (mode `0700`); the volume copy is what the relay reads, `cert 0644` / **`key 0600`**, both owned `10001:10001`. `/etc/echolet` does not exist on that host. |
| Compose / run recipes | `deploy/relay/` in the repository | `docker-compose.yml`, `docker-compose.insecure-loopback.yml`, `run-relay.sh`, `env/*.env.example`, `systemd/`. |
| Image definition | `apps/relay/Dockerfile` | build context is `apps/relay`, not the repository root. |
| Renewal timer (`depr`) | `systemctl status echolet-cert-renew.timer` | Root scope, `/etc/systemd/system`. `journalctl -u echolet-cert-renew` for its history. |
| Renewal timer (`geekom`) | `systemctl --user status echolet-cert-renew.timer` | **User scope** — the plain command above finds nothing there. `journalctl --user -u echolet-cert-renew`; script in `~/echolet-cert-renew/`. See §4.1. |

The two data rows are the *templates*, not a description of `depr`. `depr` runs
the **TLS** path against the **named volume** `echolet-relay-data`, because it
was switched from §6.5 without migrating its store: its env file sets
`ECHOLET_DATA_VOLUME` instead of `ECHOLET_HOST_DATA_DIR`, and `/var/lib/echolet`
does not exist on that host. Read its data through the volume row, and treat the
volume as the thing that must not be removed.

Client-side, nothing changes: the profile directory, its encrypted store and the
`ECHOLET_E2E_KEY`-style store key stay entirely on the operator's machine. **No
key material of any kind exists on either server.**

## 13. Teardown

TLS path (§4–§6):

```sh
docker compose --env-file env/geekom.env -f docker-compose.yml down
# or: docker rm -f echolet-relay
sudo rm -rf /var/lib/echolet /etc/echolet
sudo systemctl disable --now echolet-cert-renew.timer
sudo rm -f /etc/systemd/system/echolet-cert-renew.{service,timer}
sudo rm -rf /etc/systemd/system/echolet-cert-renew.service.d
sudo systemctl daemon-reload
```

On a **no-root host** such as `geekom` the renewal teardown is the user-scope
equivalent, and needs no `sudo` at all:

```sh
systemctl --user disable --now echolet-cert-renew.timer
rm -f ~/.config/systemd/user/echolet-cert-renew.{service,timer}
systemctl --user daemon-reload
rm -rf ~/echolet-cert-renew ~/echolet-tls
docker volume rm echolet-relay-tls      # the certificate pair inside the volume
```

`tailscale cert` leaves nothing else on the host to clean up.

Loopback-only path (§6.5) — **no `sudo` anywhere**, because nothing was created
outside Docker:

```sh
docker compose --env-file env/insecure-loopback.env \
  -f docker-compose.insecure-loopback.yml down -v      # -v removes the volume
# or, if it was started with run-relay.sh:
docker stop echolet-relay && docker rm echolet-relay
docker volume rm echolet-relay-data                    # DESTROYS all relay state

docker rmi echolet-relay:<tag>

# verify
docker ps -a  --filter name=echolet-relay
docker volume ls --filter name=echolet
ss -ltn | grep 8443          # expect no output
```

Removing the volume destroys undelivered envelopes, device records and dedup
records. There is no undo and no snapshot.

On the client machine, close any SSH forwards from §7.5:

```sh
pkill -f 'ssh .*-L 18443:127.0.0.1:8443 geekom'
pkill -f 'ssh .*-L 18444:127.0.0.1:8443 depr'
```

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
- **No production deployment and no production-readiness claim.** Two relays on
  a tailnet are a prototype deployment; nothing here attests operational
  readiness.
- **The §6.5 loopback path is not evidence for AC4, and never becomes it.** A
  relay on `127.0.0.1` reached through `ssh -L` is a genuine two-machine
  exchange through a remote relay, and the deployment report treats it as such —
  but the encryption on that wire is SSH's. The relay serves plain HTTP and says
  so. AC4 asks for the **relay itself** to terminate TLS on a **non-loopback**
  address. That was done on `depr` (§7.5), and it is `depr`'s TLS deployment —
  not this path — that establishes AC4.
- **The two hosts' TLS deployments are not interchangeable.** Both serve HTTPS
  and both renew, but `depr` keeps its pair in `/etc/echolet/tls` with a root
  timer while `geekom` keeps it in a Docker volume with a `systemctl --user`
  timer, because `geekom`'s operator has no usable root (§4.1). A command that
  works on one host can silently find nothing on the other — most sharply,
  `systemctl status echolet-cert-renew.timer` on `geekom`. This asymmetry is
  documented rather than removed: unifying it would mean restructuring a running
  TLS relay for symmetry alone.
- **The committed `deploy/relay/systemd/` units are usable on `depr` and unusable
  on `geekom`.** They are written for root and for a host-path certificate
  directory. Nothing in the repository yet ships the user-scope, volume-aware
  variant `geekom` runs; §4.1 describes it, and the `geekom` TLS report holds the
  script. A reader who copies the committed units onto a `geekom`-shaped host
  will get a unit that cannot be installed, and if it could, would renew a path
  the relay does not read.
- **Certificate hot reload has never been exercised on either host.** Both
  certificates expire **6 December 2026** and both hosts now have a timer that
  will rewrite them before then (§4.1) — but the relay's *pickup* of genuinely
  new certificate content is still evidenced only by an automated test and by the
  code, because forcing it on a real host means re-issuing into Let's Encrypt's
  duplicate rate limit. Delivery is proven on both hosts; pickup is not.
- **Neither host has been rebooted since its renewal timer was installed.** That
  the timers come back on boot rests on the `timers.target.wants` symlink
  (`depr`) and on that plus `Linger=yes` (`geekom`) — the documented mechanism,
  not an observed boot.
- **`docker-compose.yml` cannot start a TLS relay on an existing named volume.**
  It hard-requires `ECHOLET_HOST_DATA_DIR` and has no `ECHOLET_DATA_VOLUME`
  branch, so `docker compose config` fails outright for a host whose store lives
  in `echolet-relay-data`. Only `run-relay.sh` can perform that switch. See §6.
- **`ECHOLET_CLEANUP_INTERVAL_SECONDS` is removed from every operator-facing
  file** (flow 003 T28): both compose files, `run-relay.sh` and all three env
  examples no longer set it, because `CleanupService.runCleanup()` is still two
  `slog.Debug` calls and does no work, and a dial that turns nothing is worse
  than no dial. Retention is enforced entirely by Badger's own TTL from
  `ECHOLET_MAILBOX_TTL_HOURS` and needs no interval. The field is gone from the
  binary too (flow 003 T33): `internal/config/config.go` no longer declares it
  and `internal/api/router/router.go` no longer reads it, so the variable left in
  a host's `.env` is now completely inert — it changes nothing and does not stop
  the relay from starting. The relay still logs
  `Cleanup service started interval_sec=60` at boot, but the 60 now comes from
  the service that owns the ticker (`service.DefaultCleanupIntervalSeconds`),
  not from a setting. The service, its `Stop()` and its place in the shutdown
  sequence (`18afa36`) are unchanged; only the empty `runCleanup()` body is open.
- **The pinned `@signalapp/libsignal-client@0.102.0` is not a permanent
  decision.** It was taken for this prototype.

And the residual the flooding closure explicitly left, restated because a
deployed relay is where it stops being academic:

- **The first walk of a very large flood is still slow.** Delivery is no longer
  blocked — a legitimate message behind a flood now arrives — but the recipient
  still downloads every poison envelope once, bounded by its own rate limit.
  Measured by the independent verification of `c302485` (T10 r3): the flood of 4
  self-published identities and 49 maximum-size envelopes (12.23 MB, 53
  requests) is delivered through in **2 polls / 17 pages**, and three ordinary
  polls afterwards cost 4 pages — the walk is paid once, not once per poll. The
  extreme case in the design (10 801 envelopes, ~2.8 GB) still makes the *first*
  walk take on the order of an hour. Durable read positions mean the victim
  resumes rather than restarts, so an hour of polling now delivers where an hour
  used to deliver nothing — but an hour against a 24 h message lifetime is not
  comfortable margin. **This is a bound, and it is reported as a bound.**
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
