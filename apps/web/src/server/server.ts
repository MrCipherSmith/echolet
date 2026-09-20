import http from "node:http";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve, extname, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CliBridge, DEFAULT_CLI_PATH } from "./cliBridge";

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

function broadcastSSE(event: string, data: any) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    client.write(payload);
  }
}

// State cache
let cachedProfile: any = null;
let lastPingMs: number | null = null;

async function checkRelayPing(): Promise<number | null> {
  const start = Date.now();
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    const res = await fetch(`${config.relayUrl}/health`, { signal: controller.signal });
    clearTimeout(timeout);
    if (res.ok) {
      const ping = Date.now() - start;
      lastPingMs = ping;
      return ping;
    }
  } catch {
    lastPingMs = null;
  }
  return null;
}

// Background Auto-poller
let polling = false;
async function pollLoop() {
  if (polling) return;
  polling = true;
  try {
    const outcome = await bridge.poll();
    if (outcome.ok && outcome.data) {
      const received = outcome.data.received ?? 0;
      if (received > 0) {
        logTelemetry("success", `[Inbound] ${received} new encrypted message(s) downloaded from relay`);
        broadcastSSE("new_message", { received });
      }
    } else if (!outcome.ok) {
      logTelemetry("warn", `[Poll Warning] ${outcome.code}`);
    }
  } catch (err: any) {
    logTelemetry("error", `[Poll Error] ${err.message}`);
  } finally {
    polling = false;
  }
}

// Start intervals
setInterval(pollLoop, 2500);
setInterval(async () => {
  const ping = await checkRelayPing();
  if (ping !== null) {
    broadcastSSE("ping", { ping, status: "healthy" });
  } else {
    broadcastSSE("ping", { ping: null, status: "unreachable" });
  }
}, 5000);

// Initial bootstrap
(async () => {
  logTelemetry("crypto", `Initializing Echolet Web Node for [${config.label}]`);
  logTelemetry("info", `Profile store: ${config.profileDir}`);
  logTelemetry("info", `Target relay: ${config.relayUrl}`);
  
  const ping = await checkRelayPing();
  if (ping !== null) {
    logTelemetry("success", `Connected to Relay: ${ping}ms latency`);
  } else {
    logTelemetry("warn", `Relay unreachable or checking...`);
  }

  const doc = await bridge.doctor();
  if (doc.ok) {
    cachedProfile = doc.data;
    logTelemetry("crypto", `Identity verified: ${doc.data.identity_id?.substring(0, 16)}...`);
    logTelemetry("info", `Pinned contacts count: ${doc.data.contact_count ?? 0}`);
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

async function readBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((res, rej) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      try {
        res(body ? JSON.parse(body) : {});
      } catch (err) {
        rej(err);
      }
    });
    req.on("error", rej);
  });
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
    res.write("\n");
    sseClients.add(res);
    req.on("close", () => sseClients.delete(res));
    return;
  }

  if (pathname === "/api/status" && req.method === "GET") {
    if (!cachedProfile) {
      const doc = await bridge.doctor();
      if (doc.ok) cachedProfile = doc.data;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      ok: true,
      label: config.label,
      profile: cachedProfile,
      relayUrl: config.relayUrl,
      pingMs: lastPingMs,
      telemetry: telemetryLogs.slice(-50),
    }));
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
      if (!body.to || !body.text) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "Missing 'to' or 'text'" }));
        return;
      }
      logTelemetry("crypto", `Encrypting message via Double Ratchet for recipient ${body.to.substring(0, 12)}...`);
      const outcome = await bridge.send(body.to, body.text);
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
    const tmpOut = resolve(config.profileDir, "../export-temp.json");
    const outcome = await bridge.exportContact(tmpOut);
    if (outcome.ok && existsSync(tmpOut)) {
      const cardJson = await readFile(tmpOut, "utf8");
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(cardJson);
      return;
    }
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify(outcome));
    return;
  }

  if (pathname === "/api/contacts/import" && req.method === "POST") {
    try {
      const body = await readBody(req);
      let cardPath = body.cardPath;
      if (body.cardJson) {
        cardPath = resolve(config.profileDir, "../import-temp.json");
        await writeFile(cardPath, typeof body.cardJson === "string" ? body.cardJson : JSON.stringify(body.cardJson), "utf8");
      }
      if (!cardPath) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "Missing cardPath or cardJson" }));
        return;
      }
      logTelemetry("crypto", `Verifying contact card cryptographic signatures...`);
      const outcome = await bridge.importContact(cardPath);
      if (outcome.ok) {
        logTelemetry("success", `Contact trusted & added to secure address book`);
        // Refresh doctor cache
        const doc = await bridge.doctor();
        if (doc.ok) cachedProfile = doc.data;
        broadcastSSE("contact_added", {});
      } else {
        logTelemetry("error", `Contact import failed: ${outcome.code}`);
      }
      res.writeHead(outcome.ok ? 200 : 500, { "Content-Type": "application/json" });
      res.end(JSON.stringify(outcome));
    } catch (err: any) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: err.message }));
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
