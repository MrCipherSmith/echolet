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
