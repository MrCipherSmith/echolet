import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { LIMITS } from "@echolet/protocol";
import { describe, expect, it } from "vitest";

// Flow 003 T27 — V-006: the size relationship, guarded in BOTH directions.
//
// `LIMITS.MAX_MESSAGE_BYTES` (packages/protocol/src/constants/limits.ts) is the source of truth for
// the largest ciphertext an envelope may carry. `protocol.MaxMessageBytes`
// (apps/relay/internal/protocol/limits.go) is its Go mirror, and its own doc comment says "the two
// must be changed together". The relay validates every deployment's ECHOLET_MAX_MESSAGE_BYTES
// against the Go constant; the client sizes its send bound and its poll-response bound from the
// TypeScript one. The closure taken in `5235a6d` reduced four hand-written copies of this number to
// exactly these two, and the whole of that closure rests on them being equal.
//
// MEASURED (flow 003 T25 §3.1 and §5, mutations M-J / M-J2): the Go direction is caught — doubling
// `protocol.MaxMessageBytes` fails three named Go assertions across two packages — but the
// TypeScript direction was caught by nothing. Setting `MAX_MESSAGE_BYTES: 131072` left 21 files and
// 83 tests green in `apps/cli` while the relay went on accepting 262144-byte ciphertexts and
// producing poll responses a client sized at 131072 would refuse in full. Accepted, stored, never
// acknowledged, with nothing red anywhere: that is residual RI-09's exact failure mode,
// reintroduced by a one-line edit to the very constant the closure is built on.
//
// WHY IT IS WRITTEN THIS WAY. The assertion deliberately holds NO number of its own. It reads the
// TypeScript value through the real export and the Go value out of the Go source, and compares
// them. A third hand-written copy of 262144 is exactly what the closure removed, and a test that
// carried one would have to be edited in step with the constants — which is to say it would pin
// nothing. The companion assertion on the Go side is
// `TestMaxMessageBytesMirrorsTheTypeScriptProtocolConstant` in
// apps/relay/internal/protocol/limits_mirror_test.go, so a divergence is red whichever of the two
// suites is run.

/** apps/cli/src/transport → apps/cli/src → apps/cli → apps → the workspace root. */
const GO_MIRROR_PATH = fileURLToPath(new URL("../../../../apps/relay/internal/protocol/limits.go", import.meta.url));

/**
 * The value of a Go `int64` constant declared in the mirror file.
 *
 * Deliberately strict about the shape it accepts: a declaration it cannot parse fails loudly here
 * rather than silently comparing against a fallback, because a mirror this test cannot read is a
 * mirror it is not checking.
 */
function goInt64Constant(source: string, name: string): number {
  const declaration = new RegExp(`\\bconst\\s+${name}\\s+int64\\s*=\\s*([0-9_]+)\\b`).exec(source);
  expect(declaration, `apps/relay/internal/protocol/limits.go declares no \`const ${name} int64 = <number>\``).not.toBeNull();
  const digits = (declaration?.[1] ?? "").replace(/_/g, "");
  const value = Number(digits);
  expect(Number.isSafeInteger(value)).toBe(true);
  return value;
}

describe("V-006: the protocol's message-size constant and its Go mirror agree", () => {
  it("holds the same value on both sides of the wire, in both directions", () => {
    const source = readFileSync(GO_MIRROR_PATH, "utf8");
    const goValue = goInt64Constant(source, "MaxMessageBytes");

    // The pin. Lowering EITHER constant on its own leaves the relay accepting envelopes the client
    // will refuse to read back (RI-09); raising either on its own leaves a deployment able to be
    // configured for a size the other end will not carry. Neither is a deployment decision, and
    // neither may pass in silence.
    expect(goValue).toBe(LIMITS.MAX_MESSAGE_BYTES);

    // Guards against the two ways this assertion could pass while checking nothing: a regex that
    // matched an empty or zero-valued declaration, and a `LIMITS` import that resolved to
    // `undefined` under a future module change.
    expect(typeof LIMITS.MAX_MESSAGE_BYTES).toBe("number");
    expect(LIMITS.MAX_MESSAGE_BYTES).toBeGreaterThan(0);
    expect(goValue).toBeGreaterThan(0);
  });
});
