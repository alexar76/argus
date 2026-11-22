import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { fetchNoRedirect } from "../credential-fetch.js";
import type { LLMRequest, Logger } from "../types.js";

export type ModelUsageSink = (row: Record<string, unknown>) => void;

export function modelUsageSink(stateDir: string, mode: string, log: Logger): ModelUsageSink {
  return (row) => {
    try {
      mkdirSync(stateDir, { recursive: true, mode: 0o700 });
      appendFileSync(join(stateDir, "model_usage.jsonl"), JSON.stringify({ ...row, mode }) + "\n", { mode: 0o600 });
    } catch {
      log.warn("Could not append ARGUS model usage");
    }
  };
}

function count(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function mcpServers(req: LLMRequest) {
  const groups = new Map<string, { server: string; tools: Set<string>; result_tools: Set<string> }>();
  function add(name: string, field: "tools" | "result_tools") {
    const server = req.mcpToolServers?.get(name);
    if (!server) return;
    let group = groups.get(server);
    if (!group) {
      group = { server, tools: new Set(), result_tools: new Set() };
      groups.set(server, group);
    }
    group[field].add(name);
  }
  for (const tool of req.tools ?? []) add(tool.name, "tools");
  for (const message of req.messages) {
    if (message.role === "tool" && message.name) add(message.name, "result_tools");
  }
  return [...groups.values()].map(({ server, tools, result_tools }) => ({
    server, tools: [...tools], result_tools: [...result_tools],
  }));
}

export async function modelResponse(opts: {
  endpoint: string;
  provider: string;
  wire: "openai" | "anthropic";
  request: LLMRequest;
  body: Record<string, unknown>;
  headers: Record<string, string>;
  timeoutMs: number;
  sink?: ModelUsageSink;
}): Promise<any> {
  const { endpoint, provider, wire, request, body, headers, timeoutMs, sink } = opts;
  const host = new URL(endpoint).hostname;
  if (host === "openrouter.ai" && wire === "openai") body.usage = { include: true };
  const payload = JSON.stringify(body);
  const started = performance.now();
  const timestamp = new Date().toISOString();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const signal = request.signal ?? ctrl.signal;
  let response: Response | undefined;
  let data: any;
  let outcome = "error";
  try {
    response = await fetchNoRedirect(endpoint, { method: "POST", headers, body: payload, signal });
    clearTimeout(timer);
    if (!response.ok) {
      const error = await response.text().catch(() => "");
      throw new Error(`${provider} HTTP ${response.status}: ${error.slice(0, 500)}`);
    }
    data = await response.json();
    outcome = data?.error ? "error" : "ok";
    return data;
  } catch (error) {
    if (signal.aborted) outcome = "cancelled";
    throw error;
  } finally {
    clearTimeout(timer);
    if (sink) {
      const usage = data?.usage ?? {};
      const anthropic = wire === "anthropic";
      const cacheRead = count(anthropic ? usage.cache_read_input_tokens : usage.prompt_tokens_details?.cached_tokens)
        ?? count(usage.prompt_cache_hit_tokens);
      const cacheWrite = count(anthropic ? usage.cache_creation_input_tokens : usage.prompt_tokens_details?.cache_write_tokens);
      const cacheMiss = count(anthropic ? usage.input_tokens : usage.prompt_cache_miss_tokens);
      const input = anthropic ? (cacheMiss === null ? null : cacheMiss + (cacheRead ?? 0) + (cacheWrite ?? 0))
        : count(usage.prompt_tokens);
      const cost = host === "openrouter.ai" ? usage.cost : null;
      sink({
        schema_version: 1,
        call_id: randomUUID(),
        timestamp,
        service: "argus",
        provider,
        provider_host: host,
        model: request.model,
        provider_model: typeof data?.model === "string" ? data.model : null,
        provider_generation_id: typeof data?.id === "string" ? data.id : null,
        provider_request_id: response?.headers?.get("request-id") ?? response?.headers?.get("x-request-id") ?? null,
        http_status: response?.status ?? null,
        outcome,
        latency_ms: Math.round((performance.now() - started) * 100) / 100,
        mcp_servers: mcpServers(request),
        input_tokens: input,
        output_tokens: count(anthropic ? usage.output_tokens : usage.completion_tokens),
        cache_read_input_tokens: cacheRead,
        cache_write_input_tokens: cacheWrite,
        cache_miss_input_tokens: cacheMiss,
        provider_cost_usd: typeof cost === "number" && Number.isFinite(cost) && cost >= 0 ? cost : null,
      });
    }
  }
}
