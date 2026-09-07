# T11 — Host reconnaissance: `geekom` and `depr`

Date: 2026-09-07 (probes run 12:13 UTC)
Scope: **read-only**. Nothing was installed, started, stopped, enabled, configured or written on either host. Every remote command was a pure query (`id`, `uname`, `cat` of readable files, `systemctl is-active`, `docker version`, `sudo -n ufw status`, `ss -ltn`, `df`, `free`, `timedatectl`, `tailscale status --json`, `tailscale dns status`, `tailscale cert --help`). **No `tailscale cert` was issued.** No secret, key or token was read or recorded.

---

## Summary

Both hosts are reachable, both are Ubuntu 24.04.4 x86_64, both run Docker with the user in the `docker` group, both run Tailscale in `Running` state on tailnet `tail5a88fb.ts.net` with MagicDNS enabled tailnet-wide, and **nothing listens on 443 or 8443 on either host**. Time is synchronised on both. `/etc/echolet` and `/var/lib/echolet` do not exist on either host, and there is no echolet container, image, process or systemd unit anywhere.

The deployment-runbook's §1 table is accurate in every respect it asserts, and its two host env templates need only `ECHOLET_IMAGE` and `ECHOLET_BIND_ADDR` filled in — both `ECHOLET_BIND_ADDR` values are now known and recorded below.

**There is exactly one blocking gap, and it is shared by both hosts and is not fixable on the hosts:**

> `tailscale status --json` reports `CertDomains: null` on **both** `geekom` and `depr`. `CertDomains` is the field the Tailscale client populates with the names it is permitted to issue certificates for; an empty value means **HTTPS Certificates are not enabled for this tailnet**. `sudo tailscale cert …` (runbook §4) will therefore fail, and §4 is the step every later step depends on — no certificate means no `cert.pem`/`key.pem`, and the relay refuses to start without both (it never degrades to plain HTTP). The fix is a one-click toggle in the Tailscale **admin console** (DNS page → *HTTPS Certificates* → Enable), performed by the tailnet owner (`aleks.zeitler@gmail.com`). It cannot be done over SSH.

Everything else is either already in place or is a routine, expected step of the runbook (create two directories, `chown` them, install a timer unit).

The second-order difference between the hosts is operator ergonomics, not capability: `geekom`'s `altsay` has `sudo` but **needs a password**, so the four `tailscale cert` commands, the two `mkdir`/`chown` pairs and the timer install on `geekom` must be run in an interactive session. `depr`'s `ubuntu` is `NOPASSWD: ALL` and can be scripted end-to-end.

---

## Host: `geekom`

SSH alias `geekom` → `100.116.255.111`, user `altsay`, key `~/.ssh/id_ed25519` (from `~/.ssh/config`).

### 1. Access and privilege

| | |
|---|---|
| SSH | **works**, non-interactive (`BatchMode=yes`), exit 0 |
| User | `altsay` — `uid=1000 gid=1000` |
| Groups | `altsay adm cdrom sudo dip plugdev lxd libvirt docker kvm` |
| `sudo -n true` | **FAILS** — `sudo: a password is required` |
| Consequence | in the `sudo` group, so `sudo` works **interactively**; every privileged runbook step on this host needs a human at the terminal |
| `docker` group | **yes** (gid 988) — Docker needs no sudo |

### 2. OS

- `Ubuntu 24.04.4 LTS` (noble), `VERSION_ID=24.04`, `ID=ubuntu`
- Kernel `6.8.0-138-generic #138-Ubuntu SMP PREEMPT_DYNAMIC Fri Jul 31 22:41:49 UTC 2026`
- Arch `x86_64` → **`linux/amd64` is the correct build target** (matches `build-image.sh`'s default)
- `hostname` = `geekom`; `hostname -f` = `geekom` (no FQDN from the resolver — MagicDNS name comes from Tailscale, see §5)

### 3. Resources

| | |
|---|---|
| CPU | **16** cores |
| RAM | 27 GiB total, 17 GiB used, **9.8 GiB available** |
| Swap | 8.0 GiB total, **4.5 GiB in use** |
| Disk `/` | `/dev/nvme0n1p2` 937 G, 310 G used, **580 G available (35 %)** |
| Disk `/var` | **not a separate filesystem** — same `/dev/nvme0n1p2` as `/` |

Note: this is a busy machine (32 containers, 48 images, 4.5 GiB of swap in use). Ample for a relay, but the "flood fills the relay's disk without limit" residual in runbook §14 shares its 580 G with everything else on the box.

### 4. Docker

| | |
|---|---|
| Installed | `/usr/bin/docker` |
| Client / Server | **29.3.0** (Docker Engine — Community), API 1.54 |
| containerd / runc | v2.2.2 / 1.3.4 |
| Daemon | `active`, `enabled` |
| Usable without sudo | **yes** — `docker ps` as `altsay` succeeds |
| `docker compose` (v2 plugin) | **yes — v5.1.0** |
| `docker-compose` (v1) | not present (not needed) |
| Storage driver | `overlayfs`, cgroup v2, `DockerRootDir=/var/lib/docker` |
| Current load | 32 containers, 48 images |

`docker compose` is present, so the compose path in runbook §6 works and `run-relay.sh` is a fallback, not a requirement.

### 5. Tailscale

| | |
|---|---|
| Installed | `/usr/bin/tailscale`, version **1.102.2** |
| `tailscaled` | `active`, `enabled` |
| `BackendState` | **Running**; `WantRunning=True`, `LoggedOut=False`, `ShieldsUp=False` |
| Tailnet | `aleks.zeitler@gmail.com`, suffix **`tail5a88fb.ts.net`** |
| MagicDNS | **enabled tailnet-wide** (`tailscale dns status` confirms) |
| **MagicDNS FQDN** | **`geekom.tail5a88fb.ts.net`** |
| **Tailnet IPv4** | **`100.116.255.111`** ← this is `ECHOLET_BIND_ADDR` |
| Tailnet IPv6 | `fd7a:115c:a1e0::7638:ff6f` |
| Health | `[]` (no warnings) |
| Peers online | `depr`, `alekss-macbook-pro`, `iphone172` (3 of 6 online) |
| **`CertDomains`** | **`null` — HTTPS certificates NOT enabled for the tailnet** |

`tailscale cert` **would not be usable today.** See the blocking gap in the summary. `tailscale cert --help` confirms the command exists and its `--cert-file` / `--key-file` flags match what the runbook and `echolet-cert-renew.service` pass.

### 6. Firewall and ports

| | |
|---|---|
| `ufw` binary | present (`/usr/sbin/ufw`) |
| `ufw` unit | `active`, `enabled` |
| `/etc/ufw/ufw.conf` | `ENABLED=yes` (world-readable, so this much is knowable without sudo) |
| **`ufw status verbose`** | **could not be read** — needs root and `sudo` needs a password |
| `nftables` unit | `inactive` |
| `nft` / `iptables` binaries | both present; **rulesets not readable** (`sudo: a password is required`) |
| Reverse proxies | `nginx`, `apache2`, `caddy`, `haproxy`, `traefik`, `lighttpd` — all `inactive` |

**Port 443: free. Port 8443: free.** (`ss -ltn` filtered for `:443`/`:8443` returned only the header.)

What *is* listening (`ss -ltn`, unprivileged so most process names are hidden):

```
0.0.0.0:22        sshd
0.0.0.0:8000      (unidentified)
0.0.0.0:9443      (unidentified)          <- note: 9443, NOT 8443. No conflict.
100.116.255.111:5432   docker publish on the tailnet IP (deprecated-postgres-tailscale / socat)
100.116.255.111:38949  tailscaled
127.0.0.1:{3011,3458,3847,5432,5433,6379,8080,20241,32923,38117,40157}
127.0.0.53:53, 127.0.0.54:53, 192.168.122.1:53
[::]:22, [::]:8000, [::]:9443, *:11434 (ollama)
```

The `100.116.255.111:5432` publish is a useful precedent: this host already publishes a container port bound to its tailnet address, exactly the pattern `docker-compose.yml` uses, and it works.

### 7. systemd

- PID 1 is **`systemd`**, version `255 (255.4-1ubuntu8.17)`
- 18 timers already installed; none named `echolet`
- Installing `echolet-cert-renew.{service,timer}` is possible but requires **interactive sudo**
- `/etc/echolet` — **absent**
- `/etc/echolet/tls` — **absent**
- `/var/lib/echolet` — **absent**

### 8. Conflicts

**None for the Echolet relay.** No `echolet` container, image, systemd unit or process exists. Nothing holds 8443 or 443.

For situational awareness, `geekom` currently runs a lot: `deprecated-scheduler`, `deprecated-bot`, `carlson-bot`, `carlson-news-collector`, `deprecated-searxng`, `deprecated-postgres-tailscale`, `helyx-bot-1`, `deprecated-flow024-control-v5`, `flow024-prod-…-shadow` (all up), plus ~10 exited containers. The container name `echolet-relay` and the compose project name `echolet-relay` are both unused.

### 9. Time synchronisation

- `System clock synchronized: yes`, `NTP service: active`, `systemd-timesyncd` active (`chrony`/`chronyd`/`ntp` inactive)
- Timezone `Etc/UTC`; local == universal == RTC
- Peer `213.42.2.60`, **Stratum 1**, jitter 3.2 ms, 219 packets, `Ignored=no`
- Verdict: **certificate validity will not be affected by clock skew.**

---

## Host: `depr`

SSH alias `depr` → `100.100.188.64` (with `HostKeyAlias 40.160.88.166`), user `ubuntu`, key `~/.ssh/id_ed25519`.

### 1. Access and privilege

| | |
|---|---|
| SSH | **works**, non-interactive, exit 0 |
| User | `ubuntu` — `uid=1000 gid=1000` |
| Groups | `ubuntu docker ollama` (note: **not** in a `sudo` group — privilege comes from a sudoers rule) |
| `sudo -n true` | **SUCCEEDS** |
| `sudo -n -l` | `User ubuntu may run the following commands on depr: (ALL) NOPASSWD: ALL` |
| Consequence | **fully scriptable**; no interactive step required anywhere |
| `docker` group | **yes** (gid 112) — Docker needs no sudo |

### 2. OS

- `Ubuntu 24.04.4 LTS` (noble), `VERSION_ID=24.04`, `ID=ubuntu`
- Kernel `6.8.0-139-generic #139-Ubuntu SMP PREEMPT_DYNAMIC Sat Aug 1 03:52:05 UTC 2026`
- Arch `x86_64` → **`linux/amd64`**
- `hostname` = `depr`; `hostname -f` = **`depr.tail5a88fb.ts.net`**

### 3. Resources

| | |
|---|---|
| CPU | **4** cores |
| RAM | 7.6 GiB total, 2.3 GiB used, **5.3 GiB available** |
| Swap | 2.0 GiB total, 1.5 MiB used |
| Disk `/` | `/dev/sda1` 72 G, 23 G used, **49 G available (33 %)** |
| Disk `/var` | **not a separate filesystem** — same `/dev/sda1` as `/` |

49 G is the smaller of the two headrooms and is the one to watch against the "`ECHOLET_MAX_STORAGE_BYTES` is enforced nowhere" residual (runbook §14). `df -h /var/lib/echolet` here will report on `/`.

### 4. Docker

| | |
|---|---|
| Installed | `/usr/bin/docker` |
| Client / Server | **29.1.3** (Ubuntu's `docker.io` package, `29.1.3-0ubuntu3~24.04.2`), API 1.52 |
| containerd / runc | 2.2.1 / 1.3.4-0ubuntu1~24.04.1 |
| Daemon | `active`, `enabled` |
| Usable without sudo | **yes** — `docker ps` as `ubuntu` succeeds |
| `docker compose` (v2 plugin) | **yes — 2.40.3+ds1-0ubuntu1~24.04.1** |
| `docker-compose` (v1) | not present |
| Storage driver | `overlayfs`, cgroup v2, `DockerRootDir=/var/lib/docker` |
| Current load | 7 containers, 61 images |

Worth recording: `run-relay.sh`'s header and runbook §6 both warn that "Ubuntu's `docker.io` package ships the engine without `docker compose`". On this host that caveat **does not apply** — the distro compose plugin is installed. The `run-relay.sh` fallback remains available but is not needed on either host.

### 5. Tailscale

| | |
|---|---|
| Installed | `/usr/bin/tailscale`, version **1.102.3** |
| `tailscaled` | `active`, `enabled` |
| `BackendState` | **Running**; `WantRunning=True`, `LoggedOut=False`, `ShieldsUp=False`, `Hostname=depr` |
| Tailnet | `aleks.zeitler@gmail.com`, suffix **`tail5a88fb.ts.net`** |
| MagicDNS | **enabled tailnet-wide** |
| **MagicDNS FQDN** | **`depr.tail5a88fb.ts.net`** |
| **Tailnet IPv4** | **`100.100.188.64`** ← this is `ECHOLET_BIND_ADDR` |
| Tailnet IPv6 | `fd7a:115c:a1e0::9b38:bc41` |
| Health | `[]` (no warnings) |
| Peers online | `geekom`, `alekss-macbook-pro`, `iphone172` |
| **`CertDomains`** | **`null` — HTTPS certificates NOT enabled for the tailnet** |

Same blocking gap as `geekom`, and it is the *same* gap — one tailnet, one toggle, both hosts fixed at once.

### 6. Firewall and ports

`ufw` is **active** and its rules **are** readable here (passwordless sudo):

```
Status: active
Logging: on (low)
Default: deny (incoming), allow (outgoing), deny (routed)
New profiles: skip

To                          Action      From
41641/udp                   ALLOW IN    Anywhere                  # Tailscale
Anywhere on tailscale0      ALLOW IN    Anywhere                  # Tailscale network
11434/tcp                   ALLOW IN    172.19.0.0/16             # docker helyx -> host Ollama embeddings
41641/udp (v6)              ALLOW IN    Anywhere (v6)             # Tailscale
Anywhere (v6) on tailscale0 ALLOW IN    Anywhere (v6)             # Tailscale network
```

`Anywhere on tailscale0 ALLOW IN` means tailnet traffic already reaches host services — **no ufw rule needs to be added for 8443**, and the runbook is right that none should be.

- `nftables` unit `inactive`, but `nft list ruleset` shows `table ip filter` **managed by iptables-nft** with the full ufw chain set (`ufw-before-input`, `ufw-user-input`, …) — i.e. ufw *is* the nftables ruleset here.
- `iptables -S`: `-P INPUT DROP`, `-P FORWARD DROP`, `-P OUTPUT ACCEPT`, with `ts-input` / `ts-forward` (Tailscale), `DOCKER*` and `ufw-*` chains.
- `iptables -t nat -S` confirms the DNAT-before-ufw behaviour the runbook warns about, and shows the exact precedent the relay will follow:
  ```
  -A DOCKER -d 100.100.188.64/32 ! -i br-… -p tcp --dport 5432 -j DNAT --to-destination 172.18.0.2:5432
  ```
  A container published on this host's tailnet IPv4 lands in the `DOCKER` nat chain and is reachable over the tailnet without any ufw change. Publishing on `0.0.0.0` would land in the same chain and be reachable on **every** interface regardless of `-P INPUT DROP` — which is exactly why `ECHOLET_BIND_ADDR` is the access control.
- Reverse proxies: `nginx`, `apache2`, `caddy`, `haproxy`, `traefik`, `lighttpd` all `inactive`.

**Port 443: free. Port 8443: free.**

Listening, with process names (root `ss -ltnp` available here):

```
0.0.0.0:22              sshd
127.0.0.1:3847          docker-proxy (helyx-bot)
127.0.0.1:3011          MainThread
127.0.0.1:5433          docker-proxy (helyx-postgres)
127.0.0.1:40023         containerd
127.0.0.53:53 / 127.0.0.54:53   systemd-resolve
100.100.188.64:5432     docker-proxy (deprecated-postgres, published on the tailnet IP)
100.100.188.64:39626    tailscaled
[::]:22                 sshd
*:11434                 ollama
*:3010                  MainThread
[fd7a:…:bc41]:64904     tailscaled
```

### 7. systemd

- PID 1 is **`systemd`**, version `255 (255.4-1ubuntu8.17)`
- 17 timers installed; none named `echolet`
- Installing `echolet-cert-renew.{service,timer}` is possible and **needs no password**
- `/etc/echolet` — **absent**
- `/etc/echolet/tls` — **absent**
- `/var/lib/echolet` — **absent**

### 8. Conflicts

**None.** No `echolet` container, image, systemd unit or process. Nothing on 443 or 8443.

Running containers: `deprecated-web-1`, `deprecated-server-1`, `helyx-bot-1`, `helyx-postgres-1`, `deprecated-cloudflared-1`, `deprecated-redis-1`, `deprecated-postgres-1`. Names `echolet-relay` (container) and `echolet-relay` (compose project) are unused.

One thing to note but not act on: `deprecated-cloudflared-1` is running. It is a Cloudflare tunnel and it terminates elsewhere; it does not bind 443 on this host and does not conflict. It is worth being aware that this host has an *outbound* tunnel to the public internet, which the Echolet relay does not use and must not be routed through.

### 9. Time synchronisation

- `System clock synchronized: yes`, `NTP service: active`, `systemd-timesyncd` active
- Timezone `Etc/UTC`; local == universal == RTC
- Peer `ntp.ubuntu.com` (`185.125.190.56`), **Stratum 2**, jitter 7.4 ms, 115 packets, `Ignored=no`
- Verdict: **fine for certificate validity.**

---

## Gaps that must be closed before the relay can run

Commands are **written down, not executed**. Nothing below has been run.

### Shared — blocks both hosts

| # | Gap | Where | Exact remedy |
|---|---|---|---|
| G0 | **HTTPS certificates are not enabled for tailnet `tail5a88fb.ts.net`** (`CertDomains: null` on both hosts). `tailscale cert` will fail, and with no cert pair the relay exits at startup rather than serving plain HTTP. | Tailscale **admin console**, not the hosts | Admin console → **DNS** → **HTTPS Certificates** → *Enable*. Owner: `aleks.zeitler@gmail.com`. **Not doable over SSH.** Re-verify with `ssh geekom 'tailscale status --json \| jq .CertDomains'` — it must list `geekom.tail5a88fb.ts.net`. |

### `geekom` (`altsay@100.116.255.111`, FQDN `geekom.tail5a88fb.ts.net`)

| # | Gap | Exact remedy (run on the host, **interactive — sudo asks for a password**) |
|---|---|---|
| A1 | `deploy/relay/` is not on the host | `scp -r deploy/relay altsay@geekom.tail5a88fb.ts.net:~/echolet-deploy` |
| A2 | Image not present | `docker save echolet-relay:<tag> \| gzip \| ssh altsay@geekom.tail5a88fb.ts.net 'gunzip \| docker load'` — no sudo, `altsay` is in `docker` |
| A3 | `/etc/echolet/tls` does not exist | `sudo mkdir -p /etc/echolet/tls` |
| A4 | No certificate pair (**blocked by G0**) | `sudo tailscale cert --cert-file /etc/echolet/tls/cert.pem --key-file /etc/echolet/tls/key.pem geekom.tail5a88fb.ts.net` |
| A5 | Cert pair ownership/mode for uid 10001 | `sudo chown 10001:10001 /etc/echolet/tls/cert.pem /etc/echolet/tls/key.pem && sudo chmod 0644 /etc/echolet/tls/cert.pem && sudo chmod 0600 /etc/echolet/tls/key.pem` |
| A6 | `/var/lib/echolet` does not exist | `sudo mkdir -p /var/lib/echolet && sudo chown -R 10001:10001 /var/lib/echolet && sudo chmod 0700 /var/lib/echolet` |
| A7 | `env/geekom.env` does not exist (only `.example` is committed) | `cp env/geekom.env.example env/geekom.env`, then set `ECHOLET_IMAGE=echolet-relay:<tag>` and `ECHOLET_BIND_ADDR=100.116.255.111` |
| A8 | Renewal timer not installed | `sudo cp systemd/echolet-cert-renew.service systemd/echolet-cert-renew.timer /etc/systemd/system/` ; `sudo systemctl edit echolet-cert-renew.service` → `[Service]` + `Environment=ECHOLET_TLS_HOSTNAME=geekom.tail5a88fb.ts.net` ; `sudo systemctl daemon-reload` ; `sudo systemctl enable --now echolet-cert-renew.timer` |
| A9 | ufw ruleset unknown (see "could not determine") | While at an interactive prompt anyway: `sudo ufw status verbose`. Expect no change to be needed — Docker's DNAT precedes ufw's INPUT, and this host already serves a tailnet-bound published port (5432). |

Not gaps on `geekom`: Docker ✓, `docker compose` v5.1.0 ✓, Tailscale up ✓, systemd ✓, ports 443/8443 free ✓, clock ✓, disk ✓, `docker` group ✓.

### `depr` (`ubuntu@100.100.188.64`, FQDN `depr.tail5a88fb.ts.net`)

| # | Gap | Exact remedy (fully non-interactive — `NOPASSWD: ALL`) |
|---|---|---|
| B1 | `deploy/relay/` is not on the host | `scp -r deploy/relay ubuntu@depr.tail5a88fb.ts.net:~/echolet-deploy` |
| B2 | Image not present | `docker save echolet-relay:<tag> \| gzip \| ssh ubuntu@depr.tail5a88fb.ts.net 'gunzip \| docker load'` |
| B3 | `/etc/echolet/tls` does not exist | `sudo mkdir -p /etc/echolet/tls` |
| B4 | No certificate pair (**blocked by G0**) | `sudo tailscale cert --cert-file /etc/echolet/tls/cert.pem --key-file /etc/echolet/tls/key.pem depr.tail5a88fb.ts.net` |
| B5 | Cert pair ownership/mode | `sudo chown 10001:10001 /etc/echolet/tls/cert.pem /etc/echolet/tls/key.pem && sudo chmod 0644 /etc/echolet/tls/cert.pem && sudo chmod 0600 /etc/echolet/tls/key.pem` |
| B6 | `/var/lib/echolet` does not exist | `sudo mkdir -p /var/lib/echolet && sudo chown -R 10001:10001 /var/lib/echolet && sudo chmod 0700 /var/lib/echolet` |
| B7 | `env/depr.env` does not exist | `cp env/depr.env.example env/depr.env`, then set `ECHOLET_IMAGE=echolet-relay:<tag>` and `ECHOLET_BIND_ADDR=100.100.188.64` |
| B8 | Renewal timer not installed | `sudo cp systemd/echolet-cert-renew.service systemd/echolet-cert-renew.timer /etc/systemd/system/` ; `sudo systemctl edit echolet-cert-renew.service` → `Environment=ECHOLET_TLS_HOSTNAME=depr.tail5a88fb.ts.net` ; `sudo systemctl daemon-reload` ; `sudo systemctl enable --now echolet-cert-renew.timer` |

Not gaps on `depr`: Docker ✓, `docker compose` 2.40.3 ✓, Tailscale up ✓, systemd ✓, ports 443/8443 free ✓, clock ✓, disk ✓, `docker` group ✓, passwordless sudo ✓, **ufw already allows all tailnet traffic — no firewall change needed** ✓.

### Explicitly *not* gaps (verified, so T11 need not re-check)

- No `ufw allow 8443` on either host. `depr` already allows `Anywhere on tailscale0`; and in any case Docker's published-port DNAT is evaluated before ufw's INPUT chain, so a ufw rule would neither grant nor deny the relay's port. The bind address is the access control.
- No `docker compose` install needed. Both hosts have the v2 plugin despite the runbook's warning about Ubuntu's `docker.io` package.
- No `usermod -aG docker` needed. Both users are already in the group.
- No Go/Node toolchain needed on either host — the image is built on the operator's machine and `docker load`ed.
- No port conflict remediation. 443 and 8443 are free on both.
- No time-sync remediation. Both hosts are NTP-synchronised in UTC.

---

## Exactly what T11 must copy, and where

Built on the operator's machine, carried over — nothing is built on a host.

### Copied to **both** hosts

| Source (repo) | Destination on host | Notes |
|---|---|---|
| `deploy/relay/docker-compose.yml` | `~/echolet-deploy/docker-compose.yml` | Read by `docker compose -f`. Host-agnostic. |
| `deploy/relay/run-relay.sh` | `~/echolet-deploy/run-relay.sh` | Fallback only; both hosts have the compose plugin. Keep the executable bit. |
| `deploy/relay/systemd/echolet-cert-renew.service` | `/etc/systemd/system/echolet-cert-renew.service` | via `sudo cp` from `~/echolet-deploy/systemd/` |
| `deploy/relay/systemd/echolet-cert-renew.timer` | `/etc/systemd/system/echolet-cert-renew.timer` | via `sudo cp` |
| image tarball / stream | Docker's image store (`/var/lib/docker`) | `docker save … \| gzip \| ssh … 'gunzip \| docker load'`, or `scp out/echolet-relay.tar` + `docker load -i` with a `sha256sum` compare on both ends |

The runbook's `scp -r deploy/relay "$USER_AT@$HOST":~/echolet-deploy` copies all of the above (except the image) in one command.

### Copied to **`geekom` only**

| Source | Destination | Notes |
|---|---|---|
| `deploy/relay/env/geekom.env.example` → filled in as `geekom.env` | `~/echolet-deploy/env/geekom.env` | Not committed. May be filled in on the operator's machine and copied, or copied as `.example` and edited on the host. |

### Copied to **`depr` only**

| Source | Destination | Notes |
|---|---|---|
| `deploy/relay/env/depr.env.example` → filled in as `depr.env` | `~/echolet-deploy/env/depr.env` | Same. |

### Created on the host, never copied

| Path | How | Ownership / mode |
|---|---|---|
| `/etc/echolet/tls/cert.pem` | `sudo tailscale cert` | `10001:10001`, `0644` |
| `/etc/echolet/tls/key.pem` | `sudo tailscale cert` | `10001:10001`, `0600` |
| `/var/lib/echolet/` | `sudo mkdir -p` | `10001:10001`, `0700` (recursive chown) |

**`key.pem` is generated on the host, read on the host and renewed on the host. It is never copied off, never committed, never placed in an image or an env file.**

### Never copied to a host

`apps/relay/Dockerfile`, `deploy/relay/build-image.sh`, the Go source, any repository checkout. Neither host has a Go toolchain and neither needs one.

---

## Environment variables — the complete set, per host

Two values per host are the only ones that must be *supplied*; every other variable in the templates is a recorded default. Both templates already carry the correct callsign and paths.

### Must be filled in (placeholders in the committed `.example` files)

| Variable | `geekom` | `depr` |
|---|---|---|
| `ECHOLET_IMAGE` | `echolet-relay:<tag from build-image.sh>` — replaces `REPLACE_WITH_BUILT_TAG` | same tag, **identical on both hosts** |
| `ECHOLET_BIND_ADDR` | **`100.116.255.111`** — replaces `REPLACE_WITH_TAILSCALE_IPV4` | **`100.100.188.64`** |

`run-relay.sh` hard-fails on either a `REPLACE_WITH_*` placeholder or a `0.0.0.0` / empty / `*` bind address, so a mistake here is caught rather than deployed. `docker-compose.yml` fails on the unset `?`-marked variables (`ECHOLET_IMAGE`, `ECHOLET_BIND_ADDR`, `ECHOLET_NODE_CALLSIGN`, `ECHOLET_TLS_DIR`, `ECHOLET_HOST_DATA_DIR`) but does **not** catch a `0.0.0.0` — use `run-relay.sh` or read the value twice.

### Already correct in the templates — differ per host

| Variable | `geekom` | `depr` |
|---|---|---|
| `ECHOLET_NODE_CALLSIGN` | `RPT-GEEKOM-01` | `RPT-DEPR-01` |

### Already correct in the templates — identical on both hosts

`ECHOLET_STACK_NAME=echolet-relay`, `ECHOLET_CONTAINER_NAME=echolet-relay`, `ECHOLET_PORT=8443`, `ECHOLET_TLS_DIR=/etc/echolet/tls`, `ECHOLET_TLS_RELOAD_INTERVAL_SECONDS=60`, `ECHOLET_HOST_DATA_DIR=/var/lib/echolet`, `ECHOLET_UID=10001`, `ECHOLET_GID=10001`, `ECHOLET_LOG_LEVEL=info`, `ECHOLET_LOG_MAX_SIZE=20m`, `ECHOLET_LOG_MAX_FILE=5`, `ECHOLET_MAILBOX_TTL_HOURS=168`, `ECHOLET_MAX_MESSAGE_BYTES=262144`, `ECHOLET_MAX_MAILBOX_BATCH=100`, `ECHOLET_MAX_UNACKED_ENVELOPES_PER_SENDER=16`, `ECHOLET_RATE_LIMIT_PER_MINUTE=120`, `ECHOLET_CHALLENGE_TTL_SECONDS=60`, `ECHOLET_CLEANUP_INTERVAL_SECONDS=60`, `ECHOLET_MAX_STORAGE_BYTES=2147483648`.

**The bounds must stay identical on both hosts.** `ECHOLET_MAX_UNACKED_ENVELOPES_PER_SENDER` and `ECHOLET_MAX_MAILBOX_BATCH` were sized against each other by the flood closure; changing one without re-reasoning about the other widens the walk the per-sender quota was sized against.

### Set inside the container by compose / `run-relay.sh`, never in the env file

`ECHOLET_HTTP_ADDR=0.0.0.0:8443` (the *container's* listen address — the host side of the mapping is what `ECHOLET_BIND_ADDR` controls), `ECHOLET_TLS_CERT_FILE=/etc/echolet/tls/cert.pem`, `ECHOLET_TLS_KEY_FILE=/etc/echolet/tls/key.pem`, `ECHOLET_DATA_DIR=/var/lib/echolet`.

### Set in the systemd drop-in, per host

`sudo systemctl edit echolet-cert-renew.service`:

```ini
[Service]
Environment=ECHOLET_TLS_HOSTNAME=geekom.tail5a88fb.ts.net    # depr.tail5a88fb.ts.net on depr
```

`ECHOLET_TLS_DIR=/etc/echolet/tls` and `ECHOLET_UID=10001` are already in the shipped unit. `ECHOLET_TLS_HOSTNAME` has **no default** and the unit exits 2 with a pointer to the runbook if it is unset — so the drop-in is mandatory, per host.

### Client-side, on the operator's machine only

`ECHOLET_E2E_KEY` (profile store key, runbook §9). It never reaches a server. Relay URLs for §9: `https://geekom.tail5a88fb.ts.net:8443` and `https://depr.tail5a88fb.ts.net:8443` — **origin only**, no path, no query; a path makes `init` exit 2 `INVALID_CONFIGURATION`, and an IP address will not match a MagicDNS certificate.

---

## Could not be determined, and why

1. **`geekom`'s ufw ruleset.** `ufw status verbose` needs root and `altsay`'s `sudo` requires a password; `sudo -n` correctly refused rather than prompting. Known instead, from world-readable sources: the `ufw` unit is `active` and `enabled`, and `/etc/ufw/ufw.conf` has `ENABLED=yes`. What is *allowed* is unknown. **Assessed impact: none.** Docker's published-port DNAT is evaluated before ufw's INPUT chain, so ufw would not gate the relay's port either way — and this host already serves a container port published on its tailnet address (`100.116.255.111:5432`), which demonstrates the path works. Resolve with one interactive `sudo ufw status verbose` during T11.
2. **`geekom`'s nftables and iptables rulesets.** Same cause (`sudo: a password is required` for `nft list ruleset`, `iptables -S`, `iptables -t nat -S`). Known instead: the `nftables` unit is `inactive` and both binaries are present. On `depr`, where the ruleset *was* readable, `table ip filter` is managed by iptables-nft on behalf of ufw; `geekom` is almost certainly the same, but this is inference, not observation.
3. **Process names for most of `geekom`'s listening sockets.** `ss -ltnp` shows only the caller's own processes unless run as root, and `sudo -n` was unavailable. The port numbers themselves are complete and reliable, which is what the 443/8443 question needed. Unidentified: `0.0.0.0:8000`, `0.0.0.0:9443`, and most `127.0.0.1` sockets. Note `9443` is not `8443` and does not conflict.
4. **Whether `tailscale cert` would actually succeed once HTTPS is enabled.** This can only be settled by issuing a certificate, which this reconnaissance is forbidden from doing. `CertDomains: null` is a reliable *negative* signal (Tailscale populates it with the names the node may request), and it is null on both hosts. Whether the toggle alone is sufficient — versus, say, an ACL or tailnet-policy restriction on cert issuance — is not observable from the client. First real test is runbook §4 on one host.
5. **Whether the tailnet is on a plan that permits HTTPS certificates.** `CurrentTailnet` exposes only `Name`, `MagicDNSSuffix` and `MagicDNSEnabled` — no plan or feature-flag field. The tailnet name is a personal-account address, and HTTPS certificates are available on Tailscale's free Personal plan, so there is no reason to expect a plan block; but this is background knowledge, not something these hosts reported.
6. **`/var` free space as a distinct figure.** On both hosts `/var` is not a separate filesystem, so `df -h /var` reports the root filesystem. The numbers given (`580 G` on `geekom`, `49 G` on `depr`) are correct for `/var/lib/echolet` and for `/var/lib/docker`, but they are shared with everything else on the host.
7. **Anything about the tailnet ACL.** Whether ACLs permit `alekss-macbook-pro` → `geekom:8443` / `depr:8443` is a coordination-server property, not a host property, and `tailscale status` does not expose the policy. Both hosts show `ShieldsUp=False` (no host-level block on incoming tailnet connections), and both currently accept tailnet traffic to published container ports, so the default-allow ACL is the likely state. The definitive check is runbook §8 from a second machine after the relay is up.

---

## Cross-check against the runbook's §1 table

Every claim the runbook makes about these hosts was verified. One line needs a correction and one needs an addition.

| Runbook §1 claim | Observed | Verdict |
|---|---|---|
| Both: Ubuntu 24.04, x86_64 | 24.04.4 LTS, x86_64 | ✅ |
| `geekom`: 16 cores, 27 GiB | 16 cores, 27 GiB | ✅ |
| `depr`: 4 cores, 7.6 GiB | 4 cores, 7.6 GiB | ✅ |
| Logins `altsay` / `ubuntu` | confirmed | ✅ |
| `geekom` sudo needs a password | `sudo -n true` fails | ✅ |
| `depr` sudo passwordless | `(ALL) NOPASSWD: ALL` | ✅ |
| Docker present, usable without sudo, both | 29.3.0 / 29.1.3, `docker ps` works as each user | ✅ |
| `geekom` firewall state not readable without sudo | correct | ✅ |
| `depr` ufw active | active, default deny in, tailscale0 allowed | ✅ |
| Nothing listens on 80 or 443 | nothing on 443 or 8443 either | ✅ |
| Neither host has Go, Node, a checkout or a reverse proxy | no reverse proxy active on either | ✅ (Node *is* present on `depr` via `.nvm`, but nothing depends on its absence) |
| §6: "Ubuntu's `docker.io` package ships the engine without the compose plugin" | `depr` **has** compose 2.40.3 from the distro; `geekom` has v5.1.0 | ⚠️ **caveat does not apply here** — the compose path in §6 works on both, `run-relay.sh` is not needed |
| §4 `tailscale cert` — assumed to work | **`CertDomains: null` on both hosts** | ❌ **not currently possible** — see G0. The runbook does not mention enabling HTTPS Certificates in the admin console, and it should. |

Suggested runbook addendum for §4 (not applied — this task changes no repository file beyond this report):

> `tailscale cert` requires **HTTPS Certificates** to be enabled for the tailnet (admin console → DNS → HTTPS Certificates). Confirm before you start: `tailscale status --json | jq .CertDomains` must list this host's MagicDNS name. If it is `null`, `tailscale cert` will fail and no amount of host configuration will fix it.

---

## Routing audit

- `graph_used`: no — *not relevant*. This task's targets were four named artifact paths supplied in the assignment plus two remote hosts; there was no structural "where does X live / what breaks if I change Y" question for the code graph to answer, and no repository code was navigated.
- `wiki_used`: no — *not relevant*. The question was the observed state of two servers, not project architecture, domain behaviour or a recorded decision. The authoritative in-repo source for the intended deployment is `docs/requirements/echolet-cli-prototype/deployment-runbook.md`, which was read in full.
- `ctx_used`: partial. `keryx ctx run` was invoked once (audit at `.metaproject/data/gdctx/artifacts/2026-09-07T12-13-11-183Z_run.md`) but does not forward stdin, so the `ssh … 'bash -s' < script` form produced no output through it. Remote output was instead captured to files under the session scratchpad and read from there — same objective (no raw flood into context), different mechanism. Deploy artifacts were read directly; each is under 460 lines and all of it was load-bearing.
- `raw_rg_used`: **no**. No `rg` or `grep` was run over project code. One host-side `awk` was used on `/etc/ufw/ufw.conf` (a remote file, not project code) and `python3` on `tailscale status --json`, both to avoid dumping large output.

## Files written

- This report — the only intended write.
- `.metaproject/data/gdctx/raw/2026-09-07T12-13-11-183Z_run.log` and `.metaproject/data/gdctx/artifacts/2026-09-07T12-13-11-183Z_run.md` — created automatically by the single `keryx ctx run` invocation. Tool-managed audit artifacts, no project content changed. Flagged here for transparency since this task was scoped read-only.
- Scratch under the session scratchpad (`recon.sh`, `certcheck.sh`, `geekom.txt`, `depr.txt`, `certcheck.txt`) — outside the repository.

**Nothing was written, installed, started, stopped, enabled or configured on `geekom` or `depr`.**
