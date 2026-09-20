import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CliBridge } from "./cliBridge";

const temporaryPaths: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("CliBridge process boundary", () => {
  it("passes the configured profile environment without exposing the key in argv", async () => {
    const dir = await mkdtemp(join(tmpdir(), "echolet-web-bridge-"));
    temporaryPaths.push(dir);
    const cliPath = join(dir, "fake-cli.mjs");
    await writeFile(cliPath, `
      const present = process.env.SYNTHETIC_STORE_KEY === "safe-test-value";
      process.stdout.write(JSON.stringify({ ok: true, data: { present, argv: process.argv.slice(2) } }));
    `);
    const bridge = new CliBridge({
      cliPath,
      profileDir: dir,
      storeKeyEnv: "SYNTHETIC_STORE_KEY",
      relayUrl: "http://127.0.0.1:1",
      environment: { ...process.env, SYNTHETIC_STORE_KEY: "safe-test-value" },
    });

    const result = await bridge.doctor();

    expect(result).toMatchObject({ ok: true, data: { present: true } });
    expect(JSON.stringify(result.data)).not.toContain("safe-test-value");
  });

  it("terminates a stuck CLI process and reports an explicit timeout", async () => {
    const dir = await mkdtemp(join(tmpdir(), "echolet-web-bridge-timeout-"));
    temporaryPaths.push(dir);
    const cliPath = join(dir, "fake-cli.mjs");
    await writeFile(cliPath, "setInterval(() => {}, 1000);");
    const bridge = new CliBridge({
      cliPath,
      profileDir: dir,
      storeKeyEnv: "SYNTHETIC_STORE_KEY",
      relayUrl: "http://127.0.0.1:1",
      commandTimeoutMs: 40,
    });

    await expect(bridge.doctor()).resolves.toMatchObject({
      ok: false,
      code: "CLI_TIMEOUT",
      exitCode: 1,
    });
  });
});
