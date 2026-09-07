import { describe, expect, it, vi } from "vitest";
import { parseClientConfig } from "../runtime/config";
import { RelayClient } from "./relayClient";

/**
 * RED suite for finding T10R3-F-003: `parseClientConfig` and `RelayClient` do not agree on what
 * loopback is, and the transport is the LOOSER of the two.
 *
 * The disagreement
 * ----------------
 * Plain HTTP is admitted only to loopback; everything else must be HTTPS. `parseClientConfig`
 * (runtime/config.ts:38) decides that with a dotted quad, `/^127\.(?:\d{1,3}\.){2}\d{1,3}$/`.
 * `RelayClient` (transport/relayClient.ts:75) decides it with the PREFIX `/^127\./`, which is a test
 * on the first four characters of a name and not on an address at all. `127.evil.example` is a
 * perfectly ordinary registrable hostname that an attacker can own and point anywhere, and it
 * matches. So does `127.0.0.1.evil.example`, whose left label is chosen precisely to be misread.
 *
 * Why this is worth a test even though the CLI is not exploitable today
 * --------------------------------------------------------------------
 * `commands/cli.ts:210` is the only production construction site and it runs `parseClientConfig`
 * first, so the stricter rule happens to run before the looser one and the CLI refuses these URLs at
 * `init`. That ordering is the entire defence. `RelayClient` is a public class in the transport
 * boundary with its own validation, its own typed refusal and its own reasons for having them - it
 * exists so that a base URL which could send plaintext to an attacker-chosen host never reaches the
 * wire - and a second construction site, a new command, a test harness or a reordering of those two
 * lines is all it takes. A defence in depth that only works in one order is not one.
 *
 * These tests therefore drive `RelayClient` DIRECTLY. They never go through `parseClientConfig`
 * first, because passing only because a different function ran earlier is the exact defect.
 *
 * What must not change
 * --------------------
 * The final two cases are the control. Genuine loopback development over plain HTTP is what the
 * allowance is for, and every e2e suite in this repository depends on it; a fix that closes the
 * hostname hole by refusing `127.0.0.1`, `localhost` or `[::1]` breaks the product instead of the
 * bug. Nothing here relaxes a schema or a validation rule.
 *
 * No secret, key, body or URL credential appears in this file: every URL is a public hostname.
 */

/** A construction that must be refused, with what a `/^127\./` prefix rule makes of it. */
const wronglyAdmitted = [
  {
    url: "http://127.evil.example/",
    why: "a registrable domain whose leftmost label is the three digits 127: it resolves to whatever its owner wants and is not loopback in any sense",
  },
  {
    url: "http://127.0.0.1.evil.example/",
    why: "an attacker-owned domain that begins with a literal loopback address, the classic shape for making a reader's eye stop at the left",
  },
  {
    url: "http://127.example.com:8081/",
    why: "the same prefix hole with a port, so the refusal cannot depend on the default port",
  },
] as const;

/** Genuine loopback, which must keep working. */
const genuineLoopback = ["http://127.0.0.1:8081/", "http://127.0.0.1:8081", "http://127.9.9.9:8081/", "http://localhost:8081/", "http://[::1]:8081/"] as const;

describe("RelayClient loopback rule", () => {
  it.each(wronglyAdmitted)("refuses plain HTTP to $url", ({ url, why }) => {
    expect(
      () => new RelayClient({ baseUrl: url, timeoutMs: 500, fetch: vi.fn() }),
      `RelayClient accepted ${url} as a base URL and would serve every relay request from it over plain HTTP. ` +
        `The hostname is ${why}. relayClient.ts:75 tests loopback with the prefix /^127\\./, which matches any name whose first label is "127", ` +
        "while runtime/config.ts:38 requires a dotted quad and refuses exactly these. The two must agree, and they must agree on the STRICTER rule: " +
        "the direction of the disagreement is that the transport admits plaintext HTTP to an attacker-chosen remote host. " +
        "It is unreachable through the CLI today only because commands/cli.ts:210 runs parseClientConfig first (finding T10R3-F-003), which makes this defence in depth no defence at all",
    ).toThrowError(expect.objectContaining({ code: "INVALID_RELAY_CONFIGURATION", retryable: false }));
  });

  it.each(genuineLoopback)("still accepts genuine loopback over plain HTTP: %s", (url) => {
    expect(() => new RelayClient({ baseUrl: url, timeoutMs: 500, fetch: vi.fn() }), `${url} is genuine loopback and plain HTTP to it must keep working`).not.toThrow();
  });

  it("still accepts HTTPS to a remote origin, and still refuses plain HTTP to one", () => {
    expect(() => new RelayClient({ baseUrl: "https://relay.example.com/", timeoutMs: 500, fetch: vi.fn() })).not.toThrow();
    expect(() => new RelayClient({ baseUrl: "http://relay.example.com/", timeoutMs: 500, fetch: vi.fn() }))
      .toThrowError(expect.objectContaining({ code: "INVALID_RELAY_CONFIGURATION" }));
  });

  /**
   * The disagreement itself, stated as the property that must hold rather than as a list.
   *
   * Both components answer the same question - "may this base URL be used?" - and the product's
   * security depends on the answer, so they must not answer it differently for any URL. This is the
   * assertion that keeps a future edit to either rule from re-opening the gap in the other.
   */
  it("agrees with parseClientConfig about every relay URL", () => {
    const template = {
      profile_version: 1 as const,
      profile_id: "11111111-1111-4111-8111-111111111111",
      database_path: "db.sqlite",
      store_key_env: "ECHOLET_STORE_KEY",
      request_timeout_ms: 500,
      poll_batch_size: 50,
    };
    const urls = [
      ...wronglyAdmitted.map((entry) => entry.url),
      ...genuineLoopback,
      "https://relay.example.com/",
      "http://relay.example.com/",
      "http://192.168.1.10:8081/",
      "http://0.0.0.0:8081/",
      "http://localhost.evil.example/",
      "http://127.1:8081/",
    ];
    const accepts = (decide: () => unknown) => { try { decide(); return true; } catch { return false; } };
    const disagreements = urls.filter((relay_url) =>
      accepts(() => parseClientConfig({ ...template, relay_url })) !==
      accepts(() => new RelayClient({ baseUrl: relay_url, timeoutMs: 500, fetch: vi.fn() })));

    expect(
      disagreements,
      "parseClientConfig (runtime/config.ts:38) and RelayClient (transport/relayClient.ts:75) must answer the same question the same way. " +
        "They disagree on these URLs, and in the unsafe direction: the transport treats them as loopback and would carry relay traffic to them in plaintext (finding T10R3-F-003)",
    ).toEqual([]);
  });
});
