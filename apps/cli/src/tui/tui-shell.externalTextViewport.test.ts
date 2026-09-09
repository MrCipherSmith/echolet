import { describe, expect, it } from "vitest";
import type { CliOutcome, CliRequest } from "./cli-bridge";
import type { OperatorState, TrustIdentifiers } from "./state";
import { runTuiShell, type TuiIo } from "./tui-shell";

/*
 * Flow 004 T13 — the three external-text routes that have no pure seam, measured at the terminal. RED.
 *
 * `tui-shell.externalText.test.ts` holds the boundary for the three routes that pass through
 * `applyOutcome`, and it asserts over the STATE so that a renderer-side filter cannot satisfy it.
 * Three more routes never touch a pure function at all — they are written inside `runTuiShell` and
 * `main.ts`:
 *
 *   3. the CLI's error `code`, interpolated into the activity line by `note()` (tui-shell.ts:533),
 *      kept verbatim from the child's stdout by `parseCliOutcome` (cli-bridge.ts:143);
 *   4. a trust-modal identifier, parsed out of a `contact import` child's stderr by
 *      `readIdentifiers` (main.ts:134) and assigned straight to `current.modal` (tui-shell.ts:558);
 *   6. the contact ROSTER, which `observeContact` (tui-shell.ts:521) builds out of those same
 *      identifiers when the operator confirms — a sink the verifier's enumeration did not list, and
 *      one whose lifetime OUTLASTS the modal: the identifiers are painted on the profiles pane long
 *      after the panel that showed them is gone.
 *
 * WHAT THIS FILE CAN AND CANNOT SETTLE. The only thing observable from outside `runTuiShell` is what
 * it wrote to the terminal, so these three assertions would also be satisfied by a filter placed
 * inside the renderer — which the sibling file's boundary argument rejects. That is a real limit and
 * it is recorded rather than papered over: the sibling file is where the boundary is fixed, and it
 * stays red against a renderer-side fix. What this file adds is the consequence, stated in the only
 * units that matter for a security defect — the BYTES the operator's terminal received.
 *
 * The assertion is exact rather than approximate. The console writes exactly nine escape sequences
 * of its own — the alternate-screen and cursor pairs, home-and-clear, and `styleFrame`'s three SGR
 * codes — and the payloads below are deliberately drawn from a disjoint vocabulary, so removing the
 * console's own literals leaves text in which any surviving escape byte is unambiguously somebody
 * else's. Which layer is asked to remove it is the implementer's choice: `parseCliOutcome` and
 * `note` are both defensible homes for route 3, and nothing here picks one.
 *
 * It spawns nothing: `runCli` is injected, there is no terminal, no clock, no store and no relay, so
 * this file takes no timeout from `test/childProcessTimeouts.ts` — it has none to take, and no
 * millisecond literal appears in it.
 */

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
const CSI_C1 = String.fromCharCode(0x9b);
const CTRL_C = String.fromCharCode(3);

/** C0, DEL and C1, as a numeric predicate. See the sibling file for why it is not imported. */
function isControlPoint(point: string): boolean {
  const code = point.codePointAt(0) ?? 0;
  return code <= 0x1f || code === 0x7f || (code >= 0x80 && code <= 0x9f);
}

const DISPLAY_STEERING = new Set([0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069, 0x2028, 0x2029, 0xfeff]
  .map((code) => String.fromCodePoint(code)));

const RTL_OVERRIDE = String.fromCodePoint(0x202e);

const nameOf = (point: string): string =>
  `U+${(point.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0")}`;

/**
 * Every escape sequence the console legitimately writes, as exact literals.
 *
 * `ALTERNATE_SCREEN_ON`/`OFF` and `HOME` are tui-shell.ts:344-346; the three SGR codes are
 * shell-chrome.ts:364-366. `\r\n` is the row separator `runTuiShell` joins a frame with — it is
 * written BETWEEN lines and never inside one, which is why removing it cannot hide a payload.
 *
 * This list is the console's whole ANSI vocabulary. If a later change adds a tenth sequence, this
 * suite fails loudly and the new sequence has to be justified here, which is the correct outcome for
 * a console whose security argument is that the pure layer emits no escape bytes at all.
 */
const CONSOLE_OWN_WRITES: readonly string[] = [
  `${ESC}[?1049h`, `${ESC}[?25l`,
  `${ESC}[?25h`, `${ESC}[?1049l`,
  `${ESC}[H`, `${ESC}[2J`,
  `${ESC}[1m`, `${ESC}[2m`, `${ESC}[0m`,
  "\r\n",
];

/** What the terminal received, minus everything the console is entitled to have sent it. */
function residue(writes: readonly string[]): string {
  return CONSOLE_OWN_WRITES.reduce((text, own) => text.split(own).join(""), writes.join(""));
}

/** Every forbidden code point still standing after the console's own vocabulary is removed. */
function foreignSteering(writes: readonly string[]): string[] {
  return [...residue(writes)]
    .filter((point) => isControlPoint(point) || DISPLAY_STEERING.has(point))
    .map(nameOf);
}

const KEPT_HEAD = "SYNTHETIC_HEAD";
const KEPT_TAIL = "SYNTHETIC_TAIL";
const hostile = (sequence: string): string => `${KEPT_HEAD}${sequence}${KEPT_TAIL}`;

const CONTACT_ID = "nps4faW9mNX62tZs5M0oqAWtn05cWtn9gCw0gM1JHA";
const PROFILE_DIR = "/tmp/echolet-demo/alice";
const CARD_PATH = "/tmp/echolet-demo/bob-card.json";
const AT_MS = 1_757_000_000_000;

function baseState(overrides: Partial<OperatorState> = {}): OperatorState {
  return {
    profiles: [{
      label: "alice",
      profileDir: PROFILE_DIR,
      relayUrl: "http://127.0.0.1:18099",
      storeKeyEnv: "ECHOLET_E2E_KEY",
      identityId: "hbRYeNqVnWC74METcY57eDEkV9qNQ6Qzuz6RpsIYQA",
      deviceId: "733d80b0-e7e2-5e6c-ba84-0bcd96a373ea",
      contactCount: 1,
      published: true,
      contactCardPath: CARD_PATH,
    }],
    activeProfile: 0,
    contacts: [],
    selectedContactId: CONTACT_ID,
    mailbox: { outboxPending: 0, inboxReceived: 0, more: false, lastPolledAtMs: null },
    rejections: [],
    history: [],
    health: { relayUrl: "http://127.0.0.1:18099", status: "unknown", uptimeMs: null, checkedAtMs: null },
    pane: "profiles",
    modal: undefined,
    activity: [],
    busy: false,
    ...overrides,
  };
}

/** A drain, not a delay: the shell applies effects from an async IIFE, and nothing here is on a timer. */
const drain = (): Promise<void> => new Promise<void>((resolve) => { setImmediate(resolve); });

interface DrivenShell {
  /** Every chunk handed to `stdout.write`, unmodified. */
  readonly writes: readonly string[];
  readonly requests: readonly CliRequest[];
  readonly press: (sequence: string) => void;
  readonly settle: (outcome: CliOutcome) => void;
  /** Fires the `contact import` handshake the way `main.ts` fires it, from the child's stderr. */
  readonly announceTrust: (identifiers: TrustIdentifiers) => void;
  readonly finished: Promise<number>;
}

function drive(cols: number, rows: number, state: OperatorState = baseState()): DrivenShell {
  const writes: string[] = [];
  const requests: CliRequest[] = [];
  const pending: ((outcome: CliOutcome) => void)[] = [];
  let emit: ((chunk: Buffer) => void) | undefined;
  let announce: ((input: { readonly cardPath: string; readonly profileLabel: string; readonly identifiers: TrustIdentifiers }) => void) | undefined;

  const io: TuiIo = {
    stdout: { write: (chunk: string) => { writes.push(chunk); return true; }, columns: cols, rows },
    stdin: {
      on: (event: string, handler: (chunk: Buffer) => void) => { if (event === "data") emit = handler; return undefined; },
      resume: () => undefined,
      pause: () => undefined,
    },
    now: () => AT_MS,
    runCli: (request: CliRequest) => {
      requests.push(request);
      return new Promise<CliOutcome>((resolve) => { pending.push(resolve); });
    },
    answerTrustPrompt: () => undefined,
    onTrustIdentifiers: (listener) => { announce = listener; },
  };

  const finished = runTuiShell(io, state);

  return {
    writes,
    requests,
    press: (sequence: string) => emit?.(Buffer.from(sequence, "utf8")),
    settle: (outcome: CliOutcome) => { pending.shift()?.(outcome); },
    announceTrust: (identifiers: TrustIdentifiers) =>
      announce?.({ cardPath: CARD_PATH, profileLabel: "alice", identifiers }),
    finished,
  };
}

describe("T13-F: the console's own nine escape sequences are the only ones it writes", () => {
  it("writes no foreign escape byte on a benign session", async () => {
    // The control case, and the proof that `residue` is subtracting the right things. Without it,
    // every assertion below is satisfiable by a stripper that removes too much.
    const shell = drive(96, 28);
    shell.press("p");
    shell.settle({ ok: true, code: "ok", exitCode: 0, data: { received: 0, more: false, rejected: [] } });
    await drain();
    await drain();

    expect(foreignSteering(shell.writes)).toEqual([]);
    // …and the console really did paint something, so the assertion is not vacuous.
    expect(residue(shell.writes)).toContain("UNAUDITED PROTOTYPE");

    shell.press("q");
    await shell.finished;
  });
});

describe("T13-G: route 3 — the CLI's error code reaches the activity line verbatim", () => {
  it.each([
    ["an OSC window-title set", `${ESC}]0;PWNED${BEL}`],
    ["ESC c, a full terminal reset", `${ESC}c`],
    ["an 8-bit CSI", `${CSI_C1}3J`],
    ["a right-to-left override", RTL_OVERRIDE],
  ])("does not write %s that arrived as a typed error code", async (_name, sequence) => {
    // `parseCliOutcome` keeps `error.code` verbatim, deliberately: the three refusals the CLI reports
    // under the relay's own name must stay distinguishable (cli-bridge.ts:46-48). Keeping the NAME
    // distinguishable does not require keeping the BYTES paintable. `note()` interpolates the code
    // into `activity`, and `activityLine` puts the newest entry on every frame.
    const shell = drive(96, 28);
    shell.press("p");
    shell.settle({ ok: false, code: hostile(sequence), exitCode: 4, data: null });
    await drain();
    await drain();

    expect(foreignSteering(shell.writes)).toEqual([]);
    // The operator is still told which code came back — a console that hid the failure to avoid
    // painting it would trade a terminal-injection defect for a silence defect.
    expect(residue(shell.writes)).toContain(KEPT_HEAD);

    shell.press("q");
    await shell.finished;
  });
});

describe("T13-H: routes 4 and 6 — a stranger's contact card, in the modal and in the roster", () => {
  it("does not write an escape sequence that arrived as a trust identifier", async () => {
    // Route 4. The card is the one document the trust modal exists to make a human read, and it was
    // authored by whoever is asking to be trusted. `renderModal` prints each identifier on its own
    // line so it can be compared out of band; a right-to-left override in one makes that comparison
    // meaningless, and an OSC sequence in one steers the terminal at the exact moment the operator
    // is being asked to make the surface's only irreversible decision.
    const shell = drive(203, 61);
    shell.press("i");
    await drain();
    expect(shell.requests.map((request) => request.command)).toEqual(["contact import"]);

    shell.announceTrust({
      identity_id: hostile(`${ESC}]0;PWNED${BEL}`),
      device_id: hostile(RTL_OVERRIDE),
      device_pubkey: hostile(`${ESC}c`),
      signal_identity_key: hostile(`${CSI_C1}3J`),
    });
    await drain();

    expect(foreignSteering(shell.writes)).toEqual([]);
    // The identifiers are still shown. A modal that refused to paint a malformed card would fail
    // closed loudly, which modal-host.ts:110-113 already argues for — but silently painting nothing
    // is the failure mode that comment rejects.
    expect(residue(shell.writes)).toContain(KEPT_HEAD);

    shell.press(CTRL_C);
    await shell.finished;
  });

  it("does not write one that survived into the contact roster after the modal closed", async () => {
    // Route 6, which the verifier's enumeration did not list. `observeContact` (tui-shell.ts:521)
    // copies all four identifiers out of the confirmed modal into `state.contacts`, and
    // `formatProfilesLines` paints `identityId  deviceId` on the profiles pane for the rest of the
    // session. So a filter applied only where the MODAL is rendered leaves the same bytes on every
    // subsequent frame, long after the panel that carried them is gone.
    const shell = drive(203, 61);
    shell.press("i");
    await drain();

    shell.announceTrust({
      identity_id: hostile(`${ESC}]0;PWNED${BEL}`),
      device_id: hostile(RTL_OVERRIDE),
      device_pubkey: "npsPUBKEY_aW9mNX62tZs5M0oqAWtn05cWtn9gCw0gM",
      signal_identity_key: "BQdNjP6tbN00N3eS6DNpmKpMDFDeDa4MFuUO1QWt8i",
    });
    await drain();

    // The modal was painted, so the reducer's `renderedAt` gate lets the confirmation through.
    shell.press("y");
    await drain();
    // The import succeeded, which is what puts the contact on the roster (tui-shell.ts:536).
    shell.settle({ ok: true, code: "ok", exitCode: 0, data: null });
    await drain();
    await drain();

    const beforeRoster = shell.writes.length;
    // Back to the profiles pane, which is where the roster is painted.
    shell.press("1");
    await drain();

    const rosterFrames = shell.writes.slice(beforeRoster);
    expect(rosterFrames.length).toBeGreaterThan(0);
    expect(foreignSteering(rosterFrames)).toEqual([]);
    // The contact really is on the roster, so this is a filtered identifier and not an absent one.
    expect(residue(rosterFrames)).toContain(KEPT_HEAD);

    shell.press(CTRL_C);
    await shell.finished;
  });
});

/*
 * Not pinned here, and why:
 *
 * - WHICH LAYER FILTERS. Route 3 has two defensible homes — `parseCliOutcome`, where the child's
 *   stdout first becomes a value, and `note`, where it first becomes state — and routes 4 and 6 have
 *   `readIdentifiers` and the shell's listener. The sibling file fixes the principle (filter where
 *   the field is written, never in the renderer); this file measures the result and picks no layer.
 * - THE ARGV AND KEY-MATERIAL PROPERTIES. `main.sendChild.test.ts` and `tui.keyMaterial.test.ts`
 *   already hold those, and nothing in this task moves them.
 */
