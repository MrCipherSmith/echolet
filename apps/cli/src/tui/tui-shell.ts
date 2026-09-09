import type { CliOutcome, CliRequest } from "./cli-bridge";
import type { Effect, Intent, Step } from "./intents";
import { modalIntent, trustModalIsComplete } from "./modal-host";
import { MIN_VIEWPORT, isBelowMinViewport, renderFrame, styleFrame } from "./shell-chrome";
import {
  PANE_IDS,
  inputMaxBytes,
  type ContactView,
  type HistoryEntryView,
  type InputState,
  type KeyEvent,
  type OperatorState,
  type RejectionView,
  type TrustIdentifiers,
  type TrustModal,
  type Viewport,
} from "./state";
import { utf8Bytes } from "./text";

/**
 * The shell, after the reference TUI's `tui-shell.ts`.
 *
 * Two pure functions and one impure one:
 *
 * - `mapKey(key, state) -> Intent | undefined` — what the operator asked for.
 * - `reduce(state, intent) -> Step` — the next state plus a list of effect DESCRIPTIONS. It never
 *   calls anything; it returns what should happen.
 * - `runTuiShell(io)` — the only impure function in `src/tui`. It owns the alternate screen, raw
 *   mode, the child process and the clock, and receives all four through `TuiIo`, so no test ever
 *   needs a TTY.
 *
 * The trust gate lives in `reduce`, deliberately, and not in the modal's key handling: a `confirm`
 * that arrives from anywhere — a stray keystroke, a resize race, a future scripted mode — meets
 * the same precondition. The reducer refuses to emit a trust confirmation unless the open modal is
 * a trust modal, all four identifiers are present, and the modal has actually been painted.
 */

export type { Effect, Intent, Step } from "./intents";

export interface TuiIo {
  readonly stdout: { write(chunk: string): unknown; readonly columns?: number | undefined; readonly rows?: number | undefined };
  readonly stdin: {
    setRawMode?(mode: boolean): unknown;
    on(event: string, handler: (chunk: Buffer) => void): unknown;
    resume(): unknown;
    pause(): unknown;
  };
  readonly now: () => number;
  readonly runCli: (request: CliRequest) => Promise<CliOutcome>;
  /** Answers the CLI's own `Trust these contact identifiers? [y/N]` prompt on the child's stdin. */
  readonly answerTrustPrompt: (answer: boolean) => void;
  /**
   * Optional seam for the `contact import` handshake.
   *
   * The driver owns the child, so it is the only thing that can see the four identifiers the child
   * prints while it waits at its own prompt; the shell owns the state, so it is the only thing that
   * can open the modal. This registers the shell's listener with the driver. It is optional so that
   * a caller with no child process — a scripted or read-only session — constructs a `TuiIo`
   * unchanged.
   */
  readonly onTrustIdentifiers?: (
    listener: (input: { readonly cardPath: string; readonly profileLabel: string; readonly identifiers: TrustIdentifiers }) => void,
  ) => void;
}

/**
 * A keystroke's meaning in the current state.
 *
 * An open modal takes exclusive control of the keyboard. An operator who pressed "3" mid-import and
 * landed on the history pane would not know whether the import was still pending, and the modal is
 * the one place on this surface where not knowing is dangerous.
 */
export function mapKey(key: KeyEvent, state: OperatorState): Intent | undefined {
  if (state.modal !== undefined) {
    const intent = modalIntent(key);
    if (intent === "trust-confirm") return { kind: "trust-confirm" };
    if (intent === "trust-cancel") return { kind: "trust-cancel" };
    return undefined;
  }

  /*
   * Routing order 2 (t35 §3.1): while the compose row is open it owns the keyboard, and every key
   * below this line is TEXT. An operator typing "quit" must not quit; a message containing the word
   * "period" must not poll, doctor and publish on its way in.
   *
   * It is not a modal and takes nothing away: Ctrl-C still leaves, because a console that cannot be
   * left is worse than a lost draft, and AC8 requires a way out in every state.
   */
  if (state.input !== undefined) return inputKey(key);

  if (key.ctrl) return key.name.toLowerCase() === "c" ? { kind: "quit" } : undefined;
  if (key.name === "q") return { kind: "quit" };
  if (key.name === "?") return { kind: "toggle-help" };

  const ordinal = /^[1-9]$/.test(key.name) ? Number(key.name) : 0;
  const pane = PANE_IDS[ordinal - 1];
  if (pane !== undefined) return { kind: "select-pane", pane };

  const intent = paneKeyIntent(key, state);

  /*
   * D-1, the gate the console was measured to be missing (flow 003 T2 §3.1).
   *
   * Every `run` spawns a child against one encrypted SQLite store. With one already in flight the
   * second met the store as a concurrent writer, so `p p p d` at 5 ms produced two
   * `PERSISTENCE_FAILURE (exit 5)` results and one success — the console manufactured its most
   * alarming exit class out of key-mashing — and a `relay publish` pressed during a poll reported
   * `PERSISTENCE_FAILURE (exit 5)` where the CLI on its own returns `RELAY_UNAVAILABLE (exit 4)`.
   * A console whose whole purpose is to surface the typed exit-code contract must not invent its
   * most alarming class out of its most benign one.
   *
   * The gate is written over the INTENT rather than over a list of key names, so a binding added
   * later cannot slip past it. Quit, Ctrl-C, pane selection, the modal, `?`, `c` and `t` are all
   * decided above this line and stay live: a console that goes deaf while a child runs is
   * indistinguishable from a hung one. The operator is told rather than ignored — while `busy` is
   * set, `activityLine` says so on every frame.
   */
  if (state.busy && intent?.kind === "run") return undefined;
  return intent;
}

/**
 * A keystroke's meaning while the compose row is open. Four input intents, plus the way out.
 *
 * It reads `key.sequence` and never `key.name`, which is the whole of wall 1: `decodeKey` keeps
 * only the first code point of a chunk on `name` and lower-cases it, so a mode that read `name`
 * would turn "Hello" into "h" and a paste into its first character.
 *
 * A chunk that BEGINS with ESC is a key rather than text (t35 §3.1). A bare Escape cancels; an
 * arrow — `ESC [ A` — is refused outright, because decoding one would put an escape-sequence
 * decoder in the input path of a program whose security argument rests on the pure layer emitting
 * no escape bytes (§2.3). A chunk `decodeKey` read as a control keystroke is likewise a key: only
 * Ctrl-C is bound here, and the rest are dropped rather than pasted.
 */
function inputKey(key: KeyEvent): Intent | undefined {
  if (key.ctrl) return key.name.toLowerCase() === "c" ? { kind: "quit" } : undefined;
  if (key.sequence.startsWith(ESC)) return key.sequence === ESC ? { kind: "input-cancel" } : undefined;
  if (key.sequence === "\r" || key.sequence === "\n") return { kind: "input-submit" };
  if (key.sequence === DEL) return { kind: "input-backspace" };
  if (key.sequence === "") return undefined;
  // The RAW chunk. Filtering happens in `reduce`, at the boundary, and nowhere else.
  return { kind: "input-insert", text: key.sequence };
}

/** The bindings that depend on the active profile. Split out so the D-1 gate can read the intent. */
function paneKeyIntent(key: KeyEvent, state: OperatorState): Intent | undefined {
  // The command keys. Each is a precondition away from being unbound: a key that would build an
  // incomplete request returns `undefined` rather than an argv with a missing operand.
  const profile = state.profiles[state.activeProfile];
  if (profile === undefined) return undefined;
  switch (key.name) {
    case "p": return { kind: "run", request: { command: "poll", profileDir: profile.profileDir } };
    case "d": return { kind: "run", request: { command: "doctor", profileDir: profile.profileDir } };
    case "r": return { kind: "run", request: { command: "relay publish", profileDir: profile.profileDir } };
    case "h":
      return state.selectedContactId === null
        ? undefined
        : { kind: "run", request: { command: "history", profileDir: profile.profileDir, contactIdentityId: state.selectedContactId } };
    case "i":
      // Deliberately without `--yes`: the modal opens on the identifiers the child prints, and the
      // operator answers the child's own prompt afterwards.
      return profile.contactCardPath === undefined
        ? undefined
        : { kind: "run", request: { command: "contact import", profileDir: profile.profileDir, from: profile.contactCardPath } };
    case "w":
      /*
       * Write a message to the selected contact (t35 §2.2 step 1).
       *
       * Bound on the conversation pane only — ordinal 3, which §3.4 renames `chat` — because that
       * is where the operator can see who they are writing to. Three preconditions, each of which
       * would otherwise open a row whose submit could not build a complete request: a conversation
       * on the screen, a recipient, and no child already alive.
       *
       * It is deliberately absent from the footer: the footer is one global list and this key is
       * bound on one pane, so advertising it everywhere would be the lie `shell-chrome.ts` refuses.
       * The key list under `?` names it, which is the same resolution the footer's dropped labels
       * already have. The per-pane footer relation is t35's T-11.
       */
      return state.pane !== "history" || state.selectedContactId === null || state.busy
        ? undefined
        : { kind: "input-open", field: "message" };
    case "c": {
      const next = state.contacts[(state.contacts.findIndex((contact) => contact.identityId === state.selectedContactId) + 1) % Math.max(1, state.contacts.length)];
      return next === undefined ? undefined : { kind: "select-contact", identityId: next.identityId };
    }
    case "t":
      return state.profiles.length < 2 ? undefined : { kind: "select-profile", index: (state.activeProfile + 1) % state.profiles.length };
    default:
      return undefined;
  }
}

export function reduce(state: OperatorState, intent: Intent): Step {
  switch (intent.kind) {
    case "select-pane":
      return { state: { ...state, pane: intent.pane }, effects: [] };
    case "select-profile": {
      const index = Number.isInteger(intent.index) && intent.index >= 0 && intent.index < state.profiles.length
        ? intent.index
        : state.activeProfile;
      return { state: { ...state, activeProfile: index }, effects: [] };
    }
    case "select-contact":
      return { state: { ...state, selectedContactId: intent.identityId }, effects: [] };
    case "toggle-help":
      return { state: { ...state, help: state.help !== true }, effects: [] };
    case "run":
      // The deep half of the D-1 gate, held here for the same reason the trust gate is: a `run`
      // arriving from anywhere — a stray keystroke, a resize race, a future scripted mode, a
      // startup effect — meets the same precondition. `mapKey` refusing the keystroke keeps the
      // console honest; this keeps it correct.
      if (state.busy) return { state, effects: [] };
      return { state: { ...state, busy: true }, effects: [{ kind: "run-cli", request: intent.request }] };
    case "trust-confirm": {
      const modal = state.modal;
      // Three preconditions, all of them refusals rather than corrections. `renderedAt` is the one
      // that turns "the identifiers were shown" from a claim about the code into a claim about what
      // the operator saw: the shell sets it only after the frame carrying the modal was written.
      if (modal === undefined || modal.renderedAt === null || !trustModalIsComplete(modal)) {
        return { state, effects: [] };
      }
      return { state: { ...state, modal: undefined }, effects: [{ kind: "answer-trust-prompt", answer: true }] };
    }
    case "trust-cancel":
      // An incomplete modal must still be cancellable, or a malformed contact card is a dead end.
      if (state.modal === undefined) return { state, effects: [] };
      return { state: { ...state, modal: undefined }, effects: [{ kind: "answer-trust-prompt", answer: false }] };
    case "input-open":
      /*
       * Both refusals are the coexistence rule, and they are refusals rather than corrections.
       *
       * While a modal is open nothing may compose behind it. While a child is alive nothing may
       * compose at all — which is what makes the coexisting state unreachable rather than merely
       * handled: a trust modal is only ever opened by the `contact import` handshake, and that runs
       * while `busy` is set, so a modal can never arrive on top of an open row.
       */
      if (state.modal !== undefined || state.busy) return { state, effects: [] };
      return {
        state: {
          ...state,
          // Unpainted, exactly like `buildTrustModal`'s `renderedAt: null`: the shell stamps it
          // after the frame carrying the row was written, and never before.
          input: { field: intent.field, buffer: "", renderedAt: null, maxBytes: inputMaxBytes(intent.field) },
        },
        effects: [],
      };
    case "input-insert": {
      const input = state.input;
      if (input === undefined || state.modal !== undefined) return { state, effects: [] };
      /*
       * AC7, at the boundary. Every code point of U+0000..U+001F, U+007F and U+0080..U+009F is
       * dropped here, so a paste carrying an escape sequence inserts its printable remainder and
       * nothing else, and no later renderer change can reintroduce the byte. The property belongs
       * to the state: `renderFrame` filters nothing, and the test that proves this does not import
       * it (t35 §5 item 4).
       */
      const text = withoutControlPoints(intent.text);
      if (text === "") return { state, effects: [] };
      const buffer = input.buffer + text;
      // Refused, not truncated: silently dropping the tail loses part of a message the operator
      // believes they sent. Counted in UTF-8 bytes because that is what the CLI counts.
      if (utf8Bytes(buffer) > input.maxBytes) return { state, effects: [] };
      return { state: { ...state, input: { ...input, buffer } }, effects: [] };
    }
    case "input-backspace": {
      const input = state.input;
      if (input === undefined || state.modal !== undefined) return { state, effects: [] };
      // One CODE POINT, not one UTF-16 unit: halving an astral pair would leave a lone surrogate in
      // the buffer and therefore in a frame.
      const points = [...input.buffer];
      points.pop();
      return { state: { ...state, input: { ...input, buffer: points.join("") } }, effects: [] };
    }
    case "input-cancel":
      if (state.input === undefined) return { state, effects: [] };
      return { state: { ...state, input: undefined }, effects: [] };
    case "input-submit": {
      const input = state.input;
      if (input === undefined || state.modal !== undefined || state.busy) return { state, effects: [] };
      // The trust modal's painted-at gate, reused rather than reinvented (t35 §3.2): below
      // `MIN_VIEWPORT` the frame is the degraded one, which carries no input row, so a submit from
      // there would send a body the operator never saw. The buffer is kept, because a refusal that
      // also discarded the draft would punish the operator for the size of their window.
      if (input.renderedAt === null) return { state, effects: [] };
      const request = submitRequest(state, input);
      if (request === undefined) return { state, effects: [] };
      // `busy` is set here for the same reason `run` sets it: one command in flight at a time, and
      // the unit is one operator action.
      return { state: { ...state, input: undefined, busy: true }, effects: [{ kind: "run-cli", request }] };
    }
    case "quit":
      return { state, effects: [{ kind: "quit" }] };
    default:
      return { state, effects: [] };
  }
}

/**
 * True for the three ranges no frame may be able to carry: C0, DEL and C1.
 *
 * A numeric predicate rather than a regular expression with literal control bytes, for the same
 * reason `ESC` below is built from a character code: a literal control byte in a source file is
 * invisible in review, and searching the pure layer for one has to stay a meaningful check.
 */
function isControlPoint(point: string): boolean {
  const code = point.codePointAt(0) ?? 0;
  return code <= 0x1f || code === 0x7f || (code >= 0x80 && code <= 0x9f);
}

/** `text` with every control point removed, iterated by code point so an astral pair survives. */
function withoutControlPoints(text: string): string {
  return [...text].filter((point) => !isControlPoint(point)).join("");
}

/**
 * The request a submitted buffer builds, or `undefined` when it would be incomplete.
 *
 * Only the `message` field has a submit today. The other six are operands of the registration and
 * address-book steps (t35 §2.1, §2.3), whose requests belong to those tasks; until one lands, no
 * key opens those fields and a submit on one is a refusal rather than a guess at what it meant.
 *
 * The body travels on the request OBJECT and never in an argv: `buildArgv` puts `text` in no token,
 * and `main.ts` writes it to the child's stdin. That is AC3, and it is why this is a `send` request
 * rather than a command line.
 */
function submitRequest(state: OperatorState, input: InputState): CliRequest | undefined {
  if (input.field !== "message") return undefined;
  const profile = state.profiles[state.activeProfile];
  const to = state.selectedContactId;
  if (profile === undefined || to === null || input.buffer === "") return undefined;
  return { command: "send", profileDir: profile.profileDir, to, text: input.buffer };
}

/**
 * The escape byte is built from its character code rather than written as a literal, so that the
 * one module allowed to emit ANSI cannot acquire an escape sequence by accident and so that
 * searching the pure layer for a literal escape byte stays a meaningful check.
 */
const ESC = String.fromCharCode(27);
const CTRL_C = String.fromCharCode(3);
/** What a terminal sends for Backspace. `decodeKey` gives it a `name` nothing else binds. */
const DEL = String.fromCharCode(127);

const ALTERNATE_SCREEN_ON = `${ESC}[?1049h${ESC}[?25l`;
const ALTERNATE_SCREEN_OFF = `${ESC}[?25h${ESC}[?1049l`;
const HOME = `${ESC}[H${ESC}[2J`;

/**
 * Decodes one raw-mode chunk into the three fields the input model reads.
 *
 * Deliberately small: the surface binds single characters, Escape and Ctrl-C, and nothing else.
 * A larger decoder would be more code to audit for no behaviour this console offers.
 */
export function decodeKey(chunk: Buffer | string): KeyEvent {
  const sequence = typeof chunk === "string" ? chunk : chunk.toString("utf8");
  if (sequence === CTRL_C) return { name: "c", ctrl: true, sequence };
  if (sequence === ESC) return { name: "escape", ctrl: false, sequence };
  if (sequence === "\r" || sequence === "\n") return { name: "return", ctrl: false, sequence };

  const first = [...sequence][0] ?? "";
  const code = first.charCodeAt(0);
  if (Number.isFinite(code) && code > 0 && code < 27) {
    return { name: String.fromCharCode(code + 96), ctrl: true, sequence };
  }
  return { name: first.toLowerCase(), ctrl: false, sequence };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const asNumber = (value: unknown, fallback: number): number => (typeof value === "number" && Number.isFinite(value) ? value : fallback);

/** Narrows a `poll` result's `rejected` array to the two fields the specification allows. */
function readRejections(value: unknown): RejectionView[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry): RejectionView[] => {
    if (!isRecord(entry)) return [];
    const envelopeId = entry.envelopeId;
    const code = entry.code;
    // Read by name, never spread: whatever else a relay or sender put on this object stays off the
    // operator's screen and out of the state.
    return typeof envelopeId === "string" && typeof code === "string" ? [{ envelopeId, code }] : [];
  });
}

function readHistoryEntries(value: unknown): HistoryEntryView[] {
  if (!isRecord(value) || !Array.isArray(value.entries)) return [];
  return value.entries.flatMap((entry): HistoryEntryView[] => {
    if (!isRecord(entry)) return [];
    const { sequence, contactIdentityId, messageId, direction, plaintext, createdAtMs } = entry;
    if (typeof contactIdentityId !== "string" || typeof messageId !== "string" || typeof plaintext !== "string") return [];
    if (direction !== "inbound" && direction !== "outbound") return [];
    return [{
      sequence: asNumber(sequence, 0),
      contactIdentityId,
      messageId,
      direction,
      plaintext,
      createdAtMs: asNumber(createdAtMs, 0),
    }];
  });
}

/**
 * Folds one CLI result into the state. Pure.
 *
 * Relay health is derived from the frozen surface rather than from a health endpoint of its own:
 * a `poll` or `relay publish` that succeeded proves the relay answered, and exit 4 proves it did
 * not. `uptimeMs` therefore stays null — the CLI does not report it, and inventing a number the
 * console did not observe would be worse than an empty field.
 */
export function applyOutcome(state: OperatorState, request: CliRequest, outcome: CliOutcome, atMs: number): OperatorState {
  const health = outcome.ok
    ? { ...state.health, status: "healthy" as const, checkedAtMs: atMs }
    : outcome.exitCode === 4
      ? { ...state.health, status: "unreachable" as const, checkedAtMs: atMs }
      : state.health;
  const touchedRelay = request.command === "poll" || request.command === "relay publish" || request.command === "send";
  const next: OperatorState = { ...state, health: touchedRelay ? health : state.health };

  if (!outcome.ok) return next;
  const data = outcome.data;

  switch (request.command) {
    case "doctor": {
      if (!isRecord(data)) return next;
      const profiles = next.profiles.map((profile, index) => index !== next.activeProfile ? profile : {
        ...profile,
        identityId: typeof data.identity_id === "string" ? data.identity_id : profile.identityId,
        deviceId: typeof data.device_id === "string" ? data.device_id : profile.deviceId,
        contactCount: asNumber(data.contact_count, profile.contactCount),
      });
      return { ...next, profiles };
    }
    case "poll": {
      if (!isRecord(data)) return next;
      return {
        ...next,
        mailbox: {
          outboxPending: next.mailbox.outboxPending,
          inboxReceived: next.mailbox.inboxReceived + asNumber(data.received, 0),
          more: data.more === true,
          lastPolledAtMs: atMs,
        },
        rejections: readRejections(data.rejected),
      };
    }
    case "relay publish": {
      const profiles = next.profiles.map((profile, index) => index === next.activeProfile ? { ...profile, published: true } : profile);
      return { ...next, profiles };
    }
    case "send":
      return { ...next, mailbox: { ...next.mailbox, outboxPending: next.mailbox.outboxPending + 1 } };
    case "history":
      return { ...next, history: readHistoryEntries(data) };
    default:
      return next;
  }
}

/**
 * The only impure function in `src/tui`.
 *
 * It owns the alternate screen, raw mode, the clock and the child process, and receives every one
 * of them through `TuiIo`. Everything it decides, it decides by calling `mapKey` and `reduce`; it
 * executes the effects they describe and does nothing else, which is why the interaction model can
 * be driven end to end by a test with no process and no terminal.
 */
export function runTuiShell(io: TuiIo, state: OperatorState): Promise<number> {
  let current = state;
  let running = true;

  /**
   * The terminal's OWN size, never clamped up to `MIN_VIEWPORT`.
   *
   * MEASURED (flow 003 T2 §4, D-4): clamping up wrote sixteen 72-column lines into a 40×10 window,
   * the terminal wrapped every one of them, and `UNAUDITED_NOTICE` — flow 002's AC6 — scrolled off
   * the top. `renderFrame` is total at any viewport and paints a degraded frame below the minimum,
   * so the honest thing is to hand it the size that was reported. A terminal that reports nothing
   * at all (a pipe) still falls back to `MIN_VIEWPORT`, which is a default rather than a clamp.
   */
  const viewport = (): Viewport => ({
    cols: Math.max(1, Math.floor(io.stdout.columns ?? MIN_VIEWPORT.cols)),
    rows: Math.max(1, Math.floor(io.stdout.rows ?? MIN_VIEWPORT.rows)),
  });

  const paint = (): void => {
    const painted = viewport();
    io.stdout.write(`${HOME}${styleFrame(renderFrame(current, painted)).join("\r\n")}`);
    // Set only AFTER the frame carrying the modal has been written. This is the whole content of
    // the `renderedAt` gate in `reduce`.
    //
    // The degraded frame below `MIN_VIEWPORT` carries no modal, so writing it is not the operator
    // seeing the four identifiers. Recording `renderedAt` there would let a confirmation through
    // for a modal that was never painted, which is exactly what the gate exists to refuse.
    const modal = current.modal;
    if (modal !== undefined && modal.renderedAt === null && !isBelowMinViewport(painted)) {
      current = { ...current, modal: { ...modal, renderedAt: io.now() } };
    }
    // The same gate, for the same reason, on the compose row: the degraded frame carries no input
    // row either, so writing one is not the operator seeing what Enter would send.
    const input = current.input;
    if (input !== undefined && input.renderedAt === null && !isBelowMinViewport(painted)) {
      current = { ...current, input: { ...input, renderedAt: io.now() } };
    }
  };

  const note = (text: string): void => {
    current = { ...current, activity: [...current.activity, { at: io.now(), text }].slice(-64) };
  };

  /**
   * The contact the operator confirmed in the modal, held until the child exits.
   *
   * The roster records contacts this session OBSERVED being imported, and an import the CLI then
   * refused was not one. Waiting for the exit code keeps the roster from claiming a trust
   * relationship that does not exist in the store.
   */
  let confirmed: TrustModal | undefined;

  const observeContact = (modal: TrustModal): void => {
    const { identity_id: identityId, device_id: deviceId, device_pubkey: devicePubkey, signal_identity_key: signalIdentityKey } = modal.identifiers;
    if (identityId === undefined || deviceId === undefined || devicePubkey === undefined || signalIdentityKey === undefined) return;
    if (current.contacts.some((contact) => contact.identityId === identityId)) return;
    const contact: ContactView = { identityId, deviceId, devicePubkey, signalIdentityKey };
    current = { ...current, contacts: [...current.contacts, contact] };
  };

  const apply = async (effect: Effect): Promise<void> => {
    switch (effect.kind) {
      case "run-cli": {
        const outcome = await io.runCli(effect.request);
        note(`${effect.request.command} → ${outcome.code} (exit ${outcome.exitCode})`);
        current = { ...applyOutcome(current, effect.request, outcome, io.now()), busy: false };
        if (effect.request.command === "contact import") {
          if (outcome.ok && confirmed !== undefined) observeContact(confirmed);
          confirmed = undefined;
        }
        return;
      }
      case "answer-trust-prompt":
        io.answerTrustPrompt(effect.answer);
        note(effect.answer ? "contact import → confirmed by operator" : "contact import → declined by operator");
        return;
      case "quit":
        running = false;
        return;
      default:
        return;
    }
  };

  return new Promise<number>((settle) => {
    io.stdin.setRawMode?.(true);
    io.stdin.resume();
    io.stdout.write(ALTERNATE_SCREEN_ON);

    io.onTrustIdentifiers?.((input) => {
      current = {
        ...current,
        modal: { kind: "trust", cardPath: input.cardPath, profileLabel: input.profileLabel, identifiers: { ...input.identifiers }, renderedAt: null },
      };
      paint();
    });

    const finish = (): void => {
      io.stdin.setRawMode?.(false);
      io.stdin.pause();
      io.stdout.write(ALTERNATE_SCREEN_OFF);
      settle(0);
    };

    io.stdin.on("data", (chunk: Buffer) => {
      if (!running) return;
      const intent = mapKey(decodeKey(chunk), current);
      if (intent === undefined) return;
      const open = current.modal;
      const step = reduce(current, intent);
      // The reducer clears the modal, so the identifiers the operator just checked are captured
      // here — and only when the reducer actually emitted the confirmation, which is where the
      // four-identifier and never-painted gates live.
      if (open !== undefined && step.effects.some((effect) => effect.kind === "answer-trust-prompt" && effect.answer)) {
        confirmed = open;
      }
      current = step.state;
      paint();
      void (async () => {
        for (const effect of step.effects) await apply(effect);
        if (running) paint();
        else finish();
      })();
    });

    paint();
  });
}
