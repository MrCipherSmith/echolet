# T14 — Renewal report: `depr` renews itself, and the fleet-wide gap is closed

Date: 2026-09-07 (20:51–21:02 UTC)
Scope: **write**, on `depr` only — three unit files under `/etc/systemd/system`,
one enabled timer, three service runs. Plus `docs/requirements/echolet-cli-prototype/deployment-runbook.md`.
`geekom` was read exactly once, read-only, over SSH, and not modified.
No source file, no test file and **no committed deployment artifact** was changed:
`deploy/relay/systemd/*` is byte-identical to what it was before this task.
The working tree's in-flight changes under `apps/relay` and `apps/cli` were not
read, run or touched.

---

## 0. The headline

| | `depr` before | `depr` after |
|---|---|---|
| Renewal | **none** — certificate expires 6 Dec 2026 with nothing to renew it | **automated** — root `systemd` timer, enabled + active, next run scheduled |
| Units used | — | **the committed `deploy/relay/systemd/*`, byte-for-byte**, plus one per-host drop-in |
| Proven end to end | — | **yes** — service started 3×, `Result=success`, `status=0/SUCCESS` each time |
| Reaches the running container | — | **yes** — same inode host-side and container-side; a write by the unit is observed from inside the container (§4) |
| Let's Encrypt requests made | — | **zero.** Serial `0583D38A…` identical before and after all three runs |
| Relay restarted | — | **no.** Same container id, same `StartedAt`, `RestartCount=0`, `health=healthy` throughout |
| Key permissions | `key.pem 0600`, owner `10001:10001` | **unchanged — `0600`, owner `10001:10001`**, never touched, never printed |

**Both hosts in the fleet now renew their own certificates.** The gap that
`t11-geekom-tls-report.md` §13 left open is closed.

---

## 1. Before state on `depr`, captured before anything was touched

```
uid=1000(ubuntu) gid=1000(ubuntu) groups=1000(ubuntu),112(docker),988(ollama)
sudo -n true  ->  sudo_n_exit=0                      # passwordless, confirmed
CertDomains = ['depr.tail5a88fb.ts.net']
tailscaled.service: active, enabled
systemd 255 (255.4-1ubuntu8.17);  Docker 29.1.3;  Compose 2.40.3
```

```
id=7eef4c4e222af88d48823fbddb3de52cd3aaaa18814ee47406bf5d6083611deb
image=echolet-relay:20260907-a2f07bb
started=2026-09-07T19:36:22.318727808Z   restarts=0   health=healthy   status=running
user=10001:10001   labels={"echolet.tls":"enabled", …}
mounts=[{"Destination":"/etc/echolet/tls","Mode":"ro","RW":false,
         "Source":"/etc/echolet/tls","Type":"bind"},
        {"Destination":"/var/lib/echolet","Name":"echolet-relay-data","Type":"volume","RW":true}]
ECHOLET_TLS_CERT_FILE=/etc/echolet/tls/cert.pem
ECHOLET_TLS_KEY_FILE=/etc/echolet/tls/key.pem
ECHOLET_TLS_RELOAD_INTERVAL_SECONDS=60
```

| | value |
|---|---|
| Certificate | Let's Encrypt `CN=depr.tail5a88fb.ts.net`, issuer `CN=YE2`, `Sep 7 18:35:38 2026 GMT` → `Dec 6 18:35:37 2026 GMT`, serial `0583D38AB74143B5369C686A76F9F923A7D2` |
| Host pair | `/etc/echolet/tls/cert.pem` `0644` `10001:10001`, `key.pem` `0600` `10001:10001` |
| Renewal units | **none.** `systemctl list-timers --all` has no `echolet` entry; `/etc/systemd/system` has no `echolet` unit file |
| crontab | `no crontab for ubuntu` |
| User manager | `running`; `loginctl show-user ubuntu` → `State=active Linger=yes` |
| Strays baseline | **8 containers, 4 volumes, 0 dangling**; one `echolet*` volume (`echolet-relay-data`) |
| Host copy of the committed units | `~/echolet-deploy/systemd/` present, **byte-identical to the repository** |

The host's copy of the units is the committed artifact, confirmed by digest on
both sides:

```
2711142bb929bd3d3964ff7e14248197200b0fbd626c71e672271d5b17e956f9  echolet-cert-renew.service   (repo == depr)
c18f0395a501117585ebaaed30dca3608d35020cd96b173351bf76db6ed2c9e0  echolet-cert-renew.timer     (repo == depr)
b9140d0476745b9c84ed85a0e72ec027db78c37af41f6269ffe5bbacdcdc6eb4  run-relay.sh                 (repo == depr)
```

Both relays were confirmed serving before anything was touched, from this Mac,
with no `-k`:

```
depr    http_code=200 ssl_verify_result=0 scheme=HTTPS   {"ok":true,"data":{"status":"healthy","uptime_ms":4772289}}
geekom  http_code=200 ssl_verify_result=0 scheme=HTTPS   {"ok":true,"data":{"status":"healthy","uptime_ms":882280}}
```

---

## 2. The decision: a system timer on `depr`'s existing layout, not `geekom`'s volume

The task set the choice explicitly. **I kept `depr`'s host-path layout and
installed the committed units as a root-scope timer.** Reasons, in the order that
decided it:

1. **Replicating `geekom`'s arrangement means replacing the running container.**
   Moving `depr`'s pair into a named volume requires editing `env/depr.env` to
   point `ECHOLET_TLS_DIR` at a volume and re-running `run-relay.sh`, which
   `docker stop` + `docker rm` + re-creates `echolet-relay`. The constraint is
   "do not disturb either running relay", and the task itself says not to
   restructure a working TLS deployment merely for symmetry. A relay outage to
   make two hosts look alike is a bad trade against an outage nine months away.
2. **`geekom`'s volume arrangement exists to work around a missing privilege that
   `depr` has.** `altsay`'s `sudo` is password-gated, so `geekom` cannot `chown`
   to uid 10001 on the host and cannot install into `/etc/systemd/system`; the
   volume + `--user 0` container route exists precisely to get root's effect
   without root. `depr` has passwordless `sudo`. Copying the workaround to a host
   that does not need it makes the fleet uniformly *odd* rather than uniformly
   *simple*, and it would leave the committed units unusable on both hosts —
   strictly worse for the next reader.
3. **The committed units work on `depr` as written.** Every assumption they make
   holds: root install ✓, `ECHOLET_TLS_DIR=/etc/echolet/tls` matches the host ✓,
   `ECHOLET_UID=10001` matches the container ✓, `tailscaled.service` exists and
   is active ✓, `/usr/bin/tailscale` and `/usr/bin/env` exist ✓. Verified before
   installing, not assumed. Using them means the repository's own artifact is now
   proven somewhere rather than being dead code everywhere.
4. **`depr`'s bind mount is a stronger delivery guarantee than `geekom`'s volume,
   not a weaker one.** `geekom` needs an extra copy step to get renewed bytes
   from `~/echolet-tls` into `echolet-relay-tls`; that step can fail. On `depr`
   the container's `/etc/echolet/tls` **is** the host's `/etc/echolet/tls` —
   verified as the same inode from both sides (§4). There is nothing in between
   to fail. Adding a copy step to `depr` for symmetry would add a failure mode.

**Where the uniformity actually landed.** What an operator has to remember is
now nearly identical on both hosts: same unit name `echolet-cert-renew`, same
schedule (`OnCalendar=daily`, `RandomizedDelaySec=6h`, `Persistent=true`), same
no-restart guarantee, same shape of status and journal output. **The one thing
that differs is the `--user` flag** — `systemctl status echolet-cert-renew.timer`
on `depr`, `systemctl --user status echolet-cert-renew.timer` on `geekom`. That
single divergence is now written into the runbook in three places, including the
"Where things live" table, because the failure mode is silent: the plain command
on `geekom` reports nothing rather than reporting an error.

Rejected alternatives: **cron** (no journal, no `Persistent=true` catch-up, no
status surface — and `depr` has no crontab at all, so adding one introduces a
second scheduling system to the fleet); **a sidecar container** (a second
long-lived container on a host that should end with one).

---

## 3. What was installed

Three files, all root-owned `0644`. The two unit files are the committed bytes,
installed with `install(1)` and **not edited**:

```
/etc/systemd/system/echolet-cert-renew.service                        (1570 bytes, sha256 2711142b…)
/etc/systemd/system/echolet-cert-renew.timer                          ( 509 bytes, sha256 c18f0395…)
/etc/systemd/system/echolet-cert-renew.service.d/10-hostname.conf     (  66 bytes, new)
```

The drop-in carries the one per-host value the committed service demands and
deliberately does not hardcode. It is exactly what `sudo systemctl edit
echolet-cert-renew.service` writes, done non-interactively:

```ini
[Service]
Environment=ECHOLET_TLS_HOSTNAME=depr.tail5a88fb.ts.net
```

`daemon-reload` succeeded, and both units lint clean:

```
daemon_reload_exit=0
systemd-analyze verify echolet-cert-renew.service  ->  exit 0, no output
systemd-analyze verify echolet-cert-renew.timer    ->  exit 0, no output
```

systemd's own view of what it parsed — worth recording because the committed
`ExecStart` is one long single-quoted `sh -c` argument full of `$VAR`, and it was
not obvious in advance whether systemd would expand those at load time or leave
them for `sh`:

```
ExecStart: { path=/usr/bin/env ; argv[]=/usr/bin/env sh -c  test -n "$ECHOLET_TLS_HOSTNAME" || { … };
             /usr/bin/tailscale cert --cert-file "$ECHOLET_TLS_DIR/cert.pem" … }
Environment: ECHOLET_TLS_DIR=/etc/echolet/tls ECHOLET_UID=10001 ECHOLET_TLS_HOSTNAME=depr.tail5a88fb.ts.net
DropInPaths: /etc/systemd/system/echolet-cert-renew.service.d/10-hostname.conf
```

The `$VAR` references survive into the child verbatim, and the environment that
resolves them — including the drop-in's contribution — is present. Both readings
would have produced the same result here, but it is now observed rather than
assumed.

### Timer state

```
$ sudo systemctl enable --now echolet-cert-renew.timer
Created symlink /etc/systemd/system/timers.target.wants/echolet-cert-renew.timer
  → /etc/systemd/system/echolet-cert-renew.timer.
enable_exit=0

$ systemctl is-enabled echolet-cert-renew.timer   ->  enabled
$ systemctl is-active  echolet-cert-renew.timer   ->  active

$ systemctl list-timers echolet-cert-renew.timer --all
NEXT                        LEFT LAST PASSED UNIT                     ACTIVATES
Tue 2026-09-08 05:32:19 UTC   8h -    -      echolet-cert-renew.timer echolet-cert-renew.service

Unit=echolet-cert-renew.service   Persistent=yes   RandomizedDelayUSec=6h
```

Two notes on that output, so nobody reads it wrong later:

- **`NEXT` moves between readings** — it was `00:50:41 UTC` right after enabling
  and `05:32:19 UTC` a few minutes later. That is `RandomizedDelaySec=6h`
  re-rolling the jitter on each recalculation, which is the flag doing its job.
- **`LAST` is `-` even though the service has run three times.** systemd records
  a trigger stamp only for elapses it caused; a manual `systemctl start` of the
  service is not one. `geekom`'s timer shows the same `-` for the same reason.
  **The timer itself has not yet fired.** What is proven is that the service it
  activates runs correctly and that the timer is armed to activate it.

---

## 4. Proof that renewal reaches the path the *running container* sees

### 4.1 Host path and container path are the same inode

This is the fact `depr`'s arrangement rests on, and it is checked from both
sides rather than inferred from the mount type:

```
HOST /etc/echolet/tls/cert.pem ino=2177654 mode=644 owner=10001:10001 size=4833
CTR  /etc/echolet/tls/cert.pem ino=2177654 mode=644 owner=10001:10001 size=4833
HOST /etc/echolet/tls/key.pem  ino=2177655 mode=600 owner=10001:10001 size=227
CTR  /etc/echolet/tls/key.pem  ino=2177655 mode=600 owner=10001:10001 size=227

host      cert sha256: 10089b7a4efbe9feecbc610b3b379566558e3aa57dc3f0411153ff9670b31995
container cert sha256: 10089b7a4efbe9feecbc610b3b379566558e3aa57dc3f0411153ff9670b31995
```

(`CTR` lines are `docker exec echolet-relay …` against the **running** container,
not a fresh one.)

### 4.2 The first end-to-end run

```
$ sudo systemctl start echolet-cert-renew.service        start_exit=0

● echolet-cert-renew.service - Renew the Echolet relay's tailnet TLS certificate
     Loaded: loaded (/etc/systemd/system/echolet-cert-renew.service; disabled; preset: enabled)
    Drop-In: /etc/systemd/system/echolet-cert-renew.service.d
             └─10-hostname.conf
     Active: inactive (dead) since Mon 2026-09-07 20:57:30 UTC
TriggeredBy: ● echolet-cert-renew.timer
    Process: 3918223 ExecStart=/usr/bin/env sh -c … (code=exited, status=0/SUCCESS)
        CPU: 24ms

Result=success   ExecMainCode=1   ExecMainStatus=0

Sep 07 20:57:29 depr systemd[1]: Starting echolet-cert-renew.service …
Sep 07 20:57:30 depr env[3918224]: Public cert unchanged at /etc/echolet/tls/cert.pem
Sep 07 20:57:30 depr env[3918224]: Private key unchanged at /etc/echolet/tls/key.pem
Sep 07 20:57:30 depr systemd[1]: echolet-cert-renew.service: Deactivated successfully.
Sep 07 20:57:30 depr systemd[1]: Finished echolet-cert-renew.service …
```

`Loaded: … disabled` is correct: the **timer** is enabled, the service is
`TriggeredBy` it. Only the timer should ever be enabled.

**No Let's Encrypt request was made.** `tailscale cert` reported both files
unchanged, and the serial is identical before and after:

```
serial=0583D38AB74143B5369C686A76F9F923A7D2
notBefore=Sep  7 18:35:38 2026 GMT   notAfter=Dec  6 18:35:37 2026 GMT
```

The run's only observable effect on the pair is a **`ctime` change to 20:57 on
both files** — that is the unit's `chown` + `chmod` landing. `mtime` stayed at
`19:34`, because `tailscale cert` did not rewrite content it did not need to.

### 4.3 A positive proof that the unit's own writes land inside the container

`geekom` could show delivery by a changed `mtime`, because its script copies into
the volume on every run. On `depr` a no-op run rewrites no content, so a digest
comparison alone would be a tautology — it would have matched before the run too.
So the unit's write path was exercised deliberately, and observed from inside the
running container.

The perturbation is confined to the **public** `cert.pem` and is strictly *more*
restrictive (`0644` → `0640`). The file is owned by uid 10001, which is the
relay's own uid, so the relay can read it at every instant. **`key.pem` was not
touched and stayed `0600` throughout.** Nothing was made world-readable at any
point, in either direction.

```
step 0  CTR /etc/echolet/tls/cert.pem ino=2177654 mode=644 owner=10001:10001

step 1  $ sudo chmod 0640 /etc/echolet/tls/cert.pem      chmod_exit=0
        HOST /etc/echolet/tls/cert.pem mode=640

step 2  CTR /etc/echolet/tls/cert.pem ino=2177654 mode=640 owner=10001:10001
        cert still readable by the relay uid: yes

step 3  $ sudo systemctl start echolet-cert-renew.service   start_exit=0
        Result=success   ExecMainStatus=0
        Sep 07 20:58:32 depr env[3919724]: Public cert unchanged at /etc/echolet/tls/cert.pem
        Sep 07 20:58:32 depr env[3919724]: Private key unchanged at /etc/echolet/tls/key.pem
        Sep 07 20:58:32 depr systemd[1]: Finished echolet-cert-renew.service …

step 4  CTR /etc/echolet/tls/cert.pem ino=2177654 mode=644 owner=10001:10001   <- restored, seen from inside
        CTR /etc/echolet/tls/key.pem  ino=2177655 mode=600 owner=10001:10001   <- untouched
        container cert sha256: 10089b7a4efbe9feecbc610b3b379566558e3aa57dc3f0411153ff9670b31995
        host      cert sha256: 10089b7a4efbe9feecbc610b3b379566558e3aa57dc3f0411153ff9670b31995

step 5  serial=0583D38AB74143B5369C686A76F9F923A7D2       <- still no issuance
```

**The running container observed a state that only the timer's service unit
produced.** That is the link the report needed: it is the unit's writes, not
merely some host path, that the relay reads.

### 4.4 The relay was not disturbed

Across all three service runs and the mode round-trip:

```
id=7eef4c4e222af88d48823fbddb3de52cd3aaaa18814ee47406bf5d6083611deb   <- same container
started=2026-09-07T19:36:22.318727808Z                                <- same start, not restarted
restarts=0   health=healthy   status=running
```

The relay log gained **no** certificate, reload, `WARN` or `ERROR` line — the
grep for them returned empty. (The only other log lines on that host are the
`TLS handshake error … client sent an HTTP request to an HTTPS server` entries
from the T11 downgrade probes at 19:37 and 19:48, which predate this task.)

Health, over verified TLS with no `-k`, from the host itself and from this Mac
after all the work:

```
on depr:      local http_code=200 ssl_verify_result=0
from this Mac depr    http_code=200 ssl_verify_result=0 scheme=HTTPS
              geekom  http_code=200 ssl_verify_result=0 scheme=HTTPS
```

Strays, against the §1 baseline: **8 containers / 4 volumes / 0 dangling —
identical.** No container was created, no volume was created, no image was
pulled. `echolet-relay-data` was not deleted, not recreated, not touched.

---

## 5. `geekom`, read-only, after this task

Checked once over SSH, nothing written:

```
systemctl --user is-enabled echolet-cert-renew.timer   ->  enabled
systemctl --user is-active  echolet-cert-renew.timer   ->  active
NEXT                        LEFT     UNIT                     ACTIVATES
Tue 2026-09-08 01:46:27 UTC 4h 47min echolet-cert-renew.timer echolet-cert-renew.service
loginctl show-user altsay  ->  State=active  Linger=yes
last service run: Mon 2026-09-07 20:44:25 UTC, Result=success, ExecMainStatus=0

CTR /etc/echolet/tls/cert.pem ino=51010369 mode=644 owner=10001:10001
CTR /etc/echolet/tls/key.pem  ino=51010370 mode=600 owner=10001:10001
docker exec echolet-relay sha256sum → 6d25a68f5e1dd883c63b1e35833b78752e22b58b8a88cfeeb5732ad25a816669
relay: id=2207fce6eb29… started=2026-09-07T20:41:12.586657673Z restarts=0 health=healthy
cert: serial=05A82BF9667A1EFEE1709DAAD9EF83F0F15B  Sep 7 2026 → Dec 6 2026
```

Unchanged from `t11-geekom-tls-report.md` §8 in every respect.

---

## 6. Fleet state after this task

| | `depr` | `geekom` |
|---|---|---|
| Serving | `https://depr.tail5a88fb.ts.net:8443`, `200`, `ssl_verify_result=0` | `https://geekom.tail5a88fb.ts.net:8443`, `200`, `ssl_verify_result=0` |
| Certificate | `CN=depr…`, issuer `YE2`, serial `0583D38A…`, → **6 Dec 2026** | `CN=geekom…`, issuer `YE1`, serial `05A82BF9…`, → **6 Dec 2026** |
| Certificate lives in | `/etc/echolet/tls` (host dir, bind-mounted `:ro`) | named volume `echolet-relay-tls` |
| **Renewal** | **AUTOMATED** — root `systemd` timer | **AUTOMATED** — `systemctl --user` timer, lingering |
| Units | **the committed `deploy/relay/systemd/*`, verbatim** + drop-in | bespoke, under `~/echolet-cert-renew/` — committed units unusable there |
| Schedule | `daily`, `RandomizedDelaySec=6h`, `Persistent=true` | identical |
| Proven run | 3 runs, `Result=success`, exit 0 | 1 run, `Result=success`, exit 0 |
| Restarts the relay | no | no |
| Issuances spent by proving it | **0** | 0 |
| Status command | `systemctl status echolet-cert-renew.timer` | `systemctl --user status …` |
| `sudo` used by this task | yes | **none — not contacted for writes at all** |

**Do the two hosts' arrangements match? No — and deliberately not.** The
*mechanism* differs (root vs user scope; host directory vs Docker volume) because
the hosts' privileges differ. The *operator-visible contract* matches: same unit
name, same schedule, same no-restart guarantee, same journal shape. The single
residual divergence an operator must remember is the `--user` flag, and it is now
documented in four places in the runbook.

---

## 7. The two open gaps — where each stands after this work

**Gap 1 — the relay's reloader picking up genuinely new certificate content is
still unproven, on both hosts. Unchanged by this task, and honestly so.**

What is now proven on **both** hosts is the *delivery* half: renewed bytes reach
the exact path the running relay reads. On `geekom` that was shown by a changed
`mtime` inside the volume plus a matching digest read from inside the container;
on `depr` it is shown more directly still, because the host path and the
container path are literally the same inode (§4.1), and by the container
observing a state only the service unit produced (§4.3).

What is **not** proven on either host is the *pickup* half — the relay's
in-process reloader noticing changed content by digest and swapping the
certificate without a restart. Forcing that requires the certificate content to
actually change, which requires re-issuance, and Let's Encrypt rate-limits
duplicates at roughly five per week per name. Both names have one issuance each
and neither budget was spent here. Pickup rests on
`apps/cli/test/e2e/relay-tls.test.ts` ("picks up a renewed certificate without a
restart") and on reading the code — not on an observation from either host. This
was a deliberate refusal to spend the budget for a demonstration, and it is
recorded as a gap in the runbook's limitations section rather than glossed.

**Gap 2 — no reboot has been performed on either host, so "the timer survives a
reboot" still rests on configuration rather than on an observed boot. Unchanged.**

On `depr` the mechanism is the standard one: `/etc/systemd/system/timers.target.wants/echolet-cert-renew.timer`
exists as a symlink (observed), and `timers.target` is reached on every boot; a
root-scope timer needs no lingering at all, so `depr`'s claim is on marginally
firmer ground than `geekom`'s, which additionally needs `Linger=yes` for the user
manager to start without a login session (`Linger=yes` observed, and it predates
both tasks). `Persistent=true` on both means a host that was off across the
renewal window catches up on boot rather than waiting for the next daily tick.
Rebooting either relay host to observe this was not attempted — it would have
meant deliberately interrupting a serving relay, which the constraints forbid and
which would be a poor trade for confirming a documented systemd behaviour.

---

## 8. Runbook changes

All in `docs/requirements/echolet-cli-prototype/deployment-runbook.md`, version
bumped `0.4.0` → `0.5.0`. **No committed deployment artifact was changed** —
`deploy/relay/systemd/*` is untouched, because the units needed no correction:
they work as written on `depr`, and their unusability on `geekom` is a property
of that host, not a defect in the files.

1. **Status block (top of document).** It said `depr`'s renewal timer "is not
   installed" and that `geekom` "is still on the loopback-only path" — both stale,
   the second since the T11 `geekom` task. Replaced with what is actually running:
   both hosts on TLS, both renewing, and an explicit statement that **the
   committed units work on `depr` and are unusable as written on `geekom`**, with
   the four assumptions that fail there enumerated, and a warning not to copy the
   five-line recipe without checking which case the host is.
2. **"Which path to follow".** The loopback path is no longer "what `geekom` runs
   today" — neither host runs it. The TLS path now names the no-root variant.
3. **§1 survey note.** The claim that both hosts run "on the §6.5 path … no
   `/etc/echolet`, no systemd unit" was stale in every clause. Replaced with a
   four-row table of exactly what the two hosts no longer share: certificate
   location, `/etc/echolet`, timer scope, and whether `sudo` is used at all.
4. **§4's renewal section, rewritten and given a subsection §4.1, "Renewal is
   installed on both hosts, by two different mechanisms".** This is the substance
   of the change: a comparison table of the two arrangements; the exact `depr`
   recipe as run (install + drop-in + enable + prove); *why* no volume-refresh
   step is needed there, with the inode fact; the `geekom` route with its
   `--user 0` container step and why the committed units cannot be used there;
   the no-restart guarantee; the "a daily run costs nothing" property with the
   evidence; and an explicit **"what renewal does not yet prove"** list carrying
   both open gaps from §7 above. It also warns against `systemctl enable` on the
   *service* — the committed unit's `[Install] WantedBy=multi-user.target` is a
   wart, and `disabled` in the service's status is correct rather than a mistake.
5. **§12 "Where things live".** The single "Renewal timer" row became two, one
   per host, because the `geekom` command needs `--user` and the plain command
   finds nothing there — a silent failure. The single "Certificate pair" row
   likewise became two.
6. **§13 Teardown.** Added removal of the `.service.d` drop-in directory, which
   the old recipe would have orphaned, and added the whole no-root teardown
   variant for a `geekom`-shaped host.
7. **Known limitations.** The entries "`geekom` is still on the loopback-only
   path" and "the certificate-renewal timer is not installed on `depr`" were both
   removed as no longer true, and replaced by four that are: the two hosts' TLS
   deployments are not interchangeable; the committed units are usable on one host
   and not the other, with nothing in the repository yet shipping the variant
   `geekom` runs; hot reload is unexercised on **both** hosts; and neither host has
   been rebooted since its timer was installed.

**One thing left alone, and flagged rather than fixed:** `deploy/relay/README.md`
line 15 still describes `systemd/echolet-cert-renew.{service,timer}` as simply
"Daily `tailscale cert` refresh". That is accurate but incomplete — it does not
say the units are root-and-host-path only. `deploy/relay/README.md` sits outside
the paths this task was permitted to change (`docs/` and
`deploy/relay/systemd/`), so it was not edited. A reader who starts there rather
than at the runbook can still be misled, and the honest fix is either a line in
that README or a user-scope variant committed under `deploy/relay/systemd/`.

---

## 9. Redaction

- **No private key, no store key, no plaintext and no HTTP request body appears
  anywhere in this report.** `key.pem` was never read, never printed, never
  copied off `depr`. Only its size (227 bytes), mode (`0600`), owner
  (`10001:10001`) and inode number were recorded — and its mode was never
  changed, in either direction, at any point.
- The only permission change made anywhere was `cert.pem` (the **public**
  certificate) `0644` → `0640` → `0644`, entirely within §4.3, ending exactly
  where it started. Nothing was made world-readable.
- The identifiers quoted — certificate serials, subjects, issuers, validity
  dates, inode numbers, container ids and image digests — are public certificate
  metadata and local object identifiers.
- No `-k`, no `--insecure`, no `--cacert` and no `NODE_TLS_REJECT_UNAUTHORIZED`
  was used at any point. Every TLS connection in this task validated its chain
  against the system trust store.
- No certificate was issued. `tailscale cert` ran three times and reported the
  pair unchanged every time; the serial is byte-identical before and after.

---

## 10. What failed

**Nothing failed.** Every step succeeded on its first attempt: the units
installed cleanly, `systemd-analyze verify` returned exit 0 with no output for
both, `daemon-reload` succeeded, `enable --now` created the `timers.target.wants`
symlink, and all three service runs exited `0/SUCCESS`.

Two observations that are not failures but would have been easy to misread, and
are recorded so a later reader does not:

1. **`systemctl list-timers` shows `LAST` as `-`.** The service has run three
   times, but by manual `systemctl start`, which does not update the timer's
   persistence stamp. The timer has genuinely not fired yet; its first elapse is
   the next scheduled one. `geekom`'s timer shows the same, for the same reason.
   Read `LAST` as "last *timer-driven* run", not "last run".
2. **`NEXT` changes between consecutive readings** (`00:50:41` → `05:32:19` UTC).
   That is `RandomizedDelaySec=6h` re-rolling, not instability.

One pre-existing wart worth naming: the committed `.service` carries
`[Install] WantedBy=multi-user.target`, which is meaningless for a
timer-triggered oneshot and invites someone to enable the service as well as the
timer. It is harmless as long as only the timer is enabled — which is what was
done — and it is now called out in the runbook. It was **not** edited, because
the units are a committed artifact and editing them was not needed to close this
gap.

---

## 11. Teardown

Remove the renewal automation from `depr`, leaving the relay serving:

```sh
sudo systemctl disable --now echolet-cert-renew.timer
sudo rm -f /etc/systemd/system/echolet-cert-renew.{service,timer}
sudo rm -rf /etc/systemd/system/echolet-cert-renew.service.d
sudo systemctl daemon-reload
```

That returns `depr` to exactly its §1 state. It does not touch the certificate,
the container, or `echolet-relay-data`. **On this Mac:** nothing to clean up —
no file was created outside the session scratchpad and this report.

---

## 12. The question, answered plainly

**Is renewal now genuinely automated on `depr`? Yes.** A root-scope `systemd`
timer, enabled and active, built from the repository's own committed units
byte-for-byte plus one per-host drop-in, scheduled daily with 6 h of jitter and
`Persistent=true`, with a next elapse on the clock. Its service was run three
times end to end, exited `0/SUCCESS` every time, made no Let's Encrypt request
(the serial never changed), did not restart the relay, and its writes were
observed from inside the **running** container.

**Do the two hosts match? Not in mechanism; yes in contract.** `depr` renews as
root into a host directory the container bind-mounts; `geekom` renews as an
unprivileged user into a Docker volume, because it has no usable root. The unit
name, schedule, no-restart guarantee and journal shape are the same on both. The
one thing an operator must remember is `--user` on `geekom`, and the runbook now
says so in four places, including the two commands where forgetting it fails
silently.

**Both certificates still expire 6 December 2026, and both hosts will now renew
them without anyone remembering to.**

---

## Routing audit

- `graph_used`: **no** — *not relevant*. No structural question arose; no
  repository code was navigated or changed. The authoritative documents were
  named directly by the task.
- `wiki_used`: **no** — *not relevant*. This was operating two servers against a
  written runbook. The in-repo sources (`deployment-runbook.md` §0, §1, §4, §12,
  §13 and its limitations section, `deploy/relay/systemd/echolet-cert-renew.{service,timer}`,
  `deploy/relay/README.md`, and the two T11 TLS reports) were read directly.
- `ctx_used`: **yes**. `keryx ctx run` for every local command and every SSH
  invocation to both hosts, and `keryx ctx rg` for every in-repo search. Remote
  output arrives through the routed `ssh` invocation and is compacted and
  recorded like any other command.
- `raw_rg_used`: **no**. No bare `rg` or `grep` was run over project code at any
  point. The `grep` calls that appear in this report ran **inside the remote
  hosts' shell scripts**, against `docker logs`, `systemctl` output and
  `tailscale status` — remote command output, not project code, and not reachable
  by `keryx ctx rg` from this machine.

## Files written

- This report, and `docs/requirements/echolet-cli-prototype/deployment-runbook.md`
  — the only two writes inside the repository.
- `.metaproject/data/gdctx/raw/…` and `.metaproject/data/gdctx/artifacts/…`,
  created automatically by the routed `keryx ctx` invocations.
- On `depr`: `/etc/systemd/system/echolet-cert-renew.{service,timer}`,
  `/etc/systemd/system/echolet-cert-renew.service.d/10-hostname.conf`, and the
  `timers.target.wants` symlink.
- Scratch outside the repository, in the session scratchpad: `recon-depr.sh`,
  `precheck-depr.sh`, `install-renewal-depr.sh`, `enable-run-depr.sh`,
  `prove-delivery-depr.sh`, `check-geekom.sh`.

**No source file, no test file and no committed deployment artifact was changed.
`geekom` was read once, read-only, and not modified. The `echolet-relay-data`
volume was not deleted and not recreated on either host. Neither relay was
restarted.**
