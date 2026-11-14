import { randomUUID } from "node:crypto";
import type { Hex } from "viem";
import { readProviderJson } from "../economy/external-payment.js";
import type { ReportProviderActivity } from "../monitor/provider-events.js";
import { LASO_ORIGIN, lasoWalletAuth } from "../tools/laso-auth.js";
import type { ItchBilling, ItchCard } from "./itch-browser.js";

const CARD_TYPE = "Non-Reloadable U.S.";

export class LasoCheckoutAuthError extends Error {
  constructor() { super("Laso checkout session expired or unavailable."); }
}

export const LASO_CHECKOUT_RECONNECT = "Сессия Laso истекла или недоступна. Попроси администратора обновить подключение карты";

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
  hudsonDebits?: number[];
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
      if (response.status === 401) throw new LasoCheckoutAuthError();
      throw new Error("Laso checkout card is unavailable.");
    }
    return record(await readProviderJson(response, 128_000));
  }

  async function merchantAcceptance(names: readonly string[], signal: AbortSignal, onRequest?: () => void) {
    const primary = names[0];
    if (!primary) throw new Error("Missing Laso merchant name.");
    const data = await call("/search-merchants", { q: primary, card_type: CARD_TYPE }, signal, false, onRequest);
    const exact = new Set(names.map(name => name.toLowerCase()));
    const statuses = (Array.isArray(data.merchants) ? data.merchants : []).flatMap(entry => {
      const merchant = record(entry);
      return exact.has(text(merchant.name).toLowerCase()) ? [merchant.status] : [];
    });
    if (statuses.includes("not_accepted")) return "not_accepted";
    if (statuses.includes("accepted")) return "accepted";
    return "unknown";
  }

  return {
    merchantAcceptance,
    async accepted(signal: AbortSignal): Promise<boolean> {
      let requested = false;
      let accepted = false;
      try {
        accepted = await merchantAcceptance(["itch.io"], signal, () => {
          requested = true;
        }) === "accepted";
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
      const debits = (Array.isArray(data.transactions) ? data.transactions : []).flatMap((entry) => {
        const item = record(entry);
        const cents = cardCents(Math.abs(typeof item.amount === "number" ? item.amount : NaN));
        return item.is_credit === false && cents ? [{ cents, description: text(item.description, 250) }] : [];
      });
      const itchDebits = debits.filter(item => /\bitch[.\s]*io\b/i.test(item.description)).map(item => item.cents);
      const hudsonDebits = Array.isArray(data.transactions)
        ? debits.filter(item => /\b(?:hudson[\s-]*link|coach[\s-]*usa|community[\s-]*coach|community[\s-]*transport[\s-]*lines)\b/i.test(item.description)).map(item => item.cents)
        : undefined;
      const state = { billing, balanceCents, itchDebits, hudsonDebits };
      if (!credentials) return state;
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
      return { ...state, card };
    },
    async refresh(signal: AbortSignal): Promise<void> {
      await call("/refresh-card-data", { card_id: options.id, card_type: CARD_TYPE }, signal, true);
    },
  };
}
