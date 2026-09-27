import { describe, expect, it } from "vitest";
import { checkApiRequest, checkHost } from "./requestGuard";

const PORT = 3001;

describe("station request guard", () => {
  it("accepts loopback Host headers on the station port", () => {
    expect(checkHost({ host: "localhost:3001" }, PORT)).toBeNull();
    expect(checkHost({ host: "127.0.0.1:3001" }, PORT)).toBeNull();
    expect(checkHost({ host: "[::1]:3001" }, PORT)).toBeNull();
  });

  it("refuses rebound, foreign-port and missing Host headers", () => {
    expect(checkHost({ host: "evil.example:3001" }, PORT)?.code).toBe("HOST_NOT_ALLOWED");
    expect(checkHost({ host: "localhost:3002" }, PORT)?.code).toBe("HOST_NOT_ALLOWED");
    expect(checkHost({ host: "192.168.1.5:3001" }, PORT)?.code).toBe("HOST_NOT_ALLOWED");
    expect(checkHost({}, PORT)?.code).toBe("HOST_NOT_ALLOWED");
  });

  it("accepts the station's own page and local tools", () => {
    expect(checkApiRequest("GET", { origin: "http://localhost:3001", "sec-fetch-site": "same-origin" }, PORT)).toBeNull();
    expect(checkApiRequest("GET", {}, PORT)).toBeNull();
    expect(
      checkApiRequest("POST", { origin: "http://127.0.0.1:3001", "content-type": "application/json; charset=utf-8" }, PORT),
    ).toBeNull();
  });

  it("refuses another origin, including another local station", () => {
    expect(checkApiRequest("GET", { origin: "https://evil.example" }, PORT)?.code).toBe("ORIGIN_NOT_ALLOWED");
    expect(checkApiRequest("GET", { origin: "http://localhost:3002" }, PORT)?.code).toBe("ORIGIN_NOT_ALLOWED");
    expect(checkApiRequest("GET", { origin: "null" }, PORT)?.code).toBe("ORIGIN_NOT_ALLOWED");
  });

  it("refuses cross-site fetch metadata even without an Origin header", () => {
    expect(checkApiRequest("GET", { "sec-fetch-site": "cross-site" }, PORT)?.code).toBe("CROSS_SITE_REFUSED");
    expect(checkApiRequest("GET", { "sec-fetch-site": "same-site" }, PORT)?.code).toBe("CROSS_SITE_REFUSED");
  });

  it("refuses POST bodies that are not JSON, closing the no-preflight text/plain path", () => {
    expect(checkApiRequest("POST", { "content-type": "text/plain" }, PORT)?.code).toBe("UNSUPPORTED_MEDIA_TYPE");
    expect(checkApiRequest("POST", {}, PORT)?.code).toBe("UNSUPPORTED_MEDIA_TYPE");
  });
});
