import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readStationProfileConfig } from "./station";

const temporaryPaths: string[] = [];

afterEach(() => {
  for (const path of temporaryPaths.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("station web launch profile config", () => {
  it("reads the relay origin and custom store-key environment from the selected profile", () => {
    const profileDir = mkdtempSync(join(tmpdir(), "echolet-station-profile-"));
    temporaryPaths.push(profileDir);
    writeFileSync(join(profileDir, "config.json"), JSON.stringify({
      profile_version: 1,
      profile_id: randomUUID(),
      relay_url: "https://relay.example",
      database_path: "client.sqlite",
      store_key_env: "ECHOLET_CUSTOM_PROFILE_KEY",
      request_timeout_ms: 4_000,
      poll_batch_size: 20,
    }));

    expect(readStationProfileConfig(profileDir)).toMatchObject({
      relay_url: "https://relay.example",
      store_key_env: "ECHOLET_CUSTOM_PROFILE_KEY",
    });
  });
});
