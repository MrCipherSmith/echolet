/**
 * The bounds more than one layer of this package has to agree on.
 *
 * A leaf module with no imports of its own, so the pure TUI layer can read a limit without pulling
 * the runtime — `runtime/outbound.ts` reaches the encrypted store, the relay client and libsignal
 * through its own imports, and a renderer that had to load all of that to learn one number would
 * have paid for the number with the purity the whole `src/tui` design rests on.
 *
 * This is the "leaf module in `apps/cli` imported by both" that t35 §8 Q2 names as one of the two
 * homes for the plaintext bound. The other — a constant in `packages/protocol` — is still open, and
 * moving the value there later is a change to this file and to nothing that reads it.
 */

/**
 * The largest message body this client will encrypt, in bytes.
 *
 * It was a bare `65536` written twice in `runtime/outbound.ts` — once as the schema's character
 * bound and once as the byte bound — and `commands/cli.ts` enforcing the same limit while reading a
 * body from stdin would have made a third. The operator console composing a body is now the fourth
 * reader: it refuses an insertion that would carry the buffer past this number, so a message the
 * console accepted cannot be one the CLI then refuses with `INVALID_MESSAGE` at exit 2.
 *
 * One name, one value: a reader that has to bound a plaintext imports this rather than restating
 * the number, so the console's compose row, the CLI's stdin guard and the messenger's own refusal
 * can never drift apart the way the message-size constants on the two sides of the wire once did.
 */
export const MAX_PLAINTEXT_BYTES = 65536;
