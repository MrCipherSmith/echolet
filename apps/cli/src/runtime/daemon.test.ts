import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  startDaemon,
  stopDaemon,
  getDaemonStatus,
  getPidPath,
  getLogPath,
} from "./daemon.js";
import { getRunDir, getLogsDir } from "./globalPaths.js";

describe("daemon runtime", () => {
  let tempDir: string;
  const originalEnvEcholetHome = process.env.ECHOLET_HOME;
  const spawnedPids: number[] = [];

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "echolet-daemon-test-"));
    process.env.ECHOLET_HOME = tempDir;
  });

  afterEach(() => {
    for (const pid of spawnedPids) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {}
    }
    spawnedPids.length = 0;

    if (originalEnvEcholetHome !== undefined) {
      process.env.ECHOLET_HOME = originalEnvEcholetHome;
    } else {
      delete process.env.ECHOLET_HOME;
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("getPidPath and getLogPath return expected paths", () => {
    expect(getPidPath("test-service")).toBe(path.join(getRunDir(), "test-service.pid"));
    expect(getLogPath("test-service")).toBe(path.join(getLogsDir(), "test-service.log"));
  });

  it("startDaemon spawns process, creates log file and writes pid file", () => {
    const daemonName = "test-sleeper";
    const res = startDaemon(daemonName, process.execPath, [
      "-e",
      "console.log('daemon-started'); setTimeout(() => {}, 10000);",
    ]);

    expect(res.pid).toBeTypeOf("number");
    expect(res.pid).toBeGreaterThan(0);
    spawnedPids.push(res.pid);

    const expectedLogPath = path.join(getLogsDir(), `${daemonName}.log`);
    expect(res.logPath).toBe(expectedLogPath);
    expect(fs.existsSync(expectedLogPath)).toBe(true);

    const pidPath = path.join(getRunDir(), `${daemonName}.pid`);
    expect(fs.existsSync(pidPath)).toBe(true);
    expect(fs.readFileSync(pidPath, "utf8").trim()).toBe(res.pid.toString());
  });

  it("getDaemonStatus reports running true for active process and false when no pid file", () => {
    const daemonName = "status-test";
    const statusBefore = getDaemonStatus(daemonName);
    expect(statusBefore.running).toBe(false);
    expect(statusBefore.pid).toBeUndefined();
    expect(statusBefore.logPath).toBe(path.join(getLogsDir(), `${daemonName}.log`));

    const started = startDaemon(daemonName, process.execPath, [
      "-e",
      "setTimeout(() => {}, 10000);",
    ]);
    spawnedPids.push(started.pid);

    const statusRunning = getDaemonStatus(daemonName);
    expect(statusRunning.running).toBe(true);
    expect(statusRunning.pid).toBe(started.pid);
  });

  it("getDaemonStatus cleans up stale PID file when process is no longer running", () => {
    const daemonName = "stale-test";
    const pidPath = path.join(getRunDir(), `${daemonName}.pid`);
    fs.mkdirSync(getRunDir(), { recursive: true, mode: 0o700 });
    // Write a PID that is definitely not running
    fs.writeFileSync(pidPath, "999999", "utf8");

    const status = getDaemonStatus(daemonName);
    expect(status.running).toBe(false);
    expect(fs.existsSync(pidPath)).toBe(false);
  });

  it("stopDaemon stops running process and removes PID file", () => {
    const daemonName = "stop-test";
    const started = startDaemon(daemonName, process.execPath, [
      "-e",
      "setTimeout(() => {}, 10000);",
    ]);
    spawnedPids.push(started.pid);

    const pidPath = path.join(getRunDir(), `${daemonName}.pid`);
    expect(fs.existsSync(pidPath)).toBe(true);

    const stopRes = stopDaemon(daemonName);
    expect(stopRes.success).toBe(true);
    expect(stopRes.pid).toBe(started.pid);
    expect(fs.existsSync(pidPath)).toBe(false);

    const statusAfter = getDaemonStatus(daemonName);
    expect(statusAfter.running).toBe(false);
  });

  it("stopDaemon returns failure when daemon is not running or pid file is missing/empty", () => {
    const stopMissing = stopDaemon("nonexistent");
    expect(stopMissing.success).toBe(false);
    expect(stopMissing.error).toBe("Daemon is not running");

    // Test with empty PID file
    const pidPath = path.join(getRunDir(), "empty.pid");
    fs.mkdirSync(getRunDir(), { recursive: true, mode: 0o700 });
    fs.writeFileSync(pidPath, "");

    const stopEmpty = stopDaemon("empty");
    expect(stopEmpty.success).toBe(false);
    expect(stopEmpty.error).toBe("Daemon is not running");
  });
});
