#!/usr/bin/env node

/**
 * Cross-Claude MCP Server
 *
 * Modes (auto-detected):
 * - Local (stdio + SQLite): when no PORT env var is set
 * - Remote (HTTP + PostgreSQL): when PORT and DATABASE_URL are set (Railway)
 *
 * Remote endpoints:
 * - POST /mcp -- Streamable HTTP (Claude.ai, Claude Code via mcp-remote, Claude Desktop)
 * - GET  /mcp -- SSE stream for Streamable HTTP
 * - GET  /sse -- Legacy SSE transport (backward compat)
 * - POST /messages -- Legacy SSE message endpoint
 * - GET  /health -- Health check
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createDB } from "./db.mjs";
import { registerTools } from "./tools.mjs";
import { createRestRouter } from "./rest-api.mjs";
import { InviteCodeOAuthProvider, createAuthorizeSubmitHandler } from "./auth.mjs";
import { resolveFull } from "../cc-discover.mjs";
import { revString, codeRev } from "../cc-rev.mjs";

// --- Transport: Stdio (local) ---

async function startStdio(db) {
  const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");

  const server = new McpServer({ name: "cross-claude-mcp", version: "2.0.0" }, { capabilities: { tools: {}, experimental: { "claude/channel": {} } } });
  const cleanup = registerTools(server, db);

  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) {
    process.on(signal, () => { cleanup(); process.exit(0); });
  }
  process.on("exit", cleanup);
  process.stdin.on("end", () => { cleanup(); process.exit(0); });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// --- Transport: HTTP (Railway) ---

async function startHTTP(db) {
  const express = (await import("express")).default;
  const { StreamableHTTPServerTransport } = await import("@modelcontextprotocol/sdk/server/streamableHttp.js");
  const { SSEServerTransport } = await import("@modelcontextprotocol/sdk/server/sse.js");
  const { randomUUID } = await import("crypto");

  const app = express();
  const PORT = parseInt(process.env.PORT) || 3000;

  // --- Election / discovery identity (set by the cc-bus supervisor) ---
  // CC_EPOCH: monotonic authority counter — highest epoch wins across the estate.
  // CC_HOST:  stable node id used for the deterministic tiebreak on equal epoch.
  const os = await import("os");
  const EPOCH = parseInt(process.env.CC_EPOCH) || 0;
  const CC_HOST = process.env.CC_HOST || os.hostname();
  const STARTED_AT = new Date().toISOString();
  // Running-code revision — advertised so the estate can verify every node is on the same
  // code and nudge stale ones to pull + re-launch (a leader on old code was the /console gap).
  const REV = revString();
  const REV_DIRTY = codeRev().dirty;

  // --- CORS (required for Claude Desktop custom connectors) ---

  app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.header("Access-Control-Allow-Headers", "Content-Type, Authorization, Mcp-Session-Id");
    res.header("Access-Control-Expose-Headers", "Mcp-Session-Id");
    if (req.method === "OPTIONS") return res.sendStatus(204);
    next();
  });

  // --- OAuth 2.1 (for Claude Desktop custom connectors) ---

  const SERVER_URL = process.env.SERVER_URL || `http://localhost:${PORT}`;
  const oauthProvider = new InviteCodeOAuthProvider(db);

  const { mcpAuthRouter } = await import("@modelcontextprotocol/sdk/server/auth/router.js");
  const { requireBearerAuth } = await import("@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js");
  const { getOAuthProtectedResourceMetadataUrl } = await import("@modelcontextprotocol/sdk/server/auth/router.js");

  app.use(mcpAuthRouter({
    provider: oauthProvider,
    issuerUrl: new URL(SERVER_URL),
    resourceServerUrl: new URL("/mcp", SERVER_URL),
    scopesSupported: [],
    resourceName: "Cross-Claude MCP",
    serviceDocumentationUrl: new URL("/readme", SERVER_URL),
  }));

  // Invite code form submission (url-encoded form POST)
  const urlencoded = (await import("express")).default.urlencoded({ extended: false });
  app.post("/authorize/submit", urlencoded, createAuthorizeSubmitHandler(db));

  const resourceMetadataUrl = getOAuthProtectedResourceMetadataUrl(new URL("/mcp", SERVER_URL));

  // --- Health check + README (no auth) ---

  app.get("/health", (req, res) => {
    const memUsage = process.memoryUsage();
    const poolStats = db.pool ? {
      total: db.pool.totalCount,
      idle: db.pool.idleCount,
      waiting: db.pool.waitingCount,
    } : null;

    res.json({
      status: "ok",
      server: "cross-claude-mcp",
      version: "2.0.0",
      rev: REV,
      epoch: EPOCH,
      host: CC_HOST,
      memory: {
        rss: memUsage.rss,
        heapUsed: memUsage.heapUsed,
        heapTotal: memUsage.heapTotal,
      },
      sessions: sessions.size,
      sseTransports: sseTransports.size,
      pool: poolStats,
    });
  });

  // --- Discovery beacon (no auth): who is the authoritative bus, and at what epoch ---
  // Clients probe this across loopback / LAN / tailnet and pick the highest epoch.
  app.get("/cc/whoami", (req, res) => {
    // Honour the host the client actually reached us on, so the advertised base_url is
    // usable by that client (loopback callers get 127.0.0.1; LAN/tailnet callers get the IP).
    const host = (req.headers.host || `${CC_HOST}:${PORT}`).split(",")[0].trim();
    res.json({
      role: "leader",
      host: CC_HOST,
      epoch: EPOCH,
      base_url: `http://${host}`,
      port: PORT,
      version: "2.0.0",
      rev: REV,
      dirty: REV_DIRTY,
      started_at: STARTED_AT,
    });
  });

  app.get("/readme", async (req, res) => {
    const { readFileSync } = await import("fs");
    const { join, dirname } = await import("path");
    const { fileURLToPath } = await import("url");
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const md = readFileSync(join(__dirname, "README.md"), "utf-8");

    const escaped = md
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/^### (.+)$/gm, '<h3>$1</h3>')
      .replace(/^## (.+)$/gm, '<h2>$1</h2>')
      .replace(/^# (.+)$/gm, '<h1>$1</h1>')
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/^- (.+)$/gm, '<li>$1</li>')
      .replace(/\n\n/g, '</p><p>')
      .replace(/\n/g, '<br>');

    res.type("html").send(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Cross-Claude MCP</title>
<style>body{max-width:800px;margin:40px auto;padding:0 20px;font-family:-apple-system,system-ui,sans-serif;line-height:1.6;color:#333}
code{background:#f4f4f4;padding:2px 6px;border-radius:3px;font-size:0.9em}
pre{background:#f4f4f4;padding:16px;border-radius:6px;overflow-x:auto}
h1{border-bottom:2px solid #eee;padding-bottom:8px}h2{border-bottom:1px solid #eee;padding-bottom:4px;margin-top:2em}
table{border-collapse:collapse;width:100%}th,td{border:1px solid #ddd;padding:8px;text-align:left}th{background:#f4f4f4}
li{margin:4px 0}</style></head>
<body><p>${escaped}</p></body></html>`);
  });

  // --- Live console (no auth): the browser UI is served by the bus itself, so it "lives in
  // the server" rather than as a loose file on someone's disk. The HTML is public; every API
  // call it makes still carries the bearer token the page prompts for. Read fresh each request
  // so edits ship without a restart. Served at both / and /console for convenience.
  const sendConsole = async (req, res) => {
    try {
      const { readFileSync } = await import("fs");
      const { join, dirname } = await import("path");
      const { fileURLToPath } = await import("url");
      const __dirname = dirname(fileURLToPath(import.meta.url));
      res.type("html").send(readFileSync(join(__dirname, "..", "cc-console.html"), "utf-8"));
    } catch (e) {
      res.status(500).type("text").send("console unavailable: " + e.message);
    }
  };
  app.get("/console", sendConsole);
  app.get("/", sendConsole);

  // --- OpenAPI spec (no auth, needed for ChatGPT Custom GPT Actions) ---

  app.get("/openapi.json", async (req, res) => {
    const { readFileSync } = await import("fs");
    const { join, dirname } = await import("path");
    const { fileURLToPath } = await import("url");
    const __dirname = dirname(fileURLToPath(import.meta.url));
    res.type("json").send(readFileSync(join(__dirname, "openapi.json"), "utf-8"));
  });

  // --- Auth: static API key (CLI/REST) OR OAuth bearer token (Claude Desktop) ---

  const API_TOKEN = process.env.MCP_API_KEY;

  const oauthBearerAuth = requireBearerAuth({
    verifier: oauthProvider,
    resourceMetadataUrl,
  });

  app.use((req, res, next) => {
    // Skip auth for public endpoints (the console HTML is public; its API calls still carry the token)
    if (req.path === "/health" || req.path === "/readme" || req.path.startsWith("/openapi.json") ||
        req.path === "/console" || req.path === "/") return next();
    // /cc/whoami is the unauthenticated discovery beacon — advertises host/epoch/base only,
    // never any secret. Discovery has to reach it before it has anything but the shared token.
    if (req.path === "/cc/whoami") return next();
    // Skip auth for OAuth endpoints (handled by mcpAuthRouter)
    if (req.path.startsWith("/.well-known/") || req.path === "/authorize" || req.path === "/authorize/submit" || req.path === "/token" || req.path === "/register" || req.path === "/revoke") return next();

    const authHeader = req.headers.authorization || "";

    // Try static API key first
    if (API_TOKEN) {
      const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : req.query.api_key || null;
      if (token && token === API_TOKEN) {
        console.log(`[AUTH OK] ${req.method} ${req.path} (api-key)`);
        return next();
      }
    }

    // Try OAuth bearer token
    if (authHeader.startsWith("Bearer ")) {
      return oauthBearerAuth(req, res, (err) => {
        if (err) return next(err);
        console.log(`[AUTH OK] ${req.method} ${req.path} (oauth)`);
        next();
      });
    }

    // No valid auth
    if (API_TOKEN) {
      console.log(`[AUTH FAIL] ${req.method} ${req.path}`);
      return res.status(401).json({ error: "Unauthorized" });
    }

    // No API_TOKEN configured — allow all (dev mode)
    next();
  });

  // --- REST API (for ChatGPT, Gemini, curl, etc.) ---

  app.use("/api", express.json(), createRestRouter(db));

  // --- Migration control plane (authed) ---

  // GET /cc/export — stream a transactionally-consistent snapshot of the live message DB.
  // Used by the current leader during `cc-bus migrate` to hand its state to the new host.
  app.get("/cc/export", async (req, res, next) => {
    try {
      if (!db.snapshot) return res.status(501).json({ error: "export only supported on SQLite bus" });
      const { tmpdir } = await import("os");
      const { join } = await import("path");
      const { createReadStream, unlink } = await import("fs");
      const { randomUUID } = await import("crypto");
      const snapPath = join(tmpdir(), `cc-export-${randomUUID()}.db`);
      await db.snapshot(snapPath);
      res.setHeader("Content-Type", "application/octet-stream");
      res.setHeader("X-CC-Epoch", String(EPOCH));
      const stream = createReadStream(snapPath);
      stream.on("close", () => unlink(snapPath, () => {}));
      stream.on("error", (e) => { unlink(snapPath, () => {}); next(e); });
      stream.pipe(res);
    } catch (e) { next(e); }
  });

  // POST /cc/stepdown — relinquish the leader role. Drop a marker the supervisor reads on
  // our exit so it drops to CLIENT (and does NOT re-elect itself to leader — the marker is
  // what distinguishes an intentional stepdown from a crash). Then ack and exit.
  app.post("/cc/stepdown", async (req, res) => {
    console.log("[CC] stepdown requested — exiting leader role");
    try {
      const { join } = await import("path");
      const { writeFileSync } = await import("fs");
      const { homedir } = await import("os");
      const dir = process.env.CC_DATA_DIR || join(homedir(), ".cross-claude-mcp");
      writeFileSync(join(dir, ".stepdown"), String(EPOCH));
    } catch {}
    res.json({ ok: true, host: CC_HOST, epoch: EPOCH });
    setTimeout(() => process.exit(0), 250);
  });

  // --- Streamable HTTP transport ---

  const sessions = new Map();

  // TTL eviction: sweep idle sessions every 60s
  const SESSION_IDLE_MS = 24 * 60 * 60 * 1000; // 24 hours
  const sweepSessions = () => {
    const now = Date.now();
    for (const [sid, entry] of sessions.entries()) {
      // Check if transport response is destroyed
      if (entry.transport._response?.destroyed === true) {
        console.log(`[SESSION EVICT] ${sid} (destroyed)`);
        entry.cleanup();
        try { entry.transport.close(); } catch {}
        sessions.delete(sid);
        continue;
      }
      // Check idle timeout
      if (now - entry.lastActivity > SESSION_IDLE_MS) {
        console.log(`[SESSION EVICT] ${sid} (idle ${Math.round((now - entry.lastActivity) / 1000)}s)`);
        entry.cleanup();
        try { entry.transport.close(); } catch {}
        sessions.delete(sid);
      }
    }
  };
  const sessionSweepInterval = setInterval(sweepSessions, 60_000);

  app.post("/mcp", express.json(), async (req, res) => {
    const sessionId = req.headers["mcp-session-id"];
    let session = sessionId ? sessions.get(sessionId) : null;

    if (!session) {
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
      });
      const server = new McpServer({ name: "cross-claude-mcp", version: "2.0.0" }, { capabilities: { tools: {}, experimental: { "claude/channel": {} } } });
      const cleanup = registerTools(server, db);

      await server.connect(transport);

      const sessionEntry = { server, transport, cleanup, lastActivity: Date.now() };

      transport.onclose = () => {
        const sid = transport.sessionId;
        if (sid && sessions.has(sid)) {
          cleanup();
          sessions.delete(sid);
        }
      };

      await transport.handleRequest(req, res, req.body);

      if (transport.sessionId) {
        sessions.set(transport.sessionId, sessionEntry);
      }
      return;
    }

    // Update lastActivity on every request
    session.lastActivity = Date.now();
    await session.transport.handleRequest(req, res, req.body);
  });

  app.get("/mcp", async (req, res) => {
    const sessionId = req.headers["mcp-session-id"];
    const session = sessionId ? sessions.get(sessionId) : null;

    if (!session) {
      res.status(400).json({ error: "No session. Send POST /mcp first to initialize." });
      return;
    }

    session.lastActivity = Date.now();
    await session.transport.handleRequest(req, res);
  });

  app.delete("/mcp", async (req, res) => {
    const sessionId = req.headers["mcp-session-id"];
    const session = sessionId ? sessions.get(sessionId) : null;

    if (session) {
      session.cleanup();
      await session.transport.close();
      sessions.delete(sessionId);
    }
    res.status(200).json({ ok: true });
  });

  // --- Legacy SSE transport ---

  const sseTransports = new Map();

  // TTL eviction: sweep idle SSE transports every 60s
  const sweepSSE = () => {
    const now = Date.now();
    for (const [sid, entry] of sseTransports.entries()) {
      // Check if transport response is destroyed
      if (entry.transport._response?.destroyed === true) {
        console.log(`[SSE EVICT] ${sid} (destroyed)`);
        entry.cleanup();
        try { entry.transport.close(); } catch {}
        sseTransports.delete(sid);
        continue;
      }
      // Check idle timeout
      if (now - entry.lastActivity > SESSION_IDLE_MS) {
        console.log(`[SSE EVICT] ${sid} (idle ${Math.round((now - entry.lastActivity) / 1000)}s)`);
        entry.cleanup();
        try { entry.transport.close(); } catch {}
        sseTransports.delete(sid);
      }
    }
  };
  const sseSweepInterval = setInterval(sweepSSE, 60_000);

  app.get("/sse", async (req, res) => {
    const transport = new SSEServerTransport("/messages", res);
    const server = new McpServer({ name: "cross-claude-mcp", version: "2.0.0" }, { capabilities: { tools: {}, experimental: { "claude/channel": {} } } });
    const cleanup = registerTools(server, db);

    sseTransports.set(transport.sessionId, { server, transport, cleanup, lastActivity: Date.now() });

    transport.onclose = () => {
      cleanup();
      sseTransports.delete(transport.sessionId);
    };

    await server.connect(transport);
    await transport.start();
  });

  app.post("/messages", express.json(), async (req, res) => {
    const sessionId = req.query.sessionId;
    const session = sessionId ? sseTransports.get(sessionId) : null;

    if (!session) {
      res.status(400).json({ error: "Invalid session ID" });
      return;
    }

    session.lastActivity = Date.now();
    await session.transport.handlePostMessage(req, res, req.body);
  });

  // --- Start ---

  // --- Auto-cleanup: delete data older than 7 days ---

  const CLEANUP_DAYS = parseInt(process.env.CLEANUP_DAYS) || 7;
  const CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

  async function runCleanup() {
    try {
      const result = await db.cleanup(CLEANUP_DAYS);
      const total = result.messages + result.instances + result.shared_data;
      if (total > 0) {
        console.log(`[CLEANUP] Removed ${result.messages} messages, ${result.instances} instances, ${result.shared_data} shared data (older than ${CLEANUP_DAYS} days)`);
      }
    } catch (err) {
      console.error(`[CLEANUP] Error: ${err.message}`);
    }
  }

  await runCleanup();
  const cleanupInterval = setInterval(runCleanup, CLEANUP_INTERVAL_MS);

  // Graceful shutdown: clean up intervals
  const shutdown = () => {
    clearInterval(sessionSweepInterval);
    clearInterval(sseSweepInterval);
    clearInterval(cleanupInterval);
    process.exit(0);
  };

  for (const signal of ["SIGTERM", "SIGINT"]) {
    process.on(signal, shutdown);
  }

  // --- Server-side self-demotion (zombie-leader guard) ---
  // A leader that discovers a STRICTLY higher-ranked peer for this bus steps itself down —
  // regardless of how it was born (`cc-bus start` election OR `cc-bus receive`/migrate promote)
  // and even if its supervisor died. Without this, a migrate-promoted leader that is later
  // superseded by a failover keeps serving a stale, forked DB as an invisible "zombie" (the
  // 2026-08 incident). It writes the same `.stepdown` marker POST /cc/stepdown uses, so the
  // supervisor drops to CLIENT rather than re-electing. FAIL-SAFE: only demote when a real
  // outranking peer is observed; a discovery miss or error NEVER demotes. EPOCH===0 means a
  // standalone/dev server not under the supervisor — it takes no part in the election.
  if (EPOCH > 0) {
    const { join } = await import("path");
    const { writeFileSync } = await import("fs");
    const { homedir } = await import("os");
    const dataDir = process.env.CC_DATA_DIR || join(homedir(), ".cross-claude-mcp");
    let demoting = false;
    const SELF_DEMOTE_MS = 15000;
    const selfDemoteIv = setInterval(async () => {
      if (demoting) return;
      let peer = null;
      try { peer = await resolveFull({ token: process.env.MCP_API_KEY, skipLoopback: true, skipSelf: true }); } catch { return; }
      if (!peer) return;
      const outranked = peer.epoch > EPOCH || (peer.epoch === EPOCH && String(peer.host).localeCompare(CC_HOST) < 0);
      if (!outranked) return;
      demoting = true;
      console.log(`[CC] outranked by ${peer.host} epoch ${peer.epoch} (I am ${CC_HOST} epoch ${EPOCH}) → self-demoting`);
      try { writeFileSync(join(dataDir, ".stepdown"), String(EPOCH)); } catch {}
      setTimeout(() => process.exit(0), 250);
    }, SELF_DEMOTE_MS);
    selfDemoteIv.unref?.();   // don't keep the process alive just for this timer
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`cross-claude-mcp v2.0.0 listening on port ${PORT}`);
    console.log(`  Mode:            Standard`);
    console.log(`  Streamable HTTP: POST/GET /mcp`);
    console.log(`  REST API:        /api/* (ChatGPT, Gemini, curl)`);
    console.log(`  Legacy SSE:      GET /sse, POST /messages`);
    console.log(`  Health:          GET /health`);
    console.log(`  Auth:            ${process.env.MCP_API_KEY ? "Bearer token required" : "NONE (set MCP_API_KEY)"}`);
    console.log(`  OAuth:           ${SERVER_URL}/.well-known/oauth-authorization-server`);
    console.log(`  Database:        ${process.env.DATABASE_URL ? "PostgreSQL" : "SQLite (local)"}`);
    console.log(`  Cleanup:         Every ${CLEANUP_DAYS} days (checks hourly)`);
  });
}

// --- Main ---

const db = await createDB();

if (process.env.PORT) {
  await startHTTP(db);
} else {
  await startStdio(db);
}
