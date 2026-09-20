import * as child_process from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { getRunDir, getLogsDir, ensureEcholetDirs } from "./globalPaths.js";

export interface DaemonMeta {
  pid: number;
  name: string;
  command: string;
  port?: number;
  profile?: string;
  startedAt: string;
}

export function getPidPath(name: string): string {
  return path.join(getRunDir(), `${name}.pid`);
}

export function getLogPath(name: string): string {
  return path.join(getLogsDir(), `${name}.log`);
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    return err?.code === "EPERM";
  }
}

/**
 * Starts a background daemon process.
 * 1. Calls ensureEcholetDirs().
 * 2. Resolves log file path: path.join(getLogsDir(), `${name}.log`).
 * 3. Opens log file with fs.openSync(logPath, 'a').
 * 4. Spawns process using child_process.spawn(cmd, args, { detached: true, stdio: ['ignore', outFd, outFd], env: { ...process.env, ...env } }).
 * 5. Verifies child.pid exists and writes child.pid.toString() to path.join(getRunDir(), `${name}.pid`).
 * 6. Calls child.unref() and closes outFd.
 * 7. Returns { pid: child.pid, logPath }.
 */
export function startDaemon(
  name: string,
  cmd: string,
  args: string[],
  env?: NodeJS.ProcessEnv
): { pid: number; logPath: string } {
  ensureEcholetDirs();

  const logPath = path.join(getLogsDir(), `${name}.log`);
  const outFd = fs.openSync(logPath, "a");

  let child: child_process.ChildProcess;
  try {
    child = child_process.spawn(cmd, args, {
      detached: true,
      stdio: ["ignore", outFd, outFd],
      env: { ...process.env, ...env },
    });
  } catch (err) {
    try {
      fs.closeSync(outFd);
    } catch {}
    throw err;
  }

  if (!child.pid) {
    try {
      fs.closeSync(outFd);
    } catch {}
    throw new Error(`Failed to start daemon process '${name}': child.pid is undefined`);
  }

  const pidFile = path.join(getRunDir(), `${name}.pid`);
  fs.writeFileSync(pidFile, child.pid.toString(), "utf8");

  child.unref();
  try {
    fs.closeSync(outFd);
  } catch {}

  return { pid: child.pid, logPath };
}

/**
 * Stops a running daemon process.
 * 1. Reads PID file from path.join(getRunDir(), `${name}.pid`). If not found or empty, returns { success: false, error: 'Daemon is not running' }.
 * 2. Parses pid number.
 * 3. If process.platform === 'win32', executes child_process.execSync(`taskkill /pid ${pid} /T /F`).
 *    Else tries process.kill(pid, 'SIGTERM').
 * 4. Deletes PID file via fs.unlinkSync.
 * 5. Returns { success: true, pid }.
 */
export function stopDaemon(name: string): {
  success: boolean;
  pid?: number;
  error?: string;
  ok?: boolean;
  message?: string;
} {
  const pidFile = path.join(getRunDir(), `${name}.pid`);

  if (!fs.existsSync(pidFile)) {
    return {
      success: false,
      error: "Daemon is not running",
      ok: false,
      message: "Daemon is not running",
    };
  }

  let raw = "";
  try {
    raw = fs.readFileSync(pidFile, "utf8").trim();
  } catch {
    return {
      success: false,
      error: "Daemon is not running",
      ok: false,
      message: "Daemon is not running",
    };
  }

  if (!raw) {
    return {
      success: false,
      error: "Daemon is not running",
      ok: false,
      message: "Daemon is not running",
    };
  }

  let pid = parseInt(raw, 10);
  if (isNaN(pid) && raw.startsWith("{")) {
    try {
      pid = parseInt(JSON.parse(raw).pid, 10);
    } catch {}
  }

  if (isNaN(pid)) {
    return {
      success: false,
      error: "Daemon is not running",
      ok: false,
      message: "Daemon is not running",
    };
  }

  if (process.platform === "win32") {
    try {
      child_process.execSync(`taskkill /pid ${pid} /T /F`, { stdio: "ignore" });
    } catch {
      // Process may already be stopped
    }
  } else {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // Process may already be stopped or ESRCH
    }
  }

  try {
    fs.unlinkSync(pidFile);
  } catch {}

  return {
    success: true,
    pid,
    ok: true,
    message: `Daemon ${name} (PID ${pid}) stopped.`,
  };
}

/**
 * Gets the current status of a daemon process.
 * 1. Log file path is path.join(getLogsDir(), `${name}.log`).
 * 2. PID file path is path.join(getRunDir(), `${name}.pid`).
 * 3. If PID file doesn't exist, returns { running: false, logPath }.
 * 4. Reads pid and checks if process is alive:
 *    try {
 *      process.kill(pid, 0);
 *      return { running: true, pid, logPath };
 *    } catch (e) {
 *      // Stale PID file
 *      try { fs.unlinkSync(pidFile); } catch {}
 *      return { running: false, logPath };
 *    }
 */
export function getDaemonStatus(name: string): {
  running: boolean;
  pid?: number;
  logPath: string;
  meta?: DaemonMeta | null;
} {
  const logPath = path.join(getLogsDir(), `${name}.log`);
  const pidFile = path.join(getRunDir(), `${name}.pid`);

  if (!fs.existsSync(pidFile)) {
    return { running: false, logPath, meta: null };
  }

  let raw = "";
  try {
    raw = fs.readFileSync(pidFile, "utf8").trim();
  } catch {
    return { running: false, logPath, meta: null };
  }

  if (!raw) {
    try {
      fs.unlinkSync(pidFile);
    } catch {}
    return { running: false, logPath, meta: null };
  }

  let pid = parseInt(raw, 10);
  let parsedMeta: Partial<DaemonMeta> | undefined;
  if (raw.startsWith("{")) {
    try {
      parsedMeta = JSON.parse(raw);
      if (parsedMeta && typeof parsedMeta.pid === "number") {
        pid = parsedMeta.pid;
      }
    } catch {}
  }

  if (isNaN(pid)) {
    try {
      fs.unlinkSync(pidFile);
    } catch {}
    return { running: false, logPath, meta: null };
  }

  const metaObj: DaemonMeta = {
    pid,
    name,
    command: parsedMeta?.command || "",
    port: parsedMeta?.port,
    profile: parsedMeta?.profile,
    startedAt: parsedMeta?.startedAt || "",
  };

  try {
    process.kill(pid, 0);
    return { running: true, pid, logPath, meta: metaObj };
  } catch (e: any) {
    if (e?.code === "EPERM") {
      return { running: true, pid, logPath, meta: metaObj };
    }
    // Stale PID file
    try {
      fs.unlinkSync(pidFile);
    } catch {}
    return { running: false, logPath, meta: null };
  }
}

/**
 * Backward compatibility wrapper for existing CLI operators (e.g. repeater).
 */
export function startDaemonProcess(options: {
  name: string;
  execPath: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  port?: number;
  profile?: string;
}): DaemonMeta {
  const result = startDaemon(options.name, options.execPath, options.args, options.env);
  return {
    pid: result.pid,
    name: options.name,
    command: `${options.execPath} ${options.args.join(" ")}`,
    port: options.port,
    profile: options.profile,
    startedAt: new Date().toISOString(),
  };
}
