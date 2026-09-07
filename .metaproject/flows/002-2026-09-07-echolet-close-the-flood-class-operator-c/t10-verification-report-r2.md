# T10 (re-run, attempt 3) — Independent verification after T14

Flow: `002-2026-09-07-echolet-close-the-flood-class-operator-c`
Dispatch: `002-T10-verify-r2` · parent `002-T10-verify` · Date: 2026-09-07
Runtime: **Node v26.5.0** · Go 1.26.1 · pnpm 10.0.0 · darwin/arm64

I wrote none of this code and I credit none of the earlier verification. Every number
below is one I measured on the current tree (`HEAD` = `624ea47`, "fix: the contact-import
re-walk no longer loses a message behind a deep flood"), against artefacts I built here:

| artefact | sha256 |
|---|---|
| `apps/cli/dist/cli.js` | `ed7c15575369f6744b50a4772888b66581c7a149aefd6314baa2697447b33a2b` |
| `apps/cli/dist/tui.js` | `05db89409cbb4362c39cf5c5f9958e6aba9cf890874aff38edb8fd2def027d98` |
| relay binary (`go build ./cmd/relay`) | `7d16ae901aa36623ffc720a21e2dd03184cbabbda6da1f2ab69b77fe057e1c45` |

**Probe discipline.** Every probe lives outside the repository, in the session scratchpad
(`probe-lib.mjs`, `probe-flood.mjs`, `probe-rewalk.mjs`, `probe-rewalk-interrupt.mjs`,
`probe-rewalk-reimport.mjs`, `probe-oracle.mjs`, `probe-init.mjs`, `probe-tls.mjs`,
`probe-pure.mjs`, `probe-tui-live.mjs`, `argv-recorder.mjs`). Signing uses **node:crypto's
own ed25519**, not the project's helpers, so agreement with the relay is evidence rather
than a tautology. Probes print labels, counters, byte totals, HTTP statuses, exit codes,
certificate fingerprints and booleans only — never a body, ciphertext, plaintext, store
key, seed, signature or TLS private key.

**Integrity.** A SHA-256 manifest of **242** source and documentation files under `apps/`,
`packages/` and `docs/` was taken before any work (manifest digest
`8a1041454d83347d78235a7e93d6e0c1ab9e702b61b2a3fcd42b38d5d9951120`) and re-verified at the
end: **242 of 242 OK, 0 mismatches**. Integrity was established by digest; mtime was never
used. No source, test, documentation or flow file was modified by this verification.

**Declared configuration deviation.** Probes run the relay with
`ECHOLET_RATE_LIMIT_PER_MINUTE=1000000`, the same single deviation T49/T52/T55, the
`flood-closure` suite and the previous T10 attempt declare, so the per-IP limiter does not
confound a count-of-envelopes measurement.

---

## 1. The verification matrix, re-run by me on this tree

| check | command | result |
|---|---|---|
| frozen install | `pnpm install --frozen-lockfile` | **exit 0**, 8 projects, already up to date |
| CLI build | `node build.mjs` in `apps/cli` | **exit 0** |
| relay build | `go -C apps/relay build ./cmd/relay` | **exit 0** |
| typecheck | `pnpm typecheck` (`pnpm -r typecheck`) | **exit 0**, 7 projects |
| workspace tests | `pnpm -r test` | **exit 0** — 48 files, **278 tests**, 0 failed |
| CLI e2e | `pnpm --filter @echolet/cli test:e2e --reporter=verbose` | **exit 0** — **3/3** (12.9 s / 13.2 s / 10.6 s) |
| Go vet | `go -C apps/relay vet ./...` | **exit 0** |
| Go, untagged | `go -C apps/relay test -count=1 ./...` | **exit 0** — 16 packages, 8 with tests, all `ok` |
| Go, race | `go -C apps/relay test -race -count=1 ./...` | **exit 0** — **0 `DATA RACE`** |
| Go, race + relayv2 | `go -C apps/relay test -race -count=1 -tags=relayv2 ./...` | **exit 0** — **0 `DATA RACE`** |

Per-package test counts I measured: `packages/protocol` 3/12, `client-db` 1/1,
`crypto-core` 4/20, `client-core` 2/2, `session-node` 3/24, `apps/mobile` 1/6, `apps/cli`
34/**213** — total **48 files / 278 tests**. This matches T14's claim exactly. Inside the
`apps/cli` run, `test/e2e` is **24/24 across 5 files**: `flood-closure` 8/8 (133.5 s),
`init-relay-url` 9/9, `relay-tls` 3/3, `two-process` 3/3, `publication-claimability` 1/1.

### 1.1 Test-suite integrity (AC3's second half)

- `git show --stat 624ea47` (T14): **no test file, no vitest config and no test setup file is
  in the commit.** The commit touches `apps/cli/src/runtime/{config,inbound,profile}.ts`,
  `apps/relay/internal/api/handler/mailbox_handler.go`, one runbook and flow artefacts.
- Across the whole flow, `git diff --name-status e9f0da7..HEAD -- '*test*'`: **20 test files
  added, exactly one pre-existing test file modified, none deleted.**
- The one modification is `apps/relay/internal/api/handler/mailbox_sender_quota_test.go`:
  `TestKnownResidueDistinctIdentitiesStillWedgeTheDrainWalk` became
  `TestDistinctIdentitiesNoLongerWedgeTheDrainWalk`, a parameterised assertion that now
  **fails if the wedge returns**, plus a second arm requiring a message behind the whole
  flood to be reachable in pages linear in the mailbox, plus a `t.Logf` of the measured page
  counts. I read the diff myself: the occupancy half of the residue is still asserted. The
  old test's own comment demanded exactly this change and forbade deleting or weakening it.
  **Strengthened, not weakened.**
- A repository-wide scan for `it.skip`, `test.skip`, `describe.skip`, `.todo(`, `t.Skip(`,
  `.only`, `xit(`, `xdescribe(` over `apps/` and `packages/` returns **zero genuine
  matches** (the eight hits are `os.Exit(1)` lines matching the `xit(` alternative).

---

## 2. AC2 — the closure, re-measured

4 self-published identities, 49 maximum-size poison envelopes, then Alice (already pinned)
sends; Bob polls in fresh processes. Real relay binary, real `dist/cli.js`, counting
loopback proxy.

| attacker cost | value |
|---|---:|
| identities | 4 |
| poison stored | 49 / 49 |
| uploaded | **12 880 434 B** |
| requests | 53 |

| delivery | poll exits | pages | requests | bytes down | amplification | history |
|---|---|---:|---:|---:|---:|---:|
| 1st message | **`[3,0]`** | 17 | 35 | 12 887 594 | **1.0006:1** | 1 |
| 2nd message | **`[0]`** | 2 | 5 | 1 055 957 | 0.082:1 | 2 |
| 3rd message | **`[0]`** | 1 | 3 | 267 181 | **0.0207:1** | 3 |

Every HTTP status observed across the run was `200`. The poison is still at the head of the
mailbox for the second and third messages, and they cost 5 and 3 requests: **the steady
state is O(1)**, which is the measurement a larger constant page cap cannot produce. Nothing
was duplicated or lost. **No wedge.**

Deeper volumes, measured in §3 as part of the re-walk work, confirm the walk stays O(N):
166 envelopes cost 56 pages of pre-import drive, 5 006 envelopes cost 101 pages, and the
amplification stays ≈1.0:1 per full walk.

**R-2 is reported as a bound, not as a fix.** The first walk is still linear in the mailbox:
5 006 poison envelopes cost the recipient 101 poll pages and 7 poll invocations before the
mailbox is drained once. That is a bound, and it is the design's own R-2.

---

## 3. T10-F-001 — the contact-import re-walk, re-attacked

`cli:mailbox-rewalk` now holds a **position** rather than a flag: `contact import` writes
`"0"`, `takeMailboxRewalk()` consumes it once before the walk, `poll()` advances it per
fully judged page, clears it when the relay reports no further pages, and
`keepMailboxRewalk()` writes it back — from the `catch` as well as from the normal path, and
before any verdict is re-raised (`inbound.ts:145-194`, `profile.ts:155-204`). I attacked
this path.

Construction in every row: `ahead` poison envelopes; then **Carol**, a third real CLI
profile Bob has never imported, sends one real message; then `behind` poison, from a
disjoint envelope-id range, so the message is not left in the never-marked final page; Bob
drives `poll` until a poll walks fewer than 16 pages (the mark is genuinely past Carol's
envelope, history = 0); then `contact import`; then polls.

### 3.1 The exact T10-F-001 attack, and past it

| # | ahead / behind | ciphertext | identities | envelopes | uploaded B | attacker requests | post-import exits | pages after import | requests after | **delivered** |
|---|---|---:|---:|---:|---:|---:|---|---:|---:|---|
| A | 49 / 6 (**the exact T10-F-001 shape**) | 262 144 | **5** | **55** | **14 457 630** | **60** | `[3,0,3,3]` | 20 | 41 | **YES (history = 1)** |
| B | 160 / 6 (54 pages ahead) | 262 144 | 11 | 166 | 43 635 756 | 177 | `[3,3,3,0,3,3,3,3]` | 59 | 119 | **YES** |
| C | 5000 / 6 (100 pages ahead) | 4 | 314 | 5 006 | 3 609 326 | 5 320 | `[3,3,3,3,3,3,0,…]` | 104 | 209 | **YES** |
| D | 2000 / 60 (40 pages ahead) | 4 | 129 | 2 060 | 1 485 260 | 2 189 | `[3,3,0,…]` | 48 | 97 | **YES** |

**T10-F-001 is closed at the cost that broke it.** The attack the previous attempt recorded
as permanent message loss — 5 identities, 55 maximum-size envelopes, 14 457 630 B, 60
requests, paid once — now delivers on the **second** post-import poll. Pushing to 11
identities / 166 envelopes / 43.6 MB delivers on the 4th, and 314 identities / 5 006
envelopes delivers on the 7th: exactly `ceil(pages / 16) ` invocations, which is progress,
not truncation. I found **no depth at which the re-walk fails to progress.**

The recovery cost, stated as a bound: a `contact import` against a flooded mailbox costs one
extra walk of it. Total recipient download against attacker upload was **2.019:1** (A),
**2.019:1** (B), **1.985:1** (C) and **2.017:1** (D) — paid once, operator-triggered only,
against ≈1.0:1 for ordinary delivery.

### 3.2 The first configuration at which a message is still lost

**An interruption of the recovery poll destroys the re-walk and the message is lost
permanently and silently.** Two arms of the identical shape, differing only in the
interruption:

| arm | interruption | post-import exits | pages after import | **delivered** |
|---|---|---|---:|---|
| control | none | `[3,3,0,3,3,3,3,3,3,3]` | 48 | **YES (history = 1)** |
| **SIGKILL** | recovery poll killed after 5 pages | `[3,3,3,3,3,3,3,3,3,3]` | 15 | **NO (history = 0)** |
| **SIGINT** (the operator's own Ctrl-C) | recovery poll interrupted after 5 pages | `[3,3,3,3,3,3,3,3,3,3,3,3]` | 17 | **NO (history = 0)** |
| relay outage | proxy answers `503` for the rest of that poll; poll exits **4** | `[3,3,0,3,3,3,…]` | 50 | **YES** |

Shape for all four: 2 000 min-size poison ahead (40 pages), 60 behind, 129 identities, 2 060
envelopes, 1 485 260 B, 2 189 attacker requests. Attacker cost and pre-import drive are
byte-identical across the arms; the only difference is the interruption.

- The **relay-outage** arm confirms T14's `catch`-path claim: an unreachable relay does not
  spend the re-walk, and the operator sees the exit 4 they should.
- The **SIGINT** arm is the one that matters. `takeMailboxRewalk()` deletes the key before
  the walk begins and `keepMailboxRewalk()` writes it back only when the walk returns, so a
  signal that terminates the process between those two points drops the re-walk. `inbound.ts`
  names "an operator's Ctrl-C" as one of the **normal** interruptions durable progress must
  survive; the relay-held mark survives it, the local re-walk does not.
- After the loss, the mark is already past Carol's envelope, every later poll is cursorless,
  and 10–12 further polls never re-offer it. **Nothing tells the operator anything happened:**
  polls keep exiting 3 on the never-marked final page of poison, and Carol's history stays 0.
- It **is** recoverable by the action T14 names. I measured it: a second
  `contact import --from <carol-card> --yes` exits **0**, and the message is delivered on the
  3rd subsequent poll (46 pages, 93 requests, 1 505 667 B). But nothing prompts the operator
  to do it.
- The attacker does not cause the interruption, but does choose the window: the recovery
  spans `ceil(N / 16 pages)` poll invocations, and N is the mailbox size the attacker fills.

This is finding **T10R3-F-001 (major)**. T14 disclosed the SIGKILL half in its §5.2 residual
list; the SIGINT half and the silence are not recorded anywhere, and the design's R-5 does
not predict it (R-5 names "a peer trusted through some other path, or a card imported on a
different device"). It is a residual of T14's own fix, not of the T5 design.

---

## 4. T10-F-002 — the lifetime-envelope-count oracle

`resolveReadThrough` is now split into `decodeReadThroughShape` (shape only, still before the
challenge, the device binding and the signature) and `readThroughWithinIssued` (the
mailbox-dependent bound). On `/v1/mailbox/poll` the bound runs **after
`VerifyMessageSignature` succeeds** (`mailbox_handler.go:549`); on `/v1/mailbox/ack` it runs
after `authorizeMailboxDevice` resolves and **before** the signature check
(`mailbox_handler.go:699`).

Measured against a mailbox with exactly **66** allocated positions, over the ladder
`[0, 1, 33, 65, 66, 67, 99, 1000, 4096]`, plus a binary search:

| route | credentials presented | distinct answers | recovered | oracle |
|---|---|---:|---:|---|
| `/v1/mailbox/poll` | fabricated `challenge_id`, fabricated `device_id`, signature `"AAAA"` | **1** — `400 CHALLENGE_EXPIRED` for every value | search collapses to the 4096 ceiling | **no** |
| `/v1/mailbox/ack` | fabricated `device_id`, signature `"AAAA"` | **1** — `403 UNAUTHORIZED_MAILBOX_ACCESS` | search collapses | **no** |
| `/v1/mailbox/ack` | **real `device_id` off the victim's contact card**, signature `"AAAA"` | **2** — `403 INVALID_SIGNATURE` at or below the bound, `400 INVALID_SCHEMA` above it | **exactly 66, in 13 requests** | **yes** |

Control: a real, signed poll carrying a real read position still delivers (`[0]`, history 1),
so the bound was not satisfied by deleting the protection.

**Verdict.** The unauthenticated oracle the previous attempt recovered is closed on the poll
route and closed on the ack route for a caller who names no device this mailbox knows. The
residual T14 states in its §5.1 is real and I reproduced it exactly. One honest qualification
the implementation report does not make: `identity_id` (from which `mailbox_id` is computed)
and `device_id` are **printed on the same contact card**, so the population of adversaries who
can still run this is essentially unchanged — anyone holding the victim's card. What the fix
removes is the adversary who learned `identity_id` through some other channel. Recorded as
**T10R3-F-002 (minor)**; AC8's residual list must carry it as a bound, which is what the
dispatch's own clause asks for.

---

## 5. T10-F-003 — `init` and the relay URL

26 real `echolet init` invocations against the built `dist/cli.js`, each into a fresh profile
directory:

- **Refused, exit 2 `INVALID_CONFIGURATION`, and `config.json` absent afterwards (0 files in
  the profile directory):** `https://relay.example.com/path`, `…/a/b/c`, `…/?a=1`, `…/#frag`,
  `http://127.0.0.1:8081/path`, `http://127.0.0.1:8081/?q=1`, `http://127.0.0.1:8081/#x`,
  `http://relay.example.com/`, `http://192.168.1.10:8081/`, `http://0.0.0.0:8081/`,
  `http://localhost.evil.example/`, `http://127.evil.example/`,
  `http://127.0.0.1.evil.example/`, `http://user:pw@127.0.0.1:8081/`, `ftp://127.0.0.1:8081/`.
- **Accepted, exit 0:** `http://127.0.0.1:8081/`, `http://127.0.0.1:8081`,
  `http://localhost:8081/`, `http://[::1]:8081/`, `http://127.1:8081/`,
  `http://127.0.0.1.:8081/`, `http://LOCALHOST:8081/`, `https://relay.example.com/`,
  `https://relay.example.com`, `https://relay.example.com:8443/`.

**The defect is closed:** a relay URL carrying a path or a query is now an
`INVALID_CONFIGURATION` at exit 2 rather than a `PERSISTENCE_FAILURE` at exit 5 on the next
relay command, and a refused `init` writes nothing.

**They do not yet fully agree.** Driving both `parseClientConfig` and `RelayClient` directly,
through an out-of-repo esbuild bundle of the real modules, over 24 URLs: **22 agree, 2 do
not.** `RelayClient` treats loopback as `/^127\./` on the hostname
(`relayClient.ts:75`) while `parseClientConfig` requires a dotted quad
(`config.ts:38`), so `http://127.evil.example/` and `http://127.0.0.1.evil.example/` are
**accepted by the transport as loopback plain HTTP and refused by the configuration**.
The stricter rule runs first and the only production construction site is
`commands/cli.ts:210`, immediately after `parseClientConfig`, so this is not reachable through
the CLI today — but it is a real disagreement about what a relay URL is, in the direction that
would admit plaintext HTTP to an attacker-chosen host. Recorded as **T10R3-F-003 (minor)**.

---

## 6. AC4 — TLS, on loopback

Real relay binary, two self-signed pairs I generated (`alpha`, `bravo`). Every
misconfiguration was checked by starting the process, waiting for it to exit, and then
attempting a **TCP connect to the configured port**, so "nothing listening" is measured.

| configuration | relay exit | port open afterwards |
|---|---:|---|
| cert only | **1** | **no** |
| key only | **1** | **no** |
| cert path missing | **1** | **no** |
| key path missing | **1** | **no** |
| cert is not a certificate | **1** | **no** |
| key is not a key | **1** | **no** |
| mismatched pair | **1** | **no** |
| cert file empty | **1** | **no** |
| cert path is a directory | **1** | **no** |
| `ECHOLET_TLS_RELOAD_INTERVAL_SECONDS=-1` | **1** | **no** |

**Ten misconfiguration paths, ten non-zero exits, nothing listening in any of them.**

| behaviour | measured |
|---|---|
| neither variable set | plain HTTP `/health` → `200`; a TLS handshake to that port fails (`ERR_SSL_WRONG_VERSION_NUMBER`) |
| both set | HTTPS serves `CN=alpha.echolet.test`; an HTTPS request with default verification fails `DEPTH_ZERO_SELF_SIGNED_CERT`, so the certificate really is validated |
| plain HTTP to the TLS port | Go's fixed **400**; no API response is served over plain text |
| reload: cert rewritten with **identical bytes**, new mtime | fingerprint **unchanged** — detection is by content, not mtime |
| reload: cert truncated to empty **while serving** | handshake still succeeds and serves the **last known-good** certificate (identical fingerprint) |
| reload: completed renewal to the `bravo` pair | new certificate served (`CN=bravo.echolet.test`), fingerprint changed, **no restart** |

**TLS cannot silently downgrade.**

**The "from a different machine" half of AC4 is NOT established and I do not claim it.**
Everything I ran is loopback; the dispatch forbids touching `geekom` and `depr` and forbids
opening a non-loopback listener, and a loopback measurement cannot show that a client on
another host completes the scenario over the network. That half belongs to T11. AC4 is
therefore **partial**, and the reason is a scope constraint, not a defect.

---

## 7. AC5 / AC6 — the operator console

### 7.1 The pure layer

`renderFrame` driven over **1 008 frames**: 6 state shapes (the five panes plus a trust
modal) × 14 column values `{1, 2, 10, 40, 61, 62, 71, 72, 80, 120, 200, 0, −5, 79.7}` × 12 row
values `{1, 2, 3, 5, 13, 14, 16, 24, 60, 0, −3, 16.9}`.

| property | result |
|---|---:|
| threw | **0** |
| not exactly `max(1,⌊rows⌋)` lines of `max(1,⌊cols⌋)` code points | **0** |
| contained an ESC byte | **0** |
| differed between two calls with identical arguments | **0** |
| **AC6 notice absent or corrupted on row 0** | **0** |

The notice is 62 code points. On the **504** frames at least 62 columns wide it is present in
full, including every modal frame; on the **504** narrower frames row 0 is exactly the
notice's prefix — never absent, never replaced. The live shell clamps its viewport to
`MIN_VIEWPORT = 72 × 16`, so a real terminal always gets it in full.

`buildArgv`: 8 frozen commands, all 8 built, **0 tokens containing a planted secret**, a ninth
command refused at runtime, `--store-key-env` carrying a variable **name**, and no argv
carrying `--yes`.

Trust gate: confirm on an unpainted modal → **no effect**; confirm on a painted, complete
modal → **confirms**; one identifier absent → **no effect**; one identifier empty → **no
effect**; `Ctrl-Y` → **unbound**; cancel on an incomplete modal → **always available**.

### 7.2 The live run — evidence, not assertion

The real `dist/tui.js`, against a real relay, with a real 32-byte store key in
`ECHOLET_E2E_KEY`, driven through all five panes and then `doctor`, `relay publish`, `poll`
and a `contact import` with a confirmation. Its `--cli` target was a recording wrapper that
logs the child's `process.argv` verbatim before delegating to the real `dist/cli.js`.

| check | result |
|---|---|
| frames written | **25** |
| AC6 notice occurrences in stdout | **25** — one per frame |
| store key in the console's stdout | **no** |
| store key in the console's stderr | **no** (stderr was empty) |
| store key in the relay's log | **no** |
| leak-detector control (would the predicate have seen it?) | **yes** |
| real child processes spawned | **4** — `doctor`, `relay publish`, `poll`, `contact import` |
| any child **argv token** contained the key | **no** |
| any child's **full command line** contained the key | **no** |
| every child nevertheless **inherited** the key in its environment | **yes** — so the negative result is not vacuous |
| `contact import` child argv carried `--yes` | **no** |
| identifiers on Carol's card shown before the confirming keystroke | **4 of 4** |
| console exit | **0** on `q` |

`src/tui/main.ts` passes `process.env` through wholesale and never indexes it; there is no
code path from a variable name to its value. The five panes are exactly
`["profiles", "mailbox", "history", "rejections", "health"]` — profiles, queues, history,
rejections and relay health, as AC5 requires — and every one rendered.

---

## 8. Acceptance criteria

| AC | Verdict | Evidence |
|---|---|---|
| **AC1** — the closure is chosen by a written design task naming what it closes, what it does not, and why alternatives were rejected | **MET** | `t5-flood-closure-design.md` §3 (C4-1/C4-2/C4-3 and "Why this closes the class"), §4 (R-1…R-8, each with how to measure it, written before implementation), §6 (candidates 1, 2 and 3 rejected with measured or cited reasons). Read in full by me. |
| **AC2** — the 4-identity / 49-envelope probe no longer prevents delivery; new attacker cost measured and stated; a bound reported as a bound | **MET** | §2: 4 identities / 49 max-size / 12 880 434 B / 53 requests → `[3,0]`, 17 pages, 35 requests, 12 887 594 B, **1.0006:1 paid once**; 2nd and 3rd messages 5 and 3 requests. All statuses 200. R-2 reported as a bound: 5 006 envelopes still cost 101 pages and 7 poll invocations for the first walk. |
| **AC3** — legitimate exchange, offline delivery, byte-identical exact retry and deduplication still pass; no pre-existing test weakened, skipped or deleted | **MET** | §1: `two-process.test.ts` 3/3 unfiltered (offline delivery, restart, byte-identical exact retry, ack recovery); `test/e2e` 24/24; 278/278 workspace tests; Go untagged + `-race` + `-race -tags=relayv2` all exit 0 with no data race. §1.1: T14 touches no test file; one pre-existing test changed across the whole flow and it was **strengthened**; zero skips or focuses. |
| **AC4** — a relay on a non-loopback address serves HTTPS, and the CLI completes the full scenario against it from a different machine | **PARTIAL** | §6: HTTPS serving, ten misconfiguration refusals with nothing listening, content-addressed reload, last-known-good mid-rewrite, renewal without restart, plain HTTP refused on the TLS port, all measured by me; `relay-tls.test.ts` 3/3. **The "different machine" half cannot be established from loopback** and the dispatch forbids touching `geekom`/`depr` or opening a non-loopback listener. That half is T11's. |
| **AC5** — the console drives a local CLI, shows profiles, queues, history, rejections and relay health, and never receives, stores or transmits key material, **by evidence** | **MET** | §7.2: a real key in the environment, 25 real frames, 4 real child processes captured at OS argv level, key absent from stdout, stderr, every argv and every full command line while present in every child's environment, with a working leak-detector control. All five panes render. |
| **AC6** — the console displays, on its own surface, that this is an unaudited prototype not suitable for sensitive communication | **MET** | §7.1/§7.2: present on all 504 probe frames wide enough to hold it and a correct prefix on the other 504; row 0 is never yielded to the modal; 25 occurrences in 25 live frames. |
| **T10-F-001 is closed** (reproduce 5 identities / 55 max-size, show delivery, then push past it and state the first losing configuration) | **MET, with a stated residual** | §3.1: the exact shape delivers on the 2nd post-import poll at unchanged attacker cost; 166 and 5 006 envelope floods also deliver, at `ceil(pages/16)` invocations. §3.2: the first configuration at which a message is still lost is **an interrupted recovery poll** — SIGKILL **and SIGINT** both destroy the re-walk and lose the message silently; a relay outage does not. Recorded as T10R3-F-001 (major). |
| **T10-F-002 is closed** on every route that reads `read_through`, with the ack-route residual stated as a bound | **MET, with a stated residual** | §4: one answer for every `read_through` value on the poll route and on the ack route for an unknown device; the ack route still answers a card-holder (recovered 66 in 13 requests) and T14 §5.1 states it as a bound rather than claiming it closed. Qualification recorded as T10R3-F-002. |
| **T10-F-003 is closed**: `init` refuses a path or query with exit 2, and CLI and RelayClient agree | **PARTIAL** | §5: path/query/fragment all refused **exit 2 `INVALID_CONFIGURATION`** with nothing written. But over 24 URLs the two components still disagree on 2: `RelayClient`'s `/^127\./` hostname test admits `127.evil.example` and `127.0.0.1.evil.example` as loopback plain HTTP where `parseClientConfig` refuses them. Unreachable through the CLI today; recorded as T10R3-F-003. |
| **The full matrix is re-run on this tree** | **MET** | §1. |
| **AC7 / AC8** | **OUT OF SCOPE for T10** | Deployment is T11 and I was instructed not to touch the remote hosts. AC8's residual list must now carry T10R3-F-001 (the interrupted re-walk), T10R3-F-002 (the ack-route count oracle for a card-holder), the ≈2:1 recovery cost of an import against a flooded mailbox, and T5-F-002's unenforced `ECHOLET_MAX_STORAGE_BYTES`. |

### 8.1 What this verdict is and is not

The three findings the previous attempt raised are addressed, and the one that mattered —
permanent message loss for the cost of a 55-envelope flood, with no operator error involved —
is genuinely gone. I attacked the rewritten path at three depths and could not make the
re-walk fail to progress; it advances strictly forward, survives a relay outage and a rate
limit, and terminates.

It is not a clean bill. **A message can still be lost permanently, silently, and with no
warning to the operator, if the recovery poll is interrupted** — and Ctrl-C is the ordinary
way an operator interrupts a poll that is walking thousands of pages, a walk whose length the
attacker chooses. The loss is recoverable, but only by an operator who guesses that a second
`contact import` is needed. The natural fix is small and in the same file as the one T14 just
changed: write the re-walk position **per fully judged page** rather than once at the end of
the walk (the same rule `read_through` already follows, and for the same reason), or install a
signal handler that flushes it. The RED-4 argument T14 gives for not doing so is about the
relay-held mark being resumed cursorlessly after a kill, which a durable local re-walk
position does not contradict: a re-walk that resumes strictly forward cannot reinstate the
flooding class, and T14's own §1.2 argues exactly that.

---

## 9. Integrity

- No source, test, documentation or flow file was modified. The only writes are this report,
  the dispatch result beside it, scratch files outside the repository, and the artefacts
  `keryx ctx` writes into `.metaproject/data/gdctx/` by design.
- SHA-256 manifest of 242 files re-verified after all work: **242 OK, 0 mismatches**.
  Integrity by digest, never by mtime.
- No `git commit`, no `git push`, no change to `flow.json` or `acceptance-criteria.md`.
- `geekom` and `depr` were not contacted. No non-loopback listener was opened: every relay,
  proxy and reserved socket bound `127.0.0.1` only.
- No test was weakened, skipped, deleted or filtered to obtain any result above.
- No plaintext, ciphertext, store key, profile key, private key material, signing seed, TLS
  private key or HTTP request body was printed or logged by any probe.

## 10. Routing audit

- `graph_used`: **not-relevant** — the dispatch named its own files, lines and call sites;
  every navigation question was answered by `keryx ctx rg` against those files, and no
  blast-radius question arose that the compiler and the suites did not answer.
- `wiki_used`: **partial** — the authoritative documents for this task were the T5 design §4,
  the T10 attempt-2 report and the T14 implementation report, all read in full as the
  dispatch required.
- `ctx_used`: **yes** — `keryx ctx rg` for every code search, `keryx ctx run` for every
  build, test, git and probe command, `keryx ctx read` for compact reads; long logs were
  written outside the repository and summarised.
- `raw_rg_used`: **no**.
