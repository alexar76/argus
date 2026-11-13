import { describe, expect, it, vi } from "vitest";
import { buildExternalResearchTools } from "../src/tools/external-research.js";
import type { ToolContext } from "../src/types.js";

const TX = "0x" + "aa".repeat(32);
const PAYEE = "0x" + "bb".repeat(20);
const PROVIDER_ID = "abc12345";
const CDP_URL = "wss://connect.browserbase.com/?token=secret-session";
const approved = { approved: true } as ToolContext;
const denied = { approved: false } as ToolContext;

describe("external research tools", () => {
  it("buys Tavily search only with owner approval and the first-party spend cap", async () => {
    const tavilyPay = vi.fn().mockResolvedValue({ transaction: TX, body: { results: [
      { title: "Example", url: "https://example.com/spec", content: "Excerpt", secret: "must not appear" },
      { title: "Bad source", url: "javascript:alert(1)", content: "Invalid" },
    ] } });
    const reportProvider = vi.fn();
    const [search] = buildExternalResearchTools({ tavilyPay, reportProvider });
    const args = { query: "Example", limit: 2 };
    expect((await search!.run(args, denied)).ok).toBe(false);
    expect((await search!.run({ query: "" }, approved)).ok).toBe(false);
    expect(tavilyPay).not.toHaveBeenCalled();
    expect(reportProvider).not.toHaveBeenCalled();
    const result = await search!.run(args, approved);
    expect(tavilyPay).toHaveBeenCalledExactlyOnceWith({
      url: "https://x402.tavily.com/search", maxUsd: 0.01,
      body: { query: "Example", max_results: 2, include_answer: false },
    });
    expect(result).toMatchObject({ ok: true, data: { transaction: TX } });
    expect(result.content).toContain("https://example.com/spec");
    expect(result.content).not.toContain("must not appear");
    expect(result.content).not.toContain("Bad source");
    tavilyPay.mockRejectedValueOnce(new Error("private provider details"));
    expect((await search!.run(args, approved)).ok).toBe(false);
    expect(reportProvider.mock.calls).toEqual([
      [{ provider: "tavily", operation: "search", status: "succeeded" }],
      [{ provider: "tavily", operation: "search", status: "failed" }],
    ]);
  });

  it("buys a Chuhching creator search only with owner approval and the fixed spend cap", async () => {
    const pay = vi.fn().mockResolvedValue({
      transaction: TX, body: { results: [{ display_name: "Sample creator", secret: "not forwarded" }] },
    });
    const [search] = buildExternalResearchTools({ pay, chuhchingPayTo: PAYEE });
    const args = { kind: "creators", query: "Gaming" };
    expect((await search!.run(args, denied)).ok).toBe(false);
    expect(pay).not.toHaveBeenCalled();
    const result = await search!.run(args, approved);
    expect(pay).toHaveBeenCalledExactlyOnceWith({
      url: "https://mcp.chuhching.com/x402/search-creators",
      body: { category: "Gaming", limit: 5 },
      maxUsd: 0.02,
      expectedPayTo: PAYEE,
    });
    expect(result).toMatchObject({ ok: true, data: { transaction: TX } });
    expect(result.content).toContain("Sample creator");
    expect(result.content).not.toContain("not forwarded");
  });

  it("accepts only approved public HTTPS fetch targets and refuses a missing receipt", async () => {
    const browserbasePay = vi.fn().mockResolvedValue({
      transaction: null, body: { statusCode: 200, content: "Unreceipted page" },
    });
    const tools = buildExternalResearchTools({ browserbasePay, browserbaseFetchHosts: ["example.com", "127.0.0.1"] });
    const fetch = tools.find((tool) => tool.def.name === "browserbase_buy_fetch")!;
    for (const url of ["https://example.com.attacker.com", "https://x@example.com", "https://127.0.0.1", "http://example.com"]) {
      expect((await fetch.run({ url }, approved)).ok).toBe(false);
    }
    expect(browserbasePay).not.toHaveBeenCalled();

    const result = await fetch.run({ url: "https://example.com/about#details" }, approved);
    expect(browserbasePay).toHaveBeenCalledExactlyOnceWith({
      url: "https://x402.browserbase.com/fetch",
      maxUsd: 0.01,
      body: { url: "https://example.com/about", allowRedirects: false, allowInsecureSsl: false, proxies: false },
    });
    expect(result.ok).toBe(false);
    expect(result.content).not.toContain("Unreceipted page");
  });

  it("delivers browser credentials outside the model and only closes tracked sessions", async () => {
    const browserbasePay = vi.fn().mockResolvedValue({ transaction: TX, body: {
      sessionId: PROVIDER_ID, connectUrl: CDP_URL, paidMinutes: 5,
    } });
    const notify = vi.fn().mockResolvedValue(true);
    const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    const tools = buildExternalResearchTools({ browserbasePay, notify, fetch, hasOwnerChannel: () => true });
    const open = tools.find((tool) => tool.def.name === "browserbase_buy_session")!;
    const close = tools.find((tool) => tool.def.name === "browserbase_delete_session")!;
    const result = await open.run({ minutes: 5 }, approved);
    expect(result.ok).toBe(true);
    expect(notify).toHaveBeenCalledOnce();
    expect(notify.mock.calls[0]?.[0].copyable).toBe(CDP_URL);
    expect(JSON.stringify(result)).not.toContain(CDP_URL);
    expect(JSON.stringify(result)).not.toContain(PROVIDER_ID);
    const handle = (result.data as { sessionId: string }).sessionId;
    expect((await close.run({ session_id: PROVIDER_ID }, approved)).ok).toBe(false);
    expect((await close.run({ session_id: handle }, denied)).ok).toBe(false);
    expect((await close.run({ session_id: handle }, approved)).ok).toBe(true);
    expect((await close.run({ session_id: handle }, approved)).ok).toBe(false);
    expect(fetch).toHaveBeenCalledExactlyOnceWith(
      `https://x402.browserbase.com/browser/session/${PROVIDER_ID}`,
      expect.objectContaining({ method: "DELETE", redirect: "error" }),
    );
  });

  it("stops a paid browser session when the owner channel cannot deliver", async () => {
    const browserbasePay = vi.fn().mockResolvedValue({ transaction: TX, body: {
      sessionId: PROVIDER_ID, connectUrl: CDP_URL,
    } });
    const notify = vi.fn().mockResolvedValue(false);
    const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    const [open] = buildExternalResearchTools({ browserbasePay, notify, fetch, hasOwnerChannel: () => true });
    const result = await open!.run({ minutes: 5 }, approved);
    expect(result.ok).toBe(false);
    expect(result.content).toContain(TX);
    expect(result.content).toContain("closed");
    expect(JSON.stringify(result)).not.toContain(CDP_URL);
    expect(fetch).toHaveBeenCalledOnce();
  });
});
