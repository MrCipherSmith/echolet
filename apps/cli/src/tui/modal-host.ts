import type { KeyEvent, TrustIdentifiers, TrustModal, Viewport } from "./state";
import { clipLine, padOrClip } from "./text";

/**
 * The single confirmation surface, after the reference TUI's `modal-host.ts`.
 *
 * `contact import` is the ONLY operation that creates Echolet trust — ciphertext arriving later
 * never creates or replaces it (specification.md §Contact contract) — and the specification
 * requires the exact `identity_id`, `device_id`, `device_pubkey` and `signal_identity_key` to be
 * shown before trust is recorded. A TUI that hid them behind a "yes" button would break the
 * product's security model, so completeness is a precondition this module computes and the reducer
 * enforces, not a layout convention a later redesign could quietly drop.
 *
 * Panel geometry is exported the way the reference exports it: a hand-rolled renderer breaks at
 * its geometry, and exported geometry turns that breakage into a unit test.
 */

export const TRUST_IDENTIFIER_FIELDS = [
  "identity_id",
  "device_id",
  "device_pubkey",
  "signal_identity_key",
] as const;

export type TrustIdentifierField = (typeof TRUST_IDENTIFIER_FIELDS)[number];

export interface ModalFooterAction {
  readonly key: string;
  readonly label: string;
}

export const TRUST_MODAL_FOOTER: readonly ModalFooterAction[] = [
  { key: "y", label: "trust" },
  { key: "n", label: "reject" },
  { key: "esc", label: "cancel" },
];

/** Border (2) + horizontal padding (2). Subtract from the panel width to wrap text. */
export const MODAL_PANEL_CHROME_X = 4;
export const MODAL_PANEL_MIN_WIDTH = 56;
export const MODAL_PANEL_MIN_HEIGHT = 14;
/** Header + footer + rounded border. */
export const MODAL_CHROME_ROWS = 4;

export type ModalIntentKind = "trust-confirm" | "trust-cancel";

/** Above these the panel stops growing: a base64url identifier is 43 columns, not 200. */
const MODAL_PANEL_MAX_WIDTH = 80;
const MODAL_PANEL_MAX_HEIGHT = 20;
/** Rows the panel leaves between itself and the frame's edges. */
const MODAL_PANEL_MARGIN = 4;

/**
 * The panel's size for a given terminal, clamped at both ends.
 *
 * The floor matters more than the ceiling: below `MODAL_PANEL_MIN_WIDTH` an identifier would have
 * to be wrapped or elided, and an identifier the operator cannot read in one piece cannot be
 * compared out of band, which is the entire reason for showing it.
 */
export function resolveModalPanelSize(cols: number, rows: number): { width: number; height: number } {
  const available = (span: number, min: number, max: number): number =>
    Math.max(min, Math.min(Math.max(0, Math.floor(span) - MODAL_PANEL_MARGIN), max));
  return {
    width: available(cols, MODAL_PANEL_MIN_WIDTH, MODAL_PANEL_MAX_WIDTH),
    height: available(rows, MODAL_PANEL_MIN_HEIGHT, MODAL_PANEL_MAX_HEIGHT),
  };
}

export function modalBodyRows(panelHeight: number): number {
  return Math.max(1, Math.floor(panelHeight) - MODAL_CHROME_ROWS);
}

export function resolveModalInnerWidth(availableWidth: number): number {
  return Math.max(1, Math.floor(availableWidth) - MODAL_PANEL_CHROME_X);
}

export function formatModalFooter(actions: readonly ModalFooterAction[]): string {
  return actions.map((action) => `[${action.key}] ${action.label}`).join("  ");
}

export function buildTrustModal(input: {
  readonly cardPath: string;
  readonly profileLabel: string;
  readonly identifiers: TrustIdentifiers;
}): TrustModal {
  return {
    kind: "trust",
    cardPath: input.cardPath,
    profileLabel: input.profileLabel,
    identifiers: { ...input.identifiers },
    // Never painted yet. The shell sets this after the frame carrying the modal was written, and
    // the reducer refuses a confirmation while it is null.
    renderedAt: null,
  };
}

/** True only when all four identifiers are present and non-empty. */
export function trustModalIsComplete(modal: TrustModal): boolean {
  return TRUST_IDENTIFIER_FIELDS.every((field) => {
    const value = modal.identifiers[field];
    return typeof value === "string" && value.length > 0;
  });
}

/**
 * The modal's plain-text lines: exactly `resolveModalPanelSize(...).height` of them, each exactly
 * that size's width in code points, and none of them containing an escape sequence.
 *
 * Each identifier gets its own value line so that it is rendered IN FULL at every supported
 * terminal width. A modal that elided the middle of a base64url key would look correct and verify
 * nothing. A missing identifier is named and marked rather than skipped: failing closed silently
 * is worse than failing closed loudly, because the operator cannot then tell a malformed contact
 * card from a TUI that has stopped responding.
 */
export function renderModal(modal: TrustModal, viewport: Viewport): string[] {
  const size = resolveModalPanelSize(viewport.cols, viewport.rows);
  const inner = resolveModalInnerWidth(size.width);
  const rule = "─".repeat(Math.max(0, size.width - 2));

  const body: string[] = [`profile: ${modal.profileLabel}`, `card: ${modal.cardPath}`];
  for (const field of TRUST_IDENTIFIER_FIELDS) {
    const value = modal.identifiers[field];
    body.push(`${field}:`);
    body.push(typeof value === "string" && value.length > 0 ? `  ${value}` : "  (missing)");
  }

  const bodyRows = modalBodyRows(size.height);
  const painted = body.slice(0, bodyRows);
  while (painted.length < bodyRows) painted.push("");

  const boxed = (text: string): string => `│ ${padOrClip(clipLine(text, inner), inner)} │`;
  const lines = [
    `╭${rule}╮`,
    boxed("Trust these contact identifiers?"),
    ...painted.map(boxed),
    boxed(formatModalFooter(TRUST_MODAL_FOOTER)),
    `╰${rule}╯`,
  ];

  // Total by construction for every size this function is called with; clamped anyway so that a
  // hostile viewport can never make the panel a different shape than the frame reserved for it.
  while (lines.length < size.height) lines.push(boxed(""));
  return lines.slice(0, size.height).map((line) => padOrClip(line, size.width));
}

/**
 * A key pressed while a modal is open. `undefined` means the modal ignores it.
 *
 * A modified key is never a confirmation: the one irreversible decision on this surface must not
 * be reachable by a near miss such as Ctrl-Y.
 */
export function modalIntent(key: KeyEvent): ModalIntentKind | undefined {
  if (key.ctrl) return undefined;
  switch (key.name) {
    case "y": return "trust-confirm";
    case "n": return "trust-cancel";
    case "escape": return "trust-cancel";
    default: return undefined;
  }
}
