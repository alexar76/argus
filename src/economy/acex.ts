import type { Address } from "viem";
import type { Logger, Tool } from "../types.js";
import type { ChainContext } from "../ecosystem/networks.js";

const ERC20_ABI = [
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }],
    outputs: [{ type: "bool" }],
  },
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
] as const;

const PULSE_AMM_ABI = [
  {
    type: "function",
    name: "swapUsdcForShare",
    stateMutability: "nonpayable",
    inputs: [
      { name: "shareToken", type: "address" },
      { name: "usdcIn", type: "uint256" },
      { name: "minShareOut", type: "uint256" },
    ],
    outputs: [{ name: "shareOut", type: "uint256" }],
  },
  {
    type: "function",
    name: "pools",
    stateMutability: "view",
    inputs: [{ name: "shareToken", type: "address" }],
    outputs: [
      { name: "shareToken", type: "address" },
      { name: "usdc", type: "address" },
      { name: "reserveShare", type: "uint256" },
      { name: "reserveUsdc", type: "uint256" },
      { name: "active", type: "bool" },
    ],
  },
] as const;

/**
 * ACEX (the AICOM capital market) tools. `acex_status` is a read-only info tool.
 * `acex_trade` swaps USDC → CapShares on PulseAMM when economy.acexEnabled is set.
 */
export function buildAcexTools(chain: ChainContext | null, enabled: boolean, log: Logger): Tool[] {
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
          `Trading is ${enabled ? "ENABLED" : "DISABLED (set economy.acexEnabled to enable)"}.`,
        data: { amm: a.acexAmm, registry: a.acexRegistry, lending: a.lendingPool, tradingEnabled: enabled },
      };
    },
  };

  const trade: Tool = {
    def: {
      name: "acex_trade",
      description: "Trade on ACEX (swap USDC→agent CapShares on PulseAMM). SPENDS USDC — requires approval.",
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
    run: async (args, ctx) => {
      if (!enabled) return { ok: false, content: "ACEX trading is DISABLED. Set economy.acexEnabled in config to enable it." };
      if (!chain || !chain.walletClient || !chain.account) {
        return { ok: false, content: "No wallet/chain available for an ACEX trade." };
      }
      if (!ctx.approved) return { ok: false, content: "[blocked] acex_trade spends USDC and was not approved." };

      const shareToken = String(args.shareToken ?? "").trim() as Address;
      if (!/^0x[a-fA-F0-9]{40}$/.test(shareToken)) {
        return { ok: false, content: "shareToken must be a valid EVM address." };
      }
      const usdcHuman = Math.max(0, Number(args.usdcIn) || 0);
      if (usdcHuman <= 0) return { ok: false, content: "usdcIn must be > 0." };
      const usdcIn = BigInt(Math.floor(usdcHuman * 1e6));
      const minShareOut = BigInt(Math.floor(Math.max(0, Number(args.minShareOut ?? 0) || 0) * 1e18));

      const amm = chain.addresses.acexAmm;
      const usdc = chain.addresses.usdc;

      try {
        const pool = (await chain.publicClient.readContract({
          address: amm,
          abi: PULSE_AMM_ABI,
          functionName: "pools",
          args: [shareToken],
        })) as readonly [Address, Address, bigint, bigint, boolean];
        if (!pool[4]) return { ok: false, content: `No active PulseAMM pool for ${shareToken}.` };

        const bal = (await chain.publicClient.readContract({
          address: usdc,
          abi: ERC20_ABI,
          functionName: "balanceOf",
          args: [chain.account.address],
        })) as bigint;
        if (bal < usdcIn) {
          return { ok: false, content: `Insufficient USDC (${Number(bal) / 1e6} available, need ${usdcHuman}).` };
        }

        const { request: approveReq } = await chain.publicClient.simulateContract({
          account: chain.account,
          address: usdc,
          abi: ERC20_ABI,
          functionName: "approve",
          args: [amm, usdcIn],
        });
        await chain.walletClient.writeContract(approveReq);

        const { request: swapReq } = await chain.publicClient.simulateContract({
          account: chain.account,
          address: amm,
          abi: PULSE_AMM_ABI,
          functionName: "swapUsdcForShare",
          args: [shareToken, usdcIn, minShareOut],
        });
        const hash = await chain.walletClient.writeContract(swapReq);
        log.info(`acex_trade: ${usdcHuman} USDC → ${shareToken}, tx ${hash}`);
        return {
          ok: true,
          content: `Swapped ${usdcHuman} USDC for CapShares on ${shareToken}. Tx: ${chain.explorerTx(hash)}`,
          data: { hash, shareToken, usdcIn: usdcHuman, explorer: chain.explorerTx(hash) },
        };
      } catch (err) {
        return { ok: false, content: `acex_trade failed: ${(err as Error).message}` };
      }
    },
  };

  return [status, trade];
}
