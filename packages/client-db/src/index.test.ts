import { describe, expect, it } from "vitest";
import * as clientDb from "./index";

describe("client-db package", () => {
  it("loads the module without runtime exports", () => {
    expect(clientDb).toBeDefined();
    expect(typeof clientDb).toBe("object");
  });
});
