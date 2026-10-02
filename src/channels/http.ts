import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createServer as createHttpsServer, type Server as HttpsServer } from "node:https";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { timingSafeEqual, type KeyObject } from "node:crypto";
import type { Logger } from "../types.js";
import type { Agent, ApproveFn } from "../core/agent.js";
import { buildServingReceipt, sha256Hex, newServingKey } from "../provider/index.js";

/** Anything that can produce Agent Arena stats (the Arena class). */
export interface ArenaLike {
  stats(): Promise<unknown>;
}

export interface HttpChannelOptions {
  agent: Agent;
  port: number;
  log: Logger;
  /** Bearer token required for POST /ask. If unset, /ask is disabled. */
  token?: string;
  /** PEM-encoded TLS certificate path (enables HTTPS when both cert + key are set). */
  tlsCert?: string;
  /** PEM-encoded TLS private key path. */
  tlsKey?: string;
  /** Max concurrent /ask requests (default: 4). */
  maxConcurrent?: number;
  /** Static info surfaced on /health (the node-visibility hook for the Monitor). */
  info: {
    version: string;
    model: string;
    economy: "on" | "off";
    mode: string;
    wallet?: string;
    chain?: string;
    chainNetwork?: string;
    chainId?: number;
    walletExplorer?: string;
  };
  /** Approver for /ask tasks. Default: deny — HTTP is non-interactive. */
  approve?: ApproveFn;
  /** When set, serves the Agent Arena web UI at /arena and JSON at /arena/stats. */
  arena?: ArenaLike;
}

/**
 * HTTP channel. `GET /health` is open (no secret) — this is the endpoint that
 * lets ARGUS be discovered as a live node by Alien Monitor and by container
 * healthchecks. `GET /health` exposes only non-sensitive runtime info (version,
 * model, uptime). Wallet/chain details are surfaced on the authenticated `GET
 * /status` endpoint instead. `POST /ask` is bearer-token gated and runs the agent.
 * Sensitive tools are deny-by-default here because there is no human in the loop.
 */
export class HttpChannel {
  private server?: Server | HttpsServer;
  private readonly startedAt = Date.now();
  private readonly tls: boolean;
  private arenaHtml: string | null = null;
  /** Stable per-process Ed25519 serving identity for provider receipts (G2). */
  private readonly servingKey: KeyObject = newServingKey();
  /** In-flight /ask requests counter for concurrency throttling. */
  private activeRequests = 0;
  private readonly maxConcurrent: number;

  constructor(private readonly o: HttpChannelOptions) {
    this.tls = !!(o.tlsCert && o.tlsKey);
    this.maxConcurrent = o.maxConcurrent ?? 4;
  }

  private getArenaHtml(): string {
    if (this.arenaHtml === null) {
      try {
        this.arenaHtml = readFileSync(fileURLToPath(new URL("../../web/arena.html", import.meta.url)), "utf8");
      } catch (err) {
        this.o.log.warn(`arena.html not found: ${(err as Error).message}`);
        this.arenaHtml = "<!doctype html><meta charset=utf-8><title>ARGUS Arena</title><body style=\"background:#05060f;color:#eaf0ff;font-family:system-ui;padding:40px\"><h1>🎮 Agent Arena</h1><p>UI asset missing — see <code>GET /arena/stats</code> for raw data.</p>";
      }
    }
    return this.arenaHtml;
  }

  async start(): Promise<void> {
    const handler = (req: IncomingMessage, res: ServerResponse) => {
      this.handle(req, res).catch((err) => {
        this.o.log.warn(`request error: ${(err as Error).message}`);
        if (!res.headersSent) json(res, 500, { error: "internal error" });
      });
    };

    if (this.tls) {
      const cert = readFileSync(this.o.tlsCert!);
      const key = readFileSync(this.o.tlsKey!);
      this.server = createHttpsServer({ cert, key }, handler);
    } else {
      this.server = createServer(handler);
    }

    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(this.o.port, () => resolve());
    });
    const proto = this.tls ? "https" : "http";
    this.o.log.info(`${proto} on :${this.o.port} — /health open, /ask ${this.o.token ? "token-gated" : "DISABLED (set ARGUS_HTTP_TOKEN)"}${this.tls ? ", TLS on" : ", cleartext — set ARGUS_TLS_CERT + ARGUS_TLS_KEY for HTTPS"}`);
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server?.close(() => resolve()) ?? resolve());
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = (req.url ?? "/").split("?")[0];
    const method = req.method ?? "GET";

    // ── /health: open, non-sensitive runtime info only (H2 fix: wallet/chain REMOVED) ──
    if (method === "GET" && url === "/health") {
      json(res, 200, {
        status: "ok",
        agent: "argus",
        version: this.o.info.version,
        model: this.o.info.model,
        economy: this.o.info.economy,
        mode: this.o.info.mode,
        uptimeSec: Math.round((Date.now() - this.startedAt) / 1000),
      });
      return;
    }

    // ── /status: authenticated subset (via token) — full info including wallet/chain ──
    if (method === "GET" && url === "/status") {
      if (!this.o.token) return json(res, 401, { error: "/status requires ARGUS_HTTP_TOKEN" });
      if (!checkToken(req.headers.authorization, this.o.token)) return json(res, 401, { error: "unauthorized" });
      const body: Record<string, unknown> = {
        status: "ok",
        agent: "argus",
        version: this.o.info.version,
        model: this.o.info.model,
        economy: this.o.info.economy,
        mode: this.o.info.mode,
        uptimeSec: Math.round((Date.now() - this.startedAt) / 1000),
      };
      if (this.o.info.wallet) body.wallet = this.o.info.wallet;
      if (this.o.info.chain) body.chain = this.o.info.chain;
      if (this.o.info.chainNetwork) body.chainNetwork = this.o.info.chainNetwork;
      if (this.o.info.chainId != null) body.chainId = this.o.info.chainId;
      if (this.o.info.walletExplorer) body.walletExplorer = this.o.info.walletExplorer;
      json(res, 200, body);
      return;
    }

    if (this.o.arena && method === "GET" && (url === "/arena" || url === "/arena/")) {
      const html = this.getArenaHtml();
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-length": Buffer.byteLength(html) });
      res.end(html);
      return;
    }
    if (this.o.arena && method === "GET" && url === "/arena/stats") {
      const stats = await this.o.arena.stats();
      const body: Record<string, unknown> = {
        ...(stats as object),
        economy: this.o.info.economy,
        mode: this.o.info.mode,
        uptimeSec: Math.round((Date.now() - this.startedAt) / 1000),
      };
      if (this.o.info.wallet) body.wallet = this.o.info.wallet;
      if (this.o.info.chainNetwork) body.chainNetwork = this.o.info.chainNetwork;
      if (this.o.info.chainId != null) body.chainId = this.o.info.chainId;
      if (this.o.info.walletExplorer) body.walletExplorer = this.o.info.walletExplorer;
      json(res, 200, body);
      return;
    }

    // ── POST /ask: token-gated, concurrency-throttled, agent run (C1 fix: try/finally) ──
    if (method === "POST" && url === "/ask") {
      if (!this.o.token) return json(res, 503, { error: "/ask disabled — set ARGUS_HTTP_TOKEN" });
      if (!checkToken(req.headers.authorization, this.o.token)) return json(res, 401, { error: "unauthorized" });
      // Concurrency gate: single try/finally wraps everything after the increment
      // so a request that fails mid-flight (parse error, body too large, connection
      // drop) always releases its slot. The check is BEFORE any await, so the
      // check-and-increment is atomic in the Node event loop.
      if (this.activeRequests >= this.maxConcurrent) return json(res, 429, { error: "too many concurrent requests" });
      this.activeRequests += 1;
      try {
        const body = await readBody(req).catch(() => "");
        let task = "";
        try {
          task = String(JSON.parse(body || "{}").task ?? "").trim();
        } catch {
          return json(res, 400, { error: "invalid JSON body" });
        }
        if (!task) return json(res, 400, { error: "missing 'task'" });
        if (task.length > 32_000) return json(res, 413, { error: "task too long (max 32000 chars)" });
        const result = await this.o.agent.run(task, { approve: this.o.approve ?? (async () => false) });
        // Provider primitive (G2): a verifiable receipt that THIS request→answer was
        // served by this provider. Settlement (when priced) rides the AIMarket escrow.
        const receipt = buildServingReceipt(
          {
            capability: "argus_ask",
            requestHash: sha256Hex(task),
            answerHash: sha256Hex(result.answer),
            priceUsd: Number(process.env.ARGUS_SERVE_PRICE_USD ?? 0) || 0,
            providerId: this.o.info.wallet ?? "argus",
            timestamp: new Date().toISOString(),
          },
          this.servingKey,
        );
        json(res, 200, { answer: result.answer, meter: result.meter, outcome: result.outcome, receipt });
        return;
      } finally {
        this.activeRequests -= 1;
      }
    }

    json(res, 404, {
      error: "not found",
      routes: ["GET /health", "GET /status", "POST /ask", ...(this.o.arena ? ["GET /arena", "GET /arena/stats"] : [])],
    });
  }
}

function json(res: ServerResponse, code: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(code, { "content-type": "application/json", "content-length": Buffer.byteLength(payload) });
  res.end(payload);
}

/**
 * Constant-time bearer token check. Avoids the timing side-channel inherent in
 * JavaScript string `===` (which short-circuits on first mismatch). Uses latin1
 * encoding (single-byte-per-codepoint) so every byte of the input is preserved
 * byte-for-byte — no silent substitution of invalid UTF-8 sequences (M1 fix).
 */
function checkToken(authorization: string | undefined, expected: string): boolean {
  if (!authorization) return false;
  const prefix = "Bearer ";
  if (!authorization.startsWith(prefix)) return false;
  const got = authorization.slice(prefix.length);
  // Validate that the token is ASCII-safe (bearer tokens are base62/base64).
  // Non-ASCII bytes would indicate a malformed or malicious request.
  if (!/^[\x20-\x7e]+$/.test(got)) return false;
  const gotBuf = Buffer.from(got, "latin1");
  const expBuf = Buffer.from(expected, "latin1");
  if (gotBuf.length !== expBuf.length) return false;
  return timingSafeEqual(gotBuf, expBuf);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > 1_000_000) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      data += c;
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}
