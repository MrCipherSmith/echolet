import { fitPane } from "./pane-fit";
import type { ContactView, ProfileView, RelayHealthView } from "./state";
import { formatInstant, labelled } from "./text";

/**
 * Profiles, their relay URL, the pinned contacts this session observed, and relay health.
 *
 * Built as the reference builds an inspector pane: a pure `build…Snapshot` over plain source data
 * and a pure `format…Lines` over the snapshot, so every assertion is a value comparison and no
 * test needs a terminal.
 *
 * **The roster is deliberately partial and says so.** The frozen eight-command CLI surface has no
 * command that lists pinned contacts: `doctor` reports `contact_count` and nothing else, and
 * `Profile.listContacts()` has no entry point. The two alternatives were rejected — adding a ninth
 * command reopens a frozen decision, and reading the encrypted store directly would require the
 * TUI to hold the 32-byte store key, which is precisely what AC5 forbids. So the pane lists the
 * contacts it observed being imported through the trust modal, cross-checks the count against
 * `doctor`, and states the discrepancy rather than showing a plausible list that is silently short.
 * See the design note §6.
 *
 * An import is the only thing that can put a contact on this list. `contact export` creates no
 * trust — a card this session handed out is not a pinned contact — and it has no key binding on
 * this surface either, so the roster names exactly one category and this comment says so. (Flow 003
 * T2 §1.2: the earlier wording here claimed both categories and no code path produced the other.)
 */

export interface ProfilesRow {
  readonly label: string;
  readonly value: string;
}

export interface ProfilesSnapshot {
  readonly rows: readonly ProfilesRow[];
  readonly contactLines: readonly string[];
  /** Non-null when `doctor`'s count exceeds the contacts this session observed. */
  readonly rosterDiscrepancy: string | null;
  readonly healthLine: string;
}

function formatHealthLine(health: RelayHealthView): string {
  switch (health.status) {
    case "healthy": {
      // Health is derived from the frozen surface: a command that succeeded proves the relay
      // answered. `uptime_ms` is reported by the relay's own /health endpoint, which no CLI command
      // exposes, so it is simply absent rather than filled with a placeholder the console invented.
      const uptime = health.uptimeMs === null ? "" : `uptime ${health.uptimeMs} ms, `;
      return `relay ${health.relayUrl} healthy (${uptime}checked ${formatInstant(health.checkedAtMs)})`;
    }
    case "unreachable":
      return `relay ${health.relayUrl} unreachable (checked ${formatInstant(health.checkedAtMs)})`;
    case "unknown":
    default:
      // Deliberately distinct from "unreachable". "Never checked" and "refused the connection" are
      // different facts, and an operator standing up a remote relay needs to tell them apart.
      return `relay ${health.relayUrl} not yet checked`;
  }
}

export function buildProfilesSnapshot(source: {
  readonly profile: ProfileView;
  readonly contacts: readonly ContactView[];
  readonly health: RelayHealthView;
}): ProfilesSnapshot {
  const { profile, contacts, health } = source;

  const rows: ProfilesRow[] = [
    { label: "profile", value: profile.label },
    { label: "relay", value: profile.relayUrl },
    // The NAME of the environment variable, so two profiles can be told apart. Never its value:
    // there is no field on `ProfileView` that could hold one. See `tui.keyMaterial.test.ts`.
    { label: "store-key-env", value: profile.storeKeyEnv },
    { label: "identity", value: profile.identityId },
    { label: "device", value: profile.deviceId },
    // `send` presupposes `relay publish`; an unpublished profile is refused
    // UNAUTHORIZED_MAILBOX_ACCESS, and the operator should see why before sending. `doctor` does
    // not report publication state, so like the roster this is what the SESSION observed — and it
    // says so, rather than reporting a bare "no" about a profile that may well be published.
    { label: "published", value: profile.published ? "yes, by this session" : "not observed by this session" },
    { label: "directory", value: profile.profileDir },
  ];

  const contactLines = contacts.map((contact) => `${contact.identityId}  ${contact.deviceId}`);

  // `doctor` is the authority on how many contacts are pinned; this session's roster is the
  // authority on which ones it can name. Where they disagree the pane says so, rather than showing
  // a plausible list that is silently short. An excess in the other direction is NOT a shortfall:
  // an export creates no trust, so a card this session exported is not a pinned contact.
  const unseen = profile.contactCount - contacts.length;
  const rosterDiscrepancy = unseen > 0
    ? `+${unseen} pinned by doctor but not seen by this session (no CLI command lists contacts)`
    : null;

  return { rows, contactLines, rosterDiscrepancy, healthLine: formatHealthLine(health) };
}

/**
 * `limit` is the number of body rows the frame has for this pane; `Infinity` (the default) means
 * "no limit", which is what every value-comparison test of this module wants.
 *
 * The roster is the list region, and it keeps its HEAD rather than its tail — deliberately, and
 * unlike history and rejections. `ContactView` carries no time, so "most recent" is not a question
 * the value can answer; and the roster is a selection surface whose display order has to be decided
 * together with the `c` cycle, which walks `state.contacts` from the head. A pane that showed the
 * tail while `c` walked from the head would cycle the operator through contacts it is not showing.
 *
 * `rosterDiscrepancy` is moved above the list so that the pane's own account of what it cannot name
 * is a fixed line: it is the last thing that should disappear when the pane runs out of rows.
 */
export function formatProfilesLines(snapshot: ProfilesSnapshot, width: number, limit = Number.POSITIVE_INFINITY): string[] {
  const head: string[] = snapshot.rows.map((row) => labelled(row.label, row.value));
  head.push("");
  head.push(labelled("contacts", `${snapshot.contactLines.length} observed this session`));
  if (snapshot.rosterDiscrepancy !== null) head.push(snapshot.rosterDiscrepancy);

  const rows = snapshot.contactLines.map((contact) => `  ${contact}`);
  return fitPane({ head, rows, tail: ["", snapshot.healthLine], keep: "head" }, limit, width);
}
