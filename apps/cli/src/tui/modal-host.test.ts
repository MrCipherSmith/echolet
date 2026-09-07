import { describe, expect, it } from "vitest";
import {
  MODAL_PANEL_CHROME_X,
  MODAL_PANEL_MIN_HEIGHT,
  MODAL_PANEL_MIN_WIDTH,
  TRUST_IDENTIFIER_FIELDS,
  TRUST_MODAL_FOOTER,
  buildTrustModal,
  formatModalFooter,
  modalBodyRows,
  modalIntent,
  renderModal,
  resolveModalInnerWidth,
  resolveModalPanelSize,
  trustModalIsComplete,
} from "./modal-host";
import type { KeyEvent, TrustIdentifiers, Viewport } from "./state";

// Flow 002 T9 — the trust modal.
//
// `contact import` is the ONLY operation that creates Echolet trust. Ciphertext arriving later
// never creates or replaces it (specification.md §Contact contract), and the specification
// requires the exact `identity_id`, `device_id`, `device_pubkey` and `signal_identity_key` to be
// shown before trust is recorded — the four identifiers the runbook prints at §4.
//
// A TUI that put a "yes" button in front of that would break the product's security model, so
// completeness is pinned here as a property of the modal, and enforced again in the reducer
// (`tui-shell.test.ts`). Two independent checks, because this is the one decision in the whole
// surface that cannot be undone: "a changed device or Signal identity fails closed; reset/rotation
// UX is outside this prototype."

const COMPLETE: TrustIdentifiers = {
  identity_id: "hbRYeNqVnWC74METcY57eDEkV9qNQ6Qzuz6RpsIYQA",
  device_id: "733d80b0-e7e2-5e6c-ba84-0bcd96a373ea",
  device_pubkey: "npsPUBKEY_aW9mNX62tZs5M0oqAWtn05cWtn9gCw0gM",
  signal_identity_key: "BQdNjP6tbN00N3eS6DNpmKpMDFDeDa4MFuUO1QWt8i",
};

const VIEWPORTS: readonly Viewport[] = [{ cols: 72, rows: 16 }, { cols: 120, rows: 40 }, { cols: 203, rows: 61 }];

const modal = (identifiers: TrustIdentifiers = COMPLETE) =>
  buildTrustModal({ cardPath: "/tmp/echolet-demo/bob-card.json", profileLabel: "alice", identifiers });

const key = (name: string, overrides: Partial<KeyEvent> = {}): KeyEvent => ({ name, ctrl: false, sequence: name, ...overrides });

/** A card that lacks exactly one of the four identifiers. */
function without(field: string): TrustIdentifiers {
  const partial = { ...COMPLETE } as unknown as Record<string, unknown>;
  delete partial[field];
  return partial as TrustIdentifiers;
}

/** A card whose one identifier is present but empty — a malformed card, not a missing field. */
function blanked(field: string): TrustIdentifiers {
  const partial = { ...COMPLETE } as unknown as Record<string, unknown>;
  partial[field] = "";
  return partial as TrustIdentifiers;
}

describe("the four identifiers the specification requires", () => {
  it("names exactly the four fields the runbook prints, in the runbook's order", () => {
    expect([...TRUST_IDENTIFIER_FIELDS]).toEqual(["identity_id", "device_id", "device_pubkey", "signal_identity_key"]);
  });

  it("renders every one of the four, with its field name, before any confirmation", () => {
    for (const viewport of VIEWPORTS) {
      const painted = renderModal(modal(), viewport).join("\n");
      for (const field of TRUST_IDENTIFIER_FIELDS) {
        expect(painted).toContain(field);
        expect(painted).toContain(COMPLETE[field] ?? "");
      }
    }
  });

  it("renders the identifiers in full: an identifier the operator cannot read cannot be compared", () => {
    // Out-of-band comparison is the entire point of showing them. A modal that elided the middle of
    // a base64url key would look correct and verify nothing.
    const painted = renderModal(modal(), { cols: 120, rows: 40 }).join("\n");
    for (const field of TRUST_IDENTIFIER_FIELDS) {
      const value = COMPLETE[field] ?? "";
      expect(value.length).toBeGreaterThan(0);
      expect(painted.includes(value)).toBe(true);
    }
  });
});

describe("a modal missing any identifier is not confirmable", () => {
  it("is complete only when all four are present and non-empty", () => {
    expect(trustModalIsComplete(modal())).toBe(true);
  });

  it("is incomplete when any single identifier is absent", () => {
    for (const field of TRUST_IDENTIFIER_FIELDS) {
      expect(trustModalIsComplete(modal(without(field)))).toBe(false);
    }
  });

  it("is incomplete when any single identifier is present but empty", () => {
    for (const field of TRUST_IDENTIFIER_FIELDS) {
      expect(trustModalIsComplete(modal(blanked(field)))).toBe(false);
    }
  });

  it("still renders, and says which identifier is missing", () => {
    // Failing closed silently is worse than failing closed loudly: the operator must be able to
    // tell a malformed contact card from a TUI that is not responding.
    for (const field of TRUST_IDENTIFIER_FIELDS) {
      const painted = renderModal(modal(without(field)), { cols: 120, rows: 40 }).join("\n");
      expect(painted).toContain(field);
      expect(painted.toLowerCase()).toContain("missing");
    }
  });
});

describe("the modal's key contract", () => {
  it("maps y to confirm and n or esc to cancel", () => {
    expect(modalIntent(key("y"))).toBe("trust-confirm");
    expect(modalIntent(key("n"))).toBe("trust-cancel");
    expect(modalIntent(key("escape"))).toBe("trust-cancel");
  });

  it("ignores everything else, including a modified y", () => {
    // Ctrl-Y is not a confirmation. The one irreversible decision on this surface must not be
    // reachable by a near miss.
    for (const event of [key("y", { ctrl: true }), key("Y", { ctrl: true }), key("return"), key("space"), key("a"), key("1")]) {
      expect(modalIntent(event)).toBeUndefined();
    }
  });

  it("offers trust, reject and cancel in the footer and nothing else", () => {
    expect(TRUST_MODAL_FOOTER.map((action) => action.key)).toEqual(["y", "n", "esc"]);
    const footer = formatModalFooter(TRUST_MODAL_FOOTER);
    for (const action of TRUST_MODAL_FOOTER) {
      expect(footer).toContain(action.key);
      expect(footer).toContain(action.label);
    }
    // It has to fit, or the operator sees a truncated instruction for an irreversible action.
    expect([...footer].length).toBeLessThanOrEqual(resolveModalInnerWidth(MODAL_PANEL_MIN_WIDTH));
  });
});

describe("panel geometry", () => {
  it("never goes below the floor, whatever the terminal reports", () => {
    for (const [cols, rows] of [[10, 4], [40, 10], [72, 16], [203, 61]] as const) {
      const size = resolveModalPanelSize(cols, rows);
      expect(size.width).toBeGreaterThanOrEqual(MODAL_PANEL_MIN_WIDTH);
      expect(size.height).toBeGreaterThanOrEqual(MODAL_PANEL_MIN_HEIGHT);
    }
  });

  it("leaves at least one body row and a usable wrap width", () => {
    expect(modalBodyRows(MODAL_PANEL_MIN_HEIGHT)).toBeGreaterThanOrEqual(1);
    expect(modalBodyRows(1)).toBeGreaterThanOrEqual(1);
    expect(resolveModalInnerWidth(MODAL_PANEL_MIN_WIDTH)).toBe(MODAL_PANEL_MIN_WIDTH - MODAL_PANEL_CHROME_X);
    expect(resolveModalInnerWidth(0)).toBeGreaterThan(0);
  });

  it("paints exactly the resolved panel height, with lines of the resolved width", () => {
    for (const viewport of VIEWPORTS) {
      const size = resolveModalPanelSize(viewport.cols, viewport.rows);
      const painted = renderModal(modal(), viewport);
      expect(painted.length).toBe(size.height);
      for (const line of painted) expect([...line].length).toBe(size.width);
    }
  });

  it("is deterministic", () => {
    const viewport = { cols: 120, rows: 40 };
    expect(renderModal(modal(), viewport)).toEqual(renderModal(modal(), viewport));
  });
});
