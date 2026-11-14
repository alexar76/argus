import { randomBytes } from "node:crypto";
import { mailAddress } from "../mail/types.js";

const INPUTS = {
  receipt_email: "your receipt email address",
  billing_name: "the card's billing name",
  billing_street: "the card's billing street address",
  billing_city: "the card's billing city",
  billing_state: "the card's billing state or region",
  billing_postal: "the card's billing postal code",
  billing_country: "the card's two-letter billing country code",
  passenger_first_name: "the passenger's first name",
  passenger_last_name: "the passenger's last name",
  purchase_link: "the private itch.io download link from your receipt",
} as const;
const RUSSIAN_INPUTS: Record<keyof typeof INPUTS, string> = {
  receipt_email: "email для квитанции",
  billing_name: "имя владельца в платёжных данных карты",
  billing_street: "улицу и номер дома в платёжном адресе карты",
  billing_city: "город в платёжном адресе карты",
  billing_state: "регион в платёжном адресе карты",
  billing_postal: "почтовый индекс в платёжном адресе карты",
  billing_country: "двухбуквенный код страны платёжного адреса карты",
  passenger_first_name: "имя пассажира",
  passenger_last_name: "фамилию пассажира",
  purchase_link: "закрытую ссылку itch.io на скачивание из квитанции",
};
const INPUT_PREFIX = "Purchase details · Reply with ";
const RUSSIAN_INPUT_PREFIX = "Данные покупки · Пришлите в ответ ";
const MAX_CENTS = 500;
const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;
const INPUT_TIMEOUT_MS = 120_000;
export const HUDSON_LINK_ITEM_URL = "https://www.ridehudsonlink.com/travel-options/palisades-center-lot-j-west-nyack-ny/depot-plz-train-station-tarrytown-ny";
export const HUDSON_LINK_TICKET_CENTS = 275;

export type TelegramPurchaseInput = keyof typeof INPUTS;
export type TelegramPurchaseIntent = "buy" | "recover";
export type TelegramPurchaseMerchant = "itch" | "hudson";

export class TelegramDocumentRejected extends Error {
  constructor() {
    super("Telegram rejected the document upload.");
  }
}

export interface TelegramPurchaseApproval {
  title: string;
  merchant: string;
  totalCents: number;
  receiptEmail: string;
  itemUrl?: string;
  taxCents?: number;
  maxCents?: number;
  passengerName?: string;
}

export interface TelegramPurchaseChannel {
  readonly signal: AbortSignal;
  requestReceiptEmail(): Promise<string | null>;
  requestInput(field: TelegramPurchaseInput): Promise<string | null>;
  approve(input: TelegramPurchaseApproval): Promise<boolean>;
  approveDelivery(title: string): Promise<boolean>;
  sendDocument(filename: string, bytes: Uint8Array): Promise<void>;
  notify(text: string): Promise<void>;
}

type PurchaseTransport = {
  prompt(text: string, replyMarkup: object): Promise<number>;
  send(text: string): Promise<void>;
  upload(filename: string, bytes: Uint8Array, mimeType: "application/zip" | "application/pdf"): Promise<void>;
};

type PendingInput = {
  field: TelegramPurchaseInput;
  prompt: Promise<number>;
  finish(value: string | null): void;
};

type PendingApproval = {
  token: string;
  prompt: Promise<number>;
  finish(value: boolean): void;
};

export function purchaseCommand(text: string): TelegramPurchaseIntent | undefined {
  if (/^(?:\/buy_itch|купи (?:иконки|иконци)|buy (?:the )?icons)$/iu.test(text)) return "buy";
  if (/^(?:\/recover_itch|получи иконки|recover (?:the )?icons)$/iu.test(text)) return "recover";
}

export function isHudsonPurchaseCommand(text: string): boolean {
  return /^(?:\/buy_hudson|купи билет hudson link|buy (?:a )?hudson link ticket)$/iu.test(text);
}

export function isPurchaseInputPrompt(text: string | undefined): boolean {
  return Boolean(text && (text.startsWith(INPUT_PREFIX) || text.startsWith(RUSSIAN_INPUT_PREFIX)));
}

export function isPurchaseLink(text: string): boolean {
  try {
    const url = new URL(text);
    return itchUrl(url) && /^\/(?:[^/]+\/)?download\/[a-z0-9_-]{8,160}\/?$/i.test(url.pathname);
  } catch {
    return false;
  }
}

/** One private checkout. Input, approval, and delivery are scoped to this run. */
export class TelegramPurchase implements TelegramPurchaseChannel {
  private readonly controller = new AbortController();
  readonly signal: AbortSignal = this.controller.signal;
  private readonly requested = new Set<TelegramPurchaseInput>();
  private input: PendingInput | undefined;
  private approval: PendingApproval | undefined;
  private approvalRequested = false;
  private approved = false;
  private documentStarted = false;

  constructor(
    private readonly transport: PurchaseTransport,
    private readonly russian = false,
    private readonly merchant: TelegramPurchaseMerchant = "itch",
  ) {}

  cancel(): void {
    this.controller.abort();
    this.input?.finish(null);
    this.approval?.finish(false);
  }

  requestReceiptEmail(): Promise<string | null> {
    return this.requestInput("receipt_email");
  }

  async requestInput(field: TelegramPurchaseInput): Promise<string | null> {
    if (this.signal.aborted || this.input || this.approval || this.requested.has(field) || !Object.hasOwn(INPUTS, field)) return null;
    if (this.merchant === "hudson" ? field === "purchase_link" : field.startsWith("passenger_")) return null;
    if (field === "purchase_link" ? !this.approved : this.approvalRequested) return null;
    this.requested.add(field);
    const text = this.russian
      ? `${RUSSIAN_INPUT_PREFIX}${RUSSIAN_INPUTS[field]}. Одно значение на ответ. Номер карты и код безопасности присылать не нужно. Команда /cancel отменяет операцию.`
      : `${INPUT_PREFIX}${INPUTS[field]}. Send one value per reply. Keep your card number and security code private. /cancel stops the checkout.`;
    const prompt = this.transport.prompt(text, { force_reply: true });
    let pending!: PendingInput;
    const result = new Promise<string | null>((resolve) => {
      const timeout = setTimeout(() => pending.finish(null), INPUT_TIMEOUT_MS);
      pending = { field, prompt, finish: (value) => {
        clearTimeout(timeout);
        if (this.input === pending) this.input = undefined;
        resolve(value);
      } };
      this.input = pending;
    });
    try {
      await prompt;
      return await result;
    } finally {
      pending.finish(null);
    }
  }

  async approve(input: TelegramPurchaseApproval): Promise<boolean> {
    if (this.merchant === "hudson" && (input.merchant !== "Hudson Link" || input.itemUrl !== HUDSON_LINK_ITEM_URL
      || !input.passengerName || input.totalCents !== HUDSON_LINK_TICKET_CENTS || input.maxCents !== HUDSON_LINK_TICKET_CENTS
      || (input.taxCents !== undefined && input.taxCents !== 0))) return false;
    if (input.passengerName !== undefined && (this.merchant !== "hudson" || !personName(input.passengerName))) return false;
    const text = approvalText(input, this.russian, this.merchant);
    return text ? this.requestApproval(text, this.russian ? "Подтвердить покупку" : "Approve this purchase") : false;
  }

  async approveDelivery(title: string): Promise<boolean> {
    if (!approvalLabel(title)) return false;
    if (this.merchant === "hudson") {
      const prompt = this.russian ? `Отправить оплаченный билет повторно?\n${title}` : `Send the ticket from the existing purchase?\n${title}`;
      return this.requestApproval(prompt, this.russian ? "Получить билет" : "Send the ticket");
    }
    const text = this.russian
      ? `Получить файл по существующей покупке?\n${title}\nARGUS запросит закрытую ссылку из квитанции и пришлёт ZIP сюда. Оплаты не будет.`
      : `Deliver an existing purchase?\n${title}\nARGUS will ask for the private receipt link and send the ZIP here. No payment will be made.`;
    return this.requestApproval(text, this.russian ? "Получить файл" : "Continue to delivery");
  }

  private async requestApproval(text: string, button: string): Promise<boolean> {
    if (this.signal.aborted || this.input || this.approvalRequested) return false;
    this.approvalRequested = true;
    const token = randomBytes(12).toString("hex");
    const prompt = this.transport.prompt(text, { inline_keyboard: [[
      { text: button, callback_data: `purchase:${token}:yes` },
      { text: this.russian ? "Отклонить" : "Decline", callback_data: `purchase:${token}:no` },
    ]] });
    let pending!: PendingApproval;
    const result = new Promise<boolean>((resolve) => {
      const timeout = setTimeout(() => pending.finish(false), INPUT_TIMEOUT_MS);
      pending = { token, prompt, finish: (value) => {
        clearTimeout(timeout);
        if (this.approval === pending) this.approval = undefined;
        resolve(value);
      } };
      this.approval = pending;
    });
    try {
      await prompt;
      this.approved = await result && !this.signal.aborted;
      return this.approved;
    } finally {
      pending.finish(false);
    }
  }

  async handleMessage(text: string, replyTo?: number): Promise<void> {
    if (/^\/cancel$/i.test(text)) {
      this.cancel();
      const message = this.russian ? "Отмена запрошена." : "Purchase cancellation requested.";
      const followUp = this.russian
        ? " Проверьте квитанцию и операции по карте перед новой покупкой."
        : " Check your receipt and card activity before starting another purchase.";
      await this.transport.send(this.approved ? message + followUp : message);
      return;
    }
    const input = this.input;
    if (input) {
      if (replyTo !== undefined && replyTo === await input.prompt && this.input === input) {
        const value = purchaseInput(input.field, text);
        if (value) return input.finish(value);
        if (this.russian) return this.transport.send(`Пришлите ${RUSSIAN_INPUTS[input.field]} ответом на тот же запрос.`);
        return this.transport.send(`Reply to the same prompt with ${INPUTS[input.field]}.`);
      }
      if (this.russian) return this.transport.send("Ответьте на текущий запрос покупки или отправьте /cancel.");
      return this.transport.send("Reply directly to the current purchase prompt, or send /cancel.");
    }
    if (this.russian) {
      return this.transport.send(this.approval ? "Проверьте данные и нажмите кнопку подтверждения или отправьте /cancel." : "Операция уже выполняется. Отправьте /cancel, чтобы запросить отмену.");
    }
    await this.transport.send(this.approval ? "Review the purchase and use its approval buttons, or send /cancel." : "A purchase is in progress. Send /cancel to request cancellation.");
  }

  async handleCallback(data: string, messageId: number): Promise<void> {
    const pending = this.approval;
    const match = /^purchase:([a-f0-9]{24}):(yes|no)$/.exec(data);
    if (pending && match && match[1] === pending.token && messageId === await pending.prompt && this.approval === pending) {
      pending.finish(match[2] === "yes");
    }
  }

  async sendDocument(filename: string, bytes: Uint8Array): Promise<void> {
    this.signal.throwIfAborted();
    if (!this.approved || this.documentStarted) throw new Error("Purchase document delivery is unavailable");
    if (this.merchant === "hudson") {
      if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,114}\.pdf$/i.test(filename) || bytes.length > MAX_DOCUMENT_BYTES || !hasPdfSignature(bytes)) {
        throw new Error("Invalid ticket PDF");
      }
    } else if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,114}\.zip$/i.test(filename) || bytes.length < 22 || bytes.length > MAX_DOCUMENT_BYTES || !hasZipSignature(bytes)) {
      throw new Error("Invalid purchase ZIP");
    }
    this.documentStarted = true;
    await this.transport.upload(filename, bytes, this.merchant === "hudson" ? "application/pdf" : "application/zip");
  }

  async notify(text: string): Promise<void> {
    this.signal.throwIfAborted();
    if (!text || text.length > 4000 || possibleCardNumber(text)) throw new Error("Invalid purchase notification");
    await this.transport.send(text);
  }
}

function possibleCardNumber(value: string): boolean {
  return /(?:\d[ -]?){12}\d/.test(value);
}

function purchaseInput(field: TelegramPurchaseInput, value: string): string | null {
  if (field === "purchase_link") {
    return value.length <= 1000 && !/[\s\p{Cc}\p{Cf}]/u.test(value) && isPurchaseLink(value) ? value : null;
  }
  if (!value || value.length > 254 || /[\p{Cc}\p{Cf}]/u.test(value) || possibleCardNumber(value)) return null;
  if (field === "passenger_first_name" || field === "passenger_last_name") return personName(value) ? value : null;
  if (field === "billing_country") return /^[a-z]{2}$/i.test(value) ? value.toUpperCase() : null;
  if (["billing_name", "billing_city", "billing_state"].includes(field)) return /\p{L}/u.test(value) ? value : null;
  if (field === "billing_postal") return /^[a-z0-9][a-z0-9 -]{2,10}$/i.test(value) ? value : null;
  if (field !== "receipt_email") return value;
  try {
    return mailAddress(value);
  } catch {
    return null;
  }
}

function approvalText({ title, merchant, totalCents, receiptEmail, itemUrl, taxCents, maxCents = MAX_CENTS, passengerName }: TelegramPurchaseApproval, russian: boolean, kind: TelegramPurchaseMerchant): string | null {
  if (!approvalLabel(title) || !approvalLabel(merchant)) return null;
  if (!Number.isInteger(totalCents) || !Number.isInteger(maxCents) || totalCents <= 0 || totalCents > maxCents || maxCents > MAX_CENTS) return null;
  if (taxCents !== undefined && (!Number.isInteger(taxCents) || taxCents < 0 || taxCents > totalCents)) return null;
  const email = purchaseInput("receipt_email", receiptEmail);
  if (!email) return null;
  const url = kind === "hudson" ? HUDSON_LINK_ITEM_URL : itemUrl ? productUrl(itemUrl) : undefined;
  if (itemUrl && !url) return null;
  const address = `${email.slice(0, 1)}…${email.slice(email.lastIndexOf("@"))}`;
  const usd = (cents: number) => `$${(cents / 100).toFixed(2)} USD`;
  return [
    russian ? "Подтвердить покупку?" : "Approve this purchase?",
    title,
    `${russian ? "Продавец" : "Merchant"} · ${merchant}`,
    ...(url ? [url] : []),
    ...(passengerName ? [`${russian ? "Пассажир" : "Passenger"} · ${passengerName}`] : []),
    `${russian ? "Итого" : "Total"} · ${usd(totalCents)}`,
    ...(taxCents === undefined ? [] : [`${russian ? "В том числе налог" : "Included tax"} · ${usd(taxCents)}`]),
    `${russian ? "Лимит" : "Maximum"} · ${usd(maxCents)}`,
    `${russian ? "Email для квитанции" : "Receipt email"} · ${address}`,
  ].join("\n");
}

function approvalLabel(value: string): boolean {
  return Boolean(value.trim()) && value.length <= 160 && !/[\p{Cc}\p{Cf}]/u.test(value) && !possibleCardNumber(value);
}

function personName(value: string): boolean {
  return value.length <= 100 && /^[\p{L}\p{M}]+(?:[ .’'-][\p{L}\p{M}]+)*\.?$/u.test(value);
}

function productUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (itchUrl(url) && !url.search && !url.hash && url.href.length <= 500) return url.href;
  } catch {
    // An invalid public product URL cannot be approved.
  }
  return undefined;
}

function itchUrl(url: URL): boolean {
  return url.protocol === "https:" && /^(?:[a-z0-9-]+\.)?itch\.io$/.test(url.hostname) && !url.port && !url.username && !url.password;
}

function hasZipSignature(bytes: Uint8Array): boolean {
  return bytes[0] === 0x50 && bytes[1] === 0x4b &&
    ((bytes[2] === 3 && bytes[3] === 4) || (bytes[2] === 5 && bytes[3] === 6));
}

function hasPdfSignature(bytes: Uint8Array): boolean {
  if (bytes.length < 64) return false;
  const head = Buffer.from(bytes.subarray(0, 12)).toString("latin1");
  const tail = Buffer.from(bytes.subarray(-128)).toString("latin1");
  return /^%PDF-(?:1\.[0-7]|2\.0)\r?\n/.test(head) && /(?:\r?\n)startxref\s+\d+\s+%%EOF\s*$/.test(tail);
}
