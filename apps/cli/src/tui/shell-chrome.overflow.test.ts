import { describe, expect, it } from "vitest";
import { MIN_VIEWPORT, UNAUDITED_NOTICE, renderFrame } from "./shell-chrome";
import type { ContactView, HistoryEntryView, OperatorState, RejectionView } from "./state";

// Flow 003 T5 — D-2: a pane that does not fit must say so.
//
// MEASURED (flow 003 T2 §7, U5): 30 history entries render 10 and drop 20 with no marker of any
// kind; 16 entries render 11. The same silent `slice` reaches the contact roster and the rejections
// list. An operator reading a truncated pane cannot tell it from a complete one, which makes it a
// correctness defect rather than a comfort feature: "two conversations" and "two of four
// conversations" look identical.
//
// The pin is exactly the dispatch's sentence — a truncated pane says so, and says how many rows are
// not shown. It is deliberately NOT a pin on ordering or on a paging key: those are design choices
// for U5, and the count is what makes the display honest either way.
//
// The count is derived from the frame itself rather than from layout arithmetic, so the assertion
// stays true whatever number of body rows a later layout leaves: `hidden` is (rows supplied) minus
// (rows the frame actually shows), and the marker must name that number.

const ESC = String.fromCharCode(27);

/** Words a marker may use. The pin is that the operator is told, not which verb was chosen. */
const MARKER = /\b(more|hidden|not shown|truncated|remaining|others)\b/i;

const CONTACT_ID = "nps4faW9mNX62tZs5M0oqAWtn05cWtn9gCw0gM1JHA";

const PROFILE = {
  label: "alice",
  profileDir: "/tmp/echolet-demo/alice",
  relayUrl: "http://127.0.0.1:18099",
  storeKeyEnv: "ECHOLET_E2E_KEY",
  identityId: "hbRYeNqVnWC74METcY57eDEkV9qNQ6Qzuz6RpsIYQA",
  deviceId: "733d80b0-e7e2-5e6c-ba84-0bcd96a373ea",
  contactCount: 30,
  published: true,
} as const;

/** Two-digit tags so that a rendered row is unambiguous and short enough to survive clipping. */
const tags = (count: number): string[] => Array.from({ length: count }, (_, index) => String(index + 1).padStart(2, "0"));

function stateWith(overrides: Partial<OperatorState>): OperatorState {
  return {
    profiles: [PROFILE],
    activeProfile: 0,
    contacts: [],
    selectedContactId: CONTACT_ID,
    mailbox: { outboxPending: 0, inboxReceived: 30, more: false, lastPolledAtMs: 1_757_000_000_000 },
    rejections: [],
    history: [],
    health: { relayUrl: PROFILE.relayUrl, status: "healthy", uptimeMs: null, checkedAtMs: 1_757_000_000_000 },
    pane: "profiles",
    modal: undefined,
    activity: [{ at: 1_757_000_000_000, text: "poll → ok (exit 0)" }],
    busy: false,
    ...overrides,
  };
}

/**
 * Asserts the frame's shape and the notice — the flow 002 acceptance criteria this pin must not
 * break — and then that the frame confesses to hiding `supplied - visible` rows.
 */
function expectTruncationIsDeclared(frame: readonly string[], supplied: readonly string[]): void {
  expect(frame.length).toBe(MIN_VIEWPORT.rows);
  for (const line of frame) {
    expect([...line].length).toBe(MIN_VIEWPORT.cols);
    expect(line.includes(ESC)).toBe(false);
  }
  const painted = frame.join("\n");
  expect(painted).toContain(UNAUDITED_NOTICE);

  const visible = supplied.filter((tag) => painted.includes(tag));
  // The premise of the test: at the minimum viewport this pane genuinely cannot show everything.
  expect(visible.length).toBeLessThan(supplied.length);

  const hidden = supplied.length - visible.length;
  const markers = frame.filter((line) => MARKER.test(line));
  expect(markers.length).toBeGreaterThan(0);
  expect(markers.some((line) => new RegExp(`\\b${String(hidden)}\\b`).test(line))).toBe(true);
}

describe("D-2: no pane drops rows in silence", () => {
  it("says how many history entries it is not showing", () => {
    // All 30 belong to the selected contact, so `withheldCount` is 0 and the existing
    // "entries withheld (other contacts)" line — a different, already-correct disclosure — is
    // absent. What is missing here is the disclosure of rows dropped by the LAYOUT.
    const history: HistoryEntryView[] = tags(30).map((tag, index) => ({
      sequence: index + 1,
      contactIdentityId: CONTACT_ID,
      messageId: `HISTORY-${tag}`,
      direction: index % 2 === 0 ? "inbound" : "outbound",
      plaintext: `SYNTHETIC_TUI_BODY_${tag}`,
      createdAtMs: 1_757_000_000_000 + index,
    }));

    expectTruncationIsDeclared(
      renderFrame(stateWith({ pane: "history", history }), MIN_VIEWPORT),
      history.map((entry) => entry.messageId),
    );
  });

  it("says how many contacts of the roster it is not showing", () => {
    const contacts: ContactView[] = tags(30).map((tag) => ({
      identityId: `CONTACT-${tag}`,
      deviceId: `DEVICE-${tag}`,
      devicePubkey: `npsPUBKEY-${tag}`,
      signalIdentityKey: `SIGNALKEY-${tag}`,
    }));

    expectTruncationIsDeclared(
      renderFrame(stateWith({ pane: "profiles", contacts }), MIN_VIEWPORT),
      contacts.map((contact) => contact.identityId),
    );
  });

  it("says how many rejected envelopes it is not showing", () => {
    const rejections: RejectionView[] = tags(30).map((tag) => ({
      envelopeId: `ENVELOPE-${tag}`,
      code: "SENDER_NOT_TRUSTED",
    }));

    expectTruncationIsDeclared(
      renderFrame(stateWith({ pane: "rejections", rejections }), MIN_VIEWPORT),
      rejections.map((rejection) => rejection.envelopeId),
    );
  });
});
