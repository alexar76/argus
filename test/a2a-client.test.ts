import { verify } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { A2AClient, A2AError, paymentRequired, statusText, taskResult, taskState } from "../src/economy/a2a-client.js";
import { AgentKey, issueMandate, MandateCredential, publicKeyOfDid, requestMessage } from "../src/economy/aimarket-mandate.js";

const HUB = "https://h.test";

type Call = { url: string; init: RequestInit };

/** A scripted hub: records every request and answers the next JSON-RPC result or error. */
function hub(...answers: Array<Record<string, unknown>>): { calls: Call[]; fetch: typeof fetch } {
  const calls: Call[] = [];
  const f = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const id = JSON.parse(String(init?.body)).id;
    const answer = answers.shift() ?? { result: {} };
    return new Response(JSON.stringify({ jsonrpc: "2.0", id, ...answer }), {
      status: 200, headers: { "content-type": "application/json" },
    });
  });
  return { calls, fetch: f as unknown as typeof fetch };
}

function mandate(): MandateCredential {
  const argus = AgentKey.generate();
  const doc = issueMandate(AgentKey.generate(), argus.did, { audience: [HUB], scope: ["*"], perCallUsd: 0.01, perDayUsd: 0.1 });
  return new MandateCredential(doc, argus, HUB);
}

function proofVerifies(m: MandateCredential, headers: Record<string, string>, path: string, body: string): boolean {
  const fields = Object.fromEntries(headers["X-AIMarket-Mandate-Proof"]!.split(";").map((p) => {
    const [k, ...v] = p.split("=");
    return [k!, v.join("=")];
  }));
  const message = requestMessage({ hubOrigin: HUB, method: "POST", path, digest: m.digest, t: Number(fields.t), nonce: fields.n!, body });
  return verify(null, Buffer.from(message), publicKeyOfDid(m.key.did), Buffer.from(fields.s!, "base64url"));
}

const completed = (extra: Record<string, unknown> = {}) => ({
  result: {
    task: {
      id: "a2at_000000000000000000000000", contextId: "ctx", status: { state: "TASK_STATE_COMPLETED" },
      artifacts: [{ artifactId: "result", name: "result", parts: [{ data: { t: 11 } }] }], ...extra,
    },
  },
});

afterEach(() => vi.unstubAllGlobals());

describe("A2A client (aimarket-hub docs/a2a.md)", () => {
  it("searches with an A2A 1.0 SendMessage carrying a data part", async () => {
    const h = hub({ result: { message: { parts: [{ text: "Found 1" }, { data: { matches: [{ capability_id: "gaia.weather.read@v1" }] } }] } } });
    const found = await new A2AClient({ hubUrl: `${HUB}/`, fetch: h.fetch }).search("weather", { limit: 3 });
    expect(found.matches).toEqual([{ capability_id: "gaia.weather.read@v1" }]);
    const { url, init } = h.calls[0]!;
    expect(url).toBe(`${HUB}/a2a`);
    expect((init.headers as Record<string, string>)["A2A-Version"]).toBe("1.0");
    const rpc = JSON.parse(String(init.body));
    expect(rpc).toMatchObject({ jsonrpc: "2.0", method: "SendMessage" });
    expect(rpc.params.message.parts).toEqual([{ data: { intent: "weather", limit: 3 }, mediaType: "application/json" }]);
  });

  it("pays with a mandate by signing the exact bytes it sends as a raw part", async () => {
    const m = mandate();
    const h = hub(completed());
    const task = await new A2AClient({ hubUrl: HUB, mandate: m, apiKey: "ignored", fetch: h.fetch })
      .invoke("gaia.weather.read@v1", { device_id: "om-wx-01", scale: 1.5 }, { productId: "gaia.gateway", maxPriceUsd: 0.01 });
    expect(taskState(task)).toBe("TASK_STATE_COMPLETED");
    expect(taskResult(task)).toEqual({ t: 11 });
    const { init } = h.calls[0]!;
    const headers = init.headers as Record<string, string>;
    const part = JSON.parse(String(init.body)).params.message.parts[1];
    expect(part.mediaType).toBe("application/json");
    expect(part.data).toBeUndefined();
    const raw = Buffer.from(part.raw, "base64").toString("utf8");
    expect(JSON.parse(raw)).toEqual({
      product_id: "gaia.gateway", capability_id: "gaia.weather.read@v1", source_hub: "local",
      input: { device_id: "om-wx-01", scale: 1.5 }, max_price_usd: 0.01,
    });
    expect(headers["X-AIMarket-Mandate"]).toBe(m.digest);
    expect(headers["X-API-Key"]).toBeUndefined();
    expect(proofVerifies(m, headers, "/ai-market/v2/invoke", raw)).toBe(true);
  });

  it("pays with credits by header, with the invoke as a data part", async () => {
    const h = hub(completed());
    await new A2AClient({ hubUrl: HUB, apiKey: "amk_test", fetch: h.fetch }).invoke("x.y@v1", { q: 1 }, { messageId: "m-1" });
    const { init } = h.calls[0]!;
    expect((init.headers as Record<string, string>)["X-API-Key"]).toBe("amk_test");
    const message = JSON.parse(String(init.body)).params.message;
    expect(message.messageId).toBe("m-1");
    expect(message.parts[1]).toEqual({
      data: { invoke: { product_id: "x.y", capability_id: "x.y@v1", source_hub: "local", input: { q: 1 } } },
      mediaType: "application/json",
    });
  });

  it("reads a task back with a fresh mandate proof over the JSON-RPC body", async () => {
    const m = mandate();
    const h = hub({ result: { id: "a2at_1", contextId: "c", status: { state: "TASK_STATE_COMPLETED" } } });
    const task = await new A2AClient({ hubUrl: HUB, mandate: m, fetch: h.fetch }).getTask("a2at_1");
    expect(task.id).toBe("a2at_1");
    const { init } = h.calls[0]!;
    expect(proofVerifies(m, init.headers as Record<string, string>, "/a2a", String(init.body))).toBe(true);
  });

  it("surfaces the hub's x402 terms on a task that waits for payment", async () => {
    const terms = { x402Version: 2, accepts: [{ scheme: "exact", amount: "4000", payTo: "0xcd", network: "eip155:8453" }] };
    const h = hub({ result: { task: {
      id: "a2at_2", contextId: "c",
      status: { state: "TASK_STATE_INPUT_REQUIRED", message: { role: "ROLE_AGENT", messageId: "a", parts: [{ text: "Payment required" }],
        metadata: { "x402.payment.status": "payment-required", "x402.payment.required": terms } } },
    } } });
    const task = await new A2AClient({ hubUrl: HUB, fetch: h.fetch }).invoke("x.y@v1", {});
    expect(taskState(task)).toBe("TASK_STATE_INPUT_REQUIRED");
    expect(paymentRequired(task)).toEqual(terms);
    expect(statusText(task)).toBe("Payment required");
  });

  it("raises JSON-RPC errors with their A2A reason, and refuses a cleartext hub", async () => {
    const h = hub({ error: { code: -32001, message: "Task not found", data: [{ reason: "TASK_NOT_FOUND" }] } });
    const err = await new A2AClient({ hubUrl: HUB, fetch: h.fetch }).getTask("a2at_x").catch((e) => e);
    expect(err).toBeInstanceOf(A2AError);
    expect(err).toMatchObject({ code: -32001, reason: "TASK_NOT_FOUND" });
    expect(() => new A2AClient({ hubUrl: "http://h.test" })).toThrow(/HTTPS/);
  });
});

describe("argus a2a", () => {
  it("invokes on the free trial when nothing pays, and prints the result", async () => {
    const h = hub(completed({ metadata: { aimarket: { price_usd: 0 } } }));
    vi.stubGlobal("fetch", h.fetch);
    const saved = { ...process.env };
    const lines: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => { lines.push(a.join(" ")); });
    try {
      delete process.env.ARGUS_HUB_API_KEY;
      const { cmdA2A } = await import("../src/cli/commands/a2a.js");
      const config = { economy: { hubUrl: HUB } } as any;
      const code = await cmdA2A(config, { cmd: "a2a", rest: ["invoke", "x.y@v1"], flags: { input: '{"q":1}' } });
      expect(code).toBe(0);
      expect(lines.join("\n")).toContain('"t": 11');
      const headers = h.calls[0]!.init.headers as Record<string, string>;
      expect(headers["X-API-Key"]).toBeUndefined();
      expect(headers["X-AIMarket-Mandate"]).toBeUndefined();
    } finally {
      log.mockRestore();
      process.env = saved;
    }
  });

  it("refuses input that is not a JSON object", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { cmdA2A } = await import("../src/cli/commands/a2a.js");
      const code = await cmdA2A({ economy: { hubUrl: HUB } } as any, { cmd: "a2a", rest: ["invoke", "x.y@v1"], flags: { input: "[1]" } });
      expect(code).toBe(2);
    } finally {
      err.mockRestore();
    }
  });
});
