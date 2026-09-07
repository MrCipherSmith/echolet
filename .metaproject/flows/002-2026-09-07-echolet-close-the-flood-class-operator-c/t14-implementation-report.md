# T14 — Fixing the three T10 findings: the re-walk floor, the count oracle, the misleading `init`

Flow: `002-2026-09-07-echolet-close-the-flood-class-operator-c`
Dispatch: `002-T14-implement` · Date: 2026-09-07
Runtime: **Node v26.5.0** (`/opt/homebrew/bin/node`) · Go 1.26.1 · darwin/arm64 · pnpm 10.0.0

I wrote no test in this task. The T13 suites are the specification, and both files are
byte-identical to what T13 recorded:

| file | sha256 now | sha256 T13 recorded |
|---|---|---|
| `apps/cli/test/e2e/flood-closure.test.ts` | `cf5b6ef6…be38ee9` | `cf5b6ef6…be38ee9` |
| `apps/cli/test/e2e/init-relay-url.test.ts` | `f1d6cf70…b19b95599` | `f1d6cf70…b19b95599` |

Integrity was established by digest, never by mtime. No `git commit`, no `git push`.

---

## 1. T10-F-001 (major) — permanent message loss in the recovery path

### 1.1 What was wrong

`contact import` recorded a **flag**: "the next walk starts at the head of the mailbox". The next
`poll` consumed that flag before the walk began (`inbound.ts:135`) — correctly, because a flag that
outlived its walk would restart every poll at the head and reinstate the whole flooding class
(finding T6-F-004) — and then walked with `cursor: "0"` under the same `maxPollPagesPerPoll = 16`
liveness valve as any other walk (`inbound.ts:148`).

So the recovery path was bounded at 16 pages while the thing it had to reach was not. At the shipped
defaults (poll byte budget `(1<<20)-4096`, `ECHOLET_MAX_MESSAGE_BYTES` 262 144 → 3 maximum-size
envelopes per page) 16 pages is 48 envelopes. Past that the truncated re-walk never reached the
envelope, the durable mark was already past it, every later poll was cursorless and resumed after
it, and the message was lost until it expired. A denial of service had been traded for a lost
message, which is worse in kind.

### 1.2 The fix: the re-walk is a POSITION, and it is durable

`cli:mailbox-rewalk` no longer holds a flag byte. It holds the **position the re-walk has reached** —
the same opaque, relay-issued decimal token `cursor` and `read_through` already are, `"0"` meaning
the head of the mailbox.

- `profile.requestMailboxRewalk()` (`contact import`, still entirely offline) writes `"0"`.
- `profile.takeMailboxRewalk()` consumes it **exactly once, before the walk begins**, and returns
  the position. T6-F-004's discipline is unchanged: nothing a walk started survives that walk
  unaltered.
- `profile.keepMailboxRewalk(position)` puts back the position the walk **reached** — never the one
  it started from — when the walk could not finish.
- `poll()` (`inbound.ts`) starts the walk at that position, advances it page by page as each page is
  *fully judged*, sets it to "finished" the moment the relay reports no further pages, and carries
  it forward otherwise.

Two properties make this a floor rather than a loop:

1. **It only ever moves forward.** The value written back is a `next_cursor` the relay issued for a
   page this walk actually received and judged. Re-requesting `cursor: "0"` on truncation — the
   obvious alternative — restarts at the head and never progresses; that is the failure mode the
   T13 author warned about, and it is why the durable value is a position.
2. **It is cleared only by reaching the end.** The re-walk survives truncation at the valve, a poll
   that judged nothing but poison and re-raised its verdict, a relay outage, a rate limit and a
   request timeout. Each poll advances it by up to a valve's worth of pages, so a mailbox of N
   envelopes costs `ceil(N / (16 pages)) ` extra poll invocations and always terminates.

The write happens **before** any verdict is re-raised, because the walk that most needs to be
resumed is exactly the one that judged 16 pages of poison and threw exit 3. On a relay or storage
failure the position is written from the `catch` and the original failure is the one that reaches
the operator.

`keepMailboxRewalk` writes only while a re-walk is in flight, so **an ordinary poll still leaves the
encrypted store byte-identical** — F-012's store-identity guarantee, pinned by
`inbound.readMark.test.ts`, is untouched and still green.

### 1.3 Measured, after the fix, on the exact T10 attack shape

Out-of-repo probe (`probe-rewalk-cost.mjs`, session scratchpad), real relay binary built from this
tree, real `dist/cli.js`, real CLI profiles as real processes, an independent ed25519 implementation
(`node:crypto`), a counting loopback proxy, `ECHOLET_RATE_LIMIT_PER_MINUTE=1000000` (the same single
declared deviation T49/T52/T55/T10 use). It prints counters, byte totals, exit codes and booleans
only.

| measurement | before (T10 §2.2 / T13) | after |
|---|---|---|
| attacker identities | 5 | **5** |
| attacker envelopes | 55 (49 ahead, 6 behind) | **55** |
| attacker upload | 14 457 630 B, paid once | **14 457 630 B, paid once** |
| attacker requests | 60 | **60** |
| pre-import drive | walks to the end | `[3,3]`, 20 pages, 15 253 860 B |
| delivered before the import | 0 | **0** (unchanged: the card is not trusted yet) |
| polls after `contact import` | 8+, never delivered | **2** — exit codes `[3,0]` |
| pages after the import | 23, message still lost | **17** |
| requests after the import | — | **35** |
| bytes after the import | — | 13 413 271 B |
| **delivered** | **NO — `history = 0`, permanently** | **YES — `history = 1`** |

**The attacker's cost is unchanged and now buys nothing.** 5 identities, 55 envelopes,
14 457 630 B and 60 requests, paid once, no longer destroy a message; they delay it by one extra
poll invocation.

**Reported as a bound, not as a victory (RED-5 discipline):** a `contact import` performed against a
flooded mailbox now costs **one extra walk of the mailbox**, which is what recovery *is*. In the run
above the recipient downloaded 28 667 131 B in total against 14 457 630 B of poison —
**1.98:1**, paid once per import that needs it, against 1.06:1 for ordinary delivery. It is bounded
by the mailbox, it is not attacker-triggerable (only a local `contact import` requests a re-walk),
and it is O(N) rather than O(N·K): the re-walk resumes, it does not restart.

---

## 2. T10-F-002 (minor) — the unauthenticated count oracle

`resolveReadThrough` did two different jobs in one place, ahead of authentication:

- a **pure shape rule** (`repository.DecodeMailboxCursor`) — malformed client input must never
  answer 500 and must never depend on who is asking; and
- a **bound that consults the mailbox** (`HighestIssuedPosition`) — which made the pair of refusals
  a comparator on the victim's lifetime received-envelope count, recoverable in about twenty
  requests with a fabricated `challenge_id`, a fabricated `device_id` and the literal signature
  `"AAAA"`.

It is now split into `decodeReadThroughShape` (shape only, unchanged position: before the challenge,
the device binding and the signature) and `readThroughWithinIssued` (the mailbox-dependent bound).

- **`/v1/mailbox/poll`** applies the bound **after `VerifyMessageSignature` succeeds**. An
  unauthenticated caller now gets one answer — `400 CHALLENGE_EXPIRED` — for every `read_through`
  value, so the answer no longer depends on the mailbox. RED-7's binary search collapses and its
  live control (a real signed poll carrying a real read position must still deliver) still passes.
- **`/v1/mailbox/ack`** applies the bound after `authorizeMailboxDevice` resolves, which is as late
  as it can move on that route. See §5 for what that leaves open and why.

Both refusals keep their wire shape: `400 INVALID_SCHEMA` above the bound,
`500 INTERNAL_ERROR` if the lookup itself fails. Nothing about the signed transcripts changed.

---

## 3. T10-F-003 (minor) — `init` accepted a URL every later command rejects

`RelayClient` refuses a base URL carrying a path or a query and then serves every request from
`url.origin`; `parseClientConfig` checked scheme, credentials and fragment but not the path or the
query. So `init --relay-url https://relay.example.com/path` exited 0, wrote the profile, and every
relay command on that profile exited **5 `PERSISTENCE_FAILURE`** — a local-storage code for a
mistake on the command line, sending the operator to a disk that is perfectly healthy.

`parseClientConfig` now applies the transport's own rule: a relay URL must be an origin. The refusal
is a `ConfigurationError`, which the CLI already classifies as exit **2 `INVALID_CONFIGURATION`**,
and it is raised before `openProfile`, so a refused `init` writes nothing — `config.json` is absent
afterwards, as the suite requires.

`docs/requirements/echolet-cli-prototype/deployment-runbook.md` §9 now states the origin rule beside
the HTTPS rule, since it is the operator-facing half of this fix.

---

## 4. Verification

Node **v26.5.0** throughout. Node 22.12 was not used.

| check | result |
|---|---|
| `pnpm -r typecheck` | **exit 0**, 7 projects |
| `pnpm -r test` | **exit 0** — **278 tests** across the workspace, **0 failed** (`apps/cli` 34 files / 213 tests) |
| `apps/cli` unit tests (`vitest run src/`) | 29 files, **189 passed** |
| `init-relay-url.test.ts` | **9/9** — the five RED rows and the four guards (baseline was 5 failed / 4 passed) |
| `flood-closure.test.ts -t "RED-6"` | **2/2** — control (30 ahead / 10 pages) **and** attack (49 ahead / 17 pages) |
| `flood-closure.test.ts -t "RED-7"` | **1/1** |
| full `test/e2e` (inside `pnpm -r test`) | **24/24** across 5 files — `flood-closure` 8/8 (130.0 s), `init-relay-url` 9/9, `relay-tls` 3/3, `two-process` 3/3, `publication-claimability` 1/1 |
| `go -C apps/relay vet ./...` | **exit 0** |
| `go -C apps/relay test -count=1 ./...` | **exit 0**, 16 packages |
| `go -C apps/relay test -race -count=1 ./...` | **exit 0**, no data race |
| `go -C apps/relay test -race -count=1 -tags=relayv2 ./...` | **exit 0**, no data race |
| `keryx health run --changed --source eslint,typescript` | **PASS**, score 98, 0 findings |
| skip/focus scan (`it.skip`, `test.skip`, `describe.skip`, `.todo(`, `t.Skip(`, `.only`) over `apps/` and `packages/` | **0 matches** |

Test-count arithmetic: `apps/cli` 213 = T13's 213 (202 baseline + 11 new), with the 7 RED failures
now passing. Every other package is unchanged: protocol 12, client-db 1, crypto-core 20,
client-core 2, session-node 24, mobile 6.

**Nothing from flow 001 or from the closure was undone.** Server-assigned ordering, the durable read
position on the signed poll request, per-page marking, F-004 replay/409, F-005 expiry ordering,
F-006 bounds, required `claimable`, sender authentication, the per-sender quota, T8's TLS behaviour
and the 0/2/3/4/5 exit-code contract are all still pinned by the suites above, all green.

---

## 5. What remains open

1. **The same bound is still answerable on `/v1/mailbox/ack` to a caller who knows a device_id bound
   to the mailbox.** `TestAckRefusesAReadThroughAboveAnyPositionTheRelayIssued` requires an ack
   carrying an out-of-range `read_through` to answer `400 INVALID_SCHEMA` while presenting a
   signature that does not cover it — so on that route the bound cannot move past the signature
   check without changing a test I may not touch. I moved it as late as the test allows (after
   `authorizeMailboxDevice`), which closes it for a caller who names no device this mailbox knows.
   `device_id` is printed on every contact card, so for a card-holder the ack-route oracle survives.
   Closing it needs that Go test re-stated (the natural form: an ack whose signature does not verify
   is refused 403 before any mailbox-dependent bound), which is a test-authoring decision, not mine.
2. **A re-walk is dropped if the poll carrying it is `SIGKILL`ed.** The position is written at the
   end of the walk, not per page, so a killed recovery poll loses the re-walk and the operator must
   re-import the card. This is deliberate: per-page persistence would make the re-walk survive into
   the next process, and RED-4 requires the process that follows a `SIGKILL` to poll **cursorless**
   and resume at the relay-held mark. The trade is that recovery is not crash-safe while ordinary
   progress is. It is recoverable by an operator action; the loss it replaces was not.
3. **`contact import` against a flooded mailbox costs one extra walk of it** (§1.3: 1.98:1 measured,
   paid once, operator-triggered only). A mailbox large enough to matter makes that walk span
   several poll invocations.
4. **Recovery is delayed, not instantaneous.** While a re-walk is in flight, polls resume it instead
   of resuming at the mark, so a message arriving at the tail waits for the re-walk to catch up —
   bounded by the same `ceil(N / 16 pages)` invocations.
5. **AC8's residual list** should now record: the ack-route residual above, the re-walk cost bound,
   T5-F-002's unenforced `ECHOLET_MAX_STORAGE_BYTES`, and T10 §2.4's prekey-bundle exhaustion
   observation (one sender consuming a bundle appears to deny first contact to other senders) —
   which I did not investigate and which is out of this task's class.
6. **AC4's "different machine" half and AC7** are still T11's; nothing here touches `deploy/` or
   `apps/relay/Dockerfile`.

---

## 6. Files changed

| file | change |
|---|---|
| `apps/cli/src/runtime/profile.ts` | `cli:mailbox-rewalk` holds a re-walk POSITION; `takeMailboxRewalk()` returns it (legacy flag byte reads as `"0"`); new `keepMailboxRewalk()` |
| `apps/cli/src/runtime/inbound.ts` | `poll()` resumes an unfinished re-walk at its position, advances it per fully judged page, ends it at the end of the mailbox, and carries it forward before any verdict is re-raised or any failure propagates |
| `apps/cli/src/runtime/config.ts` | a relay URL must be an origin — no path, no query — refused as `INVALID_CONFIGURATION` |
| `apps/relay/internal/api/handler/mailbox_handler.go` | `resolveReadThrough` split into `decodeReadThroughShape` (before authentication) and `readThroughWithinIssued` (poll: after the signature verifies; ack: after the device binding resolves) |
| `docs/requirements/echolet-cli-prototype/deployment-runbook.md` | §9 records the origin-only relay URL rule |

No test file, `apps/cli/vitest.config.ts`, `apps/cli/test/globalSetup.ts`, `apps/cli/src/tui/`,
`flow.json`, `acceptance-criteria.md`, `deploy/` or `apps/relay/Dockerfile` was modified.

## 7. Routing audit

- `graph_used`: **not-relevant** — the three findings named their own files, lines and call sites;
  no blast-radius question arose that the compiler and the suites did not answer.
- `wiki_used`: **partial** — the authoritative documents here were the T10 verification report, the
  T13 dispatch result and the T5 design §4 R-5, all read in full as the dispatch required.
- `ctx_used`: **yes** — `keryx ctx rg` for every code search, `keryx ctx run` for builds, Go tests
  and vet; long test output was redirected to a file outside the repository and summarised.
- `raw_rg_used`: **no**. Four raw commands were declared with `# keryx:raw` and a reason: three
  digest/summary reads whose exact bytes are the evidence (SHA-256 manifest lines, the vitest
  summary lines of a large log, the probe's own JSON) and one `grep -n` for exact line numbers
  before placing an edit.
