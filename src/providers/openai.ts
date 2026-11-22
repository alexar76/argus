import type { LLMRequest, LLMResponse, Message, Provider, ProviderKind, StopReason, ToolCall } from "../types.js";
import { modelResponse, type ModelUsageSink } from "./model-usage.js";

export interface OpenAICompatOptions {
  id: string;
  kind?: ProviderKind;
  baseUrl: string;
  apiKey?: string;
  timeoutMs?: number;
  usageSink?: ModelUsageSink;
}

/**
 * Adapter for any OpenAI-compatible chat-completions endpoint:
 * OpenAI, DeepSeek, Qwen/DashScope, Zhipu GLM, Moonshot/Kimi, MiniMax,
 * Mistral, Groq, Together, OpenRouter, vLLM, Ollama (kind "local"), ...
 */
export class OpenAICompatProvider implements Provider {
  readonly id: string;
  readonly kind: ProviderKind;
  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly timeoutMs: number;
  private readonly usageSink?: ModelUsageSink;

  constructor(opts: OpenAICompatOptions) {
    this.id = opts.id;
    this.kind = opts.kind ?? "openai";
    this.baseUrl = opts.baseUrl.replace(/\/$/, "");
    this.apiKey = opts.apiKey;
    this.timeoutMs = opts.timeoutMs ?? 120_000;
    this.usageSink = opts.usageSink;
  }

  async chat(req: LLMRequest): Promise<LLMResponse> {
    const messages = this.toOpenAIMessages(req);
    const body: Record<string, unknown> = {
      model: req.model,
      messages,
      max_tokens: req.maxTokens ?? 4096,
      temperature: req.temperature ?? 0.7,
    };
    if (req.tools?.length) {
      body.tools = req.tools.map((t) => ({
        type: "function",
        function: { name: t.name, description: t.description, parameters: t.inputSchema },
      }));
      body.tool_choice = "auto";
    }

    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;

    const json = await modelResponse({
      endpoint: `${this.baseUrl}/chat/completions`, provider: this.id, wire: "openai",
      request: req, body, headers, timeoutMs: this.timeoutMs, sink: this.usageSink,
    });
    const choice = json.choices?.[0] ?? {};
    const msg = choice.message ?? {};
    const toolCalls: ToolCall[] = (msg.tool_calls ?? []).map((tc: any) => ({
      id: tc.id ?? `call_${Math.abs(hash(JSON.stringify(tc)))}`,
      name: tc.function?.name ?? "unknown",
      arguments: safeParse(tc.function?.arguments),
    }));

    const usage = json.usage ?? {};
    return {
      content: msg.content ?? "",
      toolCalls,
      usage: {
        inputTokens: usage.prompt_tokens ?? 0,
        outputTokens: usage.completion_tokens ?? 0,
        cachedInputTokens: usage.prompt_tokens_details?.cached_tokens ?? 0,
      },
      stopReason: mapFinish(choice.finish_reason),
      model: json.model ?? req.model,
    };
  }

  private toOpenAIMessages(req: LLMRequest): unknown[] {
    const out: unknown[] = [];
    if (req.system) out.push({ role: "system", content: req.system });
    for (const m of req.messages) out.push(toOpenAIMessage(m));
    return out;
  }
}

function toOpenAIMessage(m: Message): unknown {
  if (m.role === "tool") {
    return { role: "tool", tool_call_id: m.toolCallId, content: m.content };
  }
  if (m.role === "assistant" && m.toolCalls?.length) {
    return {
      role: "assistant",
      content: m.content || null,
      tool_calls: m.toolCalls.map((tc) => ({
        id: tc.id,
        type: "function",
        function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
      })),
    };
  }
  return { role: m.role, content: m.content };
}

function mapFinish(reason: string | undefined): StopReason {
  switch (reason) {
    case "tool_calls":
    case "function_call":
      return "tool_use";
    case "length":
      return "length";
    case "stop":
      return "stop";
    default:
      return "stop";
  }
}

function safeParse(s: string | undefined): Record<string, unknown> {
  if (!s) return {};
  try {
    return JSON.parse(s);
  } catch {
    return { _raw: s };
  }
}

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return h;
}
