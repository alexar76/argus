import { createHash, randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { readProviderJson } from "../economy/external-payment.js";
import { canReadMailCode, type MailCodeRequest, type MailSettings } from "../mail/index.js";
import type { Tool } from "../types.js";

interface BookingMail {
  settings(): (Pick<MailSettings, "accountId" | "email" | "graph" | "incoming"> & { permissions: { otp: boolean } }) | null | undefined;
  readCode(request: MailCodeRequest): Promise<string | null>;
}

interface BookingPartner {
  origin: string;
  token: string;
  otpSender: string;
  otpSubject?: string;
  mail: BookingMail;
  fetch?: typeof fetch;
  waitForCode?: (signal: AbortSignal) => Promise<void>;
}

interface BookingOffer {
  id: string;
  venue: string;
  startsAt: string;
  guests: number;
  maximumCents: number;
  terms: string;
  partner: string;
  expiresAt: number;
}

const identifier = /^[A-Za-z0-9_-]{1,100}$/;
const dateWithOffset = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:\d{2})$/;
const oneLine = (value: unknown, limit: number) => typeof value === "string" && value.length <= limit
  && value.trim().length > 0 && !/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(value);
const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid partner response");
  return value as Record<string, unknown>;
};
const summaryOf = (offer: BookingOffer) => `${offer.partner} | ${offer.venue} | ${offer.startsAt} | ${offer.guests} guests | maximum USD ${(offer.maximumCents / 100).toFixed(2)} | ${offer.terms}`;

function calendarDate(date: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(Date.parse(date)) && new Date(date).toISOString().slice(0, 10) === date;
}

/** Opens a restaurant's public Resy page, with the selected date and party size, for owner checkout. */
export function resyBookingLink(raw: string, date: string, guests: number): string {
  const url = new URL(raw);
  if (url.origin !== "https://resy.com" || url.username || url.password
      || !/^\/cities\/[a-z0-9-]+\/venues\/[a-z0-9-]+\/?$/.test(url.pathname)) throw new Error("use the official Resy restaurant page");
  if (!calendarDate(date) || !Number.isInteger(guests) || guests < 1 || guests > 20) {
    throw new Error("use a calendar date (YYYY-MM-DD) and a party of 1–20");
  }
  url.search = new URLSearchParams({ date, seats: String(guests) }).toString();
  url.hash = "";
  return url.href;
}

export function buildTravelBookingTools(partner?: BookingPartner): Tool[] {
  const handoff: Tool = {
    def: {
      name: "travel_resy_link",
      description: "Prepare the official Resy restaurant link for the owner to sign in and book. Requires a verified public Resy restaurant URL, date, and party size.",
      inputSchema: { type: "object", properties: { url: { type: "string" }, date: { type: "string" }, guests: { type: "integer" } }, required: ["url", "date", "guests"] },
    },
    source: { kind: "builtin" },
    async run(args) {
      try {
        const link = resyBookingLink(String(args.url ?? ""), String(args.date ?? ""), Number(args.guests));
        return { ok: true, content: `Open Resy to select the time and complete your reservation: ${link}` };
      } catch {
        return { ok: false, content: "Supply an official Resy restaurant link, a valid local date and a party of 1–20." };
      }
    },
  };
  if (!partner) return [handoff];
  const origin = new URL(partner.origin);
  if (origin.protocol !== "https:" || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash || !partner.token.trim()) {
    throw new Error("booking partner must be an HTTPS origin with an operator-provisioned token");
  }
  const offers = new Map<string, BookingOffer>();
  const waiting = new Set<string>();
  const requestFetch = partner.fetch ?? fetch;
  const call = async (path: string, body: unknown, signal?: AbortSignal, key?: string, allowMissing = false) => {
    const timeout = AbortSignal.timeout(15_000);
    const response = await requestFetch(new URL(path, origin), {
      method: body === undefined ? "GET" : "POST", redirect: "error",
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      headers: { authorization: `Bearer ${partner.token}`, accept: "application/json", "content-type": "application/json", ...(key ? { "idempotency-key": key } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) {
      await response.body?.cancel();
      if (allowMissing && response.status === 404) return null;
      throw new Error(`booking partner returned HTTP ${response.status}`);
    }
    return record(await readProviderJson(response, 32_768));
  };

  const quote: Tool = {
    def: {
      name: "travel_booking_quote",
      description: "Ask the configured booking partner for a restaurant slot and maximum total in USD. Include a local datetime with offset and a spending ceiling in cents.",
      inputSchema: { type: "object", properties: { venue: { type: "string" }, startsAt: { type: "string" }, guests: { type: "integer" }, maximumCents: { type: "integer" } }, required: ["venue", "startsAt", "guests", "maximumCents"] },
    },
    source: { kind: "builtin" },
    async run(args, ctx) {
      const { venue, startsAt, guests, maximumCents } = args;
      if (typeof venue !== "string" || !oneLine(venue, 140) || typeof startsAt !== "string" || !dateWithOffset.test(startsAt)
          || !calendarDate(startsAt.slice(0, 10)) || Number(startsAt.slice(11, 13)) > 23
          || !Number.isFinite(Date.parse(startsAt)) || Date.parse(startsAt) <= Date.now()
          || typeof guests !== "number" || !Number.isInteger(guests) || guests < 1 || guests > 20
          || typeof maximumCents !== "number" || !Number.isSafeInteger(maximumCents) || maximumCents < 0 || maximumCents > 100_000) {
        return { ok: false, content: "A venue, future datetime with offset, 1–20 guests and a maximum of 0–100000 USD cents are required." };
      }
      try {
        const reply = await call("/quote", { venue, startsAt, guests, maximumCents }, ctx.signal);
        if (!reply || typeof reply.id !== "string" || !identifier.test(reply.id) || reply.venue !== venue || reply.startsAt !== startsAt
            || reply.guests !== guests || reply.currency !== "USD" || typeof reply.maximumCents !== "number"
            || !Number.isSafeInteger(reply.maximumCents) || reply.maximumCents < 0 || reply.maximumCents > maximumCents
            || typeof reply.terms !== "string" || !oneLine(reply.terms, 180)) throw new Error("booking offer differs from the requested terms");
        const expiresAt = Math.min(Date.parse(String(reply.expiresAt)), Date.now() + 300_000);
        if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) throw new Error("booking offer expired");
        const offer = { id: reply.id, venue, startsAt, guests, maximumCents: reply.maximumCents, terms: reply.terms, expiresAt, partner: origin.host };
        if (offers.size >= 20) offers.delete(offers.keys().next().value!);
        const offerId = randomUUID();
        offers.set(offerId, offer);
        return { ok: true, content: `Offer ${offerId}. Use this exact summary in travel_book_approve: ${summaryOf(offer)}` };
      } catch {
        return { ok: false, content: "The booking partner did not return a matching, unexpired offer." };
      }
    },
  };
  const book: Tool = {
    def: {
      name: "travel_book_approve",
      description: "Reserve the exact offered slot after owner approval. The confirmation email code is handled privately. Pass the offerId and exact summary from travel_booking_quote.",
      inputSchema: { type: "object", properties: { offerId: { type: "string" }, summary: { type: "string" } }, required: ["offerId", "summary"] },
    },
    source: { kind: "builtin" },
    async run(args, ctx) {
      const offerId = String(args.offerId ?? "");
      const offer = offers.get(offerId);
      if (!ctx.approved || !offer || offer.expiresAt <= Date.now() || args.summary !== summaryOf(offer)) {
        return { ok: false, content: "A fresh matching booking offer and owner approval are required." };
      }
      let account: ReturnType<BookingMail["settings"]>;
      try { account = partner.mail.settings(); } catch { account = null; }
      if (!account?.permissions.otp || !canReadMailCode(account)) {
        return { ok: false, content: "Enable codes-only access in ARGUS for an IMAP or Outlook.com mailbox before requesting a booking code." };
      }
      const requestId = createHash("sha256").update(JSON.stringify([
        origin.origin, account.email.toLowerCase(), offer.venue.normalize("NFKC").trim().toLowerCase(), new Date(offer.startsAt).toISOString(), offer.guests,
      ])).digest("hex");
      if (waiting.has(requestId)) return { ok: false, content: `This booking attempt is already in progress. Request ${requestId}.` };
      waiting.add(requestId);
      const reference = randomUUID().replaceAll("-", "");
      const deadline = AbortSignal.timeout(Math.max(1, Math.min(60_000, offer.expiresAt - Date.now())));
      const signal = ctx.signal ? AbortSignal.any([ctx.signal, deadline]) : deadline;
      let confirming = false;
      try {
        // The partner keeps this idempotency key even if ARGUS restarted during a prior attempt.
        const existing = await call(`/status?requestId=${requestId}`, undefined, signal, undefined, true);
        if (existing) {
          offers.delete(offerId);
          return describeBooking(existing, requestId, offer.maximumCents);
        }
        const notBefore = Date.now();
        const challenge = await call("/challenge", { offerId: offer.id, reference, requestId }, signal);
        if (!challenge || typeof challenge.id !== "string" || !identifier.test(challenge.id) || challenge.reference !== reference) {
          throw new Error("booking code challenge is not bound to the request");
        }
        let code: string | null = null;
        for (let attempt = 0; attempt < 8 && !signal.aborted; attempt += 1) {
          code = await partner.mail.readCode({ sender: partner.otpSender, subjectIncludes: partner.otpSubject, reference, notBefore, accountId: account.accountId, signal });
          if (code) break;
          if (attempt < 7) {
            if (partner.waitForCode) await partner.waitForCode(signal);
            else await sleep(3000, undefined, { signal });
          }
        }
        if (!code || !/^\d{6}$/.test(code) || signal.aborted) return { ok: false, content: "No matching email code arrived before the booking expired. No booking was submitted." };
        confirming = true;
        offers.delete(offerId);
        const outcome = await call("/confirm", { offerId: offer.id, challengeId: challenge.id, code, requestId, maximumCents: offer.maximumCents }, signal, requestId);
        return describeBooking(outcome ?? {}, requestId, offer.maximumCents);
      } catch {
        if (!confirming) return { ok: false, content: "The booking challenge could not be completed. No booking was submitted." };
        return { ok: false, content: `Booking result unknown. Check travel_booking_status for ${requestId} before any further attempt.` };
      } finally {
        waiting.delete(requestId);
      }
    },
  };
  const status: Tool = {
    def: { name: "travel_booking_status", description: "Reconcile an existing booking using the request ID from the booking attempt.", inputSchema: { type: "object", properties: { requestId: { type: "string" } }, required: ["requestId"] } },
    source: { kind: "builtin" },
    async run(args, ctx) {
      const requestId = String(args.requestId ?? "");
      if (!/^[a-f0-9]{64}$/.test(requestId)) return { ok: false, content: "Provide the existing booking request ID." };
      try { return describeBooking(await call(`/status?requestId=${requestId}`, undefined, ctx.signal) ?? {}, requestId); }
      catch { return { ok: false, content: "Booking status could not be reconciled with the partner." }; }
    },
  };
  return [handoff, quote, book, status];
}

function describeBooking(outcome: Record<string, unknown>, requestId: string, maximumCents?: number) {
  const cost = outcome.chargedCents;
  if (outcome.requestId === requestId && outcome.status === "confirmed" && typeof outcome.bookingId === "string" && identifier.test(outcome.bookingId)
      && outcome.currency === "USD" && typeof cost === "number" && Number.isSafeInteger(cost) && cost >= 0
      && (maximumCents === undefined || cost <= maximumCents)) {
    return { ok: true, content: `Booking confirmed: ${outcome.bookingId}. Charged USD ${(cost / 100).toFixed(2)}. Request ${requestId}.` };
  }
  if (outcome.requestId === requestId && outcome.status === "declined" && cost === 0) {
    return { ok: false, content: `Booking declined with zero charge. Request ${requestId}.` };
  }
  return { ok: false, content: `Booking result unconfirmed. Reconcile request ${requestId} with the partner before trying again.` };
}
