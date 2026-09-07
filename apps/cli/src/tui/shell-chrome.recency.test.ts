import { describe, expect, it } from "vitest";
import { MIN_VIEWPORT, UNAUDITED_NOTICE, renderFrame } from "./shell-chrome";
import type { HistoryEntryView, OperatorState, RejectionView, Viewport } from "./state";

// Flow 003 T5 — D-2, second half: a pane that cannot hold everything must keep the rows an
// operator needs, not the rows that happen to be first in the array.
//
// AC7 has two halves: "a truncated pane states that it is truncated and how many rows are not
// shown, AND keeps the rows an operator needs rather than the oldest." `shell-chrome.overflow.
// test.ts` pins the first half. This file pins the second, and pins the two TOGETHER — a frame
// that names a hidden count while showing the wrong ten rows is honest and still useless.
//
// MEASURED (flow 003 T2 §7, U5): 30 history entries render 10 and the 10 kept are the OLDEST —
// `paneLines` builds every row and `renderFrame` takes `.slice(0, bodyRows)`, which is a prefix.
// The same prefix slice reaches the rejections list. For a messaging console that is backwards:
// the operator opens history to see what just arrived and is shown the first ten messages the
// conversation ever contained, with the message that caused them to look at all discarded.
//
// The design note's U5 states the direction — "History and activity are ordered newest-first" —
// but the assertion below deliberately does NOT pin a paint order. It pins WHICH entries survive,
// by scanning the supplied entries in their own order and asking the frame whether each is
// present. A fix that paints newest-first and a fix that keeps chronological order within the
// visible window both satisfy it; a fix that keeps the oldest rows does not.
//
// Nothing here is derived from a hardcoded row count. `visible` is read off the frame and `hidden`
// is (supplied - visible), exactly as the sibling truncation tests do it, so a later layout that
// frees or costs a body row leaves every assertion true.

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

/** Two-digit tags so a rendered row is unambiguous and short enough to survive clipping. */
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
 * The flow 002 acceptance criteria every new frame surface inherits: exactly `rows` × `cols` code
 * points, no ESC byte anywhere, and `UNAUDITED_NOTICE` present. Asserted on the very frames this
 * file adds requirements to, so a later "keep the newest rows" fix cannot buy its space from them.
 */
function expectFrameContract(frame: readonly string[], viewport: Viewport): string {
  expect(frame.length).toBe(viewport.rows);
  for (const line of frame) {
    expect([...line].length).toBe(viewport.cols);
    expect(line.includes(ESC)).toBe(false);
  }
  const painted = frame.join("\n");
  expect(painted).toContain(UNAUDITED_NOTICE);
  return painted;
}

/**
 * Asserts, on ONE frame, both halves of AC7: the rows kept are the most recent ones supplied, and
 * the frame says how many it is not showing.
 *
 * `supplied` is oldest-first, which is the order the state itself carries (`history` arrives in
 * ascending `sequence`, rejections in the order the poll reported them). The kept rows must be the
 * TAIL of that list, contiguously — "the most recent that fit" — whatever order they are painted in.
 *
 * The ordering assertion is made BEFORE the marker assertion so that the failure this test reports
 * today is the ordering one, which is the requirement it exists to add.
 */
function expectKeepsNewestAndSaysHowMany(
  frame: readonly string[],
  supplied: readonly string[],
  viewport: Viewport,
): void {
  const painted = expectFrameContract(frame, viewport);

  const visible: number[] = [];
  supplied.forEach((tag, index) => {
    if (painted.includes(tag)) visible.push(index);
  });

  // Premises: the pane genuinely cannot show everything here, and it does show something. If
  // either of these ever fails the fixture stopped exercising truncation and the test is void.
  expect(visible.length).toBeGreaterThan(0);
  expect(visible.length).toBeLessThan(supplied.length);

  // The pin. The surviving rows are the last `visible.length` supplied, not the first.
  const newest = supplied.map((_, index) => index).slice(supplied.length - visible.length);
  expect(visible).toEqual(newest);

  // And the frame still confesses to hiding the rest, on the same frame, for the same count.
  const hidden = supplied.length - visible.length;
  const markers = frame.filter((line) => MARKER.test(line));
  expect(markers.length).toBeGreaterThan(0);
  expect(markers.some((line) => new RegExp(`\\b${String(hidden)}\\b`).test(line))).toBe(true);
}

function historyOf(count: number): HistoryEntryView[] {
  return tags(count).map((tag, index) => ({
    sequence: index + 1,
    contactIdentityId: CONTACT_ID,
    messageId: `HISTORY-${tag}`,
    direction: index % 2 === 0 ? "inbound" : "outbound",
    plaintext: `SYNTHETIC_TUI_BODY_${tag}`,
    createdAtMs: 1_757_000_000_000 + index,
  }));
}

function rejectionsOf(count: number): RejectionView[] {
  return tags(count).map((tag) => ({ envelopeId: `ENVELOPE-${tag}`, code: "SENDER_NOT_TRUSTED" }));
}

describe("D-2: a truncated pane keeps the rows the operator came for", () => {
  it("keeps the most recent history entries, not the first ten of the conversation", () => {
    // All 30 belong to the selected contact, so `withheldCount` is 0 and the pane's existing,
    // already-correct "entries withheld (other contacts)" disclosure is absent. What is at issue
    // is purely which of the selected contact's own entries the LAYOUT chose to keep.
    const history = historyOf(30);

    expectKeepsNewestAndSaysHowMany(
      renderFrame(stateWith({ pane: "history", history }), MIN_VIEWPORT),
      history.map((entry) => entry.messageId),
      MIN_VIEWPORT,
    );
  });

  it("keeps the most recent rejected envelopes, which are the ones not yet acted on", () => {
    // A rejection an operator has already seen is a rejection they have already decided about.
    // `poll` reports rejections in arrival order, so the untriaged ones are at the end of the
    // list — and they are exactly the ones the current prefix slice throws away.
    const rejections = rejectionsOf(30);

    expectKeepsNewestAndSaysHowMany(
      renderFrame(stateWith({ pane: "rejections", rejections }), MIN_VIEWPORT),
      rejections.map((rejection) => rejection.envelopeId),
      MIN_VIEWPORT,
    );
  });

  it("keeps the most recent entries at a taller viewport too, so this is a rule about order and not about one row count", () => {
    // Four more rows means four more entries. If the property held only at MIN_VIEWPORT it would
    // be a coincidence of one layout rather than the ordering rule AC7 asks for, so the same two
    // panes are asserted at a viewport derived from MIN_VIEWPORT rather than written down.
    const taller: Viewport = { cols: MIN_VIEWPORT.cols, rows: MIN_VIEWPORT.rows + 4 };
    const history = historyOf(30);
    const rejections = rejectionsOf(30);

    expectKeepsNewestAndSaysHowMany(
      renderFrame(stateWith({ pane: "history", history }), taller),
      history.map((entry) => entry.messageId),
      taller,
    );
    expectKeepsNewestAndSaysHowMany(
      renderFrame(stateWith({ pane: "rejections", rejections }), taller),
      rejections.map((rejection) => rejection.envelopeId),
      taller,
    );
  });
});

// THE CONTACT ROSTER: no ordering is pinned here, deliberately.
//
// The dispatch asked for a decision on the roster, and the decision is that there is no ordering
// worth pinning for it — stated here rather than resolved by pinning an arbitrary one.
//
// Three reasons, in order of weight:
//
// 1. `ContactView` carries no time at all — `identityId`, `deviceId`, `devicePubkey`,
//    `signalIdentityKey`, `displayName`. "Most recent" is not a question the value can answer.
//    The array's tail happens to be the most recently observed import, but that is an artefact of
//    how `observeContact` appends, not a property the type states, and a test that pinned it would
//    be pinning an implementation detail of an unrelated module as a rendering contract.
//
// 2. The roster is a SELECTION surface, not a feed. `c` cycles `state.contacts` in array order to
//    set `selectedContactId`. If the pane rendered the tail while `c` walked from the head, the
//    operator would be cycling through contacts the pane is not showing — a worse and more
//    confusing defect than the one this file fixes for history. Any ordering pinned for the
//    displayed roster has to be pinned for the cycle at the same time, and the cycle belongs to
//    U6, which reworks selection wholesale (observed contacts plus cards known at startup). Pinning
//    a display order now would freeze half of a decision that task has to make as a whole.
//
// 3. Unlike history and rejections, the roster already has a truthful account of what it is not
//    showing that does not depend on order: `rosterDiscrepancy` states how many contacts `doctor`
//    counts that this session cannot name. Combined with the D-2 marker pinned in
//    `shell-chrome.overflow.test.ts`, an operator reading a truncated roster is told both that it
//    is short and by how much, whichever contacts are on screen.
//
// What the roster does need is a paging key, so that every contact is REACHABLE rather than merely
// counted — U5's other half. That is a key-binding and state requirement, not an ordering one, and
// it is not this file's to pin.
