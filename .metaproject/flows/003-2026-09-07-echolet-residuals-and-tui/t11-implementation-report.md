# T11 — RI-09 implementation: one shared maximum, derived on both sides

Flow 003, task T11 (task-implementer). Closes the client half of RI-09 and makes the relay refuse
the configuration that produced it. Companion to `t10-size-derivation-analysis.md` (T10) and to the
frozen relay test from T8.

Tree at start: HEAD `7c9a0ad`, working tree clean apart from T10's two new test files and its
analysis. **No test file was changed, at all** — see §4.

---

## 1. What changed, and why each piece is there

The decision implemented (handed down with the dispatch, not invented here): **no wire change**. The
relay does not advertise its configured maximum and the client does not learn a size at runtime. One
shared protocol constant is the source of truth for both sides; a deployment may configure LESS than
it and may not configure MORE.

### 1.1 The client derives its response bound (`apps/cli/src/transport/relayClient.ts`)

`if (size > 1024 * 1024)` in the streaming reader is now `if (size > this.responseByteBound)`, where

```
responseByteBoundFor(max) = Math.max(4 * max, max + 64 KiB)
this.maxMessageBytes = LIMITS.MAX_MESSAGE_BYTES   // read per instance, in the constructor
```

`4 x max` is the relay's own aggregate poll budget plus the room its response wrapper needs; `max +
64 KiB` covers the relay's deliberate first-envelope exemption and only binds when the maximum is
small. At the shared 262144 the derivation yields **1 048 576 — the same number the literal had**, so
no existing behaviour moves: `relayClient.pollCapacity.test.ts` still refuses 5 maximum-size
envelopes and still accepts 3, and it is those two cases, not the constant, that keep the bound
load-bearing.

`LIMITS.MAX_MESSAGE_BYTES` was exported by `packages/protocol` and consumed by nobody. This is the
first consumer, so the change **removes** a duplication the repository had already declared rather
than creating a new coupling.

### 1.2 The client gained the send-side bound it never had

`sendEnvelope` now refuses, locally and non-retryably, a ciphertext above the same maximum:

```ts
if (Buffer.byteLength(envelope.ciphertext, "utf8") > this.maxMessageBytes || envelope.size_bytes > this.maxMessageBytes)
  throw new RelayError("ENVELOPE_TOO_LARGE", false);
```

It measures exactly the two things `validation.ValidateMailboxEnvelope` measures on the relay — the
actual ciphertext length and the declared `size_bytes` — so it is the relay's own rule applied one
hop earlier, never a second and looser opinion about size. Nothing reaches the wire, so nothing can
land in a mailbox that could not drain. This is answer (b) of the symmetry test.

### 1.3 The relay refuses at startup a maximum it cannot carry (`internal/config/config.go`)

`Config.Validate()` now refuses `ECHOLET_MAX_MESSAGE_BYTES` above the protocol maximum, and refuses a
negative one. The precedent is in the same function: the relay already refuses to start on a
half-configured TLS pair rather than silently serving plain HTTP. The failure it prevents is the same
shape — come up healthy, accept and store an envelope, and answer every poll with a body the
recipient refuses in full, so nothing is ever acknowledged and the mailbox is undeliverable with
nothing anywhere saying so.

Zero is deliberately still accepted: it is the zero value of a partially constructed `Config`, which
`internal/server`'s own tests build directly and which the handler reads as "unconfigured, use the
protocol maximum". `Load()` can never produce it, because the field carries an `envDefault`. Refusing
`<= 0` was tried first and turned six `internal/server` tests red; that is a test-visible
demonstration that the zero-value `Config` is a real supported path, not an oversight, so the
refusal was narrowed to `< 0` rather than the tests adjusted. See §5 residual R-3.

### 1.4 The maximum is one constant on the Go side too (`internal/protocol/limits.go`, new)

`protocol.MaxMessageBytes = 262144`, documented as the mirror of `LIMITS.MAX_MESSAGE_BYTES`. Both
`handler.defaultMaxMessageBytes` and `config.Validate` now read it, and the poll budget is written as
the derivation it always was:

```go
const clientPollResponseBound int64 = 4 * protocol.MaxMessageBytes           // mirrors responseByteBoundFor
const pollEnvelopeByteBudget  int64 = clientPollResponseBound - pollResponseWrapperBytes
```

`4 * 262144 = 1 << 20`, so **every value in the relay is numerically unchanged**; what changed is that
the number is now derived from the same source on both sides instead of being written by hand in four
places. The hand-written copies are down from four to two — the Go mirror and the `envDefault` struct
tag, which has to be a literal — and `config.Validate` pins the tag to the mirror.

### 1.5 Documentation (`docs/OPS-23_LOCAL_ENV_VARS.md`)

`ECHOLET_MAX_MESSAGE_BYTES` now states that its ceiling is a protocol constant rather than a
deployment setting, that lower is allowed, and that higher is refused at startup.

---

## 2. Test results

| Test | Before | After |
|---|---|---|
| `apps/cli/src/transport/relayClient.sizeSymmetry.test.ts` | RED | **GREEN** — takes answer (b): the send is refused locally, non-retryably, and `/v1/messages/send` is never called |
| `apps/cli/src/transport/relayClient.responseBoundDerivation.test.ts` | RED | **GREEN** — one 2 MiB envelope accepted at the mocked maximum, eight still refused `INVALID_RELAY_RESPONSE, retryable=false` |
| `apps/relay/.../mailbox_poll_byte_budget_derivation_test.go` | RED | **STILL RED** — see §3 |

Full matrix, measured after the change:

| Suite | Result |
|---|---|
| `pnpm test` | exit 0 — `apps/cli` **255/255** (253 + the two new), protocol 12/12, crypto-core 20/20, client-core 2/2, client-db 1/1, session-node 24/24, mobile 6/6 |
| `pnpm typecheck` | exit 0 |
| `go test ./...` | 1 failure — only `TestMaximumSizeEnvelopeIsDeliverableAtRaisedMaxMessageBytes` |
| `go test -race ./...` | same single failure, **0 data races** |
| `go test -race -tags relayv2 ./...` | same single failure, **0 data races** |
| `gofmt -l` over every file touched | clean |
| `go vet ./...` | clean |

Baseline for comparison (measured by the dispatcher): identical except that `apps/cli` was 253/253
with the two new transport tests red.

---

## 3. The Go test is still red, and the mirror constant was NOT edited

The dispatch named the likeliest false green here: editing `maxPollResponseBytes` so the Go suite goes
green while every real recipient still refuses the batch. It also instructed that if that mirror lives
in a `_test.go` file, report rather than edit. **It does**:
`apps/relay/internal/api/handler/mailbox_poll_capacity_test.go:43`, `const maxPollResponseBytes = 1 << 20`.
It was not touched, and its SHA-256 is byte-identical to HEAD (§4).

Editing it would also have been wrong on the merits, not merely out of scope. Under the chosen
closure the client's bound is 1 MiB at every setting, because it derives from the protocol constant.
Raising the mirror to 8 MiB (`4 x` the test's 2 MiB) would assert that a recipient accepts an 8 MiB
poll response — which is false. That is precisely the "green test, stuck mailbox" outcome.

**Why no product-code change can turn it green.** Verified first-hand rather than taken from T8-F-001:
a one-line clamp of `NewMailboxHandler`'s `maxMsgBytes` to `protocol.MaxMessageBytes` was applied out
of tree and both Go tests were run.

- `TestMaximumSizeEnvelopeIsDeliverableAtRaisedMaxMessageBytes` — **PASS** (takes answer (b): 413
  `PAYLOAD_TOO_LARGE`, nothing stored)
- `TestSendEnvelopeBodyLimitIsDerivedFromMaxMessageBytes` — **FAIL**: `status = 413, want 200`

The clamp was reverted; `mailbox_handler.go` is back to the state described in §1.4 and the frozen
test passes again. The two Go tests demand 200 and 4xx for one request at one configured size, so
exactly one of them can be green, and the frozen one wins.

**What the test now pins is a configuration the product no longer permits.** It builds its handler
through `newRaisedMaxMessageBytesHarness`, which calls `NewMailboxHandler` directly and never
constructs a `config.Config` — verified by reading, and confirmed by the suite: `internal/config` and
`internal/server` are green and every other handler test is unaffected by the startup refusal. So the
test drives a relay at `ECHOLET_MAX_MESSAGE_BYTES = 2 MiB`, which as of this change **cannot start**.
Deciding what that test should assert instead — a configured maximum at or below the protocol
maximum, or `config.Validate` refusing the 2 MiB one — is a test-authoring decision for the flow
owner. This task reports it (finding T11-F-001) and leaves the file untouched.

---

## 4. Every test file, shown unchanged (SHA-256; no mtime anywhere)

| File | SHA-256 | Proof |
|---|---|---|
| `apps/relay/internal/api/handler/mailbox_poll_byte_budget_derivation_test.go` | `d3ad8fa2e661ba4b360bcc58208327b444265f208931d2cd10c38b3d2f9f5819` | identical to the same path's blob at HEAD |
| `apps/relay/internal/api/handler/mailbox_poll_capacity_test.go` (holds the mirror constant) | `988c7c8dffbbba21b3d92149d3beefc078d73b488d2988000520367c5e67f285` | identical to the same path's blob at HEAD |
| `apps/cli/src/transport/relayClient.sizeSymmetry.test.ts` | `f4ab443069249aa95549cb248928566d66f8520e272e955eff55af136904bf0d` | identical to the hash T10 recorded in `003-T10-tests-result.json` |
| `apps/cli/src/transport/relayClient.responseBoundDerivation.test.ts` | `f0dad8b42d389bce4728d0949494d2289531717d33669b2fedeb0cf752956e86` | identical to the hash T10 recorded in `003-T10-tests-result.json` |

`git status --porcelain apps packages` lists four modified files, all product code, plus the new
`apps/relay/internal/protocol/` and T10's two untracked test files. No `*_test.go` and no `*.test.ts`
is modified, added or deleted by this task.

---

## 5. Deployed relays, and every residual

### Does a currently-deployed relay still start?

**Yes — unless it exports `ECHOLET_MAX_MESSAGE_BYTES` above 262144 or below 0.** Nothing was done to
the relays on `geekom` and `depr`; they were not contacted, inspected or restarted. Stated plainly,
because both are live on their tailnet addresses with real TLS:

- The only new refusals are `> 262144` and `< 0`. Every other configuration, including a lower
  maximum and an unset variable (the `envDefault` is 262144), starts exactly as before.
- Nothing in this repository sets the variable above the default: `docs/OPS-23` documents `262144` and
  the sample `.env.local` uses it.
- **If either host's unit file or environment exports a higher value, that relay will fail to start
  on its next restart**, with a named error saying the value, the protocol maximum, and what to
  configure instead. It will not fail while running: `Validate()` runs at `Load()`, so a running
  process is unaffected until it is restarted. That is the intended trade — the alternative is the
  silent undeliverable mailbox RI-09 describes — but it needs to be checked on both hosts before the
  next restart, and this task could not check it.
- No behaviour on the wire changed. Every schema, route, status code and byte budget is numerically
  identical at the default.

### Residuals

- **R-1 (carried, the reason the Go test stays red).** `mailbox_poll_byte_budget_derivation_test.go`
  pins a configuration that can no longer start. It needs re-authoring or retiring by whoever owns
  the frozen test; RI-09 must not be recorded as closed on a green Go suite obtained by editing
  `maxPollResponseBytes`. Finding T11-F-001.
- **R-2 (new, small).** A local `ENVELOPE_TOO_LARGE` refusal reaches `classify()` in `cli.ts` as a
  non-retryable `RelayError` with no `remoteCode`, so the operator sees `PROTOCOL_REJECTED` — a
  trust-shaped diagnosis for a purely local size decision. It is unreachable through the CLI's own
  commands today (`outbound.ts` bounds plaintext at 64 KiB, whose base64url ciphertext is ~90 KiB
  against the 262144 maximum), so this is a safety net's error message, not a live path. Fixing it
  properly means a distinct local code, which is `cli.ts` surface and outside this task.
- **R-3 (pre-existing, unchanged).** `ECHOLET_MAX_MESSAGE_BYTES=0` set explicitly still passes
  validation and makes the relay accept nothing (`ValidateMailboxEnvelope` compares against 0 while
  `envelopeBodyLimit` falls back to the default). Closing it means refusing `<= 0`, which turns six
  `internal/server` tests red because they build a zero-value `Config` — a test change, so it was not
  made.
- **R-4 (accepted by the decision).** A deployment that genuinely needs messages larger than 256 KB
  cannot have them. That is the cost of a fixed protocol maximum and it is the decision that was
  handed down; the alternative remains the relay advertising its configured maximum, which is a wire
  change.
- **R-5 (documentation drift, out of scope).** `docs/PROTOCOL-07` and `docs/REP-02` state
  `MAX_MESSAGE_BYTES = 256 KB` in prose. They are consistent with the constant, but nothing keeps
  them so.

### Safety

No store key, private key, plaintext, ciphertext or HTTP request body was printed, logged or written
into any artifact. Failure output from the tests carries byte counts, status codes, error codes and
envelope identifiers only. The relays on `geekom` and `depr` were not touched.

---

## Routing audit

- `graph_used`: no — not-relevant. Every file involved was named by the T10 analysis and the two
  dispatches; the work was reading and changing those exact files, not discovering them.
- `wiki_used`: no — not-relevant. RI-09's provenance is carried by the T1 inventory row, the T8
  dispatch result and the T10 analysis, all read here.
- `ctx_used`: yes — `keryx ctx rg` for every code search and `keryx ctx run` for every command (go
  build/vet/test, gofmt, vitest, pnpm test/typecheck/lint, git, shasum, ls).
- `raw_rg_used`: no. One `keryx:raw` escape was used for a `git show | shasum` pipeline, because the
  per-file HEAD blob hashes in §4 are the proof that the test files are unchanged and a compacted
  summary would not carry them verbatim.
