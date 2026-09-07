import type { HistoryEntryView } from "./state";
import { clipLine } from "./text";

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
 */

export interface HistorySnapshot {
  readonly contactIdentityId: string | null;
  readonly lines: readonly string[];
  /** Entries for other contacts that this pane deliberately did not render. */
  readonly withheldCount: number;
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
  // on one side and `inbound` on the other, with matching sequences.
  const lines = selected.map((entry) => `${entry.sequence}  ${entry.direction}  ${entry.messageId}  ${entry.plaintext}`);
  return { contactIdentityId: selectedContactId, lines, withheldCount: entries.length - selected.length };
}

export function formatHistoryLines(snapshot: HistorySnapshot, width: number): string[] {
  const lines: string[] = [];
  if (snapshot.contactIdentityId === null) {
    lines.push(clipLine("no contact selected — history is shown only on an explicit request", width));
  } else {
    lines.push(clipLine(`history with ${snapshot.contactIdentityId}`, width));
    if (snapshot.lines.length === 0) lines.push(clipLine("  no entries for this contact", width));
    else for (const entry of snapshot.lines) lines.push(clipLine(`  ${entry}`, width));
  }
  if (snapshot.withheldCount > 0) {
    // Silently showing two of four conversations looks identical to having only two.
    lines.push("");
    lines.push(clipLine(`${snapshot.withheldCount} entries withheld (other contacts)`, width));
  }
  return lines;
}
