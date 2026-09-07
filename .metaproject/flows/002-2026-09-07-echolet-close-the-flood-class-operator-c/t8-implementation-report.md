# T8 — Implementation: serve HTTPS for non-loopback relay URLs

Flow: `002-2026-09-07-echolet-close-the-flood-class-operator-c`
Dispatch: `002-T8-tls` · result file `dispatches/002-T8-implement-result.json`
Date: 2026-09-07 · Node v26.5.0 (`/opt/homebrew/bin/node`) · Go 1.26.1 · darwin/arm64
Criterion: AC4 (wave 2, plan item 4)

---

## 0. What changed, in one paragraph

The relay can now serve HTTPS from a certificate and key file pair on disk, chosen
by two new `ECHOLET_*` variables. Set both and it serves HTTPS on the existing
`ECHOLET_HTTP_ADDR`; set neither and it serves plain HTTP exactly as before, which
is why every pre-existing suite and the reproduction runbook are untouched. Set
**one**, or point either at a file that is missing, malformed or mismatched, and
the relay exits non-zero at startup naming the offending variable or path — it
never falls back to plain HTTP. The listener is no longer a bare
`http.ListenAndServe`: it has a TLS 1.2 floor with an AEAD-only cipher list and
four timeouts a bare `ListenAndServe` leaves at "no limit". A renewed certificate
is picked up **without a restart**, detected by SHA-256 over the file bytes rather
than by modification time. No ACME client was added: on the tailnet
`tailscale cert` issues and renews the pair, and the relay's job is to read it.

---

## 1. Configuration surface

| Variable | Default | Meaning |
|---|---|---|
| `ECHOLET_TLS_CERT_FILE` | *(empty)* | PEM certificate chain |
| `ECHOLET_TLS_KEY_FILE` | *(empty)* | PEM private key for that certificate |
| `ECHOLET_TLS_RELOAD_INTERVAL_SECONDS` | `60` | how often a handshake may re-read the pair to notice a renewal; `0` means every handshake |
| `ECHOLET_HTTP_ADDR` | `:8081` | unchanged — the one listen address, used for the TLS listener as well |

**There is deliberately no `ECHOLET_HTTPS_ADDR`.** The relay serves exactly one
scheme at a time, decided by whether the pair is configured, so a second address
could only ever disagree with the first. `ECHOLET_HTTP_ADDR` was already the
listen-address variable and stays it; the task's "configuration for the listen
address" is satisfied by the variable that already exists rather than by a second
one that would need a precedence rule.

`config.Load()` now calls `Config.Validate()`, so a bad combination stops the
process before storage is opened. Two refusals:

- `(cert == "") != (key == "")` — the half-configured pair.
- `TLSReloadIntervalSeconds < 0`.

### Why the half-configured pair is a refusal and not a warning

`apps/cli/src/runtime/config.ts:25` refuses a relay URL that is neither HTTPS nor
loopback HTTP. An operator who sets one of the two variables therefore believes
they have enabled TLS. A relay that shrugged and served plain HTTP anyway would
come up, answer `/health`, look healthy in every check an operator runs, and carry
every envelope in the clear on a network they thought was protected. That is the
worst outcome available to this task, so it is the one the tests pin hardest
(§4, cases 1–4).

---

## 2. Hardening

`apps/relay/internal/server/server.go`, `apps/relay/internal/tlsx/config.go`.

| Setting | Value | Why |
|---|---|---|
| `MinVersion` | TLS 1.2 | TLS 1.0/1.1 are deprecated by RFC 8996. Not raised to 1.3: every peer here (Go's client, Node's undici, curl) negotiates 1.3 anyway, so a 1.3 floor buys nothing and would refuse a 1.2-only client outright. |
| `CipherSuites` | 6 ECDHE + AEAD suites (AES-GCM, ChaCha20-Poly1305) | Applies to TLS 1.2 only — Go ignores the field for 1.3. Drops the CBC-mode suites Go's own default still offers for interoperability. |
| `CurvePreferences` | X25519, P-256, P-384 | — |
| `NextProtos` | `h2`, `http/1.1` | Go's own default for `ServeTLS`, stated explicitly. |
| `ReadHeaderTimeout` | 10 s | The slowloris bound, and the one that matters most. No honest client needs ten seconds to send headers. |
| `ReadTimeout` | 60 s | Above the CLI's own maximum `request_timeout_ms` (60 000). |
| `WriteTimeout` | 120 s | A poll page is already bounded by `ECHOLET_MAX_MAILBOX_BATCH` and `ECHOLET_MAX_MESSAGE_BYTES`; the flood suite's largest measured page is a few hundred kilobytes. A tighter value would fail a legitimate large page on a slow link and close nothing. |
| `IdleTimeout` | 120 s | Bounds parked keep-alive connections. |
| `MaxHeaderBytes` | 64 KiB | The API carries JSON in bodies, never in headers. |

The timeouts apply to the **plain** listener too. That is deliberate: the relay
being exposed is the point of this wave, and a bare `ListenAndServe` sets none of
them in either mode. The full pre-existing suite — including the 500-identity /
8000-envelope flood case, which is the longest and heaviest request pattern in the
repository — passes unchanged under them (§5).

---

## 3. The renewal answer: reload, implemented

**Decision: implemented, not deferred.** `tailscale cert` renews on its own
schedule; a relay that needs restarting on renewal day is an outage waiting to
happen, and the reload is ~90 lines with a clean seam
(`tls.Config.GetCertificate`).

`apps/relay/internal/tlsx/reloader.go`:

- The pair is loaded **eagerly at startup**. A missing, unreadable, malformed or
  mismatched pair is an error there, where an operator sees it.
- Every handshake calls `GetCertificate`. If the last check was less than
  `ECHOLET_TLS_RELOAD_INTERVAL_SECONDS` ago the cached pair is returned; otherwise
  both files are re-read.
- **Change is detected by SHA-256 over the two files' bytes, not by mtime.** A
  renewal that rewrites a file with a preserved or coarse timestamp is still a
  different certificate, and a touched file with identical bytes is not one.
- **A failed re-read never fails a handshake.** A renewal is not atomic: for a
  moment the certificate file may be half written, or the two files may disagree.
  The last known-good pair keeps serving and a warning is logged. Failing the
  handshake instead would turn a renewal into precisely the outage this exists to
  prevent.
- Access is mutex-guarded; `go test -race` covers 32 concurrent handshakes.

The relay contains **no ACME client**, deliberately. `tailscale cert` obtains and
renews the certificate; the relay only reads files, which also means the same code
works for any other issuer that writes a PEM pair.

---

## 4. Tests — order, and what each pins

Method: RED first. The three test files were written and run **before** any
implementation existed; the recorded failure was

```
internal/config/tls_config_test.go:36: cfg.TLSEnabled undefined (type Config has no field or method TLSEnabled)
internal/tlsx/reloader_test.go:48:  undefined: NewCertificateReloader
internal/server/server_test.go:55:  undefined: New
FAIL  echolet/apps/relay/internal/{config,tlsx,server} [build failed]
```

Implementation followed and turned them green. The devcert fixture generator was
written first, as fixture infrastructure rather than as behaviour under test.

**Go — 21 cases across three packages, all green under `-race` and `-race -tags=relayv2`.**

`internal/config/tls_config_test.go`
1. neither path set → plain HTTP, `TLSEnabled() == false`
2. both set → `TLSEnabled() == true`, paths carried through
3. certificate without key → `Load()` refuses, error names **both** variables
4. key without certificate → same
5. negative reload interval → refused
6. the reload interval default is positive

`internal/tlsx/reloader_test.go`
1. missing certificate file → refused at construction, error names the path
2. mismatched certificate and key → refused at construction
3. serves the configured certificate
4. **picks up a renewal without restart** (replaced pair ⇒ different serial)
5. **keeps the last good pair when a read fails** (half-written file ⇒ still serves)
6. honours the recheck interval (no re-read inside it)
7. safe under 32 concurrent handshakes (`-race`)

`internal/server/server_test.go`
1. plain server has all four timeouts positive and no `TLSConfig`
2. missing certificate file → `New` refuses, names the path, returns no server
3. certificate without key → refused
4. key without certificate → refused
5. `MinVersion >= TLS 1.2` and `GetCertificate` is wired
6. serves HTTPS 200 over ≥ TLS 1.2, and a plaintext request to the same port is
   answered by the TLS listener's "HTTP request to an HTTPS server" 400 — never
   with the API in the clear
7. a TLS 1.1 client's handshake is refused
8. the plain server still serves loopback HTTP

**Real binary + real client — `apps/cli/test/e2e/relay-tls.test.ts`, 3 cases.**
It builds the actual relay from this tree, generates the pair with the relay
module's own `gencert`, and drives the real `dist/cli.js` as separate processes.

1. *"refuses to start on an incomplete TLS configuration"* — four spawns of the
   real binary (cert-only, key-only, cert file absent, key not matching the
   certificate). Each must exit non-zero, name the offending variable or path in
   its output, and leave **nothing listening**: an `http://` request to the port
   must be refused at the socket. This is the silent-downgrade guard.
2. *"serves HTTPS and completes a full two-party exchange with the real CLI"* —
   `/health` over HTTPS, then init → contact export/import → `relay publish` →
   offline delivery → byte-identical exact retry (same `envelopeId`) →
   deduplication (`received: 0` on the second poll) → reply → both histories,
   3 entries each, matching plaintext and order. Plus the assertion that makes it
   AC4's case rather than a loopback one: **for this same host the CLI refuses
   `http://` with exit 2 / `INVALID_CONFIGURATION`**, so the exchange is only
   possible because the relay is serving TLS. No marker (plaintext or store key)
   appears on either stream or in the relay log.
3. *"picks up a renewed certificate without a restart"* — the running relay's
   served certificate is fingerprinted, both files are replaced by `rename`, and
   the new fingerprint is read back and validated **against the renewed anchor**,
   so it cannot pass on a cached certificate. Same PID throughout, `/health` still
   200, and the real CLI completes `init` and `relay publish` over the renewed
   certificate.

### Two facts the suite had to be built around, both measured here

- **The host address.** The suite binds the relay to the machine's first
  non-loopback IPv4 (`192.168.1.106` on this machine) and dials it, because
  `127.0.0.1` and `localhost` are exactly the two cases the CLI's HTTPS
  requirement does *not* apply to. On a host with no non-loopback IPv4 it degrades
  to `127.0.0.1` and the plain-HTTP-refusal assertion is skipped; that degradation
  is the one honest weakness of this suite, and it is why AC4's
  "from a different machine" half remains T10's.
- **Node 26 loads only the FIRST certificate from a multi-PEM trust file** —
  measured: a second anchor in the same file answers
  `DEPTH_ZERO_SELF_SIGNED_CERT`, through both `NODE_EXTRA_CA_CERTS` and the `ca`
  option. The renewal test therefore trusts each pair through its own file. Worth
  recording because it is a trap for anyone bundling roots for these suites later.

---

## 5. Verification

| Suite | Result |
|---|---|
| `go -C apps/relay vet ./...` | clean |
| `go -C apps/relay test -count=1 ./...` | all packages ok |
| `go -C apps/relay test -race -count=1 ./...` | all packages ok |
| `go -C apps/relay test -race -count=1 -tags=relayv2 ./...` | all packages ok |
| `pnpm typecheck` | green, 7 projects |
| `pnpm test` | **exit 0** — 7 workspace projects; `@echolet/cli` **33 files / 202 tests passed**, including `test/e2e/relay-tls.test.ts` (3), `two-process` (3), `flood-closure` (6), `publication-claimability` (1) |

**No pre-existing test was weakened, skipped or deleted.** `git diff --name-only HEAD -- '*_test.go' '*.test.ts'`
is **empty** against 71 tracked test files.

One correction worth recording rather than hiding: an early `go fmt ./...` in this
dispatch reformatted three files outside this task's scope, one of them a test
(`mailbox_read_mark_test.go`, plus two `signal_prekey_bundle_v2.go`). They were
reverted and each was then verified **byte-identical to `HEAD` by SHA-256**, and
the two packages re-tested green. Nothing from T7's flood closure or from flow 001
was touched.

---

## 6. What an operator must do on the host

Recorded here and in `docs/requirements/echolet-cli-prototype/runbook.md`
(§"Serving HTTPS"). **Nothing below was executed** — no server was touched, and
`tailscale cert` was not run. Deployment is T11, gated behind T10.

1. Issue the pair on the host, from the tailnet's own CA path — no public DNS
   record and no inbound port:
   ```sh
   sudo tailscale cert --cert-file /etc/echolet/cert.pem --key-file /etc/echolet/key.pem <host>.tail5a88fb.ts.net
   sudo chmod 600 /etc/echolet/key.pem
   ```
   for `geekom.tail5a88fb.ts.net` and `depr.tail5a88fb.ts.net`.
2. Run the relay with the pair and a listen address:
   ```sh
   ECHOLET_HTTP_ADDR="0.0.0.0:8443" \
   ECHOLET_TLS_CERT_FILE=/etc/echolet/cert.pem \
   ECHOLET_TLS_KEY_FILE=/etc/echolet/key.pem \
   ECHOLET_DATA_DIR=/var/lib/echolet ./relay
   ```
   Binding to the tailnet interface address rather than `0.0.0.0` is tighter and
   is a T11 decision.
3. Point clients at the **name the certificate was issued for**:
   `--relay-url https://<host>.tail5a88fb.ts.net:8443`. An IP address in the URL
   will not match a MagicDNS certificate.
4. Renewal: re-run `tailscale cert` (or let a timer do it) over the same two
   paths. **No restart is required** — within `ECHOLET_TLS_RELOAD_INTERVAL_SECONDS`
   the running relay serves the new certificate. The relay logs the two paths and
   a "reloaded TLS certificate" line; it never logs their contents.
5. Read permission on the key is the operator's to set. The relay reads the file
   as whatever user it runs as and does nothing else with it.

Two things this does **not** do, stated so nobody assumes them:

- **No HTTP→HTTPS redirect and no HSTS.** The relay serves one scheme on one
  port. There is no plain-HTTP port left open to redirect *from*, which is the
  stronger arrangement, but it also means a client that dials `http://` gets a
  connection error rather than a redirect.
- **No client certificates / mTLS.** Peer authentication is still the mailbox
  signature scheme; TLS here provides confidentiality and server authentication on
  the wire, nothing more. The tailnet is the network-level access control.

---

## 7. Files changed

| File | Change |
|---|---|
| `apps/relay/internal/config/config.go` | `TLSCertFile`, `TLSKeyFile`, `TLSReloadIntervalSeconds`; `TLSEnabled()`; `Validate()` called from `Load()` |
| `apps/relay/cmd/relay/main.go` | builds the server through `server.New`, exits 1 on a TLS configuration it cannot honour, logs the scheme and the two paths |
| `apps/relay/internal/server/server.go` | **new** — timeouts, TLS wiring, `Serve`/`ListenAndServe`/`Close`/`Shutdown` |
| `apps/relay/internal/tlsx/reloader.go` | **new** — SHA-256-keyed certificate reloader, last-good fallback |
| `apps/relay/internal/tlsx/config.go` | **new** — server `tls.Config`: TLS 1.2 floor, AEAD-only 1.2 suites, curves, ALPN |
| `apps/relay/internal/devcert/devcert.go` | **new** — self-signed P-256 pair generator for tests and local development; nothing on the serving path imports it |
| `apps/relay/internal/devcert/gencert/main.go` | **new** — the command form of the above, used by the e2e suite so it needs no `openssl` |
| `apps/relay/internal/config/tls_config_test.go` | **new** — 6 cases |
| `apps/relay/internal/tlsx/reloader_test.go` | **new** — 7 cases |
| `apps/relay/internal/server/server_test.go` | **new** — 8 cases |
| `apps/cli/test/e2e/relay-tls.test.ts` | **new** — 3 real-binary cases |
| `docs/requirements/echolet-cli-prototype/runbook.md` | new §"Serving HTTPS (required for any non-loopback relay)" |

`apps/cli/src/tui/`, `apps/cli/vitest.config.ts`, `apps/cli/test/globalSetup.ts`,
`flow.json` and `acceptance-criteria.md` were not touched. No `git commit` was made.

---

## 8. What this does not close

- **AC4 is not complete.** This task makes the relay *capable* of TLS and proves a
  real CLI exchange over it against a non-loopback address on **this** machine.
  "From a different machine" is T10, and the two deployed instances are T11.
- **The certificate is trusted because Let's Encrypt issued it**, on the
  deployment path. The e2e suite uses a self-signed pair with an explicit trust
  anchor, which proves the serving and reload mechanics but not the public chain.
- **The tailnet is the access control.** Anything that reaches the relay's port
  can speak to the API; TLS authenticates the *server* to the client, not the
  client to the server.
- **`ECHOLET_MAX_STORAGE_BYTES` is still declared and enforced nowhere** (T7 §6,
  R-3). Making the relay reachable makes that storage class live; it is untouched
  here.
- **`POST /v1/device-records/publish` is still unauthenticated** (T7 §6, R-6).

---

## 9. Routing audit

- `graph_used`: **no** — `not-relevant`. Every target was a named path from the
  dispatch (`config.go`, `main.go`, `two-process.test.ts`, `runbook.md`,
  `specification.md`) or a new file.
- `wiki_used`: **partial** — the authoritative sources here were the flow's
  `description.md` / `plan.md` / `acceptance-criteria.md` / `journal.md` and the
  T7 report, all read in full, plus `specification.md` §Configuration.
- `ctx_used`: **yes** — `keryx ctx rg` for every search, `keryx ctx read` for
  compact reads, `keryx ctx run` for long-output commands.
- `raw_rg_used`: **no**.

## 10. Integrity

No private key material, certificate key bytes, store key, plaintext or ciphertext
was logged, printed or written into any artifact by the implementation, the tests
or this report. Certificate and key **paths** appear in configuration, in one
startup log line and in the reload warning; contents never do. The e2e suite
asserts that no plaintext marker and no store key reaches the CLI's streams or the
relay log. Test key material lives only under a `mkdtemp` directory removed in
`afterAll`. No `git commit` was made; no server was contacted.
