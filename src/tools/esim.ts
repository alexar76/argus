/**
 * Travel eSIM tools: offers (free, from every seller the hubs list, plus a private one if configured),
 * buy (paid from ARGUS's wallet over x402 to the seller whose offer was picked — the name matches the
 * "*buy*" approval pattern, so the owner confirms each purchase), status (free) and refund (matches
 * "*refund*": the owner confirms it too, a cancelled eSIM cannot be used again).
 *
 * The model never sees an activation code: a delivered eSIM goes to the owner through
 * channels/owner-notify.ts, and the tool tells the model only that it was delivered and where.
 */
import type { Logger, Tool } from "../types.js";
import type { Hex } from "viem";
import { EsimClient, EsimError, baseOf, sellerUrl, type EsimPurchase, type SellerQuote } from "../economy/esim.js";
import { hasOwnerSink, notifyOwner } from "../channels/owner-notify.js";

export interface EsimToolDeps {
  /** A seller node that is in no hub (a private one), asked directly: an esim.*@v1 base URL, or "". */
  seller: string;
  /** Hubs whose eSIM sellers ARGUS finds and quotes (https://modelmarket.dev by default). */
  hubs: string[];
  /** Bring each seller's signed delivery / refund receipt to the hub (ARGUS_SHARE_DELIVERIES, on by default). */
  shareDeliveries?: boolean;
  /** Most ARGUS signs for one eSIM, in USDC. */
  maxUsd: number;
  /** ARGUS's wallet key, or null: then buying is off and offers/status still work. */
  walletKey: () => Hex | null;
  stateDir: string;
  log: Logger;
  /** For tests. */
  client?: EsimClient;
}

const COUNTRY = /^[A-Za-z]{2}$/;
const PROFILE = /^[0-9A-Za-z_-]{6,64}$/;

/** An offer as ARGUS last saw it, with the seller that made it: what esim_buy pays. */
interface Candidate { offerId: string; name: string; priceUsd: number; seller: string; orderUrl: string; demo: boolean; via: string; hub?: string }

export function buildEsimTools(d: EsimToolDeps): Tool[] {
  const client = d.client ?? new EsimClient(d.stateDir);
  let candidates: Candidate[] = [];   // from the last esim_offers, so esim_buy pays the seller that offered

  // The seller's signed receipt and the transaction, to the hub that listed it (or every configured
  // hub for a seller found directly), in the background: a fresh transaction may need a moment of
  // confirmations, so a refusal that says so is tried again; any other refusal is final.
  const share = (p: EsimPurchase, kind: "delivery" | "refund", receipt: Record<string, unknown> | undefined, sig: string | undefined, tx: string | null) => {
    if (d.shareDeliveries === false || !receipt || !sig || !tx) return;
    const hubs = p.hub ? [p.hub] : d.hubs;
    for (const hub of hubs) {
      const attempt = async (n: number): Promise<void> => {
        try {
          const r = await client.shareReceipt(hub, receipt, sig, tx);
          p.shared = { ...(p.shared ?? {}), [`${kind}@${hub}`]: r.recorded ? "recorded" : "already counted" };
          client.save(p);
          d.log.info(`${kind} receipt for ${p.esimTranNo} counted by ${hub}: ${JSON.stringify(r.deliveries_30d ?? {})}`);
        } catch (err) {
          const why = (err as Error).message;
          if (n < 4 && /confirmation|not on chain|429|hub_5/i.test(`${why} ${(err as EsimError).code ?? ""}`)) {
            setTimeout(() => void attempt(n + 1), [10_000, 30_000, 90_000, 180_000][n]);
            return;
          }
          p.shared = { ...(p.shared ?? {}), [`${kind}@${hub}`]: `refused: ${why}`.slice(0, 200) };
          client.save(p);
          d.log.warn(`${kind} receipt for ${p.esimTranNo} not counted by ${hub}: ${why}`);
        }
      };
      void attempt(0);
    }
  };
  const fail = (err: unknown) => ({ ok: false, content: err instanceof EsimError ? `${err.code}: ${err.message}` : `eSIM error: ${(err as Error).message}` });
  const purchase = (args: Record<string, unknown>): EsimPurchase | null => {
    const id = args.esim_tran_no == null ? undefined : String(args.esim_tran_no);
    if (id !== undefined && !PROFILE.test(id)) throw new EsimError("bad_input", "esim_tran_no is the profile number from the purchase");
    return client.find(id);
  };

  const offers: Tool = {
    source: { kind: "builtin" },
    def: {
      name: "esim_offers",
      description: "Travel data eSIM offers for a country from an eSIM seller (esim.quote@v1), cheapest first: data, days, price in USDC. Free; buys nothing.",
      inputSchema: { type: "object", required: ["country"], properties: {
        country: { type: "string", description: "ISO 3166-1 alpha-2 code of the destination, e.g. TR" },
        min_gb: { type: "number" }, days: { type: "integer", description: "at least this many days" },
        max_usd: { type: "number" }, seller: { type: "string", description: "seller node URL; the configured one by default" } } },
    },
    async run(args) {
      try {
        if (!COUNTRY.test(String(args.country ?? ""))) throw new EsimError("bad_input", "country is a two-letter code");
        const cc = String(args.country).toUpperCase();
        const q = { country: cc, minGb: Number(args.min_gb) || 0, minDays: Number(args.days) || 0, maxUsd: Number(args.max_usd) || undefined, limit: 5 };
        const direct = args.seller ? [sellerUrl(String(args.seller))] : d.seller ? [sellerUrl(d.seller)] : [];
        const { quotes, errors } = await client.quoteAll(q, { hubs: d.hubs, direct });
        candidates = quotes.flatMap((sq: SellerQuote) => sq.offers.map((o) => ({
          offerId: o.offer_id, name: o.name, priceUsd: Number(o.price.usd), seller: sq.seller, orderUrl: sq.orderUrl, demo: sq.demo, via: sq.via, hub: sq.hub,
        }))).sort((a, b) => a.priceUsd - b.priceUsd);
        if (!candidates.length) {
          return { ok: true, content: `No eSIM seller has an offer for ${cc}.${errors.length ? ` (${errors.join("; ")})` : ""}` };
        }
        const real = candidates.filter((c) => !c.demo);
        // The label is the seller's own answer (`demo` in its quote); a seller's NAME proves nothing either way.
        const line = (c: Candidate) => `${c.demo ? "[DEMO: sells nothing]" : "[SELLS]"} ${c.offerId} — ${c.name} — ${c.priceUsd.toFixed(2)} USDC — seller "${c.seller}"`;
        const head = real.length
          ? `${real.length} offer(s) you can buy, cheapest first. Go by the [SELLS] / [DEMO] label, not by the seller's name:`
          : "Only DEMO sellers answered: these are live prices, but none of them sells. Nothing can be bought right now.";
        const body = [...real.slice(0, 8), ...candidates.filter((c) => c.demo).slice(0, real.length ? 3 : 8)].map(line).join("\n");
        return { ok: true, content: `${head}\n${body}${errors.length ? `\n(unreachable: ${errors.length})` : ""}`, data: { sellers: quotes.length, buyable: real.length } };
      } catch (err) { return fail(err); }
    },
  };

  const buy: Tool = {
    source: { kind: "builtin" },
    def: {
      name: "esim_buy",
      description: `Buy one travel eSIM (esim.order@v1) for the owner: an offer_id from esim_offers, paid in USDC on Base from ARGUS's wallet over x402 to the seller that offered it, at most ${d.maxUsd} USDC. DEMO sellers are never paid. The QR code and activation code go to the owner directly; you get the profile number. Needs the owner's approval.`,
      inputSchema: { type: "object", required: ["offer_id"], properties: {
        offer_id: { type: "string", description: "from esim_offers" },
        max_usd: { type: "number", description: `the most to pay; at most ${d.maxUsd}` },
        seller: { type: "string", description: "the seller's name or URL, when several offer the same offer_id" } } },
    },
    async run(args, ctx) {
      if (!ctx.approved) return { ok: false, content: "[blocked] esim_buy pays from ARGUS's wallet; the owner did not approve it." };
      const key = d.walletKey();
      if (!key) return { ok: false, content: "No wallet: ARGUS cannot pay. The owner sets one up with `argus setup`." };
      try {
        const offerId = String(args.offer_id ?? "");
        if (!/^[A-Za-z0-9_.,-]{1,64}$/.test(offerId)) throw new EsimError("bad_input", "offer_id is from esim_offers");
        const cap = Math.min(Number(args.max_usd) || d.maxUsd, d.maxUsd);
        const want = String(args.seller ?? "").toLowerCase();
        const pick = candidates.filter((c) => c.offerId === offerId && !c.demo
          && (!want || c.seller.toLowerCase().includes(want) || c.orderUrl.toLowerCase().includes(want)))[0];
        // Without a fresh quote, only a directly configured seller can be bought from.
        const orderUrl = pick?.orderUrl ?? (candidates.some((c) => c.offerId === offerId && c.demo)
          ? null : d.seller ? sellerUrl(d.seller) : null);
        if (!orderUrl) {
          return { ok: false, content: candidates.some((c) => c.offerId === offerId)
            ? `${offerId} is offered only by a DEMO seller, which sells nothing.`
            : `No seller offers ${offerId} in the last esim_offers: ask esim_offers for the country first.` };
        }
        const { delivery, transaction, payer, priceUsd } = await client.buy(orderUrl, offerId, key, cap);
        const p: EsimPurchase = {
          seller: /\/order$/.test(orderUrl) ? baseOf(orderUrl) : orderUrl, offerId, name: delivery.offer?.name ?? offerId, priceUsd, esimTranNo: delivery.esim_tran_no,
          iccid: delivery.iccid, statusToken: delivery.status_token, payer, transaction, at: new Date().toISOString(),
          ...(pick?.hub ? { hub: pick.hub } : {}),
        };
        client.save(p);
        share(p, "delivery", delivery.receipt, delivery.receipt_signature, transaction);
        const note = [
          `📶 eSIM bought by ARGUS: ${p.name}`,
          `Paid ${priceUsd} USDC from ${payer.slice(0, 6)}…${payer.slice(-4)}${transaction ? ` · tx ${transaction}` : ""}`,
          `ICCID ${delivery.iccid ?? "—"} · APN ${delivery.apn ?? "—"} · profile ${delivery.esim_tran_no}`,
          delivery.install_url ? `iPhone: ${delivery.install_url}` : "",
          "Scan the QR in Settings → Mobile data → Add eSIM, or paste the activation code below. Install it only if you keep it: an installed eSIM cannot be refunded.",
        ].filter(Boolean).join("\n");
        const sent = await notifyOwner({ text: note, photoUrl: delivery.qr_code_url ?? undefined, copyable: delivery.activation_code });
        d.log.info(`esim bought: ${offerId} for ${priceUsd} USDC, profile ${delivery.esim_tran_no}, tx ${transaction ?? "?"}`);
        return {
          ok: true,
          content: `Bought ${p.name} for ${priceUsd} USDC (tx ${transaction ?? "not reported"}), profile ${delivery.esim_tran_no}. `
            + (sent ? "The QR and the activation code were sent to the owner directly; do not ask for them."
                    : hasOwnerSink() ? "Sending the QR to the owner failed; the owner can read it with esim_status later."
                                     : "No owner channel is connected (Telegram), so the QR was not sent; the owner can ask the seller with the status token."),
          data: { esimTranNo: delivery.esim_tran_no, priceUsd, transaction, payer },
        };
      } catch (err) { return fail(err); }
    },
  };

  const status: Tool = {
    source: { kind: "builtin" },
    def: {
      name: "esim_status",
      description: "State of an eSIM ARGUS bought (esim.status@v1): installed or not, data used, expiry. The latest purchase by default. Free.",
      inputSchema: { type: "object", properties: { esim_tran_no: { type: "string" } } },
    },
    async run(args) {
      try {
        const p = purchase(args);
        if (!p) return { ok: true, content: "ARGUS has bought no eSIM yet." };
        const st = await client.status(p);
        return { ok: true, content: `${p.name} (profile ${p.esimTranNo}, ${p.priceUsd} USDC): ${JSON.stringify(st)}${p.refund ? ` · refund ${p.refund.status}` : ""}` };
      } catch (err) { return fail(err); }
    },
  };

  const refund: Tool = {
    source: { kind: "builtin" },
    def: {
      name: "esim_refund",
      description: "Ask the seller to refund an eSIM ARGUS bought (latest by default): possible while it is not installed and unused; the seller cancels it and pays the price back to ARGUS's wallet. Needs the owner's approval.",
      inputSchema: { type: "object", properties: { esim_tran_no: { type: "string" } } },
    },
    async run(args, ctx) {
      if (!ctx.approved) return { ok: false, content: "[blocked] esim_refund cancels the eSIM; the owner did not approve it." };
      try {
        const p = purchase(args);
        if (!p) return { ok: false, content: "No eSIM purchase to refund." };
        const r = await client.refund(p);
        p.refund = { status: r.status, amountUsd: r.amount_usd, to: r.to, transaction: r.transaction, at: new Date().toISOString() };
        client.save(p);
        share(p, "refund", r.receipt, r.receipt_signature, r.transaction);
        const line = r.status === "refunded"
          ? `↩️ Refunded ${r.amount_usd} USDC for ${p.name} to ${r.to} · tx ${r.transaction}. The eSIM is cancelled.`
          : `↩️ ${p.name}: the eSIM is cancelled; the seller owes ${r.amount_usd} USDC to ${r.to} (status ${r.status}).`;
        await notifyOwner({ text: line });
        return { ok: true, content: line };
      } catch (err) { return fail(err); }
    },
  };

  return [offers, buy, status, refund];
}
