import { randomUUID } from "node:crypto";
import type { Hex } from "viem";
import { hasOwnerSink, notifyOwner } from "../channels/owner-notify.js";
import { readProviderJson, type ExternalPaymentRequest, type ExternalPaymentResult } from "../economy/external-payment.js";
import type { Tool } from "../types.js";
import type { ReportProviderActivity } from "../monitor/provider-events.js";
import { LASO_ORIGIN as LASO, lasoWalletAuth } from "./laso-auth.js";

const LASO_BASE_PAYEE = "0x3291e96b3bff7ed56e3ca8364273c5b4654b2b37";

interface LasoCardOptions {
  pay: (request: ExternalPaymentRequest) => Promise<ExternalPaymentResult>;
  token?: () => string | undefined;
  walletKey?: () => Hex | null;
  merchant: string;
  maxCents: number;
  fetch?: typeof fetch;
  notify?: typeof notifyOwner;
  hasOwnerChannel?: typeof hasOwnerSink;
  reportProvider?: ReportProviderActivity;
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** Restricted pilot for one known US merchant; card data stays in the Laso dashboard. */
export function buildLasoCardTools(options: LasoCardOptions): Tool[] {
  const merchant = options.merchant.trim();
  if (!merchant || merchant.length > 100 || /[\p{C}]/u.test(merchant)
      || !Number.isSafeInteger(options.maxCents) || options.maxCents < 500 || options.maxCents > 100_000) {
    throw new Error("Laso needs a specific US merchant and an integer card ceiling in cents ($5–$1000)");
  }
  const walletAuth = options.walletKey ? lasoWalletAuth(options.walletKey, options.fetch) : undefined;
  const get = async (path: string, token: string): Promise<Record<string, unknown>> => {
    const response = await (options.fetch ?? fetch)(new URL(path, LASO), {
      headers: { authorization: `Bearer ${token}`, accept: "application/json" },
      redirect: "error", signal: AbortSignal.timeout(12_000),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`Laso returned HTTP ${response.status}`);
    }
    return object(await readProviderJson(response, 65_536));
  };
  const quoteRequests = new Map<string, { cents: number; summary: string; expires: number }>();
  const notify = options.notify ?? notifyOwner;
  const ready = options.hasOwnerChannel ?? hasOwnerSink;
  const quote: Tool = {
    source: { kind: "builtin" },
    def: {
      name: "laso_card_quote",
      description: `Check Laso prepaid-card acceptance at ${merchant} and prepare a card for the exact USD checkout total in cents. No payment is made.`,
      inputSchema: { type: "object", properties: { checkoutCents: { type: "integer" } }, required: ["checkoutCents"] },
    },
    async run(args) {
      const cents = args.checkoutCents;
      if (typeof cents !== "number" || !Number.isSafeInteger(cents) || cents < 500 || cents > options.maxCents) {
        return { ok: false, content: `Use the exact checkout total from 500 to ${options.maxCents} USD cents.` };
      }
      let called = false;
      try {
        const token = options.token?.()?.trim() || await walletAuth?.();
        if (!token) return { ok: false, content: "Set up an owner-authorized Laso session for the merchant check." };
        called = true;
        const check = await get(`/search-merchants?${new URLSearchParams({ q: merchant })}`, token);
        const match = Array.isArray(check.merchants) && check.merchants.some((entry) => {
          const candidate = object(entry);
          return typeof candidate.name === "string" && candidate.name.toLowerCase() === merchant.toLowerCase() && candidate.status === "accepted";
        });
        options.reportProvider?.({ provider: "laso", operation: "card_quote", status: match ? "succeeded" : "failed" });
        if (!match) return { ok: false, content: "Laso has no confirmed acceptance for the configured merchant." };
        const id = randomUUID();
        const summary = `${merchant} | US prepaid | ${(cents / 100).toFixed(2)} USDC loaded | no reload`;
        if (quoteRequests.size >= 10) quoteRequests.delete(quoteRequests.keys().next().value!);
        quoteRequests.set(id, { cents, summary, expires: Date.now() + 300_000 });
        return { ok: true, content: `Prepared ${id}. For laso_buy_card use this exact summary: ${summary}. The owner completes merchant checkout in their browser.` };
      } catch {
        if (called) options.reportProvider?.({ provider: "laso", operation: "card_quote", status: "failed" });
        return { ok: false, content: "The Laso merchant acceptance check failed." };
      }
    },
  };
  const issue: Tool = {
    source: { kind: "builtin" },
    def: {
      name: "laso_buy_card",
      description: "Issue and fund the exact Laso prepaid card after owner approval. Use the ID and summary from laso_card_quote. Only the owner gets the secure dashboard link.",
      inputSchema: { type: "object", properties: { quoteId: { type: "string" }, summary: { type: "string" } }, required: ["quoteId", "summary"] },
    },
    async run(args, ctx) {
      const id = String(args.quoteId ?? "");
      const held = quoteRequests.get(id);
      if (!ctx.approved || !held || held.summary !== args.summary || Date.now() >= held.expires || !ready()) {
        return { ok: false, content: "A current exact Laso quote, owner approval and a private owner channel are required." };
      }
      quoteRequests.delete(id);
      const amount = (held.cents / 100).toFixed(2);
      let payment: ExternalPaymentResult;
      try {
        payment = await options.pay({ url: `${LASO}/get-card?amount=${amount}`, method: "GET", maxUsd: Number(amount), exactUsd: Number(amount), expectedPayTo: LASO_BASE_PAYEE });
      } catch {
        options.reportProvider?.({ provider: "laso", operation: "card_issue", status: "failed" });
        return { ok: false, content: "Laso card issuance was not confirmed. Reconcile Laso and the wallet before another purchase." };
      }
      const payload = object(payment.body);
      const card = object(payload.card);
      const cardId = typeof card.card_id === "string" && /^[A-Za-z0-9_-]{1,100}$/.test(card.card_id) ? card.card_id : null;
      const token = object(payload.auth).id_token;
      const accepted = cardId && (card.status === "pending" || card.status === "ready");
      options.reportProvider?.({ provider: "laso", operation: "card_issue", status: accepted ? "succeeded" : "failed" });
      if (accepted && typeof token === "string" && token.length > 0) {
        try {
          const response = await get("/get-auth-link", token);
          const link = new URL(String(response.auth_url ?? ""));
          if (link.origin !== LASO || link.username || link.password || link.pathname !== "/agent/dashboard/auth"
              || !link.searchParams.get("code") || link.hash) throw new Error("invalid Laso link");
          const delivered = await notify({ text: `Laso prepaid card ${cardId} for ${merchant}. Load ${amount} USDC. The card may take a few seconds to appear. Open your private Laso dashboard to access the card. Base: ${payment.transaction}`, copyable: link.href });
          if (delivered) return { ok: true, content: `Laso accepted card order ${cardId}. The private dashboard link went to the owner. Base: ${payment.transaction}.` };
        } catch { /* The payment and card reference remain usable for wallet-based recovery. */ }
      }
      return { ok: false, content: `Laso payment reported in Base transaction ${payment.transaction}. ${cardId ? `Card order ${cardId}. ` : ""}Use Laso's dashboard with the paying wallet to check the order before retrying.` };
    },
  };
  return [quote, issue];
}
