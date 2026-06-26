import type { Logger, McpServerRef, Tool, ToolContext, ToolDef, ToolResult, WardenVerdict } from "../types.js";
import { VERSION } from "../cli/util.js";
import { isSensitiveTool } from "../warden/sandbox.js";
import type { Warden } from "../warden/index.js";
import type { WardenPolicy } from "../types.js";

/** Minimal shape of @modelcontextprotocol/sdk we use (decoupled for resilience). */
interface McpClient {
  connect(transport: unknown): Promise<void>;
  listTools(): Promise<{ tools: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }> }>;
  callTool(args: { name: string; arguments: Record<string, unknown> }): Promise<{
    content?: Array<{ type: string; text?: string; [k: string]: unknown }>;
    isError?: boolean;
  }>;
  close(): Promise<void>;
}

interface Connection {
  server: McpServerRef;
  client: McpClient;
  tools: ToolDef[];
  verdict: WardenVerdict;
}

/**
 * MCP host. Connects to MCP servers and exposes their tools to the agent — but
 * ONLY after WARDEN has vetted the server. Tool defs are listed first, run
 * through the firewall, and blocked tools never reach the model. Sensitive tools
 * are surfaced (via WardenVerdict) so the agent loop can require user approval.
 */
export class McpHost {
  private readonly conns = new Map<string, Connection>();

  constructor(
    private readonly warden: Warden,
    private readonly policy: WardenPolicy,
    private readonly log: Logger,
  ) {}

  /** Connect + vet a server. Returns the verdict; throws if WARDEN blocks it. */
  async connect(server: McpServerRef): Promise<WardenVerdict> {
    const client = await this.makeClient(server);
    const listed = await client.listTools();
    const tools: ToolDef[] = (listed.tools ?? []).map((t) => ({
      name: t.name,
      description: t.description ?? "",
      inputSchema: t.inputSchema ?? { type: "object", properties: {} },
    }));

    const verdict = await this.warden.vet(server, tools);
    if (!verdict.allow) {
      await client.close().catch(() => {});
      this.log.warn(`WARDEN blocked "${server.name}" (score ${verdict.score.toFixed(2)}, by ${verdict.decidedBy}).`);
      throw new WardenBlockedError(server, verdict);
    }

    // Pin the approved tool set so later drift is caught (rug-pull defense).
    // A pin failure is a security concern — drift detection is disabled for this server.
    // Log at WARN (not debug) so operators see it; the connection is still allowed since
    // the initial vetting passed, but the rug-pull defense is degraded.
    if (this.policy.pinToolDefs) {
      await this.warden.approve(server, tools).catch((e) => {
        this.log.warn(`pin failed for "${server.name}" — drift detection DISABLED for this connection: ${(e as Error).message}`);
      });
    }

    this.conns.set(server.id, { server, client, tools, verdict });
    this.log.info(
      `connected "${server.name}": ${verdict.allowedTools.length} tools allowed, ` +
        `${verdict.blockedTools.length} blocked (score ${verdict.score.toFixed(2)}).`,
    );
    return verdict;
  }

  /** All vetted, allowed tools across connected servers, as agent-facing Tools. */
  bridgedTools(): Tool[] {
    const out: Tool[] = [];
    for (const conn of this.conns.values()) {
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
      def: { ...def, name: exposedName },
      source: { kind: "mcp", server: conn.server.id },
      run: async (args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> => {
        if (sensitive && !ctx.approved) {
          return { ok: false, content: `[blocked] "${def.name}" is sensitive and was not approved by the user.` };
        }
        try {
          const r = await conn.client.callTool({ name: def.name, arguments: args });
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
      const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
      transport = new StdioClientTransport({
        command: server.command,
        args: server.args ?? [],
        env: cleanEnv(server.env),
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
    await client.connect(transport);
    return client;
  }

  async closeAll(): Promise<void> {
    for (const c of this.conns.values()) await c.client.close().catch(() => {});
    this.conns.clear();
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
