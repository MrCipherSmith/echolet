import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { buildArgv, type CliRequest } from "./cli-bridge";
import { renderFrame } from "./shell-chrome";
import { buildTrustModal, renderModal } from "./modal-host";
import { createInitialState, PANE_IDS, type OperatorState, type PaneId, type ProfileView, type TrustModal, type Viewport } from "./state";

// Flow 002 T9 — AC5, the half this task can prove.
//
//   "The operator console drives a local CLI, shows profiles, queues, history, rejections and
//    relay health, and never receives, stores or transmits a store key or private key material.
//    This is demonstrated by evidence, not asserted."
//
// The TUI has exactly two outputs: the frames it paints, and the argument vectors it hands to
// `dist/cli.js`. There is no HTTP server, no browser origin and no localhost port — that is the
// reason the surface is a TUI and not the web console the plan originally described. So the
// evidence AC5 asks for is an exhaustive sweep of those two outputs, which is only possible
// because `renderFrame` and `buildArgv` are pure functions.
//
// The secret used here is a REAL 32-byte base64url store key of the shape `init --store-key-env`
// expects, generated per test, and placed in the process environment exactly as the runbook places
// it. If any code path in the render layer or the argv builder reaches through the variable NAME
// to its value, these tests see the value on screen or in an argv and fail.
//
// Nothing in this file ever prints the secret: every assertion is a boolean over `includes`, the
// same discipline `cli.dashOptionValues.test.ts` uses in its `redacted()` helper, so a failure
// message cannot leak what it was checking for.

const KEY_ENV = "ECHOLET_TUI_KEY_MATERIAL_TEST";

/** Shapes that must never reach a frame even if a future field carries them. */
const PRIVATE_KEY_MARKERS = /identitySecretKey|deviceSecretKey|sessionSecretKey|"seed"|PRIVATE KEY|ciphertext/;

let storeKey = "";

const PROFILE: ProfileView = {
  label: "alice",
  profileDir: "/tmp/echolet-demo/alice",
  relayUrl: "http://127.0.0.1:18099",
  storeKeyEnv: KEY_ENV,
  identityId: "hbRYeNqVnWC74METcY57eDEkV9qNQ6Qzuz6RpsIYQA",
  deviceId: "733d80b0-e7e2-5e6c-ba84-0bcd96a373ea",
  contactCount: 1,
  published: true,
};

const CONTACT = {
  identityId: "nps4faW9mNX62tZs5M0oqAWtn05cWtn9gCw0gM1JHA",
  deviceId: "9f0c4a11-2b3c-4d5e-8f60-71829a3b4c5d",
  devicePubkey: "npsPUBKEY_aW9mNX62tZs5M0oqAWtn05cWtn9gCw0gM",
  signalIdentityKey: "BQdNjP6tbN00N3eS6DNpmKpMDFDeDa4MFuUO1QWt8i",
} as const;

const TRUST_MODAL: TrustModal = {
  kind: "trust",
  cardPath: "/tmp/echolet-demo/bob-card.json",
  profileLabel: PROFILE.label,
  identifiers: {
    identity_id: CONTACT.identityId,
    device_id: CONTACT.deviceId,
    device_pubkey: CONTACT.devicePubkey,
    signal_identity_key: CONTACT.signalIdentityKey,
  },
  renderedAt: 1_757_000_000_000,
};

function stateFor(pane: PaneId, modal?: TrustModal): OperatorState {
  return {
    profiles: [PROFILE],
    activeProfile: 0,
    contacts: [CONTACT],
    selectedContactId: CONTACT.identityId,
    mailbox: { outboxPending: 2, inboxReceived: 1, more: true, lastPolledAtMs: 1_757_000_000_000 },
    rejections: [{ envelopeId: "94a6f678-0000-4000-8000-000000000001", code: "SENDER_NOT_TRUSTED" }],
    history: [
      { sequence: 1, contactIdentityId: CONTACT.identityId, messageId: "4ba942f0-0000-4000-8000-000000000001", direction: "outbound", plaintext: "SYNTHETIC_TUI_BODY_ONE", createdAtMs: 1_757_000_000_000 },
    ],
    health: { relayUrl: PROFILE.relayUrl, status: "healthy", uptimeMs: 180, checkedAtMs: 1_757_000_000_000 },
    pane,
    modal,
    activity: [{ at: 1_757_000_000_000, text: "poll → received 1" }],
    busy: false,
  };
}

const VIEWPORTS: readonly Viewport[] = [{ cols: 72, rows: 16 }, { cols: 120, rows: 40 }, { cols: 203, rows: 61 }];

function everyRequest(): CliRequest[] {
  return [
    { command: "init", profileDir: PROFILE.profileDir, relayUrl: PROFILE.relayUrl, storeKeyEnv: KEY_ENV },
    { command: "contact export", profileDir: PROFILE.profileDir, out: "/tmp/echolet-demo/alice-card.json" },
    { command: "contact import", profileDir: PROFILE.profileDir, from: "/tmp/echolet-demo/bob-card.json" },
    { command: "relay publish", profileDir: PROFILE.profileDir },
    { command: "send", profileDir: PROFILE.profileDir, to: CONTACT.identityId, text: "SYNTHETIC_TUI_BODY_ONE" },
    { command: "poll", profileDir: PROFILE.profileDir },
    { command: "history", profileDir: PROFILE.profileDir, contactIdentityId: CONTACT.identityId },
    { command: "doctor", profileDir: PROFILE.profileDir },
  ];
}

beforeEach(() => {
  storeKey = randomBytes(32).toString("base64url");
  process.env[KEY_ENV] = storeKey;
});

afterEach(() => {
  delete process.env[KEY_ENV];
  storeKey = "";
});

describe("AC5: no store key reaches any rendered frame", () => {
  it("does not paint the store key on any pane, at any viewport", () => {
    for (const viewport of VIEWPORTS) {
      for (const pane of PANE_IDS) {
        const painted = renderFrame(stateFor(pane), viewport).join("\n");
        expect(painted.includes(storeKey)).toBe(false);
        // The variable NAME is what the operator needs to see, and it must be there: an operator
        // who cannot tell which key a profile uses cannot tell two profiles apart.
        expect(renderFrame(stateFor("profiles"), viewport).join("\n").includes(KEY_ENV)).toBe(true);
      }
    }
  });

  it("does not paint the store key with the trust modal open", () => {
    for (const viewport of VIEWPORTS) {
      expect(renderFrame(stateFor("profiles", TRUST_MODAL), viewport).join("\n").includes(storeKey)).toBe(false);
      expect(renderModal(TRUST_MODAL, viewport).join("\n").includes(storeKey)).toBe(false);
    }
  });

  it("paints no private-key-shaped material on any pane", () => {
    for (const viewport of VIEWPORTS) {
      for (const pane of PANE_IDS) {
        expect(PRIVATE_KEY_MARKERS.test(renderFrame(stateFor(pane, TRUST_MODAL), viewport).join("\n"))).toBe(false);
      }
    }
  });
});

describe("AC5: no store key reaches any argument vector", () => {
  it("passes the environment variable NAME and never its value, for every command", () => {
    for (const request of everyRequest()) {
      const argv = buildArgv(request);
      for (const token of argv) expect(token.includes(storeKey)).toBe(false);
    }
  });

  it("names the store key variable on init and nowhere carries its value", () => {
    const argv = buildArgv({ command: "init", profileDir: PROFILE.profileDir, relayUrl: PROFILE.relayUrl, storeKeyEnv: KEY_ENV });
    expect(argv).toContain("--store-key-env");
    expect(argv).toContain(KEY_ENV);
    expect(argv.join(" ").includes(storeKey)).toBe(false);
  });

  it("never emits a flag that could carry a key value", () => {
    // The CLI has no `--store-key` and must never acquire one. If a future request shape adds a
    // way to pass the key inline, this fails before it reaches a process table.
    for (const request of everyRequest()) {
      const argv = buildArgv(request);
      expect(argv.some((token) => /^--store-key$|^--key$|^--secret$|^--seed$/.test(token))).toBe(false);
    }
  });
});

describe("AC5: the state model has no place to put key material", () => {
  it("builds an initial state that does not contain the store key anywhere", () => {
    // Structural, not behavioural: `ProfileView` carries `storeKeyEnv` (a NAME) and there is no
    // field for a value, so a full serialisation of the state cannot contain one. This is why the
    // guarantee survives changes to the renderer.
    const state = createInitialState({ profiles: [PROFILE] });
    expect(JSON.stringify(state).includes(storeKey)).toBe(false);
    expect(JSON.stringify(state).includes(KEY_ENV)).toBe(true);
  });

  it("does not read the environment while rendering", () => {
    // A renderer that resolved `storeKeyEnv` to its value would render differently depending on
    // the environment. Removing the variable must change nothing on screen.
    const withKey = renderFrame(stateFor("profiles"), { cols: 120, rows: 40 });
    delete process.env[KEY_ENV];
    const withoutKey = renderFrame(stateFor("profiles"), { cols: 120, rows: 40 });
    expect(withoutKey).toEqual(withKey);
  });
});

describe("AC5: the trust modal shows public identifiers only", () => {
  it("renders the four public identifiers and no secret", () => {
    const modal = buildTrustModal({
      cardPath: TRUST_MODAL.cardPath,
      profileLabel: TRUST_MODAL.profileLabel,
      identifiers: TRUST_MODAL.identifiers,
    });
    const painted = renderModal(modal, { cols: 120, rows: 40 }).join("\n");
    expect(painted.includes(storeKey)).toBe(false);
    expect(PRIVATE_KEY_MARKERS.test(painted)).toBe(false);
    // `device_pubkey` and `signal_identity_key` are PUBLIC keys and must be visible: they are what
    // the operator compares out of band. This assertion exists so the test above cannot be
    // satisfied by redacting the modal into uselessness.
    expect(painted).toContain(CONTACT.devicePubkey);
    expect(painted).toContain(CONTACT.signalIdentityKey);
  });
});
