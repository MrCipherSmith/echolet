import { z } from "zod";
import { MailboxEnvelopeSchema, SignalPreKeyBundleV2Schema, type MailboxEnvelope, type SignalPreKeyBundleV2 } from "@echolet/protocol";
import { isLoopbackHostname } from "./loopback";

export class RelayError extends Error {
  constructor(readonly code: string, readonly retryable: boolean, readonly httpStatus?: number, readonly remoteCode?: string) {
    super(code);
    this.name = "RelayError";
  }
}
const success = <T extends z.ZodType>(data: T) => z.object({ ok: z.literal(true), data }).strict();
// Relay-chosen error codes this client is willing to carry inland. The allowlist is deliberate:
// a code the relay controls ends up in the operator's machine-readable output, so an unrecognised
// one is discarded rather than forwarded verbatim. `PREKEY_BUNDLE_UNAVAILABLE` is the relay's own
// code for an exhausted recipient (specification.md, atomic claim); without it here the CLI could
// not tell that ordinary, recoverable condition from a genuine trust/protocol violation. The v1-era
// `PREKEYS_EXHAUSTED` was removed: no v2 relay path emits it and the CLI uses only v2 endpoints.
// `UNAUTHORIZED_MAILBOX_ACCESS` is the relay's code for "no such (mailbox identity, device UUID)
// binding". Since T50 it also answers a send whose SENDER the relay holds no published device
// record for, which is an ordinary precondition - `relay publish` has not run yet - rather than a
// trust violation, and without the code here it would be indistinguishable from one.
// `SENDER_QUOTA_EXCEEDED` is the third (T54, finding T52-F-001): the relay declines a send once this
// sender already holds its full allowance of unacknowledged envelopes in that one recipient's
// mailbox. It is temporary and entirely outside the sender's control - it clears as the recipient
// acknowledges or the envelopes expire - so it is neither a trust violation nor something a retry
// can fix, and the relay answers it as a NON-retryable 403 precisely so this allowlist can carry it
// inland: `retryable` is decided from the HTTP status alone, and classify() never reads `remoteCode`
// for a retryable error.
const remoteCodes = new Set(["BUNDLE_ID_CONFLICT", "CLAIM_ID_CONFLICT", "PREKEY_BUNDLE_UNAVAILABLE", "UNAUTHORIZED_MAILBOX_ACCESS", "SENDER_QUOTA_EXCEEDED", "NOT_FOUND", "INVALID_REQUEST", "UNAUTHORIZED", "ENVELOPE_ID_CONFLICT", "RATE_LIMITED"]);
const invalid = () => new RelayError("INVALID_RELAY_RESPONSE", false);
const authorizationSchema = z.object({ recipient_mailbox_id: z.string().min(1), device_id: z.string().uuid(), signature: z.string().min(1) }).strict();
type Authorization = z.infer<typeof authorizationSchema>;
// `next_cursor` is the relay's remaining-work signal AND its resume position: a
// bounded opaque token when the response was cut short by the batch or byte
// bound, null when the mailbox is drained. Closed union - never optional, never
// unbounded.
const nextCursorSchema = z.union([z.string().min(1).max(256), z.null()]);
// The poll request carries the client's configured batch preference. Its bounds
// mirror config.ts `poll_batch_size` and the relay's ECHOLET_MAX_MAILBOX_BATCH.
//
// `cursor` is the token a previous poll returned as `next_cursor`, echoed back
// verbatim so the relay resumes past the envelopes it already returned instead of
// re-selecting them from the head of the mailbox. It is server-issued and opaque:
// this client never constructs, parses or reasons about its content, and it is
// bounded by the same closed schema the response is, so a token the relay could
// not have issued never reaches the wire. Omitted on the first page of a walk.
//
// `read_through` is the recipient's durable read position: the highest
// server-issued position this walk has JUDGED — committed or permanently refused
// — reported on the request for the page after it. It is the same kind of opaque,
// server-issued token `cursor` is (this client only ever echoes back a value the
// relay produced as `next_cursor`), it is covered by the signature this request
// already carries, and it costs no extra request. Omitted on the first page of a
// walk, where nothing has been judged yet.
const pollRequestSchema = authorizationSchema.extend({
  challenge_id: z.string().uuid(),
  batch_size: z.number().int().min(1).max(100),
  cursor: z.string().min(1).max(256).optional(),
  read_through: z.string().min(1).max(256).optional(),
});
// `claimable` is the relay's answer to "is the bundle I just published available for a first
// contact to claim?" - a question the client cannot answer, because a successful publish response
// is otherwise identical on the fresh-store and idempotent re-store paths. Required and closed: the
// relay always emits the field and always as a boolean, so a publish success without it is a
// malformed response and is refused like any other, rather than being carried inland as an absent
// key that would silently degrade a no-op republish back into plain success.
const claimableSchema = z.boolean();

export class RelayClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetcher: typeof fetch;
  constructor(options: { baseUrl: string; timeoutMs: number; fetch?: typeof fetch }) {
    let url: URL;
    try { url = new URL(options.baseUrl); } catch { throw new RelayError("INVALID_RELAY_CONFIGURATION", false); }
    // The one loopback rule (`transport/loopback.ts`), shared with `parseClientConfig` so the two
    // cannot answer "may this base URL be used?" differently. Finding T10R3-F-003: the prefix rule
    // that used to live here admitted `127.evil.example` as loopback and would have carried every
    // relay request to it in plaintext.
    const loopback = isLoopbackHostname(url.hostname);
    if (url.username || url.password || url.hash || url.search || url.pathname !== "/" ||
        !(url.protocol === "https:" || url.protocol === "http:" && loopback) ||
        !Number.isInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 60000) {
      throw new RelayError("INVALID_RELAY_CONFIGURATION", false);
    }
    this.baseUrl = url.origin;
    this.timeoutMs = options.timeoutMs;
    this.fetcher = options.fetch ?? globalThis.fetch;
  }

  async publishBundle(input: SignalPreKeyBundleV2) {
    const bundle = this.validate(SignalPreKeyBundleV2Schema, input);
    const data = await this.request("/v2/prekeys/publish", { bundle },
      z.object({ stored: z.literal(true), bundle_id: z.literal(bundle.bundle_id), claimable: claimableSchema }).strict());
    return { stored: data.stored, bundleId: data.bundle_id, claimable: data.claimable };
  }
  async claimBundle(input: { claimId: string; identityId: string; deviceId: string | null }): Promise<SignalPreKeyBundleV2> {
    const body = this.validate(z.object({ claim_id: z.string().uuid(), identity_id: z.string().min(1), device_id: z.string().uuid().nullable() }).strict(),
      { claim_id: input.claimId, identity_id: input.identityId, device_id: input.deviceId });
    return (await this.request("/v2/prekeys/claim", body, z.object({ bundle: SignalPreKeyBundleV2Schema }).strict())).bundle;
  }
  async sendEnvelope(input: MailboxEnvelope) {
    const envelope = this.validate(MailboxEnvelopeSchema.strict(), input);
    const data = await this.request("/v1/messages/send", { envelope }, z.object({ accepted: z.literal(true), envelope_id: z.literal(envelope.envelope_id), status: z.literal("relayed") }).strict());
    return { accepted: data.accepted, envelopeId: data.envelope_id, status: data.status };
  }
  createChallenge(input: Authorization) {
    return this.request("/v1/mailbox/challenge", this.validate(authorizationSchema, input), z.object({
      challenge_id: z.string().uuid(), nonce: z.string().min(1).max(256), expires_at_ms: z.number().int().nonnegative(),
    }).strict());
  }
  pollMailbox(input: Authorization & { challenge_id: string; batch_size: number; cursor?: string; read_through?: string }) {
    return this.request("/v1/mailbox/poll", this.validate(pollRequestSchema, input), z.object({
      envelopes: z.array(MailboxEnvelopeSchema.strict()).max(100), next_cursor: nextCursorSchema,
    }).strict());
  }
  ackMailbox(input: Authorization & { envelope_ids: string[] }) {
    const body = this.validate(authorizationSchema.extend({ envelope_ids: z.array(z.string().uuid()).min(1).max(100) }), input);
    return this.request("/v1/mailbox/ack", body, z.object({ acked: z.literal(body.envelope_ids.length) }).strict());
  }
  private validate<T>(schema: z.ZodType<T>, input: unknown): T {
    const result = schema.safeParse(input);
    if (!result.success) throw invalid();
    return JSON.parse(JSON.stringify(result.data)) as T;
  }
  private async request<T>(path: string, body: unknown, schema: z.ZodType<T>): Promise<T> {
    const serialized = JSON.stringify(body), controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new RelayError("RELAY_TIMEOUT", true)); }, this.timeoutMs);
    });
    try {
      return await Promise.race([deadline, (async () => {
        const response = await this.fetcher(this.baseUrl + path, { method: "POST", headers: { "content-type": "application/json" }, body: serialized, signal: controller.signal, redirect: "error" });
        const reader = response.body?.getReader();
        const chunks: Uint8Array[] = [];
        let size = 0;
        if (reader) {
          try {
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              size += value.length;
              if (size > 1024 * 1024) { void reader.cancel().catch(() => {}); throw invalid(); }
              chunks.push(value);
            }
          } finally { reader.releaseLock(); }
        }
        let value: unknown;
        try { value = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw invalid(); }
        if (!response.ok) {
          const parsed = z.object({ ok: z.literal(false), error: z.object({ code: z.string(), message: z.string() }).strict() }).strict().safeParse(value);
          const code = parsed.success && remoteCodes.has(parsed.data.error.code) ? parsed.data.error.code : undefined;
          throw new RelayError("RELAY_HTTP_ERROR", response.status === 429 || response.status >= 500, response.status, code);
        }
        return this.validate(success(schema), value).data;
      })()]);
    } catch (error) {
      if (error instanceof RelayError) throw error;
      if (error instanceof Error && error.name === "AbortError") throw new RelayError("RELAY_TIMEOUT", true);
      throw new RelayError("RELAY_UNAVAILABLE", true);
    } finally { clearTimeout(timer); }
  }
}
