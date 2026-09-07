import { describe, expect, it } from "vitest";
import { MIN_VIEWPORT, UNAUDITED_NOTICE, fitLine, renderFrame, styleFrame } from "./shell-chrome";
import { PANE_IDS, type OperatorState, type PaneId, type TrustModal, type Viewport } from "./state";

// Flow 002 T9 — the render contract.
//
// The whole design exists to make this a unit test. The reference TUI keeps its renderer behind a
// type-only optional dependency so that state-to-lines stays pure; here there is no UI package at
// all, so the purity is direct. Because `renderFrame` is a total, deterministic function from
// (state, viewport) to plain text, a test can assert over EVERY frame the program can paint —
// which is what makes AC5 and AC6 provable rather than asserted.
//
// Printable width is counted in code points. Combining marks and East Asian wide characters are
// out of scope for this prototype and are recorded as such in the design note; the CLI's own
// evidence uses Cyrillic, which is one column per code point.

const ESC = String.fromCharCode(27); // U+001B

const PROFILE = {
  label: "alice",
  profileDir: "/tmp/echolet-demo/alice",
  relayUrl: "http://127.0.0.1:18099",
  storeKeyEnv: "ECHOLET_E2E_KEY",
  identityId: "hbRYeNqVnWC74METcY57eDEkV9qNQ6Qzuz6RpsIYQA",
  deviceId: "733d80b0-e7e2-5e6c-ba84-0bcd96a373ea",
  contactCount: 1,
  published: true,
} as const;

const CONTACT = {
  identityId: "nps4faW9mNX62tZs5M0oqAWtn05cWtn9gCw0gM1JHA",
  deviceId: "9f0c4a11-2b3c-4d5e-8f60-71829a3b4c5d",
  devicePubkey: "npsPUBKEY_aW9mNX62tZs5M0oqAWtn05cWtn9gCw0gM",
  signalIdentityKey: "BQdNjP6tbN00N3eS6DNpmKpMDFDeDa4MFuUO1QWt8i",
} as const;

const TRUST_MODAL: TrustModal = {
  kind: "trust",
  cardPath: "/tmp/echolet-demo/bob-card.json",
  profileLabel: PROFILE.label,
  identifiers: {
    identity_id: CONTACT.identityId,
    device_id: CONTACT.deviceId,
    device_pubkey: CONTACT.devicePubkey,
    signal_identity_key: CONTACT.signalIdentityKey,
  },
  renderedAt: 1_757_000_000_000,
};

function stateFor(pane: PaneId, modal?: TrustModal): OperatorState {
  return {
    profiles: [PROFILE],
    activeProfile: 0,
    contacts: [CONTACT],
    selectedContactId: CONTACT.identityId,
    mailbox: { outboxPending: 2, inboxReceived: 1, more: true, lastPolledAtMs: 1_757_000_000_000 },
    rejections: [{ envelopeId: "94a6f678-0000-4000-8000-000000000001", code: "SENDER_NOT_TRUSTED" }],
    history: [
      { sequence: 1, contactIdentityId: CONTACT.identityId, messageId: "4ba942f0-0000-4000-8000-000000000001", direction: "outbound", plaintext: "SYNTHETIC_TUI_BODY_ONE", createdAtMs: 1_757_000_000_000 },
    ],
    health: { relayUrl: PROFILE.relayUrl, status: "healthy", uptimeMs: 180, checkedAtMs: 1_757_000_000_000 },
    pane,
    modal,
    activity: [{ at: 1_757_000_000_000, text: "poll → received 1" }],
    busy: false,
  };
}

const VIEWPORTS: readonly Viewport[] = [
  MIN_VIEWPORT,
  { cols: 80, rows: 24 },
  { cols: 120, rows: 40 },
  { cols: 203, rows: 61 },
];

describe("renderFrame produces a frame of exactly the viewport's shape", () => {
  it("returns one line per row, each exactly as wide as the viewport, for every pane", () => {
    for (const viewport of VIEWPORTS) {
      for (const pane of PANE_IDS) {
        const frame = renderFrame(stateFor(pane), viewport);
        expect(frame.length).toBe(viewport.rows);
        for (const line of frame) expect([...line].length).toBe(viewport.cols);
      }
    }
  });

  it("keeps the same shape with a modal open", () => {
    for (const viewport of VIEWPORTS) {
      const frame = renderFrame(stateFor("profiles", TRUST_MODAL), viewport);
      expect(frame.length).toBe(viewport.rows);
      for (const line of frame) expect([...line].length).toBe(viewport.cols);
    }
  });

  it("is defined at the minimum viewport and never throws on an empty session", () => {
    const empty: OperatorState = { ...stateFor("profiles"), profiles: [], contacts: [], history: [], rejections: [], activity: [], selectedContactId: null };
    for (const pane of PANE_IDS) {
      expect(() => renderFrame({ ...empty, pane }, MIN_VIEWPORT)).not.toThrow();
      expect(renderFrame({ ...empty, pane }, MIN_VIEWPORT).length).toBe(MIN_VIEWPORT.rows);
    }
  });
});

describe("renderFrame is pure", () => {
  it("returns an identical frame for identical input", () => {
    // No clock, no randomness, no environment read inside the render path. A frame that differs
    // between two calls cannot carry a security assertion, because the asserted frame is then not
    // the frame the operator sees.
    for (const pane of PANE_IDS) {
      const state = stateFor(pane, pane === "profiles" ? TRUST_MODAL : undefined);
      expect(renderFrame(state, { cols: 100, rows: 30 })).toEqual(renderFrame(state, { cols: 100, rows: 30 }));
    }
  });

  it("does not mutate the state it renders", () => {
    const state = stateFor("history", TRUST_MODAL);
    const before = JSON.stringify(state);
    renderFrame(state, { cols: 100, rows: 30 });
    expect(JSON.stringify(state)).toBe(before);
  });
});

describe("the pure layer emits plain text; colour is a separate step", () => {
  it("puts no escape sequence in any rendered frame", () => {
    // Styling is applied afterwards by `styleFrame`, so a change to colour can never silently
    // rewrite an assertion made against a frame — including the two security assertions.
    for (const viewport of VIEWPORTS) {
      for (const pane of PANE_IDS) {
        for (const line of renderFrame(stateFor(pane, TRUST_MODAL), viewport)) {
          expect(line.includes(ESC)).toBe(false);
        }
      }
    }
  });

  it("styleFrame adds only styling: stripping ANSI returns the plain frame", () => {
    const frame = renderFrame(stateFor("profiles"), { cols: 100, rows: 30 });
    const styled = styleFrame(frame);
    expect(styled.length).toBe(frame.length);
    const ansi = new RegExp(`${ESC}\\[[0-9;]*m`, "g");
    expect(styled.map((line) => line.replace(ansi, ""))).toEqual([...frame]);
  });
});

describe("AC6: the surface itself says this is an unaudited prototype", () => {
  it("carries the notice on every pane, at every viewport", () => {
    for (const viewport of VIEWPORTS) {
      for (const pane of PANE_IDS) {
        expect(renderFrame(stateFor(pane), viewport).join("\n")).toContain(UNAUDITED_NOTICE);
      }
    }
  });

  it("carries the notice while a modal is open", () => {
    // The trust modal is the moment the operator is deciding whether to trust a stranger. It is
    // the last moment the warning should disappear.
    for (const viewport of VIEWPORTS) {
      expect(renderFrame(stateFor("profiles", TRUST_MODAL), viewport).join("\n")).toContain(UNAUDITED_NOTICE);
    }
  });

  it("states both halves of the warning: unaudited, and not for sensitive communication", () => {
    expect(UNAUDITED_NOTICE.toLowerCase()).toContain("unaudited");
    expect(UNAUDITED_NOTICE.toLowerCase()).toContain("sensitive");
    expect(UNAUDITED_NOTICE.length).toBeLessThanOrEqual(MIN_VIEWPORT.cols);
  });
});

describe("fitLine is the width primitive the frame depends on", () => {
  it("pads a short line and truncates a long one to exactly the requested width", () => {
    expect([...fitLine("short", 20)].length).toBe(20);
    expect(fitLine("short", 20).startsWith("short")).toBe(true);
    expect([...fitLine("x".repeat(200), 20)].length).toBe(20);
    expect([...fitLine("", 1)].length).toBe(1);
  });

  it("counts code points, not UTF-16 units", () => {
    // The CLI's own evidence sends Cyrillic. A width primitive that counted `.length` would make
    // every frame containing a non-ASCII body the wrong width.
    expect([...fitLine("Привет", 10)].length).toBe(10);
    expect([...fitLine("Привет, Боб. Это первое сообщение", 12)].length).toBe(12);
  });
});
