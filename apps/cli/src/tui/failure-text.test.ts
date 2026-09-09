import { describe, expect, it } from "vitest";
import { CLI_COMMANDS, type CliCommand } from "./cli-bridge";
import { explain, type FailureText } from "./failure-text";

/*
 * Flow 004 T23 — AC5: every exit class, named accurately, over the whole matrix.
 *
 * ── What is there today, and why it is not AC5 ───────────────────────────────────────────────
 *
 * The console shows a failure as the CLI's code and a number. On the activity line that is
 * `tui-shell.ts:866`, `${command} → ${code} (exit ${exitCode})`; on the registration checklist it
 * is `profiles-pane.ts:85`, `${outcome.failed} (exit ${exitCode})`. Both are accurate and neither
 * is a message: `PREKEY_BUNDLE_UNAVAILABLE (exit 3)` tells an operator that a trust/protocol
 * failure happened, and every instinct they have about exit 3 is wrong here — nothing is wrong
 * with their profile and nothing was refused about their trust.
 *
 * 004-T12-verify recorded AC5 as not proven anywhere: "the only exit-class assertion in the
 * package is one sampled case, main.processDriven.test.ts:290". 004-T18-verify recorded it as
 * partial: `profiles-pane.setup.test.ts:255-282` now crosses the five registration steps against
 * all four classes — 20 real cases, genuine totality over the CHECKLIST — but "the console's other
 * commands (poll, send, history, contact) are covered by one sampled case", and "'presented with a
 * message that is accurate' is not met at all — the checklist prints the raw code and the exit
 * number".
 *
 * ── The module ──────────────────────────────────────────────────────────────────────────────
 *
 * `.metaproject/flows/003-.../t35-console-client-design.md` §4.1 names it: a new pure module,
 * `failure-text.ts`, exporting one TOTAL function keyed on all three of command, code and exit
 * code — total "because the CLI can return a code this table has never seen ... and the console
 * must then say the code and the class rather than nothing", and keyed on all three because
 * `INVALID_CONTACT_CARD` is returned at exit 2 for a file that would not parse (`cli.ts:308,312`)
 * and at exit 3 for a card that parsed and failed validation (`cli.ts:408`) — one code, two
 * different things to do about it. Design test T-9 states the obligation this file discharges.
 *
 * The contract this file specifies:
 *
 *   export interface FailureText {
 *     readonly command: CliCommand;  // exactly the command it was given
 *     readonly code: string;         // exactly the code it was given — the CLI's own, never lost
 *     readonly exitCode: number;     // exactly the exit code it was given — never another class
 *     readonly sentence: string;     // what happened, in words
 *     readonly action: string;       // what to do about it, in words
 *   }
 *   export function explain(command: CliCommand, code: string, exitCode: number): FailureText;
 *
 * `code` and `exitCode` are echoed as FIELDS rather than baked into the prose because AC5 has two
 * halves and they are different obligations: an operator reporting a problem needs the code and
 * the number to survive verbatim (that is a value, and a value is what a test can pin), and a
 * human sentence beside them is an ADDITION, not a replacement. Echoing them also means this
 * module dictates no layout: the surfaces compose `${code} (exit ${exitCode})` as they already do.
 *
 * The split has a second consequence, and T23-AC5-E's last case is where it bites: `code` is the
 * VALUE, echoed exactly, while `sentence` and `action` are TEXT A FRAME WILL CARRY and are
 * therefore paintable. A code the CLI kept verbatim can hold an escape sequence
 * (004-T18-verify F-001 measured one reaching a frame through exactly this field), so a module
 * that interpolates the code into its prose has to filter on the way in, the way the console's
 * other seven boundaries already do.
 *
 * ── How totality is proven rather than sampled ──────────────────────────────────────────────
 *
 * Three separate things, because "total" and "has a real entry" are not the same claim:
 *
 * 1. THE MATRIX IS ENUMERATED, NOT LISTED. `CLI_COMMANDS` × the four classes is walked in a loop,
 *    the visited cells are collected in a set, and the set's size is asserted to be the product.
 *    A cell that a future edit removes from `CLI_COMMANDS` changes the product; a cell that is
 *    silently skipped changes the count. Nothing here is a hand-written 32-row fixture.
 * 2. NO CELL IS THE DEFAULT. A function that returned one string for everything it did not
 *    recognise would pass a sampled test and fail an operator at the moment they need it. It is
 *    killed by comparing every real code against a SYNTHETIC one at the same class, with each
 *    code's own text blanked out of both: if the two blanked results are equal, the real code went
 *    down the generic path and has no entry of its own.
 * 3. THE FALLBACK IS STILL HONEST. Two different unknown codes must produce two different
 *    explanations, each naming its own code and its own class — which is what makes the function
 *    total without making it useless.
 *
 * Pure. Nothing here spawns a process, opens a store, reads a clock or touches a relay, so this
 * file takes no timeout from `apps/cli/test/childProcessTimeouts.ts` — it has none to take, and no
 * millisecond literal appears in it.
 */

/** The four failure classes, from specification.md §CLI surface and `cli-bridge.ts:58-61`. */
const CLASSES = [2, 3, 4, 5] as const;
type FailureClass = (typeof CLASSES)[number];

/** Every command on the frozen surface, typed, so a ninth would be a type error here too. */
const COMMANDS: readonly CliCommand[] = CLI_COMMANDS;

/**
 * One code the CLI demonstrably returns at each class, used to walk the command × class matrix.
 *
 *   2  INVALID_CONFIGURATION   `config.ts:5` (ConfigurationError.code) via `cli.ts:468`
 *   3  PROTOCOL_REJECTED       `cli.ts:472`, the flattening branch for a non-retryable RelayError
 *   4  RELAY_UNAVAILABLE       `cli.ts:470`, the retryable branch
 *   5  PERSISTENCE_FAILURE     `profile.ts:21` and `cli.ts:22`
 */
const REPRESENTATIVE: Readonly<Record<FailureClass, string>> = {
  2: "INVALID_CONFIGURATION",
  3: "PROTOCOL_REJECTED",
  4: "RELAY_UNAVAILABLE",
  5: "PERSISTENCE_FAILURE",
};

/**
 * Every code that reaches the console AS A COMMAND'S EXIT, enumerated from `classify`
 * (`commands/cli.ts:465-477`) and the error types it reads, not from the design's prose.
 *
 * Enumeration method: `classify` has five branches — `CliFailure` passthrough, `PersistenceError`,
 * `ConfigurationError`, `RelayError`, and `OutboundError`/`InboundError`/`ProfileError` — and each
 * was followed to the literals that can reach it.
 *
 * DELIBERATELY ABSENT, and each absence is a finding rather than an omission:
 *
 * - `INVALID_RELAY_RESPONSE` (`transport/relayClient.ts:38`). The t35 §4.1 table lists it under
 *   class 3, but `classify` reads `error.remoteCode`, not `error.code`, and this code is a LOCAL
 *   verdict with no remote code, so `cli.ts:472` flattens it to `PROTOCOL_REJECTED`. It never
 *   reaches the console under its own name, and an entry for it would explain a string the CLI
 *   cannot return.
 * - `INVALID_ENVELOPE` (`inbound.ts:255,277`) and the other per-envelope verdicts. These are
 *   isolated into `poll`'s `rejected` array rather than raised, so they are painted by the
 *   rejection list (`mailbox-pane.ts:71`) and are not an exit class at all. A different surface.
 */
const REACHABLE: readonly (readonly [string, FailureClass, string])[] = [
  // ── class 2, input/configuration ──────────────────────────────────────────────────────────
  ["INVALID_ARGUMENTS", 2, "commands/cli.ts:20 — the default input failure"],
  ["INVALID_CONFIGURATION", 2, "runtime/config.ts:5 — one code for six causes, via cli.ts:468"],
  ["INVALID_CONTACT_CARD", 2, "commands/cli.ts:308,312 — a card file that would not parse"],
  ["INVALID_MESSAGE_ID", 2, "commands/cli.ts:432 — a --message-id that is not a UUID"],
  ["INVALID_MESSAGE", 2, "runtime/outbound.ts:129 via cli.ts:474 — a body over MAX_PLAINTEXT_BYTES"],
  // ── class 3, trust/protocol ───────────────────────────────────────────────────────────────
  ["TRUST_REJECTED", 3, "commands/cli.ts:21 — the default trust failure"],
  ["CONTACT_NOT_CONFIRMED", 3, "commands/cli.ts:410 — the operator answered the child's prompt with no"],
  ["INVALID_CONTACT_CARD", 3, "commands/cli.ts:408 — a card that parsed and failed validation, expiry included"],
  ["PROTOCOL_REJECTED", 3, "commands/cli.ts:472 — every non-retryable relay refusal but the three below"],
  ["PREKEY_BUNDLE_UNAVAILABLE", 3, "commands/cli.ts:58 — reported under the relay's own name"],
  ["UNAUTHORIZED_MAILBOX_ACCESS", 3, "commands/cli.ts:58 — reported under the relay's own name"],
  ["SENDER_QUOTA_EXCEEDED", 3, "commands/cli.ts:58 — reported under the relay's own name"],
  ["CONTACT_NOT_TRUSTED", 3, "runtime/outbound.ts:138 and runtime/inbound.ts:257"],
  ["CONTACT_PIN_MISMATCH", 3, "runtime/outbound.ts:187,259,272 and runtime/inbound.ts:259,263"],
  ["PREKEY_BUNDLE_EXPIRED", 3, "runtime/outbound.ts:261"],
  ["MESSAGE_ID_CONFLICT", 3, "runtime/outbound.ts:277 and runtime/inbound.ts:270"],
  ["OUTBOUND_REJECTED", 3, "runtime/outbound.ts:55,286"],
  ["SENDER_NOT_PUBLISHED", 3, "runtime/outbound.ts:165 — refused locally, before a peer's prekey is spent"],
  ["INBOUND_REJECTED", 3, "runtime/inbound.ts:84 — the authentication path, which aborts the poll"],
  ["CHALLENGE_EXPIRED", 3, "runtime/inbound.ts:107 — the authentication path, which aborts the poll"],
  ["PROFILE_REJECTED", 3, "runtime/profile.ts:12"],
  // ── class 4, relay/network ────────────────────────────────────────────────────────────────
  ["RELAY_UNAVAILABLE", 4, "commands/cli.ts:470 — the one retryable class"],
  // ── class 5, persistence ──────────────────────────────────────────────────────────────────
  ["PERSISTENCE_FAILURE", 5, "runtime/profile.ts:21 and commands/cli.ts:22"],
];

/**
 * The bridge's own code, which no CLI exit carries: `parseCliOutcome` reports it when the child's
 * stdout was not one readable JSON envelope, at whatever exit code the child did return
 * (`cli-bridge.ts:64,127,143`). It belongs at every class for that reason.
 */
const UNREADABLE = "UNREADABLE_CLI_OUTPUT";

/** Two codes no table can have an entry for. Different from each other, on purpose. */
const UNKNOWN_A = "SYNTHETIC_UNKNOWN_CODE_A9F3";
const UNKNOWN_B = "SYNTHETIC_UNKNOWN_CODE_B7C1";

/**
 * Sentence and action as one string, joined by something that is not a control point: this file
 * also asserts that nothing `explain` returns can steer a terminal, and a joiner that could would
 * make that assertion fail on the joiner rather than on the module.
 */
const both = (text: FailureText): string => `${text.sentence} ${text.action}`;

/** `text` with every occurrence of `code` replaced, so two explanations can be compared shape-first. */
const withoutCode = (text: string, code: string): string => text.split(code).join("<CODE>");

/** `exit N` as a whole number, so `exit 1` does not match inside `exit 127`. */
const namesClass = (text: string, exitCode: number): boolean => new RegExp(`exit ${String(exitCode)}(?![0-9])`).test(text);

/**
 * The predicate `tui-shell.ts:455` uses, restated here rather than imported.
 *
 * `steersTheDisplay` is not exported, and a test that imported the renderer's own filter could not
 * tell "this module emits nothing that steers a display" from "the same filter was applied twice".
 * The code points are written as numbers for the reason `tui-shell.ts:450-453` gives: an invisible
 * literal in a source file is a character no reviewer can see and no diff can show.
 */
function steers(point: string): boolean {
  const code = point.codePointAt(0) ?? 0;
  if (code <= 0x1f || code === 0x7f || (code >= 0x80 && code <= 0x9f)) return true;
  if (code === 0x200e || code === 0x200f) return true;
  if (code >= 0x202a && code <= 0x202e) return true;
  if (code >= 0x2066 && code <= 0x2069) return true;
  return code === 0x2028 || code === 0x2029 || code === 0xfeff;
}

const ESC = String.fromCharCode(27);
/** U+009B, a control sequence introducer with no ESC in front of it. */
const C1_CSI = String.fromCharCode(0x9b);
/** U+202E RIGHT-TO-LEFT OVERRIDE, the Trojan-Source reordering point. */
const RTL_OVERRIDE = String.fromCodePoint(0x202e);

describe("T23-AC5-A: totality over the command × exit-class matrix", () => {
  it("explains every one of the eight commands at every one of the four classes", () => {
    const covered = new Set<string>();

    for (const command of COMMANDS) {
      for (const exitCode of CLASSES) {
        const code = REPRESENTATIVE[exitCode];
        const text = explain(command, code, exitCode);

        expect(text.command, `explain() changed the command for ${command} / ${code}`).toBe(command);
        expect(text.code, `explain() lost or rewrote the CLI's own code for ${command} / ${code}`).toBe(code);
        expect(text.exitCode, `explain() reported a class the CLI did not return for ${command} / ${code}`).toBe(exitCode);

        expect(text.sentence.trim().length, `${command} / ${code} has no sentence`).toBeGreaterThan(0);
        expect(text.action.trim().length, `${command} / ${code} says nothing to do about it`).toBeGreaterThan(0);
        // A sentence that is the code again is exactly the surface the console already has.
        expect(text.sentence.trim(), `${command} / ${code} restated the code instead of explaining it`).not.toBe(code);
        expect(text.action.trim(), `${command} / ${code} restated the code instead of naming an action`).not.toBe(code);

        covered.add(`${command} ${String(exitCode)}`);
      }
    }

    // Enumerated, not listed: the product is computed from the frozen surface itself.
    expect(covered.size, "a cell of the command × exit-class matrix was skipped").toBe(COMMANDS.length * CLASSES.length);
    expect(COMMANDS.length, "the frozen CLI surface is no longer eight commands").toBe(8);
    expect(covered.size).toBe(32);
  });

  it("never names a class the CLI did not return", () => {
    // The second half of AC5's sentence, over the same matrix. An explanation that mentioned a
    // second exit number would let an operator report the wrong class out of the right failure.
    for (const command of COMMANDS) {
      for (const exitCode of CLASSES) {
        const text = both(explain(command, REPRESENTATIVE[exitCode], exitCode));
        for (const other of CLASSES) {
          if (other === exitCode) continue;
          expect(
            namesClass(text, other),
            `${command} at exit ${String(exitCode)} named exit ${String(other)} as well`,
          ).toBe(false);
          expect(
            text.includes(REPRESENTATIVE[other]),
            `${command} at exit ${String(exitCode)} named ${REPRESENTATIVE[other]}, a code the CLI did not return`,
          ).toBe(false);
        }
      }
    }
  });

  it("explains the bridge's own code at every class, since a child can be unreadable at any exit", () => {
    // `UNREADABLE_CLI_OUTPUT` is not a CLI exit class; it is what the console reports when the
    // child's stdout was not one JSON envelope, carrying whatever exit code the child did return.
    // t35 §4.1: it "names the command and the exit code it did return, and says the console is
    // showing nothing about it — which is honest".
    for (const command of COMMANDS) {
      for (const exitCode of CLASSES) {
        const text = explain(command, UNREADABLE, exitCode);
        expect(text.code).toBe(UNREADABLE);
        expect(text.exitCode).toBe(exitCode);
        expect(both(text), `the unreadable-output explanation for ${command} does not name the code`).toContain(UNREADABLE);
      }
    }
  });
});

describe("T23-AC5-B: every reachable code has an entry of its own, not the default", () => {
  it("keeps the CLI's own code verbatim for every code the CLI can exit with", () => {
    for (const [code, exitCode, provenance] of REACHABLE) {
      for (const command of COMMANDS) {
        const text = explain(command, code, exitCode);
        expect(text.code, `${code} (${provenance}) was rewritten`).toBe(code);
        expect(both(text), `${code} (${provenance}) does not appear in the words the operator reads`).toContain(code);
      }
    }
  });

  it("does not answer a known code with the text it answers an unknown one with", () => {
    /*
     * The kill for a function that returns a default string for anything it does not recognise.
     *
     * Comparing the two results directly would prove nothing: an honest fallback interpolates the
     * code, so two codes give two strings either way. Blanking each code out of its own result
     * removes exactly that difference, and what is left is the SHAPE. If a real code's shape is the
     * shape the synthetic code gets, the real code has no entry and went down the generic path.
     *
     * Over every command, not a sampled one: the design's table is keyed on code and class, with
     * the command refining a handful of entries, so a lookup that only fires for some commands is
     * itself the defect.
     */
    const missing: string[] = [];

    for (const [code, exitCode] of REACHABLE) {
      for (const command of COMMANDS) {
        const real = withoutCode(both(explain(command, code, exitCode)), code);
        const generic = withoutCode(both(explain(command, UNKNOWN_A, exitCode)), UNKNOWN_A);
        if (real === generic) missing.push(`${command} / ${code} (exit ${String(exitCode)})`);
      }
    }

    expect(missing, "these cells are answered by the default rather than by an entry of their own").toEqual([]);
  });

  it("still answers a code no table has seen, and answers two of them differently", () => {
    // The other half of totality: the fallback exists, names the code and the class it was given,
    // and is not one fixed string. t35 §4.1: the console "must then say the code and the class
    // rather than nothing".
    for (const exitCode of CLASSES) {
      const first = explain("poll", UNKNOWN_A, exitCode);
      const second = explain("poll", UNKNOWN_B, exitCode);

      expect(first.code).toBe(UNKNOWN_A);
      expect(second.code).toBe(UNKNOWN_B);
      expect(first.exitCode).toBe(exitCode);
      expect(both(first)).toContain(UNKNOWN_A);
      expect(both(second)).toContain(UNKNOWN_B);
      expect(both(first), "two different unknown codes were answered with the same string").not.toBe(both(second));
    }
  });
});

describe("T23-AC5-C: the explanation is accurate for the COMMAND that produced it", () => {
  it("names the one cause of exit 5 on contact export that is not a disk problem", () => {
    // `contact export` writes with `flag: "wx"`, so exporting over a path that already exists is
    // PERSISTENCE_FAILURE at exit 5 — measured on the live system (T34) and already carried by the
    // checklist's own `stepHint` (profiles-pane.ts:96-100). It must never claim certainty: exit 5
    // is also a real storage failure, which is why the sentence names A cause and not THE cause.
    const exportFailure = both(explain("contact export", "PERSISTENCE_FAILURE", 5));
    const pollFailure = both(explain("poll", "PERSISTENCE_FAILURE", 5));

    expect(exportFailure.toLowerCase(), "export's exit 5 does not name the file that already exists").toContain("already exists");
    expect(pollFailure.toLowerCase(), "a poll cannot fail because a file already exists").not.toContain("already exists");
    expect(exportFailure, "the same code at the same class read identically for two commands").not.toBe(pollFailure);
  });

  it("points a send that was never published at the step that publishes it", () => {
    // t35 §4.1: "this profile has never published; run step 2 (`r`), then send again." Both codes
    // mean it — `SENDER_NOT_PUBLISHED` is the local refusal (outbound.ts:165) and
    // `UNAUTHORIZED_MAILBOX_ACCESS` is the relay's (cli.ts:41-47).
    for (const code of ["SENDER_NOT_PUBLISHED", "UNAUTHORIZED_MAILBOX_ACCESS"]) {
      const text = both(explain("send", code, 3)).toLowerCase();
      expect(text, `${code} on a send does not name publishing as the fix`).toContain("publish");
    }
  });

  it("says a missing prekey bundle is the other side's, and not a trust failure", () => {
    // t35 §4.1, the sentence the design says an operator needs most: "**their** side has no
    // claimable prekey bundle ... This is not a trust failure and nothing is wrong with your
    // profile. The exit code is 3, and every instinct an operator has about exit 3 is wrong here."
    const text = explain("send", "PREKEY_BUNDLE_UNAVAILABLE", 3);
    const words = both(text).toLowerCase();

    expect(text.exitCode, "the class is still the one the CLI returned").toBe(3);
    expect(words, "the explanation does not say this is not a trust failure").toContain("not a trust failure");
    expect(words, "the explanation does not point at the peer's own publication").toContain("publish");
    expect(
      both(text),
      "PREKEY_BUNDLE_UNAVAILABLE reads the same as the generic exit-3 refusal, which is what the CLI went to trouble not to flatten",
    ).not.toBe(both(explain("send", "PROTOCOL_REJECTED", 3)));
  });

  it("does not read identically for two commands that mean different things by one code", () => {
    // The relation, rather than one more fixture: the command argument must be load-bearing
    // somewhere. A module that ignored it would pass every case above but this one and the export.
    const differing = COMMANDS.filter((command) =>
      both(explain(command, "PERSISTENCE_FAILURE", 5)) !== both(explain("poll", "PERSISTENCE_FAILURE", 5)));
    expect(
      differing.length,
      "explain() gave every command the same words for the same code, so its command argument does nothing",
    ).toBeGreaterThan(0);
  });
});

describe("T23-AC5-D: one code, two classes, two different things to do", () => {
  it("separates INVALID_CONTACT_CARD at exit 2 from INVALID_CONTACT_CARD at exit 3", () => {
    // `cli.ts:308,312` — a file that would not parse, or one over a megabyte. `cli.ts:408` — a
    // card that parsed and failed validation, expiry included. `state.ts:49-51` records why the
    // console keeps both halves: "flattening either half would make the console report a class the
    // CLI did not return."
    const parse = explain("contact import", "INVALID_CONTACT_CARD", 2);
    const validate = explain("contact import", "INVALID_CONTACT_CARD", 3);

    expect(parse.exitCode).toBe(2);
    expect(validate.exitCode).toBe(3);
    expect(both(parse), "one code at two classes was explained the same way twice").not.toBe(both(validate));
  });
});

describe("T23-AC5-E: total, deterministic, and safe to paint", () => {
  const HOSTILE: readonly string[] = [
    "",
    "a".repeat(10_000),
    `X${ESC}[2JY`,
    `X${C1_CSI}2JY`,
    "line\nbreak",
    "\u{1F600}\u{1F600}",
    `${RTL_OVERRIDE}reversed`,
    "\uD800",
    "   ",
  ];

  it("returns something for any code at all, at any command and any class", () => {
    for (const command of COMMANDS) {
      for (const exitCode of CLASSES) {
        for (const code of HOSTILE) {
          expect(() => explain(command, code, exitCode), `explain() threw for ${JSON.stringify(code)}`).not.toThrow();
        }
      }
    }
  });

  it("survives an exit code outside the four classes without inventing one", () => {
    // `parseCliOutcome` passes through whatever the child exited with, including 0, 1 and 127.
    for (const exitCode of [0, 1, 6, 127, -1, Number.NaN]) {
      const text = explain("doctor", "PERSISTENCE_FAILURE", exitCode);
      expect(() => both(text)).not.toThrow();
      for (const claimed of CLASSES) {
        expect(
          namesClass(both(text), claimed),
          `an exit code of ${String(exitCode)} was explained as exit ${String(claimed)}`,
        ).toBe(false);
      }
    }
  });

  it("returns the same words for the same three arguments", () => {
    for (const [code, exitCode] of REACHABLE) {
      expect(explain("send", code, exitCode)).toEqual(explain("send", code, exitCode));
    }
  });

  it("emits nothing that can steer a terminal, even when the code it is handed does", () => {
    /*
     * The boundary rule this repository already follows in seven places (tui-shell.ts:617,
     * 642-645, 713, 744-745, 836, 907): a value that becomes text the operator reads is made
     * paintable where it becomes state. `explain` composes NEW text out of a code that
     * `parseCliOutcome` keeps verbatim (`cli-bridge.ts:143`), so it is an eighth such place — and
     * 004-T18-verify F-001 is the measured record of what happens when a new consumer of that
     * verbatim code is added without one.
     */
    for (const code of [`X${ESC}[2JY`, `X${C1_CSI}2JY`, `${RTL_OVERRIDE}reversed`, "ordinary"]) {
      const text = both(explain("contact import", code, 3));
      const offending = [...text]
        .filter((point) => steers(point))
        .map((point) => `U+${(point.codePointAt(0) ?? 0).toString(16).toUpperCase()}`);
      expect(offending, "explain() let a display-steering code point through into text a frame will carry").toEqual([]);
    }
  });
});
