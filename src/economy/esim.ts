/**
 * Travel eSIMs from any seller that speaks the `esim.*@v1` contract (the eSIM operator kit,
 * esim-kit/rails): quote, buy over x402 from ARGUS's own wallet, read the status, ask for a refund.
 *
 * Sellers are found through AIMarket hubs: a hub lists each seller's free `esim.quote@v1`, a quote
 * routed through the hub names the seller's own `/order`, and the purchase is paid there directly
 * (the hub never holds the money). A seller whose quote says `demo: true` is shown, never paid. A node
 * that is in no hub (a private one) can be added directly (ARGUS_ESIM_SELLER).
 *
 * The activation code (the LPA string) and the QR link belong to the person the eSIM is for. They go
 * from the seller's answer straight to the owner (channels/owner-notify.ts) and never into the model's
 * context, the memory or the ledger. The ledger (`<stateDir>/esim-purchases.json`, 0600) keeps what a
 * status check and a refund need: the profile number, its status token, the seller, the price, the payer.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Hex } from "viem";

export interface EsimOffer {
  offer_id: string;
  name: string;
  coverage: { kind: string; countries: string[] };
  data_gb: number;
  days: number;
  speed?: string;
  price: { usd: string; currency: string };
}

/** What the seller hands the payer (esim-kit/rails/spec/esim-v1/delivery.schema.json). */
export interface EsimDelivery {
  order_no: string | null;
  esim_tran_no: string;
  iccid: string | null;
  activation_code: string;
  qr_code_url: string | null;
  install_url: string | null;
  apn: string | null;
  expires: string | null;
  status_token: string;
  offer?: EsimOffer;
  /** The seller's signed delivery receipt (eSIM operator kit), for a hub's delivery counter. */
  receipt?: Record<string, unknown>;
  receipt_signature?: string;
}

export interface EsimPurchase {
  seller: string;
  offerId: string;
  name: string;
  priceUsd: string;
  esimTranNo: string;
  iccid: string | null;
  statusToken: string;
  payer: string;
  transaction: string | null;
  at: string;
  refund?: { status: string; amountUsd: string | null; to: string | null; transaction: string | null; at: string };
  /** The hub that listed the seller (where the delivery evidence goes), if it was found through one. */
  hub?: string;
  /** What hubs answered to the shared delivery / refund receipts. */
  shared?: Record<string, string>;
}

/** One seller's answer to a quote: where it sells, whether it really does, and its offers. */
export interface SellerQuote {
  seller: string;
  /** The seller node's base URL: `${base}/order`, `/status`, `/refund`. */
  base: string;
  orderUrl: string;
  demo: boolean;
  offers: EsimOffer[];
  via: "hub" | "direct";
  hub?: string;
}

export class EsimError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

type FetchFn = typeof fetch;

/** A seller's base URL: https, or http on this machine only (a local test node). */
/** A seller's base URL from its order URL (`…/order`). */
export const baseOf = (orderUrl: string): string => sellerUrl(orderUrl).replace(/\/order$/, "");

export function sellerUrl(raw: string): string {
  const u = new URL(String(raw).trim());
  const local = ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname);
  if (u.protocol !== "https:" && !(u.protocol === "http:" && local)) throw new EsimError("bad_seller", "a seller is an https URL");
  return u.toString().replace(/\/+$/, "");
}

export class EsimClient {
  private readonly ledgerPath: string;

  constructor(stateDir: string, private readonly fetchImpl: FetchFn = fetch) {
    this.ledgerPath = join(stateDir, "esim-purchases.json");
  }

  private async post(url: string, body: unknown): Promise<{ status: number; json: any }> {
    const res = await this.fetchImpl(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    let json: any = null;
    try { json = await res.json(); } catch { /* not JSON */ }
    return { status: res.status, json };
  }

  /** esim.quote@v1: the seller's offers for a country, cheapest first. */
  async offers(seller: string, q: { country: string; minGb?: number; minDays?: number; maxUsd?: number; limit?: number }): Promise<{ seller: string; offers: EsimOffer[]; orderUrl: string; demo: boolean }> {
    const base = sellerUrl(seller);
    const { status, json } = await this.post(`${base}/quote`, {
      country: q.country.toUpperCase(), min_gb: q.minGb ?? 0, min_days: q.minDays ?? 0, ...(q.maxUsd ? { max_usd: q.maxUsd } : {}), limit: q.limit ?? 5,
    });
    if (status !== 200 || !json?.success) throw new EsimError(json?.error ?? `http_${status}`, json?.message ?? "the seller did not quote");
    return { seller: json.result.seller?.name ?? base, offers: json.result.offers ?? [], orderUrl: json.result.order?.url ?? `${base}/order`, demo: Boolean(json.result.seller?.demo) };
  }

  /**
   * esim.order@v1 over x402: one USDC authorization from `privateKey`'s wallet for the offer's price,
   * signed only when the seller asks for no more than `maxUsd`. A 503 (the profile is still being made)
   * is retried with the SAME payment: a new one would be a second order.
   */
  /** The sellers a hub lists: one per `esim.quote@v1` listing (search is free). */
  async hubSellers(hub: string): Promise<Array<{ productId: string; sourceHub: string; name: string }>> {
    const base = sellerUrl(hub);
    const res = await this.fetchImpl(`${base}/ai-market/v2/search?intent=esim&limit=50`, { headers: { accept: "application/json" } });
    if (!res.ok) throw new EsimError(`hub_${res.status}`, `${base} did not answer the search`);
    const json: any = await res.json();
    const seen = new Set<string>();
    const out: Array<{ productId: string; sourceHub: string; name: string }> = [];
    for (const m of json?.matches ?? []) {
      if (!String(m?.capability_id ?? "").startsWith("esim.quote@")) continue;
      const key = `${m.source_hub}|${m.product_id}`;
      if (seen.has(key) || m.route_status === "down") continue;
      seen.add(key);
      out.push({ productId: String(m.product_id), sourceHub: String(m.source_hub ?? ""), name: String(m.source_hub_name ?? m.product_id) });
    }
    return out;
  }

  /** esim.quote@v1 of one seller, through the hub that lists it (free). */
  async quoteViaHub(hub: string, s: { productId: string; sourceHub: string; name: string }, q: { country: string; minGb?: number; minDays?: number; maxUsd?: number; limit?: number }): Promise<SellerQuote> {
    const base = sellerUrl(hub);
    const { status, json } = await this.post(`${base}/ai-market/v2/invoke`, {
      capability_id: "esim.quote@v1", product_id: s.productId, ...(s.sourceHub ? { source_hub: s.sourceHub } : {}), purpose: "esim-quote",
      input: { country: q.country.toUpperCase(), min_gb: q.minGb ?? 0, min_days: q.minDays ?? 0, ...(q.maxUsd ? { max_usd: q.maxUsd } : {}), limit: q.limit ?? 5 },
    });
    // The hub wraps the seller's answer: {success, result: {success, result: {seller, offers, order}}}.
    const r = json?.result?.result ?? json?.result;
    if (status !== 200 || !json?.success || !r?.offers) throw new EsimError(json?.error ?? `http_${status}`, json?.detail ?? json?.message ?? `${s.name} did not quote`);
    const orderUrl = sellerUrl(String(r.order?.url ?? ""));
    return { seller: r.seller?.name ?? s.name, base: baseOf(orderUrl), orderUrl, demo: Boolean(r.seller?.demo), offers: r.offers, via: "hub", hub: base };
  }

  /**
   * Every seller's offers for a country: each hub's eSIM sellers, quoted through the hub, plus any
   * seller given directly. One seller failing does not hide the others; the errors come back too.
   */
  async quoteAll(q: { country: string; minGb?: number; minDays?: number; maxUsd?: number; limit?: number }, where: { hubs: string[]; direct?: string[] }): Promise<{ quotes: SellerQuote[]; errors: string[] }> {
    const errors: string[] = [];
    const jobs: Array<Promise<SellerQuote | null>> = [];
    for (const d of where.direct ?? []) {
      jobs.push(this.offers(d, q).then((r) => ({ seller: r.seller, base: baseOf(r.orderUrl), orderUrl: sellerUrl(r.orderUrl), demo: r.demo, offers: r.offers, via: "direct" as const }))
        .catch((err) => { errors.push(`${d}: ${err.message}`); return null; }));
    }
    for (const hub of where.hubs) {
      let sellers: Array<{ productId: string; sourceHub: string; name: string }> = [];
      try { sellers = await this.hubSellers(hub); } catch (err) { errors.push(`${hub}: ${(err as Error).message}`); continue; }
      for (const s of sellers) {
        jobs.push(this.quoteViaHub(hub, s, q).catch((err) => { errors.push(`${s.name}: ${err.message}`); return null; }));
      }
    }
    const all = (await Promise.all(jobs)).filter((x): x is SellerQuote => x !== null);
    // The same seller reached two ways (a hub and directly, or two hubs): keep one.
    const seen = new Set<string>();
    const quotes = all.filter((x) => (seen.has(x.orderUrl) ? false : (seen.add(x.orderUrl), true)));
    return { quotes, errors };
  }

  async buy(orderUrl: string, offerId: string, privateKey: Hex, maxUsd: number): Promise<{ delivery: EsimDelivery; transaction: string | null; payer: string; priceUsd: string }> {
    // A seller's base URL (…/agents) or its order URL (…/agents/order), as a quote names it.
    const target = /\/order$/.test(sellerUrl(orderUrl)) ? sellerUrl(orderUrl) : `${sellerUrl(orderUrl)}/order`;
    const [{ wrapFetchWithPaymentFromConfig }, { ExactEvmScheme }, { privateKeyToAccount }] = await Promise.all([
      import("@x402/fetch"), import("@x402/evm"), import("viem/accounts"),
    ]);
    const account = privateKeyToAccount(privateKey);
    let paidHeaders: Headers | null = null;
    let askedUnits: bigint | null = null;
    const keep: FetchFn = async (input, init) => {
      const req = new Request(input as string | URL | Request, init);
      if (req.headers.has("PAYMENT-SIGNATURE")) paidHeaders = new Headers(req.headers);
      return this.fetchImpl(req);
    };
    const paying = wrapFetchWithPaymentFromConfig(keep, {
      schemes: [{ network: "eip155:8453", client: new ExactEvmScheme(account) }],
      // The spending cap is checked on the seller's own terms, before anything is signed.
      paymentRequirementsSelector: (_v: number, accepts: Array<{ amount: string; network: string }>) => {
        const pick = accepts.find((a) => a.network === "eip155:8453") ?? accepts[0];
        if (!pick) throw new EsimError("no_terms", "the seller offered no way to pay");
        askedUnits = BigInt(pick.amount);
        if (Number(askedUnits) / 1e6 > maxUsd) throw new EsimError("over_budget", `the seller asks ${Number(askedUnits) / 1e6} USDC, above the ${maxUsd} USDC cap`);
        return pick;
      },
      // The x402 client's own ceiling as well, so no other path signs more.
      spendControls: { maxAmountPerPayment: `$${maxUsd}` },
    } as any) as FetchFn;
    const body = JSON.stringify({ offer_id: offerId });
    const url = target;
    let res = await paying(url, { method: "POST", headers: { "content-type": "application/json" }, body });
    for (let i = 0; i < 6 && res.status === 503 && paidHeaders; i++) {
      await new Promise((r) => setTimeout(r, 1000 * Math.min(Number(res.headers.get("retry-after") || 10), 30)));
      res = await this.fetchImpl(url, { method: "POST", headers: paidHeaders, body });
    }
    if (res.status === 402) {
      let why = "no reason given";
      try { why = JSON.parse(Buffer.from(res.headers.get("payment-required") ?? "", "base64").toString("utf8")).error || why; } catch { /* none */ }
      throw new EsimError("payment_refused", `the seller refused the payment: ${why}`);
    }
    const json: any = await res.json().catch(() => null);
    if (!res.ok || !json?.success) throw new EsimError(json?.error ?? `http_${res.status}`, json?.message ?? "the order failed");
    let transaction: string | null = null;
    try { transaction = JSON.parse(Buffer.from(res.headers.get("payment-response") ?? "", "base64").toString("utf8")).transaction ?? null; } catch { /* none */ }
    const delivery = json.result as EsimDelivery;
    const priceUsd = delivery.offer?.price?.usd ?? (askedUnits !== null ? (Number(askedUnits) / 1e6).toFixed(2) : "?");
    return { delivery, transaction, payer: account.address, priceUsd };
  }

  /** esim.status@v1, without the activation code (the owner already has it). */
  async status(p: EsimPurchase): Promise<Record<string, unknown>> {
    const { status, json } = await this.post(`${sellerUrl(p.seller)}/status`, { esim_tran_no: p.esimTranNo, status_token: p.statusToken });
    if (status !== 200 || !json?.success) throw new EsimError(json?.error ?? `http_${status}`, json?.message ?? "no status");
    const { activation_code: _a, qr_code_url: _q, install_url: _i, status_token: _t, ...rest } = json.result ?? {};
    return rest;
  }

  /** A refund of an unused eSIM: the seller cancels it and pays the price back to the wallet that paid. */
  /**
   * Bring a seller's signed receipt and its transaction to a hub, as evidence that the seller
   * delivered (or refunded): the hub checks both and counts it for the seller (no amounts, no
   * addresses kept). → the hub's answer, or throws with its reason.
   */
  async shareReceipt(hub: string, receipt: Record<string, unknown>, signature: string, transaction: string): Promise<{ recorded: boolean; deliveries_30d?: unknown }> {
    const { status, json } = await this.post(`${sellerUrl(hub)}/ai-market/v2/reputation/deliveries`, { receipt, signature, transaction });
    if (status !== 200) throw new EsimError(`hub_${status}`, String(json?.detail ?? json?.message ?? "refused"));
    return json;
  }

  async refund(p: EsimPurchase): Promise<{ status: string; amount_usd: string | null; to: string | null; transaction: string | null; receipt?: Record<string, unknown>; receipt_signature?: string }> {
    const { status, json } = await this.post(`${sellerUrl(p.seller)}/refund`, { esim_tran_no: p.esimTranNo, status_token: p.statusToken });
    if (status !== 200 || !json?.success) throw new EsimError(json?.error ?? `http_${status}`, json?.message ?? "the seller did not refund");
    const r = json.result;
    return { status: r.status, amount_usd: r.amount_usd ?? null, to: r.to ?? null, transaction: r.transaction ?? null,
             receipt: r.receipt, receipt_signature: r.receipt_signature };
  }

  // ── the ledger: no activation codes, ever ──────────────────────────────────

  purchases(): EsimPurchase[] {
    if (!existsSync(this.ledgerPath)) return [];
    try { return JSON.parse(readFileSync(this.ledgerPath, "utf8")) as EsimPurchase[]; } catch { return []; }
  }

  /** The purchase with that profile number, or the latest one. */
  find(esimTranNo?: string): EsimPurchase | null {
    const all = this.purchases();
    return (esimTranNo ? all.find((x) => x.esimTranNo === esimTranNo) : all.at(-1)) ?? null;
  }

  save(p: EsimPurchase): void {
    const all = this.purchases().filter((x) => x.esimTranNo !== p.esimTranNo);
    all.push(p);
    mkdirSync(dirname(this.ledgerPath), { recursive: true });
    const tmp = `${this.ledgerPath}.tmp`;
    writeFileSync(tmp, JSON.stringify(all, null, 1), { mode: 0o600 });
    renameSync(tmp, this.ledgerPath);
  }
}
