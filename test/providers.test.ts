import { describe, it, expect, vi, afterEach } from "vitest";
import { OpenAICompatProvider } from "../src/providers/openai.js";
import { AnthropicProvider } from "../src/providers/anthropic.js";

function mockFetch(json: unknown) {
  return vi.fn(async () => ({ ok: true, status: 200, json: async () => json, text: async () => "" }) as unknown as Response);
}

afterEach(() => vi.restoreAllMocks());

describe("OpenAICompatProvider", () => {
  it("journals MCP provenance and reported charges independently of the request body", async () => {
    const usageSink = vi.fn();
    const fetch = vi.fn(async (_url: string, _init: RequestInit) => new Response(JSON.stringify({
      id: "gen-1", choices: [{ message: { content: "private response" } }],
      usage: { prompt_tokens: 50, completion_tokens: 5, cost: 0.002,
        prompt_tokens_details: { cached_tokens: 20, cache_write_tokens: 11 } },
    })));
    vi.stubGlobal("fetch", fetch);
    try {
      const p = new OpenAICompatProvider({ id: "openrouter", baseUrl: "https://openrouter.ai/api/v1", usageSink });
      const result = await p.chat({ model: "model", tools: [{ name: "hub__search", description: "search" }],
        messages: [{ role: "tool", toolCallId: "search", name: "hub__search", content: "private result" }],
        mcpToolServers: new Map([["hub__search", "hub"], ["unused__search", "unused"]]) });
      expect(result.content).toBe("private response");
      const body = JSON.parse(fetch.mock.calls[0][1].body as string);
      expect(body.usage).toEqual({ include: true });
      expect(body).not.toHaveProperty("mcpToolServers");
      expect(usageSink).toHaveBeenCalledOnce();
      expect(usageSink.mock.calls[0][0]).toMatchObject({
        mcp_servers: [{ server: "hub", tools: ["hub__search"], result_tools: ["hub__search"] }],
        cache_read_input_tokens: 20, cache_write_input_tokens: 11, provider_cost_usd: 0.002,
      });
      expect(JSON.stringify(usageSink.mock.calls[0][0])).not.toContain("private");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("maps a chat-completions response + tool call", async () => {
    global.fetch = mockFetch({
      model: "deepseek-chat",
      choices: [
        {
          message: { content: "hello", tool_calls: [{ id: "c1", function: { name: "foo", arguments: '{"a":1}' } }] },
          finish_reason: "tool_calls",
        },
      ],
      usage: { prompt_tokens: 12, completion_tokens: 7, prompt_tokens_details: { cached_tokens: 3 } },
    }) as typeof fetch;

    const p = new OpenAICompatProvider({ id: "deepseek", baseUrl: "https://api.deepseek.com/v1", apiKey: "k" });
    const r = await p.chat({ model: "deepseek-chat", messages: [{ role: "user", content: "hi" }] });
    expect(r.content).toBe("hello");
    expect(r.stopReason).toBe("tool_use");
    expect(r.toolCalls[0]).toMatchObject({ id: "c1", name: "foo", arguments: { a: 1 } });
    expect(r.usage).toMatchObject({ inputTokens: 12, outputTokens: 7, cachedInputTokens: 3 });
  });
});

describe("AnthropicProvider", () => {
  it("maps text + tool_use blocks and cache reads", async () => {
    global.fetch = mockFetch({
      model: "claude-sonnet-4-6",
      content: [
        { type: "text", text: "sure" },
        { type: "tool_use", id: "t1", name: "bar", input: { x: 2 } },
      ],
      stop_reason: "tool_use",
      usage: { input_tokens: 20, output_tokens: 9, cache_read_input_tokens: 15 },
    }) as typeof fetch;

    const p = new AnthropicProvider({ apiKey: "k" });
    const r = await p.chat({ model: "claude-sonnet-4-6", messages: [{ role: "user", content: "hi" }], cachePrefix: true });
    expect(r.content).toBe("sure");
    expect(r.stopReason).toBe("tool_use");
    expect(r.toolCalls[0]).toMatchObject({ id: "t1", name: "bar", arguments: { x: 2 } });
    expect(r.usage.cachedInputTokens).toBe(15);
  });
});
