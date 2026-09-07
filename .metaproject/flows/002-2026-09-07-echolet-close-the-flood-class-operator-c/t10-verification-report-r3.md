# T10 (attempt 4) — independent verification of flow 002 on the post-T16 tree

**Dispatch:** `002-T10-verify-r3` · **Tree:** `c302485` "fix: the contact-import re-walk survives an interrupted poll"
**Verdict:** DONE_WITH_CONCERNS — every functional criterion in scope is met; two criteria are recorded as
partial/unsatisfiable for reasons that are properties of the record, not of the code.

Nothing here is credited from an earlier attempt or from T16's own report. Every number below was
produced on this tree by this verifier, against a relay binary built here from `c302485` and the real
`apps/cli/dist/cli.js`.

---

## 0. Measurement environment

| Item | Value |
|---|---|
| Node (default, non-login) | **v26.5.0** — used for everything |
| Node under `bash -lc` | v22.12.0 — **avoided**, per the dispatch constraint |
| pnpm / Go | 10.0.0 / go1.26.1 darwin/arm64 |
| Working tree at start and end | clean; 908 tracked files |
| SHA-256 over all tracked files, start **and** end | `9b4698bb1a99f35502a76b78ac6d5742956db25b390ea4d7bffff16d19be7fce` |
| `apps/cli/dist/cli.js` | `9f0dd98b5c2d7f7cd323171f339db8d737ebbf451246d7807cb0c6e89bc1b0f9` |

`dist/cli.js` was **rebuilt from source and reproduced byte-for-byte** — the shipped bundle genuinely
is this tree's source, so measurements against it are measurements of `c302485`.

Integrity was checked by SHA-256 only, never mtime. My only writes were the two deliverables and
scratch files under `/tmp`. One untracked build artifact (`apps/relay/relay`) was rebuilt during the
run and **restored bit-for-bit** afterwards (see finding T10R3V-F-002).

---

## 1. The headline: the crash sweep (T10R3-F-001)

### What was measured

The existing suite exercises exactly one interruption point (a held page 3) at one ciphertext size
(4 bytes). That bound is recorded as T15-F-003. I swept it with an independent harness
(`/tmp/.../sweep.mjs`) that imports nothing from the repository, re-implements the Ed25519 and
mailbox-id primitives from `node:crypto`, and drives the real CLI through a controllable proxy that
can (a) hold a request so the process is provably blocked on it, (b) deliver a response and then
signal, and (c) fire on the page that reports the end of the mailbox.

Two ciphertext regimes:

- **small** — 4-byte ciphertext, 50 envelopes/page, 200 poison ahead + message + 110 behind.
- **max** — 261 000-byte ciphertext (the relay's `ECHOLET_MAX_MESSAGE_BYTES` is 262 144, and the poll
  byte budget `(1<<20)-4096` yields **3 envelopes/page**), 51 poison ahead + message + 9 behind. At
  this size the re-walk from the head needs 18 pages and therefore **crosses the 16-page liveness
  valve** — the regime the existing suite never entered.

### Result

**32 completed configurations. Zero lost messages. There is no first configuration at which a message
is still lost.**

| Interruption point | small (SIGINT/SIGKILL) | max (SIGINT/SIGKILL) |
|---|---|---|
| inside page request, page 1 (nothing judged yet) | delivered / delivered | delivered / delivered |
| inside page request, page 3 (the T15 baseline) | delivered / delivered | delivered / delivered |
| inside page request, page 5 (the page holding the message) | delivered / delivered | — |
| inside page request, page 16 (the valve boundary) | — | delivered / delivered |
| inside `accept()`, page 4 | delivered / delivered | — |
| inside `accept()`, page holding the message | delivered / delivered | — |
| inside `accept()` of the last page the valve allows | — | delivered / delivered |
| between the last page's commits and `finishMailboxRewalk()` | delivered / delivered | delivered / delivered † |
| inside `ackPending()`, ack dropped | delivered / delivered | delivered / delivered † |
| inside `ackPending()`, ack applied upstream, response never seen | delivered / delivered | delivered / delivered † |

† measured in a max-ciphertext variant with the message within one poll's reach, because the
acknowledgement only happens once a walk has accepted something — at 51-deep the first recovery poll
exits 3 without ever acking, so the ack points are unreachable there. Acceptance at maximum ciphertext
size is covered directly by the `accept-16` row.

In every one of the 32 runs: `delivered = 1`, `finalHistory = 1` (nothing duplicated), and the
interrupting signal was confirmed as the actual cause of death (`signalCode` equals the signal sent).

Notable rows:

- **max / page-1**: the recovery needed **2 polls and 17 pages** — the durable position carried the
  walk across the valve boundary, which is the case the existing suite could not reach.
- **small / accept-5**: page 5 (holding the message) was received but the kill landed inside
  acceptance, so nothing was committed; the next poll re-offered exactly that page and delivered.
  This is the "a judgement interrupted part-way re-offers that page rather than skipping it" claim,
  confirmed by measurement rather than by reading the comment.

### Was the RED suite green for the right reason?

This flow has twice found a test that passed because of the defect it was meant to catch, so I did
not accept the suite's greenness. In a throwaway worktree I checked out `c302485` and reverted **only
the four fixed source files** to `624ea47`, leaving every test at `c302485`:

| Suite | Result against pre-T16 source |
|---|---|
| `rewalk-crash-safety.test.ts` | **3 failed, 1 passed** — tests 1/2/3 (SIGINT, SIGKILL, monotone position) genuinely red; test 4, the T6-F-004 guard, passes both before and after, exactly as a guard should |
| `relayClient.loopbackHostname.test.ts` | **4 of 10 failed**, on precisely `127.evil.example`, `127.0.0.1.evil.example`, `127.example.com:8081` |
| `mailbox_ack_read_position_oracle_test.go` | `TestAckDoesNotAnswerTheMailboxEnvelopeCountToAnUnverifiedCaller` **failed**; the two guard tests passed |

So the transition is a real RED→GREEN, and the guard is a real guard in both directions.

A caution worth recording: my first attempt to run the Go oracle tests used `-run 'ReadPosition|Oracle|AckRead'`,
which matched only the guard test and printed a reassuring `ok`. Naming the three functions explicitly
produced the failure. A filter that silently matches nothing is the same failure mode this flow keeps
finding.

---

## 2. The trap that had to stay untaken (T6-F-004)

Delete-before-the-walk was deliberate: a position surviving its own successful walk restarts every
later poll at the same place and reinstates the whole flooding class. I confirmed by measurement, not
by reading `finishMailboxRewalk`'s name.

In **all 32 configurations**, after the message was delivered I ran three further ordinary polls and
counted the pages served:

- **pages that began again at poison index 0: `0`** — every run, both regimes, both signals.
- **three ordinary polls after a completed re-walk cost 3–4 pages**, against a mailbox of 311 (small)
  or 61 (max) envelopes whose full walk costs 7 and 21 pages respectively.
- history length stayed exactly `1` — the completed re-walk is neither repeated nor duplicated.

I also checked the relay side, because a re-walk from the head reports low `read_through` values that
could in principle rewind the durable mark and reinstate the class through the relay rather than the
client. `MailboxRepository.AdvanceReadMark` refuses any position at or below the current one
(`mailbox_repo.go:797`), so the mark is monotone and a re-walk cannot rewind it.

---

## 3. The ack-route oracle (T10R3-F-002)

I re-ran the binary search myself, in its strongest form: the caller holds the victim's genuine
contact card, so it knows `identity_id` (hence `mailbox_id = sha256(identity_id + ":mailbox:v1")`) and
the genuine `device_id`. Only the signature is not one. `read_through` was swept over
`{absent, 0, 1, 2, 5, 10, 20, 30, 35, 36, 37, 38, 39, 40, 50, 100, 1000, 100000, 10^15}`, followed by a
full 50-step binary search.

| | distinct answers | binary search |
|---|---|---|
| **this tree (`c302485`)** | **1** — `403/INVALID_SIGNATURE`, for every value including 0 and 10^15 | recovers nothing; converges on the search ceiling, `matchesTruth: false` |
| control: pre-T16 (`624ea47`) | 2 — `403/INVALID_SIGNATURE` at or below the count, `400/INVALID_SCHEMA` above it | **recovers the exact lifetime count (16)**, `matchesTruth: true` |

The control matters: a probe incapable of detecting the oracle would have produced the same single
answer on the fixed tree and told me nothing. It detects the oracle where the oracle exists, and finds
none here. **Number of distinct answers an unverified caller can distinguish on this tree: 1.**

Structurally, both routes now order the checks the same way — shape (`decodeReadThroughShape`, no
mailbox access) before authorisation, and the mailbox-consulting bound (`readThroughWithinIssued`)
only after `VerifyMessageSignature`: poll at lines 500 / 540 / 553, ack at 691 / 710 / 736.

---

## 4. The loopback predicate (T10R3-F-003)

`RelayClient` and `parseClientConfig` now import one function, `isLoopbackHostname`
(`apps/cli/src/transport/loopback.ts`), so they cannot disagree by construction. I tested the shared
rule end-to-end through the real `dist/cli.js init` over a 19-URL adversarial corpus:

**Admitted (exit 0), correctly:** `http://127.0.0.1:8080/`, `http://127.9.9.9:8080/`,
`http://localhost:8080/`, `http://[::1]:8080/`, `http://127.1/`, `http://0177.0.0.1/`,
`http://2130706433/`, `http://LOCALHOST/`, `http://127.0.0.1./`, `https://relay.example.com/`.

The four odd-looking ones are genuine: the WHATWG URL parser normalises `127.1`, `0177.0.0.1`,
`2130706433` and the trailing-dot form all to hostname `127.0.0.1` before the predicate sees them.

**Refused (exit 2, `INVALID_CONFIGURATION`), correctly:** `http://127.evil.example/`,
`http://127.0.0.1.evil.example/`, `http://127.example.com:8081/` (the three the old `/^127\./` prefix
rule wrongly admitted), plus `http://evil.example/`, `https://relay.example.com/path`,
`http://user:pw@127.0.0.1/`, `http://127.0.0.1/#f`, `http://127.0.0.1:8080/?q=1`.

No URL in the corpus is admitted as loopback that is not loopback. Genuine loopback still works, which
every e2e suite depends on. One informational note is recorded as T10R3V-F-004.

---

## 5. AC-by-AC

### AC1 — closure chosen by a written design task · **MET**
`t5-flood-closure-design.md` names what it closes (§3, C4-1/C4-2/C4-3 and "Why this closes the class"),
what it does **not** close (§4, "predicted before implementation, with how to measure"), and why the
alternatives were rejected (§6: candidate 1 mailbox-proportional walk alone, candidate 2 proof-of-work
on publish, candidate 3 recipient authorisation). §2 explicitly reports candidate 1 as "a bound, not a
closure — measured".

### AC2 — the wedge probe no longer prevents delivery; new attacker cost stated · **MET (reported as a bound)**
Re-measured on this tree, with Bob already trusting Carol (the wedge path, not the re-walk path):

| | measured |
|---|---|
| attacker | **4** self-published identities, **49** maximum-size envelopes stored, **12.23 MB** uploaded, **53** requests |
| recipient | message **delivered**, in **2 polls / 17 pages**, exit codes `[3, 0]` |
| after delivery | three ordinary polls cost **4 pages**; history stays `1` |

Stated as the dispatch requires: **this is a bound, not an elimination.** The attacker can still
enqueue 49 max-size envelopes for 53 unauthenticated requests, and the recipient still pays a
one-time 17-page walk for that flood. What has changed is that the cost is paid **once** — the durable
mark means the poison is never re-read, so three subsequent polls cost 4 pages rather than 17. The
class that is closed is the *amplification across polls*, which is what made the mailbox wedge
permanent; the per-flood cost is bounded, not zero.

### AC3 — legitimate exchange, offline delivery, exact retry, dedup; no test weakened · **MET**
`two-process.test.ts` 3/3 green (offline, restart, byte-identical exact retry, ack recovery). Full
suite green (§6). **Zero** `it.skip` / `describe.skip` / `test.skip` / `it.todo` / `.only` / `xit` /
`xdescribe` anywhere in TypeScript, and **zero** `t.Skip` anywhere in Go.

T16 touched two pre-existing test files, with 12 deleted lines between them. I read every deleted
line. The one that matters is `flood-closure.test.ts` RED-4's `expect(w.counters.cursored[...]).toBe(false)`
— "the resuming poll must be cursorless". It was **replaced, not dropped**: the new assertion is on the
envelopes the resuming walk is *offered* (it must not skip ground the interrupted walk had not
judged), which is mechanism-independent and strictly stronger than an assertion on a wire field; a
separate helper pins "the half of RED-4's original cursorless assertion that still holds"; and the file
**gained** a test (5 → 6). `mailbox_read_mark_test.go` kept all 4 test functions. Removing the old line
was necessary, not convenient: any crash-safe re-walk makes that poll cursored, so the assertion could
only have held while the bug was present.

### AC4 — HTTPS on a non-loopback address, full scenario from a different machine · **PARTIAL**
The HTTPS half is verified: `relay-tls.test.ts` passes 3/3 against the real relay binary. The
"different machine" half **cannot be established from loopback**, and the dispatch forbids touching
`geekom` and `depr` and forbids opening any non-loopback listener. Reported as partial for that
reason, not as met and not as failed.

### AC5 — operator console drives a local CLI, shows the five surfaces, never touches key material · **MET**
Demonstrated, not asserted, on the real `dist/tui.js` driven with real keystrokes against a real relay:

- **Structural:** every non-test module under `src/tui/` imports only `node:child_process`, `node:path`,
  `node:url` and its own siblings. The console never imports the profile, store or crypto layer, so it
  cannot open the encrypted store. It drives the CLI by `spawn(process.execPath, [cliPath, ...])` with
  the environment inherited wholesale and never inspected.
- **Runtime:** 10 931 bytes of console output captured across doctor/poll/history/pane-cycling.
  **The store key never appears.** Only the env-var *name* (`ECHOLET_E2E_KEY`) is shown, which is
  profile configuration, not a secret.
- **Token audit:** every maximal base64url run of ≥20 characters in the rendered frames was classified.
  5 runs; 4 are public contact-card material, 1 is the profile directory path. **Zero unexplained
  tokens.** (My first pass flagged one "unknown" 43-char token; it was a 43-character prefix of a
  44-character *public* Signal identity key — an artifact of my own regex, corrected by matching
  maximal runs. Recorded because a looser reading of the first pass would have been wrong in the
  alarming direction.)
- **Surfaces:** profiles, queue/mailbox, history, rejections and relay health all present in the
  rendered frames, and present as state types (`ProfileView`, `MailboxView`, `RejectionView`,
  `HistoryEntryView`, `RelayHealthView`).

### AC6 — the surface says it is an unaudited prototype · **MET**
`UNAUDITED PROTOTYPE — not suitable for sensitive communication` was found in the live captured
frames; both halves matched independently (`/UNAUDITED PROTOTYPE/` and
`/not suitable for sensitive communication/i`). It is emitted by `shell-chrome.ts` on every frame, on
every pane, behind any modal.

---

## 6. The full matrix, re-run on this tree

| Command | Exit | Counts | Data races |
|---|---|---|---|
| `pnpm typecheck` | **0** | 7 packages, all Done | — |
| `pnpm test` | **0** | **50 test files, 293 tests, 293 passed, 0 failed** | — |
| `pnpm --filter @echolet/cli test:e2e` | **0** | **1 file, 3 tests, 3 passed** | — |
| `go -C apps/relay test ./...` | **0** | 8 packages `ok`, 8 without test files; 87 test functions | **0** |
| `go -C apps/relay test -race ./...` | **0** | 8 packages `ok` | **0** |
| `go -C apps/relay test -race -tags relayv2 ./...` | **0** | 8 packages `ok`; 92 test functions | **0** |

Per-package TS counts: protocol 3/12, client-db 1/1, crypto-core 4/20, client-core 2/2,
session-node 3/24, mobile 1/6, cli 36/228. Zero `FAIL` lines and zero `DATA RACE` reports in any of
the three Go runs.

---

## 7. Findings

### T10R3V-F-001 · major · The "T15's tests unchanged by T16" criterion is not satisfiable from the record
T15's RED tests and T16's implementation were committed **together** in `c302485`: the same commit adds
`rewalk-crash-safety.test.ts` (+640), `relayClient.loopbackHostname.test.ts` (+119) and
`mailbox_ack_read_position_oracle_test.go` (+202) *and* the source changes they are red against.
There is no T15 commit to diff against, and `002-T15-tests-result.json` records no SHA-256 for any
test file. So "shown unchanged by T16" cannot be established by history or by digest — the evidence
needed to check it was never created.
**Reproduce:** `git show --stat c302485` — tests and implementation in one commit;
`rg sha256 .metaproject/flows/002-*/dispatches/002-T15-tests-result.json` — no matches.
**What I did instead:** the RED replay in §1, which tests the property the criterion exists to protect
(the tests genuinely fail against the pre-fix source, so they were not rewritten to fit it). The
substitution is sound but it is not the same check, and the flow should stop landing RED tests in the
same commit as the fix.

### T10R3V-F-002 · minor · An untracked relay binary in the tree corresponds to no commit
`apps/relay/relay` is untracked and hashes `08e33e83…`. A fresh build of HEAD produces `144b544f…`
and a fresh build of `624ea47` produces `19917dd8…` — both reproducible across output paths, so the
difference is not build nondeterminism. The binary sitting in the working tree therefore matches
neither this commit nor its parent. Anyone who runs `apps/relay/relay` directly — including a previous
verification attempt — measured code of unknown provenance.
**Reproduce:** `shasum -a 256 apps/relay/relay` then `go -C apps/relay build -o /tmp/r ./cmd/relay && shasum -a 256 /tmp/r`.
**Fix:** gitignore it and build to a temp path, as the e2e suites already do.
*(I rebuilt this file during the run and restored the original bit-for-bit; the tracked-tree digest is
unchanged. All my measurements used a binary I built from HEAD in the scratchpad.)*

### T10R3V-F-003 · info · "leaves the encrypted store byte-identical" is not literally true
`inbound.ts:159` and `profile.ts:176` state that an ordinary poll leaves the encrypted store
byte-identical (F-012 / T6-F-005). Measured by SHA-256 over the profile directory, an ordinary poll on
an empty mailbox **does** change the bytes — but so do `doctor` and `history`, which write nothing.
File sizes are stable (`client.sqlite` 32 768, `config.json` 252). The churn is encrypted-SQLite
bookkeeping, not a poll-specific write; it is pre-existing and **not** a T16 regression, and the
behavioural property that matters is confirmed (no post-completion head restart in 32 runs). Recorded
only so the comment is not later read as a byte-level guarantee it does not have.
**Reproduce:** hash the profile directory around `echolet doctor`.

### T10R3V-F-004 · info · IPv4-mapped IPv6 loopback is refused
`http://[::ffff:127.0.0.1]/` is rejected: the URL parser normalises it to `[::ffff:7f00:1]`, which the
predicate does not match. This is the **safe** direction (a genuine loopback refused, never a remote
host admitted) and is consistent with the deliberate choice to converge on the stricter of the two
original rules. Noted as a usability edge only.

---

## 8. Scope limits, stated rather than papered over

- **AC4's "different machine" half** was not attempted: it is impossible from loopback and the remote
  hosts are out of bounds. Recorded as partial.
- **AC2's "previously wedged"** half is a historical measurement (T49/T55) that I did **not** re-run —
  the pre-closure tree is several commits back. I measured the *current* cost and the *current*
  delivery, which is what AC2 asks for; I do not certify the historical figure.
- **Two configurations were attempted and not completed:** `accept-4` in the max-near regime failed to
  arm twice, because at that shallow depth the walk outruns my proxy's arming window. Interruption
  inside `accept()` at maximum ciphertext size is covered by `accept-16`, so this leaves no gap in the
  swept matrix; it is a harness race, not a product observation.

---

## 9. Routing audit

`graph_used: no` (not-relevant — the dispatch named every file, and the work was measurement rather
than navigation) · `wiki_used: no` (not-relevant — the design record lives in the flow package, which
was read directly) · `ctx_used: yes` (`keryx ctx run` / `keryx ctx read` / `keryx ctx rg` throughout) ·
`raw_rg_used: no` — every text and symbol search over project code went through `keryx ctx rg`.
