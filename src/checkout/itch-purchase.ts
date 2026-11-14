import { randomUUID } from "node:crypto";
import { constants, closeSync, fstatSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { MailService, mailAddress } from "../mail/index.js";
import type { ReportProviderActivity } from "../monitor/provider-events.js";
import { LASO_CHECKOUT_RECONNECT, LasoCheckoutAuthError, createLasoCheckoutCard, type CheckoutCardState } from "./laso-card.js";
import { ITCH_PRODUCT, ItchCheckoutError, isCheckoutBrowserEndpoint, openItchCheckout, resumeItchDownload, type ItchBilling } from "./itch-browser.js";
import { validateIconZip } from "./zip.js";
import { TelegramDocumentRejected, type TelegramPurchaseChannel, type TelegramPurchaseInput, type TelegramPurchaseIntent } from "../telegram/purchase.js";

type PurchaseRunner = (channel: TelegramPurchaseChannel, intent?: TelegramPurchaseIntent) => Promise<void>;
const reconnectLaso = `${LASO_CHECKOUT_RECONNECT}, затем повтори /buy_itch.`;

interface PurchaseRecord {
  v: 1;
  stage: "submitted" | "receipted" | "delivered";
  totalCents: number;
  beforeCents: number;
  priorDebits: number;
  cardId: string;
  reconciled?: boolean;
  providerSuccessId?: string;
}

interface ManualDeliveryRecord {
  v: 1;
  stage: "manual_delivery_pending" | "manual_delivery_retryable" | "manual_delivered";
  totalCents: number;
  cardId: string;
  reconciled: boolean;
}

type JournalRecord = PurchaseRecord | ManualDeliveryRecord;

function isManualRecord(row: JournalRecord): row is ManualDeliveryRecord {
  return row.stage === "manual_delivery_pending" || row.stage === "manual_delivery_retryable" || row.stage === "manual_delivered";
}

interface Dependencies {
  stateDir: string;
  cardId: string;
  executablePath?: string;
  browserWsEndpoint?: () => string;
  receiptEmail: () => string | undefined;
  laso: Pick<ReturnType<typeof createLasoCheckoutCard>, "read" | "accepted" | "refresh">;
  open?: typeof openItchCheckout;
  resume?: typeof resumeItchDownload;
  wait?: typeof sleep;
  reportProvider?: ReportProviderActivity;
}

const FIELDS = [
  ["country", "billing_country"], ["name", "billing_name"], ["street", "billing_street"],
  ["city", "billing_city"], ["state", "billing_state"], ["postalCode", "billing_postal"],
] as const satisfies readonly [keyof ItchBilling, TelegramPurchaseInput][];

export function readPrivateCheckoutFile(path: string, limit: number): string {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.uid !== process.getuid?.() || (st.mode & 0o077) || st.size > limit) {
      throw new Error("Invalid private checkout file.");
    }
    return readFileSync(fd, "utf8");
  } finally {
    closeSync(fd);
  }
}

export function readLasoCheckoutSession(path: string): string {
  try {
    const token = readPrivateCheckoutFile(path, 8193).trim();
    if (/^[A-Za-z0-9_.-]{1,8192}$/.test(token)) return token;
  } catch {
    // Configuration errors are reported without the contents or path of the private file.
  }
  throw new LasoCheckoutAuthError();
}

function syncDirectory(path: string): void {
  const directory = openSync(dirname(path), constants.O_RDONLY);
  try {
    fsyncSync(directory);
  } finally {
    closeSync(directory);
  }
}

export function writeCheckoutRecord(path: string, value: object, exclusive: boolean): void {
  const pending = exclusive ? path : `${path}.${randomUUID()}.tmp`;
  try {
    const fd = openSync(pending, "wx", 0o600);
    try {
      writeFileSync(fd, JSON.stringify(value));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    if (!exclusive) renameSync(pending, path);
    syncDirectory(path);
  } finally {
    if (!exclusive) {
      try { unlinkSync(pending); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  }
}

function readRecord(path: string, cardId: string): JournalRecord | undefined {
  try {
    const row = JSON.parse(readPrivateCheckoutFile(path, 4096)) as JournalRecord;
    if (row.v !== 1 || row.cardId !== cardId || !validTotal(row.totalCents)) throw new Error("Invalid checkout state.");
    if (isManualRecord(row)) {
      if (typeof row.reconciled !== "boolean") throw new Error("Invalid checkout state.");
      return row;
    }
    if (!["submitted", "receipted", "delivered"].includes(row.stage)
      || !Number.isSafeInteger(row.beforeCents) || row.beforeCents < row.totalCents
      || row.beforeCents > ITCH_PRODUCT.maxCents || !Number.isSafeInteger(row.priorDebits) || row.priorDebits < 0
      || (row.providerSuccessId !== undefined && !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(row.providerSuccessId))
      || (row.reconciled !== undefined && typeof row.reconciled !== "boolean")) throw new Error("Invalid checkout state.");
    return row;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
}

function validTotal(cents: number): boolean {
  return Number.isSafeInteger(cents) && cents >= ITCH_PRODUCT.baseCents && cents <= ITCH_PRODUCT.maxCents;
}

function debitCount(state: CheckoutCardState, cents: number): number {
  return state.itchDebits.filter(debit => debit === cents).length;
}

function dollars(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

export function createItchPurchase(deps: Dependencies): PurchaseRunner {
  const open = deps.open ?? openItchCheckout;
  const resume = deps.resume ?? resumeItchDownload;
  const wait = deps.wait ?? sleep;
  const path = join(deps.stateDir, "itch-icon-purchase.json");

  function reportReconciled(row: PurchaseRecord): void {
    if (row.providerSuccessId) {
      deps.reportProvider?.({ provider: "laso", operation: "card_checkout", status: "succeeded" }, row.providerSuccessId);
    }
  }
  const browser = () => ({ executablePath: deps.executablePath, browserWsEndpoint: deps.browserWsEndpoint?.() });

  async function reconcile(row: PurchaseRecord, signal: AbortSignal): Promise<CheckoutCardState | undefined> {
    for (let attempt = 0; attempt < 3; attempt++) {
      signal.throwIfAborted();
      const state = await deps.laso.read(signal).catch(() => undefined);
      if (state && state.balanceCents === row.beforeCents - row.totalCents
        && debitCount(state, row.totalCents) === row.priorDebits + 1) return state;
      if (attempt === 0) await deps.laso.refresh(signal).catch(() => {});
      if (attempt < 2) await wait(4_000, undefined, { signal });
    }
  }

  async function findManualDebit(totalCents: number, signal: AbortSignal): Promise<CheckoutCardState | undefined> {
    const state = await deps.laso.read(signal).catch(() => undefined);
    if (state && state.balanceCents === ITCH_PRODUCT.maxCents - totalCents
      && state.itchDebits.length === 1 && state.itchDebits[0] === totalCents) return state;
  }

  async function recoverManualPurchase(channel: TelegramPurchaseChannel, previous?: ManualDeliveryRecord): Promise<void> {
    if (!await channel.approveDelivery(ITCH_PRODUCT.title)) return;
    const privateUrl = await channel.requestInput("purchase_link");
    if (!privateUrl) return;
    let file;
    try {
      file = await resume({ privateUrl, ...browser(), signal: channel.signal });
      if (!validTotal(file.receiptCents) || file.filename !== ITCH_PRODUCT.filename
        || (previous && file.receiptCents !== previous.totalCents)) throw new Error("Unexpected paid download.");
      validateIconZip(file.bytes);
    } catch {
      if (!channel.signal.aborted) await channel.notify("Не удалось подтвердить чек и скачать нужный ZIP. Проверь приватную ссылку из письма itch.io.");
      return;
    }
    const verified = await findManualDebit(file.receiptCents, channel.signal);
    channel.signal.throwIfAborted();
    mkdirSync(deps.stateDir, { recursive: true, mode: 0o700 });
    const pending: ManualDeliveryRecord = {
      v: 1, cardId: deps.cardId, stage: "manual_delivery_pending", totalCents: file.receiptCents, reconciled: Boolean(verified || previous?.reconciled),
    };
    try {
      if (previous) {
        const claim = `${path}.manual-retry`;
        const lock = openSync(claim, "wx", 0o600);
        try {
          if (readRecord(path, deps.cardId)?.stage !== "manual_delivery_retryable") {
            return channel.notify("У этого набора уже есть запись о покупке или доставке. Повтори /recover_itch, чтобы проверить её статус.");
          }
          writeCheckoutRecord(path, pending, false);
        } finally {
          closeSync(lock);
          unlinkSync(claim);
        }
      } else {
        writeCheckoutRecord(path, pending, true);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      await channel.notify("У этого набора уже есть запись о покупке или доставке. Повтори /recover_itch, чтобы проверить её статус.");
      return;
    }
    try {
      await channel.sendDocument(file.filename, file.bytes);
      writeCheckoutRecord(path, { ...pending, stage: "manual_delivered" }, false);
    } catch (error) {
      if (error instanceof TelegramDocumentRejected) {
        writeCheckoutRecord(path, { ...pending, stage: "manual_delivery_retryable" }, false);
        if (!channel.signal.aborted) await channel.notify("Telegram отклонил загрузку ZIP. Повтори /recover_itch, чтобы отправить файл ещё раз.");
      } else if (!channel.signal.aborted) {
        await channel.notify("Telegram не подтвердил доставку ZIP. Проверь файлы в чате или скачай ZIP по ссылке из чека itch.io.");
      }
      return;
    }
    await channel.notify(verified
      ? `ZIP проверен и отправлен. Сумма чека itch.io ${dollars(file.receiptCents)} совпала с одним списанием Laso. Остаток ${dollars(verified.balanceCents)}.`
      : `Чек itch.io на ${dollars(file.receiptCents)} и ZIP проверены, файл отправлен.${pending.reconciled ? " Списание Laso ранее сверено." : " Списание Laso пока не подтверждено."}`);
  }

  async function deliver(
    channel: TelegramPurchaseChannel, row: PurchaseRecord,
    file: { receiptCents: number; filename: string; bytes: Uint8Array },
  ): Promise<void> {
    if (file.receiptCents !== row.totalCents || file.filename !== ITCH_PRODUCT.filename) throw new Error("Unexpected paid download.");
    validateIconZip(file.bytes);
    const verified = await reconcile(row, channel.signal);
    if (verified) reportReconciled(row);
    await channel.sendDocument(file.filename, file.bytes);
    writeCheckoutRecord(path, { ...row, stage: "delivered", reconciled: Boolean(verified) }, false);
    await channel.notify(verified
      ? `Готово. Чек itch.io на ${dollars(row.totalCents)} совпал со списанием Laso. Остаток ${dollars(verified.balanceCents)}. ZIP проверен и отправлен.`
      : `Чек itch.io на ${dollars(row.totalCents)} и ZIP проверены, файл отправлен. Laso ещё не подтвердил списание. Повтори «купи иконки» для сверки без новой оплаты.`);
  }

  return async (channel, intent = "buy") => {
    const signal = channel.signal;
    let previous: JournalRecord | undefined;
    try {
      previous = readRecord(path, deps.cardId);
    } catch {
      return channel.notify("Не удалось прочитать журнал покупки. Проверь чек и списание до повторной попытки.");
    }
    if (previous && isManualRecord(previous)) {
      if (previous.stage === "manual_delivery_pending") {
        return channel.notify("Telegram не подтвердил доставку предыдущего ZIP. Проверь файлы в чате или скачай ZIP по ссылке из чека itch.io.");
      }
      if (previous.stage === "manual_delivery_retryable") {
        if (intent === "recover") return recoverManualPurchase(channel, previous);
        return channel.notify("Набор уже оплачен. Повтори /recover_itch, чтобы отправить ZIP в Telegram.");
      }
      if (previous.reconciled) return channel.notify("Проверенный ZIP уже отправлен в этот чат.");
      const verified = await findManualDebit(previous.totalCents, signal);
      if (!verified) return channel.notify("ZIP уже отправлен. Списание Laso пока не подтверждено.");
      writeCheckoutRecord(path, { ...previous, reconciled: true }, false);
      return channel.notify(`Сумма чека совпала с одним списанием Laso на ${dollars(previous.totalCents)}. Остаток ${dollars(verified.balanceCents)}.`);
    }
    if (previous?.stage === "delivered") {
      if (previous.reconciled) return channel.notify("Этот набор уже куплен, проверен и отправлен в этот чат.");
      const verified = await reconcile(previous, signal);
      if (!verified) return channel.notify("ZIP уже отправлен. Laso ещё не подтвердил списание по чеку.");
      reportReconciled(previous);
      writeCheckoutRecord(path, { ...previous, reconciled: true }, false);
      return channel.notify(`Списание Laso сверено с чеком на ${dollars(previous.totalCents)}. Остаток ${dollars(verified.balanceCents)}.`);
    }
    if (previous) {
      if (!await channel.approveDelivery(ITCH_PRODUCT.title)) return;
      const privateUrl = await channel.requestInput("purchase_link");
      if (!privateUrl) {
        if (!signal.aborted) await channel.notify("Жду ссылку из чека itch.io. Если чек не пришёл, сначала проверь операции в Laso. Журнал блокирует повторную оплату.");
        return;
      }
      try {
        const file = await resume({ privateUrl, ...browser(), signal });
        if (file.receiptCents !== previous.totalCents) throw new Error("Unexpected receipt amount.");
        await deliver(channel, previous, file);
      } catch {
        if (!signal.aborted) await channel.notify("Не удалось подтвердить чек и скачать нужный ZIP. Проверь ссылку из письма itch.io. Повторного списания не было.");
      }
      return;
    }
    if (intent === "recover") return recoverManualPurchase(channel);

    let email: string | null = null;
    try {
      const configured = deps.receiptEmail();
      if (configured) email = mailAddress(configured);
    } catch { /* Ask for an address if no usable one is configured. */ }
    email ??= await channel.requestReceiptEmail();
    if (!email) return;
    let accepted = false;
    let quoteCard: CheckoutCardState;
    try {
      accepted = await deps.laso.accepted(signal);
      if (!accepted) return channel.notify("Не удалось подтвердить в Laso, что itch.io принимает настроенную карту.");
      quoteCard = await deps.laso.read(signal);
    } catch (error) {
      if (error instanceof LasoCheckoutAuthError) return channel.notify(reconnectLaso);
      return channel.notify(accepted ? "Не удалось открыть настроенную карту Laso. Для покупки нужна доступная карта, привязанная к этому боту."
        : "Не удалось подтвердить в Laso, что itch.io принимает настроенную карту.");
    }
    if (quoteCard.itchDebits.length) {
      return channel.notify("У карты уже есть списание itch.io. Проверь предыдущий чек. Используй /recover_itch, чтобы получить ZIP по ссылке из чека.");
    }
    if (quoteCard.balanceCents < ITCH_PRODUCT.baseCents) return channel.notify("На карте Laso недостаточно средств для набора.");
    const billing = { ...quoteCard.billing };
    for (const [key, prompt] of FIELDS) {
      if (!billing[key]) {
        const value = await channel.requestInput(prompt);
        if (!value) return;
        billing[key] = value;
      }
    }
    if (billing.country !== "US") {
      return channel.notify("Для этой карты Laso нужен действительный платёжный адрес в США. Этот чекаут с указанным адресом оплатить нельзя.");
    }

    let session;
    let recorded: PurchaseRecord | undefined;
    try {
      session = await open({ email, billing, ...browser(), signal });
      const { totalCents, taxCents } = session;
      if (!validTotal(totalCents) || taxCents !== totalCents - ITCH_PRODUCT.baseCents || totalCents > quoteCard.balanceCents) {
        return await channel.notify("Итоговая сумма изменилась или превышает лимит карты. Оплата остановлена.");
      }
      if (!await channel.approve({
        title: ITCH_PRODUCT.title, merchant: ITCH_PRODUCT.merchant, itemUrl: ITCH_PRODUCT.productUrl,
        receiptEmail: email, totalCents, taxCents, maxCents: ITCH_PRODUCT.maxCents,
      })) return;
      signal.throwIfAborted();
      const payment = await deps.laso.read(signal, true);
      if (!payment.card || payment.balanceCents !== quoteCard.balanceCents || payment.itchDebits.length) {
        return await channel.notify("После подтверждения состояние карты изменилось. Оплата остановлена.");
      }
      const pending: PurchaseRecord = {
        v: 1, cardId: deps.cardId, stage: "submitted", totalCents,
        beforeCents: payment.balanceCents, priorDebits: debitCount(payment, totalCents),
        providerSuccessId: randomUUID(),
      };
      const file = await session.complete(payment.card, signal, async receipt => {
        if (!recorded || receipt.receiptCents !== totalCents) throw new Error("Unexpected paid receipt.");
        writeCheckoutRecord(path, { ...recorded, stage: "receipted" }, false);
      }, () => {
        signal.throwIfAborted();
        mkdirSync(deps.stateDir, { recursive: true, mode: 0o700 });
        writeCheckoutRecord(path, pending, true);
        recorded = pending;
        deps.reportProvider?.({ provider: "laso", operation: "card_checkout", status: "attempted" });
      });
      if (!recorded) throw new Error("Missing checkout submission record.");
      await deliver(channel, recorded, file);
    } catch (error) {
      if (signal.aborted) return;
      if (recorded || (error instanceof ItchCheckoutError && error.submitted)) {
        return await channel.notify("Запрос оплаты уже отправлен. Проверь письмо itch.io. Если там есть чек, повтори «купи иконки», и я попрошу приватную ссылку для скачивания без повторной оплаты.");
      }
      if (error instanceof LasoCheckoutAuthError) return await channel.notify(reconnectLaso);
      if (error instanceof ItchCheckoutError && error.code === "billing_mismatch") {
        return await channel.notify("itch.io не подтвердил страну или платёжный адрес этой карты. Проверь данные в Laso и сообщи подходящий способ оплаты.");
      }
      if (error instanceof ItchCheckoutError && error.code === "verification_required") {
        return await channel.notify("itch.io запросил ручную проверку. Открой чекаут в браузере владельца. Автоматическая оплата остановлена.");
      }
      if (error instanceof ItchCheckoutError && error.code === "checkout_redirected") {
        return await channel.notify(`itch.io вернул на главную страницу до открытия платёжной формы. Можно оформить покупку в своём браузере по адресу ${ITCH_PRODUCT.productUrl}, а затем получить ZIP командой /recover_itch по ссылке из квитанции.`);
      }
      return await channel.notify("Не удалось проверить форму и итоговую сумму itch.io. Оплата остановлена.");
    } finally {
      await session?.close();
    }
  };
}

export function configuredItchPurchase(
  stateDir: string,
  mode: string,
  reportProvider?: ReportProviderActivity,
): PurchaseRunner | undefined {
  if (mode !== "live" || process.env.ARGUS_ITCH_PURCHASE_ENABLED !== "1") return;
  const keyPath = process.env.ARGUS_ITCH_LASO_WALLET_KEY_FILE?.trim();
  const sessionPath = process.env.ARGUS_ITCH_LASO_SESSION_FILE?.trim();
  const cardIdFile = process.env.ARGUS_ITCH_LASO_CARD_ID_FILE?.trim();
  let cardId: string | undefined;
  try {
    cardId = cardIdFile && isAbsolute(cardIdFile)
      ? readPrivateCheckoutFile(cardIdFile, 128).trim()
      : cardIdFile ? undefined : process.env.ARGUS_ITCH_LASO_CARD_ID?.trim();
  } catch {
    return channel => channel.notify("Администратору нужно проверить файл карты Laso для покупки.");
  }
  const executablePath = process.env.ARGUS_ITCH_CHROMIUM_PATH?.trim();
  const browserWsFile = process.env.ARGUS_ITCH_BROWSER_WS_FILE?.trim();
  const receiptEmailFile = process.env.ARGUS_ITCH_RECEIPT_EMAIL_FILE?.trim();
  const credentialPath = sessionPath ?? keyPath;
  if (!credentialPath || !isAbsolute(credentialPath) || (keyPath && sessionPath)
    || !cardId || (!executablePath && !browserWsFile) || (executablePath && browserWsFile)
    || (executablePath && !isAbsolute(executablePath)) || (browserWsFile && !isAbsolute(browserWsFile))
    || (receiptEmailFile && !isAbsolute(receiptEmailFile))) {
    return channel => channel.notify("Для покупки администратору нужно подключить карту Laso и браузер с изоляцией.");
  }
  const mail = new MailService(stateDir);
  try {
    const laso = createLasoCheckoutCard({
      id: cardId,
      reportProvider,
      walletKey: keyPath ? () => {
        const key = readPrivateCheckoutFile(keyPath, 128).trim();
        if (!/^0x[a-f0-9]{64}$/i.test(key)) throw new Error("Invalid dedicated Laso wallet key.");
        return key as `0x${string}`;
      } : undefined,
      token: sessionPath ? async () => readLasoCheckoutSession(sessionPath) : undefined,
    });
    return createItchPurchase({
      stateDir, cardId, executablePath, laso, reportProvider,
      browserWsEndpoint: browserWsFile ? () => {
        const endpoint = readPrivateCheckoutFile(browserWsFile, 256).trim();
        if (!isCheckoutBrowserEndpoint(endpoint)) throw new Error("Invalid private checkout browser endpoint.");
        return endpoint;
      } : undefined,
      receiptEmail: () => {
        if (receiptEmailFile) {
          try {
            const email = mailAddress(readPrivateCheckoutFile(receiptEmailFile, 512).trim());
            return email;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
        }
        return process.env.ARGUS_ITCH_RECEIPT_EMAIL?.trim() || mail.settings()?.email;
      },
    });
  } catch {
    return channel => channel.notify("Администратору нужно проверить идентификатор карты Laso для покупки.");
  }
}
