import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

export function resolveCliPath(overridePath?: string): string {
  if (overridePath && existsSync(overridePath)) {
    return overridePath;
  }
  if (process.env.ECHOLET_CLI_PATH && existsSync(process.env.ECHOLET_CLI_PATH)) {
    return process.env.ECHOLET_CLI_PATH;
  }
  const flattenedNpmPath = resolve(HERE, "./cli.js");
  if (existsSync(flattenedNpmPath)) {
    return flattenedNpmPath;
  }
  const siblingDistPath = resolve(HERE, "../cli/dist/cli.js");
  if (existsSync(siblingDistPath)) {
    return siblingDistPath;
  }
  return resolve(HERE, "../../cli/dist/cli.js");
}

export const DEFAULT_CLI_PATH = resolveCliPath();

export interface CliOutcome {
  readonly ok: boolean;
  readonly code: string;
  readonly exitCode: number;
  readonly data: any;
}

export interface CliBridgeOptions {
  cliPath: string;
  profileDir: string;
  storeKeyEnv: string;
  relayUrl: string;
  environment?: NodeJS.ProcessEnv;
  commandTimeoutMs?: number;
}

export class CliBridge {
  constructor(private options: CliBridgeOptions) {}

  private async execute(argv: string[], stdinInput?: string): Promise<CliOutcome> {
    return new Promise((res) => {
      const child = spawn(process.execPath, [this.options.cliPath, ...argv], {
        env: this.options.environment ?? process.env,
        stdio: ["pipe", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";
      let settled = false;
      const finish = (outcome: CliOutcome) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        res(outcome);
      };
      const timeout = setTimeout(() => {
        child.kill("SIGKILL");
        finish({
          ok: false,
          code: "CLI_TIMEOUT",
          exitCode: 1,
          data: { error: "CLI command timed out" },
        });
      }, this.options.commandTimeoutMs ?? 15_000);

      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });
      child.stdin.on("error", () => {
        // The CLI may reject before consuming stdin; its close outcome remains authoritative.
      });

      child.on("error", (err) => {
        finish({
          ok: false,
          code: "SPAWN_ERROR",
          exitCode: 1,
          data: { error: err.message },
        });
      });

      child.on("close", (exitCode) => {
        const code = exitCode ?? 0;
        try {
          const trimmed = stdout.trim();
          if (trimmed.startsWith("{")) {
            const parsed = JSON.parse(trimmed);
            finish({
              ok: parsed.ok ?? (code === 0),
              code: parsed.error?.code ?? (code === 0 ? "ok" : "ERROR"),
              exitCode: code,
              data: parsed.data ?? parsed,
            });
            return;
          }
        } catch {
          // not json
        }
        finish({
          ok: code === 0,
          code: code === 0 ? "ok" : "NON_ZERO_EXIT",
          exitCode: code,
          data: { stdout, stderr },
        });
      });

      if (stdinInput !== undefined) {
        child.stdin.end(stdinInput, "utf8");
      } else {
        child.stdin.end();
      }
    });
  }

  async doctor(): Promise<CliOutcome> {
    return this.execute(["doctor", "--profile", this.options.profileDir, "--json"]);
  }

  async poll(): Promise<CliOutcome> {
    return this.execute(["poll", "--profile", this.options.profileDir, "--json"]);
  }

  async history(contactIdentityId: string): Promise<CliOutcome> {
    return this.execute([
      "history",
      "--with",
      contactIdentityId,
      "--profile",
      this.options.profileDir,
      "--json",
    ]);
  }

  async send(toIdentityId: string, text: string): Promise<CliOutcome> {
    // send reads text from stdin to prevent leaking into ps process table
    return this.execute(
      ["send", "--to", toIdentityId, "--profile", this.options.profileDir, "--json"],
      text
    );
  }

  async publish(): Promise<CliOutcome> {
    return this.execute(["relay", "publish", "--profile", this.options.profileDir, "--json"]);
  }

  async exportContact(outPath: string): Promise<CliOutcome> {
    return this.execute([
      "contact",
      "export",
      "--out",
      outPath,
      "--profile",
      this.options.profileDir,
      "--json",
    ]);
  }

  async importContact(cardPath: string): Promise<CliOutcome> {
    return this.execute([
      "contact",
      "import",
      "--from",
      cardPath,
      "--yes",
      "--profile",
      this.options.profileDir,
      "--json",
    ]);
  }

  async validateContact(cardPath: string): Promise<CliOutcome> {
    // A negative confirmation reaches the CLI only after schema, expiry and signature checks.
    // It deliberately leaves the profile unchanged while preserving the CLI as validation authority.
    return this.execute([
      "contact",
      "import",
      "--from",
      cardPath,
      "--profile",
      this.options.profileDir,
      "--json",
    ], "no\n");
  }
}
