# T10 — Independent verification: flood closure, TLS, operator TUI

Flow: `002-2026-09-07-echolet-close-the-flood-class-operator-c`
Dispatch: `002-T10-verify` · Date: 2026-09-07
Runtime: **Node v26.5.0** (`/opt/homebrew/bin/node`) · Go 1.26.1 · darwin/arm64 · pnpm 12.x

I wrote none of this code. Every number below is one I measured myself, against a
relay binary I built from this tree (`sha256 a72b66c4…`) and the real
`apps/cli/dist/cli.js` I rebuilt (`sha256 f2f335e2…`). Where a number differs from
the T7 report the difference is stated.

**Probe discipline.** All probes live outside the repository, under the session
scratchpad (`probe-lib.mjs`, `probe-flood.mjs`, `probe-attack.mjs`,
`probe-attack2.mjs`, `probe-rewalk.mjs`, `probe-resume.mjs`). They use an
independent ed25519 implementation (`node:crypto`), not the project's own signing
helpers, so a transcript agreement is evidence rather than a tautology. They print
labels, counters, byte totals, HTTP statuses, exit codes and booleans only — never a
body, ciphertext, plaintext, key, seed or signature. **No file inside the repository
was modified**: a SHA-256 manifest of 236 tracked source/doc files was taken before
any work (`baseline-manifest.txt`, `sha256 d534fc93…`) and re-verified at the end
(§7).

**Declared configuration deviation.** Except where stated otherwise, probes run the
relay with `ECHOLET_RATE_LIMIT_PER_MINUTE=1000000`, the same single deviation
T49/T52/T55 and `flood-closure.test.ts` declare, so the per-IP limiter does not
confound a count-of-envelopes measurement.

---

## 1. The flooding closure, re-measured

### 1.1 Delivery behind a flood — all three volumes

Construction in every row: N maximum- or minimum-size poison envelopes are stored
first, spread across as many freshly self-published identities as the 16/sender quota
forces; then Alice (an already-pinned contact) sends one message; then Bob polls in
fresh processes until a poll does not exit 3.

| volume | identities | poison stored | attacker upload | attacker requests | poll exit codes | delivered | pages | requests | bytes down | amplification |
|---|---:|---:|---:|---:|---|---|---:|---:|---:|---:|
| 49 × 262 144 B | 4 | 49 | 12 880 434 B | 53 | **`[3,0]`** | **yes** | 18 | 37 | 13 676 311 B | **1.062:1** |
| 800 × 4 B | 50 | 800 | 576 800 B | 850 | **`[3,0]`** | **yes** | 18 | 37 | 610 572 B | **1.059:1** |
| 8000 × 4 B | 500 | 8000 | 5 768 000 B | 8 500 | **`[3,3,3,3,3,3,3,3,3,3,0]`** | **yes** | 171 | 343 | 6 067 467 B | **1.052:1** |

Every HTTP status observed across all three runs was `200`. History held exactly one
message after the first delivery in each case; nothing was duplicated or lost.

### 1.2 The second and third message into a still-poisoned mailbox

| volume | 2nd message | 3rd message |
|---|---|---|
| 4/49 max-size | 1 poll, 1 page, **3 requests**, 267 122 B (**0.021:1**) | identical: 1 poll, 1 page, 3 requests, 267 122 B |
| 50/800 | 1 poll, 1 page, **3 requests**, 4 268 B (0.0074:1) | identical |
| 500/8000 | 1 poll, 1 page, **3 requests**, 4 268 B (0.0007:1) | identical |

**The steady state is O(1) and it is stable, not a one-off.** The poison is still
sitting at the head of the mailbox in every case. This is the measurement that a
larger constant page cap cannot produce, and it is the strongest single piece of
evidence that the durable mark is real.

### 1.3 Progress survives an interrupted poll

800 minimum-size poison, one legitimate message behind it. A `poll` process was
`SIGKILL`ed once the relay had served four poll pages, then a **new process** polled
with no cursor.

| measurement | value |
|---|---|
| pages the killed process received | 4 |
| highest poison index it had judged | 100 |
| resuming poll was cursorless | **true** |
| first envelope the resuming poll was offered | poison index **150** |
| restarted at the head of the mailbox | **false** |
| resumed strictly after what was already judged | **true** |
| resumed poll exit codes | `[0]` — delivered |
| **total poll pages across every poll** | **18**, for 801 envelopes = 17 pages of real work |

O(N), not O(N·K). No fixture can produce this: it is an assertion about relay state
surviving a process kill.

### 1.4 Verdict on the closure claim

**Confirmed.** I found **no wedge threshold** at 4/49, 50/800 or 500/8000, the
amplification is ~1.05–1.06:1 paid once instead of unbounded per poll, the second
delivery is O(1), and progress is monotone across a `SIGKILL`. The T7 report's
headline numbers reproduce to within rounding (their 13 676 370 B vs my 13 676 311 B —
a 59-byte difference from a differently-sized message body; their 37 requests, 18
pages and `[3,0]` reproduce exactly).

---

## 2. Attacking the closure

### 2.1 What held

| attack | result |
|---|---|
| **Sender-chosen `envelope_id` ordering.** Legitimate envelope stored first, then five poison envelopes with `00000000-0000-1000-8000-…` ids that sort ahead of every random v4 UUID | **Held.** The first poll page's head is the legitimate envelope. Selection is the relay's store order (T5-F-001 closed) |
| **Late flood jumping the queue.** After the mark reached the end, a random-id envelope and then a head-sorting-id envelope were stored | **Held.** Both land behind the mark; neither is served at the head |
| **`read_through` above every issued position** (`99999` against a highest of 66) | **Refused** `400 INVALID_SCHEMA`, before authorisation |
| **`read_through` in the body, signature over the v1 transcript** | **Refused** `403 INVALID_SIGNATURE` |
| **`read_through` absent from the body, signature over v2** | **Refused** `403 INVALID_SIGNATURE` |
| **`read_through: "20"` in the body, signature over v2 with `60`** | **Refused** `403 INVALID_SIGNATURE` |
| **`read_through` signed by a different device's key** | **Refused** `403 INVALID_SIGNATURE` |
| **`read_through` presented under a different device_id** | **Refused** `403 UNAUTHORIZED_MAILBOX_ACCESS` |
| **Same forgery matrix on `/v1/mailbox/ack`** (body v2, signature v1) | **Refused** `403 INVALID_SIGNATURE`; correctly-signed ack v2 accepted `200` |
| **Malformed positions**: `""`, `-1`, `+5`, `" 5"`, `1e3`, `0x10`, `5.0`, 16 digits | **All refused** `400 INVALID_SCHEMA`. `"0000000000005"` is accepted as position 5 — a different signed statement for the same position, not malleability |
| **`read_through: null`** | Treated as absent, signs v1, cannot move the mark. Correct |
| **Rewind.** Mark pushed to 60, then `read_through: "1"` presented and signed correctly | **Ignored.** The next cursorless poll returned the same first envelope as before the attempt; `AdvanceReadMark` is forward-only |
| **Verbatim replay of a whole signed poll request** carrying `read_through` | **Refused** `400 CHALLENGE_EXPIRED` — challenges are single-use |
| **The never-marked final page** (the residual the implementer disclosed) | **Bounded at one page.** Steady-state re-read cost measured at exactly 1 page / 3 requests per poll in every volume |

### 2.2 T10-F-001 (major) — the `contact import` recovery path is itself wedged by the same flood

**The design's residual R-5, which T7 §6 reports as "Mitigated by §4", is not
mitigated once the flood exceeds the 16-page valve. I wedged it. It costs the
attacker the same order as the wedge this flow set out to close.**

`contact import` records a local re-walk request; the next `poll` consumes it exactly
once and re-walks with `cursor: "0"` (`inbound.ts:135`). **That re-walk is still
bounded by `maxPollPagesPerPoll = 16` (`inbound.ts:148`), and the request is consumed
whether or not the walk finished.** Every later poll is cursorless and resumes at the
durable mark, which is already past the untrusted envelope. So the recovery path only
reaches an envelope that lies inside the first 16 pages.

At the shipped defaults — poll byte budget `(1<<20)−4096`, `ECHOLET_MAX_MESSAGE_BYTES`
262 144 → **3 maximum-size envelopes per page** — 16 pages is **48 envelopes**.

Measured, on the real relay binary, with a real third CLI profile (Carol) whose card
Bob imports only after her envelope is already queued:

| run | poison ahead of Carol | pages ahead | poison behind | polls after import | Carol delivered |
|---|---:|---:|---:|---|---|
| **attack** | **49** (4 identities) | 17 | 6 (1 identity) | `[3,3,3,3,3,3]`, then 6 more polls | **NO — `history = 0`, permanently** |
| control | 30 (2 identities) | 10 | 6 | `[0]` on the first post-import poll | yes — `history = 1` |

The control isolates the cause: the only difference is whether the untrusted envelope
sits inside or outside the 16-page valve. In the attack run the post-import poll
served **16 cursored pages** (the truncated re-walk) followed by 5 cursorless pages
resuming at the mark, and twelve further poll invocations never re-offered the
envelope. Carol's message is lost until it expires.

**Exact attacker cost:** 5 self-published identities, 55 maximum-size envelopes,
**14 457 630 B uploaded, 60 HTTP requests, paid once.** That is *cheaper in identities
and comparable in bytes* to the 4-identity / 49-envelope flood T55 recorded as the
original wedge. Poison behind the envelope is needed only so the target is not in the
never-marked final page; 6 envelopes suffice.

**Why the existing suite does not catch it.** `flood-closure.test.ts` RED-6 uses 40
poison envelopes at `ciphertext: 4` — roughly one page — so it exercises the reset
flag but never the truncation. The design (§4 R-5) and T7 §6 both name this residual
as "a peer trusted through some other path, or a card imported on a different device";
**neither names the volume-dependent failure of the supported path**, which is the one
I measured.

**Class judgement.** The flooding class is closed for the *delivery* case AC2 asks
about. It is **not** closed for the *recovery* case the design itself introduced as
the mitigation for the behaviour change the mark caused. Before the mark, a
`CONTACT_NOT_TRUSTED` envelope was re-offered on every poll and a late import always
recovered it; after the mark, a 55-envelope flood makes late import fail silently.
This is a **regression introduced by this change**, not a pre-existing residual.

### 2.3 T10-F-002 (minor) — unauthenticated oracle for a mailbox's lifetime envelope count

`resolveReadThrough` is applied *before* challenge validation and *before*
`authorizeMailboxDevice` (`mailbox_handler.go:466`, deliberately, so malformed input
never depends on who is asking). It calls `HighestIssuedPosition(mailboxID)` and
answers `400 INVALID_SCHEMA` when the value is above it, versus `400 CHALLENGE_EXPIRED`
when it is not.

Measured: with a fabricated `challenge_id`, a fabricated `device_id` and the literal
signature `"AAAA"`, I binary-searched the boundary in ~20 requests and recovered
`highestIssuedPosition = 66` against a mailbox that had in fact been allocated exactly
66 positions. `mailbox_id` is `sha256(identity_id + ":mailbox:v1")` and `identity_id`
is on every contact card, so this is computable by anyone who has ever seen the
victim's card.

This is new metadata the relay did not previously disclose to third parties: it is the
victim's lifetime received-envelope count, not "observed traffic" of the asking party.
`SEC-01 §6.2` confines what the relay exposes; **AC8's residual list should record it**,
and the cheap fix is to move the `HighestIssuedPosition` bound after signature
verification while keeping the pure shape check before it.

### 2.4 Observation (out of class, appears pre-existing) — prekey-bundle exhaustion

In the T10-F-001 runs, after Carol established a session with Bob, Alice's *first*
send to Bob failed with exit 3 `PREKEY_BUNDLE_UNAVAILABLE` and never recovered without
Bob re-running `relay publish`. One sender consuming a bundle appears to deny first
contact to every other sender. This is unrelated to T7/T8/T9 and is recorded only so it
is not lost; it was not investigated further and is not counted against any AC.

---

## 3. TLS — can it silently downgrade?

Probe: `probe-tls.mjs`, driving the real relay binary with certificate pairs I
generated myself (`openssl req -x509`, two distinct self-signed pairs "alpha" and
"bravo"). Every misconfiguration path was checked by starting the process, waiting
for it to exit, and then attempting a **TCP connect to the configured port** — so
"nothing listening" is measured, not inferred from a log line.

| configuration | relay exit | TCP port open afterwards |
|---|---:|---|
| cert only | **1** | **no** |
| key only | **1** | **no** |
| cert path does not exist | **1** | **no** |
| key path does not exist | **1** | **no** |
| cert file is not a certificate | **1** | **no** |
| key file is not a key | **1** | **no** |
| cert and key from different pairs (mismatched) | **1** | **no** |
| cert file empty | **1** | **no** |
| cert path is a directory | **1** | **no** |
| `ECHOLET_TLS_RELOAD_INTERVAL_SECONDS=-1` | **1** | **no** |

**Ten misconfiguration paths, ten non-zero exits, nothing listening in any of them.
No path serves plain HTTP with TLS half configured.**

| behaviour | measured |
|---|---|
| neither variable set | plain HTTP `/health` -> `200`; a TLS handshake to that port fails (`ERR_SSL_WRONG_VERSION_NUMBER`) |
| both set | HTTPS serves the configured certificate (`CN=alpha.echolet.test`); an HTTPS request with default verification correctly fails on the self-signed chain (`DEPTH_ZERO_SELF_SIGNED_CERT`), i.e. the certificate is really being validated |
| plain HTTP to the TLS port | Go's fixed `400` refusal. **No API response is served over plain text** |

**Reload (`ECHOLET_TLS_RELOAD_INTERVAL_SECONDS=0`):**

| property | measured |
|---|---|
| rewriting the cert file with **identical bytes** (new mtime) | fingerprint **unchanged** — detection is by content, not mtime, as claimed |
| **mid-rewrite** (cert file truncated to empty while serving) | handshake **still succeeded**, and served the **last known-good** certificate (identical fingerprint) |
| completed renewal to a different pair | new certificate served (`CN=bravo.echolet.test`), fingerprint changed, **no restart** |

**CLI refusal of plain HTTP to a non-loopback host** — thirteen real `echolet init`
invocations against the built `dist/cli.js`:

- refused, exit 2 `INVALID_CONFIGURATION`: `http://relay.example.com/`,
  `http://192.168.1.10:8081/`, `http://0.0.0.0:8081/`,
  `http://localhost.evil.example/`, `http://127.evil.example/`,
  `http://127.0.0.1.evil.example/`, `http://user:pw@127.0.0.1:8081/`
- accepted: `http://127.0.0.1:8081/`, `http://127.1:8081/`, `http://[::1]:8081/`,
  `http://localhost:8081/`, `https://relay.example.com/`

I specifically probed the prefix hole a naive `/^127\./` hostname test would open
(`127.evil.example`, `127.0.0.1.evil.example`) — **both are refused.** The exchange
over a non-loopback address is possible only over TLS.

**T10-F-003 (minor) — `init` accepts a relay URL every later command rejects, and
reports it as a persistence failure.** `init --relay-url https://relay.example.com/path`
exits 0; `relay publish` on that profile then exits **5 `PERSISTENCE_FAILURE`**.
`relayClient.ts` refuses a URL whose `pathname !== "/"`, but `init` does not apply
that rule, so the profile is written and the mismatch surfaces later under a code
that points the operator at their disk instead of at their configuration. Not a
downgrade (HTTPS only), but it is exactly the class of failure the TLS design argues
elsewhere must be loud and unmissable.

**Verdict: TLS cannot silently downgrade.**

*Footnote, no finding:* the reload digest is `sha256(certPEM || keyPEM)` with no
separator, so two file pairs that shifted bytes across the boundary would collide.
Both halves must still parse as a matching pair, so this is not exploitable; noted
only because it is a one-line fix if that digest is ever reused for anything else.

---

## 4. The operator TUI

Two probes: `probe-tui.mjs` (the pure layer, driven through an out-of-repo esbuild
bundle of the real modules) and `probe-tui-e2e.mjs` (the **real** `dist/tui.js`
process against a **real** relay with a **real** 32-byte store key in its
environment).

### 4.1 `renderFrame` — total, deterministic, ESC-free, exactly rows x cols

**1 008 frames** rendered across 168 viewports (cols in {1, 2, 10, 40, 61, 62, 71,
72, 80, 120, 200, 0, -5, 79.7} x rows in {1, 2, 3, 5, 13, 14, 16, 24, 60, 0, -3,
16.9}) and all six state shapes (five panes plus a modal frame):

| property | result |
|---|---|
| threw | **0** |
| wrong shape (not exactly `max(1,floor(rows))` lines of exactly `max(1,floor(cols))` code points) | **0** |
| contained an ESC byte | **0** |
| differed between two calls with identical arguments | **0** |

### 4.2 AC6 notice

`UNAUDITED PROTOTYPE — not suitable for sensitive communication` is 62 code points.
It was present, in full, on **every one of the 1 008 frames whose width could hold
it**, including every modal frame. Below 62 columns row 0 is a **prefix** of the
notice, never absent and never replaced — verified at 1, 10, 40 and 60 columns.

In the live run the console wrote **29 frames** and the notice appears **29 times**
in its stdout, including the frames carrying the trust modal.

### 4.3 Trust modal

| gate | result |
|---|---|
| confirm while `renderedAt === null` (frame not yet painted) | **refused** — no effect, modal stays open |
| confirm after the frame was painted | confirms |
| one identifier empty | **refused** |
| one identifier absent | **refused** |
| `Ctrl-Y` | **not a confirmation** |
| cancel on an incomplete modal | always available (a malformed card is not a dead end) |

All four identifiers are rendered **in full** (43-column base64url values, not
elided) at 72, 80, 100, 120 and 200 columns, each on its own line, with its label.
In the live run against a real contact card, **4 of the 4 identifiers on the card
appeared in the console's output before the confirming keystroke was sent.**

### 4.4 Key material — measured, not asserted

Live run: a fresh 32-byte store key was placed in `ECHOLET_E2E_KEY` and the console
was driven through all five panes, `doctor`, `relay publish`, `poll` and a
`contact import` with a confirmation.

| check | result |
|---|---|
| store key in the console's stdout (29 frames) | **no** |
| store key in the console's stderr | **no** |
| leak-detector control (would it have seen the key?) | **yes** — the same predicate finds a deliberately appended key |
| real child processes spawned | **4** — `doctor`, `relay publish`, `poll`, `contact import` |
| any child **argv token** contained the key | **no** |
| any child's **full command line** contained the key | **no** |
| every child nevertheless **inherited** the key in its environment | **yes** — so the negative result is meaningful, not vacuous |
| `contact import` child argv carried `--yes` | **no** — the CLI's own prompt still guards the decision |

The argv was captured at OS level by interposing a recording wrapper as the
console's `--cli` target, which logs `process.argv` verbatim before delegating to
the real CLI. Statically, `buildArgv` was exercised for all eight frozen commands:
no token contains any planted secret, `--store-key-env` carries a variable **name**,
and a ninth command is refused at runtime as well as in the type system.

*One methodological note:* a first pass of my pure probe reported 59 "leaks". That
was my own construction — I had planted the secret markers **into** state fields
that legitimately hold public identifiers (`identityId`, activity text), and the
console faithfully rendered them. The claim under test is that the console never
obtains the key, and the live run above is the measurement that actually tests it.

---

## 5. The verification matrix

Node **v26.5.0** (`/opt/homebrew/bin/node`) throughout. Node 22.12 was not used.

| check | command | result |
|---|---|---|
| frozen install | `pnpm install --frozen-lockfile` | **exit 0** |
| CLI build | `node apps/cli/build.mjs` | **exit 0** — `dist/cli.js` `sha256 f2f335e2...`, `dist/tui.js` built |
| relay build | `go build ./cmd/relay` | **exit 0** — `sha256 a72b66c4...` |
| workspace typecheck | `pnpm -r typecheck` | **exit 0**, 7 projects |
| workspace tests, run 1 | `pnpm -r test` | **exit 0** — 47 files, **267 tests** |
| workspace tests, run 2 | `pnpm -r test` | **exit 0** — 47 files, **267 tests** |
| workspace tests, run 3 **under 10-core saturation** | `pnpm -r test` with 10 busy-loop processes | **exit 0** — 47 files, **267 tests** |
| three-iteration real E2E, **unfiltered** | `vitest run test/e2e/two-process.test.ts --reporter=verbose` | **3/3 pass** (14.3 s / 9.9 s / 9.4 s) |
| full E2E directory, verbose | `vitest run test/e2e --reporter=verbose` | **13/13 pass** across 4 files, 107.75 s |
| Go, untagged | `go -C apps/relay test ./...` | **exit 0**, 16 packages |
| Go vet | `go -C apps/relay vet ./...` | **exit 0** |
| Go race | `go -C apps/relay test -race -count=1 ./...` | **exit 0**, 16 packages, no data race |
| Go race, relayv2, **uncached** | `go -C apps/relay test -race -count=1 -tags=relayv2 ./...` | **exit 0**, 16 packages, no data race |
| `keryx test run --strict` | | **PASS** |
| `keryx health run --strict` | | **PASS**, score 95, trend stable, 10 findings, no gate condition triggered |
| graph rebuild | `keryx gdgraph build` | **exit 0** — 112 nodes, 186 edges |
| graph cycles | `keryx gdgraph query cycles` | **No cycles found** |
| wiki link check | `keryx wiki check-links` | 19 pages, 38 internal links, **0 broken** |

### 5.1 Reconciling the test count against the orchestrator's 267

**No difference to account for.** Every one of my three runs produced exactly
**267**, identical in every package:

| package | files | tests |
|---|---:|---:|
| `packages/protocol` | 3 | 12 |
| `packages/client-db` | 1 | 1 |
| `packages/crypto-core` | 4 | 20 |
| `packages/client-core` | 2 | 2 |
| `packages/session-node` | 3 | 24 |
| `apps/mobile` | 1 | 6 |
| `apps/cli` | 33 | **202** |
| **total** | **47** | **267** |

`apps/cli`'s 202 include the 13 real-binary E2E cases, so the flood suite ran three
times inside the three workspace runs plus twice standalone — five executions, all
green. T7 section 8 recorded `test/e2e` as 10/10; it is now 13/13, the three
additions being T8's `relay-tls.test.ts`. That is the only count difference anywhere
in the flow's records and it is fully explained by T8 landing after T7 wrote its
report.

### 5.2 Test-suite integrity (AC3)

- `git diff e9f0da7..c36d5c9 -- '*test*'`: **15 test files added, exactly one
  pre-existing test file modified** — `mailbox_sender_quota_test.go`.
- That modification is the **inversion T54's own instruction demanded**:
  `TestKnownResidueDistinctIdentitiesStillWedgeTheDrainWalk` became a parameterised
  closure assertion that now *fails* if the wedge returns, plus a `t.Logf` of the
  measured page counts so a regression surfaces as a number. **Strengthened, not
  weakened.**
- A repository-wide scan for `it.skip`, `test.skip`, `describe.skip`, `.todo(`,
  `t.Skip(`, `it.only`, `describe.only` across `apps/` and `packages/` returns
  **zero** matches. Nothing is skipped, focused or deleted.
- T8's TLS work is still **uncommitted** in the working tree (7 modified, 10
  untracked paths). It adds `relay-tls.test.ts` and `tls_config_test.go` and modifies
  no existing test. Everything I measured was measured against this working tree.

---

## 6. Acceptance criteria

| AC | Verdict | Evidence |
|---|---|---|
| **AC1** — closure chosen by a written design task naming what it closes, what it does not, and why alternatives were rejected | **MET** | `t5-flood-closure-design.md` section 3 (what it closes, in three coupled parts), section 4 (R-1...R-8, each with how to measure it, written *before* implementation), section 6 (candidates 1, 2 and 3 rejected with reasons — section 2's walk-cost arithmetic refutes the orchestrator's own prior, and candidate 3 is rejected against a cited `SEC-01` section 2 / 5.1 / 6.2 conflict). |
| **AC2** — the 4-identity / 49-envelope probe no longer prevents delivery; new attacker cost measured and stated; a bound reported as a bound | **MET** | Sections 1.1-1.3, all measured by me against the real binary. `[3,0]`, delivered on the 2nd poll, 37 requests, **1.062:1 amplification paid once**, second and third deliveries **3 requests each**. No wedge threshold at 4/49, 50/800 or 500/8000. R-2 is reported as a bound and is real: the 8000-envelope case needed **11 poll invocations, 171 pages and 343 requests**. |
| **AC3** — legitimate exchange, offline delivery, byte-identical exact retry and deduplication still pass; no pre-existing test weakened, skipped or deleted | **MET** | Three-iteration two-process E2E **3/3** unfiltered (offline delivery, restart, byte-identical exact retry, ack recovery); 13/13 E2E; 267/267 workspace tests three times including under load; Go untagged + `-race` + `-race -tags=relayv2` all green. Section 5.2: one pre-existing test modified and it was *strengthened*; zero skips anywhere. |
| **AC4** — a relay on a non-loopback address serves HTTPS, and the CLI completes the full scenario against it from a different machine | **PARTIALLY MET** | Section 3: HTTPS serving, ten misconfiguration refusals with nothing listening, content-based reload and last-known-good mid-rewrite all confirmed by me, and `relay-tls.test.ts > serves HTTPS and completes a full two-party exchange with the real CLI` passes. **The "different machine" half is unverified**: everything I ran is loopback, and by instruction I did not touch `geekom` or `depr`. That half is T11's. T10-F-003 is a minor operator-facing defect on this path. |
| **AC5** — the console drives a local CLI, shows profiles, queues, history, rejections and relay health, and never receives, stores or transmits a store key or private key material, **demonstrated by evidence** | **MET** | Section 4.4: a real key in the environment, 29 real frames, 4 real child processes, key absent from stdout, stderr and every argv while present in every child's environment, with a working leak-detector control. All five panes render; the console drives only the frozen eight-command CLI, as a child process. |
| **AC6** — the console displays, on its own surface, that this is an unaudited prototype not suitable for sensitive communication | **MET** | Section 4.2: present on all 1 008 probe frames wide enough to hold it and on all 29 live frames, including modal frames; row 0 is never yielded to the modal; below 62 columns it degrades to a prefix, never to absence. |
| **AC7** — two relay instances on the user's servers + runbook | **OUT OF SCOPE for T10.** Deployment is T11 and I was instructed not to touch `geekom` or `depr`. I make no judgement rather than guessing. |
| **AC8** — documentation states what remains untrue | **OUT OF SCOPE for T10**, with one input: **T10-F-001 and T10-F-002 are new items AC8's residual list must carry**, alongside T5-F-002's unenforced `ECHOLET_MAX_STORAGE_BYTES`. |

### 6.1 What this verdict is and is not

The flooding class **is** closed for delivery, at the volumes AC2 names and well
beyond them, and I could not reopen it: not through sender-chosen ordering, not
through a forged, replayed, malformed or rewound read position, not through a late
flood, not through an interrupted walk, and not through the never-marked final page.
That is a genuinely different result from the three previous mitigations in this
project, and it is the counters — 1.06:1 once, then 3 requests forever — that make
it different, not the exit code.

It is **not** a clean bill. **T10-F-001 is a regression this change introduced.** The
recovery path the design added to compensate for the durable mark is itself defeated
by a flood of the same order as the original wedge, and the test written to pin that
path uses a flood one seventeenth as large. The pattern this flow set out to break —
a mitigation moves a number, the class survives one layer over, and it is found
afterwards rather than upfront — recurred here. It is cheap to fix (consume the
re-walk request only when the re-walk actually completed, or hold a durable re-walk
floor the mark may not pass until the walk finishes) and it should be fixed **before
T11**, because after deployment a lost message is a lost message.

---

## 7. Integrity

- **No file inside the repository was modified by this verification** except this
  report and the dispatch result under `.metaproject/flows/002-.../`, plus the
  generated artefacts `keryx gdgraph build`, `keryx test run` and `keryx health run`
  write into `.metaproject/data/` by design.
- A SHA-256 manifest of **236** source and documentation files under `apps/`,
  `packages/` and `docs/` was taken before any work and **re-verified byte for byte
  afterwards: 236 of 236 OK**. Manifest digest
  `d534fc93520a102783a75f728d0a0f099662501657c0193d8c57924f5598ce00`. Integrity was
  established by digest, never by mtime.
- All probes live outside the repository. They printed labels, counters, byte totals,
  HTTP statuses, exit codes, certificate fingerprints and booleans only. **No
  plaintext body, ciphertext, store key, private key material, signing seed, TLS
  private key or HTTP request body was printed or logged.**
- No `git commit`, no `git push`, no change to `flow.json` or
  `acceptance-criteria.md`. `geekom` and `depr` were not contacted; `tailscale cert`
  was not run anywhere.

## 8. Routing audit

- `graph_used`: **yes** — `keryx gdgraph build` (112 nodes / 186 edges),
  `query cycles`, `query orphans`, as matrix checks rather than as navigation.
- `wiki_used`: **partial** — `keryx wiki check-links`; the authoritative documents
  for this task were the T5 design and the T7/T8/T9 reports, read in full as the
  dispatch required.
- `ctx_used`: **yes** — `keryx ctx rg` for every code search, `keryx ctx run` for git
  history and diffs, `keryx ctx read` for compact reads; long command output was
  redirected to files outside the repository and summarised.
- `raw_rg_used`: **no**.
