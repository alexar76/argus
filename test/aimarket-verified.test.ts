import { describe, it, expect, vi, afterEach } from "vitest";
import { AimarketConsumer } from "../src/economy/aimarket.js";
import { buildEcosystemTools } from "../src/tools/ecosystem.js";
import { createLogger } from "../src/logger.js";
import type { EconomyConsumer, InvokeOutcome, Tool, ToolContext } from "../src/types.js";

const log = createLogger("t", "error");
const ctx: ToolContext = { log, approved: true };
const HUB = "http://localhost:9083";

// ── Mocked hub HTTP (the real @aimarket/agent SDK runs against a stubbed fetch) ──

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const CHANNEL = {
  channel: { channel_id: "ch_1", balance_usd: 1, deposit_usd: 1, expires_at: new Date(Date.now() + 3_600_000).toISOString() },
};

/** Hub verification envelope (contract shape) with overridable fields. */
function envelope(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    requested: true,
    status: "settled",
    performed: true,
    verified: true,
    verify_score: 0.91,
    threshold: 0.7,
    trace_id: "tr_1",
    verifier: "metis.verify@v1",
    mode: "fast",
    settled: true,
    reason: null,
    timestamp: "2026-07-14T10:00:00Z",
    signature: { algorithm: "ed25519", value: "c2ln" },
    ...over,
  };
}

interface HubCall {
  url: string;
  body?: Record<string, unknown>;
}

/** Stub global fetch as a tiny hub: channel open + invoke + verdict lookups (in order). */
function stubHub(opts: { invoke: unknown; lookups?: Array<unknown> }): HubCall[] {
  const calls: HubCall[] = [];
  const lookups = [...(opts.lookups ?? [])];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown, init?: { body?: unknown }) => {
      const url = typeof input === "string" ? input : String((input as { url?: string }).url ?? input);
      calls.push({ url, body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined });
      if (url.endsWith("/ai-market/v2/channel/open")) return json(CHANNEL, 201);
      if (url.endsWith("/ai-market/v2/invoke")) return json(opts.invoke);
      if (url.includes("/ai-market/v2/verification/")) {
        const next = lookups.shift();
        if (next instanceof Error) throw next;
        if (next === undefined) throw new Error(`unexpected verification poll: ${url}`);
        // A raw Response passes through verbatim (lets a test drive a non-200 status).
        return next instanceof Response ? next : json(next);
      }
      throw new Error(`unexpected fetch: ${url}`);
    }),
  );
  return calls;
}

function consumer(verifyOutputs = true): AimarketConsumer {
  return new AimarketConsumer({
    hubUrl: HUB,
    walletKey: "11".repeat(32),
    affiliate: "argus",
    verifyTee: false,
    verifyOutputs,
    defaultDepositUsd: 1,
    minHubTrust: 0,
    token: "USDC",
    chain: "base",
    log,
  });
}

/** Neuter the poll backoff (record the delays instead of waiting them out). */
function instantSleep(c: AimarketConsumer): number[] {
  const delays: number[] = [];
  (c as unknown as { sleep: (ms: number) => Promise<void> }).sleep = async (ms: number) => {
    delays.push(ms);
  };
  return delays;
}

afterEach(() => vi.unstubAllGlobals());

describe("AimarketConsumer --verified (pay-on-verified hire path)", () => {
  it("sends the verify block (intent/auto/wait) and resolves an inline settled verdict", async () => {
    const calls = stubHub({
      invoke: {
        success: true,
        result: { answer: 4 },
        price_usd: 0.1,
        latency_ms: 9,
        tee_verified: false,
        receipt: { nonce: "rcpt_1" },
        verification: envelope(),
        protocol_version: "v2",
      },
    });
    const r = await consumer().invoke("cap.math@v1", { q: "2+2" }, { intent: "add two numbers" });
    const wire = calls.find((c) => c.url.endsWith("/ai-market/v2/invoke"))!.body!;
    // Exact contract block — the published SDK (0.1.0) drops unknown opts, so this
    // proves the fetch-layer injection put it on the wire.
    expect(wire.verify).toEqual({ requested: true, intent: "add two numbers", mode: "auto", wait: true, wait_timeout_s: 300 });
    expect(r.ok).toBe(true);
    expect(r.verification?.status).toBe("settled");
    expect(r.verification?.verified).toBe(true);
    expect(r.verification?.verifyScore).toBe(0.91);
    expect(r.verification?.traceId).toBe("tr_1");
    expect(r.verification?.refunded).toBe(false);
    expect(r.verification?.nonce).toBe("rcpt_1");
    expect(calls.some((c) => c.url.includes("/verification/"))).toBe(false); // resolved inline — no polling
  });

  it("without --verified sends NO verify block and reports no verification", async () => {
    const calls = stubHub({
      invoke: { success: true, result: { ok: 1 }, price_usd: 0.1, latency_ms: 9, tee_verified: false },
    });
    const r = await consumer(false).invoke("cap.math@v1", { q: "2+2" });
    expect(calls.find((c) => c.url.endsWith("/ai-market/v2/invoke"))!.body!.verify).toBeUndefined();
    expect(r.verification).toBeUndefined();
  });

  it("refunded verdict keeps the output (ok=true) and surfaces the signed rejection receipt", async () => {
    stubHub({
      invoke: {
        success: true,
        result: { answer: "wrong" },
        price_usd: 0.1,
        latency_ms: 9,
        tee_verified: false,
        receipt: { nonce: "rcpt_2" },
        verification: envelope({ status: "refunded", verified: false, verify_score: 0.41, settled: false, reason: "verify_failed" }),
        rejection_receipt: { type: "verification_rejection", nonce: "vfail_1", refunded: true, verify_score: 0.41 },
        protocol_version: "v2",
      },
    });
    const r = await consumer().invoke("cap.math@v1", { q: "2+2" }, { intent: "add two numbers" });
    // The service was delivered — a refund is a money outcome, not an invoke error.
    expect(r.ok).toBe(true);
    expect(r.verification?.status).toBe("refunded");
    expect(r.verification?.refunded).toBe(true);
    expect(r.verification?.verified).toBe(false);
    expect(r.verification?.verifyScore).toBe(0.41);
    expect(r.verification?.rejectionReceipt?.type).toBe("verification_rejection");
  });

  it("pending envelope polls GET /verification/{nonce} with 5s→exponential backoff until resolved", async () => {
    const calls = stubHub({
      invoke: {
        success: true,
        result: { answer: 4 },
        price_usd: 0.1,
        latency_ms: 9,
        tee_verified: false,
        receipt: { nonce: "rcpt_9" },
        verification: envelope({ status: "pending", performed: false, verified: null, verify_score: null, trace_id: null, settled: false }),
        protocol_version: "v2",
      },
      lookups: [
        new TypeError("fetch failed"), // transport error — NOT a verdict, keep polling
        { success: true, verification: envelope({ status: "pending", verified: null, verify_score: null }), protocol_version: "v2" },
        { success: true, verification: envelope({ verify_score: 0.88, trace_id: "tr_9" }), receipt: { nonce: "rcpt_9" }, protocol_version: "v2" },
      ],
    });
    const c = consumer();
    const delays = instantSleep(c);
    const r = await c.invoke("cap.math@v1", { q: "2+2" }, { intent: "add two numbers" });
    expect(delays).toEqual([5_000, 10_000, 20_000]); // 5s doubling, no overall deadline
    expect(calls.filter((x) => x.url.endsWith("/ai-market/v2/verification/rcpt_9"))).toHaveLength(3);
    expect(r.verification?.status).toBe("settled");
    expect(r.verification?.verifyScore).toBe(0.88);
    expect(r.verification?.traceId).toBe("tr_9");
  });

  it("a definitive 404 verification_not_found ends the poll (no hang) and surfaces a pending/unknown outcome", async () => {
    const calls = stubHub({
      invoke: {
        success: true,
        result: { answer: 4 },
        price_usd: 0.1,
        latency_ms: 9,
        tee_verified: false,
        receipt: { nonce: "rcpt_404" },
        verification: envelope({ status: "pending", performed: false, verified: null, verify_score: null, trace_id: null, settled: false }),
        protocol_version: "v2",
      },
      // The hub never learns of this nonce, so every lookup 404s "verification_not_found".
      // The poller must give up (after tolerating a little replica lag) instead of spinning
      // forever — one more 404 than it tolerates proves it stops rather than draining these.
      lookups: [
        json({ error: "verification_not_found" }, 404),
        json({ error: "verification_not_found" }, 404),
        json({ error: "verification_not_found" }, 404),
      ],
    });
    const c = consumer();
    instantSleep(c);
    const r = await c.invoke("cap.math@v1", { q: "2+2" }, { intent: "add two numbers" });
    // Gave up after tolerating VERIFY_POLL_MAX_NOT_FOUND (=2) 404s, i.e. on the 3rd — it did
    // NOT keep polling (a 4th lookup would throw "unexpected verification poll" from the stub).
    expect(calls.filter((x) => x.url.endsWith("/ai-market/v2/verification/rcpt_404"))).toHaveLength(3);
    // Surfaces the last-known pending envelope → resolveVerification's "check later" path.
    expect(r.ok).toBe(true);
    expect(r.verification?.status).toBe("pending");
    expect(r.verification?.verified).toBeNull();
    expect(r.verification?.nonce).toBe("rcpt_404");
  });

  it("pending → refunded via poll captures the rejection receipt from the lookup", async () => {
    stubHub({
      invoke: {
        success: true,
        result: { answer: "wrong" },
        price_usd: 0.1,
        latency_ms: 9,
        tee_verified: false,
        receipt: { nonce: "rcpt_3" },
        verification: envelope({ status: "pending", performed: false, verified: null, verify_score: null, settled: false }),
        protocol_version: "v2",
      },
      lookups: [
        {
          success: true,
          verification: envelope({ status: "refunded", verified: false, verify_score: 0.2, settled: false, reason: "verify_failed" }),
          rejection_receipt: { type: "verification_rejection", nonce: "vfail_2", refunded: true },
          protocol_version: "v2",
        },
      ],
    });
    const c = consumer();
    instantSleep(c);
    const r = await c.invoke("cap.math@v1", { q: "2+2" });
    expect(r.verification?.status).toBe("refunded");
    expect(r.verification?.refunded).toBe(true);
    expect(r.verification?.rejectionReceipt?.nonce).toBe("vfail_2");
  });
});

// ── Tool layer: hire tools forward the intent and surface the verdict ────────

function fakeConsumer(verification?: InvokeOutcome["verification"]) {
  const invocations: Array<{ capabilityId: string; opts?: { productId?: string; sourceHub?: string; intent?: string } }> = [];
  const c: EconomyConsumer = {
    discover: async () => [
      { capabilityId: "cap.a@v1", productId: "p1", name: "A", priceUsd: 0.1, trustScore: 0.9 },
    ],
    invoke: async (capabilityId, _input, opts) => {
      invocations.push({ capabilityId, opts });
      return { ok: true, output: { done: 1 }, priceUsd: 0.1, receiptValid: false, latencyMs: 5, verification };
    },
    settle: async () => ({ refundedUsd: 0, usedUsd: 0 }),
  };
  return { c, invocations };
}

function hubTools(c: EconomyConsumer): Tool[] {
  return buildEcosystemTools({
    cryptoEnabled: true,
    chain: null,
    oracleFamilyUrl: "http://127.0.0.1:1",
    consumer: c,
    acexEnabled: false,
    defaultBudgetUsd: 1,
    minHubTrust: 0.25,
    log,
  });
}

describe("hire tools surface the pay-on-verified outcome", () => {
  it("hub_invoke forwards the intent and reports a settled verdict", async () => {
    const { c, invocations } = fakeConsumer({
      status: "settled", verified: true, verifyScore: 0.93, traceId: "tr_7", refunded: false, nonce: "rcpt_7",
      envelope: { status: "settled" },
    });
    const tool = hubTools(c).find((t) => t.def.name === "hub_invoke")!;
    const r = await tool.run({ capabilityId: "cap.a@v1", input: {}, intent: "translate the doc" }, ctx);
    expect(invocations[0]?.opts?.intent).toBe("translate the doc");
    expect(r.ok).toBe(true);
    expect(r.content).toContain("Verified ✓ (score 0.93, trace tr_7)");
    expect((r.data as InvokeOutcome).verification?.status).toBe("settled");
  });

  it("hub_invoke reports a refunded verdict loudly", async () => {
    const { c } = fakeConsumer({
      status: "refunded", verified: false, verifyScore: 0.3, traceId: "tr_8", refunded: true, nonce: "rcpt_8",
      envelope: { status: "refunded" },
      rejectionReceipt: { type: "verification_rejection" },
    });
    const tool = hubTools(c).find((t) => t.def.name === "hub_invoke")!;
    const r = await tool.run({ capabilityId: "cap.a@v1" }, ctx);
    expect(r.content).toContain("Verification FAILED — payment refunded (score 0.3, trace tr_8)");
  });

  it("subcontract_invoke reuses its own intent as the verify intent", async () => {
    const { c, invocations } = fakeConsumer();
    const tool = hubTools(c).find((t) => t.def.name === "subcontract_invoke")!;
    const r = await tool.run({ intent: "summarize a paper", budget: 1 }, ctx);
    expect(r.ok).toBe(true);
    expect(invocations[0]?.opts?.intent).toBe("summarize a paper");
  });
});
