import { formatEther } from "viem";
import type { Logger, Tool } from "../types.js";
import type { ChainContext } from "../ecosystem/networks.js";

/** Minimal AIAgentLottery ABI (mirrors the on-chain contract; ARGUS only reads + buys). */
const LOTTERY_ABI = [
  { type: "function", name: "currentRoundId", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "ticketPrice", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "paused", stateMutability: "view", inputs: [], outputs: [{ type: "bool" }] },
  {
    type: "function",
    name: "buyTickets",
    stateMutability: "payable",
    inputs: [
      { name: "roundId", type: "uint256" },
      { name: "count", type: "uint256" },
    ],
    outputs: [],
  },
] as const;

/**
 * Native AI-Agent Oracle Lottery tools. `lottery_status` is a free read.
 * `lottery_enter` SPENDS native ETH (0.000003/ticket) — it is wallet-gated and,
 * because its name matches the WARDEN sensitive-tool patterns, the agent loop
 * forces explicit owner approval before it runs. It simulates first so a doomed
 * call (paused / round closed / insufficient funds) fails for free.
 */
export function buildLotteryTools(chain: ChainContext | null, log: Logger): Tool[] {
  const status: Tool = {
    def: {
      name: "lottery_status",
      description: "Read the AI-Agent Oracle Lottery: current round, ticket price (ETH), paused flag, and your wallet's ETH balance.",
      inputSchema: { type: "object", properties: {} },
    },
    source: { kind: "builtin" },
    run: async () => {
      if (!chain) return { ok: false, content: "Lottery needs a chain context — available in uni or live mode (live also needs AIFACTORY_CRYPTO_ENABLED=1)." };
      try {
        const a = chain.addresses.lottery;
        const [roundId, price, paused] = await Promise.all([
          chain.publicClient.readContract({ address: a, abi: LOTTERY_ABI, functionName: "currentRoundId" }) as Promise<bigint>,
          chain.publicClient.readContract({ address: a, abi: LOTTERY_ABI, functionName: "ticketPrice" }) as Promise<bigint>,
          chain.publicClient.readContract({ address: a, abi: LOTTERY_ABI, functionName: "paused" }) as Promise<boolean>,
        ]);
        let bal = 0n;
        if (chain.account) bal = await chain.publicClient.getBalance({ address: chain.account.address });
        const priceEth = formatEther(price);
        const out = {
          mode: chain.mode,
          round: roundId.toString(),
          ticketPriceEth: priceEth,
          paused,
          wallet: chain.account?.address ?? null,
          walletEth: formatEther(bal),
          canAfford: chain.account ? bal > price : false,
        };
        return { ok: true, content: `Lottery round ${out.round} · ticket ${priceEth} ETH · paused=${paused} · your balance ${out.walletEth} ETH`, data: out };
      } catch (err) {
        return { ok: false, content: `lottery_status failed: ${(err as Error).message}` };
      }
    },
  };

  const enter: Tool = {
    def: {
      name: "lottery_buy",
      description: "Buy lottery tickets — SPENDS native ETH from your wallet (requires owner approval). Args: count (default 1).",
      inputSchema: {
        type: "object",
        properties: { count: { type: "integer", description: "tickets to buy (default 1)" } },
      },
    },
    source: { kind: "builtin" },
    run: async (args, ctx) => {
      if (!chain) return { ok: false, content: "Lottery needs a chain context — available in uni or live mode (live also needs AIFACTORY_CRYPTO_ENABLED=1)." };
      if (!chain.walletClient || !chain.account) return { ok: false, content: "No wallet connected — set ARGUS_WALLET_KEY to play the lottery." };
      if (!ctx.approved) return { ok: false, content: "[blocked] lottery_enter spends ETH and was not approved." };
      const rawCount = Math.max(1, Number(args.count ?? 1) || 1);
      // Cap at 100 tickets per call — even with approval, unbounded buys could drain
      // the wallet before the on-chain revert check kicks in.
      const count = BigInt(Math.min(rawCount, 100));
      const a = chain.addresses.lottery;
      try {
        const [roundId, price] = await Promise.all([
          chain.publicClient.readContract({ address: a, abi: LOTTERY_ABI, functionName: "currentRoundId" }) as Promise<bigint>,
          chain.publicClient.readContract({ address: a, abi: LOTTERY_ABI, functionName: "ticketPrice" }) as Promise<bigint>,
        ]);
        const value = price * count;
        // Simulate first — reverts (paused, round closed, insufficient funds) cost nothing.
        const { request } = await chain.publicClient.simulateContract({
          account: chain.account,
          address: a,
          abi: LOTTERY_ABI,
          functionName: "buyTickets",
          args: [roundId, count],
          value,
        });
        const hash = await chain.walletClient.writeContract(request);
        log.info(`lottery_buy: bought ${count} ticket(s) round ${roundId}, tx ${hash}`);
        return {
          ok: true,
          content: `Bought ${count} ticket(s) for round ${roundId} (${formatEther(value)} ETH). Tx: ${chain.explorerTx(hash)}`,
          data: { hash, roundId: roundId.toString(), count: count.toString(), valueEth: formatEther(value), explorer: chain.explorerTx(hash) },
        };
      } catch (err) {
        return { ok: false, content: `lottery_buy failed (likely round not open / paused / insufficient ETH): ${(err as Error).message}` };
      }
    },
  };

  return [status, enter];
}
