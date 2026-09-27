import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleRepeaterCommand } from "./repeater";
import { buildDockerRunArgs } from "./repeaterConfig";

// A stand-in `docker` on PATH that records every argv it receives, one call per
// line with arguments separated by NUL, so the test sees exactly what reached
// the process boundary - after any shell would have had its say.
const FAKE_DOCKER = `#!/bin/sh
{ for arg in "$@"; do printf '%s\\0' "$arg"; done; printf '\\n'; } >> "$FAKE_DOCKER_LOG"
case "$1" in
  images) echo "sha256-fake-image" ;;
  run) echo "0123456789abcdef-container" ;;
esac
`;

let workDir: string;
let savedEnv: NodeJS.ProcessEnv;

beforeEach(() => {
  savedEnv = { ...process.env };
  workDir = mkdtempSync(join(tmpdir(), "echolet-repeater-argv-"));
  const binDir = join(workDir, "bin");
  mkdirSync(binDir);
  writeFileSync(join(binDir, "docker"), FAKE_DOCKER);
  chmodSync(join(binDir, "docker"), 0o755);

  process.env.PATH = `${binDir}${delimiter}${process.env.PATH ?? ""}`;
  process.env.ECHOLET_HOME = join(workDir, "home");
  process.env.FAKE_DOCKER_LOG = join(workDir, "docker.log");
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  process.env = savedEnv;
  process.exitCode = undefined;
  vi.restoreAllMocks();
  rmSync(workDir, { recursive: true, force: true });
});

function writeRepeaterConfig(lines: string[]): void {
  const repeaterDir = join(workDir, "home", "repeater");
  mkdirSync(repeaterDir, { recursive: true });
  writeFileSync(join(repeaterDir, "config.env"), lines.join("\n") + "\n");
}

function dockerCalls(): string[][] {
  const log = join(workDir, "docker.log");
  if (!existsSync(log)) return [];
  return readFileSync(log, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => line.split("\0").filter((_, index, all) => index < all.length - 1));
}

describe("echolet repeater start --docker", () => {
  it("hands docker run the validated values as discrete arguments", async () => {
    writeRepeaterConfig(["ECHOLET_NODE_CALLSIGN=REPEATER-01", "ECHOLET_PORT=9000"]);

    await handleRepeaterCommand(["start", "--docker"]);

    const run = dockerCalls().find((call) => call[0] === "run");
    const dataDir = join(workDir, "home", "repeater", "data");
    expect(run).toEqual(buildDockerRunArgs({ callsign: "REPEATER-01", port: 9000 }, dataDir));
    expect(process.exitCode).toBeUndefined();
  });

  it("refuses a tampered callsign before docker is ever asked to run anything", async () => {
    const marker = join(workDir, "pwned");
    writeRepeaterConfig([`ECHOLET_NODE_CALLSIGN=X$(touch ${marker})`, "ECHOLET_PORT=9000"]);

    await handleRepeaterCommand(["start", "--docker"]);

    expect(dockerCalls().some((call) => call[0] === "run")).toBe(false);
    expect(existsSync(marker)).toBe(false);
    expect(process.exitCode).toBe(1);
  });

  it("refuses a tampered port that would smuggle a volume mount", async () => {
    writeRepeaterConfig(["ECHOLET_NODE_CALLSIGN=REPEATER-01", "ECHOLET_PORT=9000:8443 -v /:/host -p 9001"]);

    await handleRepeaterCommand(["start", "--docker"]);

    expect(dockerCalls().some((call) => call[0] === "run")).toBe(false);
    expect(process.exitCode).toBe(1);
  });
});
