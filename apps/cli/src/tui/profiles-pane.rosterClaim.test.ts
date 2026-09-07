import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildProfilesSnapshot } from "./profiles-pane";
import type { ContactView } from "./state";

// Flow 003 T5 — the smaller of the pinned defects (flow 003 T2 §1.2).
//
// The roster's honesty is the whole point of this pane: it lists what the SESSION observed, says so,
// and cross-checks the count against `doctor` rather than showing a plausible list that is silently
// short. Its own header comment then undoes that by describing the roster as "the contacts it
// observed being exported or imported through the trust modal".
//
// No code path puts an exported card in the roster. `contact export` has no key binding at all, and
// the only writer of `state.contacts` is the shell's `observeContact`, which runs after a
// `contact import` the operator confirmed through the trust modal. An export creates no trust, so a
// card this session exported is not a pinned contact — as the reducer comment inside
// `buildProfilesSnapshot` correctly says three paragraphs later.
//
// A documented contract that names a category the module cannot produce is a defect of the same
// kind as a pane that hides rows: the next reader believes the surface shows something it does not.

const SOURCE = readFileSync(fileURLToPath(new URL("./profiles-pane.ts", import.meta.url)), "utf8");

/** The module's leading doc comment — its stated contract, as opposed to its inline reasoning. */
function moduleDocComment(): string {
  const start = SOURCE.indexOf("/**");
  const end = SOURCE.indexOf("*/", start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return SOURCE.slice(start, end);
}

describe("the profiles pane's documented roster matches the roster it can build", () => {
  it("does not describe the roster as holding exported cards as well as imported ones", () => {
    // Behaviour first: the roster is exactly what it is handed, and nothing in this module can add
    // an exported card to it.
    const contacts: readonly ContactView[] = [{
      identityId: "nps4faW9mNX62tZs5M0oqAWtn05cWtn9gCw0gM1JHA",
      deviceId: "9f0c4a11-2b3c-4d5e-8f60-71829a3b4c5d",
      devicePubkey: "npsPUBKEY_aW9mNX62tZs5M0oqAWtn05cWtn9gCw0gM",
      signalIdentityKey: "BQdNjP6tbN00N3eS6DNpmKpMDFDeDa4MFuUO1QWt8i",
    }];
    const snapshot = buildProfilesSnapshot({
      profile: {
        label: "alice",
        profileDir: "/tmp/echolet-demo/alice",
        relayUrl: "http://127.0.0.1:18099",
        storeKeyEnv: "ECHOLET_E2E_KEY",
        identityId: "hbRYeNqVnWC74METcY57eDEkV9qNQ6Qzuz6RpsIYQA",
        deviceId: "733d80b0-e7e2-5e6c-ba84-0bcd96a373ea",
        contactCount: 1,
        published: true,
      },
      contacts,
      health: { relayUrl: "http://127.0.0.1:18099", status: "healthy", uptimeMs: null, checkedAtMs: 1_757_000_000_000 },
    });
    expect(snapshot.contactLines.length).toBe(contacts.length);

    // The stated contract must say the same thing. The pattern matches only the claim that the
    // roster holds BOTH categories; a header that explains why an export is deliberately absent is
    // free to use the word.
    expect(moduleDocComment()).not.toMatch(/export\w*\s+(?:or|and)\s+import/i);
  });
});
