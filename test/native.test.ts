import { describe, it, expect } from "vitest";
import { buildEcosystemTools } from "../src/tools/ecosystem.js";
import { buildBuiltinTools } from "../src/tools/builtin.js";
import { isSensitiveTool } from "../src/warden/sandbox.js";
import { createLogger } from "../src/logger.js";
import { shouldBuildChainContext, type ChainContext } from "../src/ecosystem/networks.js";
import type { MemoryStore, Tool, ToolContext, WardenPolicy } from "../src/types.js";

const log = createLogger("t", "error");
const ctx: ToolContext = { log, approved: false };

// A minimal stand-in for a chain context (as in UNI / live). Enough for the tool
// builders + acex_status (which just reports addresses); network reads aren't called.
const fakeChain = {
  chainName: "uni",
  addresses: {
    lottery: "0x0000000000000000000000000000000000000001",
    usdc: "0x0000000000000000000000000000000000000002",
    escrow: "0x0000000000000000000000000000000000000003",
    acexAmm: "0x0000000000000000000000000000000000000004",
    acexRegistry: "0x0000000000000000000000000000000000000005",
    lendingPool: "0x0000000000000000000000000000000000000006",
    capabilityNft: "0x0000000000000000000000000000000000000007",
  },
  publicClient: {},
  walletClient: null,
  explorerAddr: (a: string) => a,
} as unknown as ChainContext;

function ecosystem(opts: { cryptoEnabled?: boolean; chain?: ChainContext | null; acexEnabled?: boolean } = {}): Tool[] {
  return buildEcosystemTools({
    cryptoEnabled: opts.cryptoEnabled ?? true,
    chain: opts.chain ?? null,
    oracleFamilyUrl: "http://127.0.0.1:1",
    consumer: null,
    acexEnabled: opts.acexEnabled ?? false,
    defaultBudgetUsd: 1,
    log,
  });
}

const fakeMemory: MemoryStore = {
  addEpisode: async () => {},
  recentEpisodes: async () => [],
  addLesson: async () => {},
  upsertLesson: async () => {},
  recall: async () => [],
  getPin: async () => undefined,
  putPin: async () => {},
};

const policy: WardenPolicy = {
  minReputation: 0.25,
  blockAtSeverity: "high",
  allowUnknownServers: true,
  pinToolDefs: true,
  sensitiveToolPatterns: ["*invoke*", "*trade*", "*swap*", "*buy*", "*spend*", "*approve*", "*withdraw*", "*delete*", "*write*", "*exec*", "*shell*", "*payment*", "*transfer*", "*email*", "*send*"],
};

describe("native ecosystem tools", () => {
  it("exposes the full first-party toolset on a chain + crypto (live)", () => {
    const names = ecosystem({ cryptoEnabled: true, chain: fakeChain }).map((t) => t.def.name).sort();
    for (const n of ["oracle_call", "oracle_random", "lottery_status", "lottery_buy", "acex_status", "acex_trade", "hub_discover", "hub_invoke"]) {
      expect(names).toContain(n);
    }
    // all native tools are first-party (trusted, bypass WARDEN)
    expect(ecosystem({ cryptoEnabled: true, chain: fakeChain }).every((t) => t.source.kind === "builtin")).toBe(true);
  });

  it("crypto OFF + no chain (test mode) exposes only free oracle tools", () => {
    const names = ecosystem({ cryptoEnabled: false, chain: null }).map((t) => t.def.name).sort();
    expect(names).toEqual(["oracle_call", "oracle_random"]);
    for (const n of ["lottery_buy", "lottery_status", "acex_trade", "acex_status", "hub_invoke", "hub_discover"]) {
      expect(names).not.toContain(n);
    }
  });

  it("UNI (chain present, public crypto OFF) exposes lottery + ACEX, but NOT the paid hub tools", () => {
    // The ACEX-in-UNI fix: a private/local chain enables lottery + ACEX without the
    // public-crypto switch; the real paid-invoke hub path stays crypto-gated.
    const names = ecosystem({ cryptoEnabled: false, chain: fakeChain }).map((t) => t.def.name).sort();
    for (const n of ["lottery_status", "lottery_buy", "acex_status", "acex_trade"]) {
      expect(names).toContain(n);
    }
    expect(names).not.toContain("hub_discover");
    expect(names).not.toContain("hub_invoke");
  });

  it("oracle_call rejects capabilities outside the allow-list", async () => {
    const tool = ecosystem().find((t) => t.def.name === "oracle_call")!;
    const r = await tool.run({ capability_id: "evil.exfiltrate@v1" }, ctx);
    expect(r.ok).toBe(false);
    expect(r.content).toMatch(/allow-list/i);
  });

  it("acex_status reports the chain's ACEX addresses (read works in UNI)", async () => {
    const tool = ecosystem({ cryptoEnabled: false, chain: fakeChain }).find((t) => t.def.name === "acex_status")!;
    const r = await tool.run({}, ctx);
    expect(r.ok).toBe(true);
    expect(r.content).toMatch(/0x0000000000000000000000000000000000000004/i); // acexAmm
  });

  it("spend tools self-guard: acex_trade/lottery_buy need a wallet; hub tools need crypto", async () => {
    // chain present but walletClient null (no-wallet UNI demo) + consumer null
    const tools = ecosystem({ cryptoEnabled: true, chain: fakeChain, acexEnabled: true });
    expect((await tools.find((t) => t.def.name === "acex_trade")!.run({ side: "buy", amountUsd: 1 }, { ...ctx, approved: true })).ok).toBe(false);
    expect((await tools.find((t) => t.def.name === "lottery_buy")!.run({}, { ...ctx, approved: true })).ok).toBe(false);
    expect((await tools.find((t) => t.def.name === "hub_discover")!.run({ intent: "x" }, ctx)).ok).toBe(false);
    expect((await tools.find((t) => t.def.name === "hub_invoke")!.run({ capabilityId: "x" }, { ...ctx, approved: true })).ok).toBe(false);
  });
});

describe("chain-context gating (public crypto vs private UNI)", () => {
  it("SAFETY: live mode with public crypto OFF never builds a chain (no Base mainnet by default)", () => {
    expect(shouldBuildChainContext("live", false)).toBe(false);
  });
  it("live mode builds a chain only with public crypto ON", () => {
    expect(shouldBuildChainContext("live", true)).toBe(true);
  });
  it("uni mode always builds a (private/local) chain — independent of public crypto", () => {
    expect(shouldBuildChainContext("uni", false)).toBe(true);
    expect(shouldBuildChainContext("uni", true)).toBe(true);
  });
  it("test mode never builds a chain", () => {
    expect(shouldBuildChainContext("test", false)).toBe(false);
    expect(shouldBuildChainContext("test", true)).toBe(false);
  });
});

describe("spending tools are sensitive; read tools are not", () => {
  it("flags only value-moving tools for approval", () => {
    for (const n of ["lottery_buy", "hub_invoke", "acex_trade"]) expect(isSensitiveTool(n, policy)).toBe(true);
    for (const n of ["lottery_status", "oracle_call", "oracle_random", "hub_discover", "acex_status"]) expect(isSensitiveTool(n, policy)).toBe(false);
  });
});

describe("web_fetch SSRF guard", () => {
  it("blocks loopback / private addresses", async () => {
    const webFetch = buildBuiltinTools({ memory: fakeMemory, log }).find((t) => t.def.name === "web_fetch")!;
    const r = await webFetch.run({ url: "http://127.0.0.1:9/" }, ctx);
    expect(r.ok).toBe(false);
    expect(r.content).toMatch(/blocked|private|internal/i);
  });
  it("rejects non-http(s) schemes", async () => {
    const webFetch = buildBuiltinTools({ memory: fakeMemory, log }).find((t) => t.def.name === "web_fetch")!;
    const r = await webFetch.run({ url: "file:///etc/passwd" }, ctx);
    expect(r.ok).toBe(false);
  });
});
