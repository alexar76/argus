import { setTimeout as delay } from "node:timers/promises";
import { encodeEventTopics, parseAbiItem, toHex, TransactionReceiptNotFoundError, type Address, type Hex, type Log, type PublicClient } from "viem";

export const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const authorizationUsed = parseAbiItem("event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)");
const transfer = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");
const searchBlocks = 256n;

export type CmcSettlementReader = Pick<PublicClient, "getChainId" | "getBlockNumber" | "getLogs" | "getBlock" | "getTransactionReceipt">;

interface Authorization {
  from: Address;
  to: Address;
  value: bigint;
  nonce: Hex;
}

function sameHex(first: unknown, second: unknown): boolean {
  return typeof first === "string" && typeof second === "string" && first.toLowerCase() === second.toLowerCase();
}

function matchesLog(log: Log, event: { blockNumber: bigint | null; blockHash: Hex | null; transactionHash: Hex | null },
  topics: readonly unknown[], data: Hex): boolean {
  return log.removed === false && sameHex(log.address, BASE_USDC)
    && log.blockNumber === event.blockNumber && sameHex(log.blockHash, event.blockHash)
    && sameHex(log.transactionHash, event.transactionHash) && sameHex(log.data, data)
    && log.topics.length === topics.length && log.topics.every((topic, i) => sameHex(topic, topics[i] ?? null));
}

/** Resolves only the exact signed authorization on Base. It never submits or retries a payment. */
export async function recoverCmcSettlement(chain: CmcSettlementReader, authorization: Authorization, txHint?: Hex): Promise<Hex | null> {
  const { from, to, value, nonce } = authorization;
  const useTopics = encodeEventTopics({ abi: [authorizationUsed], eventName: "AuthorizationUsed", args: { authorizer: from, nonce } });
  const transferTopics = encodeEventTopics({ abi: [transfer], eventName: "Transfer", args: { from, to } });
  const transferData = toHex(value, { size: 32 });
  const limit = new AbortController();
  const read = async (): Promise<Hex | null> => {
    if (await chain.getChainId() !== 8453) return null;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt) await delay(2_000, undefined, { signal: limit.signal });
      limit.signal.throwIfAborted();
      const head = await chain.getBlockNumber({ cacheTime: 0 });
      limit.signal.throwIfAborted();
      let hash = txHint;
      let event: Log | undefined;
      if (!hash) {
        const fromBlock = head >= searchBlocks ? head - searchBlocks + 1n : 0n;
        const events = await chain.getLogs({ address: BASE_USDC, event: authorizationUsed,
          args: { authorizer: from, nonce }, fromBlock, toBlock: head, strict: true });
        limit.signal.throwIfAborted();
        if (events.length > 1) return null;
        event = events[0];
        if (!event) continue;
        if (!event.transactionHash || !event.blockHash || event.blockNumber === null || event.logIndex === null
            || event.blockNumber < fromBlock || event.blockNumber > head || !matchesLog(event, event, useTopics, "0x")) return null;
        if (event.blockNumber === head) continue;
        hash = event.transactionHash;
      }
      let receipt;
      try {
        receipt = await chain.getTransactionReceipt({ hash });
      } catch (error) {
        if (error instanceof TransactionReceiptNotFoundError) continue;
        throw error;
      }
      limit.signal.throwIfAborted();
      if (receipt.status !== "success" || !sameHex(receipt.transactionHash, hash) || !receipt.blockHash
          || receipt.blockNumber == null || (event && (receipt.blockNumber !== event.blockNumber || !sameHex(receipt.blockHash, event.blockHash)))) return null;
      const uses = receipt.logs.filter((log) => matchesLog(log, receipt, useTopics, "0x"));
      const authorizationIndex = uses[0]?.logIndex;
      if (uses.length !== 1 || authorizationIndex == null || (event && authorizationIndex !== event.logIndex)
          || !receipt.logs.some((log) => log.logIndex === authorizationIndex + 1 && matchesLog(log, receipt, transferTopics, transferData))) return null;
      if (receipt.blockNumber >= head) continue;
      const block = await chain.getBlock({ blockNumber: receipt.blockNumber });
      if (block.number !== receipt.blockNumber || !sameHex(block.hash, receipt.blockHash)) return null;
      return receipt.transactionHash;
    }
    return null;
  };
  try {
    return await Promise.race([read(), delay(10_000, null, { signal: limit.signal })]);
  } finally {
    limit.abort();
  }
}
