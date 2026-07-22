import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { resolveWalletKey } from "./economy/keystore.js";
import type {
  BudgetLimits,
  McpServerRef,
  Pricing,
  ProviderKind,
  Tier,
  WardenPolicy,
} from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Truthy parse shared with the Python ecosystem: 1/true/yes/on (anything else off). */
function envTruthy(v: string | undefined): boolean {
  return v != null && ["1", "true", "yes", "on"].includes(v.trim().toLowerCase());
}

/**
 * The crypto master switch, resolved with ecosystem-wide precedence:
 *   AIFACTORY_CRYPTO_ENABLED (the ecosystem var, shared by every component)
 *   → ARGUS_CRYPTO_ENABLED   (back-compat, per-process override for ARGUS)
 *   → undefined (caller falls back to config / default OFF)
 * Returns undefined only when NEITHER var is set, so config-file values still apply.
 */
export function cryptoEnvSetting(): boolean | undefined {
  if (process.env.AIFACTORY_CRYPTO_ENABLED != null) return envTruthy(process.env.AIFACTORY_CRYPTO_ENABLED);
  if (process.env.ARGUS_CRYPTO_ENABLED != null) return envTruthy(process.env.ARGUS_CRYPTO_ENABLED);
  return undefined;
}

export interface ProviderConfig {
  id: string;
  kind: ProviderKind;
  /** Base URL for openai/local kinds. Anthropic uses its native endpoint. */
  baseUrl?: string;
  /** Name of the env var that holds the API key (e.g. "DEEPSEEK_API_KEY"). */
  apiKeyEnv?: string;
}

export interface ModelConfig {
  /** "providerId/model", e.g. "anthropic/claude-sonnet-4-6". */
  ref: string;
  /** USD per 1M tokens — drives the token meter. Edit for your real rates. */
  pricing?: Pricing;
  maxTokens?: number;
}

export interface EconomyConfig {
  /** Derived: true only when a wallet key is present. */
  enabled: boolean;
  hubUrl: string;
  meshUrl: string;
  oracleFamilyUrl: string;
  affiliate: string;
  defaultDepositUsd: number;
  chain: string;
  token: string;
  /** ACEX trading is HIGH-risk and not value-tested — OFF by default. */
  acexEnabled: boolean;
  /** Minimum Hub trust_score for discover/search (community invoke_url caps). */
  minHubTrust: number;
  /** Self-bond: USD stake ARGUS declares against its own cost/conduct claims. 0 = OFF (default). */
  bondUsd: number;
  /** Penalty rate applied to overspend in the self-bond verdict (default 1×). */
  penaltyRate: number;
  /** Resolved from ARGUS_WALLET_KEY; never written to disk. */
  walletKey?: string;
  verifyTee: boolean;
  /** Pay-on-Verified: the hub escrows each paid invoke until Metis verdicts the output
   *  (pass → captured, fail → refunded). Buyer opt-in — OFF by default; the `--verified`
   *  CLI flag (or ARGUS_VERIFY_OUTPUTS) turns it on. */
  verifyOutputs: boolean;
}

export interface WardenConfig extends WardenPolicy {
  threatFeedUrl?: string;
  /** Ed25519 public key (hex-encoded SPKI DER) for verifying signed threat feeds. */
  feedPublicKey?: string;
  /** LUMEN lives behind the oracle-family endpoint. */
  oracleFamilyUrl: string;
  /**
   * Outbound egress allowlist for the built-in web_fetch tool. Empty = no
   * host restriction (SSRF guard still applies). When set (e.g. via
   * ARGUS_EGRESS_ALLOWLIST=api.foo.com,*.bar.io) web_fetch may only reach the
   * listed hosts — the anti-exfiltration boundary is actually enforced.
   */
  egressAllowlist: string[];
}

export interface TelegramConfig {
  /** If set, ONLY this Telegram user id may command the bot (overrides TOFU). */
  ownerId?: number;
}

export interface HttpConfig {
  /** Serve the HTTP channel under `argus serve`. /health is open; /ask is token-gated. */
  enabled: boolean;
  port: number;
  /** PEM-encoded TLS certificate path. Both cert + key must be set for HTTPS. */
  tlsCert?: string;
  /** PEM-encoded TLS private key path. */
  tlsKey?: string;
  /** Max concurrent /ask requests (default: 4). */
  maxConcurrent?: number;
}

export interface MonitorFeedConfig {
  /** Alien Monitor base URL (`ALIEN_MONITOR_URL` / `MONITOR_URL`). Empty = disabled. */
  url: string;
  /** Bearer token for `POST /api/argus/run` (`ALIEN_API_TOKEN`). Empty = disabled. */
  token: string;
}

export type EcosystemMode = "live" | "uni" | "test";

export interface ArgusConfig {
  /**
   * Which AICOM environment this agent runs in:
   * - "live" — real Base mainnet, real money, real agents (production).
   * - "uni"  — Universe: real infra + real on-chain tx on a local Anvil chain with FakeUSDT; only funding is synthetic.
   * - "test" — mocks/fake metrics; no real infra (UI/dev).
   */
  mode: EcosystemMode;
  /**
   * MASTER switch for PUBLIC crypto (Base mainnet, real money). Default OFF.
   * It gates the PUBLIC chain only — NOT "any chain". Specifically:
   * - mode "live" builds a Base-mainnet chain context ONLY when this is true, so
   *   the default never touches mainnet; paid hub invokes also require it.
   * - mode "uni" builds its PRIVATE/local Anvil chain regardless of this flag — UNI
   *   is the default value layer, so ACEX/lottery *status* (and play-money actions
   *   with a wallet) work with public crypto OFF.
   * Read from AIFACTORY_CRYPTO_ENABLED (ecosystem-wide), falling back to
   * ARGUS_CRYPTO_ENABLED. With it off, ARGUS still runs fully — local assistant,
   * WARDEN, channels, memory, FREE off-chain oracle reads, and UNI.
   */
  cryptoEnabled: boolean;
  providers: ProviderConfig[];
  models: { triage?: ModelConfig; core: ModelConfig; heavy?: ModelConfig };
  budget: BudgetLimits;
  warden: WardenConfig;
  economy: EconomyConfig;
  mcp: { catalogs: string[]; servers: McpServerRef[] };
  memory: { dir: string };
  telegram: TelegramConfig;
  http: HttpConfig;
  /** Live run feed for Alien Monitor graph node (fail-soft push after each run). */
  monitor: MonitorFeedConfig;
  arena: { handle?: string; frugalUsd?: number; polyglotMin?: number };
  stateDir: string;
}

type RawConfig = Partial<Omit<ArgusConfig, "economy" | "warden">> & {
  economy?: Partial<EconomyConfig>;
  warden?: Partial<WardenConfig>;
};

const DEFAULT_STATE_DIR = join(homedir(), ".argus");

function defaults(): ArgusConfig {
  return {
    mode: (process.env.ARGUS_MODE as EcosystemMode) || "live",
    cryptoEnabled: cryptoEnvSetting() ?? false,
    providers: [
      { id: "anthropic", kind: "anthropic", apiKeyEnv: "ANTHROPIC_API_KEY" },
      { id: "local", kind: "local", baseUrl: process.env.ARGUS_LOCAL_BASE_URL ?? "http://127.0.0.1:11434/v1" },
    ],
    models: {
      triage: { ref: "local/llama3.1", pricing: { inputPerM: 0, outputPerM: 0 }, maxTokens: 1024 },
      core: { ref: "anthropic/claude-sonnet-4-6", pricing: { inputPerM: 3, outputPerM: 15, cachedInputPerM: 0.3 }, maxTokens: 4096 },
      heavy: { ref: "anthropic/claude-opus-4-8", pricing: { inputPerM: 15, outputPerM: 75, cachedInputPerM: 1.5 }, maxTokens: 8192 },
    },
    budget: { maxUsdPerTask: 0.5, maxTokensPerTask: 200_000, maxSteps: 24, maxToolCalls: 40 },
    warden: {
      minReputation: 0.25,
      blockAtSeverity: "high",
      sensitiveToolPatterns: [
        "*delete*", "*write*", "*exec*", "*shell*", "*payment*", "*transfer*", "*email*", "*send*",
        // on-chain / spending tools — must require explicit owner approval.
        // (Spend tools are named to match these; read tools like lottery_status,
        // oracle_call, hub_discover deliberately do NOT match.)
        "*invoke*", "*trade*", "*swap*", "*buy*", "*spend*", "*approve*", "*withdraw*",
      ],
      allowUnknownServers: true,
      pinToolDefs: true,
      oracleFamilyUrl: process.env.ARGUS_ORACLE_FAMILY_URL ?? "https://oracles.modelmarket.dev/family",
      threatFeedUrl: process.env.ARGUS_THREAT_FEED_URL || undefined,
      feedPublicKey: process.env.ARGUS_THREAT_FEED_PUBKEY || undefined,
      egressAllowlist: (process.env.ARGUS_EGRESS_ALLOWLIST ?? "")
        .split(",")
        .map((h) => h.trim())
        .filter(Boolean),
    },
    economy: {
      enabled: false,
      hubUrl: process.env.ARGUS_HUB_URL ?? "https://magic-ai-factory.com",
      meshUrl: process.env.ARGUS_MESH_URL ?? "http://127.0.0.1:8090",
      oracleFamilyUrl: process.env.ARGUS_ORACLE_FAMILY_URL ?? "https://oracles.modelmarket.dev/family",
      affiliate: "argus",
      defaultDepositUsd: 1.0,
      chain: "base",
      token: "USDC",
      acexEnabled: false,
      minHubTrust: Number(process.env.ARGUS_MIN_HUB_TRUST ?? "0.25"),
      bondUsd: Number(process.env.ARGUS_SELF_BOND_USD ?? "0"),
      penaltyRate: Number(process.env.ARGUS_SELF_BOND_RATE ?? "1"),
      verifyTee: true,
      verifyOutputs: envTruthy(process.env.ARGUS_VERIFY_OUTPUTS),
    },
    mcp: { catalogs: [], servers: [] },
    memory: { dir: join(DEFAULT_STATE_DIR, "memory") },
    telegram: {},
    http: {
      enabled: true,
      port: Number(process.env.ARGUS_HTTP_PORT) || 8787,
      tlsCert: process.env.ARGUS_TLS_CERT || undefined,
      tlsKey: process.env.ARGUS_TLS_KEY || undefined,
      maxConcurrent: Number(process.env.ARGUS_HTTP_MAX_CONCURRENT) || 4,
    },
    monitor: {
      url: (process.env.ALIEN_MONITOR_URL ?? process.env.MONITOR_URL ?? "").replace(/\/+$/, ""),
      token: process.env.ALIEN_API_TOKEN ?? process.env.ALIEN_MONITOR_API_TOKEN ?? "",
    },
    arena: {},
    stateDir: DEFAULT_STATE_DIR,
  };
}

/** Find argus.config.json: explicit path → cwd → package dir example. */
function resolveConfigPath(explicit?: string): string | undefined {
  const candidates = [
    explicit,
    process.env.ARGUS_CONFIG,
    resolve(process.cwd(), "argus.config.json"),
    resolve(__dirname, "..", "argus.config.json"),
  ].filter(Boolean) as string[];
  return candidates.find((p) => existsSync(p));
}

function deepMerge<T>(base: T, over: Partial<T> | undefined): T {
  if (!over) return base;
  const out: any = Array.isArray(base) ? [...(base as any)] : { ...base };
  for (const [k, v] of Object.entries(over)) {
    if (v === undefined) continue;
    const cur = (base as any)[k];
    out[k] = v && typeof v === "object" && !Array.isArray(v) && cur && typeof cur === "object"
      ? deepMerge(cur, v as any)
      : v;
  }
  return out as T;
}

export interface LoadedConfig {
  config: ArgusConfig;
  path?: string;
}

/**
 * Load config: defaults ← argus.config.json ← environment secrets.
 * Crucially, `economy.enabled` is derived purely from the presence of a wallet
 * key, so an unconfigured ARGUS runs fully autonomously.
 */
export function loadConfig(explicitPath?: string): LoadedConfig {
  const base = defaults();
  const path = resolveConfigPath(explicitPath);
  let merged = base;

  if (path) {
    try {
      const raw = JSON.parse(readFileSync(path, "utf8")) as RawConfig;
      merged = deepMerge(base, raw as Partial<ArgusConfig>);
    } catch (err) {
      throw new Error(`Failed to parse config at ${path}: ${(err as Error).message}`);
    }
  }

  // Secrets: prefer the encrypted keystore (vault) over a plaintext env var.
  const walletKey = resolveWalletKey(merged.stateDir);
  merged.economy.walletKey = walletKey;
  // The environment is the final authority on the crypto switch, so the committed
  // code/config default OFF and a deployment opts in via .env (never committed).
  // AIFACTORY_CRYPTO_ENABLED (ecosystem-wide) wins, then ARGUS_CRYPTO_ENABLED (back-compat).
  const envCrypto = cryptoEnvSetting();
  if (envCrypto != null) merged.cryptoEnabled = envCrypto;
  // Economy requires BOTH the master crypto switch AND a wallet. Crypto is OFF by
  // default — a real blockchain is never required to run ARGUS.
  merged.economy.enabled = merged.cryptoEnabled && Boolean(walletKey);

  // Monitor feed secrets always from env — never from committed argus.config.json.
  merged.monitor = {
    url: (process.env.ALIEN_MONITOR_URL ?? process.env.MONITOR_URL ?? merged.monitor?.url ?? "").replace(
      /\/+$/,
      "",
    ),
    token: process.env.ALIEN_API_TOKEN ?? process.env.ALIEN_MONITOR_API_TOKEN ?? "",
  };

  return { config: merged, path };
}

/** Resolve an API key for a provider, or undefined. */
export function providerKey(p: ProviderConfig): string | undefined {
  if (!p.apiKeyEnv) return undefined;
  return process.env[p.apiKeyEnv]?.trim() || undefined;
}

/** Split "providerId/model" into parts. */
export function parseModelRef(ref: string): { provider: string; model: string } {
  const i = ref.indexOf("/");
  if (i < 0) throw new Error(`Invalid model ref "${ref}" (expected "provider/model")`);
  return { provider: ref.slice(0, i), model: ref.slice(i + 1) };
}

export function modelForTier(cfg: ArgusConfig, tier: Tier): ModelConfig {
  const m = cfg.models[tier] ?? cfg.models.core;
  return m;
}
