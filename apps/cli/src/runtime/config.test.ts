import { describe, expect, it } from "vitest";
import { parseClientConfig, readStoreKey } from "./config";

const valid = {
  profile_version: 1,
  profile_id: "97270747-b64b-4ad5-a677-84599b27a4d9",
  relay_url: "http://127.0.0.1:8081",
  database_path: "client.sqlite",
  store_key_env: "ECHOLET_TEST_KEY",
  request_timeout_ms: 5000,
  poll_batch_size: 50,
};

describe("CLI profile configuration", () => {
  it("accepts strict loopback configuration and canonical 32-byte base64url key", () => {
    expect(parseClientConfig(valid)).toEqual(valid);
    const key = Buffer.alloc(32, 7);
    expect(readStoreKey(valid, { ECHOLET_TEST_KEY: key.toString("base64url") })).toEqual(Uint8Array.from(key));
    for (const relay_url of ["http://localhost:8081", "http://[::1]:8081", "https://relay.example"])
      expect(parseClientConfig({ ...valid, relay_url }).relay_url).toBe(relay_url);
  });

  it("rejects unknown fields, malformed config, and plaintext remote URLs", () => {
    for (const patch of [
      { extra: true }, { profile_version: 2 }, { profile_id: "bad" },
      { database_path: "" }, { store_key_env: "bad-name" },
      { request_timeout_ms: 99 }, { request_timeout_ms: 60001 },
      { poll_batch_size: 0 }, { poll_batch_size: 101 },
      { relay_url: "http://192.168.1.3:8081" }, { relay_url: "http://relay.example" },
      { relay_url: "http://localhost.evil.example" }, { relay_url: "ftp://127.0.0.1" },
      { relay_url: "http://127.0.0.1@evil.example" },
    ]) expect(() => parseClientConfig({ ...valid, ...patch })).toThrow();
  });

  it("rejects missing, invalid, noncanonical and wrong-length keys without echoing them", () => {
    const secretMarker = "SYNTHETIC_SECRET_DO_NOT_LOG";
    for (const key of [undefined, "", secretMarker, Buffer.alloc(31).toString("base64url"), Buffer.alloc(33).toString("base64url"), `${Buffer.alloc(32).toString("base64url")}=`, `${Buffer.alloc(32).toString("base64url").slice(0, -1)}B`]) {
      expect(() => readStoreKey(valid, { ECHOLET_TEST_KEY: key })).toThrow();
      try { readStoreKey(valid, { ECHOLET_TEST_KEY: key }); }
      catch (error) { expect(String(error)).not.toContain(secretMarker); }
    }
  });
});
