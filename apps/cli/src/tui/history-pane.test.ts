import { describe, expect, it } from "vitest";
import { buildHistorySnapshot, formatHistoryLines } from "./history-pane";
import type { HistoryEntryView } from "./state";

// Flow 002 T9 — history renders plaintext for the explicitly selected contact and no one else.
//
// The runbook (§9) states the guarantee: "Plaintext is readable **only** here, on the owner's
// explicit request; it never crosses the relay API." The CLI enforces it by requiring
// `history --with <identity-id>`; there is no command that dumps every conversation.
//
// A TUI is where that is easiest to lose, because a pane naturally accumulates every entry it has
// ever fetched and a careless renderer shows them all. These tests pin the narrowing at the
// snapshot boundary, before any formatting happens, so a later change to layout cannot widen it.

const ALICE = "hbRYeNqVnWC74METcY57eDEkV9qNQ6Qzuz6RpsIYQA";
const BOB = "nps4faW9mNX62tZs5M0oqAWtn05cWtn9gCw0gM1JHA";
const CAROL = "BQdNjP6tbN00N3eS6DNpmKpMDFDeDa4MFuUO1QWt8i";

const ALICE_BODY = "SYNTHETIC_TUI_BODY_ALICE";
const BOB_BODY = "SYNTHETIC_TUI_BODY_BOB";
const CAROL_BODY = "SYNTHETIC_TUI_BODY_CAROL";

const ENTRIES: readonly HistoryEntryView[] = [
  { sequence: 1, contactIdentityId: ALICE, messageId: "4ba942f0-0000-4000-8000-000000000001", direction: "outbound", plaintext: ALICE_BODY, createdAtMs: 1_757_000_000_001 },
  { sequence: 2, contactIdentityId: BOB, messageId: "4ba942f0-0000-4000-8000-000000000002", direction: "inbound", plaintext: BOB_BODY, createdAtMs: 1_757_000_000_002 },
  { sequence: 3, contactIdentityId: BOB, messageId: "4ba942f0-0000-4000-8000-000000000003", direction: "outbound", plaintext: BOB_BODY, createdAtMs: 1_757_000_000_003 },
  { sequence: 4, contactIdentityId: CAROL, messageId: "4ba942f0-0000-4000-8000-000000000004", direction: "inbound", plaintext: CAROL_BODY, createdAtMs: 1_757_000_000_004 },
];

/** Wide enough that nothing under test is truncated; truncation has its own test below. */
const WIDTH = 160;

const paint = (selectedContactId: string | null) =>
  formatHistoryLines(buildHistorySnapshot({ entries: ENTRIES, selectedContactId }), WIDTH).join("\n");

describe("plaintext is rendered only for the explicitly selected contact", () => {
  it("shows the selected contact's bodies and no other contact's", () => {
    const painted = paint(BOB);
    expect(painted).toContain(BOB_BODY);
    expect(painted.includes(ALICE_BODY)).toBe(false);
    expect(painted.includes(CAROL_BODY)).toBe(false);
  });

  it("swaps completely when the selection changes", () => {
    const painted = paint(ALICE);
    expect(painted).toContain(ALICE_BODY);
    expect(painted.includes(BOB_BODY)).toBe(false);
    expect(painted.includes(CAROL_BODY)).toBe(false);
  });

  it("renders no plaintext at all when nothing is selected", () => {
    // The default state of the pane must be closed, not open. An operator who opens the TUI has
    // not made an explicit request for anyone's plaintext yet.
    const painted = paint(null);
    for (const body of [ALICE_BODY, BOB_BODY, CAROL_BODY]) expect(painted.includes(body)).toBe(false);
  });

  it("renders nothing for a contact with no history, rather than falling back to everything", () => {
    const painted = paint("VGhpc0lkZW50aXR5SGFzTm9IaXN0b3J5QXRBbGxYWFhY");
    for (const body of [ALICE_BODY, BOB_BODY, CAROL_BODY]) expect(painted.includes(body)).toBe(false);
  });
});

describe("the narrowing happens in the snapshot, not in the formatter", () => {
  it("drops other contacts' plaintext before formatting, so no layout change can widen it", () => {
    const snapshot = buildHistorySnapshot({ entries: ENTRIES, selectedContactId: BOB });
    expect(snapshot.contactIdentityId).toBe(BOB);
    const serialised = JSON.stringify(snapshot);
    expect(serialised.includes(ALICE_BODY)).toBe(false);
    expect(serialised.includes(CAROL_BODY)).toBe(false);
    expect(serialised).toContain(BOB_BODY);
  });

  it("holds no plaintext whatsoever when nothing is selected", () => {
    const snapshot = buildHistorySnapshot({ entries: ENTRIES, selectedContactId: null });
    const serialised = JSON.stringify(snapshot);
    for (const body of [ALICE_BODY, BOB_BODY, CAROL_BODY]) expect(serialised.includes(body)).toBe(false);
    expect(snapshot.contactIdentityId).toBeNull();
  });

  it("reports how many entries it withheld, so hiding is visible", () => {
    // Silently showing two of four conversations looks identical to having only two.
    expect(buildHistorySnapshot({ entries: ENTRIES, selectedContactId: BOB }).withheldCount).toBe(2);
    expect(buildHistorySnapshot({ entries: ENTRIES, selectedContactId: ALICE }).withheldCount).toBe(3);
    expect(buildHistorySnapshot({ entries: ENTRIES, selectedContactId: null }).withheldCount).toBe(4);
    expect(buildHistorySnapshot({ entries: [], selectedContactId: BOB }).withheldCount).toBe(0);
  });
});

describe("the selected contact's history is shown usefully", () => {
  it("keeps direction, sequence and message id alongside the body", () => {
    // The runbook's §9 comparison is the point of this pane: the same messageId appears as
    // `outbound` on one side and `inbound` on the other, with matching sequences.
    const painted = paint(BOB);
    expect(painted).toContain("inbound");
    expect(painted).toContain("outbound");
    expect(painted).toContain("4ba942f0-0000-4000-8000-000000000002");
    expect(painted).toContain("4ba942f0-0000-4000-8000-000000000003");
  });

  it("respects the width it is given", () => {
    for (const width of [40, 72, 100, 200]) {
      for (const line of formatHistoryLines(buildHistorySnapshot({ entries: ENTRIES, selectedContactId: BOB }), width)) {
        expect([...line].length).toBeLessThanOrEqual(width);
      }
    }
  });

  it("is deterministic", () => {
    const snapshot = buildHistorySnapshot({ entries: ENTRIES, selectedContactId: BOB });
    expect(formatHistoryLines(snapshot, WIDTH)).toEqual(formatHistoryLines(snapshot, WIDTH));
  });
});
