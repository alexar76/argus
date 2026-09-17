import type { Logger } from "../types.js";
import type { Agent } from "../core/agent.js";
import { VERSION } from "../cli/util.js";

export interface McpServerChannelOptions {
  agent: Agent;
  log: Logger;
}

/**
 * Glama TDQS targets (from live score rubric on argus_ask @ 2.9/5):
 * Behavior, Completeness, Parameters, Purpose, Usage Guidelines + MCP annotations.
 * Conciseness: front-load the first sentence; keep body tight.
 */
const TOOLS = [
  {
    name: "argus_ask",
    description:
      "Run one bounded natural-language task through the ARGUS-3 agent and return the final answer text.\n\n" +
      "When to use: research, summarise, debug, or draft when you want a WARDEN-hardened agent " +
      "(not a raw model completion). Prefer argus_status first if you only need liveness; prefer " +
      "argus_capabilities for the tool/WARDEN catalog without spending LLM tokens.\n\n" +
      "When NOT to use: interactive multi-turn chat (use Telegram/HTTP channels); tasks that need " +
      "human approval for sensitive tools (stdio denies them); pasting secrets into `task`.\n\n" +
      "Side effects / auth / limits: calls your configured LLM provider (API key from env/config); " +
      "may invoke ARGUS-configured tools; third-party MCP tools run only after WARDEN gates " +
      "(static scan → threat feed → LUMEN → def-pinning). Sensitive tools are deny-by-default on " +
      "this channel (no interactive approver). Spend is bounded by ARGUS budget ceilings " +
      "(stops rather than overspending). Not idempotent — each call is a new metered run. " +
      "May use network (model + allowed tools).\n\n" +
      "Returns: plain-text final answer. On failure or budget stop, text may still be returned " +
      "with isError true. No streaming / partial events on this tool.\n\n" +
      "Example: argus_ask({ task: \"Summarise https://example.com in three bullets\", response_format: \"bullets\" })",
    annotations: {
      title: "Ask ARGUS",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputSchema: {
      type: "object",
      properties: {
        task: {
          type: "string",
          minLength: 1,
          maxLength: 8000,
          description:
            "Required. Single clear goal for ARGUS (1..8000 chars). Include constraints " +
            "(length, format, tone) and any URLs/paths. Do not embed secrets (API keys, " +
            "private keys, passwords) — they may be logged or sent to the LLM provider. " +
            "Whitespace-only values are rejected.",
          examples: [
            "Summarise https://example.com in three bullets",
            "Explain why WARDEN would block a tool whose description asks for API keys",
            "Draft a short README blurb for an MCP server that exposes argus_ask",
          ],
        },
        response_format: {
          type: "string",
          enum: ["prose", "bullets", "json_hint"],
          default: "prose",
          description:
            "Optional output shape hint prepended to the task. `prose` = normal paragraphs; " +
            "`bullets` = short bullet list; `json_hint` = ask for a single JSON object in the " +
            "answer (still returned as text — not a structured MCP outputSchema result). " +
            "Default prose when omitted.",
          examples: ["bullets", "prose"],
        },
        focus: {
          type: "string",
          maxLength: 500,
          description:
            "Optional one-line emphasis (≤500 chars) appended as a constraint, e.g. " +
            "\"security only\" or \"ELI5\". Omit when the task is already specific enough.",
          examples: ["security only", "cite sources"],
        },
      },
      required: ["task"],
      additionalProperties: false,
    },
  },
  {
    name: "argus_status",
    description:
      "Return ARGUS-3 MCP runtime status as JSON text (no LLM call, no side effects).\n\n" +
      "When to use: before heavy argus_ask calls, or to confirm version/channel/tools. " +
      "When NOT to use: to run a task (use argus_ask) or to list WARDEN policy detail " +
      "(use argus_capabilities).\n\n" +
      "Auth / limits: none beyond MCP session. Idempotent and read-only.\n\n" +
      "Returns: JSON with status, agent, version, channel, mode, tools, detail, " +
      "wardenNote, sensitiveToolsPolicy (and extra fields when detail=full).\n\n" +
      "Example: argus_status({ detail: \"basic\" })",
    annotations: {
      title: "ARGUS status",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: "object",
      properties: {
        detail: {
          type: "string",
          enum: ["basic", "full"],
          default: "basic",
          description:
            "Response depth. `basic` = liveness + version + tool names. `full` adds " +
            "instructions excerpt, annotation summary, and MCP transport notes. Default basic.",
          examples: ["basic", "full"],
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "argus_capabilities",
    description:
      "List ARGUS MCP tools and WARDEN security posture as JSON text (no LLM call).\n\n" +
      "When to use: discovery — choose between argus_ask / argus_status / this catalog. " +
      "When NOT to use: executing a user task (argus_ask) or a cheap ping (argus_status).\n\n" +
      "Side effects: none. Read-only, idempotent, no provider auth required for this tool.\n\n" +
      "Returns: JSON { agent, version, tools[{name, readOnly, summary}], warden, " +
      "sensitiveToolsPolicy, channel }.\n\n" +
      "Example: argus_capabilities({ include_schemas: false })",
    annotations: {
      title: "ARGUS capabilities",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: "object",
      properties: {
        include_schemas: {
          type: "boolean",
          default: false,
          description:
            "If true, include each tool's inputSchema in the JSON (larger payload). " +
            "Default false — names + short summaries only.",
          examples: [false, true],
        },
      },
      additionalProperties: false,
    },
  },
];

const MCP_INSTRUCTIONS =
  "ARGUS-3 — WARDEN-hardened personal agent over MCP stdio.\n\n" +
  "Tools:\n" +
  "• argus_capabilities — catalog + WARDEN posture (read-only, no LLM)\n" +
  "• argus_status — liveness JSON (read-only, no LLM)\n" +
  "• argus_ask — bounded NL task via agent core (meters LLM; sensitive tools deny-by-default)\n\n" +
  "Call argus_capabilities or argus_status before argus_ask when unsure. " +
  "Do not put secrets in argus_ask.task. Third-party MCP tools used by the agent are gated by WARDEN.";

function formatAskTask(args: Record<string, unknown>): string {
  const task = String(args.task ?? "").trim();
  if (!task) return "";
  const parts: string[] = [task];
  const fmt = String(args.response_format ?? "prose").trim();
  if (fmt === "bullets") {
    parts.push("Respond as a short bullet list only.");
  } else if (fmt === "json_hint") {
    parts.push("Respond with a single JSON object in the answer text (no markdown fence required).");
  }
  const focus = String(args.focus ?? "").trim();
  if (focus) parts.push(`Focus: ${focus}`);
  return parts.join("\n\n");
}

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

    const server = new Server(
      { name: "argus", version: VERSION },
      { capabilities: { tools: {} }, instructions: MCP_INSTRUCTIONS },
    );

    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

    server.setRequestHandler(CallToolRequestSchema, async (req: any) => {
      const name = req.params?.name;
      const args = (req.params?.arguments ?? {}) as Record<string, unknown>;

      if (name === "argus_ask") {
        const task = formatAskTask(args);
        if (!task) {
          return {
            content: [
              {
                type: "text",
                text:
                  "missing 'task': pass a non-empty natural-language goal " +
                  '(e.g. "Summarise https://example.com in three bullets").',
              },
            ],
            isError: true,
          };
        }
        const r = await this.o.agent.run(task, { approve: async () => false });
        return { content: [{ type: "text", text: r.answer || "(no answer)" }], isError: r.outcome === "failure" };
      }

      if (name === "argus_status") {
        const detail = String(args.detail ?? "basic").trim() === "full" ? "full" : "basic";
        const payload: Record<string, unknown> = {
          status: "ok",
          agent: "argus",
          version: VERSION,
          channel: "mcp-stdio",
          mode: "mcp-server",
          detail,
          tools: TOOLS.map((t) => t.name),
          wardenNote:
            "Third-party MCP servers used by the agent are gated by WARDEN " +
            "(static scan → threat feed → LUMEN → def-pinning) before tools run.",
          sensitiveToolsPolicy: "deny-by-default on MCP stdio (no interactive approval)",
        };
        if (detail === "full") {
          payload.transport = "stdio (stdout = MCP wire; logs on stderr)";
          payload.annotations = TOOLS.map((t) => ({
            name: t.name,
            ...(t.annotations ?? {}),
          }));
          payload.instructionsExcerpt = MCP_INSTRUCTIONS.slice(0, 400);
        }
        return { content: [{ type: "text", text: JSON.stringify(payload) }] };
      }

      if (name === "argus_capabilities") {
        const includeSchemas = Boolean(args.include_schemas);
        const payload = {
          agent: "argus",
          version: VERSION,
          channel: "mcp-stdio",
          warden: {
            gates: ["static-scan", "threat-feed", "lumen-reputation", "def-pinning"],
            purpose: "Vet third-party MCP servers before any of their tools run inside ARGUS.",
          },
          sensitiveToolsPolicy: "deny-by-default on MCP stdio (no interactive approval)",
          tools: TOOLS.map((t) => ({
            name: t.name,
            readOnly: Boolean(t.annotations?.readOnlyHint),
            summary: String(t.description).split("\n\n")[0],
            ...(includeSchemas ? { inputSchema: t.inputSchema } : {}),
          })),
        };
        return { content: [{ type: "text", text: JSON.stringify(payload) }] };
      }

      return { content: [{ type: "text", text: `unknown tool: ${name}` }], isError: true };
    });

    this.server = server;
    const transport = new StdioServerTransport();
    await server.connect(transport);
    this.o.log.info("MCP server (stdio) ready — tools: argus_ask, argus_status, argus_capabilities");
  }

  async stop(): Promise<void> {
    try {
      await this.server?.close?.();
    } catch {
      /* ignore */
    }
  }
}
