import type { CliCommand, CliOutcome, CliRequest } from "./cli-bridge";
import { explain } from "./failure-text";
import type { Effect, Intent, Step } from "./intents";
import { modalIntent, trustModalIsComplete } from "./modal-host";
import { MIN_VIEWPORT, isBelowMinViewport, renderFrame, styleFrame } from "./shell-chrome";
import {
  PANE_IDS,
  inputMaxBytes,
  nextSetupStep,
  type ContactView,
  type HistoryEntryView,
  type InputField,
  type InputState,
  type KeyEvent,
  type OperatorState,
  type ProfileState,
  type ProfileView,
  type RejectionView,
  type StepOutcome,
  type TrustIdentifiers,
  type TrustModal,
  type Viewport,
} from "./state";
import { paintable, utf8Bytes } from "./text";

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
    /*
     * AC8, in the one state the criterion names explicitly (004-T12-verify, F-005). `modalIntent`
     * refuses every modified key, so before this line no key at all left the console while the modal
     * was up and the modal's footer said nothing about it: the operator's only exit was to cancel a
     * decision they may not have wanted to cancel, and a console that cannot be left is worse than a
     * lost draft.
     *
     * Bound HERE rather than in `modalIntent` on purpose. `modal-host.ts` refuses modified keys so
     * that the one irreversible decision on this surface is not reachable by a near miss such as
     * Ctrl-Y, and that rule stays exactly as it is. This is also the only one of the verifier's two
     * suggested fixes the existing tests permit: `TRUST_MODAL_FOOTER` is pinned to exactly y/n/esc,
     * so naming the way out in the footer instead is not available.
     */
    if (key.ctrl) return key.name.toLowerCase() === "c" ? { kind: "quit" } : undefined;
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
      /*
       * The fourth precondition is publication, and it is step 2 of the checklist enforcing itself
       * (t35 §2.1): `outbound.ts:152` refuses an unpublished sender LOCALLY, before it spends a
       * peer's prekey, and `writeResult` drops the actionable sentence it refuses with. So a console
       * that let the operator compose first would spend a keystroke, a child and a draft to earn a
       * bare `SENDER_NOT_PUBLISHED` it cannot explain.
       */
      return state.pane !== "history" || state.selectedContactId === null || state.busy || profile.published !== true
        ? undefined
        : { kind: "input-open", field: "message" };
    case "return":
      /*
       * The checklist advances one step per keystroke, and never further (t35 §2.1, "Advancing is
       * manual"). Chaining 1→2→3 was rejected there: two of the three need an operand the operator
       * has to supply anyway, and a console that ran three commands from one keystroke makes "which
       * of the three failed" a question the operator reconstructs from a log rather than reads on a
       * line.
       *
       * Bound on the profiles pane, which is where the checklist is painted, and refused outright
       * while a child is alive rather than left to the D-1 gate below — because half the steps open
       * an operand row rather than a `run`, and a row opened during a command would be a second
       * thing in flight in everything but name.
       */
      return state.pane !== "profiles" || state.busy ? undefined : setupStepIntent(profile);
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

/**
 * What `Enter` starts on the profiles pane: the NEXT incomplete step, or nothing.
 *
 * Two of the five steps run straight away because every operand they need is already known; three
 * open the input row first, because an operand the console guessed would be an operand the operator
 * never named. `nextSetupStep` is where step 0 gates step 1 — with the store key absent it returns
 * `undefined`, so no keystroke on this pane can spawn a child at all.
 */
function setupStepIntent(profile: ProfileView): Intent | undefined {
  const step = nextSetupStep(profile);
  const profileDir = profile.profileDir;
  switch (step) {
    case 1:
      // t35 §2.1 gives the relay URL no default, and `main.ts --relay-url` already puts one on the
      // profile. Read together: the console invents none, and a URL supplied at launch is the
      // profile's own and is used directly. An empty one opens the row instead of guessing.
      return profile.relayUrl === ""
        ? { kind: "input-open", field: "relay-url" }
        : { kind: "run", request: { command: "init", profileDir, relayUrl: profile.relayUrl, storeKeyEnv: profile.storeKeyEnv } };
    case 2:
      return { kind: "run", request: { command: "relay publish", profileDir } };
    case 3:
      return { kind: "input-open", field: "export-path" };
    case 4:
      return { kind: "input-open", field: "card-path" };
    case 5:
      return { kind: "run", request: { command: "doctor", profileDir } };
    default:
      return undefined;
  }
}

/**
 * A UTC instant with nothing in it a path separator could be mistaken for.
 *
 * Read off `state.observedAtMs` rather than a clock, so `reduce` stays pure: the shell folds a
 * reading in at startup and after every settled command (t35 §2.3).
 */
function cardInstant(atMs: number): string {
  const at = Number.isFinite(atMs) ? atMs : 0;
  return new Date(at).toISOString().replace(/[-:.]/g, "");
}

/**
 * What an operand row opens with.
 *
 * Only step 3's export path is generated, and it is generated because `contact export` writes with
 * `flag: "wx"`: a second export over the same path is `PERSISTENCE_FAILURE` at exit 5, cards expire
 * after seven days, so re-export is routine. A timestamped name costs nothing and never destroys a
 * card a peer may still be importing — which is why `contact export --force` was rejected.
 *
 * The relay URL deliberately opens EMPTY even though the profile carries one: the only branch that
 * opens it is the one where the profile's URL is empty, and prefilling from a field that is empty by
 * construction would read as a default the console had invented.
 */
function initialBuffer(state: OperatorState, field: InputField): string {
  const profile = state.profiles[state.activeProfile];
  if (profile === undefined) return "";
  switch (field) {
    case "export-path":
      return `${profile.profileDir}/card-${cardInstant(state.observedAtMs ?? 0)}.json`;
    case "card-path":
      return profile.contactCardPath ?? "";
    default:
      return "";
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
          input: { field: intent.field, buffer: initialBuffer(state, intent.field), renderedAt: null, maxBytes: inputMaxBytes(intent.field) },
        },
        effects: [],
      };
    case "input-insert": {
      const input = state.input;
      if (input === undefined || state.modal !== undefined) return { state, effects: [] };
      /*
       * AC7, at the boundary. Every control point and every display-steering point is dropped here,
       * so a paste carrying an escape sequence inserts its printable remainder and nothing else, and
       * no later renderer change can reintroduce the byte. The property belongs to the state:
       * `renderFrame` filters nothing, and the test that proves this does not import it (t35 §5
       * item 4).
       *
       * The compose row uses the SAME predicate as the six inbound boundaries, and not a narrower
       * one, because what the operator composes becomes a correspondent's inbound plaintext on the
       * other side of the relay: a console that refuses to paint a stranger's right-to-left override
       * and cheerfully sends one exports the hazard it declines to import.
       */
      const text = paintable(intent.text);
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
      // A relay URL the operator typed becomes the profile's own, so a retry after a failed `init`
      // does not ask for it a second time and the pane stops claiming the profile has none. It is an
      // operand, not a secret: it is already on screen, already in the argv, and already in the
      // runbook's own launcher.
      const profiles = request.command !== "init"
        ? state.profiles
        : state.profiles.map((profile, index) => (index === state.activeProfile ? { ...profile, relayUrl: request.relayUrl } : profile));
      // `busy` is set here for the same reason `run` sets it: one command in flight at a time, and
      // the unit is one operator action.
      return { state: { ...state, profiles, input: undefined, busy: true }, effects: [{ kind: "run-cli", request }] };
    }
    case "quit":
      return { state, effects: [{ kind: "quit" }] };
    default:
      return { state, effects: [] };
  }
}

/**
 * The four trust identifiers, filtered where they ENTER the state.
 *
 * Absent stays absent: `trustModalIsComplete` refuses a confirmation while any of the four is
 * missing, and turning a missing identifier into an empty string would satisfy that refusal with
 * nothing for the operator to compare.
 */
function paintableIdentifiers(identifiers: TrustIdentifiers): TrustIdentifiers {
  const clean = (value: string | undefined): string | undefined => (value === undefined ? undefined : paintable(value));
  return {
    identity_id: clean(identifiers.identity_id),
    device_id: clean(identifiers.device_id),
    device_pubkey: clean(identifiers.device_pubkey),
    signal_identity_key: clean(identifiers.signal_identity_key),
  };
}

/**
 * The request a submitted buffer builds, or `undefined` when it would be incomplete.
 *
 * Four of the seven fields have a submit: one message and three registration operands. The other
 * three — `profile-dir`, `store-key-env` and `contact-name` — are operands of steps that do not
 * exist yet, no key opens them, and a submit on one is a refusal rather than a guess at what it
 * meant. Every refusal here is also the deep half of a gate `mapKey` holds: a submit arriving from
 * anywhere at all meets the same precondition.
 *
 * The message body travels on the request OBJECT and never in an argv: `buildArgv` puts `text` in no
 * token, and `main.ts` writes it to the child's stdin. That is AC3, and it is why this is a `send`
 * request rather than a command line.
 */
function submitRequest(state: OperatorState, input: InputState): CliRequest | undefined {
  const profile = state.profiles[state.activeProfile];
  if (profile === undefined) return undefined;
  const value = input.buffer;
  const profileDir = profile.profileDir;
  switch (input.field) {
    case "message": {
      const to = state.selectedContactId;
      // Publication gates every send, here as well as at the key, because `outbound.ts:152` refuses
      // an unpublished sender before it spends a peer's prekey.
      if (to === null || value === "" || profile.published !== true) return undefined;
      return { command: "send", profileDir, to, text: value };
    }
    case "relay-url":
      // Step 0 gates step 1 here too: the store key must already be in this console's environment,
      // and `storeKeyPresent` is the only thing about it this process may hold.
      if (value === "" || profile.storeKeyPresent !== true) return undefined;
      return { command: "init", profileDir, relayUrl: value, storeKeyEnv: profile.storeKeyEnv };
    case "export-path":
      if (value === "") return undefined;
      return { command: "contact export", profileDir, out: value };
    case "card-path":
      // Deliberately without `--yes`: the child prints the four identifiers and the operator answers
      // the child's own prompt, so the trust decision never moves into the console.
      if (value === "") return undefined;
      return { command: "contact import", profileDir, from: value };
    default:
      return undefined;
  }
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

/**
 * One raw chunk, split into the keystrokes it carries.
 *
 * MEASURED: a pipe delivers `Enter` and `?` written back to back as the single chunk `"\r?"`, and
 * `decodeKey` reads that as Ctrl-M — so BOTH keystrokes are lost, silently, and the console looks
 * hung. A terminal does the same thing to anyone typing faster than one key per read, which is every
 * operator who has ever pressed `1` and `p` together.
 *
 * A chunk from ESC onwards is kept WHOLE and is one keystroke. That is what keeps a bare Escape a
 * cancel and an arrow key — `ESC [ A` — a single refused key rather than three: decoding arrows
 * would put an escape-sequence decoder in the input path of a program whose security argument rests
 * on the pure layer emitting no escape bytes, and splitting them would paste their letters instead.
 *
 * Splitting happens only where a chunk is a burst of KEYS. While the compose row is open every byte
 * after the first is TEXT, so the chunk is handed over whole and a paste stays one insertion.
 */
function splitKeystrokes(chunk: string): string[] {
  const points = [...chunk];
  const keys: string[] = [];
  for (let at = 0; at < points.length; at += 1) {
    const point = points[at] ?? "";
    if (point === ESC) {
      keys.push(points.slice(at).join(""));
      return keys;
    }
    keys.push(point);
  }
  return keys;
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
    // operator's screen and out of the state. `paintable` is the same act on the BYTES of the two
    // fields that are kept — a rejected envelope is by definition one an untrusted or hostile sender
    // put in the mailbox, which is the ground `formatRejectionLine` already refuses to widen on.
    return typeof envelopeId === "string" && typeof code === "string"
      ? [{ envelopeId: paintable(envelopeId), code: paintable(code) }]
      : [];
  });
}

function readHistoryEntries(value: unknown): HistoryEntryView[] {
  if (!isRecord(value) || !Array.isArray(value.entries)) return [];
  return value.entries.flatMap((entry): HistoryEntryView[] => {
    if (!isRecord(entry)) return [];
    const { sequence, contactIdentityId, messageId, direction, plaintext, createdAtMs } = entry;
    if (typeof contactIdentityId !== "string" || typeof messageId !== "string" || typeof plaintext !== "string") return [];
    if (direction !== "inbound" && direction !== "outbound") return [];
    /*
     * `plaintext` is the decrypted body of a message a CORRESPONDENT wrote, which makes this the one
     * route in the class whose bytes are chosen by someone outside this machine entirely. It is
     * filtered here, where the field is written, rather than in the renderer: `renderFrame` is not
     * the only reader of history, and a renderer that defended itself would leave the STATE free to
     * hold an escape sequence and would need re-auditing the day a second reader appeared.
     *
     * The two identifiers are filtered for the same reason and on the same line of the same pane
     * (history-pane.ts:41): a filter applied to the body alone would leave that line exactly as
     * steerable as it was.
     */
    return [{
      sequence: asNumber(sequence, 0),
      contactIdentityId: paintable(contactIdentityId),
      messageId: paintable(messageId),
      direction,
      plaintext: paintable(plaintext),
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
/**
 * Which registration step each command completes (t35 §2.1). `poll`, `history` and `send` complete
 * none: they are not steps, and a console that folded them onto one would report progress the
 * operator did not make.
 */
const SETUP_STEP_OF: Readonly<Record<string, number | undefined>> = {
  init: 1,
  "relay publish": 2,
  "contact export": 3,
  "contact import": 4,
  doctor: 5,
};

/** `doctor` completes step 5 only with a non-zero `contact_count`; every other step, on exit 0. */
function stepSucceeded(request: CliRequest, outcome: CliOutcome): boolean {
  if (request.command !== "doctor") return true;
  return isRecord(outcome.data) && asNumber(outcome.data.contact_count, 0) > 0;
}

/** The `identity_id` an `init` or a `doctor` reported, which is what proves the profile is there. */
function reportedIdentity(request: CliRequest, outcome: CliOutcome): string | undefined {
  if (request.command !== "init" && request.command !== "doctor") return undefined;
  if (!outcome.ok || !isRecord(outcome.data)) return undefined;
  return typeof outcome.data.identity_id === "string" ? outcome.data.identity_id : undefined;
}

/**
 * Folds one outcome onto the active profile's checklist. Pure, and derived from nothing but the
 * result the CLI returned.
 *
 * A profile with no `setup` is untouched: the checklist belongs to profiles the composition root
 * built, and every surface that predates it keeps the shape it had.
 *
 * Two rules, both of which are refusals to guess. A step that succeeded says NOTHING about the steps
 * after it, so they are returned to `pending` rather than inherited — a stale failure from an
 * earlier attempt is not evidence about a step that has not been tried since. And `state` moves only
 * on the two things a result actually proves: `INVALID_CONFIGURATION` at exit 2 proves the profile
 * is not there (six causes share that one code, and this is all of it the console can know), and an
 * `identity_id` proves it is.
 */
function foldSetup(state: OperatorState, request: CliRequest, outcome: CliOutcome): readonly ProfileView[] {
  const step = SETUP_STEP_OF[request.command];
  const identity = reportedIdentity(request, outcome);
  const absent = !outcome.ok && outcome.code === "INVALID_CONFIGURATION" && outcome.exitCode === 2;

  return state.profiles.map((profile, index) => {
    const setup = profile.setup;
    if (index !== state.activeProfile || setup === undefined) return profile;

    const profileState: ProfileState | undefined = absent ? "absent" : identity !== undefined ? "ready" : profile.state;
    if (step === undefined) return { ...profile, state: profileState };

    const value: StepOutcome = outcome.ok
      ? (stepSucceeded(request, outcome) ? "ok" : "pending")
      : { failed: paintable(outcome.code), exitCode: outcome.exitCode };
    const folded = setup.map((previous, at): StepOutcome => (at === step ? value : at > step ? "pending" : previous));
    return { ...profile, state: profileState, setup: folded };
  });
}

/**
 * The figure a result carried for a mailbox count, or the last one that was carried.
 *
 * A result that reports nothing about a count is not evidence that the count is zero, and it is not
 * evidence that the previous report has stopped being true either: it is silence. So the previous
 * value stands, which is what keeps an unreadable child from erasing what a readable one said.
 */
function reportedCount(value: unknown, previous: number | null): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : previous;
}

export function applyOutcome(state: OperatorState, request: CliRequest, outcome: CliOutcome, atMs: number): OperatorState {
  const health = outcome.ok
    ? { ...state.health, status: "healthy" as const, checkedAtMs: atMs }
    : outcome.exitCode === 4
      ? { ...state.health, status: "unreachable" as const, checkedAtMs: atMs }
      : state.health;
  const touchedRelay = request.command === "poll" || request.command === "relay publish" || request.command === "send";
  const next: OperatorState = {
    ...state,
    health: touchedRelay ? health : state.health,
    profiles: foldSetup(state, request, outcome),
    /*
     * The outbox figure, decided once for every command and every outcome, refusals included.
     *
     * No command in the frozen eight reports one (`MailboxView` enumerates what `doctor` does
     * report), so the figure a result carried is always the absence of one — there is no earlier
     * report here for a refusal to erase, which is why this is written unconditionally rather than
     * carried forward the way `inboxReceived` is. The day a command does report a pending count,
     * this line becomes `reportedCount(that field, state.mailbox.outboxPending)` and the rest of the
     * rule is already in place.
     *
     * What must never come back is the increment that stood here: `outboxPending + 1` on a
     * SUCCESSFUL send, which does not merely guess — it guesses in the direction opposite to the one
     * the store moved, since a delivered message leaves the pending set rather than joining it.
     */
    mailbox: { ...state.mailbox, outboxPending: null },
  };

  if (!outcome.ok) return next;
  const data = outcome.data;

  switch (request.command) {
    // `init` returns the identical `summary()` shape `doctor` returns — `identity_id`, `device_id`,
    // `profile_id` — so the same case serves both (t35 §2.1). One fold, no second parser, and no
    // second place for a child's bytes to enter the state unfiltered.
    case "init":
    case "doctor": {
      if (!isRecord(data)) return next;
      // `label`, `relayUrl` and `profileDir` come from the operator's own argv and are outside this
      // class. These two do NOT: they are overwritten from the child's JSON on every `doctor`, and
      // `formatProfilesLines` (profiles-pane.ts:72-73) repaints them as the `identity` and `device`
      // rows on every subsequent frame the profiles pane is on.
      const profiles = next.profiles.map((profile, index) => index !== next.activeProfile ? profile : {
        ...profile,
        identityId: typeof data.identity_id === "string" ? paintable(data.identity_id) : profile.identityId,
        deviceId: typeof data.device_id === "string" ? paintable(data.device_id) : profile.deviceId,
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
          // `received` VERBATIM, and never added to what a previous poll reported: it is "envelopes
          // accepted and committed by this poll" (`runtime/inbound.ts:27`), so a second poll that
          // accepts none honestly reports `0`. A result that carries no number at all reports
          // nothing, and the last poll's figure stands.
          inboxReceived: reportedCount(data.received, next.mailbox.inboxReceived),
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
      /*
       * A send changes no count on this surface, and that is the whole of the case.
       *
       * `send`'s success result is `{ messageId, envelopeId, status }` (`runtime/outbound.ts:46`)
       * and carries no mailbox figure at all, so there is nothing here to read verbatim. The state
       * that did move is the conversation, and the console learns it the only way it can: by running
       * `history`, which returns what the store holds.
       */
      return next;
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
/**
 * What one settled command becomes on the activity line.
 *
 * The head is unchanged and stays first, deliberately: `${command} → ${code} (exit ${N})` is what an
 * operator quotes in a bug report, and it is what survives when the line is clipped at a narrow
 * terminal — at `MIN_VIEWPORT` the activity line is one 72-column row and the words have nowhere to
 * go. So the sentence is an ADDITION beside the code, never a replacement for it.
 *
 * The code therefore appears twice on a wide terminal: once as the value, and once inside the
 * sentence that explains it. That is the cost of `explain` returning text that is complete on its
 * own — a caller that trimmed the repetition would be composing the module's prose for it, and this
 * is the one line where the two obligations meet.
 *
 * Nothing is composed for a success: a console that named a class on every frame would tell the
 * operator a successful poll failed.
 */
function outcomeLine(command: CliCommand, outcome: CliOutcome): string {
  const head = `${command} → ${outcome.code} (exit ${String(outcome.exitCode)})`;
  if (outcome.ok) return head;
  const text = explain(command, outcome.code, outcome.exitCode);
  return `${head}  ${text.sentence} ${text.action}`;
}

export function runTuiShell(io: TuiIo, state: OperatorState): Promise<number> {
  // The first of the two moments a clock reading is folded in (t35 §2.3). It is done HERE, in the
  // one impure function, so that `reduce` can build a timestamped export path without reading a
  // clock and `renderFrame` stays a deterministic function of its two arguments.
  let current: OperatorState = { ...state, observedAtMs: state.observedAtMs ?? io.now() };
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

  /**
   * The activity line, and the boundary for the CLI's own error `code`.
   *
   * `parseCliOutcome` keeps `error.code` verbatim, deliberately: the refusals the CLI reports under
   * the relay's own name have to stay distinguishable. Keeping the NAME distinguishable does not
   * require keeping the BYTES paintable, and `activityLine` puts the newest entry on every frame.
   * Filtering the whole composed line rather than the interpolated code covers every caller of
   * `note`, present and future, at the one place the text becomes state.
   */
  const note = (text: string): void => {
    current = { ...current, activity: [...current.activity, { at: io.now(), text: paintable(text) }].slice(-64) };
  };

  /**
   * The contact the operator confirmed in the modal, held until the child exits.
   *
   * The roster records contacts this session OBSERVED being imported, and an import the CLI then
   * refused was not one. Waiting for the exit code keeps the roster from claiming a trust
   * relationship that does not exist in the store.
   */
  let confirmed: TrustModal | undefined;

  /*
   * The identifiers are already paintable when they get here: the only modal this can be handed is
   * one the trust listener above wrote, and that is where they were filtered. A second filter on
   * this copy would be a second place to keep in agreement with the first, and would hide the fact
   * that the guarantee belongs to the state rather than to each of its readers.
   */
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
        note(outcomeLine(effect.request.command, outcome));
        // The second moment the clock is read into the state, for the reason above.
        current = { ...applyOutcome(current, effect.request, outcome, io.now()), busy: false, observedAtMs: io.now() };
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

    /*
     * The boundary for the contact card's four identifiers, and it is HERE rather than in the modal
     * or in `renderModal` because this listener is the sole writer of `modal`: `reduce` only ever
     * clears it, and `createInitialState` starts it undefined. The card was authored by whoever is
     * asking to be trusted, and the modal is the one document this surface exists to make a human
     * read.
     *
     * Filtering at the writer is also what closes the ROSTER route: `observeContact` copies these
     * four out of the confirmed modal into `state.contacts`, where the profiles pane repaints them
     * for the rest of the session, long after the panel that carried them is gone. It inherits the
     * guarantee from here instead of holding a second copy of it.
     */
    io.onTrustIdentifiers?.((input) => {
      current = {
        ...current,
        modal: { kind: "trust", cardPath: input.cardPath, profileLabel: input.profileLabel, identifiers: paintableIdentifiers(input.identifiers), renderedAt: null },
      };
      paint();
    });

    /**
     * The one command the console runs that the operator did not press (t35 §2.1, §5 item 6).
     *
     * Without it the console begins knowing neither its own identity nor whether the profile exists
     * — `"(run doctor)"` where an identity belongs, and a checklist that cannot say which step is
     * next — which is flow 003 T2 §1.3's measured complaint. It is read-only, touches no relay,
     * creates no trust, spawns exactly one child, and is subject to the same single-flight rule as
     * every other command: it goes through `reduce`, so it sets `busy` and a keystroke arriving
     * while it runs is refused and told so on the activity line.
     *
     * It runs only for a profile whose `state` is `"unknown"` — a profile the composition root built
     * and has observed nothing about. A profile handed to this shell by a script, with no state to
     * be unknown, is left exactly alone.
     */
    const askWhatIsThere = (): void => {
      const profile = current.profiles[current.activeProfile];
      if (profile === undefined || profile.state !== "unknown") return;
      const step = reduce(current, { kind: "run", request: { command: "doctor", profileDir: profile.profileDir } });
      current = step.state;
      paint();
      void (async () => {
        for (const effect of step.effects) await apply(effect);
        if (running) paint();
      })();
    };

    const finish = (): void => {
      io.stdin.setRawMode?.(false);
      io.stdin.pause();
      io.stdout.write(ALTERNATE_SCREEN_OFF);
      settle(0);
    };

    const handleKey = (sequence: string): void => {
      const intent = mapKey(decodeKey(sequence), current);
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
    };

    io.stdin.on("data", (chunk: Buffer) => {
      if (!running) return;
      const text = chunk.toString("utf8");
      /*
       * One chunk can carry more than one keystroke, and each of them is the operator's. While the
       * compose row is open the chunk is the operator's TEXT instead, and is inserted whole.
       *
       * Nothing here evades the single-flight rule: `reduce` sets `busy` synchronously, and the D-1
       * gate reads it, so the second key of a burst meets a console that is already running one
       * command and is refused exactly as a second keystroke a second later would be.
       */
      for (const key of current.input === undefined ? splitKeystrokes(text) : [text]) {
        if (!running) return;
        handleKey(key);
      }
    });

    paint();
    askWhatIsThere();
  });
}
