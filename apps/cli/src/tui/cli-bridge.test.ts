import { describe, expect, it } from "vitest";
import { CLI_COMMANDS, buildArgv, parseCliOutcome, type CliRequest } from "./cli-bridge";

// Flow 002 T9 — the operator TUI drives the LOCAL CLI, and this module is the only place that
// decides what it says to it. Two contracts are pinned here.
//
// 1. The eight-command surface is frozen. specification.md §CLI surface: "The surface is
//    deliberately frozen: no ninth command was added during remediation, which is why bundle
//    rotation and pending-send retry have no entry point." An operator console is exactly where a
//    ninth command would creep in — `rotateBundle()` and `retryPending()` already exist in the
//    runtime and are deliberately unreachable — so the refusal is a test, not a convention.
//
// 2. An argv never carries key material. The 32-byte store key travels in the inherited
//    environment named by `--store-key-env`, exactly as the runbook passes it. `buildArgv` is
//    given the variable NAME. The exhaustive version of this assertion lives in
//    `tui.keyMaterial.test.ts`; what is pinned here is the argv SHAPE that makes it possible.

const PROFILE = "/tmp/echolet-tui-profile";
const RELAY = "http://127.0.0.1:18099";
const KEY_ENV = "ECHOLET_E2E_KEY";
const CARD = "/tmp/echolet-tui-profile/peer-card.json";
const PEER = "hbRYeNqVnWC74METcY57eDEkV9qNQ6Qzuz6RpsIYQA";
const MESSAGE_ID = "0dea9038-1f2b-4c3d-8e5f-6a7b8c9d0e1f";

describe("the CLI surface the TUI may drive stays the frozen eight", () => {
  it("declares exactly the eight commands the specification freezes, in its order", () => {
    expect([...CLI_COMMANDS]).toEqual([
      "init",
      "contact export",
      "contact import",
      "relay publish",
      "send",
      "poll",
      "history",
      "doctor",
    ]);
  });

  it("refuses a command outside the frozen surface rather than inventing a ninth", () => {
    // `rotateBundle` and `retryPending` are real runtime capabilities with no CLI entry point.
    // The TUI is not allowed to become their entry point by accident.
    for (const command of ["contact list", "relay rotate", "retry", "send-all"]) {
      const request = { command, profileDir: PROFILE } as unknown as CliRequest;
      // The refusal must NAME the command it refused. Asserting a bare throw would be satisfied by
      // any incidental error — including the RED-phase scaffold — and would prove nothing.
      expect(() => buildArgv(request)).toThrow(new RegExp(command));
    }
  });
});

describe("buildArgv writes the documented invocation for every command", () => {
  it("init", () => {
    expect(buildArgv({ command: "init", profileDir: PROFILE, relayUrl: RELAY, storeKeyEnv: KEY_ENV })).toEqual([
      "init", "--relay-url", RELAY, "--store-key-env", KEY_ENV, "--profile", PROFILE, "--json",
    ]);
  });

  it("contact export", () => {
    expect(buildArgv({ command: "contact export", profileDir: PROFILE, out: CARD })).toEqual([
      "contact", "export", "--out", CARD, "--profile", PROFILE, "--json",
    ]);
  });

  it("contact import, deliberately WITHOUT --yes", () => {
    // `--yes` skips the CLI's own `Trust these contact identifiers? [y/N]` prompt. The TUI must not
    // use it: the modal shows the four identifiers and the operator answers the child's real
    // prompt afterwards, so the CLI's guard and the TUI's guard both hold. Passing `--yes` would
    // leave the trust decision resting on the TUI alone.
    const argv = buildArgv({ command: "contact import", profileDir: PROFILE, from: CARD });
    expect(argv).toEqual(["contact", "import", "--from", CARD, "--profile", PROFILE, "--json"]);
    expect(argv).not.toContain("--yes");
  });

  it("relay publish", () => {
    expect(buildArgv({ command: "relay publish", profileDir: PROFILE })).toEqual([
      "relay", "publish", "--profile", PROFILE, "--json",
    ]);
  });

  // Flow 004: the body left argv. This case used to assert `--text` and the body were HERE, which
  // was true and is now the defect: argv is readable through `ps` by every process the same user
  // owns, so the plaintext of an end-to-end encrypted message was on display for the life of the
  // command. The body now rides the child's stdin (see main.ts) and the expectations below say so.
  // The CLI still ACCEPTS `--text` for the operator's own scripts; this caller simply never uses it.
  // Edited by the orchestrator, not by the implementer, who correctly refused to touch a test in
  // order to make its own work pass and reported the contradiction instead.
  it("send, with and without an explicit message id", () => {
    expect(buildArgv({ command: "send", profileDir: PROFILE, to: PEER, text: "SYNTHETIC_TUI_BODY" })).toEqual([
      "send", "--to", PEER, "--profile", PROFILE, "--json",
    ]);
    // The runbook's ambiguous-send / exact-retry step: the same --message-id replays identical bytes.
    expect(buildArgv({ command: "send", profileDir: PROFILE, to: PEER, text: "SYNTHETIC_TUI_BODY", messageId: MESSAGE_ID })).toEqual([
      "send", "--to", PEER, "--message-id", MESSAGE_ID, "--profile", PROFILE, "--json",
    ]);
  });

  it("poll, history and doctor", () => {
    expect(buildArgv({ command: "poll", profileDir: PROFILE })).toEqual(["poll", "--profile", PROFILE, "--json"]);
    expect(buildArgv({ command: "history", profileDir: PROFILE, contactIdentityId: PEER })).toEqual([
      "history", "--with", PEER, "--profile", PROFILE, "--json",
    ]);
    expect(buildArgv({ command: "doctor", profileDir: PROFILE })).toEqual(["doctor", "--profile", PROFILE, "--json"]);
  });

  it("passes an identity id beginning with '-' through verbatim as its own element", () => {
    // `identity_id` is base64url, so about one identity in sixty-four begins with '-'. The CLI
    // fixed this class in F-013 by rewriting `--opt value` into `--opt=value` itself; the TUI must
    // therefore hand the value through unchanged and must not pre-mangle or quote it.
    const dashed = "-DashRecipientIdentity000000000000000000000A";
    const argv = buildArgv({ command: "send", profileDir: PROFILE, to: dashed, text: "SYNTHETIC_TUI_BODY" });
    expect(argv).toContain(dashed);
    expect(argv.filter((token) => token.includes(dashed))).toEqual([dashed]);
  });

  it("always addresses a profile and always asks for JSON", () => {
    const requests: CliRequest[] = [
      { command: "init", profileDir: PROFILE, relayUrl: RELAY, storeKeyEnv: KEY_ENV },
      { command: "contact export", profileDir: PROFILE, out: CARD },
      { command: "contact import", profileDir: PROFILE, from: CARD },
      { command: "relay publish", profileDir: PROFILE },
      { command: "send", profileDir: PROFILE, to: PEER, text: "SYNTHETIC_TUI_BODY" },
      { command: "poll", profileDir: PROFILE },
      { command: "history", profileDir: PROFILE, contactIdentityId: PEER },
      { command: "doctor", profileDir: PROFILE },
    ];
    for (const request of requests) {
      const argv = buildArgv(request);
      expect(argv).toContain("--profile");
      expect(argv).toContain(PROFILE);
      expect(argv.at(-1)).toBe("--json");
    }
  });
});

describe("parseCliOutcome reads one JSON result and keeps the typed codes apart", () => {
  it("reports success", () => {
    const outcome = parseCliOutcome(`${JSON.stringify({ ok: true, data: { received: 1, more: false, rejected: [] } })}\n`, 0);
    expect(outcome).toMatchObject({ ok: true, code: "ok", exitCode: 0 });
    expect(outcome.data).toEqual({ received: 1, more: false, rejected: [] });
  });

  it("reports the CLI's typed failure code and exit code", () => {
    const outcome = parseCliOutcome(`${JSON.stringify({ ok: false, error: { code: "CONTACT_NOT_TRUSTED" } })}\n`, 3);
    expect(outcome).toMatchObject({ ok: false, code: "CONTACT_NOT_TRUSTED", exitCode: 3 });
  });

  it("keeps the three relay refusals under the relay's own name", () => {
    // specification.md §CLI surface: none of the three is a trust violation, and flattening them
    // into PROTOCOL_REJECTED "names nothing the operator can act on". A console that re-flattens
    // them on screen would undo that at the last step.
    for (const code of ["PREKEY_BUNDLE_UNAVAILABLE", "UNAUTHORIZED_MAILBOX_ACCESS", "SENDER_QUOTA_EXCEEDED"]) {
      expect(parseCliOutcome(`${JSON.stringify({ ok: false, error: { code } })}\n`, 3).code).toBe(code);
    }
  });

  it("never throws on output it cannot parse", () => {
    // A console that crashes on a malformed line is worse than one that reports it: the operator
    // loses the whole session's state along with the message.
    for (const [stdout, exitCode] of [["", 5], ["not json\n", 4], ["{\n", 2], ["null\n", 0]] as const) {
      const outcome = parseCliOutcome(stdout, exitCode);
      expect(outcome.ok).toBe(false);
      expect(typeof outcome.code).toBe("string");
      expect(outcome.code.length).toBeGreaterThan(0);
      expect(outcome.exitCode).toBe(exitCode);
    }
  });
});
