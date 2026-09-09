import { fitPane } from "./pane-fit";
import type { MailboxView, RejectionView } from "./state";
import { formatInstant, labelled } from "./text";

/**
 * Outbox and inbox state, and the rejected envelopes from the last `poll`.
 *
 * specification.md §`poll` result: each rejection carries "only `{ envelopeId, code }` and no
 * envelope content". `runtime/inbound.ts` says the same about `RejectedEnvelope`, because that
 * value is returned verbatim to stdout. A rendering layer that widened it — by printing whatever
 * else happened to be on the object, or by echoing a relay-supplied message — would put
 * sender-controlled bytes on the operator's screen and undo the guarantee at the last step.
 * `formatRejectionLine` therefore reads exactly two properties and nothing else.
 */

export interface MailboxRow {
  readonly label: string;
  readonly value: string;
}

/**
 * A count no command reported, rendered as words rather than as a digit or as a sentinel.
 *
 * Both failures here have been shipped by real programs: printing the sentinel (`${null} pending` is
 * "null pending", which reads as a bug rather than as an absence) and printing a digit that came
 * from nowhere. `0` is a figure a command really can report — a poll that accepted nothing reports
 * exactly that — so it renders as `0` and is never conflated with silence.
 */
function countedValue(count: number | null, unit: string, absent: string): string {
  return count === null ? absent : `${String(count)} ${unit}`;
}

export interface MailboxSnapshot {
  readonly rows: readonly MailboxRow[];
  readonly rejectionLines: readonly string[];
  readonly rejectionCount: number;
}

export function buildMailboxSnapshot(source: {
  readonly mailbox: MailboxView;
  readonly rejections: readonly RejectionView[];
}): MailboxSnapshot {
  const { mailbox, rejections } = source;
  const rows: MailboxRow[] = [
    // Two rows, two different silences, and each says which one it is.
    //
    // The outbox row is empty because the frozen eight-command surface has nothing that reports a
    // pending count (see `MailboxView`), so the row names the gap rather than disappearing: an
    // operator who cannot see that the console has no view of its own outbox will assume it has one.
    // The inbox row is empty only until the first poll, which is a different sentence.
    { label: "outbox", value: countedValue(mailbox.outboxPending, "pending", "no command reports an outbox count") },
    // "received" is what the LAST poll accepted and committed, not a session or store total, so the
    // row says which poll it is talking about. The `last poll` row below carries when that was.
    { label: "inbox", value: countedValue(mailbox.inboxReceived, "received by the last poll", "no poll has reported yet") },
    // The relay's remaining-work signal is what tells the operator to poll again; a pane that hid
    // it would make a partially drained mailbox look empty.
    { label: "more", value: mailbox.more ? "yes — poll again" : "no" },
    { label: "last poll", value: formatInstant(mailbox.lastPolledAtMs) },
  ];

  // The narrowing happens here, at the snapshot boundary, so the snapshot itself cannot carry a
  // sender-controlled byte that a later formatting change might reveal.
  return { rows, rejectionLines: rejections.map(formatRejectionLine), rejectionCount: rejections.length };
}

/**
 * `limit` is the number of body rows the frame has for this pane; `Infinity` (the default) means
 * "no limit", which is what every value-comparison test of this module wants.
 *
 * The rejection list is the only region truncation may take rows from, and it is kept from the END:
 * a rejection the operator has already seen is one they have already decided about, and `poll`
 * reports rejections in arrival order, so the untriaged ones are at the tail.
 */
export function formatMailboxLines(snapshot: MailboxSnapshot, width: number, limit = Number.POSITIVE_INFINITY): string[] {
  const head: string[] = snapshot.rows.map((row) => labelled(row.label, row.value));
  if (snapshot.rejectionCount > 0) {
    head.push("");
    head.push(labelled("rejected", `${snapshot.rejectionCount} permanently unacceptable`));
  }
  const rows = snapshot.rejectionLines.map((rejection) => `  ${rejection}`);
  return fitPane({ head, rows, keep: "tail" }, limit, width);
}

/**
 * Renders exactly `envelopeId` and `code`, whatever else the value carries at runtime.
 *
 * A rejected envelope is by definition one an untrusted or hostile sender put in the mailbox, so
 * anything beyond those two fields would be sender-controlled bytes on the operator's screen. The
 * two properties are read by name; the value is never stringified wholesale.
 */
export function formatRejectionLine(rejection: RejectionView): string {
  return `${rejection.envelopeId}  ${rejection.code}`;
}
