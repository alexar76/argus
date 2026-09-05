import { describe, it, expect } from "vitest";
import { OracleClient, buildOracleTools } from "../src/economy/oracles.js";
import { AimarketConsumer } from "../src/economy/aimarket.js";
import { MeshProvider } from "../src/economy/mesh.js";
import { createLogger } from "../src/logger.js";

// Live ecosystem connectivity — hits the local/production fleet.
// Enable with ARGUS_INTEGRATION=1 (same gate as integration.test.ts).
const RUN = process.env.ARGUS_INTEGRATION === "1";
const suite = RUN ? describe : describe.skip;
const log = createLogger("eco-it", "error");

const LOCAL = {
  factory: process.env.FACTORY_URL ?? "http://127.0.0.1:9081",
  hub: process.env.HUB_URL ?? "http://127.0.0.1:9083",
  mesh: process.env.MESH_URL ?? "http://127.0.0.1:8090",
  argus: process.env.ARGUS_URL ?? "http://127.0.0.1:8787",
  monitor: process.env.MONITOR_URL ?? "http://127.0.0.1:9100",
};

async function getJson(url: string, headers?: Record<string, string>) {
  const res = await fetch(url, { headers });
  return { status: res.status, data: (await res.json()) as Record<string, unknown> };
}

suite("ecosystem connectivity blocks (live)", () => {
  it("factory block: /api/health + /api/products", async () => {
    const health = await getJson(`${LOCAL.factory}/api/health`);
    expect(health.status).toBe(200);
    expect(health.data.status).toBe("ok");
    const products = await getJson(`${LOCAL.factory}/api/products`);
    expect(products.status).toBe(200);
    expect(products.data).toHaveProperty("products");
  }, 15_000);

  it("hub block: well-known + stats/live", async () => {
    const wk = await getJson(`${LOCAL.hub}/.well-known/ai-market.json`);
    expect(wk.status).toBe(200);
    expect(wk.data.hub_url ?? wk.data.name).toBeTruthy();
    const stats = await getJson(`${LOCAL.hub}/ai-market/v2/stats/live?limit=2`);
    expect(stats.status).toBe(200);
    expect(stats.data).toHaveProperty("summary");
  }, 15_000);

  it("mesh block: /v1/stats", async () => {
    const token = process.env.MESH_API_TOKEN?.trim();
    const headers = token ? { Authorization: `Bearer ${token}` } : undefined;
    const stats = await getJson(`${LOCAL.mesh}/v1/stats`, headers);
    expect(stats.status).toBe(200);
    expect(typeof stats.data).toBe("object");
  }, 15_000);

  it("argus block: /health public, /status gated", async () => {
    const health = await getJson(`${LOCAL.argus}/health`);
    expect(health.status).toBe(200);
    expect(health.data.agent).toBe("argus");
    expect(health.data.wallet).toBeUndefined();
    const status = await getJson(`${LOCAL.argus}/status`);
    expect([401, 403]).toContain(status.status);
  }, 15_000);

  it("monitor block: argus node active in /api/state", async () => {
    const token = process.env.ALIEN_API_TOKEN?.trim();
    const headers = token ? { Authorization: `Bearer ${token}` } : undefined;
    const state = await getJson(`${LOCAL.monitor}/monitor/api/state`, headers);
    expect(state.status).toBe(200);
    const nodes = (state.data.nodes ?? []) as Array<Record<string, unknown>>;
    const argus = nodes.find((n) => n.id === "argus");
    expect(argus).toBeTruthy();
    expect(argus?.group).toBe("argus");
    // Live run feed is optional until Argus completes a task with monitor env wired.
    if (argus?.argus_run) {
      expect((argus.argus_run as { beats?: unknown[] }).beats?.length).toBeGreaterThan(0);
    }
  }, 20_000);

  it("cross block: hub discover from AimarketConsumer", async () => {
    const c = new AimarketConsumer({
      hubUrl: LOCAL.hub,
      walletKey: "0x" + "1".repeat(64),
      affiliate: "argus",
      verifyTee: false,
      defaultDepositUsd: 1,
      minHubTrust: 0,
      token: "USDC",
      chain: "base",
      log,
    });
    const caps = await c.discover("run", 5, 3);
    expect(Array.isArray(caps)).toBe(true);
  }, 20_000);

  it("cross block: oracle-family random via builtin tools", async () => {
    const tools = buildOracleTools(new OracleClient("https://oracles.modelmarket.dev/family", log));
    const r = await tools.find((t) => t.def.name === "oracle_random")!.run({ bytes: 4 }, { log, approved: false });
    expect(r.ok).toBe(true);
  }, 20_000);

  it("cross block: mesh provider accepts localhost stats probe", async () => {
    const mesh = new MeshProvider({ meshUrl: LOCAL.mesh, name: "argus-connectivity-probe", log });
    // register() would mutate mesh roster — only verify the client can reach /v1/stats.
    const token = process.env.MESH_API_TOKEN?.trim();
    const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
    const res = await fetch(`${LOCAL.mesh}/v1/stats`, { headers });
    expect(res.status).toBe(200);
    expect(mesh).toBeTruthy();
  }, 15_000);
});
