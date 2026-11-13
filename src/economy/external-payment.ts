import { x402Client, x402HTTPClient } from "@x402/core/client";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { isAddressEqual, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { BASE_USDC, recoverCmcSettlement, type CmcSettlementReader } from "./cmc-settlement.js";

const MAX_BODY = 1_048_576;
const BASE_NETWORKS = ["base", "eip155:8453"];
const HASH = /^0x[a-f0-9]{64}$/i;
type CmcReceiptFields = { txHash?: unknown; networkId?: unknown };
export const CMC_QUOTES = "https://pro-api.coinmarketcap.com/x402/v3/cryptocurrency/quotes/latest";

export interface ExternalPaymentRequest {
  url: string;
  method?: "GET" | "POST";
  body?: unknown;
  maxUsd: number;
  exactUsd?: number;
  expectedPayTo: string;
}

export interface ExternalPaymentResult {
  body: unknown;
  transaction: string;
  amountUsd: number;
}

type VendorPaymentRequest = Omit<ExternalPaymentRequest, "expectedPayTo">;

export async function readProviderJson(response: Response, maxBytes = MAX_BODY): Promise<unknown> {
  if (!response.body) return null;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new Error("provider response exceeds the size limit");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return bytes ? JSON.parse(Buffer.concat(chunks, bytes).toString("utf8")) : null;
}

function sameAddress(first: unknown, second: string): boolean {
  return typeof first === "string" && /^0x[a-f0-9]{40}$/i.test(first) && /^0x[a-f0-9]{40}$/i.test(second)
    && isAddressEqual(first.toLowerCase() as Hex, second.toLowerCase() as Hex);
}

function cmcNetworkCompatible(networkId: unknown): boolean {
  if (networkId === undefined || networkId === 8453) return true;
  if (typeof networkId !== "string" || !/^[\w:. -]{1,100}$/.test(networkId) || !networkId.trim()) return false;
  const id = networkId.trim().toLowerCase();
  if (BASE_NETWORKS.includes(id) || ["8453", "0x2105", "base mainnet", "base-mainnet", "base_mainnet"].includes(id)) return true;
  if (/^\d+$|^0x[\da-f]+$|:/.test(id)) return false;
  if (/^(?:base|eth(?:ereum)?|solana|polygon|arbitrum|optimism|bsc|avalanche)(?:$|[-_. ]|\d)/.test(id)) return false;
  // Proprietary IDs supply no chain evidence. The hash still needs an exact proof on Base.
  return true;
}

/** Called only by fixed, owner-approved tools. Sends a single authorization and never follows redirects. */
export function externalBasePayment(walletKey: () => Hex | null, requestFetch: typeof fetch = fetch, cmcChain?: CmcSettlementReader) {
  const pay = basePayment(walletKey, requestFetch, cmcChain);
  return (request: ExternalPaymentRequest) => pay(request);
}

/** Browserbase allocates deposit addresses per request. Only its fixed first-party gateway can supply one. */
export function externalBrowserbasePayment(walletKey: () => Hex | null, requestFetch: typeof fetch = fetch) {
  const pay = basePayment(walletKey, requestFetch);
  return (request: VendorPaymentRequest) => {
    if ((request.method ?? "POST") !== "POST" || request.maxUsd > 0.05 || ![
      "https://x402.browserbase.com/fetch", "https://x402.browserbase.com/browser/session/create",
    ].includes(request.url)) throw new Error("Browserbase payments require an approved gateway endpoint and a ceiling of at most $0.05");
    return pay({ ...request, expectedPayTo: null });
  };
}

/** Tavily supplies a fresh deposit address per challenge at this first-party endpoint. */
export function externalTavilyPayment(walletKey: () => Hex | null, requestFetch: typeof fetch = fetch) {
  const pay = basePayment(walletKey, requestFetch);
  return (request: VendorPaymentRequest) => {
    if ((request.method ?? "POST") !== "POST" || request.maxUsd > 0.01 || request.url !== "https://x402.tavily.com/search") {
      throw new Error("Tavily payments require the approved search endpoint and a ceiling of at most $0.01");
    }
    return pay({ ...request, expectedPayTo: null });
  };
}

function basePayment(walletKey: () => Hex | null, requestFetch: typeof fetch, cmcChain?: CmcSettlementReader) {
  return async (request: Omit<ExternalPaymentRequest, "expectedPayTo"> & { expectedPayTo: string | null }): Promise<ExternalPaymentResult> => {
    const url = new URL(request.url);
    if (url.protocol !== "https:" || url.username || url.password || url.hash || url.port) {
      throw new Error("invalid provider HTTPS endpoint");
    }
    const ceiling = Math.round(request.maxUsd * 1_000_000);
    const exact = request.exactUsd === undefined ? null : Math.round(request.exactUsd * 1_000_000);
    if (!Number.isSafeInteger(ceiling) || ceiling <= 0 || Math.abs(request.maxUsd * 1_000_000 - ceiling) > 1e-7
        || (exact !== null && (!Number.isSafeInteger(exact) || exact <= 0 || exact > ceiling))
        || (request.expectedPayTo !== null && !sameAddress(request.expectedPayTo, request.expectedPayTo))) {
      throw new Error("payment requires a fixed Base recipient and a positive USDC ceiling");
    }
    const key = walletKey();
    if (!key) throw new Error("external x402 needs an unlocked Base wallet");
    const account = privateKeyToAccount(key);
    const client = new x402Client().setSpendControls({ maxAmountPerPayment: request.maxUsd });
    const http = new x402HTTPClient(registerExactEvmScheme(client, { signer: account, networks: ["eip155:8453"] }));
    const headers = { accept: "application/json", "user-agent": "ARGUS/1.0", ...(request.body === undefined ? {} : { "content-type": "application/json" }) };
    const init = {
      method: request.method ?? "POST",
      body: request.body === undefined ? undefined : JSON.stringify(request.body),
      redirect: "error" as const,
    };
    const cmcRoute = init.method === "GET" && url.origin + url.pathname === CMC_QUOTES && request.expectedPayTo !== null;
    const quote = await requestFetch(url, { ...init, headers, signal: AbortSignal.timeout(15_000) });
    if (quote.status !== 402) {
      await quote.body?.cancel();
      throw new Error(`provider did not return an x402 quote (HTTP ${quote.status})`);
    }
    const quoteHeader = quote.headers.get("payment-required");
    const body = quoteHeader ? (await quote.body?.cancel(), undefined) : await readProviderJson(quote, 65_536);
    const required = http.getPaymentRequiredResponse((name) => quote.headers.get(name), body);
    if ((required.x402Version !== 1 && required.x402Version !== 2) || !Array.isArray(required.accepts)) {
      throw new Error("unsupported x402 quote");
    }
    const offer = required.accepts.find((candidate) => {
      if (!candidate || typeof candidate !== "object") return false;
      const amount = "maxAmountRequired" in candidate ? candidate.maxAmountRequired : candidate.amount;
      const resource = required.x402Version === 1 && "resource" in candidate ? candidate.resource : required.resource?.url;
      return candidate.scheme === "exact" && (candidate.network === "eip155:8453" || (required.x402Version === 1 && String(candidate.network) === "base"))
        && sameAddress(candidate.asset, BASE_USDC) && sameAddress(candidate.payTo, request.expectedPayTo ?? candidate.payTo)
        && typeof amount === "string" && /^\d{1,16}$/.test(amount) && BigInt(amount) > 0n && BigInt(amount) <= BigInt(ceiling)
        && (exact === null || BigInt(amount) === BigInt(exact))
        && Number.isInteger(candidate.maxTimeoutSeconds) && candidate.maxTimeoutSeconds > 0 && candidate.maxTimeoutSeconds <= 300
        && candidate.extra?.name === "USD Coin" && String(candidate.extra.version) === "2"
        && (candidate.extra.assetTransferMethod ?? "eip3009") === "eip3009"
        && (resource === url.href || (cmcRoute && (resource === CMC_QUOTES || resource === url.pathname)));
    });
    if (!offer) throw new Error("no exact Base USDC offer matches the endpoint, recipient and approved ceiling");
    const amount = "maxAmountRequired" in offer ? String(offer.maxAmountRequired) : offer.amount;
    const payload = await http.createPaymentPayload({ x402Version: required.x402Version, accepts: [offer], ...(required.x402Version === 2 ? { resource: required.resource } : {}) } as typeof required);
    const authorization = payload.payload.authorization as { from?: unknown; to?: unknown; value?: unknown; nonce?: unknown } | undefined;
    if (!authorization || !sameAddress(authorization.from, account.address) || !sameAddress(authorization.to, offer.payTo)
        || String(authorization.value) !== amount || typeof payload.payload.signature !== "string") {
      throw new Error("signed payload does not match the approved transfer");
    }
    let result: Response | undefined;
    let transaction: string | undefined;
    try {
      const response = await requestFetch(url, {
        ...init, headers: { ...headers, ...http.encodePaymentSignatureHeader(payload) }, signal: AbortSignal.timeout(90_000),
      });
      result = response;
      const receipt = http.getPaymentSettleResponse((name) => response.headers.get(name)) as ReturnType<typeof http.getPaymentSettleResponse> & CmcReceiptFields;
      if (receipt?.success !== true
          || (receipt.payer !== undefined && !sameAddress(receipt.payer, account.address))
          || (receipt.amount !== undefined && String(receipt.amount) !== amount)) {
        throw new Error("payment receipt is missing or inconsistent");
      }
      const hasStandardHash = typeof receipt.transaction === "string" && HASH.test(receipt.transaction);
      const hasStandardReceipt = hasStandardHash && BASE_NETWORKS.includes(receipt.network);
      if (hasStandardReceipt && (!cmcRoute || (receipt.txHash === undefined && receipt.networkId === undefined))) {
        transaction = receipt.transaction;
      } else if (cmcRoute && cmcChain && response.ok && response.headers.has("payment-response")
          && (receipt.transaction === undefined || receipt.transaction === "" || hasStandardHash)
          && (receipt.network === undefined || BASE_NETWORKS.includes(receipt.network))
          && cmcNetworkCompatible(receipt.networkId)
          && typeof authorization.nonce === "string" && HASH.test(authorization.nonce)) {
        const hint = receipt.txHash ?? (hasStandardHash ? receipt.transaction : undefined);
        if ((hint !== undefined && (typeof hint !== "string" || !HASH.test(hint))) || receipt.txHash === null
            || (hasStandardHash && String(hint).toLowerCase() !== receipt.transaction.toLowerCase())) {
          throw new Error("payment receipt is missing or inconsistent");
        }
        transaction = await recoverCmcSettlement(cmcChain, {
          from: account.address, to: offer.payTo as Hex, value: BigInt(amount), nonce: authorization.nonce as Hex,
        }, hint as Hex | undefined) ?? undefined;
      }
      if (!transaction) throw new Error("payment receipt is missing or inconsistent");
      if (!response.ok) throw new Error(`provider returned HTTP ${response.status}`);
      return { body: await readProviderJson(response), transaction, amountUsd: Number(amount) / 1_000_000 };
    } catch {
      if (transaction) throw new Error(`provider reported Base transaction ${transaction}, but delivery is unconfirmed; reconcile before retrying`);
      throw new Error("x402 result is unconfirmed after authorization; reconcile the wallet and provider before retrying");
    } finally {
      await result?.body?.cancel().catch(() => {});
    }
  };
}
