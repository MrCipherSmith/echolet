# T10 — RI-09 size derivation: where each limit lives, and which closure to take

Flow 003, task T10 (tests-creator, client half). Companion to the RED relay test
`apps/relay/internal/api/handler/mailbox_poll_byte_budget_derivation_test.go` (T8) and to
finding T8-F-001.

Everything below is read off the tree at the time of writing, not inferred from the inventory
row. Nothing in `apps/cli/src` outside `*.test.ts`, nothing in `apps/relay` outside `*_test.go`,
and nothing in `packages/` or `docs/` was changed.

---

## 1. What was established by reading

### 1.1 The relay's maximum is per-deployment and unbounded above

- `apps/relay/internal/config/config.go:37` —
  `MaxMessageBytes int64 \`env:"ECHOLET_MAX_MESSAGE_BYTES" envDefault:"262144"\``.
- `Config.Validate()` (`config.go:68-78`) checks the TLS pair and the TLS reload interval.
  **It does not look at `MaxMessageBytes` at all.** Any value an operator exports is accepted.
- `apps/relay/internal/api/router/router.go:74` passes `cfg.MaxMessageBytes` straight into
  `NewMailboxHandler`.
- The send route derives its own bound from it: `envelopeBodyLimit()`
  (`mailbox_handler.go:81-89`) = `maxMessageBytes + envelopeJSONOverheadBytes` (64 KiB,
  `request_body.go:22`). This is the half that already works.
- The poll route does not: `pollEnvelopeByteBudget` (`mailbox_handler.go:67`) is
  `(1 << 20) - pollResponseWrapperBytes`, a compile-time constant with no reference to
  `h.maxMessageBytes`. That is the defect RI-09 names.

### 1.2 The client's limit is compiled in and unreachable from configuration

- `apps/cli/src/transport/relayClient.ts:144` — `if (size > 1024 * 1024) { … throw invalid(); }`,
  a literal inside the streaming reader.
- `RelayClient`'s constructor takes `{ baseUrl, timeoutMs, fetch }` and nothing else
  (`relayClient.ts:73`). There is no size option.
- The CLI profile schema (`apps/cli/src/runtime/config.ts:8-16`) has
  `request_timeout_ms` and `poll_batch_size` but **no size field of any kind**. So nothing an
  operator can set — profile, flag or environment — reaches that literal today.
- The client applies **no send-side bound at all**: `sendEnvelope` validates the envelope against
  `MailboxEnvelopeSchema.strict()`, and `ciphertext` there is a plain `z.string()` with no `.max()`
  (`packages/protocol/src/types/mailboxEnvelope.ts`). The client will serialize and post a
  ciphertext of any size, including one it will then refuse to read back. That asymmetry is what
  the first of the two new tests pins, and it needs no new surface to state.

### 1.3 A shared protocol constant already exists — and is consumed by nobody

- `packages/protocol/src/constants/limits.ts:2` — `LIMITS = { MAX_MESSAGE_BYTES: 262144, … }`,
  exported from the package index (`packages/protocol/src/index.ts:9`).
- `keryx ctx rg` for `LIMITS` across `apps` and `packages` returns **exactly one match: the
  declaration itself.** Nothing imports it.
- The same number 262144 is written by hand in four places: `LIMITS.MAX_MESSAGE_BYTES`,
  `config.go:37`'s `envDefault`, `request_body.go:26`'s `defaultMaxMessageBytes`, and
  `mailbox_poll_capacity_test.go:48`'s `pollCapacityMaxMessageBytes`.

So the answer to "is there an existing shared protocol constant both sides already use?" is:
**a shared constant exists, but no side uses it.** The shared *notion* is present in the tree and
quadruplicated by hand. Making the client derive from `LIMITS.MAX_MESSAGE_BYTES` introduces no new
coupling — it starts honouring a coupling the repository has already declared.

### 1.4 The relay does not advertise its configured maximum

No response field, no limits endpoint, no header. `createChallenge`, `pollMailbox`, `sendEnvelope`
and the two v2 prekey routes all have closed, strict response schemas
(`relayClient.ts:91-120`) and none of them carries a size. **A client cannot learn a
per-deployment maximum today, and there is no place to put it that is not a wire change.**
This analysis does not invent one.

### 1.5 Why the two numbers cannot both be satisfied at the relay (re-confirmed)

`TestSendEnvelopeBodyLimitIsDerivedFromMaxMessageBytes` (`mailbox_poll_capacity_test.go:200-227`)
pins acceptance of a ciphertext of exactly `ECHOLET_MAX_MESSAGE_BYTES` at 2 MiB. The frozen T8 test
allows the relay to refuse such a send instead — but that is the same route, the same configured
size and the same envelope, so the two demand 200 and 4xx for one request. Answer (b) of the frozen
test is therefore **unsatisfiable**, exactly as T8-F-001 said, and the only remaining answer is that
a poll response carrying a maximum-size envelope must be one the client accepts. That is a statement
about `relayClient.ts:144`, which is why this task exists.

One consequence the implementer must not miss: the frozen test compares the poll response against
`maxPollResponseBytes` (`mailbox_poll_capacity_test.go:43`, `1 << 20`), whose own comment says it
*mirrors the client's hard bound*. When the client's bound becomes derived, that mirror has to
become derived too, or it stops mirroring anything. Editing it is permitted (it is a test constant
outside the two protected tests) — but editing it **without** moving the client's bound is how this
residual gets marked closed while still being open. That is the single most likely false green here.

---

## 2. The two closures, and what each actually costs

### Closure A — "make every size work"

The client's response bound scales with the maximum message size. The relay's poll budget scales
with `h.maxMessageBytes`. Any `ECHOLET_MAX_MESSAGE_BYTES` becomes deliverable.

To do this the client must **learn the maximum**, and there are only three ways:

1. **A CLI config field** (`max_message_bytes` in the profile). No wire change. **But it does not
   close the residual** — it relocates the skew. The sender's client and the recipient's client are
   different installs with different profiles. A sender configured at 2 MiB posts a 2 MiB envelope;
   a recipient still at the default refuses the poll response, acknowledges nothing, and the mailbox
   is undeliverable exactly as before, now with no single place an operator can look. This is the
   same defect one level out.
2. **The shared protocol constant** (`LIMITS.MAX_MESSAGE_BYTES`). Skew-free, because it ships with
   the code rather than with the deployment — but then it is the *protocol* that fixes the maximum,
   and an `ECHOLET_MAX_MESSAGE_BYTES` above it is a configuration the deployment cannot carry. That
   is Closure B wearing Closure A's clothes.
3. **The relay advertises its configured maximum** — a new field on an existing small response
   (the challenge response is the natural carrier, since it precedes every poll and is bounded) or a
   limits endpoint. This is the only form of "every size works" with no skew and no fixed ceiling.
   **It is a wire change**, and per the dispatch it is reported, not invented.

### Closure B — "refuse a maximum the deployment cannot carry"

`Config.Validate()` refuses at startup an `ECHOLET_MAX_MESSAGE_BYTES` above what a conforming client
can poll back, the way it already refuses a half-configured TLS pair rather than silently serving
plaintext (`config.go:60-73`). One-sided, no wire change, and impossible to get wrong silently.

**Reconcilability with the existing acceptance test: yes, cleanly.**
`TestSendEnvelopeBodyLimitIsDerivedFromMaxMessageBytes` builds its handler through
`newMailboxHandlerWithMaxMessageBytes` (`mailbox_poll_capacity_test.go:328-342`), which calls
`NewMailboxHandler` directly. It never constructs a `config.Config` and never calls `Validate()`.
A startup refusal cannot turn it red. The same is true of every other handler test, including the
frozen T8 one.

**But it cannot be the whole closure**, and this is the part worth being blunt about: the frozen T8
test drives a handler at 2 MiB directly, so a startup refusal leaves it red. Closure B answers the
operator's question ("why is my mailbox stuck?" → "the relay refused to start and said so") without
answering the test's.

---

## 3. Recommendation

**Take both, split this way.**

1. **The client's response bound must be derived, not literal** — from the same notion of maximum
   message size the relay is configured with. This is the necessary half: nothing else can make the
   frozen relay test green, and it is what the two new tests pin. Deriving from
   `LIMITS.MAX_MESSAGE_BYTES` is the cheapest honest source, because the constant already exists,
   already carries the same number, and cannot skew per deployment.
2. **The relay should refuse at startup a maximum its clients cannot carry.** It is one-sided, it
   costs a few lines in `Config.Validate()`, it has an exact precedent in that function, it is
   reconcilable with the acceptance test as established above, and it converts the *last* remaining
   silent case — an operator who raises the env var on a fleet of already-installed clients — into
   a loud refusal at the one moment someone is watching.
3. **Do not close this with a per-client config field alone.** It looks like Closure A and behaves
   like the original defect between sender and recipient.
4. **If the project wants an arbitrary per-deployment maximum to work, that needs a wire change** —
   the relay advertising its configured maximum. That is a protocol decision for the flow owner, and
   nothing here invents it.

### Why no startup-refusal test is included

Pinning Closure B requires naming the ceiling that `Validate()` must refuse. Any concrete value
either contradicts the frozen T8 test's own premise (it demands a 2 MiB configured maximum be
deliverable at the handler) or guesses a number the implementer has not chosen yet — which is
precisely the "hardcode the limit somewhere new" move this task was told to avoid. The
recommendation is therefore recorded with its reconcilability established, and left for the
implementer to pin at the value they choose.

---

## 4. The tests

Both are new files under `apps/cli/src/transport/`; both are RED on their own assertion in ~20 ms.

| File | Test | RED failure |
|---|---|---|
| `relayClient.sizeSymmetry.test.ts` | must not accept sending an envelope whose poll response it will refuse | `the client serialized and posted an envelope whose ciphertext is 2097152 bytes and then refused the 2097730-byte poll response carrying that same envelope back (INVALID_RELAY_RESPONSE, retryable=false)…` |
| `relayClient.responseBoundDerivation.test.ts` | derives its response bound from the maximum message size instead of a fixed literal | `with the maximum message size raised to 2097152 the client refused a 2097730-byte poll response carrying exactly one envelope of that size (INVALID_RELAY_RESPONSE, retryable=false)…` |

- The **symmetry** test names no maximum and needs no new surface: it asserts only that the client's
  two opinions about size agree — it will post what it will not read back. It allows either coherent
  answer (bound moves, or the send is refused locally and non-retryably without reaching the wire)
  and refuses only today's incoherence, mirroring the structure of the relay-side test.
- The **derivation** test supplies a raised maximum through both seams that exist without a wire
  change — the shared protocol constant (mocked, since `packages/` is production code) and a
  constructor option (cast, since it does not exist yet) — and asserts two things so that neither
  "raise the literal to 2 MiB" nor "delete the check" passes: a response carrying exactly one
  maximum-size envelope is accepted, **and** a response of eight of them is still refused
  non-retryably. It also asserts the mocked constant really reached the module, so it cannot be red
  for the wrong reason. If the closure chosen is a relay-advertised maximum, the plumbing in
  `clientAtRaisedMaximum` is the part that changes; the two assertions are the part that must not.

### Achievability (verified, then reverted)

A throwaway patch of `relayClient.ts` — an optional `maxMessageBytes` option defaulting to
`LIMITS.MAX_MESSAGE_BYTES`, a response bound of `max(4 × max, max + 64 KiB)`, and a local
non-retryable refusal to send a ciphertext above the maximum — turned **both new tests green** with
all 26 pre-existing transport tests still passing, including the four in
`relayClient.pollCapacity.test.ts` that pin the 1 MiB behaviour at the default. That is not an
accident of the formula: `4 × 262144` is exactly the 1 MiB those tests encode, which is one reason
to suspect the current literal was always a derivation nobody wrote down. The patch was then
reverted; `apps/cli/src/transport/relayClient.ts` is byte-identical to its pre-task state,
`sha256:1c99f959c31c93f3c5eeb953221d5eff189c6a9f6a060b542a33bf050f928af7`, and `git status` over
`apps` and `packages` lists only the two new test files.

`npx tsc -p tsconfig.json --noEmit` in `apps/cli` is clean with both new files present.

No plaintext, ciphertext, key material, store key or request body appears in either test's output;
failure messages carry byte counts, error codes and envelope identifiers only.

---

## Routing audit

- `graph_used`: no — not-relevant. The question was the relationship between four named constants
  already identified by T8/T1; the work was reading those exact files, not discovering them.
- `wiki_used`: no — not-relevant. RI-09's provenance is fully carried by the T1 inventory row and
  the T8 dispatch result, both read here.
- `ctx_used`: yes — `keryx ctx rg` for every code search (`LIMITS`, `maxMessageBytes`/
  `MAX_MESSAGE_BYTES`/`1024 * 1024`, `defaultMaxMessageBytes`/`envelopeJSONOverheadBytes`/
  `maxPollResponseBytes`), and `keryx ctx run` for every command (vitest, tsc, git status, ls, cat).
- `raw_rg_used`: no.
