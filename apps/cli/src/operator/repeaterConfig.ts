// Values that reach the repeater's env file and its `docker run` argv come from
// an interactive prompt or from `config.env`, which anyone who can write the
// operator's home directory can edit. They are validated before use and never
// interpolated into a shell command line.

const CALLSIGN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

export const DEFAULT_REPEATER_PORT = 8081;
export const REPEATER_CONTAINER_NAME = "echolet-relay";
export const REPEATER_IMAGE = "echolet-relay:latest";

export class RepeaterConfigError extends Error {}

export function validateCallsign(value: string): string {
  const callsign = value.trim();
  if (!CALLSIGN_PATTERN.test(callsign)) {
    throw new RepeaterConfigError(
      `Недопустимый позывной "${printable(value)}": 1–32 символа, латинские буквы, цифры, "-" и "_", начиная с буквы или цифры.`,
    );
  }
  return callsign;
}

export function validatePort(value: string | number): number {
  const text = String(value).trim();
  const port = Number(text);
  if (!/^\d+$/.test(text) || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new RepeaterConfigError(`Недопустимый порт "${printable(text)}": ожидается целое число от 1 до 65535.`);
  }
  return port;
}

// A newline in a value written to config.env would start a second variable.
export function validateEnvValue(name: string, value: string): string {
  if (CONTROL_CHARACTERS.test(value)) {
    throw new RepeaterConfigError(`Недопустимое значение ${name}: управляющие символы и переводы строки запрещены.`);
  }
  return value;
}

export function formatEnvFile(entries: Array<[string, string]>): string {
  return entries.map(([name, value]) => `${name}=${validateEnvValue(name, value)}`).join("\n") + "\n";
}

export function parseEnvFile(raw: string): Record<string, string> {
  const cfg: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const [key, ...rest] = line.split("=");
    if (key && rest.length) cfg[key.trim()] = rest.join("=").trim();
  }
  return cfg;
}

export interface RepeaterStartConfig {
  callsign: string;
  port: number;
}

// Refuses a tampered config.env instead of passing its values on.
export function resolveStartConfig(cfg: Record<string, string>): RepeaterStartConfig {
  return {
    callsign: validateCallsign(cfg.ECHOLET_NODE_CALLSIGN || "LOCAL-REPEATER"),
    port: validatePort(cfg.ECHOLET_PORT || String(DEFAULT_REPEATER_PORT)),
  };
}

// The argv for `docker run`, one value per element: nothing here is ever parsed
// by a shell, so no character in a value can end an argument or start a command.
export function buildDockerRunArgs(config: RepeaterStartConfig, dataDir: string): string[] {
  return [
    "run",
    "-d",
    "--name", REPEATER_CONTAINER_NAME,
    "--restart", "unless-stopped",
    "--user", "10001:10001",
    "-p", `127.0.0.1:${config.port}:8443`,
    "-e", "ECHOLET_HTTP_ADDR=0.0.0.0:8443",
    "-e", "ECHOLET_DATA_DIR=/var/lib/echolet",
    "-e", `ECHOLET_NODE_CALLSIGN=${config.callsign}`,
    "-v", `${dataDir}:/var/lib/echolet`,
    REPEATER_IMAGE,
  ];
}

function printable(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]/g, "?");
}
