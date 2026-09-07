import { describe, expect, it } from "vitest";
import { buildMailboxSnapshot, formatMailboxLines, formatRejectionLine } from "./mailbox-pane";
import type { MailboxView, RejectionView } from "./state";

// Flow 002 T9 — rejected envelopes render `{ envelopeId, code }` and nothing else.
//
// specification.md §`poll` result: rejections carry "only `{ envelopeId, code }` and no envelope
// content", and `runtime/inbound.ts` repeats it, because that value goes verbatim to stdout.
//
// The rendering layer is the last place the guarantee can be lost, and the way it would be lost is
// mundane: a formatter that stringifies whatever object it is handed. A rejected envelope is, by
// definition, one an untrusted or hostile sender put in the mailbox, so anything beyond those two
// fields is sender-controlled bytes on the operator's screen. `formatRejectionLine` therefore
// reads exactly two properties, and the test proves it by handing it an object carrying more.

const MAILBOX: MailboxView = { outboxPending: 2, inboxReceived: 1, more: true, lastPolledAtMs: 1_757_000_000_000 };

const REJECTIONS: readonly RejectionView[] = [
  { envelopeId: "94a6f678-0000-4000-8000-000000000001", code: "SENDER_NOT_TRUSTED" },
  { envelopeId: "94a6f678-0000-4000-8000-000000000002", code: "INVALID_ENVELOPE" },
  { envelopeId: "94a6f678-0000-4000-8000-000000000003", code: "MESSAGE_ID_CONFLICT" },
];

const WIDTH = 120;

describe("a rejection renders its two fields and nothing else", () => {
  it("shows the envelope id and the code", () => {
    const line = formatRejectionLine({ envelopeId: "94a6f678-0000-4000-8000-000000000001", code: "SENDER_NOT_TRUSTED" });
    expect(line).toContain("94a6f678-0000-4000-8000-000000000001");
    expect(line).toContain("SENDER_NOT_TRUSTED");
  });

  it("ignores every other property the value happens to carry at runtime", () => {
    // `poll`'s result is parsed from the CLI's JSON output. A relay or a sender that widened the
    // object must not be able to put its own bytes on the operator's screen through this pane.
    const hostile = {
      envelopeId: "94a6f678-0000-4000-8000-000000000009",
      code: "SENDER_NOT_TRUSTED",
      ciphertext: "SYNTHETIC_CIPHERTEXT_MARKER",
      plaintext: "SYNTHETIC_PLAINTEXT_MARKER",
      senderIdentityId: "SYNTHETIC_SENDER_MARKER",
      note: "SYNTHETIC_NOTE_MARKER",
    } as unknown as RejectionView;

    const line = formatRejectionLine(hostile);

    expect(line).toContain("94a6f678-0000-4000-8000-000000000009");
    expect(line).toContain("SENDER_NOT_TRUSTED");
    for (const marker of ["SYNTHETIC_CIPHERTEXT_MARKER", "SYNTHETIC_PLAINTEXT_MARKER", "SYNTHETIC_SENDER_MARKER", "SYNTHETIC_NOTE_MARKER"]) {
      expect(line.includes(marker)).toBe(false);
    }
    for (const property of ["ciphertext", "plaintext", "senderIdentityId", "note"]) {
      expect(line.includes(property)).toBe(false);
    }
  });

  it("carries the same narrowing through the snapshot and the formatted pane", () => {
    const hostile = {
      envelopeId: "94a6f678-0000-4000-8000-000000000009",
      code: "SENDER_NOT_TRUSTED",
      ciphertext: "SYNTHETIC_CIPHERTEXT_MARKER",
    } as unknown as RejectionView;

    const snapshot = buildMailboxSnapshot({ mailbox: MAILBOX, rejections: [hostile] });

    expect(JSON.stringify(snapshot).includes("SYNTHETIC_CIPHERTEXT_MARKER")).toBe(false);
    expect(formatMailboxLines(snapshot, WIDTH).join("\n").includes("SYNTHETIC_CIPHERTEXT_MARKER")).toBe(false);
  });
});

describe("the pane reports queue state the operator can act on", () => {
  it("renders one line per rejection, in the order the poll read them", () => {
    const snapshot = buildMailboxSnapshot({ mailbox: MAILBOX, rejections: REJECTIONS });
    expect(snapshot.rejectionCount).toBe(REJECTIONS.length);
    expect(snapshot.rejectionLines.length).toBe(REJECTIONS.length);
    const painted = formatMailboxLines(snapshot, WIDTH).join("\n");
    for (const rejection of REJECTIONS) {
      expect(painted).toContain(rejection.envelopeId);
      expect(painted).toContain(rejection.code);
    }
  });

  it("shows outbox, inbox and the relay's remaining-work signal", () => {
    // `more` is what tells the operator to poll again; a pane that hid it would make a partially
    // drained mailbox look empty.
    const painted = formatMailboxLines(buildMailboxSnapshot({ mailbox: MAILBOX, rejections: [] }), WIDTH).join("\n").toLowerCase();
    expect(painted).toContain("outbox");
    expect(painted).toContain("inbox");
    expect(painted).toContain("more");
  });

  it("renders an empty mailbox without a rejection section", () => {
    const snapshot = buildMailboxSnapshot({ mailbox: { outboxPending: 0, inboxReceived: 0, more: false, lastPolledAtMs: null }, rejections: [] });
    expect(snapshot.rejectionCount).toBe(0);
    expect(snapshot.rejectionLines).toEqual([]);
    expect(() => formatMailboxLines(snapshot, WIDTH)).not.toThrow();
  });

  it("respects the width it is given and is deterministic", () => {
    const snapshot = buildMailboxSnapshot({ mailbox: MAILBOX, rejections: REJECTIONS });
    for (const width of [40, 72, 120, 200]) {
      for (const line of formatMailboxLines(snapshot, width)) expect([...line].length).toBeLessThanOrEqual(width);
    }
    expect(formatMailboxLines(snapshot, WIDTH)).toEqual(formatMailboxLines(snapshot, WIDTH));
  });
});
