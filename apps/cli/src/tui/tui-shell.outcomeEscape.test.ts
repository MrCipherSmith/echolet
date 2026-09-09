import { describe, expect, it } from "vitest";
import { parseCliOutcome, type CliRequest } from "./cli-bridge";
import { renderFrame, UNAUDITED_NOTICE } from "./shell-chrome";
import { applyOutcome } from "./tui-shell";
import { PENDING_SETUP, type OperatorState, type ProfileView, type StepOutcome, type Viewport } from "./state";

/*
 * Flow 004 T21 — AC6's escape-free property on the surface the registration slice added. RED.
 *
 * MEASURED (004-T18-verify, F-001, reproduced on tree 860005b): `parseCliOutcome` keeps the CLI's
 * `error.code` verbatim by design (cli-bridge.ts:143, "typed failure codes are kept verbatim"), and
 * `foldSetup` (tui-shell.ts:713) writes it into `profile.setup` as `{ failed: outcome.code }`
 * WITHOUT the `paintable()` boundary that the sibling function `note()` applies to the very same
 * value one screen away (tui-shell.ts:836, "Keeping the NAME distinguishable does not require
 * keeping the BYTES paintable"). `profiles-pane.ts:85` then paints it, so a frame row comes out as
 *
 *   step 1  create profile  init            X<0x1b>[2JY (exit 2)
 *
 * and the row is still EXACTLY `cols` code points, so every shape assertion in the package passes
 * while the terminal obeys `ESC[2J` and clears the screen. Six inbound boundaries were closed in
 * flow 003 for exactly this hazard class ("a correspondent can no longer steer the operator's
 * terminal", 94899ef); this is a seventh field, added afterwards, that skips the one boundary its
 * own module documents for it.
 *
 * ── WHY THE PIN IS HERE AND NOT IN `profiles-pane.setup.test.ts` ────────────────────────────────
 *
 * That file's escape-free case (`profiles-pane.setup.test.ts:296-319`) is VACUOUS: it builds
 * `setup` by hand out of `RELAY_UNAVAILABLE` and `PERSISTENCE_FAILURE`, inputs that could not
 * violate the property whatever the code did. It was deliberately left as it is rather than fed a
 * hostile `StepOutcome`, because a hand-built hostile `setup` value asserts a property of the
 * RENDERER — and satisfying it would put a second filter in `stepStatus`, which is precisely the
 * arrangement `tui-shell.ts:832-833` argues against ("filtering at the one place text becomes
 * state" rather than in each reader, so a second reader added later inherits the guarantee instead
 * of needing its own audit). A test that can be passed at the wrong boundary is worse than a
 * vacuous one. So the property is pinned HERE, starting from the bytes the CLI actually returned
 * and asserting the STATE first and the frame second: only a filter at the boundary passes both.
 *
 * ── WHICH CASES ARE RED, AND WHICH ARE THE PAIRS THAT KILL A DEGENERATE FIX ─────────────────────
 *
 * RED on this tree (each fails on the unfiltered `failed` field, measured below):
 *   "keeps a control byte out of the STATE"           — the boundary; fails on U+009B and U+202E
 *   "keeps it out of the FRAME"                       — the impact; fails on U+001B at all three
 *                                                       viewports, with the row at full width
 *   "holds for every command that can write a step outcome"   — the same, over all five
 *   "holds for a C1 introducer and a bidi override"           — the other half of the predicate
 *   "keeps the printable remainder of a hostile code"         — RED, and it constrains the FIX:
 *                                                       today the frame reads `X<0x1b>[2JY`, so
 *                                                       `X[2JY` is absent; only a filter produces it
 *   "survives an outcome that is hostile in every field"      — the CLASS, not the instance
 *
 * PASSES TODAY, and is the pair that kills a fix which closes the hole by throwing the field away —
 * a console that renders `UNREADABLE` where the CLI named a code teaches the operator nothing, and
 * `paintable` is documented as "A FILTER, not a rejection and not a placeholder":
 *   "still paints a well-formed code and its exit class in full"
 *
 * Nothing here spawns a process, reads a clock or touches a store: `parseCliOutcome`, `applyOutcome`
 * and `renderFrame` are pure. It therefore takes no timeout from `apps/cli/test/childProcessTimeouts.ts`
 * — it has none to take, and no millisecond literal appears in it.
 */

const ESC = String.fromCharCode(27);
/** U+009B: a control sequence introducer that IS a single code point, with no ESC in front of it. */
const C1_CSI = String.fromCharCode(0x9b);
/** U+202E RIGHT-TO-LEFT OVERRIDE: reorders the rest of the painted line. */
const RTL_OVERRIDE = String.fromCharCode(0x202e);

/** The code the verifier measured: it clears the operator's screen and leaves the row full width. */
const HOSTILE_CODE = `X${ESC}[2JY`;

const PROFILE_DIR = "/tmp/echolet-demo/alice";
const RELAY_URL = "http://127.0.0.1:18317";
const OWN_IDENTITY = "hbRYeNqVnWC74METcY57eDEkV9qNQ6Qzuz6RpsIYQA";
const OWN_DEVICE = "733d80b0-e7e2-5e6c-ba84-0bcd96a373ea";
const CONTACT_ID = "nps4faW9mNX62tZs5M0oqAWtn05cWtn9gCw0gM1JHA";

/** Wide enough that no assertion below can be satisfied by the pane clipping the hostile bytes. */
const VIEWPORT: Viewport = { cols: 120, rows: 40 };
const VIEWPORTS: readonly Viewport[] = [{ cols: 72, rows: 16 }, VIEWPORT, { cols: 203, rows: 61 }];

/**
 * The predicate `tui-shell.ts` calls `steersTheDisplay`, restated rather than imported.
 *
 * It is deliberately a SECOND copy: the module's own predicate is private, and a test that imported
 * it would agree with the implementation by construction and would still pass if both were widened
 * to permit an escape byte. Written from the doc comment at `tui-shell.ts:418-462`, as a numeric
 * predicate for the reason recorded there — an invisible literal in a source file is a character no
 * reviewer can see and no diff can show.
 */
function steers(point: string): boolean {
  const code = point.codePointAt(0) ?? 0;
  if (code <= 0x1f || code === 0x7f || (code >= 0x80 && code <= 0x9f)) return true;
  if (code === 0x200e || code === 0x200f) return true;
  if (code >= 0x202a && code <= 0x202e) return true;
  if (code >= 0x2066 && code <= 0x2069) return true;
  return code === 0x2028 || code === 0x2029 || code === 0xfeff;
}

/** Every steering code point in `text`, named rather than printed, so a failure message is legible. */
function steeringPoints(text: string): string[] {
  return [...text].filter(steers).map((point) => `U+${(point.codePointAt(0) ?? 0).toString(16).padStart(4, "0").toUpperCase()}`);
}

/**
 * Every steering code point in a whole FRAME, counted line by line.
 *
 * Deliberately not `frame.join("\n")` then one scan: the joiner would itself be a C0 byte and the
 * assertion would fail on this test's own newlines rather than on the renderer's output.
 */
function steeringPointsInFrame(frame: readonly string[]): string[] {
  return frame.flatMap((line) => steeringPoints(line));
}

/**
 * Every string anywhere in a value, walked structurally.
 *
 * Deliberately not `JSON.stringify`: `JSON.stringify` escapes C0 bytes into a six-character
 * ASCII escape, so a scan of the serialised form reports a state carrying a raw ESC as
 * CLEAN — a false pass, and exactly the shape of vacuity this file exists to remove. (It does NOT
 * escape U+009B or U+202E, so a serialised scan is inconsistent as well as wrong.)
 */
function stringsIn(value: unknown, found: string[] = []): string[] {
  if (typeof value === "string") found.push(value);
  else if (Array.isArray(value)) for (const item of value) stringsIn(item, found);
  else if (typeof value === "object" && value !== null) for (const item of Object.values(value)) stringsIn(item, found);
  return found;
}

/** Every steering code point held anywhere in a value, as a flat list of names. */
function steeringPointsInValue(value: unknown): string[] {
  return stringsIn(value).flatMap((text) => steeringPoints(text));
}

function profileWith(overrides: Partial<ProfileView> = {}): ProfileView {
  return {
    label: "alice",
    profileDir: PROFILE_DIR,
    relayUrl: RELAY_URL,
    storeKeyEnv: "ECHOLET_TUI_REG_KEY",
    identityId: "(run doctor)",
    deviceId: "(run doctor)",
    contactCount: 0,
    published: false,
    state: "absent",
    storeKeyPresent: true,
    setup: PENDING_SETUP.map((step, index): StepOutcome => (index === 0 ? "ok" : step)),
    ...overrides,
  };
}

function stateWith(profile: ProfileView = profileWith()): OperatorState {
  return {
    profiles: [profile],
    activeProfile: 0,
    contacts: [],
    selectedContactId: null,
    mailbox: { outboxPending: 0, inboxReceived: 0, more: false, lastPolledAtMs: null },
    rejections: [],
    history: [],
    health: { relayUrl: RELAY_URL, status: "unknown", uptimeMs: null, checkedAtMs: null },
    pane: "profiles",
    modal: undefined,
    activity: [],
    busy: false,
    observedAtMs: 1_757_000_000_000,
  };
}

/** A clock reading. Any value serves; `applyOutcome` only stores it. */
const AT_MS = 1_757_000_000_000;

/**
 * One CLI failure, built the way the console actually receives it: as the child's JSON on stdout,
 * through the real `parseCliOutcome`. Nothing here hand-builds a `CliOutcome`, because the question
 * is whether the bytes a CHILD can emit reach a frame.
 */
function failureFromChild(code: string, exitCode: number) {
  return parseCliOutcome(JSON.stringify({ ok: false, error: { code } }), exitCode);
}

const INIT: CliRequest = { command: "init", profileDir: PROFILE_DIR, relayUrl: RELAY_URL, storeKeyEnv: "ECHOLET_TUI_REG_KEY" };

/** The five step-bearing commands, which are the five that can write a `failed` code (t35 §2.1). */
const STEP_REQUESTS: readonly CliRequest[] = [
  INIT,
  { command: "relay publish", profileDir: PROFILE_DIR },
  { command: "contact export", profileDir: PROFILE_DIR, out: `${PROFILE_DIR}/card.json` },
  { command: "contact import", profileDir: PROFILE_DIR, from: `${PROFILE_DIR}/peer.json` },
  { command: "doctor", profileDir: PROFILE_DIR },
];

describe("a CLI error code cannot steer the operator's terminal through the registration checklist", () => {
  it("keeps a control byte out of the STATE, which is where the boundary is", () => {
    // The boundary assertion. A fix applied in `profiles-pane.ts` — filtering as the pane paints —
    // leaves the state holding the escape byte and fails here, which is the whole reason this
    // assertion comes before the frame one.
    const outcome = failureFromChild(HOSTILE_CODE, 2);
    expect(outcome.code, "parseCliOutcome keeps the code verbatim, which is the premise of this file")
      .toContain(ESC);

    const next = applyOutcome(stateWith(), INIT, outcome, AT_MS);

    expect(
      steeringPointsInValue(next.profiles[0]?.setup),
      "a control byte from a CLI error code was written into profile.setup — foldSetup skips the paintable() boundary that note() applies to the same value",
    ).toEqual([]);
  });

  it("keeps it out of the FRAME, where the terminal would execute it", () => {
    const next = applyOutcome(stateWith(), INIT, failureFromChild(HOSTILE_CODE, 2), AT_MS);

    for (const viewport of VIEWPORTS) {
      const frame = renderFrame(next, viewport);

      // The shape holds either way, and that is the point: every width assertion in this package
      // passes on a row that clears the screen. Asserted here so the failure below cannot be
      // mistaken for a layout problem.
      expect(frame).toHaveLength(viewport.rows);
      for (const line of frame) expect([...line]).toHaveLength(viewport.cols);
      expect(frame.join("\n"), "AC6: the notice is on every frame").toContain(UNAUDITED_NOTICE);

      expect(
        steeringPointsInFrame(frame),
        `AC6 at ${String(viewport.cols)}x${String(viewport.rows)}: the renderer emitted a display-steering point that came from a CLI error code`,
      ).toEqual([]);
    }
  });

  it("holds for every command that can write a step outcome, not only for init", () => {
    // Totality over the five step-bearing commands rather than a sample: `SETUP_STEP_OF` maps each
    // of them onto a checklist row, and a fix applied to one call site would leave four open.
    for (const request of STEP_REQUESTS) {
      const next = applyOutcome(stateWith(), request, failureFromChild(HOSTILE_CODE, 4), AT_MS);

      expect(
        steeringPointsInValue(next.profiles[0]?.setup),
        `${request.command}: a control byte reached profile.setup`,
      ).toEqual([]);
      expect(
        steeringPointsInFrame(renderFrame(next, VIEWPORT)),
        `${request.command}: a control byte reached the frame`,
      ).toEqual([]);
    }
  });

  it("holds for a C1 introducer and a bidi override, not only for a bare ESC", () => {
    // AC7's predicate is two classes, not one. A fix that stripped U+001B alone would pass the
    // cases above and leave a code carrying U+009B — which IS a control sequence with no ESC in
    // front of it — and one carrying U+202E, which reorders the whole painted row.
    for (const code of [`A${C1_CSI}2JB`, `RELAY_${RTL_OVERRIDE}ELBAHCAERNU`]) {
      const next = applyOutcome(stateWith(), INIT, failureFromChild(code, 4), AT_MS);

      expect(steeringPointsInValue(next.profiles[0]?.setup)).toEqual([]);
      expect(steeringPointsInFrame(renderFrame(next, VIEWPORT))).toEqual([]);
    }
  });
});

describe("the fix must FILTER the code, not discard it", () => {
  it("still paints a well-formed code and its exit class in full", () => {
    // The pair. A console that answered the hole by replacing every failure code with a constant
    // would pass every assertion above and would take away the one string an operator has to search
    // for — which is what `profiles-pane.setup.test.ts`'s 20-case matrix exists to protect.
    const next = applyOutcome(stateWith(), INIT, failureFromChild("RELAY_UNAVAILABLE", 4), AT_MS);
    const joined = renderFrame(next, VIEWPORT).join("\n");

    expect(joined).toContain("RELAY_UNAVAILABLE");
    expect(joined).toContain("exit 4");
  });

  it("keeps the printable remainder of a hostile code, so the operator still sees what happened", () => {
    // `paintable` is documented as "A FILTER, not a rejection and not a placeholder" — an entry the
    // operator never sees is a worse outcome than one with a character missing, and a console that
    // dropped the code would also hide the fact that something emitted these bytes at all.
    const next = applyOutcome(stateWith(), INIT, failureFromChild(HOSTILE_CODE, 2), AT_MS);
    const joined = renderFrame(next, VIEWPORT).join("\n");

    expect(joined, "the hostile code was discarded rather than filtered").toContain("X[2JY");
    expect(joined).toContain("exit 2");
  });
});

describe("the class, not the instance: nothing an outcome writes may carry a steering point", () => {
  it("survives an outcome that is hostile in every field it can write", () => {
    /*
     * The enumeration this file exists to make total. Every string field of `OperatorState` that
     * `applyOutcome` writes from a `CliOutcome` is exercised at once — the checklist's `failed`
     * code, `init`/`doctor`'s two identifiers, `poll`'s rejection list, and `history`'s entries —
     * and EVERY string in the resulting state is walked rather than the fields being named one by
     * one, so a field this slice added that nobody thought to list is caught by the same assertion.
     *
     * Five of these six routes were closed in flow 003 and are expected to pass; the sixth is the
     * one this file is red on. Running them together is what makes the result an enumeration
     * instead of a spot check.
     */
    const hostile = (label: string): string => `${label}${ESC}[2J${C1_CSI}${RTL_OVERRIDE}`;

    let state = stateWith(profileWith({ state: "absent" }));

    state = applyOutcome(state, INIT, failureFromChild(hostile("CODE"), 2), AT_MS);
    state = applyOutcome(
      state,
      { command: "doctor", profileDir: PROFILE_DIR },
      parseCliOutcome(JSON.stringify({ ok: true, data: { identity_id: hostile(OWN_IDENTITY), device_id: hostile(OWN_DEVICE), contact_count: 1 } }), 0),
      AT_MS,
    );
    state = applyOutcome(
      state,
      { command: "poll", profileDir: PROFILE_DIR },
      parseCliOutcome(JSON.stringify({ ok: true, data: { received: 1, more: false, rejected: [{ envelopeId: hostile("env"), code: hostile("REJECTED") }] } }), 0),
      AT_MS,
    );
    state = applyOutcome(
      state,
      { command: "history", profileDir: PROFILE_DIR, contactIdentityId: CONTACT_ID },
      parseCliOutcome(JSON.stringify({
        ok: true,
        data: { entries: [{ sequence: 1, contactIdentityId: hostile(CONTACT_ID), messageId: hostile("mid"), direction: "inbound", plaintext: hostile("body"), createdAtMs: AT_MS }] },
      }), 0),
      AT_MS,
    );

    expect(
      steeringPointsInValue(state),
      "a field written from a CLI outcome reached the state carrying a display-steering point",
    ).toEqual([]);

    for (const pane of ["profiles", "mailbox", "history", "rejections", "health"] as const) {
      expect(
        steeringPointsInFrame(renderFrame({ ...state, pane }, VIEWPORT)),
        `the ${pane} pane painted a display-steering point`,
      ).toEqual([]);
    }
  });
});
