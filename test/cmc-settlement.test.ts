import { createPublicClient, custom, encodeEventTopics, parseAbiItem, toHex } from "viem";
import { generatePrivateKey } from "viem/accounts";
import { base } from "viem/chains";
import { expect, it, vi } from "vitest";
import { BASE_USDC } from "../src/economy/cmc-settlement.js";
import { CMC_QUOTES, externalBasePayment } from "../src/economy/external-payment.js";
import { createLogger } from "../src/logger.js";
import { buildCoinMarketCapTool } from "../src/tools/cmc.js";

const url = `${CMC_QUOTES}?id=1`;
const payee = "0x1111111111111111111111111111111111111111";
const wrongAddress = "0x2222222222222222222222222222222222222222";
const transaction = `0x${"a".repeat(64)}`;
const block = `0x${"b".repeat(64)}`;
const differentHash = `0x${"c".repeat(64)}`;
const authEvent = parseAbiItem("event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)");
const transferEvent = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");
const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64");

function fixture(options: { recipient?: string; amount?: bigint; nonce?: string; transferIndex?: string;
  blockHash?: string; reverted?: boolean; status?: number; header?: unknown; endpoint?: string; chainId?: number } = {}) {
  let authorization: { from: `0x${string}`; nonce: `0x${string}` };
  const endpoint = options.endpoint ?? url;
  const vendor = vi.fn<typeof fetch>(async (_input, init) => {
    const signature = new Headers(init?.headers).get("payment-signature");
    if (!signature) return Response.json({}, { status: 402, headers: { "payment-required": encode({ x402Version: 2,
      resource: { url: endpoint }, accepts: [{ scheme: "exact", network: "eip155:8453", asset: BASE_USDC,
        amount: "10000", payTo: payee, maxTimeoutSeconds: 60, extra: { name: "USD Coin", version: "2" } }] }) } });
    authorization = JSON.parse(Buffer.from(signature, "base64").toString()).payload.authorization;
    return Response.json({ status: { error_code: 0 }, data: [{ id: 1, quote: [{ symbol: "USD", price: 10 }] }] }, { status: options.status ?? 200,
      headers: { "payment-response": encode(options.header ?? { success: true }) } });
  });
  const request = vi.fn(async ({ method, params }: { method: string; params?: unknown }) => {
    if (method === "eth_chainId") return toHex(options.chainId ?? 8453);
    if (method === "eth_blockNumber") return "0x101";
    const topics = encodeEventTopics({ abi: [authEvent], args: { authorizer: authorization.from, nonce: authorization.nonce } });
    const authLog = { address: BASE_USDC, logIndex: "0x4", blockNumber: "0x100", blockHash: block,
      transactionHash: transaction, transactionIndex: "0x0", removed: false, topics, data: "0x" };
    if (method === "eth_getLogs") {
      expect(params).toEqual([{ address: BASE_USDC, topics, fromBlock: "0x2", toBlock: "0x101" }]);
      return [authLog];
    }
    if (method === "eth_getBlockByNumber") return { hash: options.blockHash ?? block, number: "0x100" };
    if (method === "eth_getTransactionReceipt") return { status: options.reverted ? "0x0" : "0x1", blockHash: block,
      blockNumber: "0x100", transactionHash: transaction, logs: [
        { ...authLog, topics: [...topics.slice(0, 2), options.nonce ?? authorization.nonce] },
        { ...authLog, logIndex: options.transferIndex ?? "0x5", data: toHex(options.amount ?? 10000n, { size: 32 }),
          topics: encodeEventTopics({ abi: [transferEvent], args: { from: authorization.from, to: (options.recipient ?? payee) as `0x${string}` } }) },
      ] };
    throw new Error(`Unexpected RPC ${method}`);
  });
  const chain = createPublicClient({ chain: base, transport: custom({ request }, { retryCount: 0 }) });
  const key = generatePrivateKey();
  const pay = externalBasePayment(() => key, vendor, chain);
  return { vendor, request, pay, run: () => pay({ url: endpoint, method: "GET", expectedPayTo: payee, maxUsd: 0.01 }) };
}

it("returns CMC delivery and the canonical Base transaction bound to the signed nonce without another vendor call", async () => {
  const { run, vendor, request } = fixture();
  await expect(run()).resolves.toMatchObject({ body: { status: { error_code: 0 } }, transaction, amountUsd: 0.01 });
  expect(vendor).toHaveBeenCalledTimes(2);
  expect(request).toHaveBeenCalledTimes(5);
});

it.each([undefined, 8453, "8453", "Base", "eip155:8453", "base-mainnet", "cmc-provider-id-123"])("proves the CMC hash hint directly on Base with networkId %s", async (networkId) => {
  const { pay, vendor, request } = fixture({ header: { success: true, txHash: transaction, networkId, x402FlowId: "private-fixture" } });
  const tool = buildCoinMarketCapTool(pay, payee);
  const log = createLogger("cmc-settlement-test", "error");
  expect((await tool.run({ ids: [1] }, { log })).ok).toBe(false);
  expect(vendor).not.toHaveBeenCalled();
  const result = await tool.run({ ids: [1] }, { approved: true, log });
  expect(result).toMatchObject({ ok: true, content: expect.stringContaining(transaction) });
  expect(result.content).not.toContain("private-fixture");
  expect(vendor).toHaveBeenCalledTimes(2);
  expect(request.mock.calls.map(([call]) => call.method)).toEqual(["eth_chainId", "eth_blockNumber", "eth_getTransactionReceipt", "eth_getBlockByNumber"]);
  expect(request.mock.calls[2]?.[0].params).toEqual([transaction]);
});

it.each([
  { recipient: wrongAddress }, { amount: 9999n }, { nonce: differentHash }, { transferIndex: "0x6" },
  { blockHash: differentHash }, { reverted: true }, { chainId: 1 }, { header: { success: true, txHash: differentHash } },
])("rejects an unmatched CMC hash proof without falling back to log scan: %o", async (options) => {
  const { run, vendor, request } = fixture({ header: { success: true, txHash: transaction }, ...options });
  await expect(run()).rejects.toThrow("reconcile");
  expect(vendor).toHaveBeenCalledTimes(2);
  expect(request.mock.calls.map(([call]) => call.method)).not.toContain("eth_getLogs");
});

it.each([
  { txHash: differentHash, transaction, network: "base" }, { txHash: differentHash, transaction },
  { txHash: "broken" }, { txHash: "" }, { txHash: null },
  { networkId: 1 }, { networkId: "0x1" }, { networkId: "solana" }, { networkId: "eip155:1" },
  { networkId: "base-sepolia" }, { networkId: {} }, { network: "eip155:1" },
])("rejects a malformed or contradictory CMC hint before RPC: %o", async (fields) => {
  const { run, vendor, request } = fixture({ header: { success: true, txHash: transaction, ...fields } });
  await expect(run()).rejects.toThrow("reconcile");
  expect(vendor).toHaveBeenCalledTimes(2);
  expect(request).not.toHaveBeenCalled();
});

it.each([
  { recipient: wrongAddress }, { amount: 9999n }, { nonce: differentHash }, { transferIndex: "0x6" },
  { blockHash: differentHash }, { reverted: true },
])("leaves a CMC payment unconfirmed when the on-chain proof differs: %o", async (options) => {
  const { run, vendor } = fixture(options);
  await expect(run()).rejects.toThrow("reconcile");
  expect(vendor).toHaveBeenCalledTimes(2);
});

it.each([
  { status: 402 }, { header: { success: false } }, { header: { success: true, network: "eip155:1" } },
  { header: { success: true, transaction: "not-a-transaction" } }, { header: { success: true, payer: wrongAddress } },
  { header: { success: true, amount: "9999" } }, { endpoint: "https://agent.laso.finance/get-card?amount=5.00" },
  { endpoint: "https://x402.tavily.com/search" },
])("keeps the incomplete receipt exception scoped to the successful CMC route: %j", async (options) => {
  const { run, vendor, request } = fixture(options);
  await expect(run()).rejects.toThrow("reconcile");
  expect(vendor).toHaveBeenCalledTimes(2);
  expect(request).not.toHaveBeenCalled();
});
