# T34 — A second Echolet user, on `depr`

Date: 2026-09-08. Flow 003.

Until now both correspondents were profiles on the same Mac. There is now a second user on a
different machine: a client running in a container on `depr`, with its own profile, its own keys and
its own store key, talking to the same relay. Messages have gone both ways.

## What the second user is

| | |
|---|---|
| Identity id | `mL_Hg-NSPVUAvL8FnbFgw84kzb6KPNPQ-jYXJWU6XBI` |
| Profile id | `27561905-06d4-4a23-a117-a7fc0499c61c` |
| Device id | `29b822ad-030f-5ed0-a00a-93e36e2243b0` |
| Lives in | Docker volume `echolet-peer-profile` on `depr`, mounted at `/data` |
| Store key | `/home/ubuntu/.echolet-peer/key.env`, mode 600, in a directory mode 700 |
| Relay | `https://depr.tail5a88fb.ts.net:8443` |
| Runs as | image `echolet-client:0.1.0`, one throwaway container per command |

The owner of this Mac is `N164884qQpTeQBT3RJMcv5B4BqFlymvO4cOG4l5LW04`, unchanged.

## The commands the user types

The script is `~/.echolet/peer`, next to the existing `~/.echolet/echolet`. No identity id is ever
typed; both are baked into the script.

```
~/.echolet/peer write "hello from the Mac"     # you -> depr
~/.echolet/peer reply "hello back"             # make the depr user answer you
~/.echolet/peer read                           # poll, then print your thread with depr
~/.echolet/peer inbox                          # what the depr user has received
~/.echolet/peer roundtrip                      # one message each way, end to end
```

`read` and `inbox` poll first, so "read" really means "collect and show". Output is one line per
message rather than the CLI's JSON:

```
you  ->  9/8/2026, 7:38:25 PM  round trip at 19:38:25
them <-  9/8/2026, 7:38:37 PM  answering the 19:38:25 round trip
```

There is a matching wrapper on the server, `/home/ubuntu/.echolet-peer/echolet`, which takes the raw
CLI surface (`poll`, `send --to … --text …`, `history --with …`, `doctor`) for anyone driving the
second user from `depr` directly.

### The Node trap the script sidesteps

`~/.echolet/echolet` runs whatever `node` is first on `PATH`. In a **login** shell on this Mac that is
`/usr/local/bin/node`, **v22.12.0** — which has no `node:sqlite`, so the profile store cannot open and
the failure reads like broken code. `~/.echolet/peer` therefore picks its interpreter deliberately
(`/opt/homebrew/bin/node`, v26.5.0, or any `node` it proves is ≥ 22.13) and refuses to run rather than
fail obscurely. Verified: `bash -lc '~/.echolet/peer roundtrip'` works. The existing
`~/.echolet/echolet` launcher was left untouched and still carries this hazard.

## The image

Built **on `depr`** rather than cross-built here: `depr` is `x86_64` with Docker, so the native build
is the native platform and no `buildx` emulation is involved.

- Base: `node:22-bookworm-slim`, digest `sha256:83f487e0a634…7767a7e5`, Node **v22.23.2**.
- Result: `echolet-client:0.1.0`, `sha256:241d7096f2ac…`, `linux/amd64`, 548 MB.
- Build context on the host: `/home/ubuntu/echolet-client-build/` (`Dockerfile`, `package.json`,
  `cli.js`, `echolet`). Kept, so the image can be rebuilt on the host without this Mac.
- Build command: `cd /home/ubuntu/echolet-client-build && docker build --pull -t echolet-client:0.1.0 .`

`cli.js` is built from this repo (`pnpm --filter @echolet/cli build`), not a shipped artifact;
sha256 `465255aaba0dcfdc31c6d3f127e8347c2639602b5ed97890e095c5912cdac33c`, identical on both machines.
`esbuild` inlines everything except `@signalapp/libsignal-client`, so the image needs exactly one
`npm install`.

Two checks are baked into the build so a wrong assumption fails at `docker build`, not at the user's
first command:

1. a Node version assertion (`< 22.13` ⇒ build fails, naming `node:sqlite`);
2. an actual `require('@signalapp/libsignal-client')` plus a smoke test of `PrivateKey.generate`.
   Build output: `libsignal ok on linux/x64`.

### glibc, not musl — checked rather than assumed

The prebuilt addon in `@signalapp/libsignal-client@0.102.0` was inspected before choosing a base:

```
prebuilds/linux-x64/@signalapp+libsignal-client.node
  ELF, 26,464,448 bytes
  max GLIBC version referenced: GLIBC_2.34   (18 distinct GLIBC_* symbols)
  shared libraries:  libstdc++.so.6, libgcc_s.so.1
  musl markers:      none
```

There is **no musl build in the package at all**. On an Alpine base the install would have succeeded
and the failure would only have appeared at `require()` — the exact trap warned about. Debian
bookworm is glibc 2.36 (host is 2.39) and already carries `libstdc++6`/`libgcc-s1`, so no extra
package is installed.

Surprise worth recording: the 0.102.0 tarball ships prebuilds for **every** platform at once
(`darwin-arm64`, `darwin-x64`, `linux-arm64`, `linux-x64`, `win32-arm64`, `win32-x64`) and selects at
require time. The install is therefore not platform-specific in the usual sense — but the *selected*
binary very much is, so "install it in the container" remains the right call and the darwin/arm64
`node_modules` were never copied.

## Reaching the relay: the tailnet name, over host networking

**Decision: the tailnet name `https://depr.tail5a88fb.ts.net:8443`, with `--network host`.**

Loopback was not available, and this is a fact about the deployment rather than a preference:

```
ss -ltn 'sport = :8443'   →  LISTEN on the tailnet address only
docker inspect echolet-relay → published HostIp == `tailscale ip -4`
```

Nothing listens on `127.0.0.1:8443` or `0.0.0.0:8443`. Making loopback work would have meant
republishing the relay's port — forbidden here, and the wrong trade for a demo.

A bridge-network container could not reach the tailnet address either, even with the name pinned:

```
docker run --rm --add-host "depr.tail5a88fb.ts.net:$(tailscale ip -4)" … \
  node -e 'fetch("https://depr.tail5a88fb.ts.net:8443/")'
→ FAILED TypeError fetch failed UND_ERR_CONNECT_TIMEOUT
```

With `--network host` the same probe succeeds:

```
→ TLS ok, HTTP status 404
```

404 at `/` is the relay answering. The name is the one on the certificate, so TLS verification is
ordinary and complete — no `-k`, no `--insecure`, no CA pinning, no host-file spoofing. The
containers publish no ports of their own and are all `--rm`, so host networking grants reach without
leaving anything listening.

## Wiring the two users together

```
# on depr, inside the container
init --relay-url https://depr.tail5a88fb.ts.net:8443 --store-key-env ECHOLET_STORE_KEY
  → identity_id mL_Hg-NSPVUAvL8FnbFgw84kzb6KPNPQ-jYXJWU6XBI
relay publish
  → {"stored":true,"claimable":true,"pool":{"target":20,"claimable":20,"minted":20}}
contact export --out /out/peer-card.json

# cards carried between machines (public data)
scp depr:/home/ubuntu/.echolet-peer/peer-card.json ~/.echolet/peer-card.json
scp ~/.echolet/my-card.json depr:/home/ubuntu/.echolet-peer/owner-card.json

# each side imports the other, confirming the fingerprint it was shown
depr:  contact import --from /out/owner-card.json --yes
       shown identity_id N164884qQpTeQBT3RJMcv5B4BqFlymvO4cOG4l5LW04  → {"trusted":true}
Mac:   ~/.echolet/echolet contact import --from ~/.echolet/peer-card.json --yes
       shown identity_id mL_Hg-NSPVUAvL8FnbFgw84kzb6KPNPQ-jYXJWU6XBI  → {"trusted":true}

# the Mac had to publish too, so depr could claim a prekey bundle for it
Mac:   ~/.echolet/echolet relay publish
  → {"stored":true,"claimable":true,"pool":{"target":20,"claimable":20,"minted":19}}
```

Both fingerprints printed at import matched the identities expected on the other side.

## The transcript, both directions

Mac → `depr`:

```
Mac    send --to mL_Hg-…  --text "T34 probe: Mac to depr, first message across two machines."
       → {"messageId":"edb03c8e-…","envelopeId":"cd0cee5f-…","status":"delivered"}
depr   poll     → {"received":1,"more":false,"rejected":[]}
depr   history --with N164884qQ…
       → [{"sequence":1,"direction":"inbound","messageId":"edb03c8e-…",
           "plaintext":"T34 probe: Mac to depr, first message across two machines."}]
```

`depr` → Mac:

```
depr   send --to N164884qQ… --text "T34 probe: depr replying. Received you from a different machine."
       → {"messageId":"773d0539-…","envelopeId":"a99e2380-…","status":"delivered"}
Mac    poll     → {"received":1,"more":false,"rejected":[]}
Mac    history --with mL_Hg-…
       → [{"sequence":1,"direction":"outbound","messageId":"edb03c8e-…", …},
          {"sequence":2,"direction":"inbound","messageId":"773d0539-…",
           "plaintext":"T34 probe: depr replying. Received you from a different machine."}]
```

Polled from both sides, as asked. Message ids match across machines in both directions, so this is
one message travelling rather than two local echoes.

Then, through the user-facing script, from a **login** shell:

```
$ ~/.echolet/peer roundtrip
you  ->  9/8/2026, 7:36:31 PM  T34 probe: Mac to depr, first message across two machines.
them <-  9/8/2026, 7:37:04 PM  T34 probe: depr replying. Received you from a different machine.
you  ->  9/8/2026, 7:38:25 PM  round trip at 19:38:25
them <-  9/8/2026, 7:38:37 PM  answering the 19:38:25 round trip
```

Quoting was exercised deliberately — an apostrophe and embedded double quotes survive the trip
through `ssh` into the container (`peer write "does quoting survive? it's a test - yes"`,
`peer reply 'reply verb works, quoting and all: "quoted"'`), because arguments are re-quoted with
`printf %q` for the remote shell.

All bodies above are probe strings written for this test. No pre-existing user content, no store key,
no private key and no HTTP request body was printed, copied or recorded anywhere in this work. The
second user's store key was generated **on `depr`** (`python3 -c` writing straight to a 600-mode file)
and has never left it.

Persistence is not asserted, it is structural: every command is a **fresh `--rm` container**, and the
history above accumulates across all of them because the profile is in the named volume. `doctor` on
the second user reports `"storage":"encrypted"`, `"contact_count":1`.

## What now exists on `depr` that did not before

| Thing | Kind |
|---|---|
| `echolet-client:0.1.0` | Docker image, 548 MB |
| `echolet-peer-profile` | Docker volume (the second user's profile and history) |
| `/home/ubuntu/.echolet-peer/` | dir 700: `key.env` (600), `peer-card.json`, `owner-card.json`, `echolet` wrapper |
| `/home/ubuntu/echolet-client-build/` | the build context, kept so the image can be rebuilt on the host |

No host package was installed. No Node, no pnpm, no Go on the host — still true.

On this Mac: `~/.echolet/peer` (the script) and `~/.echolet/peer-card.json` (the second user's public
card). One contact row was added inside `~/.echolet/profile/client.sqlite`.

### The relay was not touched

Confirmed after all work: `echolet-relay` `Up 20 hours (healthy)`, `RestartCount=0`,
`StartedAt 2026-09-07T19:36:22Z` — i.e. it has not restarted, and predates this task. The
`echolet-relay-data` volume was never mounted, read or written by anything here. Nothing on `geekom`
was contacted.

No stray containers were left: `docker ps -a --filter name=echolet-peer` is empty, because every
invocation is `--rm`.

An unrelated container `musing_kowalevski` (`alpine:3.22`) was already running on `depr` when this
task started. It is not mine and was left alone.

## Teardown

Removes everything this task created, and nothing else.

```bash
# on depr
ssh depr 'docker volume rm echolet-peer-profile \
       && docker rmi echolet-client:0.1.0 \
       && rm -rf /home/ubuntu/.echolet-peer /home/ubuntu/echolet-client-build'

# on this Mac
rm -f ~/.echolet/peer ~/.echolet/peer-card.json
```

Two commands, as intended. Note the one residue neither command can clear: the second user's contact
row inside `~/.echolet/profile/client.sqlite`. The CLI's frozen eight-command surface has no
"forget contact", so removing it would mean editing the encrypted store by hand — out of scope, and
harmless: it is a public key for an identity that no longer exists, and messages to it would simply
fail with `PREKEY_BUNDLE_UNAVAILABLE`.

## Things that failed or surprised me

1. **A bridge-network container cannot reach the relay.** `UND_ERR_CONNECT_TIMEOUT`, even with the
   tailnet name pinned to the tailnet IP via `--add-host`. The relay is published on the tailnet
   address only, and traffic from `docker0` to that address does not get there. `--network host` was
   the fix; loopback was never an option without republishing the relay.
2. **`@signalapp/libsignal-client` ships every platform's prebuild in one tarball**, so `npm install`
   is not platform-selective — but the linux-x64 binary is glibc-only (GLIBC_2.34, `libstdc++.so.6`),
   with no musl build anywhere in the package. Alpine would have installed happily and blown up at
   `require()`.
3. **The existing `~/.echolet/echolet` launcher is broken in a login shell**: `/usr/local/bin/node` is
   v22.12.0 and has no `node:sqlite`. Not fixed here (out of scope), but `~/.echolet/peer` picks a
   ≥ 22.13 interpreter itself so the new commands work from any shell.
4. `contact export` uses `open(..., 'wx')`, so re-exporting a card over an existing file fails with
   `PERSISTENCE_FAILURE`. Expected, but worth knowing before assuming a disk problem.

## Routing audit

`graph_used: no` (not-relevant — this was an ops/deployment task on a known, small surface;
the CLI entry point and config module were read directly).
`wiki_used: no` (not-relevant — no architecture or domain question arose).
`ctx_used: yes` (`keryx ctx run` for every command and `keryx ctx read` for every file read).
`raw_rg_used: no` (searches went through `keryx ctx rg`).
