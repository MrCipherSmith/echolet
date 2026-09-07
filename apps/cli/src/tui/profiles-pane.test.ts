import { describe, expect, it } from "vitest";
import { buildProfilesSnapshot, formatProfilesLines } from "./profiles-pane";
import type { ContactView, ProfileView, RelayHealthView } from "./state";

// Flow 002 T9 — AC5's "shows profiles, queues, history, rejections and relay health", the profiles
// half.
//
// One design decision is pinned here rather than left to the implementer, because the obvious
// implementation of it is the unsafe one. The frozen eight-command CLI surface has NO command that
// lists pinned contacts: `doctor` reports `contact_count` and nothing else, and
// `Profile.listContacts()` has no entry point — exactly like `rotateBundle()` and `retryPending()`.
// The three ways out are:
//
//   1. add `contact list` — the ninth command specification.md §CLI surface froze against;
//   2. read the encrypted store from the TUI — which requires the TUI to hold the 32-byte store
//      key, the one thing AC5 forbids;
//   3. list what this session observed, and state the shortfall.
//
// (3) is chosen. A status pane for an unaudited prototype has to be honest about being partial,
// and a plausible list that is silently short is worse than a short list that says so.

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

const CONTACT: ContactView = {
  identityId: "nps4faW9mNX62tZs5M0oqAWtn05cWtn9gCw0gM1JHA",
  deviceId: "9f0c4a11-2b3c-4d5e-8f60-71829a3b4c5d",
  devicePubkey: "npsPUBKEY_aW9mNX62tZs5M0oqAWtn05cWtn9gCw0gM",
  signalIdentityKey: "BQdNjP6tbN00N3eS6DNpmKpMDFDeDa4MFuUO1QWt8i",
};

const HEALTHY: RelayHealthView = { relayUrl: PROFILE.relayUrl, status: "healthy", uptimeMs: 180, checkedAtMs: 1_757_000_000_000 };

const WIDTH = 160;

const paint = (profile: ProfileView, contacts: readonly ContactView[], health: RelayHealthView = HEALTHY) =>
  formatProfilesLines(buildProfilesSnapshot({ profile, contacts, health }), WIDTH).join("\n");

describe("the pane shows the profile the operator is driving", () => {
  it("shows the relay URL, identity, device and the store key variable NAME", () => {
    const painted = paint(PROFILE, [CONTACT]);
    expect(painted).toContain(PROFILE.relayUrl);
    expect(painted).toContain(PROFILE.identityId);
    expect(painted).toContain(PROFILE.deviceId);
    // The NAME, so two profiles can be told apart. Never the value — see `tui.keyMaterial.test.ts`.
    expect(painted).toContain(PROFILE.storeKeyEnv);
  });

  it("shows whether the profile has published its device record", () => {
    // `send` presupposes `relay publish`; an unpublished profile is refused
    // `UNAUTHORIZED_MAILBOX_ACCESS`, and the operator should be able to see why before sending.
    expect(paint(PROFILE, [CONTACT]).toLowerCase()).toContain("published");
    expect(paint({ ...PROFILE, published: false }, [CONTACT])).not.toEqual(paint(PROFILE, [CONTACT]));
  });
});

describe("pinned contacts, and the honest count", () => {
  it("lists each contact this session observed", () => {
    const painted = paint(PROFILE, [CONTACT]);
    expect(painted).toContain(CONTACT.identityId);
    expect(painted).toContain(CONTACT.deviceId);
  });

  it("reports no discrepancy when the observed roster matches doctor's count", () => {
    expect(buildProfilesSnapshot({ profile: PROFILE, contacts: [CONTACT], health: HEALTHY }).rosterDiscrepancy).toBeNull();
  });

  it("states the shortfall when doctor knows of contacts this session did not observe", () => {
    const snapshot = buildProfilesSnapshot({ profile: { ...PROFILE, contactCount: 3 }, contacts: [CONTACT], health: HEALTHY });
    expect(snapshot.rosterDiscrepancy).not.toBeNull();
    expect(snapshot.rosterDiscrepancy ?? "").toContain("2");
    expect(formatProfilesLines(snapshot, WIDTH).join("\n")).toContain(snapshot.rosterDiscrepancy ?? "");
  });

  it("states the shortfall for a fresh session over an existing profile", () => {
    // The commonest case: the operator restarts the TUI against a profile that already trusts
    // three contacts. Showing an empty contact list without comment would be a lie.
    const snapshot = buildProfilesSnapshot({ profile: { ...PROFILE, contactCount: 3 }, contacts: [], health: HEALTHY });
    expect(snapshot.contactLines).toEqual([]);
    expect(snapshot.rosterDiscrepancy).not.toBeNull();
    expect(snapshot.rosterDiscrepancy ?? "").toContain("3");
  });

  it("does not invent a discrepancy when the session observed more than doctor reported", () => {
    // An export creates no trust, so a card this session exported is not a pinned contact. That is
    // a state to leave alone, not a shortfall to announce.
    expect(buildProfilesSnapshot({ profile: { ...PROFILE, contactCount: 0 }, contacts: [CONTACT], health: HEALTHY }).rosterDiscrepancy).toBeNull();
  });
});

describe("relay health", () => {
  it("shows the health of the relay this profile is configured against", () => {
    const painted = paint(PROFILE, [CONTACT], HEALTHY);
    expect(painted.toLowerCase()).toContain("healthy");
    expect(painted).toContain(HEALTHY.relayUrl);
  });

  it("distinguishes unreachable from not-yet-checked", () => {
    // A relay that has never been checked and a relay that refused the connection are different
    // facts, and an operator standing up a remote relay needs to tell them apart.
    const unknown = buildProfilesSnapshot({ profile: PROFILE, contacts: [], health: { relayUrl: PROFILE.relayUrl, status: "unknown", uptimeMs: null, checkedAtMs: null } });
    const unreachable = buildProfilesSnapshot({ profile: PROFILE, contacts: [], health: { relayUrl: PROFILE.relayUrl, status: "unreachable", uptimeMs: null, checkedAtMs: 1_757_000_000_000 } });
    expect(unknown.healthLine).not.toBe(unreachable.healthLine);
    expect(unreachable.healthLine.toLowerCase()).toContain("unreachable");
  });
});

describe("formatting", () => {
  it("respects the width it is given and is deterministic", () => {
    const snapshot = buildProfilesSnapshot({ profile: PROFILE, contacts: [CONTACT], health: HEALTHY });
    for (const width of [40, 72, 120, 200]) {
      for (const line of formatProfilesLines(snapshot, width)) expect([...line].length).toBeLessThanOrEqual(width);
    }
    expect(formatProfilesLines(snapshot, WIDTH)).toEqual(formatProfilesLines(snapshot, WIDTH));
  });
});
