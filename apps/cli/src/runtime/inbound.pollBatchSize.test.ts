import { afterEach, describe, expect, it, vi } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openProfile } from "./profile";
import { RelayClient } from "../transport/relayClient";
import { openInboundMessenger } from "./inbound";

/**
 * RED test for the wiring half of review finding F-009: the CLI validates
 * `poll_batch_size` (config.ts:14) but never forwards it, so the relay always
 * applies its own MaxMailboxBatch=100 default and can return a batch the client
 * refuses to read.
 *
 * The assertion is on the outgoing poll request only; no plaintext, ciphertext
 * or key material is asserted or logged.
 */

const paths: string[] = [];
const handles: Array<{ close(): Promise<void> }> = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const handle of handles.splice(0)) await handle.close();
  for (const path of paths.splice(0)) rmSync(path, { recursive: true, force: true });
});

const directory = () => {
  const path = mkdtempSync(join(tmpdir(), "echolet-poll-batch-test-"));
  paths.push(path);
  return path;
};

describe("CLI mailbox poll batch size wiring (F-009)", () => {
  it("forwards the profile's configured poll_batch_size to the relay poll request", async () => {
    const configuredBatchSize = 7;
    const profileDir = directory();
    const environment = { ECHOLET_TEST_KEY: randomBytes(32).toString("base64url") };
    const config = {
      profile_version: 1,
      profile_id: randomUUID(),
      relay_url: "http://127.0.0.1:8081",
      database_path: "client.sqlite",
      store_key_env: "ECHOLET_TEST_KEY",
      request_timeout_ms: 500,
      poll_batch_size: configuredBatchSize,
    };

    const profile = await openProfile({ profileDir, config, environment, initialize: true });
    await profile.close();

    const pollRequests: Array<Record<string, unknown>> = [];
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      if (path === "/v1/mailbox/challenge") {
        return new Response(JSON.stringify({
          ok: true,
          data: { challenge_id: randomUUID(), nonce: "bm9uY2U", expires_at_ms: Date.now() + 60_000 },
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (path === "/v1/mailbox/poll") {
        pollRequests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return new Response(JSON.stringify({ ok: true, data: { envelopes: [], next_cursor: null } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`unexpected path ${path}`);
    });

    const relay = new RelayClient({ baseUrl: "http://127.0.0.1:8081", timeoutMs: 500, fetch });
    const messenger = await openInboundMessenger({ profileDir, environment, relay });
    handles.push(messenger);

    await messenger.poll();

    expect(pollRequests).toHaveLength(1);
    expect(pollRequests[0]).toMatchObject({ batch_size: configuredBatchSize });
  });
});
