import { CMC_QUOTES, type ExternalPaymentRequest, type ExternalPaymentResult } from "../economy/external-payment.js";
import type { Tool } from "../types.js";
import type { ReportProviderActivity } from "../monitor/provider-events.js";

/** Fixed CoinMarketCap GET, paid directly from the buyer's Base wallet. */
export function buildCoinMarketCapTool(
  pay: (request: ExternalPaymentRequest) => Promise<ExternalPaymentResult>,
  payTo: string,
  reportProvider?: ReportProviderActivity,
): Tool {
  return {
    source: { kind: "builtin" },
    def: {
      name: "cmc_buy_quotes",
      description: "Buy latest USD market quotes from CoinMarketCap for up to 10 numeric CMC IDs. Costs at most 0.01 USDC on Base and requires owner approval.",
      inputSchema: { type: "object", properties: { ids: { type: "array", items: { type: "integer" }, minItems: 1, maxItems: 10 } }, required: ["ids"] },
    },
    async run(args, ctx) {
      const ids = args.ids;
      if (!ctx.approved || !Array.isArray(ids) || ids.length < 1 || ids.length > 10
          || !ids.every((id) => typeof id === "number" && Number.isSafeInteger(id) && id > 0 && id <= 1_000_000_000)) {
        return { ok: false, content: "Owner approval and 1–10 valid numeric CoinMarketCap IDs are required." };
      }
      const uniqueIds = [...new Set(ids)] as number[];
      let payment: ExternalPaymentResult;
      try {
        payment = await pay({ url: `${CMC_QUOTES}?id=${uniqueIds.join(",")}`, method: "GET", maxUsd: 0.01, expectedPayTo: payTo });
      } catch (error) {
        reportProvider?.({ provider: "coinmarketcap", operation: "quotes", status: "failed" });
        return { ok: false, content: `CoinMarketCap: ${error instanceof Error ? error.message : "call unconfirmed"}.` };
      }
      const result = payment.body as { status?: { error_code?: unknown }, data?: unknown } | null;
      const data = Array.isArray(result?.data) ? result.data : [];
      const quotes = uniqueIds.flatMap((id) => {
        const item = data.find((entry) => entry?.id === id || entry?.id === String(id));
        const usd = Array.isArray(item?.quote) ? item.quote.find((quote: { symbol?: string } | null) => quote?.symbol === "USD") : undefined;
        return typeof usd?.price === "number" && Number.isFinite(usd.price) && usd.price >= 0
          ? [{ id, usd: usd.price, observedAt: typeof usd.last_updated === "string" && Number.isFinite(Date.parse(usd.last_updated)) ? new Date(usd.last_updated).toISOString() : null }]
          : [];
      });
      const status = result?.status?.error_code;
      const success = (status === 0 || status === "0") && quotes.length === uniqueIds.length;
      reportProvider?.({ provider: "coinmarketcap", operation: "quotes", status: success ? "succeeded" : "failed" });
      return { ok: success, content: `CoinMarketCap ${success ? "quotes" : "incomplete delivery"} ${JSON.stringify(quotes)}. Base: ${payment.transaction}.` };
    },
  };
}
