import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Build the published CLI binary exactly once per vitest run, before any suite starts.
 *
 * `dist/cli.js` is spawned by both the command suite and the two-process E2E suite. When each of
 * those rebuilt it from its own `beforeAll`, one suite could observe a partially rewritten bundle
 * while the other was executing it, which surfaced as unrelated argument-parsing exits. Building
 * here keeps the binary immutable for the whole run; no suite may rebuild it.
 */
export default function setup(): Promise<void> {
  return new Promise((done, reject) => {
    const child = spawn(process.execPath, [resolve(packageDir, "build.mjs")], { cwd: packageDir, stdio: ["ignore", "inherit", "inherit"] });
    child.once("error", reject);
    child.once("close", (code) => { code === 0 ? done() : reject(new Error(`CLI build failed with exit code ${String(code)}`)); });
  });
}
