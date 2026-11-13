import { randomUUID } from "node:crypto";
import type { Hex } from "viem";
import { readProviderJson } from "../economy/external-payment.js";
import type { ReportProviderActivity } from "../monitor/provider-events.js";
import { LASO_ORIGIN, lasoWalletAuth } from "../tools/laso-auth.js";
import type { ItchBilling, ItchCard } from "./itch-browser.js";

const CARD_TYPE = "Non-Reloadable U.S.";

export function cardCents(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return;
  const cents = Math.round(value * 100);
  if (Number.isSafeInteger(cents) && Math.abs(cents - value * 100) < 1e-6) return cents;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function text(value: unknown, max = 100): string {
  return typeof value === "string" && value.length <= max && !/[\p{Cc}\p{Cf}]/u.test(value) ? value.trim() : "";
}

export interface CheckoutCardState {
  balanceCents: number;
  itchDebits: number[];
  billing: ItchBilling;
  card?: ItchCard;
}

/** The checkout receives card credentials only at the payment step. */
export function createLasoCheckoutCard(options: {
  id: string;
  token?: () => Promise<string>;
  walletKey?: () => Hex | null;
  request?: typeof fetch;
  reportProvider?: ReportProviderActivity;
}) {
  if (!/^O-[A-Za-z0-9_-]{8,96}$/.test(options.id)) throw new Error("Invalid Laso checkout card reference.");
  const request = options.request ?? fetch;
  const token = options.token ?? (options.walletKey && lasoWalletAuth(options.walletKey, request));
  if (!token) throw new Error("Missing dedicated Laso checkout authentication.");

  async function call(
    path: string, params: Record<string, string>, signal: AbortSignal, refresh = false, onRequest?: () => void,
  ) {
    signal.throwIfAborted();
    const url = new URL(path, LASO_ORIGIN);
    if (!refresh) url.search = new URLSearchParams(params).toString();
    const authorization = await token!();
    signal.throwIfAborted();
    onRequest?.();
    const response = await request(url, {
      method: refresh ? "POST" : "GET",
      headers: {
        authorization: `Bearer ${authorization}`, accept: "application/json",
        ...(refresh && { "content-type": "application/json", "idempotency-key": randomUUID() }),
      },
      ...(refresh && { body: JSON.stringify(params) }),
      redirect: "error", signal: AbortSignal.any([signal, AbortSignal.timeout(12_000)]),
    });
    if (refresh && (response.ok || response.status === 409 || response.status === 429)) {
      await response.body?.cancel();
      return {};
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error("Laso checkout card is unavailable.");
    }
    return record(await readProviderJson(response, 128_000));
  }

  return {
    async accepted(signal: AbortSignal): Promise<boolean> {
      let requested = false;
      let accepted = false;
      try {
        const data = await call("/search-merchants", { q: "itch.io", card_type: CARD_TYPE }, signal, false, () => {
          requested = true;
        });
        accepted = Array.isArray(data.merchants) && data.merchants.some((entry) => {
          const merchant = record(entry);
          return text(merchant.name).toLowerCase() === "itch.io" && merchant.status === "accepted";
        });
        return accepted;
      } finally {
        if (requested && !signal.aborted) {
          options.reportProvider?.({ provider: "laso", operation: "card_quote", status: accepted ? "succeeded" : "failed" });
        }
      }
    },
    async read(signal: AbortSignal, credentials = false): Promise<CheckoutCardState> {
      const data = await call("/get-card-data", { card_id: options.id }, signal);
      const details = record(data.card_details);
      const balanceCents = cardCents(details.available_balance);
      if (data.card_id !== options.id || data.country !== "US" || data.status !== "ready"
        || (data.card_type !== undefined && data.card_type !== CARD_TYPE) || balanceCents === undefined
        || cardCents(data.usd_amount) !== 500 || balanceCents > 500) {
        throw new Error("Laso card is not the configured $5 U.S. prepaid card.");
      }
      const address = record(details.billing_address);
      const billing: ItchBilling = {
        name: text(address.name), street: text(address.line_1), street2: text(address.line_2),
        city: text(address.city), state: text(address.state), postalCode: text(address.zip, 20),
        country: text(address.country, 2).toUpperCase(),
      };
      const itchDebits = (Array.isArray(data.transactions) ? data.transactions : []).flatMap((entry) => {
        const item = record(entry);
        const cents = cardCents(Math.abs(typeof item.amount === "number" ? item.amount : NaN));
        return item.is_credit === false && cents && /\bitch[.\s]*io\b/i.test(text(item.description, 250)) ? [cents] : [];
      });
      if (!credentials) return { billing, balanceCents, itchDebits };
      const card: ItchCard = {
        number: text(details.card_number, 24).replace(/[ -]/g, ""),
        expMonth: text(details.exp_month, 2).padStart(2, "0"),
        expYear: text(details.exp_year, 4),
        cvv: text(details.cvv, 4),
      };
      if (!/^\d{13,19}$/.test(card.number) || !/^(0[1-9]|1[0-2])$/.test(card.expMonth)
        || !/^(?:20)?\d{2}$/.test(card.expYear) || !/^\d{3,4}$/.test(card.cvv)) {
        throw new Error("Laso checkout card credentials are unavailable.");
      }
      return { billing, balanceCents, itchDebits, card };
    },
    async refresh(signal: AbortSignal): Promise<void> {
      await call("/refresh-card-data", { card_id: options.id, card_type: CARD_TYPE }, signal, true);
    },
  };
}
