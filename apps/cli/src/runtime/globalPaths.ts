import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomBytes } from "node:crypto";

export interface GlobalConfig {
  activeProfile?: string;
  defaultRelayUrl: string;
  defaultPort: number;
}

export const DEFAULT_RELAY_URL = "https://depr.tail5a88fb.ts.net:8443";
export const DEFAULT_PORT = 3001;

/**
 * Returns path to ~/.echolet (or process.env.ECHOLET_HOME if set).
 */
export function getEcholetHome(): string {
  return process.env.ECHOLET_HOME || path.join(os.homedir(), ".echolet");
}

/**
 * Returns path to ~/.echolet/profiles
 */
export function getProfilesDir(): string {
  return path.join(getEcholetHome(), "profiles");
}

/**
 * Returns path to ~/.echolet/profiles/<callsign>
 */
export function getProfileDir(callsign: string): string {
  return path.join(getProfilesDir(), callsign);
}

/**
 * Returns path to ~/.echolet/profiles/<callsign>/store.key
 */
export function getStoreKeyPath(callsign: string): string {
  return path.join(getProfileDir(callsign), "store.key");
}

/**
 * Returns path to ~/.echolet/profiles/<callsign>/client.sqlite
 */
export function getClientDbPath(callsign: string): string {
  return path.join(getProfileDir(callsign), "client.sqlite");
}

/**
 * Returns path to ~/.echolet/profiles/<callsign>/identity.card.json
 */
export function getCardPath(callsign: string): string {
  return path.join(getProfileDir(callsign), "identity.card.json");
}

/**
 * Returns path to ~/.echolet/profiles/<callsign>/config.json
 */
export function getProfileConfigPath(callsign: string): string {
  return path.join(getProfileDir(callsign), "config.json");
}

/**
 * Returns path to ~/.echolet/run
 */
export function getRunDir(): string {
  return path.join(getEcholetHome(), "run");
}

/**
 * Returns path to ~/.echolet/logs
 */
export function getLogsDir(): string {
  return path.join(getEcholetHome(), "logs");
}

/**
 * Returns path to ~/.echolet/repeater
 */
export function getRepeaterDir(): string {
  return path.join(getEcholetHome(), "repeater");
}

/**
 * Returns path to ~/.echolet/repeater/config.env
 */
export function getRepeaterEnvPath(): string {
  return path.join(getRepeaterDir(), "config.env");
}

/**
 * Returns path to ~/.echolet/repeater/data
 */
export function getRepeaterDbPath(): string {
  return path.join(getRepeaterDir(), "data");
}

/**
 * Sets file permissions to 0o600.
 */
export function ensureKeyPermissions(filePath: string): void {
  fs.chmodSync(filePath, 0o600);
}

/**
 * Ensures directories ~/.echolet/, profiles/, repeater/, run/, logs/ exist with permission 0o700.
 */
export function ensureEcholetDirs(): void {
  const dirs = [
    getEcholetHome(),
    getProfilesDir(),
    getRepeaterDir(),
    getRunDir(),
    getLogsDir(),
  ];

  for (const dir of dirs) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.chmodSync(dir, 0o700);
  }
}

/**
 * Ensures global directories and returns their paths (retained for backward compatibility).
 */
export function ensureGlobalDirs(): {
  home: string;
  profiles: string;
  run: string;
  logs: string;
  repeater: string;
} {
  ensureEcholetDirs();
  return {
    home: getEcholetHome(),
    profiles: getProfilesDir(),
    run: getRunDir(),
    logs: getLogsDir(),
    repeater: getRepeaterDir(),
  };
}

/**
 * Reads ~/.echolet/config.json and returns activeProfile callsign (or null if none).
 */
export function getActiveProfile(): string | null {
  const configPath = path.join(getEcholetHome(), "config.json");
  if (!fs.existsSync(configPath)) {
    return null;
  }
  try {
    const content = fs.readFileSync(configPath, "utf8");
    const parsed = JSON.parse(content);
    if (parsed && typeof parsed.activeProfile === "string" && parsed.activeProfile.trim().length > 0) {
      return parsed.activeProfile.trim();
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Writes activeProfile to ~/.echolet/config.json.
 */
export function setActiveProfile(callsign: string): void {
  ensureEcholetDirs();
  const configPath = path.join(getEcholetHome(), "config.json");
  let currentConfig: Record<string, unknown> = {};
  if (fs.existsSync(configPath)) {
    try {
      const content = fs.readFileSync(configPath, "utf8");
      const parsed = JSON.parse(content);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        currentConfig = parsed as Record<string, unknown>;
      }
    } catch {
      currentConfig = {};
    }
  } else {
    currentConfig = {
      defaultRelayUrl: DEFAULT_RELAY_URL,
      defaultPort: DEFAULT_PORT,
    };
  }
  currentConfig.activeProfile = callsign;
  fs.writeFileSync(configPath, JSON.stringify(currentConfig, null, 2), { mode: 0o600 });
  fs.chmodSync(configPath, 0o600);
}

/**
 * Returns string[] of all callsigns in ~/.echolet/profiles/ that are directories.
 */
export function listProfiles(): string[] {
  const profilesDir = getProfilesDir();
  if (!fs.existsSync(profilesDir)) {
    return [];
  }
  try {
    return fs
      .readdirSync(profilesDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

/**
 * Reads global configuration from ~/.echolet/config.json.
 */
export function getGlobalConfig(): GlobalConfig {
  ensureEcholetDirs();
  const configPath = path.join(getEcholetHome(), "config.json");
  if (!fs.existsSync(configPath)) {
    const initial: GlobalConfig = {
      defaultRelayUrl: DEFAULT_RELAY_URL,
      defaultPort: DEFAULT_PORT,
    };
    fs.writeFileSync(configPath, JSON.stringify(initial, null, 2), { mode: 0o600 });
    fs.chmodSync(configPath, 0o600);
    return initial;
  }
  try {
    return JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch {
    return { defaultRelayUrl: DEFAULT_RELAY_URL, defaultPort: DEFAULT_PORT };
  }
}

/**
 * Writes global configuration to ~/.echolet/config.json.
 */
export function saveGlobalConfig(config: GlobalConfig): void {
  ensureEcholetDirs();
  const configPath = path.join(getEcholetHome(), "config.json");
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), { mode: 0o600 });
  fs.chmodSync(configPath, 0o600);
}

/**
 * Retrieves or generates profile store key.
 */
export function getProfileKey(name: string): string {
  const dir = getProfileDir(name);
  const keyPath = getStoreKeyPath(name);
  if (fs.existsSync(keyPath)) {
    return fs.readFileSync(keyPath, "utf8").trim();
  }
  const key = randomBytes(32).toString("base64url");
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.chmodSync(dir, 0o700);
  }
  fs.writeFileSync(keyPath, key, { mode: 0o600 });
  ensureKeyPermissions(keyPath);
  return key;
}
