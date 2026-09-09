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
 * A LIST ITEM IS NOT ALWAYS ONE LINE. Flow 004 T28 gave the conversation pane a second row per
 * message — the metadata on one line, the body on its own beneath it — because a message id and a
 * body cannot both fit in 72 columns and the body is what the pane exists for. An item is therefore
 * a `string` or an array of the lines it occupies, and truncation drops WHOLE ITEMS: a half-painted
 * message with its own metadata missing is not a shorter list, it is a wrong one.
 *
 * The count in `truncationMarker` is a count of ITEMS for the same reason it always was — "how much
 * of this list am I not looking at" is a question about messages, not about rows of text.
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

/**
 * One item of a pane's list: a single line, or every line that one item occupies.
 *
 * A bare `string` is the one-line case spelled the way it always was, so a pane whose items are one
 * line each passes exactly what it passed before and gets exactly what it got before.
 */
export type PaneRow = string | readonly string[];

/** The lines one item occupies. */
function rowLines(row: PaneRow): readonly string[] {
  return typeof row === "string" ? [row] : row;
}

export interface PaneRegions {
  /** Fixed lines above the list — the pane's own headings and disclosures. */
  readonly head: readonly string[];
  /** The list. The only region truncation is allowed to take items from. */
  readonly rows: readonly PaneRow[];
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
 * How many list ITEMS survive, taken from the `keep` end, and how many lines they cost.
 *
 * The floor is one item whenever there is any room at all: a pane reduced to headings and a marker
 * has not been truncated, it has been emptied (rule 2 below). Past that floor an item is taken only
 * if all of its lines fit, because half a message is worse than an honest count of whole ones.
 */
function keepItems(rows: readonly PaneRow[], keep: KeepEnd, room: number, budget: number): { kept: PaneRow[]; used: number } {
  const kept: PaneRow[] = [];
  let used = 0;
  if (room <= 0) return { kept, used };
  const ordered = keep === "tail" ? [...rows].reverse() : rows;
  for (const row of ordered) {
    const height = rowLines(row).length;
    if (kept.length > 0 && used + height > budget) break;
    kept.push(row);
    used += height;
    if (used >= budget) break;
  }
  if (keep === "tail") kept.reverse();
  return { kept, used };
}

/**
 * Lays out one pane's regions into at most `limit` lines, each clipped to `width`.
 *
 * When everything fits, this is the concatenation and nothing else happens. When it does not:
 *
 * 1. one line is spent on `truncationMarker`, so the pane always says that it is short and by how
 *    much before it drops anything;
 * 2. the list keeps at least one item whenever it has one and there is room for it — a pane reduced
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
  const listLines = regions.rows.flatMap((row) => [...rowLines(row)]);
  const all = [...regions.head, ...listLines, ...tail];

  if (!Number.isFinite(limit)) return all.map(clip);
  const cap = Math.max(0, Math.floor(limit));
  if (all.length <= cap) return all.map(clip);
  // Nothing to truncate honestly: with no list items there is no count to report, so the pane is
  // simply cut. This is the pre-existing behaviour for panes that have no list at all.
  if (regions.rows.length === 0) return all.slice(0, cap).map(clip);

  const room = Math.max(0, cap - 1);
  const wanted = regions.head.length + tail.length;
  const { kept, used } = keepItems(regions.rows, regions.keep, room, room - wanted);

  const fixed = Math.max(0, Math.min(wanted, room - used));
  const headRoom = Math.min(regions.head.length, fixed);
  const tailRoom = Math.max(0, fixed - headRoom);

  return [
    ...regions.head.slice(0, headRoom),
    ...kept.flatMap((row) => [...rowLines(row)]),
    truncationMarker(regions.rows.length - kept.length),
    ...tail.slice(tail.length - tailRoom),
  ].slice(0, cap).map(clip);
}
