import { z } from "zod";

export class ConfigurationError extends Error {
  readonly code = "INVALID_CONFIGURATION";
}

const configSchema = z.object({
  profile_version: z.literal(1),
  profile_id: z.string().uuid().regex(/^[0-9a-f-]+$/),
  relay_url: z.string().url(),
  database_path: z.string().min(1),
  store_key_env: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
  request_timeout_ms: z.number().int().min(100).max(60000),
  poll_batch_size: z.number().int().min(1).max(100),
}).strict();

export type ClientConfig = z.infer<typeof configSchema>;
export type Environment = Readonly<Record<string, string | undefined>>;

export function parseClientConfig(input: unknown): ClientConfig {
  const parsed = configSchema.safeParse(input);
  if (!parsed.success) throw new ConfigurationError("Invalid client configuration");
  const url = new URL(parsed.data.relay_url);
  const loopback = url.hostname === "localhost" || url.hostname === "[::1]" || /^127\.(?:\d{1,3}\.){2}\d{1,3}$/.test(url.hostname);
  if (url.username || url.password || url.hash || (url.protocol !== "https:" && !(url.protocol === "http:" && loopback))) {
    throw new ConfigurationError("Relay URL requires HTTPS or loopback HTTP without credentials");
  }
  return parsed.data;
}

export function readStoreKey(config: { store_key_env: string }, environment: Environment): Uint8Array {
  const value = environment[config.store_key_env];
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value)) {
    throw new ConfigurationError("Store key must be canonical base64url encoding of 32 bytes");
  }
  const key = Buffer.from(value, "base64url");
  if (key.length !== 32 || key.toString("base64url") !== value) {
    key.fill(0);
    throw new ConfigurationError("Store key must be canonical base64url encoding of 32 bytes");
  }
  const owned = Uint8Array.from(key);
  key.fill(0);
  return owned;
}
