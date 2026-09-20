import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { CliBridge, type CliOutcome } from "./cliBridge";
import { parseContactCard } from "../client/contactCard";
import {
  exportContactCard,
  importContactCardJson,
  parseContactCardJson,
  validateContactCardJson,
  type ContactCardBridge,
} from "./contactCards";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI_PATH = resolve(HERE, "../../../cli/dist/cli.js");
const temporaryPaths: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function runCli(args: string[], environment: NodeJS.ProcessEnv): Promise<number | null> {
  return new Promise((done, reject) => {
    const child = spawn(process.execPath, [CLI_PATH, ...args], {
      env: environment,
      stdio: ["ignore", "ignore", "ignore"],
    });
    const timeout = setTimeout(() => child.kill("SIGKILL"), 20_000);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      done(code);
    });
  });
}

describe("contact-card temporary files", () => {
  it("exports twice through the real CLI without reusing an exclusive output path", async () => {
    const profileDir = await mkdtemp(join(tmpdir(), "echolet-web-profile-"));
    const tempRoot = await mkdtemp(join(tmpdir(), "echolet-web-export-root-"));
    temporaryPaths.push(profileDir, tempRoot);
    const environment = {
      ...process.env,
      ECHOLET_WEB_TEST_KEY: randomBytes(32).toString("base64url"),
    };

    expect(await runCli([
      "init",
      "--profile",
      profileDir,
      "--relay-url",
      "http://127.0.0.1:1",
      "--store-key-env",
      "ECHOLET_WEB_TEST_KEY",
      "--json",
    ], environment)).toBe(0);

    const cli = new CliBridge({
      cliPath: CLI_PATH,
      profileDir,
      storeKeyEnv: "ECHOLET_WEB_TEST_KEY",
      relayUrl: "http://127.0.0.1:1",
      environment,
    });
    const exportPaths: string[] = [];
    const bridge: ContactCardBridge = {
      exportContact: async (outPath) => {
        exportPaths.push(outPath);
        return cli.exportContact(outPath);
      },
      importContact: (cardPath) => cli.importContact(cardPath),
      validateContact: (cardPath) => cli.validateContact(cardPath),
    };

    const first = await exportContactCard(bridge, tempRoot);
    const second = await exportContactCard(bridge, tempRoot);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(exportPaths).toHaveLength(2);
    expect(exportPaths[0]).not.toBe(exportPaths[1]);
    expect(exportPaths.every((path) => !existsSync(path))).toBe(true);
    if (first.ok && second.ok) {
      expect(first.data.preview.identityId).toBe(second.data.preview.identityId);
      expect(parseContactCard(JSON.stringify(first.data.card))).toMatchObject({
        ok: true,
        preview: { identityId: first.data.preview.identityId },
      });
      expect(parseContactCard(JSON.stringify(second.data.card)).ok).toBe(true);
      const before = await cli.doctor();
      const validation = await validateContactCardJson(bridge, first.data.card, tempRoot);
      const forged = structuredClone(first.data.card);
      const bundle = forged.signal_bundle as Record<string, unknown>;
      bundle.signature = Buffer.alloc(64).toString("base64url");
      const rejected = await validateContactCardJson(bridge, forged, tempRoot);
      const after = await cli.doctor();
      expect(validation.ok).toBe(true);
      expect(rejected).toMatchObject({ ok: false, code: "INVALID_CONTACT_CARD" });
      expect(before.data?.contact_count).toBe(0);
      expect(after.data?.contact_count).toBe(0);
    }
  }, 30_000);

  it("uses a private per-request import file and always removes it", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "echolet-web-import-root-"));
    temporaryPaths.push(tempRoot);
    let observedPath = "";
    let observedJson = "";
    const bridge: ContactCardBridge = {
      exportContact: async () => ({ ok: false, code: "UNUSED", exitCode: 1, data: null }),
      importContact: async (cardPath) => {
        observedPath = cardPath;
        observedJson = await readFile(cardPath, "utf8");
        return { ok: true, code: "ok", exitCode: 0, data: { trusted: true } };
      },
      validateContact: async () => ({ ok: false, code: "TRUST_FAILURE", exitCode: 3, data: { error: { detail: "CONTACT_NOT_CONFIRMED" } } }),
    };
    const card = {
      type: "echolet_contact_card",
      version: 1,
      signal_bundle: {
        device_record: { identity_id: "identity", device_id: "device" },
      },
    };

    const result = await importContactCardJson(bridge, card, tempRoot);

    expect(result.ok).toBe(true);
    expect(JSON.parse(observedJson)).toEqual(card);
    expect(existsSync(observedPath)).toBe(false);
  });

  it("rejects malformed cards before invoking the CLI", async () => {
    let imported = false;
    const bridge: ContactCardBridge = {
      exportContact: async (): Promise<CliOutcome> => ({ ok: false, code: "UNUSED", exitCode: 1, data: null }),
      importContact: async () => {
        imported = true;
        return { ok: true, code: "ok", exitCode: 0, data: {} };
      },
      validateContact: async () => ({ ok: false, code: "UNUSED", exitCode: 1, data: null }),
    };

    expect(parseContactCardJson({ signal_bundle: {} })).toEqual({
      ok: false,
      code: "INVALID_CONTACT_CARD",
      message: "Contact card is missing public identity fields",
    });
    const result = await importContactCardJson(bridge, { signal_bundle: {} });
    expect(result).toMatchObject({ ok: false, code: "INVALID_CONTACT_CARD" });
    expect(imported).toBe(false);
  });
});
