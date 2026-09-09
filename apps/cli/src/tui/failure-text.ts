import { UNREADABLE_CLI_OUTPUT, type CliCommand } from "./cli-bridge";
import { paintable } from "./text";

/**
 * What a failure MEANS, in words, beside the code and the class the CLI actually returned.
 *
 * ── Why this module exists ──────────────────────────────────────────────────────────────────
 *
 * The console already shows a failure accurately: `${command} → ${code} (exit ${exitCode})` on the
 * activity line, `${failed} (exit ${exitCode})` on the registration checklist. Accurate is not the
 * same as useful. `PREKEY_BUNDLE_UNAVAILABLE (exit 3)` tells an operator that a trust or protocol
 * failure happened, and every instinct they have about exit 3 is wrong here: nothing is wrong with
 * their profile, nothing was refused about their trust, and the thing to do is on somebody else's
 * machine. That sentence is the one thing the CLI itself cannot deliver, because the CLI answers one
 * command at a time and does not know it is being driven by a console with a checklist and a key
 * for every step.
 *
 * ── The contract, and the two halves it keeps apart ─────────────────────────────────────────
 *
 * `explain` is TOTAL: three arguments in, five fields out, for any code at all. `command`, `code`
 * and `exitCode` come back exactly as they were given — they are VALUES a caller compares and a
 * surface composes, and losing the CLI's own code would take away the string the operator quotes
 * when they report a problem. `sentence` and `action` are TEXT A FRAME WILL CARRY, so they are made
 * paintable: `parseCliOutcome` keeps `error.code` verbatim on purpose (`cli-bridge.ts:143`), which
 * means a code can carry an escape sequence, and this module composes new prose out of one. The code
 * is therefore filtered once, where it enters the prose, and the echoed `code` field is left alone.
 *
 * This module dictates no layout. It writes no `(exit N)` of its own and names no surface, so the
 * activity line, the checklist and anything added later compose the code and the class as they
 * already do and add these words beside them.
 *
 * ── Keyed on all three, and total under all three ───────────────────────────────────────────
 *
 * Keyed on CODE AND CLASS because one code can mean two different things: `INVALID_CONTACT_CARD` is
 * returned at exit 2 for a file that would not parse (`commands/cli.ts:308,312`) and at exit 3 for a
 * card that parsed and failed validation, expiry included (`:408`) — one code, two different things
 * to do about it. Refined by COMMAND where the command genuinely changes the answer, which today is
 * `contact export`'s exit 5: it writes with `flag: "wx"`, so a path that already exists is a
 * persistence failure that has nothing to do with the disk.
 *
 * Totality has two halves and both are here. A code with no entry still gets an explanation that
 * names it and describes the class it arrived at — "say the code and the class rather than nothing"
 * — and an exit code outside the four classes is not explained as one of them, because
 * `parseCliOutcome` passes through whatever the child exited with, 0, 1 and 127 included.
 *
 * ── What it deliberately does not do ────────────────────────────────────────────────────────
 *
 * It never guesses a cause the console cannot know. `INVALID_CONFIGURATION` is one code for six
 * causes and the sentence says exactly that rather than ranking them; `PERSISTENCE_FAILURE` on an
 * export names a cause and not the cause, because a real storage failure returns the same code. It
 * reads no clock, opens no store, spawns nothing and holds no state: two calls with the same three
 * arguments return the same five fields.
 *
 * Every sentence is written to fit beside the code on one activity row at an ordinary terminal
 * width. At `MIN_VIEWPORT` (72×16) that row is clipped and the words are the part that goes, which
 * is the right way round: the code and the number survive at every size the console supports.
 */

export interface FailureText {
  /** Exactly the command it was given. */
  readonly command: CliCommand;
  /** Exactly the code it was given — the CLI's own, never rewritten and never lost. */
  readonly code: string;
  /** Exactly the exit code it was given — never another class, and never one it invented. */
  readonly exitCode: number;
  /** What happened, in words. */
  readonly sentence: string;
  /** What to do about it, in words. */
  readonly action: string;
}

/** The four failure classes documented in specification.md §CLI surface (`cli-bridge.ts:58-61`). */
const CLASSES = [2, 3, 4, 5] as const;
type FailureClass = (typeof CLASSES)[number];

const isClass = (exitCode: number): exitCode is FailureClass =>
  CLASSES.some((candidate) => candidate === exitCode);

/**
 * One explanation, before the code is substituted in.
 *
 * `{code}` is the one placeholder, and it appears in the sentence rather than being appended: the
 * words have to name the code so that this text is complete wherever it is shown, including on a
 * surface that does not print the code separately.
 */
interface Words {
  readonly sentence: string;
  readonly action: string;
}

const fill = (template: string, code: string): string => template.split("{code}").join(code);

/**
 * Every code the CLI can EXIT with, keyed `${code}@${exitCode}`.
 *
 * Enumerated from `classify` (`commands/cli.ts:465-477`) and the five branches it has — a
 * `CliFailure` passthrough, `PersistenceError`, `ConfigurationError`, `RelayError`, and
 * `OutboundError`/`InboundError`/`ProfileError` — rather than from prose.
 *
 * Two families are deliberately absent, and each absence is a fact about the CLI rather than an
 * omission here:
 *
 * - `INVALID_RELAY_RESPONSE` (`transport/relayClient.ts:38`) never reaches a caller under its own
 *   name. `classify` reads `error.remoteCode`, not `error.code`, and this is a LOCAL verdict with no
 *   remote code, so `cli.ts:472` flattens it to `PROTOCOL_REJECTED`. An entry for it would explain a
 *   string the CLI cannot return.
 * - `INVALID_ENVELOPE` and the other per-envelope verdicts are isolated into `poll`'s `rejected`
 *   array (`runtime/inbound.ts:242`) instead of being raised, so they are painted by the rejection
 *   list and are not an exit class at all.
 */
const ENTRIES: Readonly<Record<string, Words>> = {
  // ── 2 — input and configuration: the command was wrong, not the world ─────────────────────
  "INVALID_ARGUMENTS@2": {
    sentence: "{code} — the console built this command wrongly. Nothing was read or written.",
    action: "Report it — no keystroke here should be able to produce it.",
  },
  "INVALID_CONFIGURATION@2": {
    sentence: "{code} — one code for six causes; the console cannot say which.",
    action: "Check steps 0 and 1 on the profiles pane; the rest are on disk.",
  },
  "INVALID_CONTACT_CARD@2": {
    sentence: "{code} — that file is not a contact card the CLI can read, or it is too big.",
    action: "Check the path, and that the file is the card they sent.",
  },
  "INVALID_MESSAGE_ID@2": {
    sentence: "{code} — the message id used here is not a UUID.",
    action: "Report it: the console names no id of its own, so the CLI minted this one.",
  },
  "INVALID_MESSAGE@2": {
    sentence: "{code} — the body is longer than the CLI accepts; nothing was encrypted.",
    action: "Shorten it; the compose row counts bytes once you are past half.",
  },

  // ── 3 — trust and protocol: never flattened, because the CLI took trouble not to ──────────
  "TRUST_REJECTED@3": {
    sentence: "{code} — refused on trust grounds; no pin and no session changed.",
    action: "Check the contact is pinned and the card you imported is the one they sent.",
  },
  "CONTACT_NOT_CONFIRMED@3": {
    sentence: "{code} — the import was answered with no, so nothing was pinned.",
    action: "Press i again and answer y once all four identifiers match.",
  },
  "INVALID_CONTACT_CARD@3": {
    sentence: "{code} — the card read cleanly but failed validation; it may have expired.",
    action: "Ask them to run contact export again and send you the new card.",
  },
  "PROTOCOL_REJECTED@3": {
    sentence: "{code} — the relay refused this, and will refuse the same request again.",
    action: "Check both sides run the same build against the same relay.",
  },
  "PREKEY_BUNDLE_UNAVAILABLE@3": {
    sentence: "{code} — their side has no claimable prekey bundle. Not a trust failure.",
    action: "Ask them to run relay publish, then try again.",
  },
  "UNAUTHORIZED_MAILBOX_ACCESS@3": {
    sentence: "{code} — the relay would not accept this profile as the sender.",
    action: "Run step 2 (r) to publish this profile, then try again.",
  },
  "SENDER_QUOTA_EXCEEDED@3": {
    sentence: "{code} — your unacked allowance in their mailbox is full. Temporary.",
    action: "It clears when they poll, or when the envelopes expire.",
  },
  "CONTACT_NOT_TRUSTED@3": {
    sentence: "{code} — that correspondent is not pinned in this profile.",
    action: "Import their card first: profiles pane, i.",
  },
  "CONTACT_PIN_MISMATCH@3": {
    sentence: "{code} — the bundle the relay served is not the one you pinned. Stop.",
    action: "Do not re-import a card sent the same way; check out of band.",
  },
  "PREKEY_BUNDLE_EXPIRED@3": {
    sentence: "{code} — the bundle pinned for them has expired.",
    action: "Ask them to run relay publish, then try again.",
  },
  "MESSAGE_ID_CONFLICT@3": {
    sentence: "{code} — that message id was already used for different text.",
    action: "Send again; each send takes a fresh id from the CLI.",
  },
  "OUTBOUND_REJECTED@3": {
    sentence: "{code} — the relay refused the envelope; nothing was delivered.",
    action: "Check they are still published, then send again.",
  },
  "SENDER_NOT_PUBLISHED@3": {
    sentence: "{code} — this profile has never published, so this was refused locally.",
    action: "Run step 2 (r) to publish, then send again.",
  },
  "INBOUND_REJECTED@3": {
    sentence: "{code} — the relay refused this profile's authentication; the poll stopped.",
    action: "Check this profile is published to that relay, then poll again.",
  },
  "CHALLENGE_EXPIRED@3": {
    sentence: "{code} — the relay's challenge expired before the poll could use it.",
    action: "Poll again; a slow or loaded relay is the usual cause.",
  },
  "PROFILE_REJECTED@3": {
    sentence: "{code} — the relay refused this profile's own record.",
    action: "Re-run steps 1 and 2, and check the relay URL on the profiles pane.",
  },

  // ── 4 — relay and network: the one class where retrying is the answer ─────────────────────
  "RELAY_UNAVAILABLE@4": {
    sentence: "{code} — the relay did not answer, so nothing was committed anywhere.",
    action: "Check it is up at the URL on the profiles pane; retrying is safe.",
  },

  // ── 5 — persistence: the one class where retrying is not ──────────────────────────────────
  "PERSISTENCE_FAILURE@5": {
    sentence: "{code} — the encrypted store could not be read or written.",
    action: "Do not retry blindly: check the profile directory and its store-key variable.",
  },
};

/**
 * The entries a command changes, keyed the same way and looked up first.
 *
 * There is one, and it earns its place by being the failure whose exit class is most misleading:
 * `contact export` writes with `flag: "wx"`, so exporting over a path that already exists is a
 * persistence failure with nothing wrong with the store. It names A cause, not THE cause — exit 5 is
 * also a genuine storage failure and the action says so, because a sentence that claimed certainty
 * here would send an operator looking for a disk problem that is not there, or stop them looking for
 * one that is.
 */
const BY_COMMAND: Readonly<Record<string, Partial<Record<CliCommand, Words>>>> = {
  "PERSISTENCE_FAILURE@5": {
    "contact export": {
      sentence: "{code} — one cause is that the path already exists; export never overwrites.",
      action: "Export to a new path; a real storage failure looks the same.",
    },
  },
};

/**
 * What the console says about a code it has no entry for, at a class it does recognise.
 *
 * This is the half of totality that keeps the function honest rather than merely defined: the CLI
 * can return a code added after this table was written, and the console must then say the code and
 * describe the class rather than say nothing. It describes the class in WORDS and never as a number,
 * so no caller can read a class out of it that the CLI did not return.
 */
const GENERIC: Readonly<Record<FailureClass, Words>> = {
  2: {
    sentence: "{code} — the CLI refused the command as it was built, not the state of the world.",
    action: "Correct the operand this command used and run it again.",
  },
  3: {
    sentence: "{code} — a trust or protocol refusal; no pin, session or trust state changed.",
    action: "Read the code before retrying: repeated unchanged, it will be refused again.",
  },
  4: {
    sentence: "{code} — a relay or network failure; nothing was committed anywhere.",
    action: "Check the relay at the URL on the profiles pane; retrying is safe.",
  },
  5: {
    sentence: "{code} — a persistence failure; the encrypted store could not be read or written.",
    action: "Do not retry blindly — the store may be locked, or opened with a different key.",
  },
};

/**
 * A code that arrived with an exit code outside the four classes.
 *
 * `parseCliOutcome` reports whatever the child exited with, so 0, 1 and 127 all reach here. Naming
 * one of the four classes anyway would be the console inventing the one thing AC5 says it may never
 * invent, so it names neither a class nor a cause.
 */
const UNCLASSED: Words = {
  sentence: "{code} — the CLI exited with a status this console has no class for.",
  action: "Quote the code and the status exactly if you report this.",
};

/**
 * The bridge's own code, which no CLI exit carries.
 *
 * `parseCliOutcome` reports it when the child's stdout was not one readable JSON envelope, at
 * whatever exit code the child did return (`cli-bridge.ts:64,127,143`), so it belongs at every
 * class. The console genuinely knows nothing about what happened, and the sentence says so — which
 * is the honest answer, and is why `parseCliOutcome` never throws.
 */
const UNREADABLE: Words = {
  sentence: "{code} — the CLI printed nothing the console could read, so it knows nothing more.",
  action: "Run the same command in a terminal and read its output there.",
};

/**
 * The words for one cell of the matrix: a command's override, the code's own entry, the class, or —
 * for an exit code that is not a class at all — the statement that the console cannot place it.
 */
function wordsFor(command: CliCommand, code: string, exitCode: number): Words {
  if (code === UNREADABLE_CLI_OUTPUT) return UNREADABLE;
  const key = `${code}@${String(exitCode)}`;
  const override = BY_COMMAND[key]?.[command];
  if (override !== undefined) return override;
  const entry = ENTRIES[key];
  if (entry !== undefined) return entry;
  return isClass(exitCode) ? GENERIC[exitCode] : UNCLASSED;
}

/**
 * One failure, explained. Total, pure and deterministic.
 *
 * The three arguments come back untouched; the two strings are composed from the table above with
 * the code filtered on its way into the prose. A code that steers a terminal therefore loses the
 * bytes that steer it in the words, and keeps every one of them in `code`, where a caller comparing
 * the CLI's own vocabulary still sees exactly what the CLI said.
 */
export function explain(command: CliCommand, code: string, exitCode: number): FailureText {
  const words = wordsFor(command, code, exitCode);
  const shown = paintable(code);
  return {
    command,
    code,
    exitCode,
    sentence: fill(words.sentence, shown),
    action: fill(words.action, shown),
  };
}
