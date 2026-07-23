import type { DiscoveredCapability, EconomyConsumer, InvokeOutcome, Logger, VerificationOutcome } from "../types.js";

/** Max bytes to read from a Hub error response body (guards OOM on a malicious
 *  or misconfigured endpoint that streams an unbounded response). */
const MAX_ERROR_BODY = 2048;

/** Max bytes for a Hub search response (capped to avoid OOM on a bad endpoint). */
const MAX_SEARCH_BODY = 256_000;

/** Pay-on-Verified: `wait_timeout_s` sent with the verify block (the hub caps
 *  synchronous verdict waits at 300s; longer waits degrade to a pending envelope). */
const VERIFY_WAIT_TIMEOUT_S = 300;

/** Per-attempt HTTP timeout while a verified invoke waits on its verdict. MUST exceed
 *  the hub's 300s wait cap — the SDK's default 30s timeout would abort mid-wait and
 *  its retry loop would RE-INVOKE (i.e. pay again). Mirrors the hub's own 330s. */
const VERIFY_ATTEMPT_TIMEOUT_MS = 330_000;

/** Verdict polling backoff: 5s doubling to a 300s cap, NO overall deadline — matches
 *  the hub's own retry policy. An unresolved verdict is buyer-safe (hold, no debit). */
const VERIFY_POLL_INITIAL_MS = 5_000;
const VERIFY_POLL_CAP_MS = 300_000;

/** Consecutive `404 verification_not_found` responses tolerated before the poller gives
 *  up. A 404 right after invoke can be read-replica lag, but a persistent one is definitive
 *  — the hub has no such record and never will (mirrors the Python SDK, which returns on
 *  the first `verification_not_found`). Without this, the poll would spin forever. */
const VERIFY_POLL_MAX_NOT_FOUND = 2;

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
    /** Pay-on-Verified request block — threaded natively by verify-aware SDKs (>0.1.0). */
    verify?: Record<string, unknown>;
  }): Promise<any>;
  closeChannel(channelId: string): Promise<any>;
}

export interface AimarketConsumerOptions {
  hubUrl: string;
  walletKey: string;
  affiliate: string;
  verifyTee: boolean;
  /** Pay-on-Verified: request Metis-verified (escrowed) settlement on every paid invoke. */
  verifyOutputs: boolean;
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
  /** Verify block for the invoke currently in flight (consumed by fetchWithVerify). */
  private pendingVerify: Record<string, unknown> | null = null;
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
    const agentOpts: Record<string, unknown> = {
      hubUrl: this.o.hubUrl,
      walletKey: this.o.walletKey,
      affiliate: this.o.affiliate,
      verifyTee: this.o.verifyTee,
    };
    if (this.o.verifyOutputs) {
      // wait=true holds the invoke response server-side up to VERIFY_WAIT_TIMEOUT_S; the
      // SDK's default 30s timeout would abort mid-wait and retry — i.e. PAY AGAIN.
      agentOpts.timeoutMs = VERIFY_ATTEMPT_TIMEOUT_MS;
      // The published SDK (0.1.0) drops unknown invoke opts, so the verify block is
      // injected at the fetch layer; verify-aware SDKs that already sent one win.
      agentOpts.fetch = (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
        this.fetchWithVerify(input, init);
    }
    this.agent = new mod.AimarketAgent(agentOpts) as AimarketAgentLike;
    return this.agent;
  }

  /** Fetch wrapper that splices the pending Pay-on-Verified `verify` block into the v2
   *  invoke body when the SDK dropped it (unknown opt on 0.1.0). Signed invoke headers
   *  cover channel/capability/affiliate — not the body — so the splice stays valid. */
  private fetchWithVerify(input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]): Promise<Response> {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (this.pendingVerify && init?.method === "POST" && url.endsWith("/ai-market/v2/invoke") && typeof init.body === "string") {
      const body = JSON.parse(init.body) as Record<string, unknown>;
      if (!("verify" in body)) {
        body.verify = this.pendingVerify;
        init = { ...init, body: JSON.stringify(body) };
      }
    }
    return fetch(input, init);
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
    opts?: { productId?: string; sourceHub?: string; intent?: string },
  ): Promise<InvokeOutcome> {
    const agent = await this.ready();
    const channelId = await this.ensureChannel();
    // Pay-on-Verified (buyer opt-in): the hub HOLDS the channel debit until Metis
    // verdicts the output — pass captures, fail refunds. ARGUS is the fail-closed
    // reference buyer: it WAITS for the verdict inline (hub cap 300s) and degrades
    // to polling the lookup endpoint when the hub answers "pending".
    const verify = this.o.verifyOutputs
      ? {
          requested: true,
          intent:
            opts?.intent?.trim() ||
            `Correctly and completely fulfil capability ${capabilityId} for input: ${JSON.stringify(input ?? {}).slice(0, 500)}`,
          mode: "auto",
          wait: true,
          wait_timeout_s: VERIFY_WAIT_TIMEOUT_S,
        }
      : undefined;
    this.pendingVerify = verify ?? null;
    let r: any;
    try {
      r = await agent.invoke({
        capabilityId,
        input: (input ?? {}) as Record<string, unknown>,
        channelId,
        productId: opts?.productId,
        sourceHub: opts?.sourceHub,
        verifyTee: this.o.verifyTee,
        verify,
      });
    } finally {
      this.pendingVerify = null;
    }
    const verification = verify ? await this.resolveVerification(r) : undefined;
    return {
      ok: Boolean(r.success),
      // SDK InvokeResult exposes the capability payload under `result` (the hub's
      // invoke body key); `output` never existed on the wire.
      output: r.result ?? (r as { output?: unknown }).output ?? null,
      priceUsd: r.price_usd ?? 0,
      receiptValid: Boolean(r.tee_verified),
      latencyMs: r.latency_ms ?? 0,
      error: r.error,
      verification,
    };
  }

  /** Resolve the Pay-on-Verified outcome from an invoke response: take the inline
   *  envelope (wait=true usually resolves it) and poll the lookup endpoint when the
   *  hub answered "pending". Returns undefined when the hub sent no envelope at all
   *  (failed invoke, or a hub that predates verified settlement). */
  private async resolveVerification(r: any): Promise<VerificationOutcome | undefined> {
    let envelope = (r?.verification ?? null) as Record<string, unknown> | null;
    let rejection = (r?.rejection_receipt ?? undefined) as Record<string, unknown> | undefined;
    const receipt = r?.receipt as Record<string, unknown> | undefined;
    const nonce = typeof receipt?.nonce === "string" ? (receipt.nonce as string) : undefined;
    if (!envelope || typeof envelope !== "object") {
      if (r?.success) this.o.log.warn("verified settlement requested but the hub returned no verification envelope (old hub?)");
      return undefined;
    }
    if (envelope.status === "pending") {
      if (nonce) {
        ({ envelope, rejection } = await this.pollVerification(nonce, envelope));
      } else {
        this.o.log.warn("verification pending but the invoke response carries no receipt nonce — cannot poll");
      }
    }
    const status = String(envelope.status ?? "pending");
    const out: VerificationOutcome = {
      status,
      verified: typeof envelope.verified === "boolean" ? envelope.verified : null,
      verifyScore: typeof envelope.verify_score === "number" ? envelope.verify_score : null,
      traceId: typeof envelope.trace_id === "string" ? envelope.trace_id : null,
      refunded: status === "refunded",
      nonce,
      envelope,
      rejectionReceipt: rejection,
    };
    if (out.status === "settled") {
      this.o.log.info(`verified ✓ score ${out.verifyScore ?? "?"} · trace ${out.traceId ?? "?"} · debit captured`);
    } else if (out.refunded) {
      this.o.log.warn(`verification FAILED — payment refunded (score ${out.verifyScore ?? "?"}, trace ${out.traceId ?? "?"})`);
    } else {
      const hint = out.status === "pending" && out.nonce ? ` — check later: GET /ai-market/v2/verification/${out.nonce}` : "";
      this.o.log.info(`verification ${out.status}${hint}`);
    }
    return out;
  }

  /** Poll GET /ai-market/v2/verification/{nonce} until the verdict resolves. Exponential
   *  backoff (5s → cap 300s) with NO overall deadline — mirroring the hub, which retries
   *  the verdict indefinitely; a still-pending hold is buyer-safe (no verdict, no debit). */
  private async pollVerification(
    nonce: string,
    pending: Record<string, unknown>,
  ): Promise<{ envelope: Record<string, unknown>; rejection?: Record<string, unknown> }> {
    let envelope = pending;
    let delayMs = VERIFY_POLL_INITIAL_MS;
    let notFound = 0;
    for (;;) {
      await this.sleep(delayMs);
      delayMs = Math.min(delayMs * 2, VERIFY_POLL_CAP_MS);
      try {
        const res = await fetch(`${this.o.hubUrl}/ai-market/v2/verification/${encodeURIComponent(nonce)}`, {
          headers: { "X-AIMarket-Affiliate": this.o.affiliate },
        });
        if (!res.ok) {
          const body = await readErrorBody(res);
          // A `404 verification_not_found` is definitive: the record isn't there and never
          // will be. Tolerate a couple in a row (read-replica lag right after invoke), then
          // give up rather than poll forever — returning the last-known pending envelope so
          // resolveVerification takes its existing "check later" path instead of hanging.
          if (res.status === 404 && body.includes("verification_not_found")) {
            if (++notFound > VERIFY_POLL_MAX_NOT_FOUND) {
              this.o.log.warn(
                `verification ${nonce} unknown to the hub — giving up; check later via GET /ai-market/v2/verification/${nonce}`,
              );
              return { envelope };
            }
            this.o.log.debug(`verification ${nonce} not found (404) — replica lag? attempt ${notFound}/${VERIFY_POLL_MAX_NOT_FOUND}`);
            continue;
          }
          this.o.log.debug(`verification poll HTTP ${res.status}: ${body} — retrying`);
          continue;
        }
        notFound = 0;
        checkJsonContent(res, "verification lookup");
        const data: any = await res.json();
        const env = data?.verification;
        if (env && typeof env === "object") {
          envelope = env as Record<string, unknown>;
          if (envelope.status !== "pending") {
            return { envelope, rejection: (data.rejection_receipt ?? undefined) as Record<string, unknown> | undefined };
          }
        }
        this.o.log.debug(`verification ${nonce} still pending — next poll in ${Math.round(delayMs / 1000)}s`);
      } catch (err) {
        this.o.log.debug(`verification poll failed (${(err as Error).message}) — retrying`);
      }
    }
  }

  /** Seam for tests (poll backoff without real waiting). */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
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
