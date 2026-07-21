import { createPublicClient, createWalletClient, http, fallback, type Account, type Hex, type PublicClient, type WalletClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import type { EcosystemMode } from "../config.js";
import type { Logger } from "../types.js";

export type Address = `0x${string}`;

export interface Addresses {
  lottery: Address;
  usdc: Address;
  escrow: Address;
  acexAmm: Address;
  acexRegistry: Address;
  lendingPool: Address;
  capabilityNft: Address;
}

/** Real Base-mainnet deployment (from the ecosystem scout / onchain-journal). */
export const BASE_MAINNET_ADDRESSES: Addresses = {
  lottery: "0xbda3e32331822d525d5e7c7b51ed76132e84db61",
  usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  escrow: "0x3Df85a639EAB8B50DD14f09bdeB46D5FeF163017",
  acexAmm: "0x049B839BD5B30797c27f1806E06172014c5d4337",
  acexRegistry: "0xcF28770416294358af286a2E4a2e88d6c1f436C3",
  lendingPool: "0xB0BE904642EDE39135A0F1c5e5A811925b1c2F48",
  capabilityNft: "0xA9Af496fD4A1Dc594029Aa8Ea2dbd236Fd255033",
};

/** Public Base RPCs, in fallback priority order (mirrors the ecosystem's preset). */
const BASE_RPCS = [
  "https://mainnet.base.org",
  "https://base-rpc.publicnode.com",
  "https://base.llamarpc.com",
  "https://base.drpc.org",
  "https://1rpc.io/base",
];

// ── RPC Privacy: proxy + custom headers ────────────────────────────────────

/**
 * Parse ARGUS_RPC_EXTRA_HEADERS (JSON map) for custom HTTP headers on every
 * RPC call.  E.g. `{"X-API-Key":"...", "CF-Access-Client-Id":"..."}` lets
 * operators use private/authenticated RPC endpoints without baking credentials
 * into the URL.
 */
function rpcExtraHeaders(): Record<string, string> | undefined {
  const raw = process.env.ARGUS_RPC_EXTRA_HEADERS?.trim();
  if (!raw) return undefined;
  try {
    const obj = JSON.parse(raw);
    if (obj && typeof obj === "object" && !Array.isArray(obj)) {
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(obj)) {
        if (typeof v === "string") headers[k] = v;
      }
      return Object.keys(headers).length > 0 ? headers : undefined;
    }
  } catch {
    /* silently ignore malformed JSON */
  }
  return undefined;
}

/**
 * Build a custom fetch function that routes through a proxy when
 * ARGUS_RPC_PROXY is set.  Uses Node's built-in undici ProxyAgent.
 *
 * Supported proxy URLs:
 *   - http://proxy:8080          (HTTP CONNECT tunnel for https:// targets)
 *   - socks5://proxy:1080        (SOCKS5 — needs `npm install socks-proxy-agent`)
 *   - socks5h://proxy:1080       (SOCKS5 with remote DNS — proxy resolves hostnames)
 *
 * Leave ARGUS_RPC_PROXY unset for direct connections (the default).
 */
function rpcFetchFn(): typeof globalThis.fetch | undefined {
  const proxyUrl = process.env.ARGUS_RPC_PROXY?.trim();
  if (!proxyUrl) return undefined;

  const proxyLower = proxyUrl.toLowerCase();
  const isSocks = proxyLower.startsWith("socks5://") || proxyLower.startsWith("socks5h://");

  if (isSocks) {
    // Dynamic require so socks-proxy-agent stays optional.  The cast through
    // any avoids a compile-time dependency on the package's types.
    let SocksProxyAgent: any;
    try {
      SocksProxyAgent = require("socks-proxy-agent").SocksProxyAgent;
    } catch {
      throw new Error(
        `ARGUS_RPC_PROXY is set to a SOCKS URL (${proxyUrl}) but "socks-proxy-agent" ` +
        `is not installed.  Run: npm install socks-proxy-agent`,
      );
    }
    const agent = new SocksProxyAgent(proxyUrl);
    return ((url: any, init?: any) => {
      return fetch(url, { ...init, dispatcher: agent } as any);
    }) as typeof globalThis.fetch;
  }

  // HTTP CONNECT proxy — Node's undici (used by global fetch in Node 18+) reads
  // from http_proxy / https_proxy / ALL_PROXY env vars.  We set them only if
  // they aren't already present so they don't bleed into non-RPC fetch calls.
  if (!process.env.HTTP_PROXY && !process.env.http_proxy) {
    process.env.HTTP_PROXY = proxyUrl;
  }
  if (!process.env.HTTPS_PROXY && !process.env.https_proxy) {
    process.env.HTTPS_PROXY = proxyUrl;
  }
  return undefined; // native fetch picks up the env vars
}

/** Build a viem http() transport with privacy options applied. */
function makeRpcTransport(url: string, timeout = 6000) {
  const headers = rpcExtraHeaders();
  const fetchFn = rpcFetchFn();
  const opts: Record<string, unknown> = {};
  if (headers) opts.fetchOptions = { headers };
  if (fetchFn) opts.fetch = fetchFn;
  return http(url, { ...opts, timeout } as any);
}

export interface ChainContext {
  mode: EcosystemMode;
  chainId: number;
  /** Native gas ticker. */
  ticker: string;
  addresses: Addresses;
  publicClient: PublicClient;
  /** Present only when a wallet key is configured. */
  walletClient: WalletClient | null;
  account: Account | null;
  explorerTx(hash: string): string;
  explorerAddr(addr: string): string;
}

export interface ChainOptions {
  mode: EcosystemMode;
  walletKey?: string;
  /** Comma-separated RPC override (prepended to the preset list). */
  rpcOverride?: string;
  log: Logger;
}

/**
 * Whether a chain context should be built for (mode, public-crypto):
 *  - uni  → always (a PRIVATE/local Anvil chain — the default value layer; never Base)
 *  - live → ONLY with public crypto on (so the default never touches Base mainnet)
 *  - test → never
 * Safety invariant: `shouldBuildChainContext("live", false) === false`.
 */
export function shouldBuildChainContext(mode: EcosystemMode, cryptoEnabled: boolean): boolean {
  return mode === "uni" || (mode === "live" && cryptoEnabled);
}

/**
 * Build the on-chain context for the current mode, with a viem `fallback()`
 * transport across multiple Base RPCs so a single dead endpoint never stalls the
 * agent. Returns null in TEST mode (no real chain). In UNI mode it targets the
 * local Universe Anvil chain + sim addresses from env. Live targets Base mainnet.
 *
 * Privacy: respects ARGUS_RPC_PROXY (SOCKS5 / HTTP CONNECT), ARGUS_RPC_EXTRA_HEADERS.
 */
export function buildChainContext(opts: ChainOptions): ChainContext | null {
  if (opts.mode === "test") {
    opts.log.debug("chain: test mode — no on-chain context");
    return null;
  }
  const account = opts.walletKey ? privateKeyToAccount(normalizeKey(opts.walletKey)) : null;

  if (opts.mode === "uni") {
    const rpc = process.env.ARGUS_UNI_RPC || "http://127.0.0.1:8545";
    const chainId = Number(process.env.ARGUS_UNI_CHAIN_ID || 31337);
    const chain = {
      id: chainId,
      name: "aicom-universe",
      nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
      rpcUrls: { default: { http: [rpc] } },
    } as const;
    const transport = makeRpcTransport(rpc);
    const publicClient = createPublicClient({ chain, transport }) as unknown as PublicClient;
    const walletClient = account ? (createWalletClient({ account, chain, transport }) as unknown as WalletClient) : null;
    const addresses = { ...BASE_MAINNET_ADDRESSES, ...uniAddressesFromEnv() };
    opts.log.info(`chain: UNI on ${rpc} (chainId ${chainId})`);
    return {
      mode: "uni",
      chainId,
      ticker: "ETH",
      addresses,
      publicClient,
      walletClient,
      account,
      explorerTx: (h) => `uni:tx:${h}`,
      explorerAddr: (a) => `uni:addr:${a}`,
    };
  }

  // live — Base mainnet
  const rpcs = dedup([...splitCsv(opts.rpcOverride), ...splitCsv(process.env.ARGUS_RPC_BASE), ...BASE_RPCS]);
  const transport = fallback(
    rpcs.map((u) => makeRpcTransport(u)),
    { rank: false, retryCount: 2 },
  );
  const publicClient = createPublicClient({ chain: base, transport }) as unknown as PublicClient;
  const walletClient = account ? (createWalletClient({ account, chain: base, transport }) as unknown as WalletClient) : null;
  opts.log.info(`chain: LIVE Base mainnet (${rpcs.length} RPC endpoints, fallback)`);
  return {
    mode: "live",
    chainId: base.id,
    ticker: "ETH",
    addresses: BASE_MAINNET_ADDRESSES,
    publicClient,
    walletClient,
    account,
    explorerTx: (h) => `https://basescan.org/tx/${h}`,
    explorerAddr: (a) => `https://basescan.org/address/${a}`,
  };
}

function uniAddressesFromEnv(): Partial<Addresses> {
  const out: Partial<Addresses> = {};
  const map: Array<[keyof Addresses, string]> = [
    ["lottery", "ARGUS_UNI_LOTTERY"],
    ["usdc", "ARGUS_UNI_USDC"],
    ["escrow", "ARGUS_UNI_ESCROW"],
    ["acexAmm", "ARGUS_UNI_ACEX_AMM"],
    ["acexRegistry", "ARGUS_UNI_ACEX_REGISTRY"],
    ["lendingPool", "ARGUS_UNI_LENDING_POOL"],
    ["capabilityNft", "ARGUS_UNI_CAPABILITY_NFT"],
  ];
  for (const [k, env] of map) {
    const v = process.env[env];
    if (v && /^0x[0-9a-fA-F]{40}$/.test(v)) out[k] = v as Address;
  }
  return out;
}

function normalizeKey(k: string): Hex {
  const n = k.startsWith("0x") ? k : `0x${k}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(n)) throw new Error("wallet key must be a 32-byte hex (64 chars)");
  return n as Hex;
}
function splitCsv(s?: string): string[] {
  return s ? s.split(",").map((x) => x.trim()).filter(Boolean) : [];
}
function dedup(xs: string[]): string[] {
  return [...new Set(xs)];
}
