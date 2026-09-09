import { fitPane } from "./pane-fit";
import type { HistoryEntryView } from "./state";
import { codePoints } from "./text";

/**
 * Decrypted history for ONE explicitly selected contact.
 *
 * The runbook (§9) states the rule this module exists to keep: "Plaintext is readable **only**
 * here, on the owner's explicit request; it never crosses the relay API." The CLI enforces it by
 * requiring `history --with <identity-id>` — there is no command that dumps every conversation.
 *
 * A TUI is where that guarantee is easiest to lose, because a pane naturally holds every entry it
 * has ever fetched and a careless renderer shows them all. `buildHistorySnapshot` therefore drops
 * the plaintext of every entry that does not belong to the selected contact before formatting, and
 * reports how many were withheld, so the operator sees that something was hidden rather than
 * nothing at all. With no contact selected, no plaintext is rendered.
 *
 * ── WHAT A MESSAGE OCCUPIES, AND WHY IT IS TWO ROWS ───────────────────────────────────────────
 *
 * MEASURED (004-T25-verify F-001, on a live run against a real relay): a message arrived, was
 * decrypted, was committed to the store — and could not be read. The pane painted
 * `  <sequence>  <direction>  <messageId>  <plaintext>` on ONE line, and a 36-character UUID plus
 * its separators cost 52 of the 72 columns the minimum viewport has. The two real bodies were 50
 * and 51 characters; the operator saw twenty of them.
 *
 * The id could not simply be deleted to pay for the body. `runtime/inbound.ts` keys the inbox by it,
 * `runtime/outbound.ts` retries by it — which is what makes an exact retry byte-identical — the
 * threat model requires deduplication by it, and the runbook's §9 comparison, the same message read
 * as `outbound` on one screen and `inbound` on another, is performed on it. Nor could it be
 * shortened enough: an 8-character prefix still leaves only 48 columns at 72, three short of the
 * message this flow's own end-to-end test sends, and eliding a real message by three characters is
 * the worst kind of nearly-working.
 *
 * So the message gets a ROW OF ITS OWN. The metadata that DESCRIBES a message keeps its line in
 * full — sequence, direction and the whole id — and the message itself is painted beneath it,
 * indented, across as many rows as it needs up to `MAX_BODY_ROWS`. At the minimum viewport that is
 * 68 columns per row instead of 20, and a 51-character body is read whole. Describing a thing no
 * longer costs more than the thing described.
 */

/** Everything that DESCRIBES a message, and the message itself, kept apart so layout can spend differently on each. */
export interface HistoryLine {
  /** `sequence  direction  messageId` — the three fields the runbook's §9 comparison reads. */
  readonly meta: string;
  /** The decrypted body. */
  readonly body: string;
}

export interface HistorySnapshot {
  readonly contactIdentityId: string | null;
  readonly lines: readonly HistoryLine[];
  /** Entries for other contacts that this pane deliberately did not render. */
  readonly withheldCount: number;
}

/**
 * The body's own rows are indented, so that they read as a continuation of the line above rather
 * than as a second message with its metadata missing.
 */
const BODY_INDENT = "    ";

/**
 * How many rows ONE message's body may spend before it is elided.
 *
 * A bound is necessary and not a convenience: the pane has eleven rows at `MIN_VIEWPORT`, and an
 * unbounded body would evict an entire conversation from the screen to show one message nobody
 * asked to see in full. Four rows is 272 columns at the minimum viewport — an order of magnitude
 * more than the twenty this pane used to show, and more than any body the flow has measured.
 *
 * Past it the body is cut and SAYS SO with `ELLIPSIS`, which is flow 003 AC7 on this pane: the
 * console never hides data without saying so. The whole body remains available from
 * `history --with <identity-id>`, which is where an exact value belongs anyway.
 */
const MAX_BODY_ROWS = 4;

/** The character this codebase already spends on "there is more here than is shown". */
const ELLIPSIS = "…";

/**
 * One message's body, hard-wrapped into indented rows and elided — visibly — past `MAX_BODY_ROWS`.
 *
 * An empty body takes no row at all: a blank indented line would read as a message that is there
 * and says nothing, which is a different fact from the one the state holds.
 */
export function bodyRows(body: string, width: number): string[] {
  const room = Math.max(1, Math.floor(width) - BODY_INDENT.length);
  const points = codePoints(body);
  if (points.length === 0) return [];

  const wrapped: string[] = [];
  for (let at = 0; at < points.length; at += room) wrapped.push(points.slice(at, at + room).join(""));
  if (wrapped.length <= MAX_BODY_ROWS) return wrapped.map((row) => `${BODY_INDENT}${row}`);

  const kept = wrapped.slice(0, MAX_BODY_ROWS);
  const last = codePoints(kept[MAX_BODY_ROWS - 1] ?? "");
  kept[MAX_BODY_ROWS - 1] = `${last.slice(0, Math.max(0, room - 1)).join("")}${ELLIPSIS}`;
  return kept.map((row) => `${BODY_INDENT}${row}`);
}

export function buildHistorySnapshot(source: {
  readonly entries: readonly HistoryEntryView[];
  readonly selectedContactId: string | null;
}): HistorySnapshot {
  const { entries, selectedContactId } = source;

  // With nothing selected the pane is CLOSED, not open: an operator who has just started the TUI
  // has not made an explicit request for anyone's plaintext yet. The snapshot therefore holds no
  // plaintext at all — not merely a formatter that declines to print it.
  if (selectedContactId === null) {
    return { contactIdentityId: null, lines: [], withheldCount: entries.length };
  }

  const selected = entries.filter((entry) => entry.contactIdentityId === selectedContactId);
  // The runbook's §9 comparison is what this pane is for: the same messageId appears as `outbound`
  // on one side and `inbound` on the other, with matching sequences. All three stay on the metadata
  // line in full; the body is a separate field because it is laid out separately.
  const lines = selected.map((entry): HistoryLine => ({
    meta: `${entry.sequence}  ${entry.direction}  ${entry.messageId}`,
    body: entry.plaintext,
  }));
  return { contactIdentityId: selectedContactId, lines, withheldCount: entries.length - selected.length };
}

/**
 * `limit` is the number of body rows the frame has for this pane; `Infinity` (the default) means
 * "no limit", which is what every value-comparison test of this module wants.
 *
 * The entries are the list region and they are kept from the END: an operator opens history to see
 * what just arrived, and a pane that kept the first ten messages a conversation ever contained
 * would discard the message that made them look. The two disclosures — which contact this is, and
 * how many entries belong to other contacts — are fixed regions and survive the truncation that
 * takes rows from the conversation.
 *
 * Each entry is handed over as the LINES IT OCCUPIES rather than as one line, so that `fitPane`
 * drops whole messages and its count stays a count of messages. A half-dropped entry would leave a
 * body with no direction, no sequence and no id above it — unreadable in exactly the way this
 * layout exists to fix.
 */
export function formatHistoryLines(snapshot: HistorySnapshot, width: number, limit = Number.POSITIVE_INFINITY): string[] {
  const head: string[] = [];
  const rows: (readonly string[])[] = [];
  if (snapshot.contactIdentityId === null) {
    head.push("no contact selected — history is shown only on an explicit request");
  } else {
    head.push(`history with ${snapshot.contactIdentityId}`);
    if (snapshot.lines.length === 0) head.push("  no entries for this contact");
    else for (const entry of snapshot.lines) rows.push([`  ${entry.meta}`, ...bodyRows(entry.body, width)]);
  }
  // Silently showing two of four conversations looks identical to having only two.
  const tail = snapshot.withheldCount > 0
    ? ["", `${snapshot.withheldCount} entries withheld (other contacts)`]
    : [];

  return fitPane({ head, rows, tail, keep: "tail" }, limit, width);
}
