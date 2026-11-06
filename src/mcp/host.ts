import type { Logger, McpServerRef, Tool, ToolContext, ToolDef, ToolResult, WardenVerdict } from "../types.js";
import { VERSION } from "../cli/util.js";
import { isDeepStrictEqual } from "node:util";
import { isSensitiveTool, type Warden } from "@aimarket/warden";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import type { WardenPolicy } from "../types.js";
import { homedir } from "node:os";
import { join } from "node:path";
import { planLaunch, type SandboxContext, type SandboxedServerRef } from "./sandbox.js";

/** Minimal shape of @modelcontextprotocol/sdk we use (decoupled for resilience). */
export interface McpClient {
  connect(transport: unknown): Promise<void>;
  listTools(params?: { cursor?: string }): Promise<{ tools: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown>; [key: string]: unknown }>; nextCursor?: string }>;
  setNotificationHandler(schema: typeof ToolListChangedNotificationSchema, handler: () => void): void;
  callTool(args: { name: string; arguments: Record<string, unknown> }): Promise<{
    content?: Array<{ type: string; text?: string; [k: string]: unknown }>;
    isError?: boolean;
  }>;
  close(): Promise<void>;
}

/**
 * What became of one MCP server ARGUS was told to use. Carries only the server's id (cleaned)
 * and WARDEN finding codes, never text the server sent, because it reaches the owner's chat
 * and `/status`.
 */
export interface McpServerState {
  id: string;
  /** "config" for a server in mcp.servers; "catalog" for one a remote catalog listed (its id is remote text). */
  source: "config" | "catalog";
  /** "failed": not reachable, refused to launch, or its tool list could not be read. */
  state: "connected" | "blocked" | "failed";
  /** The blocking WARDEN codes for "blocked" (e.g. TOOL_DEF_DRIFT); empty otherwise. */
  reasons: string[];
  since: string;
}

/** A server id fit for a log line or a chat message: catalog-discovered ids are remote text. */
export function safeServerId(id: string): string {
  return (String(id).replace(/[^A-Za-z0-9._-]/g, "?").slice(0, 64)) || "?";
}

function blockingCodes(verdict: WardenVerdict): string[] {
  const blocking = (verdict.findings ?? []).filter((f) => !f.advisory);
  const codes = (blocking.length ? blocking : verdict.findings ?? []).map((f) => String(f.code));
  return [...new Set(codes.map((c) => (/^[A-Z0-9_]{1,48}$/.test(c) ? c : "OTHER")))].slice(0, 4);
}

interface Connection {
  server: McpServerRef;
  client: McpClient;
  tools: ToolDef[];
  verdict: WardenVerdict;
  quarantined: boolean;
  generation: number;
  refresh?: Promise<void>;
}

/**
 * MCP host. Connects to MCP servers and exposes their tools to the agent — but
 * ONLY after WARDEN has vetted the server. Tool defs are listed first, run
 * through the firewall, and blocked tools never reach the model. Sensitive tools
 * are surfaced (via WardenVerdict) so the agent loop can require user approval.
 */
export class McpHost {
  private readonly conns = new Map<string, Connection>();
  private readonly states = new Map<string, McpServerState>();
  /** Called when a server becomes blocked (not again while it stays blocked for the same reasons). */
  onBlocked?: (state: McpServerState) => void;

  constructor(
    private readonly warden: Warden,
    private readonly policy: WardenPolicy,
    private readonly log: Logger,
    private readonly clientFactory?: (server: McpServerRef) => Promise<McpClient>,
    /** Process isolation for stdio servers (see sandbox.ts). Absent → "auto" over ~/.argus. */
    private readonly sandbox?: SandboxContext,
  ) {}

  /**
   * Every server this host was asked to connect, and how that went. A blocked server stays
   * blocked until someone approves it and ARGUS restarts, and ARGUS goes on running without
   * its tools. In November 2026 our own hub sat blocked like that for days on every ARGUS,
   * each of them reporting healthy, so the state is kept here for /health and the owner.
   */
  serverStates(): McpServerState[] {
    return [...this.states.values()].map((s) => ({ ...s, reasons: [...s.reasons] }));
  }

  private mark(server: McpServerRef, state: McpServerState["state"], reasons: string[] = []): void {
    const id = safeServerId(server.id);
    const prev = this.states.get(id);
    const same = prev && prev.state === state && prev.reasons.join() === reasons.join();
    const next: McpServerState = { id, source: server.catalog ? "catalog" : "config", state, reasons,
      since: same ? prev.since : new Date().toISOString() };
    this.states.set(id, next);
    if (state === "blocked" && !same && this.onBlocked) {
      try { this.onBlocked({ ...next, reasons: [...reasons] }); } catch { /* a listener never breaks a connection */ }
    }
  }

  /** Connect + vet a server. Returns the verdict; throws if WARDEN blocks it. */
  async connect(server: McpServerRef): Promise<WardenVerdict> {
    try {
      const verdict = await this.open(server);
      this.mark(server, "connected");
      return verdict;
    } catch (err) {
      if (err instanceof WardenBlockedError) this.mark(server, "blocked", blockingCodes(err.verdict));
      else this.mark(server, "failed");
      throw err;
    }
  }

  private async open(server: McpServerRef): Promise<WardenVerdict> {
    server = structuredClone(server);
    const launch = await this.warden.vetLaunch(server);
    if (!launch.allow) throw new WardenBlockedError(server, launch);
    const client = await (this.clientFactory ? this.clientFactory(server) : this.makeClient(server));
    const conn: Connection = { server: structuredClone(server), client, tools: [], verdict: launch, quarantined: true, generation: 0 };
    try {
      client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
        conn.quarantined = true;
        conn.generation++;
        void this.refresh(conn).catch(err => this.log.warn(`MCP tools changed; server quarantined: ${(err as Error).message}`));
      });
      await this.refresh(conn);
      if (this.policy.pinToolDefs) await this.warden.approve(conn.server, conn.tools);
      const old = this.conns.get(server.id);
      if (old) { old.quarantined = true; await old.client.close().catch(() => {}); }
      this.conns.set(server.id, conn);
      this.log.info(`connected "${server.name}": ${conn.verdict.allowedTools.length} vetted tools.`);
      return conn.verdict;
    } catch (err) {
      conn.quarantined = true;
      await client.close().catch(() => {});
      throw err;
    }
  }

  private async listTools(client: McpClient): Promise<ToolDef[]> {
    const tools: ToolDef[] = [];
    const cursors = new Set<string>();
    const names = new Set<string>();
    let cursor: string | undefined;
    let bytes = 0;
    for (let page = 0; page < 32; page++) {
      const listed = await client.listTools(cursor ? { cursor } : undefined);
      if (!Array.isArray(listed.tools)) throw new Error("Invalid MCP tools/list");
      bytes += Buffer.byteLength(JSON.stringify(listed), "utf8");
      if (bytes > 1_048_576 || tools.length + listed.tools.length > 256) throw new Error("MCP tool definitions exceed limits");
      for (const t of listed.tools) {
        if (!t || typeof t.name !== "string" || !t.name || names.has(t.name) ||
            (t.description !== undefined && typeof t.description !== "string") ||
            (t.title !== undefined && typeof t.title !== "string")) throw new Error("Invalid or duplicate MCP tool definition");
        for (const key of ["inputSchema", "outputSchema", "annotations"]) {
          if (t[key] !== undefined && (!t[key] || typeof t[key] !== "object" || Array.isArray(t[key]))) throw new Error(`Invalid MCP ${key}`);
        }
        names.add(t.name);
        tools.push({ ...structuredClone(t), name: t.name, description: t.description ?? "", inputSchema: t.inputSchema ?? { type: "object", properties: {} } });
      }
      cursor = listed.nextCursor;
      if (!cursor) return tools;
      if (typeof cursor !== "string" || cursors.has(cursor)) throw new Error("Invalid MCP pagination cursor");
      cursors.add(cursor);
    }
    throw new Error("MCP tools/list page limit exceeded");
  }

  /**
   * List a server's tools for a human re-approval, without pinning or exposing them. `reviewer`
   * is a Warden whose pin store is empty, so every gate except pinning still decides — a
   * legacy or drifted pin is what is being reviewed, not a reason to refuse the review.
   */
  async review(server: McpServerRef, reviewer: Warden): Promise<{ tools: ToolDef[]; verdict: WardenVerdict }> {
    server = structuredClone(server);
    const launch = await reviewer.vetLaunch(server);
    if (!launch.allow) throw new WardenBlockedError(server, launch);
    const client = await (this.clientFactory ? this.clientFactory(server) : this.makeClient(server));
    try {
      const tools = await this.listTools(client);
      return { tools, verdict: await reviewer.vet(server, tools) };
    } finally {
      await client.close().catch(() => {});
    }
  }

  /** Coalesce overlapping checks; any notification during a check invalidates it. */
  private async refresh(conn: Connection): Promise<void> {
    if (conn.refresh) return conn.refresh;
    conn.quarantined = true;
    const generation = conn.generation;
    const work = (async () => {
      let tools: ToolDef[];
      try {
        tools = await this.listTools(conn.client);
      } catch (err) {
        // A server that stops answering after connect. connect() marks its own failures.
        if (this.conns.get(conn.server.id) === conn) this.mark(conn.server, "failed");
        throw err;
      }
      const verdict = await this.warden.vet(conn.server, tools);
      if (generation !== conn.generation) throw new Error("Tools changed during verification; retry after review");
      conn.verdict = verdict;
      if (!verdict.allow) {
        // A connected server whose tools changed under it lands here, not in connect().
        if (this.conns.get(conn.server.id) === conn) this.mark(conn.server, "blocked", blockingCodes(verdict));
        throw new WardenBlockedError(conn.server, verdict);
      }
      conn.tools = tools;
      conn.quarantined = false;
      if (this.conns.get(conn.server.id) === conn) this.mark(conn.server, "connected");
    })();
    conn.refresh = work;
    try { await work; }
    finally { if (conn.refresh === work) conn.refresh = undefined; }
  }

  /** All vetted, allowed tools across connected servers, as agent-facing Tools. */
  bridgedTools(): Tool[] {
    const out: Tool[] = [];
    for (const conn of this.conns.values()) {
      if (conn.quarantined || !conn.verdict.allow) continue;
      const blocked = new Set(conn.verdict.blockedTools);
      for (const def of conn.tools) {
        if (blocked.has(def.name)) continue;
        out.push(this.wrap(conn, def));
      }
    }
    return out;
  }

  private wrap(conn: Connection, def: ToolDef): Tool {
    const sensitive = isSensitiveTool(def.name, this.policy);
    // Namespacing avoids cross-server shadowing of the same tool name.
    const exposedName = `${conn.server.id}__${def.name}`;
    return {
      def: { ...structuredClone(def), name: exposedName },
      source: { kind: "mcp", server: conn.server.id },
      run: async (args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> => {
        if (sensitive && !ctx.approved) {
          return { ok: false, content: `[blocked] "${def.name}" is sensitive and was not approved by the user.` };
        }
        try {
          if (this.conns.get(conn.server.id) !== conn) throw new Error("MCP connection was closed or replaced");
          // Also catch servers that omit list_changed notifications. The wrapper
          // is bound to what the model/user actually saw, not just the tool name.
          await this.refresh(conn);
          const current = conn.tools.find(t => t.name === def.name);
          // Structural equality, not a hash: a host's own before/after comparison needs no canonical
          // form, and canonicalToolsHash refuses fractional numbers ("default": 0.7), which made every
          // call to such a tool fail.
          if (conn.quarantined || !current || !isDeepStrictEqual(current, def)) {
            throw new Error("Tool changed since exposure; refresh tools and obtain approval again");
          }
          const generation = conn.generation;
          const r = await conn.client.callTool({ name: def.name, arguments: args });
          if (conn.quarantined || generation !== conn.generation || this.conns.get(conn.server.id) !== conn) {
            throw new Error("Tools changed during execution; result withheld, execution may already have occurred");
          }
          const text = (r.content ?? [])
            .map((c) => (c.type === "text" ? c.text ?? "" : `[${c.type}]`))
            .join("\n")
            .trim();
          return { ok: !r.isError, content: text || "(empty result)", data: r };
        } catch (err) {
          return { ok: false, content: `[error] ${def.name}: ${(err as Error).message}` };
        }
      },
    };
  }

  private async makeClient(server: McpServerRef): Promise<McpClient> {
    let ClientCtor: any;
    try {
      ({ Client: ClientCtor } = await import("@modelcontextprotocol/sdk/client/index.js"));
    } catch (err) {
      throw new Error(`@modelcontextprotocol/sdk not installed: ${(err as Error).message}`);
    }
    const client = new ClientCtor({ name: "argus", version: VERSION }, { capabilities: {} }) as McpClient;

    let transport: unknown;
    if (server.transport === "stdio") {
      if (!server.command) throw new Error(`server "${server.id}" missing command for stdio transport`);
      // Throws SandboxRefused when the server must not run at all (e.g. no sandbox on an
      // unattended host); nothing has been spawned at that point.
      const plan = planLaunch(server as SandboxedServerRef, cleanEnv(server.env), this.sandbox ?? {
        stateDir: join(homedir(), ".argus"),
        production: false,
      });
      if (plan.warning) this.log.warn(plan.warning);
      else this.log.info(`starting "${server.id}" in ${plan.note}`);
      const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
      transport = new StdioClientTransport({
        command: plan.command,
        args: plan.args,
        env: plan.env,
        cwd: plan.cwd,
      });
    } else if (server.transport === "sse") {
      if (!server.url) throw new Error(`server "${server.id}" missing url for sse transport`);
      const { SSEClientTransport } = await import("@modelcontextprotocol/sdk/client/sse.js");
      transport = new SSEClientTransport(new URL(server.url));
    } else {
      if (!server.url) throw new Error(`server "${server.id}" missing url for http transport`);
      const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
      transport = new StreamableHTTPClientTransport(new URL(server.url));
    }
    try { await client.connect(transport); return client; }
    catch (err) { await client.close().catch(() => {}); throw err; }
  }

  async closeAll(): Promise<void> {
    const connections = [...this.conns.values()];
    this.conns.clear();
    this.states.clear();
    for (const c of connections) { c.quarantined = true; await c.client.close().catch(() => {}); }
  }
}

export class WardenBlockedError extends Error {
  constructor(public readonly server: McpServerRef, public readonly verdict: WardenVerdict) {
    super(`WARDEN blocked MCP server "${server.name}"`);
    this.name = "WardenBlockedError";
  }
}

// SECURITY: third-party MCP servers are spawned with an ALLOW-LIST env only.
// Never forward ARGUS_*/API keys/tokens/the wallet key+seed to untrusted children
// — that would defeat WARDEN and the "agent only ever sees the public address"
// invariant. Only harmless OS vars + the server's own operator-declared env pass.
const ENV_PASSTHROUGH = [
  "PATH", "HOME", "LANG", "LC_ALL", "LC_CTYPE", "TZ", "TMPDIR", "TEMP", "TMP",
  "SHELL", "USER", "LOGNAME", "TERM", "SystemRoot", "NODE_PATH",
];

function cleanEnv(env?: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of ENV_PASSTHROUGH) {
    const v = process.env[k];
    if (typeof v === "string") out[k] = v;
  }
  // Operator-declared, per-server env (intentional) is layered on top.
  if (env) for (const [k, v] of Object.entries(env)) out[k] = v;
  return out;
}
