import { buildHistorySnapshot, formatHistoryLines } from "./history-pane";
import { buildMailboxSnapshot, formatMailboxLines } from "./mailbox-pane";
import { renderModal, resolveModalPanelSize } from "./modal-host";
import { buildProfilesSnapshot, formatProfilesLines } from "./profiles-pane";
import { PANE_IDS, type Frame, type OperatorState, type PaneId, type Viewport } from "./state";
import { clipLine, codePoints, padOrClip } from "./text";

/**
 * The frame renderer: a pure function from state to plain text lines.
 *
 * This is the property the whole design exists for. The reference TUI keeps `@opentui/core` as a
 * type-only optional dependency so that state-to-lines stays pure and every terminal effect
 * arrives through an injected parameter; here there is no UI package at all, so the same purity is
 * obtained directly. A test can therefore assert over EVERY frame the program can paint, which is
 * what makes AC5 and AC6 provable rather than asserted.
 *
 * The renderer emits plain text and no escape sequences. Colour is a separate, later step
 * (`styleFrame`), so a change to styling can never silently rewrite a security assertion made
 * against a frame.
 */

/**
 * AC6 — "The console displays, on its own surface, that this is an unaudited prototype not
 * suitable for sensitive communication." Every frame carries it, on every pane, with any modal
 * open. A document nobody opens is not a warning, and neither is a banner that scrolls away.
 */
export const UNAUDITED_NOTICE = "UNAUDITED PROTOTYPE — not suitable for sensitive communication";

/**
 * Below this the frame is not defined; the shell shows the notice and a resize hint instead.
 * 72 columns is chosen so `UNAUDITED_NOTICE` fits on one line without truncation at the narrowest
 * supported terminal: a warning that has to be truncated to fit is not a warning.
 */
export const MIN_VIEWPORT: Viewport = { cols: 72, rows: 16 };

/** Pads or truncates to exactly `cols` printable columns, counted in code points. */
export function fitLine(text: string, cols: number): string {
  return padOrClip(text, cols);
}

/** The notice occupies row 0; the modal is never allowed to start above row 1. */
const FIRST_OVERLAY_ROW = 1;
/** Rows of chrome above the pane body: the notice, the header and the rule. */
const HEAD_ROWS = 3;
/** Rows of chrome below it: the activity line and the key footer. */
const TAIL_ROWS = 2;

function headerLine(state: OperatorState): string {
  const profile = state.profiles[state.activeProfile];
  const tabs = PANE_IDS.map((pane, index) => (pane === state.pane ? `[${index + 1} ${pane}]` : ` ${index + 1} ${pane} `)).join("");
  return `echolet operator · ${profile?.label ?? "no profile"} ·${tabs}`;
}

/** Names exactly what `mapKey` binds. A footer that advertised an unbound key would be a lie. */
function footerLine(state: OperatorState): string {
  if (state.modal !== undefined) return "[y] trust  [n] reject  [esc] cancel";
  return "[1-5] pane  [p] poll  [d] doctor  [r] publish  [h] history  [i] import  [c] contact  [t] profile  [q] quit";
}

function activityLine(state: OperatorState): string {
  const latest = state.activity.at(-1);
  const busy = state.busy ? "running… " : "";
  return `${busy}${latest?.text ?? "no activity yet"}`;
}

/**
 * The lines of the pane the operator has selected.
 *
 * Every pane is a `build…Snapshot` + `format…Lines` pair living in its own module, so each is
 * independently testable as a value comparison and this function is only layout.
 */
function paneLines(state: OperatorState, pane: PaneId, width: number): string[] {
  const profile = state.profiles[state.activeProfile];
  switch (pane) {
    case "profiles": {
      if (profile === undefined) return [clipLine("no profile configured — run init first", width)];
      return formatProfilesLines(buildProfilesSnapshot({ profile, contacts: state.contacts, health: state.health }), width);
    }
    case "mailbox":
      return formatMailboxLines(buildMailboxSnapshot({ mailbox: state.mailbox, rejections: state.rejections }), width);
    case "history":
      return formatHistoryLines(buildHistorySnapshot({ entries: state.history, selectedContactId: state.selectedContactId }), width);
    case "rejections": {
      const snapshot = buildMailboxSnapshot({ mailbox: state.mailbox, rejections: state.rejections });
      if (snapshot.rejectionCount === 0) return [clipLine("no permanently rejected envelopes in the last poll", width)];
      return [
        clipLine(`${snapshot.rejectionCount} rejected by the last poll`, width),
        ...snapshot.rejectionLines.map((line) => clipLine(`  ${line}`, width)),
      ];
    }
    case "health": {
      const snapshot = buildProfilesSnapshot({
        profile: profile ?? { label: "-", profileDir: "-", relayUrl: state.health.relayUrl, storeKeyEnv: "-", identityId: "-", deviceId: "-", contactCount: 0, published: false },
        contacts: state.contacts,
        health: state.health,
      });
      return [clipLine(snapshot.healthLine, width), "", clipLine(`status  ${state.health.status}`, width)];
    }
    default:
      return [];
  }
}

/**
 * Exactly `viewport.rows` lines, each exactly `viewport.cols` columns, containing no ESC byte and
 * depending on nothing but its two arguments.
 *
 * The layout puts `UNAUDITED_NOTICE` on row 0 and never lets the modal overlay start above row 1,
 * so the warning survives the one moment it matters most: the operator deciding whether to trust
 * a stranger's contact card.
 */
export function renderFrame(state: OperatorState, viewport: Viewport): Frame {
  const cols = Math.max(1, Math.floor(viewport.cols));
  const rows = Math.max(1, Math.floor(viewport.rows));

  const head = [UNAUDITED_NOTICE, headerLine(state), "─".repeat(cols)].slice(0, Math.min(HEAD_ROWS, rows));
  const tail = [activityLine(state), footerLine(state)].slice(0, Math.max(0, Math.min(TAIL_ROWS, rows - head.length)));

  const bodyRows = Math.max(0, rows - head.length - tail.length);
  const body = paneLines(state, state.pane, cols).slice(0, bodyRows);
  while (body.length < bodyRows) body.push("");

  const frame = [...head, ...body, ...tail].map((line) => fitLine(line, cols));
  return state.modal === undefined ? frame : overlayModal(frame, state, { cols, rows });
}

/** Paints the modal panel over the frame in place of a second render pass. */
function overlayModal(frame: string[], state: OperatorState, viewport: Viewport): Frame {
  const modal = state.modal;
  if (modal === undefined) return frame;

  const size = resolveModalPanelSize(viewport.cols, viewport.rows);
  const panel = renderModal(modal, viewport);
  const top = Math.min(
    Math.max(FIRST_OVERLAY_ROW, Math.floor((viewport.rows - size.height) / 2)),
    Math.max(FIRST_OVERLAY_ROW, viewport.rows - size.height),
  );
  const left = Math.max(0, Math.floor((viewport.cols - size.width) / 2));

  const painted = [...frame];
  panel.forEach((panelLine, index) => {
    const row = top + index;
    const base = painted[row];
    if (base === undefined) return;
    const cells = codePoints(base);
    codePoints(panelLine).forEach((cell, offset) => {
      const column = left + offset;
      if (column >= 0 && column < cells.length) cells[column] = cell;
    });
    painted[row] = cells.join("");
  });
  return painted;
}

const ESC = String.fromCharCode(27);
const BOLD = `${ESC}[1m`;
const DIM = `${ESC}[2m`;
const RESET = `${ESC}[0m`;

/**
 * The only place ANSI is introduced. Never called by anything a security assertion reads.
 *
 * It adds SGR codes around whole lines and changes no character, so stripping the codes returns
 * the plain frame exactly — which is what lets every assertion in this task be made against
 * `renderFrame` and stay true of what the operator actually sees.
 */
export function styleFrame(frame: Frame): string[] {
  return frame.map((line, index) => {
    if (line.includes(UNAUDITED_NOTICE)) return `${BOLD}${line}${RESET}`;
    if (index === 1) return `${BOLD}${line}${RESET}`;
    return line.startsWith("─") ? `${DIM}${line}${RESET}` : line;
  });
}
