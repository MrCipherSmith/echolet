import type { IncomingHttpHeaders } from "node:http";

// The station drives the operator's identity (send, import, publish, history),
// so it only ever answers the operator's own browser on this machine.
export const STATION_BIND_HOST = "127.0.0.1";

const LOOPBACK_HOSTNAMES = ["localhost", "127.0.0.1", "[::1]"];

export type GuardRejection = { status: number; code: string; error: string };

function header(headers: IncomingHttpHeaders, name: string): string | undefined {
  const value = headers[name];
  return Array.isArray(value) ? value[0] : value;
}

export function allowedHosts(port: number): Set<string> {
  return new Set(LOOPBACK_HOSTNAMES.map((name) => `${name}:${port}`));
}

export function allowedOrigins(port: number): Set<string> {
  return new Set(LOOPBACK_HOSTNAMES.map((name) => `http://${name}:${port}`));
}

// A Host outside loopback means DNS rebinding or a request that did not come
// through the loopback socket; either way it is not the operator's browser.
export function checkHost(headers: IncomingHttpHeaders, port: number): GuardRejection | null {
  const host = header(headers, "host")?.toLowerCase();
  if (host && allowedHosts(port).has(host)) return null;
  return { status: 421, code: "HOST_NOT_ALLOWED", error: "Station answers only on loopback" };
}

// Browsers mark every cross-site request with Origin and/or Sec-Fetch-Site.
// Requests without either come from local tools (curl), not from a web page.
export function checkApiRequest(
  method: string | undefined,
  headers: IncomingHttpHeaders,
  port: number,
): GuardRejection | null {
  const origin = header(headers, "origin");
  if (origin !== undefined && !allowedOrigins(port).has(origin.toLowerCase())) {
    return { status: 403, code: "ORIGIN_NOT_ALLOWED", error: "Cross-origin requests are refused" };
  }

  const fetchSite = header(headers, "sec-fetch-site");
  if (fetchSite !== undefined && fetchSite !== "same-origin" && fetchSite !== "none") {
    return { status: 403, code: "CROSS_SITE_REFUSED", error: "Cross-site requests are refused" };
  }

  // A cross-origin page can POST text/plain without a preflight; demanding JSON
  // forces a preflight that this server never approves.
  if (method === "POST") {
    const contentType = header(headers, "content-type")?.split(";")[0]?.trim().toLowerCase();
    if (contentType !== "application/json") {
      return { status: 415, code: "UNSUPPORTED_MEDIA_TYPE", error: "POST body must be application/json" };
    }
  }

  return null;
}
