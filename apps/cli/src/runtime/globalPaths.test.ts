import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  getEcholetHome,
  ensureEcholetDirs,
  ensureGlobalDirs,
  getProfilesDir,
  getProfileDir,
  getStoreKeyPath,
  getClientDbPath,
  getCardPath,
  getProfileConfigPath,
  getActiveProfile,
  setActiveProfile,
  listProfiles,
  getRunDir,
  getLogsDir,
  getRepeaterDir,
  getRepeaterEnvPath,
  getRepeaterDbPath,
  ensureKeyPermissions,
  getGlobalConfig,
  saveGlobalConfig,
  getProfileKey,
} from "./globalPaths";

describe("globalPaths", () => {
  let tempDir: string;
  const originalEnvEcholetHome = process.env.ECHOLET_HOME;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "echolet-test-home-"));
    process.env.ECHOLET_HOME = tempDir;
  });

  afterEach(() => {
    if (originalEnvEcholetHome !== undefined) {
      process.env.ECHOLET_HOME = originalEnvEcholetHome;
    } else {
      delete process.env.ECHOLET_HOME;
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("getEcholetHome returns ECHOLET_HOME when set, otherwise falls back to homedir", () => {
    expect(getEcholetHome()).toBe(tempDir);

    delete process.env.ECHOLET_HOME;
    expect(getEcholetHome()).toBe(path.join(os.homedir(), ".echolet"));
  });

  it("path getters return expected subpaths under home", () => {
    const callsign = "R0ABC";

    expect(getProfilesDir()).toBe(path.join(tempDir, "profiles"));
    expect(getProfileDir(callsign)).toBe(path.join(tempDir, "profiles", callsign));
    expect(getStoreKeyPath(callsign)).toBe(path.join(tempDir, "profiles", callsign, "store.key"));
    expect(getClientDbPath(callsign)).toBe(path.join(tempDir, "profiles", callsign, "client.sqlite"));
    expect(getCardPath(callsign)).toBe(path.join(tempDir, "profiles", callsign, "identity.card.json"));
    expect(getProfileConfigPath(callsign)).toBe(path.join(tempDir, "profiles", callsign, "config.json"));
    expect(getRunDir()).toBe(path.join(tempDir, "run"));
    expect(getLogsDir()).toBe(path.join(tempDir, "logs"));
    expect(getRepeaterDir()).toBe(path.join(tempDir, "repeater"));
    expect(getRepeaterEnvPath()).toBe(path.join(tempDir, "repeater", "config.env"));
    expect(getRepeaterDbPath()).toBe(path.join(tempDir, "repeater", "data"));
  });

  it("ensureEcholetDirs creates all required directories with mode 0o700", () => {
    // Remove tempDir to ensure ensureEcholetDirs creates home as well
    fs.rmSync(tempDir, { recursive: true, force: true });

    ensureEcholetDirs();

    const expectedDirs = [
      tempDir,
      path.join(tempDir, "profiles"),
      path.join(tempDir, "repeater"),
      path.join(tempDir, "run"),
      path.join(tempDir, "logs"),
    ];

    for (const dir of expectedDirs) {
      expect(fs.existsSync(dir)).toBe(true);
      const stat = fs.statSync(dir);
      expect(stat.isDirectory()).toBe(true);
      // Verify mode mask on Unix-like systems (0o700)
      if (process.platform !== "win32") {
        expect(stat.mode & 0o777).toBe(0o700);
      }
    }
  });

  it("ensureGlobalDirs creates dirs and returns them for backward compatibility", () => {
    fs.rmSync(tempDir, { recursive: true, force: true });
    const dirs = ensureGlobalDirs();

    expect(dirs.home).toBe(tempDir);
    expect(dirs.profiles).toBe(path.join(tempDir, "profiles"));
    expect(dirs.run).toBe(path.join(tempDir, "run"));
    expect(dirs.logs).toBe(path.join(tempDir, "logs"));
    expect(dirs.repeater).toBe(path.join(tempDir, "repeater"));
    expect(fs.existsSync(dirs.run)).toBe(true);
  });

  it("ensureKeyPermissions sets file permissions to 0o600", () => {
    const testFile = path.join(tempDir, "test.key");
    fs.writeFileSync(testFile, "secret-key", { mode: 0o644 });

    ensureKeyPermissions(testFile);

    if (process.platform !== "win32") {
      const stat = fs.statSync(testFile);
      expect(stat.mode & 0o777).toBe(0o600);
    }
  });

  it("getActiveProfile and setActiveProfile manage activeProfile in ~/.echolet/config.json", () => {
    expect(getActiveProfile()).toBeNull();

    setActiveProfile("ALPHA");
    expect(getActiveProfile()).toBe("ALPHA");

    const configPath = path.join(tempDir, "config.json");
    expect(fs.existsSync(configPath)).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(configPath, "utf8"));
    expect(parsed.activeProfile).toBe("ALPHA");
    if (process.platform !== "win32") {
      expect(fs.statSync(configPath).mode & 0o777).toBe(0o600);
    }

    // Updating profile preserves existing properties
    parsed.customField = "preserved";
    fs.writeFileSync(configPath, JSON.stringify(parsed, null, 2), { mode: 0o600 });

    setActiveProfile("BRAVO");
    expect(getActiveProfile()).toBe("BRAVO");
    const updated = JSON.parse(fs.readFileSync(configPath, "utf8"));
    expect(updated.activeProfile).toBe("BRAVO");
    expect(updated.customField).toBe("preserved");
  });

  it("listProfiles lists all profile directories and ignores regular files", () => {
    expect(listProfiles()).toEqual([]);

    ensureEcholetDirs();
    expect(listProfiles()).toEqual([]);

    const profilesDir = getProfilesDir();
    fs.mkdirSync(path.join(profilesDir, "CALLSIGN1"));
    fs.mkdirSync(path.join(profilesDir, "CALLSIGN2"));
    fs.writeFileSync(path.join(profilesDir, "not-a-dir.txt"), "hello");

    const profiles = listProfiles();
    expect(profiles.sort()).toEqual(["CALLSIGN1", "CALLSIGN2"]);
  });

  it("getGlobalConfig and saveGlobalConfig work with defaults", () => {
    const config = getGlobalConfig();
    expect(config.defaultPort).toBe(3001);
    expect(config.defaultRelayUrl).toContain("depr.tail5a88fb.ts.net");

    config.defaultPort = 4000;
    saveGlobalConfig(config);

    const reloaded = getGlobalConfig();
    expect(reloaded.defaultPort).toBe(4000);
  });

  it("getProfileKey creates and retrieves random base64url key", () => {
    const key1 = getProfileKey("TESTCALL");
    expect(typeof key1).toBe("string");
    expect(key1.length).toBeGreaterThan(20);

    const key2 = getProfileKey("TESTCALL");
    expect(key2).toBe(key1);

    const keyPath = getStoreKeyPath("TESTCALL");
    expect(fs.existsSync(keyPath)).toBe(true);
    if (process.platform !== "win32") {
      expect(fs.statSync(keyPath).mode & 0o777).toBe(0o600);
    }
  });
});
