import { describe, expect, it } from "vitest";
import { MIN_VIEWPORT, UNAUDITED_NOTICE, renderFrame } from "./shell-chrome";
import type { KeyEvent, OperatorState } from "./state";
import { mapKey } from "./tui-shell";

// Flow 003 T5 — D-3: the legend must fit the viewport it is clamped to.
//
// MEASURED (flow 003 T2 §4): the footer is 106 columns and `MIN_VIEWPORT.cols` is 72, so at exactly
// the width the shell falls back to, the frame ends at "[i] import" and `[c] contact`,
// `[t] profile` and `[q] quit` are cut off. The key that leaves the program is undiscoverable from
// the program's own surface. `?` is unbound and paints nothing, so there is no second route to the
// key list either.
//
// The pin: every advertised key is visible at the minimum viewport, and there is a discoverable way
// to see the key list. `MIN_VIEWPORT` itself must NOT move — 72 is derived from the notice's 62
// columns, and widening it to win chrome space would trade an acceptance criterion for a legend.

const CONTACT_ID = "nps4faW9mNX62tZs5M0oqAWtn05cWtn9gCw0gM1JHA";

const key = (name: string): KeyEvent => ({ name, ctrl: false, sequence: name });

/** A state on which every command key is bound: a card to import, a contact selected, two profiles. */
function richState(): OperatorState {
  const profile = {
    label: "alice",
    profileDir: "/tmp/echolet-demo/alice",
    relayUrl: "http://127.0.0.1:18099",
    storeKeyEnv: "ECHOLET_E2E_KEY",
    identityId: "hbRYeNqVnWC74METcY57eDEkV9qNQ6Qzuz6RpsIYQA",
    deviceId: "733d80b0-e7e2-5e6c-ba84-0bcd96a373ea",
    contactCount: 1,
    published: true,
    contactCardPath: "/tmp/echolet-demo/bob-card.json",
  };
  return {
    profiles: [profile, { ...profile, label: "bob", profileDir: "/tmp/echolet-demo/bob" }],
    activeProfile: 0,
    contacts: [{
      identityId: CONTACT_ID,
      deviceId: "9f0c4a11-2b3c-4d5e-8f60-71829a3b4c5d",
      devicePubkey: "npsPUBKEY_aW9mNX62tZs5M0oqAWtn05cWtn9gCw0gM",
      signalIdentityKey: "BQdNjP6tbN00N3eS6DNpmKpMDFDeDa4MFuUO1QWt8i",
    }],
    selectedContactId: CONTACT_ID,
    mailbox: { outboxPending: 0, inboxReceived: 1, more: false, lastPolledAtMs: 1_757_000_000_000 },
    rejections: [],
    history: [],
    health: { relayUrl: profile.relayUrl, status: "healthy", uptimeMs: null, checkedAtMs: 1_757_000_000_000 },
    pane: "profiles",
    modal: undefined,
    activity: [{ at: 1_757_000_000_000, text: "poll → ok (exit 0)" }],
    busy: false,
  };
}

/** The shape assertions the legend must not cost, checked on the same frame the pin reads. */
function paintedAtMinimum(): string {
  const frame = renderFrame(richState(), MIN_VIEWPORT);
  expect(frame.length).toBe(MIN_VIEWPORT.rows);
  for (const line of frame) {
    expect([...line].length).toBe(MIN_VIEWPORT.cols);
    expect(line.includes(String.fromCharCode(27))).toBe(false);
  }
  const painted = frame.join("\n");
  expect(painted).toContain(UNAUDITED_NOTICE);
  return painted;
}

describe("D-3: the surface is learnable at the width it falls back to", () => {
  it("shows the operator how to quit at the minimum viewport", () => {
    // `q` is bound, and at 72 columns the frame does not say so. An operator who cannot find the
    // exit of a full-screen program that owns the alternate screen has to kill the terminal.
    expect(mapKey(key("q"), richState())).toEqual({ kind: "quit" });
    expect(paintedAtMinimum()).toContain("[q]");
  });

  it("binds a help key", () => {
    // Measured: `?` returns undefined and paints nothing. It is the one key an operator will try.
    expect(mapKey(key("?"), richState())).toBeDefined();
  });

  it("advertises the route to the full key list at the minimum viewport", () => {
    // A footer cannot carry ten labelled keys in 72 columns, so the honest resolution is that the
    // footer names the help key and the help surface carries the rest. Whatever the footer drops,
    // it must not drop the way to find what it dropped.
    expect(paintedAtMinimum()).toContain("[?]");
  });
});
