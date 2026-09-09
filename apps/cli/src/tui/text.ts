/**
 * The two width primitives the whole pure layer is built on, kept in a leaf module so that
 * `shell-chrome.ts` can compose the panes without any pane having to import it back. A cycle
 * between the frame renderer and the panes would be harmless at runtime and confusing to read;
 * one leaf module with no imports of its own removes the question.
 *
 * Printable width is counted in CODE POINTS, not UTF-16 units. The CLI's own evidence sends
 * Cyrillic, and a width primitive that counted `.length` would make every frame containing a
 * non-ASCII body the wrong width. Combining marks and East Asian wide characters are out of scope
 * for this prototype and are recorded as such in the design note.
 */

/** The code points of `text`, which is what "one column" means everywhere in `src/tui`. */
export function codePoints(text: string): string[] {
  return [...text];
}

/**
 * The UTF-8 byte length of `text`, which is what every bound this console must respect counts in.
 *
 * `outbound.ts` re-checks a plaintext with `Buffer.byteLength` before it encrypts one, so a console
 * that bounded a compose buffer in code points would accept a body the CLI then refuses. Pure, and
 * therefore usable from both the reducer and the renderer.
 */
export function utf8Bytes(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

/** Truncates to at most `width` code points. Never pads: panes are laid out inside a frame. */
export function clipLine(text: string, width: number): string {
  const limit = Math.max(0, Math.floor(width));
  const points = codePoints(text);
  return points.length <= limit ? text : points.slice(0, limit).join("");
}

/** Pads or truncates to exactly `width` code points. */
export function padOrClip(text: string, width: number): string {
  const limit = Math.max(0, Math.floor(width));
  const points = codePoints(text);
  if (points.length >= limit) return points.slice(0, limit).join("");
  return text + " ".repeat(limit - points.length);
}

/** `label` in a fixed gutter, then `value`. The gutter keeps a pane's values in one column. */
export function labelled(label: string, value: string, gutter = 16): string {
  return `${padOrClip(label, gutter)}${value}`;
}

/**
 * True for every code point that can make a frame say something other than what the state holds.
 *
 * It lives in this leaf module, and not in the renderer or in either of its two callers, because
 * there is exactly ONE such predicate: two boundaries with two predicates would be one more thing to
 * keep in agreement than a security property should have. `tui-shell.ts` filters everything that
 * enters the state through it; `failure-text.ts` filters the CLI's own error code through it before
 * composing that code into prose a frame will carry.
 *
 * Two classes, together because the property is one property.
 *
 * CONTROL POINTS — C0 (U+0000..U+001F), DEL (U+007F), C1 (U+0080..U+009F). ESC starts a sequence the
 * terminal executes; a C1 byte IS a control sequence with no ESC in front of it.
 *
 * DISPLAY-STEERING POINTS — none of these is a control character and none can start an escape
 * sequence, so AC7 as frozen does not name them; they are here because each one makes the same lie
 * possible by other means:
 *
 * - THE BIDI CONTROLS (U+200E, U+200F, U+202A..U+202E, U+2066..U+2069) reorder the rest of the line.
 *   `formatHistoryLines` (history-pane.ts:41) paints `sequence  direction  messageId  plaintext` on
 *   ONE line, so an override inside a correspondent's plaintext reorders the fields painted before
 *   it, and a stranger can make their own inbound message render with `outbound` where the operator
 *   reads the direction. In the trust modal the damage is more direct: an identifier that renders in
 *   an order it was not written in cannot be compared out of band, which is the one thing the modal
 *   exists to let a human do. On the compose row it defeats the painted-at gate itself.
 * - THE SEPARATORS (U+2028, U+2029) are line terminators some terminals honour, so a frame's
 *   exactly-rows-by-cols promise would hold in the value and break on the screen — the one place it
 *   was made.
 * - U+FEFF is zero-width, so it can sit inside a base64url identifier and make two different
 *   identifiers paint identically.
 *
 * DELIBERATELY ABSENT, and this is an enumeration of what STEERS A DISPLAY rather than of Unicode's
 * `Cf` category for exactly this reason: U+200B ZERO WIDTH SPACE and U+00AD SOFT HYPHEN are
 * invisible but reorder nothing, terminate no line, and are legitimate in prose. U+200D ZERO WIDTH
 * JOINER is excluded for a stronger reason still — it is load-bearing inside emoji sequences, so
 * refusing it would corrupt ordinary message bodies rather than defend them.
 *
 * A numeric predicate rather than a regular expression with literal bytes: an invisible literal in a
 * source file is a character no reviewer can see and no diff can show, and searching the pure layer
 * for one has to stay a meaningful check.
 */
export function steersTheDisplay(point: string): boolean {
  const code = point.codePointAt(0) ?? 0;
  if (code <= 0x1f || code === 0x7f || (code >= 0x80 && code <= 0x9f)) return true;
  if (code === 0x200e || code === 0x200f) return true;
  if (code >= 0x202a && code <= 0x202e) return true;
  if (code >= 0x2066 && code <= 0x2069) return true;
  return code === 0x2028 || code === 0x2029 || code === 0xfeff;
}

/**
 * `text` with every steering point removed, iterated by code point so an astral pair survives.
 *
 * A FILTER, not a rejection and not a placeholder: the printable remainder is kept, because an
 * inbound body the operator never sees is a worse outcome than one with two characters missing, and
 * a console that dropped the entry would also hide the fact that a correspondent tried this at all.
 */
export function paintable(text: string): string {
  return [...text].filter((point) => !steersTheDisplay(point)).join("");
}

/**
 * A fixed, timezone-independent rendering of an epoch millisecond value.
 *
 * `renderFrame` must be deterministic and must not read the environment, so a local-time format is
 * not available to it: the same state would paint differently on two machines and the asserted
 * frame would not be the frame the operator saw.
 */
export function formatInstant(atMs: number | null): string {
  if (atMs === null || !Number.isFinite(atMs)) return "never";
  return `${new Date(atMs).toISOString().slice(0, 19).replace("T", " ")}Z`;
}
