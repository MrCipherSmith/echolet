/**
 * The operator TUI's state model (flow 002 T9).
 *
 * Every type here is data the surface may render. That is the whole of AC5's structural half:
 * **no field in this file can hold key material.** A profile carries the NAME of the environment
 * variable that holds its 32-byte store key (`storeKeyEnv`), never its value, so the key reaches
 * `dist/cli.js` the way the runbook already passes it — through the inherited environment, named
 * by `--store-key-env` — and the TUI never reads it, renders it, or writes it into an argv.
 *
 * See `.metaproject/flows/002-.../t9-operator-tui-design.md` §3.
 */

import { MAX_PLAINTEXT_BYTES } from "../limits";

/** Terminal dimensions the renderer is given. Never read from the environment inside a pure path. */
export interface Viewport {
  readonly cols: number;
  readonly rows: number;
}

/** One fully painted screen, as plain text. Styling is applied afterwards by `styleFrame`. */
export type Frame = readonly string[];

/** The pluggable inspector panes, mirroring the reference TUI's pane model. */
export const PANE_IDS = ["profiles", "mailbox", "history", "rejections", "health"] as const;
export type PaneId = (typeof PANE_IDS)[number];

/** A raw-mode key, reduced to the three fields the input model reads. */
export interface KeyEvent {
  readonly name: string;
  readonly ctrl: boolean;
  readonly sequence: string;
}

/**
 * One local profile as the operator sees it.
 *
 * `storeKeyEnv` is the environment variable NAME. There is deliberately no field for its value.
 */
export interface ProfileView {
  readonly label: string;
  readonly profileDir: string;
  readonly relayUrl: string;
  readonly storeKeyEnv: string;
  readonly identityId: string;
  readonly deviceId: string;
  /** `contact_count` as last reported by `doctor`; the authority on how many contacts are pinned. */
  readonly contactCount: number;
  readonly published: boolean;
  /**
   * The contact card this session may import, if the operator named one at startup.
   *
   * A filesystem path, never a secret: contact cards hold the four PUBLIC identifiers the
   * specification requires a human to check, which is why the TUI can read one without any key.
   * It lives here so that `mapKey` stays a pure function of the state — the import key has to
   * know which card it would import.
   */
  readonly contactCardPath?: string;
}

/**
 * A contact this session observed being imported through the trust modal. See the design note §6.
 *
 * An export creates no trust, so a card this session handed out never reaches this list.
 */
export interface ContactView {
  readonly identityId: string;
  readonly deviceId: string;
  readonly devicePubkey: string;
  readonly signalIdentityKey: string;
  readonly displayName?: string;
}

export interface MailboxView {
  readonly outboxPending: number;
  readonly inboxReceived: number;
  /** The relay's remaining-work signal from the last `poll`. */
  readonly more: boolean;
  readonly lastPolledAtMs: number | null;
}

/**
 * One permanently rejected envelope, carrying exactly what `poll` reports and nothing else.
 * Mirrors `runtime/inbound.ts` `RejectedEnvelope`: no ciphertext, no plaintext, no sender string.
 */
export interface RejectionView {
  readonly envelopeId: string;
  readonly code: string;
}

export interface HistoryEntryView {
  readonly sequence: number;
  readonly contactIdentityId: string;
  readonly messageId: string;
  readonly direction: "inbound" | "outbound";
  readonly plaintext: string;
  readonly createdAtMs: number;
}

export interface RelayHealthView {
  readonly relayUrl: string;
  readonly status: "healthy" | "unreachable" | "unknown";
  readonly uptimeMs: number | null;
  readonly checkedAtMs: number | null;
}

/** The four identifiers the specification requires a human to check before trust is recorded. */
export interface TrustIdentifiers {
  readonly identity_id?: string;
  readonly device_id?: string;
  readonly device_pubkey?: string;
  readonly signal_identity_key?: string;
}

/**
 * The confirmation surface for `contact import` — the only operation that creates Echolet trust.
 *
 * `renderedAt` is set by the shell once the modal has actually been painted. The reducer refuses a
 * confirmation while it is null, so trust cannot be recorded from a modal the operator never saw.
 */
export interface TrustModal {
  readonly kind: "trust";
  readonly cardPath: string;
  readonly profileLabel: string;
  readonly identifiers: TrustIdentifiers;
  readonly renderedAt: number | null;
}

export type Modal = TrustModal | undefined;

/**
 * The seven operands this console has to be able to accept from the keyboard (t35 §3.1).
 *
 * Every one of them is an operand the CLI already takes — a relay URL, a profile directory, the
 * NAME of the store-key variable, a path to write a card to, a path to import one from, a message
 * body, a local label for a contact. None of them is, or can become, key material: `store-key-env`
 * is a variable name for exactly the reason `ProfileView.storeKeyEnv` is one.
 */
export type InputField =
  | "relay-url"
  | "profile-dir"
  | "store-key-env"
  | "export-path"
  | "card-path"
  | "message"
  | "contact-name";

/**
 * The row the operator types into.
 *
 * It is a FIELD on the state and deliberately not a second `Modal`, for the reason recorded on
 * `help` below: composing a message is not a decision, and the trust gate must never have a second
 * door. `tui-shell.inputTrustExclusion.test.ts` holds that half — the two can never be open at
 * once, because `reduce` refuses to open this row while a modal is up or while a child is alive,
 * and a trust modal is only ever opened by the `contact import` handshake, which runs while one is.
 *
 * `buffer` never contains a control character: `reduce` filters at the boundary, so the "no ESC
 * byte in a frame" property belongs to the state rather than to the renderer's defensiveness
 * (AC7, and t35 §5 item 4).
 *
 * `renderedAt` is the trust modal's painted-at gate, reused rather than reinvented: the shell sets
 * it only after a frame that was not below `MIN_VIEWPORT` was written, and `reduce` refuses a
 * submit while it is null. Below the minimum the frame is the degraded one, which carries no input
 * row, so an operator there would be submitting a body they cannot see. Insertion is deliberately
 * NOT gated — a keystroke into an invisible buffer is recoverable; a send is not.
 */
export interface InputState {
  readonly field: InputField;
  readonly buffer: string;
  readonly renderedAt: number | null;
  /** Counted in UTF-8 BYTES, because that is the unit every bound this console must respect uses. */
  readonly maxBytes: number;
}

/** Paths and URLs (t35 §3.1). Long enough for any real path, short enough to bound a paste. */
const PATH_MAX_BYTES = 1024;
/** Names: `cardSchema`'s own `display_name` bound, and generous for a variable name. */
const NAME_MAX_BYTES = 128;

/**
 * What a field's buffer may not exceed, in UTF-8 bytes.
 *
 * The message bound is the CLI's own: a console that let the operator compose past it would spend
 * a keystroke, a child process and a prekey to earn `INVALID_MESSAGE` at exit 2. The others are
 * the design's stated numbers and are deliberately not measured — moving them costs one line here.
 */
export function inputMaxBytes(field: InputField): number {
  switch (field) {
    case "message":
      return MAX_PLAINTEXT_BYTES;
    case "contact-name":
    case "store-key-env":
      return NAME_MAX_BYTES;
    case "relay-url":
    case "profile-dir":
    case "export-path":
    case "card-path":
    default:
      return PATH_MAX_BYTES;
  }
}

export interface ActivityLine {
  readonly at: number;
  readonly text: string;
}

export interface OperatorState {
  readonly profiles: readonly ProfileView[];
  readonly activeProfile: number;
  readonly contacts: readonly ContactView[];
  readonly selectedContactId: string | null;
  readonly mailbox: MailboxView;
  readonly rejections: readonly RejectionView[];
  readonly history: readonly HistoryEntryView[];
  readonly health: RelayHealthView;
  readonly pane: PaneId;
  readonly modal: Modal;
  readonly activity: readonly ActivityLine[];
  readonly busy: boolean;
  /**
   * True while the key list is open (`?`).
   *
   * Optional, and absent means closed, so a state constructed before this field existed still
   * describes a console with the help list shut. It is a boolean rather than a second `Modal`
   * because the key list is not a decision: it takes no exclusive control of the keyboard and the
   * trust gate must never have a second door.
   */
  readonly help?: boolean;
  /**
   * The compose row, while one is open.
   *
   * Optional, and absent means closed, so a state constructed before this field existed still
   * describes a console that is not composing. It takes exclusive control of the keyboard the way
   * the modal does — while it is defined, `q` is text and no command key spawns a child — but it is
   * not a modal: it decides nothing, and Ctrl-C still leaves.
   */
  readonly input?: InputState;
}

/**
 * The session's starting state.
 *
 * Everything the surface will later show is empty, because the TUI has observed nothing yet: no
 * contact roster, no history, no rejections, and a relay whose health is `"unknown"` rather than
 * assumed. `unknown` is deliberately distinct from `"unreachable"`; an operator standing up a
 * remote relay needs to tell "never checked" from "refused the connection".
 */
export function createInitialState(input: { readonly profiles: readonly ProfileView[] }): OperatorState {
  const profiles = [...input.profiles];
  const first = profiles[0];
  return {
    profiles,
    activeProfile: 0,
    contacts: [],
    selectedContactId: null,
    mailbox: { outboxPending: 0, inboxReceived: 0, more: false, lastPolledAtMs: null },
    rejections: [],
    history: [],
    health: { relayUrl: first?.relayUrl ?? "", status: "unknown", uptimeMs: null, checkedAtMs: null },
    pane: "profiles",
    modal: undefined,
    activity: [],
    busy: false,
  };
}
