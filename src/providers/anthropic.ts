import type { LLMRequest, LLMResponse, Message, Provider, ProviderKind, StopReason, ToolCall } from "../types.js";

export interface AnthropicOptions {
  id?: string;
  apiKey: string;
  baseUrl?: string;
  version?: string;
  timeoutMs?: number;
}

/**
 * Anthropic-native adapter (Claude Opus/Sonnet/Haiku/Fable). Uses the Messages
 * API with first-class prompt caching via `cache_control`, which is the single
 * biggest token-economy lever for a long-lived agent: the stable system prompt
 * and tool definitions are cached across every step of a task.
 */
export class AnthropicProvider implements Provider {
  readonly id: string;
  readonly kind: ProviderKind = "anthropic";
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly version: string;
  private readonly timeoutMs: number;

  constructor(opts: AnthropicOptions) {
    this.id = opts.id ?? "anthropic";
    this.apiKey = opts.apiKey;
    this.baseUrl = (opts.baseUrl ?? "https://api.anthropic.com").replace(/\/$/, "");
    this.version = opts.version ?? "2023-06-01";
    this.timeoutMs = opts.timeoutMs ?? 120_000;
  }

  async chat(req: LLMRequest): Promise<LLMResponse> {
    const body: Record<string, unknown> = {
      model: req.model,
      max_tokens: req.maxTokens ?? 4096,
      temperature: req.temperature ?? 0.7,
      messages: this.toAnthropicMessages(req.messages),
    };

    if (req.system) {
      body.system = req.cachePrefix
        ? [{ type: "text", text: req.system, cache_control: { type: "ephemeral" } }]
        : req.system;
    }

    if (req.tools?.length) {
      const tools = req.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.inputSchema,
      })) as any[];
      // Cache the whole tool block by marking the last tool.
      if (req.cachePrefix && tools.length) {
        tools[tools.length - 1] = { ...tools[tools.length - 1], cache_control: { type: "ephemeral" } };
      }
      body.tools = tools;
    }

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    const signal = req.signal ?? ctrl.signal;
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/v1/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": this.apiKey,
          "anthropic-version": this.version,
        },
        body: JSON.stringify(body),
        signal,
      });
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`anthropic HTTP ${res.status}: ${text.slice(0, 500)}`);
    }

    const json: any = await res.json();
    const blocks: any[] = json.content ?? [];
    let content = "";
    const toolCalls: ToolCall[] = [];
    for (const b of blocks) {
      if (b.type === "text") content += b.text;
      else if (b.type === "tool_use") toolCalls.push({ id: b.id, name: b.name, arguments: b.input ?? {} });
    }

    const u = json.usage ?? {};
    return {
      content,
      toolCalls,
      usage: {
        inputTokens: u.input_tokens ?? 0,
        outputTokens: u.output_tokens ?? 0,
        cachedInputTokens: u.cache_read_input_tokens ?? 0,
      },
      stopReason: mapStop(json.stop_reason),
      model: json.model ?? req.model,
    };
  }

  private toAnthropicMessages(messages: Message[]): unknown[] {
    const out: unknown[] = [];
    for (const m of messages) {
      if (m.role === "system") continue; // system handled separately
      if (m.role === "tool") {
        out.push({
          role: "user",
          content: [{ type: "tool_result", tool_use_id: m.toolCallId, content: m.content }],
        });
        continue;
      }
      if (m.role === "assistant" && m.toolCalls?.length) {
        const content: unknown[] = [];
        if (m.content) content.push({ type: "text", text: m.content });
        for (const tc of m.toolCalls) content.push({ type: "tool_use", id: tc.id, name: tc.name, input: tc.arguments });
        out.push({ role: "assistant", content });
        continue;
      }
      out.push({ role: m.role, content: m.content });
    }
    return out;
  }
}

function mapStop(reason: string | undefined): StopReason {
  switch (reason) {
    case "tool_use":
      return "tool_use";
    case "max_tokens":
      return "length";
    case "end_turn":
    case "stop_sequence":
      return "stop";
    default:
      return "stop";
  }
}
