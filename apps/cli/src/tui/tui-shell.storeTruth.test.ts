import { describe, expect, it } from "vitest";
import type { CliOutcome, CliRequest } from "./cli-bridge";
import { buildMailboxSnapshot } from "./mailbox-pane";
import type { MailboxView, OperatorState, ProfileView } from "./state";
import { applyOutcome, runTuiShell, type TuiIo } from "./tui-shell";

/*
 * Flow 004 T23 — AC2: what the console shows after a send is what the STORE holds.
 *
 * ── The measured defect, twice ───────────────────────────────────────────────────────────────
 *
 * 004-T12-verify (AC2, "partial"):  `applyOutcome`'s `send` case does
 *   `outboxPending: next.mailbox.outboxPending + 1` — "a local increment the console computes
 *   itself and never reconciles against the store, which is exactly the optimistic echo the
 *   criterion forbids."
 * 004-T18-verify (AC2, "not_met"):  unchanged, at tui-shell.ts:768, and the same shape one case
 *   above at tui-shell.ts:756, `inboxReceived + asNumber(data.received, 0)`, "which accumulates
 *   poll deltas locally rather than reading a store total".
 *
 * ── Where the truth lives, and why the increment is not merely optimistic but backwards ──────
 *
 * The console holds no store key and must never hold one (state.ts:4-8, cli-bridge.ts:10-12), so
 * it cannot read `cli:outbox:*` itself. The ONLY honest source is what a command reported.
 *
 * Read the CLI and the two counts have different standing:
 *
 * - THE OUTBOX. `runtime/outbound.ts:294` derives "pending" from the records whose `status` is
 *   `"pending"`. A send that SUCCEEDS sets that record to `"delivered"` (`outbound.ts:289`) and
 *   returns `{ messageId, envelopeId, status: "delivered" }` (`outbound.ts:46`). So a successful
 *   send is evidence that the store's pending set did NOT grow — and `+ 1` moves the number on
 *   screen in the direction opposite to the one the store moved. No command in the frozen eight
 *   (`cli-bridge.ts:19-28`) reports a pending count at all: `doctor`'s `diagnostics()`
 *   (`profile.ts:476-479`) reports `profile_id`, `identity_id`, `device_id`, `contact_count`,
 *   `contacts`, `storage`, `runtime` — and no outbox figure.
 * - THE INBOX. `poll` reports `received` (`inbound.ts:27,36`), which is "envelopes accepted and
 *   committed BY THIS POLL". It is a per-poll delta, not a store total, so accumulating it makes
 *   the console's number diverge from the store's the moment one poll's result never arrives.
 *
 * ── The shape this file specifies, and the one it rejects ────────────────────────────────────
 *
 * SPECIFIED: **show nothing until a command says.** A mailbox count is either a value some command
 * result carried, verbatim, or the ABSENCE of a value. The console performs no arithmetic on a
 * count: no `+`, no accumulation, and no initial zero standing in for a report.
 *
 * REJECTED: "count from the last command result". For the inbox the two shapes agree — `poll`
 * carries `received`, so the last result's number is shown verbatim, which is what the second and
 * third cases below require. For the OUTBOX they do not, and the rejected shape has nothing to
 * count from: no result carries an outbox figure, so any implementation of it must fall back on a
 * value nothing reported — `createInitialState`'s `outboxPending: 0` (state.ts:345). That is the
 * same invention in a quieter voice, and the first case below is written to fail it: before any
 * command has run, "0 pending" is a claim about the store that the console made up.
 *
 * REPRESENTATION. `null` for "no command has reported this", matching `lastPolledAtMs: number |
 * null` on the same interface (state.ts:122) — "never checked", already distinct from a number
 * there for the same reason. `undefined` is accepted as the same statement: `reported()` below
 * normalises the two, so the implementer picks the spelling and the type widens to `number | null`
 * (or `| undefined`) on `MailboxView`. The reads go through a cast so that this file compiles and
 * RUNS against the current tree — every failure below is an assertion, never a loader error, and
 * `tsc --noEmit` stays at 0 until the implementer widens the field.
 *
 * A test that merely checked a number went up would be satisfied by the defect, which is why every
 * case here is about what the console may NOT claim. Each such case is paired with one a console
 * broken in the opposite direction — one that shows nothing, ever — cannot pass; the pairs are
 * labelled RED and PAIR below.
 *
 * Pure and shell-driven. Nothing here spawns a process, opens a store, reads a clock or touches a
 * relay, so this file takes no timeout from `apps/cli/test/childProcessTimeouts.ts` — it has none
 * to take, and no millisecond literal appears in it. The real-child half of AC2 is in
 * `main.processDriven.test.ts` ("T23 — AC2 against real child processes").
 */

/** A published profile with no registration checklist: the surfaces here predate one. */
const PROFILE: ProfileView = {
  label: "alice",
  profileDir: "/tmp/echolet-demo/alice",
  relayUrl: "http://127.0.0.1:18099",
  storeKeyEnv: "ECHOLET_E2E_KEY",
  identityId: "hbRYeNqVnWC74METcY57eDEkV9qNQ6Qzuz6RpsIYQA",
  deviceId: "733d80b0-e7e2-5e6c-ba84-0bcd96a373ea",
  contactCount: 1,
  published: true,
};

const CONTACT_ID = "nps4faW9mNX62tZs5M0oqAWtn05cWtn9gCw0gM1JHA";
const PAINTED_AT = 1_757_000_000_000;

const SEND: CliRequest = { command: "send", profileDir: PROFILE.profileDir, to: CONTACT_ID, text: "hello" };
const POLL: CliRequest = { command: "poll", profileDir: PROFILE.profileDir };

const ok = (data: unknown): CliOutcome => ({ ok: true, code: "ok", exitCode: 0, data });
const failed = (code: string, exitCode: number): CliOutcome => ({ ok: false, code, exitCode, data: null });

/** The four failure classes the CLI can return (specification.md §CLI surface; cli-bridge.ts:61). */
const CLASSES = [
  ["INVALID_CONFIGURATION", 2],
  ["PROTOCOL_REJECTED", 3],
  ["RELAY_UNAVAILABLE", 4],
  ["PERSISTENCE_FAILURE", 5],
] as const;

/**
 * A console that has observed nothing.
 *
 * Written out rather than taken from `createInitialState`, because the very thing under test is
 * what an unobserved mailbox may claim, and a helper that supplied the answer would beg the
 * question. Every field is the initial one; only the two counts are read.
 */
function freshState(): OperatorState {
  return {
    profiles: [PROFILE],
    activeProfile: 0,
    contacts: [{
      identityId: CONTACT_ID,
      deviceId: "9f0c4a11-2b3c-4d5e-8f60-71829a3b4c5d",
      devicePubkey: "npsPUBKEY_aW9mNX62tZs5M0oqAWtn05cWtn9gCw0gM",
      signalIdentityKey: "BQdNjP6tbN00N3eS6DNpmKpMDFDeDa4MFuUO1QWt8i",
    }],
    selectedContactId: CONTACT_ID,
    // Fixture correction (task-implementer, 2026-09-09): this hand-written copy of
    // `createInitialState` claimed `outboxPending: 0, inboxReceived: 0` — a count this very file's
    // own representation paragraph (state.ts:120-128) says must be `null`, the absence of a report,
    // not an invented zero. The two RED cases in "T23-AC2-A" read this object directly, with no
    // `applyOutcome` in between, so they failed against any implementation until the fixture matched
    // what `createInitialState` (state.ts:376) now produces. Only this line moved; no assertion and
    // no other file changed.
    mailbox: { outboxPending: null, inboxReceived: null, more: false, lastPolledAtMs: null },
    rejections: [],
    history: [],
    health: { relayUrl: PROFILE.relayUrl, status: "unknown", uptimeMs: null, checkedAtMs: null },
    pane: "mailbox",
    modal: undefined,
    activity: [],
    busy: false,
  };
}

/**
 * The state the composition root actually starts from, read through the same cast.
 *
 * `createInitialState` is deliberately NOT imported: `freshState` above is a hand-written copy of
 * it, so a change to the initial value shows up here as a difference between the two rather than
 * as two assertions moving together.
 */
type Reported = number | null;

/**
 * What a mailbox count says, with "no command has reported this" normalised to `null`.
 *
 * The cast is what lets this file run against the current tree: `MailboxView` types both fields
 * `number` today (state.ts:118-119), and the implementer widens them. A cast rather than a `@ts-`
 * comment, so the intended shape is written down as a type instead of as a suppression.
 */
function reported(mailbox: MailboxView, field: "outboxPending" | "inboxReceived"): Reported {
  const value = (mailbox as unknown as Readonly<Record<string, unknown>>)[field];
  if (value === undefined || value === null) return null;
  return value as number;
}

/** What the operator reads on the mailbox pane for one row, with no frame layout in the way. */
function paneValue(mailbox: MailboxView, label: "outbox" | "inbox"): string {
  const row = buildMailboxSnapshot({ mailbox, rejections: [] }).rows.find((entry) => entry.label === label);
  return row?.value ?? `<the mailbox pane has no ${label} row at all>`;
}

/**
 * A row that reports nothing must LOOK like it reports nothing.
 *
 * Two ways to fail this and both have been shipped by real programs: printing the sentinel
 * (`${null} pending` is "null pending") and printing a digit that came from nowhere.
 */
function expectsNoFigure(value: string, why: string): void {
  expect(/[0-9]/.test(value), `${why}: the row still shows a figure — ${JSON.stringify(value)}`).toBe(false);
  for (const sentinel of ["null", "undefined", "NaN"]) {
    expect(value.includes(sentinel), `${why}: the row leaked the sentinel ${sentinel} — ${JSON.stringify(value)}`).toBe(false);
  }
}

describe("T23-AC2-A: before a command has reported, the console reports nothing", () => {
  it("RED — claims no outbox count on a console that has run nothing", () => {
    // The case that kills "count from the last command result": there IS no last result, so the
    // only number available is `createInitialState`'s literal 0 (state.ts:345), which is a claim
    // about an encrypted store this process has never opened and cannot open.
    const mailbox = freshState().mailbox;

    expect(
      reported(mailbox, "outboxPending"),
      "the console asserted an outbox count before any command reported one",
    ).toBeNull();
    expectsNoFigure(paneValue(mailbox, "outbox"), "no command has reported an outbox count");
  });

  it("RED — claims no inbox count on a console that has run nothing", () => {
    const mailbox = freshState().mailbox;

    expect(
      reported(mailbox, "inboxReceived"),
      "the console asserted an inbox count before any command reported one",
    ).toBeNull();
    expectsNoFigure(paneValue(mailbox, "inbox"), "no command has reported an inbox count");
  });
});

describe("T23-AC2-B: a send is not evidence about the outbox, in either direction", () => {
  it("RED — does not raise the outbox count on a send the store recorded as DELIVERED", () => {
    /*
     * `send`'s success result is `{ messageId, envelopeId, status: "delivered" }`
     * (`outbound.ts:46`), written after the record is set to `"delivered"` (`outbound.ts:289`).
     * The store's pending set — `outbound.ts:294`, the records whose status is `"pending"` — did
     * not grow. `+ 1` therefore does not merely guess: it guesses in the wrong direction.
     */
    const before = freshState();
    const after = applyOutcome(before, SEND, ok({ messageId: "b6f0f1e2-0000-4000-8000-000000000001", envelopeId: "e1", status: "delivered" }), PAINTED_AT);

    expect(
      reported(after.mailbox, "outboxPending"),
      "the console invented an outbox count out of a send the store recorded as delivered",
    ).toBeNull();
    expectsNoFigure(paneValue(after.mailbox, "outbox"), "no result carried an outbox count");
  });

  it("RED — shows the same thing after two sends as after one", () => {
    // Accumulation, on its own. A console that shows `n + 1` per send drifts further from the
    // store with every message the operator writes, and never comes back: nothing decrements it.
    const one = applyOutcome(freshState(), SEND, ok({ status: "delivered" }), PAINTED_AT);
    const two = applyOutcome(one, SEND, ok({ status: "delivered" }), PAINTED_AT);

    expect(
      reported(two.mailbox, "outboxPending"),
      "the console accumulated a count of its own sends and called it the store's outbox",
    ).toBe(reported(one.mailbox, "outboxPending"));
    expect(reported(two.mailbox, "outboxPending")).toBeNull();
  });

  it("RED — reports no outbox count after a send the CLI refused, at every exit class", () => {
    // The dispatch's own case: "after a send that the relay refused, the number on screen is a
    // number the console invented". Today the refusal is handled by returning early, so the count
    // stays at the invented 0 rather than becoming the invented 1 — a different spelling of the
    // same claim, and the criterion is about the claim.
    for (const [code, exitCode] of CLASSES) {
      const after = applyOutcome(freshState(), SEND, failed(code, exitCode), PAINTED_AT);
      expect(
        reported(after.mailbox, "outboxPending"),
        `the console asserted an outbox count after ${code} (exit ${String(exitCode)})`,
      ).toBeNull();
    }
  });
});

describe("T23-AC2-C: what a poll reported is what the console shows — that poll's number, not a running total", () => {
  it("PAIR — shows the number the last poll actually reported", () => {
    // The anti-degenerate. A console that showed nothing, ever, would pass every RED case above
    // and would be a console that cannot tell the operator a message arrived.
    const after = applyOutcome(freshState(), POLL, ok({ received: 3, more: false, rejected: [] }), PAINTED_AT);

    expect(reported(after.mailbox, "inboxReceived"), "the console dropped the number the poll reported").toBe(3);
    expect(paneValue(after.mailbox, "inbox")).toContain("3");
  });

  it("RED — does not add one poll's number to the next", () => {
    /*
     * `received` is per-poll: "envelopes accepted and committed BY THIS POLL, across every page it
     * walked" (`inbound.ts:27`). Two polls, three envelopes then none, and the honest report of the
     * second poll is `0`. Today the console shows `3` again — a total it maintains itself, which is
     * the accumulation 004-T18-verify recorded at tui-shell.ts:756.
     */
    const first = applyOutcome(freshState(), POLL, ok({ received: 3, more: true, rejected: [] }), PAINTED_AT);
    const second = applyOutcome(first, POLL, ok({ received: 0, more: false, rejected: [] }), PAINTED_AT);

    expect(
      reported(second.mailbox, "inboxReceived"),
      "the console added one poll's count to the next and showed the sum as the store's inbox",
    ).toBe(0);
  });

  it("RED — moves no outbox count on a poll, because a poll reports none", () => {
    const after = applyOutcome(freshState(), POLL, ok({ received: 2, more: false, rejected: [] }), PAINTED_AT);

    expect(
      reported(after.mailbox, "outboxPending"),
      "a poll's result carries no outbox figure, so the console must still report none",
    ).toBeNull();
  });

  it("PAIR — keeps the last readable report when a poll's result is unreadable", () => {
    /*
     * The second anti-degenerate, and the dispatch's other case: "a poll whose result never
     * arrives". `parseCliOutcome` never throws and reports `UNREADABLE_CLI_OUTPUT`
     * (`cli-bridge.ts:64,127`). The console then knows nothing NEW — which is not the same as
     * knowing nothing — so the last thing a command actually said must stand. A fix that reset
     * every count to `null` on any failure would pass every RED case and fail this one.
     */
    const polled = applyOutcome(freshState(), POLL, ok({ received: 3, more: false, rejected: [] }), PAINTED_AT);
    const unreadable = applyOutcome(polled, POLL, failed("UNREADABLE_CLI_OUTPUT", 5), PAINTED_AT);

    expect(
      reported(unreadable.mailbox, "inboxReceived"),
      "an unreadable result erased a figure a readable one had reported",
    ).toBe(3);
  });
});

/* ── The driven half: the same property, from the keystroke that sends ────────────────────────
 *
 * The real `runTuiShell`, driven through the real `stdin` "data" handler, with `runCli` injected
 * so the send settles when this test says so. 004-T12-verify recorded that "a keystroke-to-real-
 * child send is covered by nothing"; the real-child half of that gap is closed in
 * `main.processDriven.test.ts`, and this is the keystroke half.
 */

const CR = String.fromCharCode(13);
const CTRL_C = String.fromCharCode(3);
const ESC = String.fromCharCode(27);
/** `${ESC}[H${ESC}[2J`, the prefix `paint()` writes before every frame (tui-shell.ts:548). */
const HOME = `${ESC}[H${ESC}[2J`;

interface DrivenShell {
  readonly requests: readonly CliRequest[];
  /** The last frame written, with the SGR runs `styleFrame` added stripped back out. */
  readonly lastFrame: () => string;
  readonly press: (sequence: string) => void;
  readonly settle: (outcome: CliOutcome) => void;
  readonly finished: Promise<number>;
}

function drive(state: OperatorState): DrivenShell {
  const requests: CliRequest[] = [];
  const writes: string[] = [];
  const pending: Array<(outcome: CliOutcome) => void> = [];
  let emit: ((chunk: Buffer) => void) | undefined;

  const io: TuiIo = {
    stdout: { write: (chunk: string) => { writes.push(chunk); return true; }, columns: 120, rows: 40 },
    stdin: {
      on: (event: string, handler: (chunk: Buffer) => void) => { if (event === "data") emit = handler; return undefined; },
      resume: () => undefined,
      pause: () => undefined,
    },
    now: () => PAINTED_AT,
    runCli: (request: CliRequest) => {
      requests.push(request);
      return new Promise<CliOutcome>((resolve) => { pending.push(resolve); });
    },
    answerTrustPrompt: () => undefined,
  };

  const finished = runTuiShell(io, state);

  return {
    requests,
    lastFrame: () => {
      const painted = writes.filter((chunk) => chunk.startsWith(HOME)).at(-1) ?? "";
      // `styleFrame` writes SGR runs; the row text is what the operator reads.
      return painted.split(`${ESC}[`).map((part, index) => (index === 0 ? part : part.replace(/^[0-9;?]*[a-zA-Z]/, ""))).join("");
    },
    press: (sequence: string) => emit?.(Buffer.from(sequence, "utf8")),
    settle: (outcome: CliOutcome) => { pending.shift()?.(outcome); },
    finished,
  };
}

const drain = (): Promise<void> => new Promise<void>((resolve) => { setImmediate(resolve); });

/** The mailbox pane's row for `label`, out of a painted frame. */
function frameRow(frame: string, label: "outbox" | "inbox"): string {
  const line = frame.split("\r\n").find((row) => row.trimStart().startsWith(label));
  return (line ?? `<no ${label} row was painted>`).slice(label.length).trim();
}

describe("T23-AC2-D: driven from the keystroke, the frame claims nothing the CLI did not report", () => {
  it("RED — paints no outbox figure after a send the console really made", async () => {
    const shell = drive({ ...freshState(), pane: "history" });
    await drain();

    shell.press("w");
    await drain();
    shell.press("hello");
    await drain();
    shell.press(CR);
    await drain();

    expect(shell.requests.map((request) => request.command), "the keystrokes did not produce one send").toEqual(["send"]);

    shell.settle(ok({ messageId: "b6f0f1e2-0000-4000-8000-000000000002", envelopeId: "e2", status: "delivered" }));
    await drain();

    // On the mailbox pane, which is where the operator reads the counts.
    shell.press("2");
    await drain();

    expectsNoFigure(frameRow(shell.lastFrame(), "outbox"), "the console painted an outbox figure no command reported");

    shell.press(CTRL_C);
    await shell.finished;
  });

  it("PAIR — still paints the figure a poll reported", async () => {
    // The anti-degenerate for the driven half: a console that painted no figures at all would pass
    // the case above and would never tell the operator that seven messages arrived.
    const shell = drive({ ...freshState(), pane: "mailbox" });
    await drain();

    shell.press("p");
    await drain();
    expect(shell.requests.map((request) => request.command)).toEqual(["poll"]);

    shell.settle(ok({ received: 7, more: false, rejected: [] }));
    await drain();

    expect(frameRow(shell.lastFrame(), "inbox"), "the console dropped the figure the poll reported").toContain("7");

    shell.press(CTRL_C);
    await shell.finished;
  });
});
