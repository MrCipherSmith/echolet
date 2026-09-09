import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildProfilesSnapshot, formatProfilesLines } from "./profiles-pane";
import { UNAUDITED_NOTICE, renderFrame } from "./shell-chrome";
import type { OperatorState, ProfileView, RelayHealthView, Viewport } from "./state";

/**
 * Flow 004, T15 — the registration checklist, as a value (t35 §2.1; AC1's pure half).
 *
 * WHY THIS FILE EXISTS. Registration today is four separate CLI invocations plus a card file
 * exchanged by hand, and the console can start none of them: `paneKeyIntent` binds p/d/r/h/i/c/t/w
 * and nothing else, so `init`, `contact export` and the operand-carrying half of `contact import`
 * have no key. The design's answer is not a wizard pane and not an overlay — it is the EXISTING
 * profiles pane (ordinal 1) rendering a six-step checklist while the active profile is not yet
 * `ready`, and the ordinary detail rows once it is. That costs no ordinal and no chrome, which is
 * why the frame properties flows 002 and 003 paid for are re-asserted here rather than renegotiated.
 *
 * The six steps and what each drives (t35 §2.1, verbatim):
 *
 *   0  store key present    no child is spawned      `Object.hasOwn(env, profile.storeKeyEnv)`
 *   1  create the profile   `init`                   exit 0 with identity_id/device_id/profile_id
 *   2  publish to the relay `relay publish`          exit 0
 *   3  export your card     `contact export`         exit 0
 *   4  import their card    `contact import`         exit 0, through the trust modal
 *   5  confirm              `doctor`                 exit 0 with a non-zero contact_count
 *
 * ── STEP 0 IS A SECURITY BOUNDARY, AND THIS FILE HOLDS THE HALF A PURE TEST CAN HOLD ────────────
 *
 * The 32-byte store key must already be in the console's environment; the console may neither
 * generate it, read it, nor write it anywhere. The pure half of that is: **the renderer's output
 * cannot depend on the environment at all**, so removing the variable changes nothing on screen and
 * no key-shaped literal can appear on the frame — including in the shell command the pane prints
 * when the key is missing, which is the one place a console tempted to generate a key would put it.
 *
 * The half a pure test CANNOT hold is the read itself: `process.env[name] !== undefined` and
 * `Object.hasOwn(process.env, name)` produce the same boolean and the same frame. That detection
 * needs a hostile environment object in a real process, and it lives in
 * `main.registration.processDriven.test.ts`, where the console's own `process.env` is replaced by a
 * Proxy whose `get` trap records the caller.
 *
 * ── WHICH CASES ARE RED, AND WHICH WOULD PASS VACUOUSLY ────────────────────────────────────────
 *
 * RED today (the checklist does not exist, so these fail on the missing text):
 *   "renders the six steps", "names the command each step runs", "step 0 prints the shell command",
 *   "a failed step is shown with the code and the exit code the CLI returned" (all 20 rows),
 *   "the checklist survives the frame's shape".
 *
 * VACUOUS today, and paired with the red case that kills the degenerate implementation:
 *   "the detail rows replace the checklist once the profile is ready" — passes now because the
 *     detail rows are all the pane has. Its pair is "renders the six steps": an implementation that
 *     always paints the checklist fails that one, an implementation that never paints it fails this
 *     one, and only an implementation that switches on `state` passes both.
 *   "renders identically with and without the value in the environment" — passes now because
 *     nothing in the pure layer reads the environment. Its pair is "step 0 prints the shell
 *     command": together they force a pane that reports the key's ABSENCE without reading its
 *     PRESENCE from anything but the state.
 *   "no key-shaped literal reaches the pane" — passes now because the pane prints no command at
 *     all. Same pair: the command must be there, and must carry no key.
 */

const KEY_ENV = "ECHOLET_TUI_REGISTRATION_TEST";
const PROFILE_DIR = "/tmp/echolet-demo/alice";
const RELAY_URL = "http://127.0.0.1:18317";
const OWN_IDENTITY = "hbRYeNqVnWC74METcY57eDEkV9qNQ6Qzuz6RpsIYQA";
const OWN_DEVICE = "733d80b0-e7e2-5e6c-ba84-0bcd96a373ea";

/**
 * A run of at least 32 characters from the base64url alphabet: the shape of a 32-byte store key,
 * which is 43 characters once encoded. Nothing legitimate on this pane is that long and that
 * unbroken — the environment variable's NAME is 29 characters, the profile directory contains `/`,
 * and the generator command the design prints is all short shell tokens.
 */
const KEY_SHAPED = /[A-Za-z0-9_-]{32,}/;

const HEALTH: RelayHealthView = { relayUrl: RELAY_URL, status: "unknown", uptimeMs: null, checkedAtMs: null };

/** t35 §2.1: `"pending" | "ok" | { failed: code, exitCode }`, one per step, six of them. */
type StepOutcome = "pending" | "ok" | { readonly failed: string; readonly exitCode: number };

const PENDING: readonly StepOutcome[] = ["pending", "pending", "pending", "pending", "pending", "pending"];

interface ProfileOverrides {
  readonly state?: "unknown" | "absent" | "ready";
  readonly storeKeyPresent?: boolean;
  readonly setup?: readonly StepOutcome[];
  readonly identityId?: string;
  readonly deviceId?: string;
  readonly contactCount?: number;
  readonly published?: boolean;
  readonly relayUrl?: string;
}

/**
 * `state`, `storeKeyPresent` and `setup` are the three fields t35 §2.1 adds to `ProfileView`. They
 * are cast in rather than declared here, following `tui-shell.input.test.ts`, so that the tests are
 * red on the BEHAVIOUR and the type-check stays usable while the fields are being added.
 */
function profileWith(overrides: ProfileOverrides = {}): ProfileView {
  return {
    label: "alice",
    profileDir: PROFILE_DIR,
    relayUrl: RELAY_URL,
    storeKeyEnv: KEY_ENV,
    identityId: "(run doctor)",
    deviceId: "(run doctor)",
    contactCount: 0,
    published: false,
    state: "absent",
    storeKeyPresent: true,
    setup: PENDING.map((step, index): StepOutcome => (index === 0 ? "ok" : step)),
    ...overrides,
  } as unknown as ProfileView;
}

const READY_PROFILE = profileWith({
  state: "ready",
  identityId: OWN_IDENTITY,
  deviceId: OWN_DEVICE,
  contactCount: 1,
  published: true,
  setup: ["ok", "ok", "ok", "ok", "ok", "ok"],
});

function checklistLines(profile: ProfileView, width = 120): string[] {
  return formatProfilesLines(buildProfilesSnapshot({ profile, contacts: [], health: HEALTH }), width);
}

function stateFor(profile: ProfileView): OperatorState {
  return {
    profiles: [profile],
    activeProfile: 0,
    contacts: [],
    selectedContactId: null,
    mailbox: { outboxPending: 0, inboxReceived: 0, more: false, lastPolledAtMs: null },
    rejections: [],
    history: [],
    health: HEALTH,
    pane: "profiles",
    modal: undefined,
    activity: [],
    busy: false,
  };
}

const VIEWPORTS: readonly Viewport[] = [{ cols: 72, rows: 16 }, { cols: 120, rows: 40 }, { cols: 203, rows: 61 }];
const ESC = String.fromCharCode(27);

let storeKey = "";

beforeEach(() => {
  // A real 32-byte store key, of exactly the shape `init --store-key-env` expects, placed in the
  // environment exactly as the runbook places it. Never printed: every assertion over it is a
  // boolean, the discipline `tui.keyMaterial.test.ts` established.
  storeKey = randomBytes(32).toString("base64url");
  process.env[KEY_ENV] = storeKey;
});

afterEach(() => {
  delete process.env[KEY_ENV];
  storeKey = "";
});

describe("the profiles pane is the registration checklist until the profile is ready", () => {
  it("renders six steps while the profile is not ready, in order", () => {
    const painted = checklistLines(profileWith({ state: "absent" })).join("\n");

    for (const step of [0, 1, 2, 3, 4, 5]) {
      expect(painted, `t35 §2.1: the checklist has six steps and this one is missing`).toContain(`step ${String(step)}`);
    }
    // In order, and each exactly once: a checklist an operator reads top to bottom is the whole
    // point of putting it where they already look for "what is this profile".
    const ordinals = [...painted.matchAll(/step (\d)/g)].map((match) => Number(match[1]));
    expect(ordinals.filter((value, index) => ordinals.indexOf(value) === index)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it("names the command each step runs, so an operator can see what a keystroke will start", () => {
    const painted = checklistLines(profileWith({ state: "absent" })).join("\n");

    // Step 0 spawns nothing at all — that is the whole of its security value.
    expect(painted).toContain("init");
    expect(painted).toContain("relay publish");
    expect(painted).toContain("contact export");
    expect(painted).toContain("contact import");
    expect(painted).toContain("doctor");
  });

  it("replaces the checklist with the ordinary detail rows once the profile is ready", () => {
    // The pair for "renders six steps". An implementation that always paints the checklist fails
    // here; one that never paints it fails there. Only switching on `state` passes both.
    const painted = checklistLines(READY_PROFILE).join("\n");

    expect(painted).toContain(OWN_IDENTITY);
    expect(painted).toContain(OWN_DEVICE);
    expect(painted).toContain(KEY_ENV);
    expect(painted, "a ready profile is not a profile in setup").not.toContain("step 0");
    expect(painted).not.toContain("step 1");
  });
});

describe("step 0: the store key is the operator's to create, and the console's to notice", () => {
  it("prints a shell command the operator runs themselves when the variable is not set", () => {
    const painted = checklistLines(profileWith({ storeKeyPresent: false, setup: PENDING })).join("\n");

    // The variable is named — an operator who cannot see WHICH variable cannot set it.
    expect(painted).toContain(KEY_ENV);
    // And the command to run is printed, because "set the variable" is not an instruction anyone
    // can follow for a 32-byte key. The console never runs it: it has no shell and no key.
    expect(painted, "t35 §2.1: the pane prints the shell command for the operator to run")
      .toMatch(new RegExp(`export\\s+${KEY_ENV}=`));
  });

  it("puts no key material in that command, and none anywhere else on the pane", () => {
    const lines = checklistLines(profileWith({ storeKeyPresent: false, setup: PENDING }));

    for (const line of lines) {
      // Said as a boolean so a failure message cannot print what it was looking for.
      expect(line.includes(storeKey), "the store key's VALUE reached the pane").toBe(false);
      if (!line.includes("export ")) continue;
      // The rejected design, refused by a test rather than by a paragraph: a console that generated
      // the 32 bytes itself and printed them — or handed them to `init` — would put a key-shaped
      // literal on this exact line. The command must GENERATE the key in the operator's shell.
      expect(KEY_SHAPED.test(line), "a key-shaped literal is on the line the operator is told to run").toBe(false);
    }
  });

  it("does not print that command once the variable is set", () => {
    const painted = checklistLines(profileWith({ storeKeyPresent: true })).join("\n");
    expect(painted).not.toMatch(new RegExp(`export\\s+${KEY_ENV}=`));
  });

  it("renders identically whether the variable's value is in the environment or not", () => {
    // The pure half of "presence, never the value". A pane that resolved the NAME to its VALUE
    // would render differently once the variable is removed; one that reads a boolean off the state
    // cannot. Asserted in both directions, because a pane that reads the environment could be
    // reading it in either branch.
    for (const profile of [profileWith({ storeKeyPresent: true }), profileWith({ storeKeyPresent: false, setup: PENDING })]) {
      const withKey = checklistLines(profile);
      delete process.env[KEY_ENV];
      const withoutKey = checklistLines(profile);
      process.env[KEY_ENV] = storeKey;
      expect(withoutKey, "the pane's output depends on the environment").toEqual(withKey);
    }
  });
});

describe("a failed step is shown with the code and the exit class the CLI actually returned", () => {
  /**
   * The command × exit-class matrix, over the codes this tree's `cli.ts` actually classifies.
   *
   * Totality over the matrix rather than a sample (AC5's discipline, applied to the one surface
   * this task builds): each of the five child-spawning steps, against each of the four failure
   * classes the CLI can return. The console must report the class it was GIVEN — flow 003 measured
   * the opposite, a console that turned a retryable exit 4 into a stop-and-investigate exit 5.
   */
  const CLASSES: readonly (readonly [string, number])[] = [
    ["INVALID_CONFIGURATION", 2],
    ["INVALID_CONTACT_CARD", 3],
    ["RELAY_UNAVAILABLE", 4],
    ["PERSISTENCE_FAILURE", 5],
  ];

  for (const step of [1, 2, 3, 4, 5]) {
    for (const [code, exitCode] of CLASSES) {
      it(`step ${String(step)} failing ${code} names the code and exit ${String(exitCode)}`, () => {
        const setup = PENDING.map((pending, index): StepOutcome => {
          if (index === 0) return "ok";
          if (index < step) return "ok";
          return index === step ? { failed: code, exitCode } : pending;
        });
        const painted = checklistLines(profileWith({ state: "absent", setup })).join("\n");

        expect(painted, "the CLI's own code is what the operator has to search for").toContain(code);
        expect(painted).toContain(`exit ${String(exitCode)}`);
        // AC5's second clause on this pane: the console never reports a class the CLI did not
        // return. This is the assertion that fails if a step flattens every failure into one line.
        for (const other of [2, 3, 4, 5].filter((candidate) => candidate !== exitCode)) {
          expect(painted, `the pane reported exit ${String(other)}, which the CLI did not return`)
            .not.toContain(`exit ${String(other)}`);
        }
      });
    }
  }

  it("leaves the steps after a failed one visibly unrun", () => {
    const setup: readonly StepOutcome[] = ["ok", "ok", "ok", { failed: "PERSISTENCE_FAILURE", exitCode: 5 }, "pending", "pending"];
    const painted = checklistLines(profileWith({ state: "absent", setup })).join("\n");

    expect(painted).toContain("PERSISTENCE_FAILURE");
    // Two steps are still pending and the pane has to say so: a step that silently did not run is
    // indistinguishable from a step that ran and found nothing (t35 §2.2, the same rule as
    // sequences). Counted rather than matched by position, so the wording stays the pane's.
    expect((painted.match(/pending/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });
});

describe("the checklist changes nothing the frame already guarantees", () => {
  it("keeps the frame exactly rows by cols, escape-free, and carrying the notice", () => {
    const states = [
      stateFor(profileWith({ state: "absent" })),
      stateFor(profileWith({ storeKeyPresent: false, setup: PENDING })),
      stateFor(profileWith({ state: "absent", setup: ["ok", "ok", { failed: "RELAY_UNAVAILABLE", exitCode: 4 }, "pending", "pending", "pending"] })),
    ];

    for (const state of states) {
      for (const viewport of VIEWPORTS) {
        const frame = renderFrame(state, viewport);
        expect(frame).toHaveLength(viewport.rows);
        for (const line of frame) expect([...line]).toHaveLength(viewport.cols);
        const joined = frame.join("\n");
        expect(joined, "AC6: the notice is on every frame").toContain(UNAUDITED_NOTICE);
        expect(joined.includes(ESC), "the renderer emitted an escape byte").toBe(false);
        expect(joined.includes(storeKey), "the store key reached a frame").toBe(false);
        // Not vacuous: the checklist really is on these frames. At 72x16 the pane has ten body
        // rows, so only that it is a checklist is asserted there; the full six are asserted above
        // at a width where they all fit.
        expect(joined).toContain("step ");
      }
    }
  });
});
