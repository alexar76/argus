import type { Logger, Tool } from "../types.js";
import type { ChainContext } from "../ecosystem/networks.js";

/**
 * ACEX (the AICOM capital market) tools. `acex_status` is a read-only info tool.
 * `acex_trade` is **OFF by default** — ACEX was redeployed recently, is rated
 * HIGH-risk, and is not value-tested, so real swaps stay gated behind
 * economy.acexEnabled and a per-call approval until the contracts are vetted.
 */
export function buildAcexTools(chain: ChainContext | null, enabled: boolean, _log: Logger): Tool[] {
  const status: Tool = {
    def: {
      name: "acex_status",
      description: "Info on ACEX (AICOM capital market): the Pulse AMM, listing registry, and lending pool addresses, and whether trading is enabled.",
      inputSchema: { type: "object", properties: {} },
    },
    source: { kind: "builtin" },
    run: async () => {
      if (!chain) return { ok: false, content: "ACEX needs a chain context — available in uni or live mode (live also needs AIFACTORY_CRYPTO_ENABLED=1)." };
      const a = chain.addresses;
      return {
        ok: true,
        content:
          `ACEX (${chain.mode}): AMM ${a.acexAmm} · registry ${a.acexRegistry} · lending ${a.lendingPool}. ` +
          `Trading is ${enabled ? "ENABLED" : "DISABLED (HIGH-risk, not value-tested — set economy.acexEnabled to enable)"}.`,
        data: { amm: a.acexAmm, registry: a.acexRegistry, lending: a.lendingPool, tradingEnabled: enabled },
      };
    },
  };

  const trade: Tool = {
    def: {
      name: "acex_trade",
      description: "Trade on ACEX (swap USDC↔agent shares). SPENDS USDC — requires approval. DISABLED by default (HIGH-risk).",
      inputSchema: {
        type: "object",
        properties: {
          shareToken: { type: "string" },
          usdcIn: { type: "number" },
          minShareOut: { type: "number" },
        },
        required: ["shareToken", "usdcIn"],
      },
    },
    source: { kind: "builtin" },
    run: async (_args, ctx) => {
      if (!enabled) return { ok: false, content: "ACEX trading is DISABLED (HIGH-risk, not value-tested). Set economy.acexEnabled in config to enable it." };
      if (!chain || !chain.walletClient) return { ok: false, content: "No wallet/chain available for an ACEX trade." };
      if (!ctx.approved) return { ok: false, content: "[blocked] acex_trade spends USDC and was not approved." };
      // The swap path (approve USDC → Pulse AMM swapUsdcForShare) is implemented
      // conservatively but withheld pending contract value-testing.
      return { ok: false, content: `acex_trade is exposed but the swap is held pending value-testing of the ACEX contracts (AMM ${chain.addresses.acexAmm}). Not executed.` };
    },
  };

  return [status, trade];
}
