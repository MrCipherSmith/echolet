import type { MailboxView, RejectionView } from "./state";
import { clipLine, formatInstant, labelled } from "./text";

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
    { label: "outbox", value: `${mailbox.outboxPending} pending` },
    { label: "inbox", value: `${mailbox.inboxReceived} received` },
    // The relay's remaining-work signal is what tells the operator to poll again; a pane that hid
    // it would make a partially drained mailbox look empty.
    { label: "more", value: mailbox.more ? "yes — poll again" : "no" },
    { label: "last poll", value: formatInstant(mailbox.lastPolledAtMs) },
  ];

  // The narrowing happens here, at the snapshot boundary, so the snapshot itself cannot carry a
  // sender-controlled byte that a later formatting change might reveal.
  return { rows, rejectionLines: rejections.map(formatRejectionLine), rejectionCount: rejections.length };
}

export function formatMailboxLines(snapshot: MailboxSnapshot, width: number): string[] {
  const lines: string[] = snapshot.rows.map((row) => clipLine(labelled(row.label, row.value), width));
  if (snapshot.rejectionCount > 0) {
    lines.push("");
    lines.push(clipLine(labelled("rejected", `${snapshot.rejectionCount} permanently unacceptable`), width));
    for (const rejection of snapshot.rejectionLines) lines.push(clipLine(`  ${rejection}`, width));
  }
  return lines;
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
