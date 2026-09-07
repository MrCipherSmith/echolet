import { describe, expect, it } from "vitest";
import type { CliOutcome } from "./cli-bridge";
import { UNAUDITED_NOTICE } from "./shell-chrome";
import type { OperatorState } from "./state";
import { runTuiShell, type TuiIo } from "./tui-shell";

// Flow 003 T5 — D-4: below the minimum viewport the shell must not write over-wide lines.
//
// MEASURED (flow 003 T2 §4, through the real `runTuiShell` with an injected 40x10 stdout): the
// shell writes 16 lines of 72 columns into a 40-column window, because `runTuiShell.viewport()`
// clamps UP to `MIN_VIEWPORT` instead of rendering a frame that fits. The terminal then wraps every
// line to two rows — about 32 visual rows in a 10-row window — and `UNAUDITED_NOTICE`, which sits
// on row 0, scrolls out of view. That notice is AC6 of flow 002: "the console displays, on its own
// surface, that this is an unaudited prototype not suitable for sensitive communication." A small
// terminal must not defeat an acceptance criterion.
//
// `shell-chrome.ts:30` already documents the behaviour that was never implemented — "below this the
// frame is not defined; the shell shows the notice and a resize hint instead".
//
// `renderFrame` itself is already total at any viewport, so this is a defect of the shell's clamp,
// and it is pinned where it lives: at the seam that actually writes to the terminal. The large
// viewport is asserted in the same test so that "always paint the minimum" cannot pass for a fix.

const ESC = String.fromCharCode(27);
const ANSI = new RegExp(`${ESC}\\[[0-9;?]*[A-Za-z]`, "g");

function state(): OperatorState {
  return {
    profiles: [{
      label: "alice",
      profileDir: "/tmp/echolet-demo/alice",
      relayUrl: "http://127.0.0.1:18099",
      storeKeyEnv: "ECHOLET_E2E_KEY",
      identityId: "hbRYeNqVnWC74METcY57eDEkV9qNQ6Qzuz6RpsIYQA",
      deviceId: "733d80b0-e7e2-5e6c-ba84-0bcd96a373ea",
      contactCount: 0,
      published: false,
    }],
    activeProfile: 0,
    contacts: [],
    selectedContactId: null,
    mailbox: { outboxPending: 0, inboxReceived: 0, more: false, lastPolledAtMs: null },
    rejections: [],
    history: [],
    health: { relayUrl: "http://127.0.0.1:18099", status: "unknown", uptimeMs: null, checkedAtMs: null },
    pane: "profiles",
    modal: undefined,
    activity: [],
    busy: false,
  };
}

/**
 * Drives the real shell with an injected stdout of the given size and returns every frame it wrote.
 *
 * No timer and no clock: the first paint happens synchronously while the shell installs its
 * listener, and `q` settles the promise.
 */
async function framesAt(cols: number, rows: number): Promise<string[][]> {
  const writes: string[] = [];
  let emit: ((chunk: Buffer) => void) | undefined;
  const io: TuiIo = {
    stdout: { write: (chunk: string) => { writes.push(chunk); return true; }, columns: cols, rows },
    stdin: {
      on: (event: string, handler: (chunk: Buffer) => void) => { if (event === "data") emit = handler; return undefined; },
      resume: () => undefined,
      pause: () => undefined,
    },
    now: () => 1_757_000_000_000,
    runCli: () => Promise.resolve<CliOutcome>({ ok: true, code: "ok", exitCode: 0, data: null }),
    answerTrustPrompt: () => undefined,
  };

  const finished = runTuiShell(io, state());
  emit?.(Buffer.from("q", "utf8"));
  await finished;

  return writes
    .map((chunk) => chunk.replace(ANSI, ""))
    .filter((chunk) => chunk.length > 0)
    .map((chunk) => chunk.split("\r\n"));
}

describe("D-4: the shell paints the terminal it was given, at that terminal's size", () => {
  it("writes no line wider than a 40x10 terminal, and keeps the unaudited notice on the frame", async () => {
    const small = await framesAt(40, 10);
    expect(small.length).toBeGreaterThan(0);
    for (const lines of small) {
      for (const line of lines) expect([...line].length).toBeLessThanOrEqual(40);
      expect(lines.length).toBeLessThanOrEqual(10);
      // Wrapping the notice across rows is allowed; losing it, or pushing it off-screen by writing
      // lines the terminal has to wrap, is not.
      expect(lines.join("").replace(/\s+/g, "")).toContain(UNAUDITED_NOTICE.replace(/\s+/g, ""));
    }

    // The other half of the same clamp: a console that answered this defect by always painting the
    // minimum would not have fixed it. A terminal reporting 96x28 is still painted at 96x28.
    const large = await framesAt(96, 28);
    const first = large[0] ?? [];
    expect(first.length).toBe(28);
    for (const line of first) expect([...line].length).toBe(96);
  });
});
