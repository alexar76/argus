import type { Logger } from "../types.js";
import type { Agent } from "../core/agent.js";
import { VERSION } from "../cli/util.js";

export interface McpServerChannelOptions {
  agent: Agent;
  log: Logger;
}

const TOOLS = [
  {
    name: "argus_ask",
    description: "Ask ARGUS — a security-hardened personal agent — to perform a task and return the answer.",
    inputSchema: {
      type: "object",
      properties: { task: { type: "string", description: "The task or question for ARGUS." } },
      required: ["task"],
    },
  },
  {
    name: "argus_status",
    description: "Report ARGUS availability.",
    inputSchema: { type: "object", properties: {} },
  },
];

/**
 * MCP-server mode: ARGUS exposes ITSELF as an MCP server (stdio), so other
 * agents, IDEs (Claude Desktop, Cursor) and — via the economy — paying callers
 * can use it as a tool. This is the provider / "sell my capability" channel.
 *
 * Protocol note: stdout is reserved for the MCP wire protocol; all logging goes
 * to stderr (the project logger). Sensitive tools are deny-by-default — there is
 * no interactive human to approve them over MCP.
 */
export class McpServerChannel {
  private server: any;

  constructor(private readonly o: McpServerChannelOptions) {}

  async start(): Promise<void> {
    let Server: any, StdioServerTransport: any, ListToolsRequestSchema: any, CallToolRequestSchema: any;
    try {
      ({ Server } = await import("@modelcontextprotocol/sdk/server/index.js"));
      ({ StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js"));
      ({ ListToolsRequestSchema, CallToolRequestSchema } = await import("@modelcontextprotocol/sdk/types.js"));
    } catch (err) {
      throw new Error(`@modelcontextprotocol/sdk not available: ${(err as Error).message}`);
    }

    const server = new Server({ name: "argus", version: VERSION }, { capabilities: { tools: {} } });

    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

    server.setRequestHandler(CallToolRequestSchema, async (req: any) => {
      const name = req.params?.name;
      const args = req.params?.arguments ?? {};
      if (name === "argus_ask") {
        const task = String(args.task ?? "").trim();
        if (!task) return { content: [{ type: "text", text: "missing 'task'" }], isError: true };
        const r = await this.o.agent.run(task, { approve: async () => false });
        return { content: [{ type: "text", text: r.answer || "(no answer)" }], isError: r.outcome === "failure" };
      }
      if (name === "argus_status") {
        return { content: [{ type: "text", text: "ARGUS online (MCP server mode)." }] };
      }
      return { content: [{ type: "text", text: `unknown tool: ${name}` }], isError: true };
    });

    this.server = server;
    const transport = new StdioServerTransport();
    await server.connect(transport);
    this.o.log.info("MCP server (stdio) ready — tools: argus_ask, argus_status");
  }

  async stop(): Promise<void> {
    try {
      await this.server?.close?.();
    } catch {
      /* ignore */
    }
  }
}
