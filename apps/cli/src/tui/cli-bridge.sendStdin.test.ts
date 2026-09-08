import { describe, expect, it } from "vitest";
import { buildArgv } from "./cli-bridge";

// Flow 004, T5 — the first of two RED specs this dispatch asks for: `send` must stop putting the
// message body on the child's argv, because on Unix argv is readable by every process the same user
// owns for the life of the child (`ps`), and a messenger whose whole point is end-to-end encryption
// must not hand the plaintext to the local process table.
//
// `apps/cli/src/tui/cli-bridge.ts:88-93` is named directly by the dispatch as today's wall 2:
//   return ["send", "--to", request.to, "--text", request.text, ...];
//
// `cli-bridge.test.ts` (untouched — see this dispatch's constraints) already pins the CURRENT shape
// with two tests that construct a `send` CliRequest and assert `buildArgv` puts `--text` and the
// body in argv verbatim:
//   - "send, with and without an explicit message id" (asserts `["send", "--to", PEER, "--text",
//     "SYNTHETIC_TUI_BODY", ...]`)
//   - "passes an identity id beginning with '-' through verbatim as its own element"
//   - "always addresses a profile and always asks for JSON" (its `requests` fixture includes a
//     `text` field for the `send` case)
// That file is left exactly as it is: this dispatch is tests-only and the wall-2 fix is the
// implementer's job, under review. This file pins the REPLACEMENT contract, and the two files are
// deliberately in tension until that fix lands — `buildArgv`'s `send` case cannot satisfy both at
// once, which is the point: once it does satisfy this file, `cli-bridge.test.ts`'s three tests above
// must be updated by the implementer, not by this dispatch.
describe("buildArgv keeps the message body out of the child's argv entirely (send)", () => {
  const PROFILE = "/tmp/echolet-tui-profile";
  const PEER = "hbRYeNqVnWC74METcY57eDEkV9qNQ6Qzuz6RpsIYQA";
  const MESSAGE_ID = "0dea9038-1f2b-4c3d-8e5f-6a7b8c9d0e1f";

  it("emits no --text token and no token containing the body, for an ordinary body", () => {
    const BODY = "SYNTHETIC_STDIN_BODY_MUST_NOT_REACH_ARGV";
    const argv = buildArgv({ command: "send", profileDir: PROFILE, to: PEER, text: BODY, messageId: MESSAGE_ID });
    expect(argv, `argv was ${JSON.stringify(argv)}`).not.toContain("--text");
    expect(argv.some((token) => token.includes(BODY)), `argv was ${JSON.stringify(argv)}`).toBe(false);
  });

  it("emits no --text token and no token containing the body, for a body that looks like a flag", () => {
    // The exact case flagged by the design (t35-console-client-design.md T-1): a body an unwary
    // implementation might swallow as an option value, or collide with, an option of its own.
    const BODY = "--json";
    const argv = buildArgv({ command: "send", profileDir: PROFILE, to: PEER, text: BODY, messageId: MESSAGE_ID });
    expect(argv, `argv was ${JSON.stringify(argv)}`).not.toContain("--text");
    // Today the literal body "--json" is pushed as its own argv element AND the command's own
    // trailing --json flag is pushed too, so "--json" appears twice — the exact collision a body
    // that looks like a flag must never cause once the body is off argv.
    expect(argv.filter((token) => token === "--json"), `argv was ${JSON.stringify(argv)}`).toHaveLength(1);
  });

  it("emits no --text token, and no token containing either line, for a multi-line body", () => {
    const BODY = "SYNTHETIC_LINE_ONE\nSYNTHETIC_LINE_TWO";
    const argv = buildArgv({ command: "send", profileDir: PROFILE, to: PEER, text: BODY, messageId: MESSAGE_ID });
    expect(argv, `argv was ${JSON.stringify(argv)}`).not.toContain("--text");
    expect(
      argv.some((token) => token.includes(BODY) || token.includes("SYNTHETIC_LINE_ONE") || token.includes("SYNTHETIC_LINE_TWO")),
      `argv was ${JSON.stringify(argv)}`,
    ).toBe(false);
  });

  it("still addresses the right recipient, message id, profile and --json once the body is gone from argv", () => {
    // Pinned so the fix cannot satisfy the three tests above by simply deleting fields rather than
    // moving the body off argv: the rest of the invocation must be unchanged.
    const argv = buildArgv({ command: "send", profileDir: PROFILE, to: PEER, text: "SYNTHETIC_BODY_UNCHECKED_HERE", messageId: MESSAGE_ID });
    expect(argv).toContain("--to");
    expect(argv).toContain(PEER);
    expect(argv).toContain("--message-id");
    expect(argv).toContain(MESSAGE_ID);
    expect(argv).toContain("--profile");
    expect(argv).toContain(PROFILE);
    expect(argv.at(-1)).toBe("--json");
  });
});
