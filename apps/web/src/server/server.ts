import http from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve, extname, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { CliBridge, DEFAULT_CLI_PATH } from "./cliBridge";
import { exportContactCard, importContactCardJson, validateContactCardJson } from "./contactCards";
import { createStatusPayload, validationFailureHttpStatus } from "./stationApi";
import { StationStatus } from "./stationStatus";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLIENT_DIST = resolve(HERE, "client");

interface ServerConfig {
  port: number;
  profileDir: string;
  label: string;
  relayUrl: string;
  storeKeyEnv: string;
  cliPath: string;
}

function parseArgv(): ServerConfig {
  const argv = process.argv.slice(2);
  let port = 3000;
  let profileDir = resolve(process.cwd(), ".tmp/demo-data/alice");
  let label = "Operator";
  let relayUrl = "https://depr.tail5a88fb.ts.net:8443";
  let storeKeyEnv = "ECHOLET_STORE_KEY";
  let cliPath = DEFAULT_CLI_PATH;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--port" && next) {
      port = parseInt(next, 10);
      i++;
    } else if (arg === "--profile" && next) {
      profileDir = resolve(next);
      i++;
    } else if (arg === "--label" && next) {
      label = next;
      i++;
    } else if (arg === "--relay-url" && next) {
      relayUrl = next;
      i++;
    } else if (arg === "--store-key-env" && next) {
      storeKeyEnv = next;
      i++;
    } else if (arg === "--cli" && next) {
      cliPath = resolve(next);
      i++;
    }
  }

  return { port, profileDir, label, relayUrl, storeKeyEnv, cliPath };
}

const config = parseArgv();
const bridge = new CliBridge({
  cliPath: config.cliPath,
  profileDir: config.profileDir,
  storeKeyEnv: config.storeKeyEnv,
  relayUrl: config.relayUrl,
});
const stationStatus = new StationStatus({
  doctor: () => bridge.doctor(),
  relayUrl: config.relayUrl,
});

// Telemetry buffer for the Inspector panel
interface TelemetryItem {
  id: string;
  time: string;
  type: "info" | "success" | "warn" | "error" | "crypto";
  message: string;
}

const telemetryLogs: TelemetryItem[] = [];

function logTelemetry(type: TelemetryItem["type"], message: string) {
  const now = new Date();
  const time = now.toTimeString().split(" ")[0] + "." + String(now.getMilliseconds()).padStart(3, "0");
  const item: TelemetryItem = {
    id: Math.random().toString(36).substring(2, 9),
    time,
    type,
    message,
  };
  telemetryLogs.push(item);
  if (telemetryLogs.length > 200) telemetryLogs.shift();
  broadcastSSE("telemetry", item);
}

// SSE client tracking
const sseClients: Set<http.ServerResponse> = new Set();

function broadcastSSE(event: string, data: unknown) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    client.write(payload);
  }
}

function statusPayload() {
  return createStatusPayload(config.label, stationStatus.snapshot());
}

function broadcastStatus() {
  broadcastSSE("status", statusPayload());
}

function numericField(value: unknown, key: string): number | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const field = (value as Record<string, unknown>)[key];
  return typeof field === "number" && Number.isFinite(field) ? field : null;
}

// Background Auto-poller
let polling = false;
async function pollLoop() {
  if (polling) return;
  polling = true;
  try {
    const outcome = await bridge.poll();
    stationStatus.recordPoll(outcome);
    broadcastStatus();
    if (outcome.ok && outcome.data) {
      const received = numericField(outcome.data, "received") ?? 0;
      if (received > 0) {
        logTelemetry("success", `[Inbound] ${received} new encrypted message(s) downloaded from relay`);
        broadcastSSE("new_message", { received });
      }
    } else if (!outcome.ok) {
      logTelemetry("warn", `[Poll Warning] ${outcome.code}`);
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown poll error";
    logTelemetry("error", `[Poll Error] ${message}`);
  } finally {
    polling = false;
  }
}

// Start intervals
setInterval(pollLoop, 2500);
setInterval(async () => {
  await stationStatus.refreshRelayReachability();
  const snapshot = statusPayload();
  if (snapshot.pingMs !== null) {
    broadcastSSE("ping", { ping: snapshot.pingMs, status: "reachable" });
  } else {
    broadcastSSE("ping", { ping: null, status: "unreachable" });
  }
  broadcastStatus();
}, 5000);

// Initial bootstrap
(async () => {
  logTelemetry("crypto", `Initializing Echolet Web Node for [${config.label}]`);
  logTelemetry("info", `Profile store: ${config.profileDir}`);
  logTelemetry("info", `Target relay: ${config.relayUrl}`);
  
  await stationStatus.refreshRelayReachability();
  const snapshot = statusPayload();
  if (snapshot.pingMs !== null) {
    logTelemetry("success", `Relay reachable: ${snapshot.pingMs}ms latency`);
  } else {
    logTelemetry("warn", `Relay unreachable or checking...`);
  }

  await stationStatus.refreshProfile();
  const profile = statusPayload().profile;
  const identityId = typeof profile?.identity_id === "string" ? profile.identity_id : "";
  if (profile) {
    logTelemetry("crypto", `Identity verified: ${identityId.substring(0, 16)}...`);
    logTelemetry("info", `Pinned contacts count: ${numericField(profile, "contact_count") ?? 0}`);
  }
})();

// MIME helper
const MIME_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".js": "application/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
};

const MAX_JSON_BODY_BYTES = 128 * 1024;

class RequestBodyError extends Error {
  constructor(readonly statusCode: number, readonly code: string, message: string) {
    super(message);
  }
}

async function readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((res, rej) => {
    let body = "";
    let bytes = 0;
    let settled = false;
    req.on("data", (chunk: Buffer) => {
      if (settled) return;
      bytes += chunk.length;
      if (bytes > MAX_JSON_BODY_BYTES) {
        settled = true;
        req.resume();
        rej(new RequestBodyError(413, "PAYLOAD_TOO_LARGE", "JSON body exceeds 128 KiB"));
        return;
      }
      body += chunk.toString("utf8");
    });
    req.on("end", () => {
      if (settled) return;
      try {
        const parsed: unknown = body ? JSON.parse(body) : {};
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
          rej(new RequestBodyError(400, "INVALID_JSON_BODY", "JSON body must be an object"));
          return;
        }
        res(parsed as Record<string, unknown>);
      } catch {
        rej(new RequestBodyError(400, "INVALID_JSON_BODY", "JSON body is malformed"));
      }
    });
    req.on("error", rej);
  });
}

function writeJson(res: http.ServerResponse, statusCode: number, value: unknown): void {
  res.writeHead(statusCode, { "Content-Type": "application/json" });
  res.end(JSON.stringify(value));
}

function writeRequestError(res: http.ServerResponse, error: unknown): void {
  if (error instanceof RequestBodyError) {
    writeJson(res, error.statusCode, { ok: false, code: error.code, error: error.message });
    return;
  }
  writeJson(res, 500, { ok: false, code: "INTERNAL_ERROR", error: "Request failed" });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
  const pathname = url.pathname;

  // CORS headers for local dev flexibility
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  // --- API Routes ---
  if (pathname === "/api/events") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    res.write(`event: status\ndata: ${JSON.stringify(statusPayload())}\n\n`);
    sseClients.add(res);
    req.on("close", () => sseClients.delete(res));
    return;
  }

  if (pathname === "/api/status" && req.method === "GET") {
    await Promise.all([
      stationStatus.refreshProfile(),
      stationStatus.refreshRelayReachability(),
    ]);
    writeJson(res, 200, {
      ok: true,
      ...statusPayload(),
      telemetry: telemetryLogs.slice(-50),
    });
    return;
  }

  if (pathname === "/api/history" && req.method === "GET") {
    const withId = url.searchParams.get("with");
    if (!withId) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "Missing 'with' parameter" }));
      return;
    }
    const outcome = await bridge.history(withId);
    res.writeHead(outcome.ok ? 200 : 500, { "Content-Type": "application/json" });
    res.end(JSON.stringify(outcome));
    return;
  }

  if (pathname === "/api/send" && req.method === "POST") {
    try {
      const body = await readBody(req);
      const to = typeof body.to === "string" ? body.to : "";
      const text = typeof body.text === "string" ? body.text : "";
      if (!to || !text) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "Missing 'to' or 'text'" }));
        return;
      }
      logTelemetry("crypto", `Encrypting message via Double Ratchet for recipient ${to.substring(0, 12)}...`);
      const outcome = await bridge.send(to, text);
      if (outcome.ok) {
        logTelemetry("success", `[Outbound] Envelope delivered to relay (status: ${outcome.data?.status})`);
        broadcastSSE("outbound_sent", outcome.data);
      } else {
        logTelemetry("error", `Send failure: ${outcome.code}`);
      }
      res.writeHead(outcome.ok ? 200 : 500, { "Content-Type": "application/json" });
      res.end(JSON.stringify(outcome));
    } catch (err: any) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: err.message }));
    }
    return;
  }

  if (pathname === "/api/publish" && req.method === "POST") {
    logTelemetry("crypto", `Minting and publishing Signal PreKey Bundles...`);
    const outcome = await bridge.publish();
    if (outcome.ok) {
      logTelemetry("success", `PreKey pool updated: target 20, claimable 20`);
    } else {
      logTelemetry("error", `Publish failed: ${outcome.code}`);
    }
    res.writeHead(outcome.ok ? 200 : 500, { "Content-Type": "application/json" });
    res.end(JSON.stringify(outcome));
    return;
  }

  if (pathname === "/api/contacts/export" && req.method === "GET") {
    const result = await exportContactCard(bridge);
    if (result.ok) {
      writeJson(res, 200, result.data.card);
      return;
    }
    logTelemetry("error", `Contact export failed: ${result.code}`);
    writeJson(res, 500, { ok: false, code: result.code, error: result.message });
    return;
  }

  if (pathname === "/api/contacts/validate" && req.method === "POST") {
    try {
      const body = await readBody(req);
      const result = await validateContactCardJson(bridge, body.cardJson);
      if (!result.ok) {
        writeJson(res, validationFailureHttpStatus(result.code), {
          ok: false,
          code: result.code,
          error: result.message,
        });
        return;
      }
      writeJson(res, 200, { ok: true, data: { preview: result.data.preview } });
    } catch (error: unknown) {
      writeRequestError(res, error);
    }
    return;
  }

  if (pathname === "/api/contacts/import" && req.method === "POST") {
    try {
      const body = await readBody(req);
      if (body.cardJson === undefined) {
        writeJson(res, 400, { ok: false, code: "MISSING_CONTACT_CARD", error: "Missing cardJson" });
        return;
      }
      if (body.confirmed !== true) {
        writeJson(res, 409, { ok: false, code: "CONFIRMATION_REQUIRED", error: "Confirm the validated contact card before import" });
        return;
      }
      logTelemetry("crypto", `Verifying contact card cryptographic signatures...`);
      const result = await importContactCardJson(bridge, body.cardJson);
      if (result.ok) {
        logTelemetry("success", `Contact trusted & added to secure address book`);
        await stationStatus.refreshProfile();
        broadcastSSE("contact_added", {});
        broadcastStatus();
      } else {
        logTelemetry("error", `Contact import failed: ${result.code}`);
      }
      writeJson(
        res,
        result.ok ? 200 : result.code === "INVALID_CONTACT_CARD" || result.code === "TRUST_FAILURE" ? 400 : 500,
        result.ok
          ? { ok: true, code: "ok", data: { preview: result.data.preview } }
          : { ok: false, code: result.code, error: result.message },
      );
    } catch (error: unknown) {
      writeRequestError(res, error);
    }
    return;
  }

  // --- Static Files Serving ---
  let filePath = pathname === "/" ? "index.html" : pathname.replace(/^\//, "");
  let target = resolve(CLIENT_DIST, filePath);

  if (!existsSync(target)) {
    // SPA fallback: return index.html for navigation routes
    target = resolve(CLIENT_DIST, "index.html");
  }

  if (existsSync(target)) {
    const ext = extname(target).toLowerCase();
    const contentType = MIME_TYPES[ext] || "application/octet-stream";
    try {
      const content = await readFile(target);
      res.writeHead(200, { "Content-Type": contentType });
      res.end(content);
      return;
    } catch {
      res.writeHead(500);
      res.end("Error loading file");
      return;
    }
  }

  res.writeHead(404);
  res.end("Not Found");
});

server.listen(config.port, () => {
  console.log(`\n=====================================================`);
  console.log(`  ECHOLET WEB CLIENT — ${config.label}`);
  console.log(`=====================================================`);
  console.log(`  Local URL:   http://localhost:${config.port}`);
  console.log(`  Profile:     ${config.profileDir}`);
  console.log(`  Relay URL:   ${config.relayUrl}`);
  console.log(`=====================================================\n`);
});
