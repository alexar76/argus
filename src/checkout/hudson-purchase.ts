import { randomUUID } from "node:crypto";
import { constants, closeSync, fstatSync, fsyncSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { mailAddress } from "../mail/types.js";
import type { ReportProviderActivity } from "../monitor/provider-events.js";
import { HUDSON_LINK_ITEM_URL, HUDSON_LINK_TICKET_CENTS, TelegramDocumentRejected, type TelegramPurchaseChannel } from "../telegram/purchase.js";
import { HudsonCheckoutError, isHudsonBrowserEndpoint, openHudsonCheckout } from "./hudson-browser.js";
import { HUDSON_ORDER_ID, hudsonOrderFromTicketUrl, verifyHudsonReceipt } from "./hudson-receipt.js";
import { readLasoCheckoutSession, readPrivateCheckoutFile, writeCheckoutRecord } from "./itch-purchase.js";
import { LASO_CHECKOUT_RECONNECT, LasoCheckoutAuthError, createLasoCheckoutCard, type CheckoutCardState } from "./laso-card.js";

const ticketCents = HUDSON_LINK_TICKET_CENTS;
const title = "Hudson Link · West Nyack (Palisades Center Lot J) → Tarrytown (Depot Plaza) · 1 взрослый билет";
const filename = "hudson-link-ticket.pdf";
const maxPdfBytes = 2 * 1024 * 1024;
const reconnectLaso = `${LASO_CHECKOUT_RECONNECT}, затем повтори /buy_hudson.`;
const checkoutFailureMessages = {
  verification_required: "Hudson Link потребовал ручную проверку в браузере. Бот остановился до оплаты. Сообщи об этом в рабочем чате, чтобы подготовить ручную проверку.",
  offer_changed: "Итог или маршрут Hudson Link изменился. Запрос оплаты не отправлен.",
  merchant_unavailable: "Hudson Link или платёжный сервис не загрузил чекаут. Запрос оплаты не отправлен.",
  browser_interrupted: "Браузер ARGUS потерял соединение при открытии Hudson Link. Запрос оплаты не отправлен.",
  cancelled: "Истекло время открытия чекаута Hudson Link. Запрос оплаты не отправлен.",
} as const;

interface PurchaseRecord {
  v: 1;
  id: string;
  stage: "submitted" | "receipted" | "uploading" | "delivered";
  beforeCents: number;
  priorDebits: number;
  reconciled: boolean;
  receiptVerified: boolean;
  cardId: string;
  merchantOrderId?: string;
  receiptSha256?: string;
}

interface Dependencies {
  stateDir: string;
  cardId: string;
  browserWsEndpoint: () => string;
  receiptEmail: () => string | undefined;
  laso: Pick<ReturnType<typeof createLasoCheckoutCard>, "merchantAcceptance" | "read" | "refresh">;
  open?: typeof openHudsonCheckout;
  wait?: typeof sleep;
  report?: ReportProviderActivity;
  verifyReceipt?: typeof verifyHudsonReceipt;
}

function debitCount(state: CheckoutCardState): number {
  if (!state.hudsonDebits) throw new Error("Issuer history is unavailable");
  return state.hudsonDebits.filter(amount => amount === ticketCents).length;
}

function readRecord(path: string, cardId: string): PurchaseRecord | undefined {
  try {
    const row = JSON.parse(readPrivateCheckoutFile(path, 4096)) as PurchaseRecord;
    if (row.v !== 1 || row.cardId !== cardId || !/^[\da-f-]{36}$/i.test(row.id)
      || !["submitted", "receipted", "uploading", "delivered"].includes(row.stage)
      || !Number.isInteger(row.beforeCents) || row.beforeCents < ticketCents || row.beforeCents > 500
      || (row.merchantOrderId !== undefined && (typeof row.merchantOrderId !== "string" || !HUDSON_ORDER_ID.test(row.merchantOrderId)))
      || (row.receiptSha256 !== undefined && (!row.merchantOrderId || !row.receiptVerified
        || typeof row.receiptSha256 !== "string" || !/^[a-f0-9]{64}$/.test(row.receiptSha256)))
      || !Number.isInteger(row.priorDebits) || row.priorDebits < 0 || typeof row.reconciled !== "boolean"
      || typeof row.receiptVerified !== "boolean") {
      throw new Error("Invalid Hudson Link journal");
    }
    return row;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
}

function checkedPdf(bytes: Uint8Array): Buffer {
  const pdf = Buffer.from(bytes);
  if (pdf.length < 100 || pdf.length > maxPdfBytes || !/^%PDF-1\.[0-7]\r?\n/.test(pdf.subarray(0, 12).toString("ascii"))
    || !/%%EOF\s*$/.test(pdf.subarray(-64).toString("ascii"))) throw new Error("Invalid Hudson Link ticket PDF");
  return pdf;
}

export function createHudsonPurchase(deps: Dependencies) {
  const path = join(deps.stateDir, "hudson-link-purchase.json");
  const pdfPath = join(deps.stateDir, "hudson-link-ticket.pdf");
  const open = deps.open ?? openHudsonCheckout;
  const wait = deps.wait ?? sleep;
  const verifyReceipt = deps.verifyReceipt ?? verifyHudsonReceipt;

  async function reconcile(row: PurchaseRecord, signal: AbortSignal): Promise<boolean> {
    if (row.reconciled) return true;
    for (let attempt = 0; attempt < 4; attempt++) {
      signal.throwIfAborted();
      const card = await deps.laso.read(signal).catch(() => undefined);
      if (card?.hudsonDebits && card.balanceCents === row.beforeCents - ticketCents && debitCount(card) === row.priorDebits + 1) {
        return true;
      }
      if (attempt === 0) await deps.laso.refresh(signal).catch(() => {});
      if (attempt < 3) await wait(5_000, undefined, { signal });
    }
    return false;
  }

  async function checkReceipt(row: PurchaseRecord, orderId: string, signal: AbortSignal, ticketReference?: string): Promise<PurchaseRecord> {
    if (row.merchantOrderId && row.merchantOrderId !== orderId) throw new Error("Hudson Link order reference changed");
    const card = await deps.laso.read(signal);
    if (!card.last4) throw new Error("Laso card reference is unavailable");
    const receiptSha256 = await verifyReceipt({ orderId, last4: card.last4, signal, ticketReference });
    const sameDebit = Boolean(card.hudsonDebits && card.balanceCents === row.beforeCents - ticketCents
      && debitCount(card) === row.priorDebits + 1);
    return { ...row, merchantOrderId: orderId, receiptSha256, receiptVerified: true,
      reconciled: sameDebit || (!ticketReference && row.reconciled) };
  }

  async function checkPurchase(row: PurchaseRecord, signal: AbortSignal): Promise<PurchaseRecord> {
    const verified = row.merchantOrderId && !row.receiptSha256
      ? await checkReceipt(row, row.merchantOrderId, signal).catch(() => row) : row;
    const reconciled = await reconcile(verified, signal);
    signal.throwIfAborted();
    return { ...verified, reconciled };
  }

  function saveChecked(row: PurchaseRecord, checked: PurchaseRecord): void {
    const current = readRecord(path, deps.cardId);
    if (!current || current.id !== row.id || current.stage !== row.stage
      || (current.merchantOrderId && current.merchantOrderId !== checked.merchantOrderId)) {
      throw new Error("Hudson Link purchase changed during reconciliation");
    }
    const updated = { ...checked, reconciled: current.reconciled || checked.reconciled,
      receiptVerified: current.receiptVerified || checked.receiptVerified, receiptSha256: current.receiptSha256 ?? checked.receiptSha256 };
    if (JSON.stringify(updated) === JSON.stringify(current)) return;
    writeCheckoutRecord(path, updated, false);
    if (!(current.receiptVerified && current.reconciled) && updated.receiptVerified && updated.reconciled) {
      deps.report?.({ provider: "laso", operation: "card_checkout", status: "succeeded" }, updated.id);
    }
  }

  async function deliver(channel: TelegramPurchaseChannel, row: PurchaseRecord, pdf: Buffer): Promise<void> {
    const checked = await checkPurchase(row, channel.signal);
    saveChecked(row, checked);
    const { reconciled } = checked;
    const uploading = { ...checked, stage: "uploading" } as const;
    writeCheckoutRecord(path, uploading, false);
    try {
      await channel.sendDocument(filename, pdf);
    } catch (error) {
      if (error instanceof TelegramDocumentRejected) {
        writeCheckoutRecord(path, { ...uploading, stage: "receipted" }, false);
        return channel.notify("Telegram отклонил отправку PDF. Повтори /buy_hudson, чтобы отправить уже оплаченный билет.");
      }
      throw error;
    }
    writeCheckoutRecord(path, { ...uploading, stage: "delivered" }, false);
    try { unlinkSync(pdfPath); } catch { /* Private file; ticket is already delivered. */ }
    if (!checked.receiptVerified) {
      return channel.notify(reconciled
        ? "PDF отправлен. В Laso одно списание на $2,75, как при подтверждении заказа. Сумма отдельной квитанции Hudson Link ещё не сверена, она должна прийти на email."
        : "PDF отправлен. Сумма отдельной квитанции Hudson Link ещё не сверена. Повтори /buy_hudson, чтобы проверить списание Laso.");
    }
    await channel.notify(reconciled ? "Билет Hudson Link на $2,75 отправлен. Сумма чека совпала с одним списанием Laso."
      : "Билет и чек Hudson Link на $2,75 проверены, PDF отправлен. Laso пока не показал совпадающее списание. Повтори /buy_hudson, чтобы сверить его.");
  }

  return async (channel: TelegramPurchaseChannel, legacy?: { ticketUrl: string; ticketReference: string }): Promise<void> => {
    const signal = channel.signal;
    const previous = readRecord(path, deps.cardId);
    if (legacy) {
      const orderId = hudsonOrderFromTicketUrl(legacy.ticketUrl);
      if (previous?.stage !== "delivered" || !orderId || !/^[A-Z0-9]{8}$/.test(legacy.ticketReference)) {
        throw new Error("Expected an existing delivered Hudson Link ticket and its reference");
      }
      const checked = await checkReceipt(previous, orderId, signal, legacy.ticketReference);
      if (!checked.reconciled) throw new Error("Laso did not confirm the existing Hudson Link debit");
      saveChecked(previous, checked);
      return;
    }
    if (previous?.stage === "uploading") return channel.notify("Telegram не подтвердил отправку. Проверь файл в этом чате и письмо Hudson Link перед повтором.");
    if (previous?.stage === "submitted") {
      if (previous.merchantOrderId) {
        const checked = await checkPurchase(previous, signal);
        saveChecked(previous, checked);
        if (checked.reconciled && checked.receiptVerified) {
          return channel.notify("Hudson Link подтвердил оплату $2,75, списание Laso совпало. Доставка билета не подтверждена. Открой билет по ссылке из письма перевозчика.");
        }
      }
      return channel.notify("Исход оплаты неизвестен. Проверь письмо Hudson Link и операции Laso. Повторное списание заблокировано.");
    }
    if (previous?.stage === "delivered") {
      const checked = await checkPurchase(previous, signal);
      saveChecked(previous, checked);
      if (!checked.reconciled) return channel.notify("Билет уже отправлен. Laso пока не показал совпадающее списание.");
      return channel.notify(checked.receiptVerified ? "Билет уже отправлен, квитанция на $2,75 совпала со списанием Laso."
        : "Билет уже отправлен, Laso показал одно списание на $2,75. Сумма отдельной квитанции Hudson Link ещё не сверена.");
    }
    if (previous?.stage === "receipted") {
      const fd = openSync(pdfPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      let pdf: Buffer;
      try {
        const stat = fstatSync(fd);
        if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) || stat.size > maxPdfBytes) throw new Error("Invalid ticket file");
        pdf = checkedPdf(readFileSync(fd));
      } finally { closeSync(fd); }
      if (await channel.approveDelivery(title)) await deliver(channel, previous, pdf);
      return;
    }

    let accepted: boolean | undefined;
    let initial: CheckoutCardState;
    const balanceUnavailable = "Не удалось подтвердить достаточный остаток и историю карты Laso.";
    try {
      const merchantRows = await Promise.all([
        deps.laso.merchantAcceptance(["Coach USA", "Coach USA Community"], signal),
        deps.laso.merchantAcceptance(["Hudson Link"], signal),
      ]);
      if (merchantRows.includes("not_accepted")) return channel.notify("Laso пометил перевозчика как несовместимого с этой картой.");
      accepted = merchantRows.includes("accepted");
      initial = await deps.laso.read(signal);
    } catch (error) {
      if (error instanceof LasoCheckoutAuthError) return channel.notify(reconnectLaso);
      return channel.notify(accepted === undefined ? "Не удалось проверить Laso. Повтори /buy_hudson позже." : balanceUnavailable);
    }
    if (initial.balanceCents < ticketCents || !initial.hudsonDebits) return channel.notify(balanceUnavailable);
    if (debitCount(initial) > 0) return channel.notify("На Laso уже видна операция Hudson Link или Coach USA на $2,75. Сначала проверь предыдущий чек.");
    const configured = deps.receiptEmail();
    const email = configured ? mailAddress(configured) : await channel.requestReceiptEmail();
    if (!email) return;
    let session: Awaited<ReturnType<typeof openHudsonCheckout>> | undefined;
    let submitted: PurchaseRecord | undefined;
    try {
      const firstName = await channel.requestInput("passenger_first_name");
      const lastName = firstName && await channel.requestInput("passenger_last_name");
      if (!firstName || !lastName) return;
      try {
        session = await open({ email, browserWsEndpoint: deps.browserWsEndpoint(), signal });
      } catch (error) {
        if (error instanceof HudsonCheckoutError && error.opening && !signal.aborted) {
          const { stage, response, status } = error.opening;
          console.warn("[Hudson Link] Checkout opening failed", { code: error.code, stage, response, status });
        }
        throw error;
      }
      if (session.totalCents !== ticketCents) return await channel.notify("Hudson Link изменил итог. Ожидалось $2,75.");
      if (!accepted) await channel.notify("Laso пока не подтвердил приём этой карты у Coach USA. Перевозчик показал итог $2,75.");
      if (!await channel.approve({ title, merchant: "Hudson Link", itemUrl: HUDSON_LINK_ITEM_URL, passengerName: `${firstName} ${lastName}`,
        totalCents: ticketCents, maxCents: ticketCents, receiptEmail: email })) return;
      const ready = await deps.laso.read(signal, true);
      const { billing } = ready;
      if (!ready.card || billing.country !== "US" || !billing.name || !billing.street || !billing.city || !billing.state || !billing.postalCode) {
        return await channel.notify("Laso не вернул полные реквизиты карты и платёжный адрес. Оплата остановлена.");
      }
      if (ready.balanceCents !== initial.balanceCents || debitCount(ready) !== debitCount(initial)) {
        return await channel.notify("Состояние карты изменилось после подтверждения. Проверь Laso и повтори /buy_hudson.");
      }
      const row: PurchaseRecord = { v: 1, id: randomUUID(), cardId: deps.cardId, stage: "submitted", beforeCents: ready.balanceCents,
        priorDebits: debitCount(ready), reconciled: false, receiptVerified: false };
      const ticket = await session.complete(ready.card, billing, { firstName, lastName }, () => {
        signal.throwIfAborted();
        mkdirSync(deps.stateDir, { recursive: true, mode: 0o700 });
        writeCheckoutRecord(path, row, true);
        submitted = row;
        deps.report?.({ provider: "laso", operation: "card_checkout", status: "attempted" });
      }, signal, orderId => {
        if (!submitted || !HUDSON_ORDER_ID.test(orderId)) throw new Error("Hudson Link order arrived before its journal entry");
        submitted = { ...submitted, merchantOrderId: orderId };
        writeCheckoutRecord(path, submitted, false);
      });
      if (!submitted || ticket.totalCents !== ticketCents || ticket.filename.toLowerCase() !== filename) throw new Error("Unverified Hudson Link receipt");
      const pdf = checkedPdf(ticket.bytes);
      const fd = openSync(pdfPath, "wx", 0o600);
      try { writeFileSync(fd, pdf); fsyncSync(fd); } finally { closeSync(fd); }
      const receipted = { ...submitted, stage: "receipted", receiptVerified: !submitted.merchantOrderId && ticket.receiptVerified } as const;
      writeCheckoutRecord(path, receipted, false);
      await deliver(channel, receipted, pdf);
    } catch (error) {
      if (signal.aborted) return;
      if (submitted) {
        return channel.notify("Платёж мог быть отправлен. Проверь чек Hudson Link и Laso. Повторное списание заблокировано.");
      }
      if (error instanceof LasoCheckoutAuthError) return channel.notify(reconnectLaso);
      const code = error instanceof HudsonCheckoutError ? error.code : undefined;
      await channel.notify(code && code in checkoutFailureMessages
        ? checkoutFailureMessages[code as keyof typeof checkoutFailureMessages]
        : "Не удалось проверить платёжную форму Hudson Link. Запрос оплаты не отправлен.");
    } finally { await session?.close(); }
  };
}

export function configuredHudsonPurchase(stateDir: string, mode: string, report?: ReportProviderActivity) {
  if (mode !== "live" || process.env.ARGUS_HUDSON_PURCHASE_ENABLED !== "1") return;
  const file = (name: string) => {
    const path = process.env[name]?.trim();
    if (!path || !isAbsolute(path)) throw new Error("Missing private Hudson checkout configuration");
    return path;
  };
  return async (channel: TelegramPurchaseChannel, legacy?: { ticketUrl: string; ticketReference: string }) => {
    const wsFile = file("ARGUS_HUDSON_BROWSER_WS_FILE");
    const tokenFile = process.env.ARGUS_ITCH_LASO_SESSION_FILE?.trim();
    if (!tokenFile || !isAbsolute(tokenFile)) return channel.notify(reconnectLaso);
    const id = readPrivateCheckoutFile(file("ARGUS_ITCH_LASO_CARD_ID_FILE"), 128).trim();
    const laso = createLasoCheckoutCard({ id, token: async () => readLasoCheckoutSession(tokenFile) });
    return createHudsonPurchase({ stateDir, cardId: id, laso, report, browserWsEndpoint: () => {
      const endpoint = readPrivateCheckoutFile(wsFile, 256).trim();
      if (!isHudsonBrowserEndpoint(endpoint)) throw new Error("Invalid Hudson checkout browser endpoint");
      return endpoint;
    }, receiptEmail: () => {
      const emailFile = process.env.ARGUS_ITCH_RECEIPT_EMAIL_FILE;
      return emailFile && isAbsolute(emailFile) ? readPrivateCheckoutFile(emailFile, 512).trim() : undefined;
    } })(channel, legacy);
  };
}
