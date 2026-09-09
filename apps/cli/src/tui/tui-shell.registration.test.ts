import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MAX_PLAINTEXT_BYTES } from "../limits";
import { buildArgv, type CliOutcome, type CliRequest } from "./cli-bridge";
import type { Intent } from "./intents";
import { applyOutcome, decodeKey, mapKey, reduce } from "./tui-shell";
import type { InputState, OperatorState, ProfileView, RelayHealthView } from "./state";

/**
 * Flow 004, T15 — the checklist as an interaction model (t35 §2.1; AC1's reducer half).
 *
 * `profiles-pane.setup.test.ts` pins what the checklist SAYS. This file pins what it DOES: which
 * keystroke starts which step, the order it enforces, and how a step's outcome is folded back.
 *
 * Three properties carry the weight, and each was chosen because the design names it explicitly:
 *
 * 1. **Advancing is manual and one step at a time.** `Enter` on the profiles pane starts the next
 *    incomplete step and nothing auto-runs after a success (t35 §2.1, "Advancing is manual").
 *    Chaining steps 1→2→3 was rejected there: two of the three need an operand the operator has to
 *    supply anyway, and a console that ran three commands from one keystroke makes "which of the
 *    three failed" a question the operator reconstructs from a log rather than reads on a line.
 * 2. **Order is enforced by keying, not by disabling.** Step 0 gates step 1 — a console that
 *    spawned `init` without the store key in its environment would earn `INVALID_CONFIGURATION`
 *    and teach the operator nothing — and step 2 gates every `send`, because `outbound.ts:152`
 *    refuses an unpublished sender locally, before it spends a peer's prekey.
 * 3. **A step's state comes from an observed outcome and from nothing else.** No optimism, no
 *    guessing: the code and the exit code the CLI actually returned, or `pending`.
 *
 * ── WHICH CASES ARE RED, AND WHICH WOULD PASS VACUOUSLY ────────────────────────────────────────
 *
 * RED today: every "Enter starts …" case (`mapKey` binds no Return at all, so the intent is
 * `undefined`), every `applyOutcome` case that reads `setup`/`state` (both fields are unread), and
 * "no compose row before publication" (today `w` opens one for an unpublished profile — the console
 * will happily compose a message that `send` then refuses).
 *
 * VACUOUS today, each paired with the red case that kills the degenerate implementation:
 *   "Enter starts nothing while the store key is absent"  — vacuous because Enter is unbound.
 *       Pair: "Enter starts init once the store key is present". An implementation that binds
 *       Enter unconditionally fails the first; one that never binds it fails the second.
 *   "Enter starts nothing while a child is in flight"     — same shape, same pair.
 *   "Enter starts nothing once every step is done"       — same shape, same pair.
 *   "a published profile does open a compose row"        — passes now, and is the pair for
 *       "opens no compose row before publication": without it, that one is satisfied by a console
 *       that can never send at all.
 *   "no argv carries the store key's value"               — vacuous because no checklist argv
 *       exists yet. Pair: the exact-argv assertions beside it, which force those argvs to exist.
 */

const KEY_ENV = "ECHOLET_TUI_REGISTRATION_KEYING_TEST";
const PROFILE_DIR = "/tmp/echolet-demo/alice";
const RELAY_URL = "http://127.0.0.1:18317";
const OWN_IDENTITY = "hbRYeNqVnWC74METcY57eDEkV9qNQ6Qzuz6RpsIYQA";
const OWN_DEVICE = "733d80b0-e7e2-5e6c-ba84-0bcd96a373ea";
const PEER_IDENTITY = "nps4faW9mNX62tZs5M0oqAWtn05cWtn9gCw0gM1JHA";
const CARD_PATH = "/tmp/echolet-demo/bob-card.json";
const OBSERVED_AT_MS = 1_757_000_000_000;

type StepOutcome = "pending" | "ok" | { readonly failed: string; readonly exitCode: number };

const PENDING: readonly StepOutcome[] = ["pending", "pending", "pending", "pending", "pending", "pending"];

/** Steps 1..5 marked done, so the checklist's next incomplete step is `step`. */
function upTo(step: number, tail: readonly StepOutcome[] = []): readonly StepOutcome[] {
  return PENDING.map((pending, index): StepOutcome => {
    if (index < step) return "ok";
    return tail[index - step] ?? pending;
  });
}

const HEALTH: RelayHealthView = { relayUrl: RELAY_URL, status: "unknown", uptimeMs: null, checkedAtMs: null };

interface ProfileOverrides {
  readonly state?: "unknown" | "absent" | "ready";
  readonly storeKeyPresent?: boolean;
  readonly setup?: readonly StepOutcome[];
  readonly relayUrl?: string;
  readonly published?: boolean;
  readonly contactCardPath?: string;
  readonly identityId?: string;
  readonly deviceId?: string;
  readonly contactCount?: number;
}

/** The three fields t35 §2.1 adds to `ProfileView`, cast in the way this suite's siblings do. */
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
    setup: upTo(1),
    ...overrides,
  } as unknown as ProfileView;
}

function stateWith(profile: ProfileView, overrides: Partial<OperatorState> = {}): OperatorState {
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
    // t35 §2.3: a clock reading folded into state at startup and after every settled command, so
    // nothing pure has to read a clock. The default export path's instant comes from here.
    observedAtMs: OBSERVED_AT_MS,
    ...overrides,
  } as unknown as OperatorState;
}

const ENTER = decodeKey("\r");

/** One keystroke, end to end through the pure model: what it meant, and what it did. */
function press(state: OperatorState, key = ENTER): { readonly intent: Intent | undefined; readonly state: OperatorState; readonly requests: readonly CliRequest[] } {
  const intent = mapKey(key, state);
  if (intent === undefined) return { intent, state, requests: [] };
  const step = reduce(state, intent);
  return {
    intent,
    state: step.state,
    requests: step.effects.flatMap((effect) => (effect.kind === "run-cli" ? [effect.request] : [])),
  };
}

const ok = (data: unknown): CliOutcome => ({ ok: true, code: "ok", exitCode: 0, data });
const failed = (code: string, exitCode: number): CliOutcome => ({ ok: false, code, exitCode, data: null });

const activeProfile = (state: OperatorState): Record<string, unknown> =>
  state.profiles[state.activeProfile] as unknown as Record<string, unknown>;

let storeKey = "";
beforeEach(() => {
  storeKey = randomBytes(32).toString("base64url");
  process.env[KEY_ENV] = storeKey;
});
afterEach(() => {
  delete process.env[KEY_ENV];
  storeKey = "";
});

describe("Enter on the profiles pane starts the next incomplete step, and only that one", () => {
  it("step 1 — creates the profile, with the argv t35 §2.1 tabulates", () => {
    const outcome = press(stateWith(profileWith({ setup: upTo(1) })));

    expect(outcome.requests).toEqual([
      { command: "init", profileDir: PROFILE_DIR, relayUrl: RELAY_URL, storeKeyEnv: KEY_ENV },
    ]);
    expect(buildArgv(outcome.requests[0] as CliRequest)).toEqual([
      "init", "--relay-url", RELAY_URL, "--store-key-env", KEY_ENV, "--profile", PROFILE_DIR, "--json",
    ]);
  });

  it("step 1 — asks for the relay URL first when the profile has none", () => {
    // t35 §2.1: the relay URL is the one operand with no honest default. A profile launched with
    // `--relay-url` already has its own and is not asked again; one launched without it must be,
    // because a console that guessed would spawn `init` against a relay the operator never named.
    const outcome = press(stateWith(profileWith({ relayUrl: "", setup: upTo(1) })));

    expect(outcome.intent).toEqual({ kind: "input-open", field: "relay-url" });
    expect(outcome.requests, "no child may be spawned before the operand exists").toEqual([]);
  });

  it("step 2 — publishes to the relay", () => {
    const outcome = press(stateWith(profileWith({ state: "ready", setup: upTo(2) })));

    expect(outcome.requests).toEqual([{ command: "relay publish", profileDir: PROFILE_DIR }]);
    expect(buildArgv(outcome.requests[0] as CliRequest)).toEqual(["relay", "publish", "--profile", PROFILE_DIR, "--json"]);
  });

  it("step 3 — opens the export path pre-filled with a name that cannot collide", () => {
    // `contact export` writes with `flag: "wx"`, so re-exporting over the same path is
    // PERSISTENCE_FAILURE at exit 5 — measured on the live system (T34). Cards expire after seven
    // days, so re-export is routine; a timestamped default costs nothing and never destroys a card
    // a peer may still be importing. `--force` was rejected for exactly that reason.
    const opened = press(stateWith(profileWith({ state: "ready", published: true, setup: upTo(3) })));
    expect(opened.intent).toEqual({ kind: "input-open", field: "export-path" });

    const input = opened.state.input;
    expect(input, "the row has to be open for the operator to see what will be written").toBeDefined();
    const buffer = (input as InputState).buffer;
    expect(buffer, "t35 §2.1: the default is <profileDir>/card-<UTC instant>.json")
      .toMatch(new RegExp(`^${PROFILE_DIR}/card-[^/]+\\.json$`));

    // Painted, then submitted: the same `renderedAt` gate the trust modal uses.
    const painted = { ...opened.state, input: { ...(input as InputState), renderedAt: OBSERVED_AT_MS } } as unknown as OperatorState;
    const submitted = reduce(painted, { kind: "input-submit" });
    expect(submitted.effects).toEqual([{ kind: "run-cli", request: { command: "contact export", profileDir: PROFILE_DIR, out: buffer } }]);
  });

  it("step 4 — opens the card path, and imports it without --yes", () => {
    const opened = press(stateWith(profileWith({ state: "ready", published: true, setup: upTo(4) })));
    expect(opened.intent).toEqual({ kind: "input-open", field: "card-path" });

    const input = opened.state.input;
    expect(input).toBeDefined();
    const typed: InputState = { ...(input as InputState), buffer: CARD_PATH, renderedAt: OBSERVED_AT_MS };
    const submitted = reduce({ ...opened.state, input: typed } as unknown as OperatorState, { kind: "input-submit" });

    expect(submitted.effects).toEqual([{ kind: "run-cli", request: { command: "contact import", profileDir: PROFILE_DIR, from: CARD_PATH } }]);
    const argv = buildArgv({ command: "contact import", profileDir: PROFILE_DIR, from: CARD_PATH });
    expect(argv).toEqual(["contact", "import", "--from", CARD_PATH, "--profile", PROFILE_DIR, "--json"]);
    // The trust decision stays in the child. `--yes` would move it into the console, which t35 §9
    // refuses "for any convenience".
    expect(argv).not.toContain("--yes");
  });

  it("step 5 — confirms with doctor", () => {
    const outcome = press(stateWith(profileWith({ state: "ready", published: true, setup: upTo(5) })));

    expect(outcome.requests).toEqual([{ command: "doctor", profileDir: PROFILE_DIR }]);
    expect(buildArgv(outcome.requests[0] as CliRequest)).toEqual(["doctor", "--profile", PROFILE_DIR, "--json"]);
  });

  it("starts nothing once every step is done", () => {
    const outcome = press(stateWith(profileWith({ state: "ready", published: true, contactCount: 1, setup: upTo(6) })));
    expect(outcome.requests).toEqual([]);
  });
});

describe("the order the checklist enforces", () => {
  it("refuses to start step 1 while the store key is not in this console's environment", () => {
    // Step 0's whole content, at the keying layer. The pair for this case is "step 1 — creates the
    // profile" above: an implementation that binds Enter unconditionally fails here, and one that
    // never binds it fails there.
    const outcome = press(stateWith(profileWith({ storeKeyPresent: false, setup: PENDING })));

    expect(outcome.requests, "init without the store key earns INVALID_CONFIGURATION and teaches nothing").toEqual([]);
    expect(outcome.intent?.kind, "step 0 is the operator's to do in their own shell").not.toBe("run");
  });

  it("refuses to start a step while a child is already in flight", () => {
    const outcome = press(stateWith(profileWith({ setup: upTo(1) }), { busy: true }));
    expect(outcome.requests).toEqual([]);

    // The deep half, for a `run` that arrives from anywhere at all: the reducer refuses it too.
    const deep = reduce(stateWith(profileWith({ setup: upTo(1) }), { busy: true }), {
      kind: "run",
      request: { command: "init", profileDir: PROFILE_DIR, relayUrl: RELAY_URL, storeKeyEnv: KEY_ENV },
    });
    expect(deep.effects).toEqual([]);
  });

  it("opens no compose row for a profile that has never published", () => {
    // Step 2 before any send (t35 §2.1). `send` presupposes publication: `outbound.ts:152` refuses
    // an unpublished sender locally, before it spends a peer's prekey, and the CLI's actionable
    // sentence — "run `relay publish` for this profile, then send again" — is dropped by
    // `writeResult`. So a console that composes first tells the operator nothing they can act on.
    const unpublished = stateWith(
      profileWith({ state: "ready", published: false, setup: upTo(2) }),
      { pane: "history", selectedContactId: PEER_IDENTITY },
    );
    expect(mapKey(decodeKey("w"), unpublished), "composing before publication ends in a refusal the console cannot explain").toBeUndefined();

    // And the deep half: a submit that arrives from anywhere for an unpublished profile builds no
    // request. This is the assertion that survives a future key rebinding.
    const composed = {
      ...unpublished,
      input: { field: "message", buffer: "SYNTHETIC_TUI_BODY_ONE", renderedAt: OBSERVED_AT_MS, maxBytes: MAX_PLAINTEXT_BYTES },
    } as unknown as OperatorState;
    expect(reduce(composed, { kind: "input-submit" }).effects).toEqual([]);
  });

  it("opens one for the same profile once it has published", () => {
    // The pair: without this, "opens no compose row" is satisfied by a console that can never send.
    const published = stateWith(
      profileWith({ state: "ready", published: true, setup: upTo(3) }),
      { pane: "history", selectedContactId: PEER_IDENTITY },
    );
    expect(mapKey(decodeKey("w"), published)).toEqual({ kind: "input-open", field: "message" });

    const composed = {
      ...published,
      input: { field: "message", buffer: "SYNTHETIC_TUI_BODY_ONE", renderedAt: OBSERVED_AT_MS, maxBytes: MAX_PLAINTEXT_BYTES },
    } as unknown as OperatorState;
    expect(reduce(composed, { kind: "input-submit" }).effects).toEqual([
      { kind: "run-cli", request: { command: "send", profileDir: PROFILE_DIR, to: PEER_IDENTITY, text: "SYNTHETIC_TUI_BODY_ONE" } },
    ]);
  });
});

describe("a step's state is folded from the outcome the CLI returned, and from nothing else", () => {
  const STEPS: readonly (readonly [number, CliRequest])[] = [
    [1, { command: "init", profileDir: PROFILE_DIR, relayUrl: RELAY_URL, storeKeyEnv: KEY_ENV }],
    [2, { command: "relay publish", profileDir: PROFILE_DIR }],
    [3, { command: "contact export", profileDir: PROFILE_DIR, out: `${PROFILE_DIR}/card-1.json` }],
    [4, { command: "contact import", profileDir: PROFILE_DIR, from: CARD_PATH }],
    [5, { command: "doctor", profileDir: PROFILE_DIR }],
  ];

  for (const [step, request] of STEPS) {
    it(`marks step ${String(step)} ok on exit 0`, () => {
      const before = stateWith(profileWith({ setup: upTo(step) }));
      const after = applyOutcome(before, request, ok({ identity_id: OWN_IDENTITY, device_id: OWN_DEVICE, contact_count: 1 }), OBSERVED_AT_MS);
      const setup = activeProfile(after).setup as readonly StepOutcome[] | undefined;
      expect(setup, "applyOutcome must fold the step outcomes t35 §2.1 puts on ProfileView").toBeDefined();
      expect((setup ?? [])[step]).toBe("ok");
      // Nothing auto-runs and nothing auto-completes: the steps after this one are untouched.
      for (let later = step + 1; later < 6; later += 1) expect((setup ?? [])[later]).toBe("pending");
    });

    for (const [code, exitCode] of [["INVALID_CONFIGURATION", 2], ["INVALID_CONTACT_CARD", 3], ["RELAY_UNAVAILABLE", 4], ["PERSISTENCE_FAILURE", 5]] as const) {
      it(`marks step ${String(step)} failed with ${code} and exit ${String(exitCode)}`, () => {
        const before = stateWith(profileWith({ setup: upTo(step) }));
        const after = applyOutcome(before, request, failed(code, exitCode), OBSERVED_AT_MS);
        const setup = activeProfile(after).setup as readonly StepOutcome[] | undefined;
        expect(setup, "applyOutcome must fold the step outcomes t35 §2.1 puts on ProfileView").toBeDefined();

        // The code AND the exit code, because `INVALID_CONTACT_CARD` is returned at exit 2 for a
        // file that would not parse and at exit 3 for a card that parsed and failed validation —
        // one code, two different things for the operator to do (t35 §4.1).
        expect((setup ?? [])[step]).toEqual({ failed: code, exitCode });
        for (let later = step + 1; later < 6; later += 1) expect((setup ?? [])[later]).toBe("pending");
      });
    }
  }

  it("becomes ready when init reports an identity, the way doctor does", () => {
    // t35 §2.1: `init` returns the identical `summary()` shape `doctor` returns, so the same fold
    // serves both — one line, no new parser.
    const after = applyOutcome(
      stateWith(profileWith({ setup: upTo(1) })),
      { command: "init", profileDir: PROFILE_DIR, relayUrl: RELAY_URL, storeKeyEnv: KEY_ENV },
      ok({ identity_id: OWN_IDENTITY, device_id: OWN_DEVICE, profile_id: "0d1f4a2b" }),
      OBSERVED_AT_MS,
    );

    expect(activeProfile(after).state).toBe("ready");
    expect(activeProfile(after).identityId).toBe(OWN_IDENTITY);
    expect(activeProfile(after).deviceId).toBe(OWN_DEVICE);
  });

  it("becomes absent when any command reports INVALID_CONFIGURATION at exit 2", () => {
    // Six configuration failures share one code (`ConfigurationError`'s fixed
    // `INVALID_CONFIGURATION`, discarded message and all), so this is all the console can know —
    // and it is enough to know that the profile is not there and the checklist is what to show.
    for (const [, request] of STEPS) {
      const after = applyOutcome(stateWith(profileWith({ state: "ready" })), request, failed("INVALID_CONFIGURATION", 2), OBSERVED_AT_MS);
      expect(activeProfile(after).state, `${request.command} did not report the profile as absent`).toBe("absent");
    }
  });
});

describe("no step can put the store key anywhere but the inherited environment", () => {
  it("names the variable and never carries its value, for every request the checklist builds", () => {
    // Vacuous on its own — it is the exact-argv assertions above that force these requests to
    // exist. Together they are the whole of AC5 on this path.
    const requests: readonly CliRequest[] = [
      { command: "init", profileDir: PROFILE_DIR, relayUrl: RELAY_URL, storeKeyEnv: KEY_ENV },
      { command: "relay publish", profileDir: PROFILE_DIR },
      { command: "contact export", profileDir: PROFILE_DIR, out: `${PROFILE_DIR}/card-1.json` },
      { command: "contact import", profileDir: PROFILE_DIR, from: CARD_PATH },
      { command: "doctor", profileDir: PROFILE_DIR },
    ];

    for (const request of requests) {
      for (const token of buildArgv(request)) expect(token.includes(storeKey)).toBe(false);
    }
    expect(buildArgv(requests[0] as CliRequest)).toContain(KEY_ENV);
  });

  it("keeps the key out of the state the checklist adds", () => {
    // Structural, like `tui.keyMaterial.test.ts`'s: `storeKeyPresent` is a BOOLEAN and `setup` holds
    // codes and exit codes, so a full serialisation of the state cannot contain a key.
    const serialised = JSON.stringify(stateWith(profileWith({ storeKeyPresent: true, setup: upTo(3) })));
    expect(serialised.includes(storeKey)).toBe(false);
    expect(serialised.includes(KEY_ENV)).toBe(true);
  });
});
