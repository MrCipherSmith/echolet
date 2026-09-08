import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { openProfile, type ContactCard, type ContactIdentifiers } from "../runtime/profile";
import { CLI_CHILD_TIMEOUT_MS, CLI_TEST_TIMEOUT_MS } from "../../test/childProcessTimeouts";

// Flow 004, T5 — RED spec 2 of 2: `doctor` must enumerate the profile's pinned correspondents. The
// console-as-client design holds no store key and must never hold one (AC5), so it cannot read
// `cli:contact:*` itself; `doctor` is its only route to an address book, and today `diagnostics()`
// (profile.ts:459-461) returns only `{profile_id, identity_id, device_id, contact_count, storage,
// runtime}` — the count, never the identities behind it, even though `Profile.listContacts()`
// (profile.ts:448-450) already exists and is used for the outbound send path only (outbound.ts:126).
//
// Every timeout below comes from apps/cli/test/childProcessTimeouts.ts, never a new literal.

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const manifest = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8")) as { bin?: string | { echolet?: string } };
const bin = typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.echolet;
const entry = resolve(packageDir, bin ?? "dist/cli.js");
const paths: string[] = [];
type ProcessResult = { code: number | null; stdout: string; stderr: string };

function child(executable: string, args: string[], environment: Record<string, string | undefined> = {}, stdin = "", cwd = packageDir): Promise<ProcessResult> {
  return new Promise((resolveResult, reject) => {
    const processChild = spawn(executable, args, { cwd, env: { ...process.env, ...environment }, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    const timeout = setTimeout(() => { processChild.kill("SIGKILL"); reject(new Error("CLI child timed out")); }, CLI_CHILD_TIMEOUT_MS);
    processChild.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    processChild.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    processChild.on("error", (error) => { clearTimeout(timeout); reject(error); });
    processChild.on("close", (code) => { clearTimeout(timeout); resolveResult({ code, stdout, stderr }); });
    processChild.stdin.on("error", () => { /* Entrypoint may reject before reading stdin. */ });
    processChild.stdin.end(stdin);
  });
}

beforeAll(() => { expect(existsSync(entry)).toBe(true); });
afterEach(async () => {
  for (const path of paths.splice(0)) rmSync(path, { recursive: true, force: true });
});

function fixture() {
  const profileDir = mkdtempSync(join(tmpdir(), "echolet-cli-doctorcontacts-")); paths.push(profileDir);
  return { profileDir, environment: { ECHOLET_TEST_KEY: randomBytes(32).toString("base64url") } };
}
type Fixture = ReturnType<typeof fixture>;
const run = (owner: Fixture, args: string[], stdin = "", environment = owner.environment) =>
  child(process.execPath, [entry, ...args, "--profile", owner.profileDir, "--json"], environment, stdin);

function json(result: ProcessResult, code = 0): Record<string, unknown> {
  expect(result.code, `stdout=${result.stdout} stderr=${result.stderr}`).toBe(code);
  const value: unknown = JSON.parse(result.stdout);
  expect(value).not.toBeNull(); expect(Array.isArray(value)).toBe(false); expect(typeof value).toBe("object");
  const object = value as Record<string, unknown>;
  expect(object.ok).toBe(code === 0);
  if (code !== 0) expect(object.error).toMatchObject({ code: expect.any(String) });
  return object;
}

async function init(owner: Fixture, relayUrl = "http://127.0.0.1:1") {
  return json(await run(owner, ["init", "--relay-url", relayUrl, "--store-key-env", "ECHOLET_TEST_KEY"]));
}
async function exportCard(owner: Fixture) {
  const path = join(owner.profileDir, "contact.json");
  json(await run(owner, ["contact", "export", "--out", path]));
  return { path, card: JSON.parse(readFileSync(path, "utf8")) as ContactCard };
}
function redacted(result: ProcessResult, owner: Fixture) {
  const output = result.stdout + result.stderr;
  expect(output.includes(owner.environment.ECHOLET_TEST_KEY)).toBe(false);
  expect(/identitySecretKey|deviceSecretKey|sessionSecretKey|"seed"|ciphertext/.test(output)).toBe(false);
}

describe("doctor enumerates the profile's pinned correspondents", () => {
  it("reports a complete, empty contact list on a fresh profile — contact_count equal to the array's length", async () => {
    const owner = fixture();
    await init(owner);
    const raw = await run(owner, ["doctor"]);
    const doctor = json(raw);
    const data = doctor.data as { contact_count?: unknown; contacts?: unknown };
    expect(
      Array.isArray(data.contacts),
      `doctor's data was ${JSON.stringify(data)} — today it reports contact_count alone, never the contacts behind it`,
    ).toBe(true);
    expect(data.contacts).toEqual([]);
    expect(data.contact_count).toBe((data.contacts as unknown[]).length);
    redacted(raw, owner);
  }, CLI_TEST_TIMEOUT_MS);

  it(
    "lists every pinned contact's four identifiers, in Profile.listContacts() order, with contact_count " +
      "exactly equal to the array's length",
    async () => {
      const owner = fixture(), bob = fixture(), carol = fixture();
      await init(owner); await init(bob); await init(carol);
      const bobCard = await exportCard(bob), carolCard = await exportCard(carol);
      json(await run(owner, ["contact", "import", "--from", bobCard.path, "--yes"]));
      json(await run(owner, ["contact", "import", "--from", carolCard.path, "--yes"]));

      // Ground truth: the same store `doctor` must read from, read directly. This test does not
      // invent an expected shape independent of the store — it compares doctor's report against
      // Profile.listContacts()'s own output, which is the only thing "pinned" can mean here.
      const profile = await openProfile({ profileDir: owner.profileDir, environment: owner.environment });
      let groundTruth: ContactIdentifiers[];
      try { groundTruth = await profile.listContacts(); } finally { await profile.close(); }
      expect(groundTruth).toHaveLength(2);

      const raw = await run(owner, ["doctor"]);
      const doctor = json(raw);
      const data = doctor.data as { contact_count?: unknown; contacts?: unknown };
      // "Trust state" (this dispatch's task description): the CLI has no separate trust boolean or
      // enum to report. `ContactIdentifiers` (contactSchema, profile.ts:79-82) carries only the four
      // comparison fields, and the referenced design's P-2 (§6) specifies `contacts:
      // ContactIdentifiers[]` verbatim — nothing added. So "trust state" is expressed by MEMBERSHIP
      // in this array: an entry here is, by construction, a row this profile's encrypted store
      // actually pinned (`cli:contact:<identity_id>`, profile.ts:435/449); there is no other trust
      // value the CLI can produce. This is a judgment call this test makes explicit rather than
      // inventing a field the design does not have.
      expect(
        Array.isArray(data.contacts),
        `doctor's data was ${JSON.stringify(data)} — today it reports contact_count alone`,
      ).toBe(true);
      expect(data.contacts).toEqual(groundTruth);
      for (const contact of data.contacts as Record<string, unknown>[]) {
        expect(Object.keys(contact).sort()).toEqual(["device_id", "device_pubkey", "identity_id", "signal_identity_key"]);
      }
      expect(data.contact_count).toBe((data.contacts as unknown[]).length);
      expect(data.contact_count).toBe(2);
      redacted(raw, owner);
    },
    CLI_TEST_TIMEOUT_MS,
  );

  it("stays offline and leaks no key material while enumerating pinned contacts", async () => {
    // init() defaults to an unreachable relay (http://127.0.0.1:1 — nothing listens there). If
    // `doctor` ever tried to reach the relay to build the contacts array it would fail (connection
    // refused) rather than succeed, so a clean exit 0 that ALSO carries the contacts array is itself
    // the proof of no network access. (`cli.test.ts`'s existing "keeps doctor/history offline" test
    // already established this for contact_count alone; re-asserted here so the new `contacts` field
    // is proven not to have been implemented as a relay-side contact directory lookup.)
    const owner = fixture(); await init(owner);
    const bob = fixture(); await init(bob);
    const card = await exportCard(bob);
    json(await run(owner, ["contact", "import", "--from", card.path, "--yes"]));
    const raw = await run(owner, ["doctor"]);
    const doctor = json(raw);
    const data = doctor.data as { contacts?: unknown };
    expect(
      Array.isArray(data.contacts),
      `doctor's data was ${JSON.stringify(data)}`,
    ).toBe(true);
    expect((data.contacts as unknown[])).toHaveLength(1);
    redacted(raw, owner);
  }, CLI_TEST_TIMEOUT_MS);
});
