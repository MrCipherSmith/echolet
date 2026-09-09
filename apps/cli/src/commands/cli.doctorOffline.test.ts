import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ContactCard } from "../runtime/profile";
import { CLI_CHILD_TIMEOUT_MS, CLI_TEST_TIMEOUT_MS } from "../../test/childProcessTimeouts";

// Flow 004, T8 — replacing an UNSOUND PROOF, not a wrong behaviour (verification 004-T7, F-003).
//
// `cli.doctorContacts.test.ts:138-158` and `cli.test.ts`'s "keeps doctor/history offline" both argue
// the offline property by INFERENCE: the profile points at an unreachable relay
// (`http://127.0.0.1:1`), so "a clean exit 0 is itself the proof of no network access". That only
// follows if a relay request would be FATAL. A best-effort, swallowed or fire-and-forget request is
// invisible to it. The verifier inserted
//
//     await fetch(new URL("/v2/prekeys/claim", config.relay_url).toString()).catch(() => undefined);
//
// into `doctor` and all seven files under `src/commands/` passed. The shipped code IS offline
// (`Profile.diagnostics()` reads only the store); it was the proof that did not hold.
//
// This file proves the negative directly instead, with the same causal-barrier discipline
// `main.processDriven.test.ts` uses for "no second child was spawned". The profile is configured
// against a relay URL that a REAL, LISTENING server owns, and that server records every request it
// receives. A swallowed request is still a request: it is recorded, and the assertion fails.
//
// The recorder is proven to work IN THIS TEST, by a positive control (`poll`, which must reach the
// relay) run against the same server before the assertion — so "recorded nothing" is a fact about
// `doctor` and not about a recorder that was never wired up. No dependency is added: `node:http` is
// what the round-trip test in `cli.sendStdin.test.ts` already uses for its mock relay.
//
// SCOPE, stated rather than implied: this proves no request reached the CONFIGURED RELAY. It does
// not prove the process opened no socket to anywhere else; a request to some other host would need
// an outbound-network sandbox this package does not have. That is the honest boundary of the claim,
// and it is the boundary the property itself is written on ("doctor makes no relay request").
//
// Every timeout comes from apps/cli/test/childProcessTimeouts.ts, never a new literal.

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const manifest = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8")) as { bin?: string | { echolet?: string } };
const bin = typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.echolet;
const entry = resolve(packageDir, bin ?? "dist/cli.js");
const paths: string[] = [], servers: Server[] = [];
type ProcessResult = { code: number | null; stdout: string; stderr: string };

function child(args: string[], environment: Record<string, string | undefined>, stdin = ""): Promise<ProcessResult> {
  return new Promise((resolveResult, reject) => {
    const processChild = spawn(process.execPath, [entry, ...args], {
      cwd: packageDir,
      env: { ...process.env, ...environment },
      stdio: ["pipe", "pipe", "pipe"],
    });
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
  for (const server of servers.splice(0)) await new Promise<void>((done, reject) => {
    server.closeAllConnections(); server.close((error) => error ? reject(error) : done());
  });
  for (const path of paths.splice(0)) rmSync(path, { recursive: true, force: true });
});

function fixture() {
  const profileDir = mkdtempSync(join(tmpdir(), "echolet-cli-doctoroffline-")); paths.push(profileDir);
  return { profileDir, environment: { ECHOLET_TEST_KEY: randomBytes(32).toString("base64url") } };
}
type Fixture = ReturnType<typeof fixture>;
const run = (owner: Fixture, args: string[]) =>
  child([...args, "--profile", owner.profileDir, "--json"], owner.environment);

function json(result: ProcessResult, code = 0): Record<string, unknown> {
  expect(result.code, `stdout=${result.stdout} stderr=${result.stderr}`).toBe(code);
  const value = JSON.parse(result.stdout) as Record<string, unknown>;
  expect(value.ok).toBe(code === 0);
  return value;
}

describe("doctor issues no relay request, proven by a relay that records what it receives", () => {
  it(
    "records a request from a command that must make one (poll), and records nothing at all from " +
      "doctor or history",
    async () => {
      const seen: string[] = [];
      // Answers everything with a retryable refusal, so a command that DOES reach the relay fails
      // fast and cleanly instead of hanging. What matters is the recording, not the answer.
      const relay = createServer((request, reply) => {
        seen.push(`${request.method ?? "?"} ${request.url ?? "?"}`);
        request.resume();
        reply.statusCode = 503;
        reply.setHeader("content-type", "application/json");
        reply.end(JSON.stringify({ ok: false, error: { code: "RELAY_UNAVAILABLE" } }));
      });
      servers.push(relay);
      await new Promise<void>((done) => relay.listen(0, "127.0.0.1", done));
      const address = relay.address();
      if (address === null || typeof address === "string") throw new Error("Missing test relay address");
      const relayUrl = `http://127.0.0.1:${String(address.port)}`;

      const owner = fixture(), bob = fixture();
      json(await run(owner, ["init", "--relay-url", relayUrl, "--store-key-env", "ECHOLET_TEST_KEY"]));
      json(await run(bob, ["init", "--relay-url", relayUrl, "--store-key-env", "ECHOLET_TEST_KEY"]));
      const cardPath = join(bob.profileDir, "contact.json");
      json(await run(bob, ["contact", "export", "--out", cardPath]));
      const card = JSON.parse(readFileSync(cardPath, "utf8")) as ContactCard;
      json(await run(owner, ["contact", "import", "--from", cardPath, "--yes"]));

      // POSITIVE CONTROL. `poll` fetches from the mailbox, so it must reach this relay. If it does
      // not, the recorder is not observing this CLI's traffic and every "recorded nothing" assertion
      // below would be worthless.
      seen.length = 0;
      await run(owner, ["poll"]);
      expect(
        seen.length,
        "the recording relay saw no request from `poll`, so it cannot witness one from `doctor` either — the instrument, not the property, failed",
      ).toBeGreaterThan(0);

      // THE PROPERTY. Any request `doctor` makes to the configured relay — including one whose
      // failure is swallowed — lands in `seen`.
      seen.length = 0;
      const doctor = json(await run(owner, ["doctor"]));
      expect((doctor.data as { contact_count?: unknown }).contact_count).toBe(1);
      expect(seen, "doctor reached the relay").toEqual([]);

      // The same claim `cli.test.ts` makes for `history`, on the same instrument.
      seen.length = 0;
      json(await run(owner, ["history", "--with", card.signal_bundle.device_record.identity_id]));
      expect(seen, "history reached the relay").toEqual([]);
    },
    CLI_TEST_TIMEOUT_MS,
  );
});
