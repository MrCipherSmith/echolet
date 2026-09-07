import { buildHistorySnapshot, formatHistoryLines } from "./history-pane";
import { buildMailboxSnapshot, formatMailboxLines } from "./mailbox-pane";
import { renderModal, resolveModalPanelSize } from "./modal-host";
import { fitPane } from "./pane-fit";
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
 * Below this the frame is not defined; the frame shows the notice and a resize hint instead.
 * 72 columns is chosen so `UNAUDITED_NOTICE` fits on one line without truncation at the narrowest
 * supported terminal: a warning that has to be truncated to fit is not a warning.
 *
 * It is NOT a floor the shell clamps up to. Painting 72-column lines into a 40-column terminal makes
 * the terminal wrap every one of them, which pushes the notice — an acceptance criterion — off the
 * screen entirely (flow 003 T2 §4, D-4). See `isBelowMinViewport` and `tooSmallFrame`.
 */
export const MIN_VIEWPORT: Viewport = { cols: 72, rows: 16 };

/**
 * True when the defined frame does not fit and `renderFrame` paints the degraded one instead.
 *
 * Exported because the shell has to know: the degraded frame carries no modal, so the shell must
 * not record that a modal was painted after writing one. "The operator saw the four identifiers"
 * has to stay a claim about what was on the screen.
 */
export function isBelowMinViewport(viewport: Viewport): boolean {
  return Math.floor(viewport.cols) < MIN_VIEWPORT.cols || Math.floor(viewport.rows) < MIN_VIEWPORT.rows;
}

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

/**
 * One advertised key, and how badly the footer needs it.
 *
 * `rank` orders removal, not display: the labels are painted in the order they appear here, and the
 * ones with the highest rank are dropped first when they do not fit. MEASURED (flow 003 T2 §4): the
 * old footer was one 106-column string and `MIN_VIEWPORT.cols` is 72, so at exactly the width the
 * shell falls back to, the frame ended at "[i] import" and the key that leaves the program was
 * invisible. Quitting and finding the key list are the two things an operator cannot do without, so
 * they hold ranks 1 and 2 and are the last to go.
 */
interface FooterKey {
  readonly label: string;
  readonly rank: number;
}

const FOOTER_KEYS: readonly FooterKey[] = [
  { label: "[1-5] pane", rank: 3 },
  { label: "[p] poll", rank: 4 },
  { label: "[d] doctor", rank: 5 },
  { label: "[r] publish", rank: 6 },
  { label: "[h] history", rank: 7 },
  { label: "[i] import", rank: 8 },
  { label: "[c] contact", rank: 9 },
  { label: "[t] profile", rank: 10 },
  { label: "[?] help", rank: 2 },
  { label: "[q] quit", rank: 1 },
];

const FOOTER_KEYS_HELP_OPEN: readonly FooterKey[] = FOOTER_KEYS.map((entry) =>
  entry.label === "[?] help" ? { label: "[?] close", rank: entry.rank } : entry);

const FOOTER_SEPARATOR = "  ";

/**
 * The widest prefix of `entries`, by rank, that fits `cols`.
 *
 * Whatever the footer drops, it never drops the way to find what it dropped: `[?] help` opens the
 * list that names every binding, so a footer of two labels is short rather than dishonest.
 */
function fitFooter(entries: readonly FooterKey[], cols: number): string {
  const byRank = entries.map((_, index) => index)
    .sort((left, right) => (entries[left]?.rank ?? 0) - (entries[right]?.rank ?? 0));

  const paint = (chosen: readonly number[]): string =>
    [...chosen].sort((left, right) => left - right).map((index) => entries[index]?.label ?? "").join(FOOTER_SEPARATOR);

  const chosen: number[] = [];
  for (const index of byRank) {
    const candidate = paint([...chosen, index]);
    if (codePoints(candidate).length > Math.max(0, Math.floor(cols))) break;
    chosen.push(index);
  }
  return paint(chosen);
}

/** Names exactly what `mapKey` binds. A footer that advertised an unbound key would be a lie. */
function footerLine(state: OperatorState, cols: number): string {
  if (state.modal !== undefined) return "[y] trust  [n] reject  [esc] cancel";
  return fitFooter(state.help === true ? FOOTER_KEYS_HELP_OPEN : FOOTER_KEYS, cols);
}

/**
 * What the console is doing, and — while it is doing it — that a second command would not start.
 *
 * MEASURED (flow 003 T2 §3.1 and §4): a keystroke that starts nothing paints nothing, which is
 * indistinguishable from a hung console. The busy state is the one moment where that matters, so
 * the state itself says it rather than each refused keystroke having to.
 */
function activityLine(state: OperatorState): string {
  const latest = state.activity.at(-1);
  const text = latest?.text ?? "no activity yet";
  return state.busy ? `running… (busy — a command key starts nothing) ${text}` : text;
}

/**
 * Every binding on this surface, in one place, reachable with `?`.
 *
 * MEASURED (flow 003 T2 §4): `?` was unbound and painted nothing, and the footer could not carry
 * ten labelled keys in 72 columns. A footer that has to drop labels needs somewhere to send the
 * operator, and this is it. It replaces the pane body rather than floating over it, so it inherits
 * the frame's shape, the notice and the escape-free guarantee without a second layout to audit.
 */
const HELP_LINES: readonly string[] = [
  "key bindings",
  "  1-5        select pane",
  "  p          poll",
  "  d          doctor",
  "  r          relay publish",
  "  h          history for the selected contact",
  "  i          import the contact card named at startup",
  "  c          next contact",
  "  t          next profile",
  "  ?          close this list",
  "  q          quit (ctrl-c also quits)",
];

/**
 * The lines of the pane the operator has selected, laid out into the `bodyRows` the frame has.
 *
 * Every pane is a `build…Snapshot` + `format…Lines` pair living in its own module, so each is
 * independently testable as a value comparison and this function is only layout. The row budget is
 * passed DOWN into each pane rather than applied here as a slice, because which rows a pane may
 * drop, and from which end, is a fact about that pane — see `pane-fit.ts`.
 */
function paneLines(state: OperatorState, pane: PaneId, width: number, bodyRows: number): string[] {
  if (state.help === true) return fitPane({ head: [HELP_LINES[0] ?? ""], rows: HELP_LINES.slice(1), keep: "head" }, bodyRows, width);

  const profile = state.profiles[state.activeProfile];
  switch (pane) {
    case "profiles": {
      if (profile === undefined) return [clipLine("no profile configured — run init first", width)];
      return formatProfilesLines(buildProfilesSnapshot({ profile, contacts: state.contacts, health: state.health }), width, bodyRows);
    }
    case "mailbox":
      return formatMailboxLines(buildMailboxSnapshot({ mailbox: state.mailbox, rejections: state.rejections }), width, bodyRows);
    case "history":
      return formatHistoryLines(buildHistorySnapshot({ entries: state.history, selectedContactId: state.selectedContactId }), width, bodyRows);
    case "rejections": {
      const snapshot = buildMailboxSnapshot({ mailbox: state.mailbox, rejections: state.rejections });
      if (snapshot.rejectionCount === 0) return [clipLine("no permanently rejected envelopes in the last poll", width)];
      return fitPane({
        head: [`${snapshot.rejectionCount} rejected by the last poll`],
        rows: snapshot.rejectionLines.map((line) => `  ${line}`),
        // The untriaged rejections are the ones that arrived last; `poll` reports them in arrival
        // order, so the tail is what the operator has not yet decided about.
        keep: "tail",
      }, bodyRows, width);
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
 * The frame for a terminal smaller than `MIN_VIEWPORT`, painted at the terminal's OWN size.
 *
 * MEASURED (flow 003 T2 §4, D-4): the shell used to clamp UP to 72×16 and write sixteen 72-column
 * lines into a 40×10 window. The terminal wraps every one of them into two rows — roughly 32 visual
 * rows in a 10-row window — and `UNAUDITED_NOTICE`, which sits on row 0, scrolls out of view. That
 * notice is flow 002's AC6, and a small terminal must not defeat an acceptance criterion.
 *
 * So the notice is WRAPPED rather than truncated or clamped: at any width it is present in full,
 * across as many rows as it takes, which is what `shell-chrome.ts` has documented since flow 002
 * and never did. Everything else on this frame is what the operator needs in order to leave it.
 */
function tooSmallFrame(state: OperatorState, cols: number, rows: number): string[] {
  const lines = [
    ...wrapToWidth(UNAUDITED_NOTICE, cols),
    "",
    ...wrapToWidth(`${String(cols)}x${String(rows)} — this console needs ${String(MIN_VIEWPORT.cols)}x${String(MIN_VIEWPORT.rows)}`, cols),
    ...wrapToWidth("resize, or press q to quit", cols),
  ];
  // A trust decision cannot be answered here, because the identifiers cannot be shown here, and the
  // reducer will refuse a confirmation for a modal that was never painted. Saying so is the
  // difference between a refusal and a console that appears to have stopped responding.
  if (state.modal !== undefined) lines.push("", ...wrapToWidth("a trust decision is waiting — resize to answer it", cols));
  return lines;
}

/**
 * Hard-wraps to `cols` code points per line.
 *
 * Every line of the degraded frame goes through this, so nothing on the one frame whose job is to
 * explain a too-small terminal is itself cut off by that terminal. `cols` is at least 1 where this
 * is called, so it always terminates.
 */
function wrapToWidth(text: string, cols: number): string[] {
  const points = codePoints(text);
  if (points.length === 0) return [""];
  const lines: string[] = [];
  for (let at = 0; at < points.length; at += cols) lines.push(points.slice(at, at + cols).join(""));
  return lines;
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

  if (isBelowMinViewport({ cols, rows })) {
    const degraded = tooSmallFrame(state, cols, rows).slice(0, rows).map((line) => fitLine(line, cols));
    while (degraded.length < rows) degraded.push(fitLine("", cols));
    return degraded;
  }

  const head = [UNAUDITED_NOTICE, headerLine(state), "─".repeat(cols)].slice(0, Math.min(HEAD_ROWS, rows));
  const tail = [activityLine(state), footerLine(state, cols)].slice(0, Math.max(0, Math.min(TAIL_ROWS, rows - head.length)));

  const bodyRows = Math.max(0, rows - head.length - tail.length);
  const body = paneLines(state, state.pane, cols, bodyRows).slice(0, bodyRows);
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
