import { clipLine } from "./text";

/**
 * The one place a pane is allowed to drop a row, and the reason it is a module of its own.
 *
 * Flow 003 AC7: "The console never hides data without saying so: a truncated pane states that it is
 * truncated and how many rows are not shown, and keeps the rows an operator needs rather than the
 * oldest." Before this module every pane handed `renderFrame` a flat list of lines and the frame
 * took `.slice(0, bodyRows)` — a PREFIX, silently. Thirty history entries rendered the first ten and
 * said nothing, so "two conversations" and "two of four conversations" looked identical, and the
 * message that made the operator open the pane was the one thrown away.
 *
 * A pane therefore no longer hands over a flat list. It hands over three regions:
 *
 * - `head` — the pane's own fixed lines and disclosures, read first;
 * - `rows` — the variable-length list, the only region that may be truncated;
 * - `tail` — fixed lines that belong after the list.
 *
 * `keep` says which end of `rows` survives. It is a per-pane decision and not a global rule:
 * history and rejections are feeds, where the newest rows are the ones the operator came for; the
 * contact roster is a SELECTION surface whose display order has to be decided together with the `c`
 * cycle, so it keeps its head and its order is deliberately not changed here.
 *
 * Pure, total and deterministic, like everything else the frame is built from: no clock, no
 * environment, no mutation of its input.
 */

export type KeepEnd = "head" | "tail";

export interface PaneRegions {
  /** Fixed lines above the list — the pane's own headings and disclosures. */
  readonly head: readonly string[];
  /** The list. The only region truncation is allowed to take rows from. */
  readonly rows: readonly string[];
  /** Fixed lines below the list. */
  readonly tail?: readonly string[];
  /** Which end of `rows` survives when they do not all fit. */
  readonly keep: KeepEnd;
}

/**
 * The line a truncated pane spends one of its rows on.
 *
 * It names the number of LIST rows that are not shown, which is the number the operator can act on:
 * "how much of this list am I not looking at". It is deliberately not a count of dropped output
 * lines, because a pane's own heading is not a row of data.
 */
export function truncationMarker(hidden: number): string {
  return `… ${String(hidden)} more not shown`;
}

/**
 * Lays out one pane's regions into at most `limit` lines, each clipped to `width`.
 *
 * When everything fits, this is the concatenation and nothing else happens. When it does not:
 *
 * 1. one line is spent on `truncationMarker`, so the pane always says that it is short and by how
 *    much before it drops anything;
 * 2. the list keeps at least one row whenever it has one and there is room for it — a pane reduced
 *    to headings and a marker has not been truncated, it has been emptied;
 * 3. whatever is left goes to the fixed regions, `head` before `tail`, so the lines nearest the top
 *    of the pane — which is where every pane puts what it is and what it is not showing — are the
 *    last to go.
 *
 * `limit` may be any number, including a non-integer, a negative one or `Infinity`; the result is
 * always between 0 and `limit` lines.
 */
export function fitPane(regions: PaneRegions, limit: number, width: number): string[] {
  const tail = regions.tail ?? [];
  const clip = (line: string): string => clipLine(line, width);
  const all = [...regions.head, ...regions.rows, ...tail];

  if (!Number.isFinite(limit)) return all.map(clip);
  const cap = Math.max(0, Math.floor(limit));
  if (all.length <= cap) return all.map(clip);
  // Nothing to truncate honestly: with no list rows there is no count to report, so the pane is
  // simply cut. This is the pre-existing behaviour for panes that have no list at all.
  if (regions.rows.length === 0) return all.slice(0, cap).map(clip);

  const room = Math.max(0, cap - 1);
  const wanted = regions.head.length + tail.length;
  const floor = Math.min(regions.rows.length, room, 1);
  const shown = Math.max(floor, Math.min(regions.rows.length, room - wanted));
  const kept = regions.keep === "tail"
    ? regions.rows.slice(regions.rows.length - shown)
    : regions.rows.slice(0, shown);

  const fixed = Math.max(0, Math.min(wanted, room - shown));
  const headRoom = Math.min(regions.head.length, fixed);
  const tailRoom = Math.max(0, fixed - headRoom);

  return [
    ...regions.head.slice(0, headRoom),
    ...kept,
    truncationMarker(regions.rows.length - shown),
    ...tail.slice(tail.length - tailRoom),
  ].slice(0, cap).map(clip);
}
