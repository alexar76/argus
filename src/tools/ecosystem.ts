import type { EconomyConsumer, Logger, Tool } from "../types.js";
import type { ChainContext } from "../ecosystem/networks.js";
import { OracleClient, buildOracleTools } from "../economy/oracles.js";
import { buildLotteryTools } from "../economy/lottery.js";
import { buildAcexTools } from "../economy/acex.js";
import { rankByCi } from "../ci/index.js";

export interface EcosystemToolDeps {
  /** Master crypto switch — when false, the wallet/chain/payment tools are not exposed at all. */
  cryptoEnabled: boolean;
  chain: ChainContext | null;
  oracleFamilyUrl: string;
  /** Hub consumer (present only with a wallet). */
  consumer: EconomyConsumer | null;
  acexEnabled: boolean;
  defaultBudgetUsd: number;
  log: Logger;
}

/**
 * Native, FIRST-PARTY ecosystem tools. These are trusted (they bypass WARDEN,
 * which is only for third-party MCP servers) and are appended to the agent's
 * toolset before the bridged MCP tools. Read tools (oracles, *_status,
 * hub_discover) need no wallet; spending tools (lottery_enter, hub_invoke,
 * acex_trade) are wallet-gated AND named so WARDEN's sensitive-tool approval
 * gate fires before any value moves.
 */
export function buildEcosystemTools(d: EcosystemToolDeps): Tool[] {
  const tools: Tool[] = [];
  // Oracles are FREE, off-chain HTTP reads — always available, even crypto-off.
  tools.push(...buildOracleTools(new OracleClient(d.oracleFamilyUrl, d.log.child("oracle"))));
  // A chain context exists in UNI (private/local Anvil) and on live+crypto. Lottery
  // and ACEX *status* are reads that ride on it; ACEX trade stays gated by acexEnabled
  // (+ a wallet) and lottery_buy self-guards on a wallet — both WARDEN-sensitive. The
  // PUBLIC-crypto switch is NOT required for the private UNI chain, so ACEX and the
  // lottery work in UNI (play money) by default; live needs crypto to build a chain.
  if (d.chain) {
    tools.push(...buildLotteryTools(d.chain, d.log.child("lottery")));
    tools.push(...buildAcexTools(d.chain, d.acexEnabled, d.log.child("acex")));
  }
  // The Hub paid-invoke path is real external settlement (USDC channel) → public crypto only.
  if (d.cryptoEnabled) {
    tools.push(...buildHubTools(d.consumer, d.defaultBudgetUsd, d.log.child("hub")));
  }
  return tools;
}

function buildHubTools(consumer: EconomyConsumer | null, defaultBudgetUsd: number, _log: Logger): Tool[] {
  const discover: Tool = {
    def: {
      name: "hub_discover",
      description: "Discover paid capabilities on the AIMarket Hub by natural-language intent + budget (USD). Read-only.",
      inputSchema: {
        type: "object",
        properties: { intent: { type: "string" }, budget: { type: "number", description: "max USD/call" } },
        required: ["intent"],
      },
    },
    source: { kind: "builtin" },
    run: async (args) => {
      if (!consumer) return { ok: false, content: "Hub discovery needs a wallet (set ARGUS_WALLET_KEY)." };
      try {
        const caps = await consumer.discover(String(args.intent ?? ""), Number(args.budget ?? defaultBudgetUsd), 5);
        if (!caps.length) return { ok: true, content: "No capabilities matched." };
        // Sentinel-CI read-side: surface healthy (green) listings first; red ones sink.
        const ranked = rankByCi(caps as unknown as Record<string, unknown>[]) as unknown as typeof caps;
        return { ok: true, content: ranked.map((c) => `• ${c.name} — $${c.priceUsd}/call  trust ${c.trustScore ?? "?"}  [${c.capabilityId}]`).join("\n"), data: ranked };
      } catch (err) {
        return { ok: false, content: `hub_discover failed: ${(err as Error).message}` };
      }
    },
  };

  const invoke: Tool = {
    def: {
      name: "hub_invoke",
      description: "Invoke (pay for) a Hub capability with USDC on Base. SPENDS money — requires owner approval. Args: capabilityId, input.",
      inputSchema: {
        type: "object",
        properties: {
          capabilityId: { type: "string" },
          input: { type: "object" },
          productId: { type: "string" },
          sourceHub: { type: "string" },
        },
        required: ["capabilityId"],
      },
    },
    source: { kind: "builtin" },
    run: async (args, ctx) => {
      if (!consumer) return { ok: false, content: "Hub invoke needs a wallet (set ARGUS_WALLET_KEY)." };
      if (!ctx.approved) return { ok: false, content: "[blocked] hub_invoke spends USDC and was not approved." };
      try {
        const r = await consumer.invoke(String(args.capabilityId ?? ""), args.input ?? {}, {
          productId: args.productId ? String(args.productId) : undefined,
          sourceHub: args.sourceHub ? String(args.sourceHub) : undefined,
        });
        return {
          ok: r.ok,
          content: r.ok ? `Invoked (paid $${r.priceUsd}). Output: ${JSON.stringify(r.output).slice(0, 1500)}` : `invoke failed: ${r.error}`,
          data: r,
        };
      } catch (err) {
        return { ok: false, content: `hub_invoke failed: ${(err as Error).message}` };
      }
    },
  };

  // Subcontract (A2): hire another agent for a bounded sub-task, paid per-call. The
  // name contains "invoke" so WARDEN's sensitive-tool gate fires (per-call approval)
  // before any USDC moves; the provider is CI/trust-ranked before it is paid.
  const subcontract: Tool = {
    def: {
      name: "subcontract_invoke",
      description:
        "Subcontract a sub-task to another agent on the Hub, paid per-call in USDC. Discovers the cheapest CI/trust-ranked capability for the intent within `budget` and invokes it. SPENDS money — requires owner approval. Args: intent, budget (max USD/call), input (optional).",
      inputSchema: {
        type: "object",
        properties: {
          intent: { type: "string" },
          budget: { type: "number", description: "max USD for this single sub-call" },
          input: { type: "object", description: "input forwarded to the subcontracted capability" },
        },
        required: ["intent"],
      },
    },
    source: { kind: "builtin" },
    run: async (args, ctx) => {
      if (!consumer) return { ok: false, content: "subcontract needs a wallet (set ARGUS_WALLET_KEY)." };
      const intent = String(args.intent ?? "");
      const cap = Math.max(0, Number(args.budget ?? defaultBudgetUsd));
      let caps;
      try {
        caps = await consumer.discover(intent, cap, 5);
      } catch (err) {
        return { ok: false, content: `subcontract discover failed: ${(err as Error).message}` };
      }
      const ranked = rankByCi(caps as unknown as Record<string, unknown>[]) as unknown as typeof caps;
      const pick = ranked.filter((c) => c.priceUsd <= cap).sort((a, b) => a.priceUsd - b.priceUsd)[0];
      if (!pick) {
        const cheapest = [...caps].sort((a, b) => a.priceUsd - b.priceUsd)[0];
        return { ok: true, content: cheapest ? `No capability within $${cap}/call (cheapest is $${cheapest.priceUsd}).` : "No capability matched." };
      }
      if (!ctx.approved) {
        return { ok: false, content: `[blocked] subcontract_invoke would pay $${pick.priceUsd} to ${pick.capabilityId}; not approved.` };
      }
      try {
        const r = await consumer.invoke(pick.capabilityId, args.input ?? { intent });
        return {
          ok: r.ok,
          content: r.ok
            ? `Subcontracted ${pick.capabilityId} (paid $${r.priceUsd}). Output: ${JSON.stringify(r.output).slice(0, 1200)}`
            : `subcontract failed: ${r.error}`,
          data: { ...r, capabilityId: pick.capabilityId, trustScore: pick.trustScore },
        };
      } catch (err) {
        return { ok: false, content: `subcontract invoke failed: ${(err as Error).message}` };
      }
    },
  };

  return [discover, invoke, subcontract];
}
