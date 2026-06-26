import type { DiscoveredCapability, EconomyConsumer, InvokeOutcome, Logger } from "../types.js";

/** Max bytes to read from a Hub error response body (guards OOM on a malicious
 *  or misconfigured endpoint that streams an unbounded response). */
const MAX_ERROR_BODY = 2048;

/** Max bytes for a Hub search response (capped to avoid OOM on a bad endpoint). */
const MAX_SEARCH_BODY = 256_000;

/** Minimal shape of the @aimarket/agent SDK we depend on (decoupled so a
 *  missing/unbuilt SDK degrades gracefully instead of breaking typecheck). */
interface AimarketAgentLike {
  discover(opts: { intent: string; budget?: number; limit?: number }): Promise<any[]>;
  openChannel(depositUsd: number, token?: string, chain?: string): Promise<any>;
  invoke(opts: {
    capabilityId: string;
    input: Record<string, unknown>;
    channelId: string;
    productId?: string;
    sourceHub?: string;
    verifyTee?: boolean;
  }): Promise<any>;
  closeChannel(channelId: string): Promise<any>;
}

export interface AimarketConsumerOptions {
  hubUrl: string;
  walletKey: string;
  affiliate: string;
  verifyTee: boolean;
  defaultDepositUsd: number;
  minHubTrust: number;
  token: string;
  chain: string;
  log: Logger;
}

/** Ensure a URL is HTTPS (or localhost for dev). Refuse to talk to cleartext hubs. */
function requireSecureHub(url: string, label: string): void {
  if (!/^https:\/\//i.test(url) && !/^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?\/?$/i.test(url)) {
    throw new Error(`${label} must be HTTPS (or localhost for dev): got "${url}"`);
  }
}

/** Read a bounded slice of a response body for error reporting. */
async function readErrorBody(res: Response): Promise<string> {
  try {
    const text = await res.text();
    return text.slice(0, MAX_ERROR_BODY);
  } catch {
    return "(body unreadable)";
  }
}

/** Validate Content-Type before parsing JSON. */
function checkJsonContent(res: Response, label: string): void {
  const ct = res.headers.get("content-type") ?? "";
  if (!ct.includes("application/json") && !ct.includes("+json")) {
    throw new Error(`${label}: expected JSON but got "${ct}"`);
  }
}

/**
 * Demand-side client. Wraps the existing `@aimarket/agent` SDK (the canonical
 * AI Market Protocol v2 consumer) — ARGUS reuses ecosystem components rather
 * than reimplementing the 5-phase paid cycle. The SDK is dynamically imported so
 * the economy module is entirely absent unless a wallet is configured.
 */
export class AimarketConsumer implements EconomyConsumer {
  private agent: AimarketAgentLike | null = null;
  private channelId: string | null = null;
  private readonly o: AimarketConsumerOptions;

  constructor(opts: AimarketConsumerOptions) {
    this.o = opts;
    requireSecureHub(opts.hubUrl, "hubUrl");
  }

  private async ready(): Promise<AimarketAgentLike> {
    if (this.agent) return this.agent;
    let mod: any;
    try {
      const sdkModule = "@aimarket/agent";
      mod = await import(sdkModule);
    } catch (err) {
      throw new Error(
        `@aimarket/agent SDK not available (${(err as Error).message}). ` +
          `Run \`npm install\` in argus/ — the economy module needs it.`,
      );
    }
    this.agent = new mod.AimarketAgent({
      hubUrl: this.o.hubUrl,
      walletKey: this.o.walletKey,
      affiliate: this.o.affiliate,
      verifyTee: this.o.verifyTee,
    }) as AimarketAgentLike;
    return this.agent;
  }

  async discover(intent: string, budgetUsd: number, limit = 5): Promise<DiscoveredCapability[]> {
    const params = new URLSearchParams({ intent, limit: String(limit) });
    if (budgetUsd != null) params.set("budget", String(budgetUsd));
    if (this.o.minHubTrust > 0) params.set("min_trust", String(this.o.minHubTrust));
    const res = await fetch(`${this.o.hubUrl}/ai-market/v2/search?${params.toString()}`, {
      headers: { "X-AIMarket-Affiliate": this.o.affiliate },
    });
    if (!res.ok) throw new Error(`hub search HTTP ${res.status}: ${await readErrorBody(res)}`);
    checkJsonContent(res, "hub search");
    // Guard against oversized responses (OOM / zip-bomb via a bad endpoint).
    const cl = res.headers.get("content-length");
    if (cl && Number(cl) > MAX_SEARCH_BODY) {
      throw new Error(`hub search: content-length ${cl} exceeds ${MAX_SEARCH_BODY} byte limit`);
    }
    const data: any = await res.json();
    // The AIMarket v2 search returns capabilities under `matches` (each match IS
    // the capability). Be defensive about the exact key/shape.
    const results: any[] = Array.isArray(data.matches)
      ? data.matches
      : Array.isArray(data.results)
        ? data.results
        : [];
    return results.map((p) => {
      const c = p.capability ?? p ?? {};
      return {
        capabilityId: c.capability_id,
        productId: c.product_id,
        name: c.name,
        description: c.description,
        priceUsd: c.price_per_call_usd ?? c.routed_price_usd ?? 0,
        trustScore: c.trust_score,
        p50LatencyMs: c.p50_latency_ms,
        sourceHub: c.source_hub,
      } satisfies DiscoveredCapability;
    });
  }

  private async ensureChannel(): Promise<string> {
    if (this.channelId) return this.channelId;
    const agent = await this.ready();
    const ch = await agent.openChannel(this.o.defaultDepositUsd, this.o.token, this.o.chain);
    this.channelId = ch.channel_id;
    this.o.log.info(`opened payment channel ${this.channelId} (${ch.balance_usd} ${this.o.token} on ${this.o.chain})`);
    return this.channelId!;
  }

  async invoke(
    capabilityId: string,
    input: unknown,
    opts?: { productId?: string; sourceHub?: string },
  ): Promise<InvokeOutcome> {
    const agent = await this.ready();
    const channelId = await this.ensureChannel();
    const r = await agent.invoke({
      capabilityId,
      input: (input ?? {}) as Record<string, unknown>,
      channelId,
      productId: opts?.productId,
      sourceHub: opts?.sourceHub,
      verifyTee: this.o.verifyTee,
    });
    return {
      ok: Boolean(r.success),
      output: r.output ?? null,
      priceUsd: r.price_usd ?? 0,
      receiptValid: Boolean(r.tee_verified),
      latencyMs: r.latency_ms ?? 0,
      error: r.error,
    };
  }

  async settle(): Promise<{ refundedUsd: number; usedUsd: number }> {
    if (!this.channelId) return { refundedUsd: 0, usedUsd: 0 };
    const agent = await this.ready();
    const s = await agent.closeChannel(this.channelId);
    this.o.log.info(`settled channel ${this.channelId}: spent $${s.total_spent_usd}, refunded $${s.refund_usd}`);
    this.channelId = null;
    return { refundedUsd: s.refund_usd ?? 0, usedUsd: s.total_spent_usd ?? 0 };
  }
}
