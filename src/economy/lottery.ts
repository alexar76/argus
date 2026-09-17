import { formatEther } from "viem";
import type { Logger, Tool } from "../types.js";
import type { ChainContext } from "../ecosystem/networks.js";

/** Minimal AIAgentLottery ABI. Default door is unpaid enterFromWork; buyTickets is off on LIVE. */
const LOTTERY_ABI = [
  { type: "function", name: "currentRoundId", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "ticketPrice", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "paused", stateMutability: "view", inputs: [], outputs: [{ type: "bool" }] },
  { type: "function", name: "paidTicketsEnabled", stateMutability: "view", inputs: [], outputs: [{ type: "bool" }] },
  { type: "function", name: "workSeated", stateMutability: "view", inputs: [{ name: "roundId", type: "uint256" }, { name: "agent", type: "address" }], outputs: [{ type: "bool" }] },
  {
    type: "function",
    name: "enterFromWork",
    stateMutability: "nonpayable",
    inputs: [
      { name: "roundId", type: "uint256" },
      { name: "participantId", type: "bytes32" },
      { name: "weightBps", type: "uint16" },
      { name: "expiry", type: "uint64" },
      { name: "sig", type: "bytes" },
    ],
    outputs: [],
  },
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

function relayerUrl(): string {
  return (process.env.ARGUS_LOTTERY_RELAYER_URL || "https://lottery.modelmarket.dev").replace(/\/+$/, "");
}

function lotteryHubUrl(): string {
  return (
    process.env.ARGUS_LOTTERY_HUB_URL
    || process.env.ARGUS_HUB_URL
    || "https://magic-ai-factory.com"
  ).replace(/\/+$/, "");
}

interface HubEntitlement {
  purpose: string;
  hub_url: string;
  agent_id: string;
  participant_id: `0x${string}`;
  wallet: string;
  issued_at: number;
  expires_at: number;
  nonce: string;
  signature: Record<string, unknown>;
}

async function fetchHubEntitlement(wallet: string): Promise<HubEntitlement> {
  const agentId = process.env.ARGUS_LOTTERY_AGENT_ID?.trim();
  const agentToken = process.env.ARGUS_LOTTERY_AGENT_TOKEN?.trim();
  if (!agentId || !agentToken) {
    throw new Error(
      "Hub eligibility is not configured: set ARGUS_LOTTERY_AGENT_ID and "
      + "ARGUS_LOTTERY_AGENT_TOKEN issued by your home Hub",
    );
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 12_000);
  try {
    const response = await fetch(`${lotteryHubUrl()}/ai-market/v2/lottery/work-seat-entitlement`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${agentToken}`,
      },
      body: JSON.stringify({ agent_id: agentId, wallet }),
      signal: ctrl.signal,
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`home Hub entitlement ${response.status}: ${text.slice(0, 240)}`);
    }
    const body = JSON.parse(text) as { entitlement?: HubEntitlement };
    if (!body.entitlement?.participant_id) {
      throw new Error("home Hub returned no signed entitlement");
    }
    return body.entitlement;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchWorkSeat(agent: string, roundId: bigint): Promise<{
  round_id: number;
  participant_id: `0x${string}`;
  weight_bps: number;
  expiry?: number;
  signature?: string;
  already_seated?: boolean;
}> {
  const entitlement = await fetchHubEntitlement(agent);
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 12_000);
  try {
    const r = await fetch(`${relayerUrl()}/work-seat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agent, round_id: Number(roundId), entitlement }),
      signal: ctrl.signal,
    });
    const text = await r.text();
    if (!r.ok) throw new Error(`relayer /work-seat ${r.status}: ${text.slice(0, 240)}`);
    return JSON.parse(text) as {
      round_id: number;
      participant_id: `0x${string}`;
      weight_bps: number;
      expiry?: number;
      signature?: string;
      already_seated?: boolean;
    };
  } finally {
    clearTimeout(t);
  }
}

/**
 * Native AI-Agent Oracle Lottery tools. `lottery_status` is a free read.
 * `lottery_enter` is the default door: unpaid work seat (relayer-signed WorkSeat,
 * agent sends enterFromWork). Gas only — no ticket ETH.
 * `lottery_buy` SPENDS native ETH and reverts on LIVE while paidTicketsEnabled=false.
 */
export function buildLotteryTools(chain: ChainContext | null, log: Logger): Tool[] {
  const status: Tool = {
    def: {
      name: "lottery_status",
      description: "Read the AI-Agent Oracle Lottery: current round, paid-tickets flag, ticket price (ETH), paused flag, and your wallet's ETH balance.",
      inputSchema: { type: "object", properties: {} },
    },
    source: { kind: "builtin" },
    run: async () => {
      if (!chain) return { ok: false, content: "Lottery needs a chain context — available in uni or live mode (live also needs AIFACTORY_CRYPTO_ENABLED=1)." };
      try {
        const a = chain.addresses.lottery;
        const [roundId, price, paused, paid] = await Promise.all([
          chain.publicClient.readContract({ address: a, abi: LOTTERY_ABI, functionName: "currentRoundId" }) as Promise<bigint>,
          chain.publicClient.readContract({ address: a, abi: LOTTERY_ABI, functionName: "ticketPrice" }) as Promise<bigint>,
          chain.publicClient.readContract({ address: a, abi: LOTTERY_ABI, functionName: "paused" }) as Promise<boolean>,
          chain.publicClient.readContract({ address: a, abi: LOTTERY_ABI, functionName: "paidTicketsEnabled" }) as Promise<boolean>,
        ]);
        let bal = 0n;
        if (chain.account) bal = await chain.publicClient.getBalance({ address: chain.account.address });
        const seated = chain.account
          ? Boolean(await chain.publicClient.readContract({
              address: a, abi: LOTTERY_ABI, functionName: "workSeated",
              args: [roundId, chain.account.address],
            }))
          : false;
        const priceEth = formatEther(price);
        const out = {
          mode: chain.mode,
          round: roundId.toString(),
          ticketPriceEth: priceEth,
          paidTickets: paid,
          paused,
          workSeated: seated,
          wallet: chain.account?.address ?? null,
          walletEth: formatEther(bal),
          canAfford: chain.account ? bal > price : false,
        };
        return {
          ok: true,
          content: `Lottery round ${out.round} · paidTickets=${paid} · ticket ${priceEth} ETH · seated=${seated} · paused=${paused} · your balance ${out.walletEth} ETH`,
          data: out,
        };
      } catch (err) {
        return { ok: false, content: `lottery_status failed: ${(err as Error).message}` };
      }
    },
  };

  const enter: Tool = {
    def: {
      name: "lottery_enter",
      description: "Take an unpaid work seat in the current lottery round (default door). Asks the relayer for a WorkSeat signature, then sends enterFromWork from this wallet. Gas only. Requires owner approval.",
      inputSchema: { type: "object", properties: {} },
    },
    source: { kind: "builtin" },
    run: async (_args, ctx) => {
      if (!chain) return { ok: false, content: "Lottery needs a chain context — available in uni or live mode (live also needs AIFACTORY_CRYPTO_ENABLED=1)." };
      if (!chain.walletClient || !chain.account) return { ok: false, content: "No wallet connected — set ARGUS_WALLET_KEY to take a work seat." };
      if (!ctx.approved) return { ok: false, content: "[blocked] lottery_enter sends an on-chain tx and was not approved." };
      const a = chain.addresses.lottery;
      const agent = chain.account.address;
      try {
        const [roundId, paused] = await Promise.all([
          chain.publicClient.readContract({ address: a, abi: LOTTERY_ABI, functionName: "currentRoundId" }) as Promise<bigint>,
          chain.publicClient.readContract({ address: a, abi: LOTTERY_ABI, functionName: "paused" }) as Promise<boolean>,
        ]);
        if (paused) return { ok: false, content: "Lottery is paused." };
        if (roundId === 0n) return { ok: false, content: "No open round." };
        const already = Boolean(await chain.publicClient.readContract({
          address: a, abi: LOTTERY_ABI, functionName: "workSeated", args: [roundId, agent],
        }));
        if (already) {
          return { ok: true, content: `Already work-seated in round ${roundId}.`, data: { roundId: roundId.toString(), already: true } };
        }
        const seat = await fetchWorkSeat(agent, roundId);
        if (seat.already_seated) {
          return { ok: true, content: `Already work-seated in round ${seat.round_id}.`, data: { ...seat, already: true } };
        }
        if (!seat.signature || !seat.expiry || !seat.participant_id) {
          return { ok: false, content: "Relayer did not return a WorkSeat signature." };
        }
        const { request } = await chain.publicClient.simulateContract({
          account: chain.account,
          address: a,
          abi: LOTTERY_ABI,
          functionName: "enterFromWork",
          args: [
            BigInt(seat.round_id),
            seat.participant_id,
            seat.weight_bps,
            BigInt(seat.expiry),
            seat.signature as `0x${string}`,
          ],
        });
        const hash = await chain.walletClient.writeContract(request);
        log.info(`lottery_enter: work seat round ${roundId}, tx ${hash}`);
        return {
          ok: true,
          content: `Work-seated in round ${roundId} (gas only). Tx: ${chain.explorerTx(hash)}`,
          data: {
            hash,
            roundId: roundId.toString(),
            participantId: seat.participant_id,
            explorer: chain.explorerTx(hash),
          },
        };
      } catch (err) {
        return { ok: false, content: `lottery_enter failed: ${(err as Error).message}` };
      }
    },
  };

  const buy: Tool = {
    def: {
      name: "lottery_buy",
      description: "Buy lottery tickets — SPENDS native ETH from your wallet (requires owner approval). Optional odds boost; OFF by default on-chain. Args: count (default 1).",
      inputSchema: {
        type: "object",
        properties: { count: { type: "integer", description: "tickets to buy (default 1)" } },
      },
    },
    source: { kind: "builtin" },
    run: async (args, ctx) => {
      if (!chain) return { ok: false, content: "Lottery needs a chain context — available in uni or live mode (live also needs AIFACTORY_CRYPTO_ENABLED=1)." };
      if (!chain.walletClient || !chain.account) return { ok: false, content: "No wallet connected — set ARGUS_WALLET_KEY to play the lottery." };
      if (!ctx.approved) return { ok: false, content: "[blocked] lottery_buy spends ETH and was not approved." };
      const rawCount = Math.max(1, Number(args.count ?? 1) || 1);
      const count = BigInt(Math.min(rawCount, 100));
      const a = chain.addresses.lottery;
      try {
        const paid = await (chain.publicClient.readContract({
          address: a, abi: LOTTERY_ABI, functionName: "paidTicketsEnabled",
        }) as Promise<boolean>);
        if (!paid) {
          return { ok: false, content: "Paid tickets are OFF on-chain. Use lottery_enter (work seat) instead." };
        }
        const [roundId, price, paused] = await Promise.all([
          chain.publicClient.readContract({ address: a, abi: LOTTERY_ABI, functionName: "currentRoundId" }) as Promise<bigint>,
          chain.publicClient.readContract({ address: a, abi: LOTTERY_ABI, functionName: "ticketPrice" }) as Promise<bigint>,
          chain.publicClient.readContract({ address: a, abi: LOTTERY_ABI, functionName: "paused" }) as Promise<boolean>,
        ]);
        if (paused) return { ok: false, content: "Lottery is paused." };
        const value = price * count;
        const { request } = await chain.publicClient.simulateContract({
          account: chain.account,
          address: a,
          abi: LOTTERY_ABI,
          functionName: "buyTickets",
          args: [roundId, count],
          value,
        });
        const currentRound = await (chain.publicClient.readContract({
          address: a,
          abi: LOTTERY_ABI,
          functionName: "currentRoundId",
        }) as Promise<bigint>);
        if (currentRound !== roundId) {
          return { ok: false, content: `Round advanced from ${roundId} to ${currentRound} — your tickets would land in a stale round. Retry.` };
        }
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

  return [status, enter, buy];
}
