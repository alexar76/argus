import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createItchPurchase } from "../src/checkout/itch-purchase.js";
import { LasoCheckoutAuthError, createLasoCheckoutCard } from "../src/checkout/laso-card.js";
import { ITCH_PRODUCT, ItchCheckoutError, type ItchCheckoutSession } from "../src/checkout/itch-browser.js";
import { TelegramDocumentRejected, type TelegramPurchaseChannel } from "../src/telegram/purchase.js";

// A deflated ZIP with one 1×1 PNG, generated with Python zipfile.
const zip = Buffer.from("UEsDBBQAAAAIAAAAbV0zMwpxPwAAAEQAAAAKAAAAd2FsbGV0LnBuZ+sM8HPn5ZLiYmBg4PX0cAkC0owgzMECJLfK8DABKW5PF8eQilvJKT/4GRhZGRnVJR6nAYUZPF39XNY5JTQBAFBLAQIUAxQAAAAIAAAAbV0zMwpxPwAAAEQAAAAKAAAAAAAAAAAAAACkgQAAAAB3YWxsZXQucG5nUEsFBgAAAAABAAEAOAAAAGcAAAAAAA==", "base64");
const cardId = "O-fixtureCard01";
const card = { number: "4242424242424242", expMonth: "11", expYear: "2028", cvv: "123" };
const billing = { name: "Test Buyer", street: "100 Test Avenue", city: "Testville", state: "CA", postalCode: "90001", country: "US" };
const before = { balanceCents: 500, itchDebits: [], billing };
const after = { balanceCents: 201, itchDebits: [299], billing };
const privateUrl = `${ITCH_PRODUCT.productUrl}/download/test_download_key`;
const file = { receiptCents: 299, filename: ITCH_PRODUCT.filename, bytes: zip };
const temps: string[] = [];

function setup() {
  const stateDir = mkdtempSync(join(tmpdir(), "argus-itch-test-"));
  temps.push(stateDir);
  const stateFile = join(stateDir, "itch-icon-purchase.json");
  const session: ItchCheckoutSession = {
    totalCents: 299, taxCents: 0, close: vi.fn(async () => {}),
    complete: vi.fn<ItchCheckoutSession["complete"]>(async (credentials, _signal, receipt, submit) => {
      expect(credentials).toEqual(card);
      submit!();
      expect(JSON.parse(readFileSync(stateFile, "utf8")).stage).toBe("submitted");
      await receipt!({ receiptCents: 299, privateUrl });
      return file;
    }),
  };
  const channel = {
    signal: new AbortController().signal,
    requestReceiptEmail: vi.fn<TelegramPurchaseChannel["requestReceiptEmail"]>().mockResolvedValue("test@example.com"),
    requestInput: vi.fn<TelegramPurchaseChannel["requestInput"]>().mockResolvedValue(privateUrl),
    approve: vi.fn<TelegramPurchaseChannel["approve"]>().mockResolvedValue(true),
    approveDelivery: vi.fn<TelegramPurchaseChannel["approveDelivery"]>().mockResolvedValue(true),
    sendDocument: vi.fn<TelegramPurchaseChannel["sendDocument"]>().mockResolvedValue(undefined),
    notify: vi.fn<TelegramPurchaseChannel["notify"]>().mockResolvedValue(undefined),
  };
  const deps = {
    stateDir, cardId, executablePath: "/fake/chromium", receiptEmail: vi.fn<() => string | undefined>(),
    laso: {
      accepted: vi.fn().mockResolvedValue(true), refresh: vi.fn().mockResolvedValue(undefined),
      read: vi.fn().mockResolvedValue(after).mockResolvedValueOnce(before).mockResolvedValueOnce({ ...before, card }),
    },
    open: vi.fn().mockResolvedValue(session),
    resume: vi.fn().mockResolvedValue(file),
    wait: vi.fn().mockResolvedValue(undefined),
    reportProvider: vi.fn(),
  };
  return { channel, deps, session, stateFile };
}

afterEach(() => { for (const path of temps.splice(0)) rmSync(path, { recursive: true, force: true }); });

describe("owner-approved itch.io purchase", () => {
  it.each([401, 503])("distinguishes Laso HTTP %d without opening checkout", async status => {
    const { channel, deps, session } = setup();
    const request = vi.fn<typeof fetch>(async () => new Response("provider error", { status }));
    const laso = createLasoCheckoutCard({ id: cardId, token: async () => "fixture", request });
    await createItchPurchase({ ...deps, laso })(channel);
    expect(channel.notify).toHaveBeenCalledExactlyOnceWith(expect.stringContaining(status === 401 ? "Сессия Laso истекла" : "Не удалось подтвердить в Laso"));
    expect(deps.open).not.toHaveBeenCalled();
    expect(session.complete).not.toHaveBeenCalled();
  });

  it("asks to reconnect if the Laso session expires after approval", async () => {
    const { channel, deps, session } = setup();
    deps.laso.read.mockReset().mockResolvedValueOnce(before).mockRejectedValueOnce(new LasoCheckoutAuthError());
    await createItchPurchase(deps)(channel);
    expect(channel.approve).toHaveBeenCalledOnce();
    expect(channel.notify).toHaveBeenCalledExactlyOnceWith(expect.stringMatching(/Сессия Laso истекла.*\/buy_itch/));
    expect(session.complete).not.toHaveBeenCalled();
  });

  it("asks for missing email and billing, pins the total, charges once, reconciles and delivers the verified ZIP", async () => {
    const { channel, deps, session, stateFile } = setup();
    deps.laso.read.mockReset()
      .mockResolvedValueOnce({ ...before, billing: { ...billing, city: "" } })
      .mockResolvedValueOnce({ ...before, card }).mockResolvedValue(after);
    channel.requestInput.mockResolvedValueOnce(billing.city);
    await createItchPurchase(deps)(channel);
    expect(channel.requestReceiptEmail).toHaveBeenCalledOnce();
    expect(channel.requestInput).toHaveBeenCalledExactlyOnceWith("billing_city");
    expect(deps.open).toHaveBeenCalledWith(expect.objectContaining({ billing, email: "test@example.com" }));
    expect(channel.approve).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ totalCents: 299, taxCents: 0, maxCents: 500 }));
    expect(session.complete).toHaveBeenCalledOnce();
    expect(channel.sendDocument).toHaveBeenCalledExactlyOnceWith(ITCH_PRODUCT.filename, zip);
    const stored = readFileSync(stateFile, "utf8");
    expect(JSON.parse(stored)).toMatchObject({ stage: "delivered", reconciled: true });
    for (const value of [privateUrl, card.number, "test@example.com", billing.street]) expect(stored).not.toContain(value);

    await createItchPurchase(deps)(channel);
    expect(session.complete).toHaveBeenCalledOnce();
    expect(channel.sendDocument).toHaveBeenCalledOnce();
  });

  it("uses configured email, stops on an over-limit quote and does not fetch credentials", async () => {
    const { channel, deps, session } = setup();
    deps.receiptEmail.mockReturnValue("configured@example.com");
    session.totalCents = 501;
    session.taxCents = 202;
    await createItchPurchase(deps)(channel);
    expect(channel.requestReceiptEmail).not.toHaveBeenCalled();
    expect(channel.approve).not.toHaveBeenCalled();
    expect(deps.laso.read).toHaveBeenCalledExactlyOnceWith(channel.signal);
    expect(session.complete).not.toHaveBeenCalled();
  });

  it("does not fetch credentials after a declined approval or pay after a changed balance", async () => {
    const { channel, deps, session } = setup();
    channel.approve.mockResolvedValueOnce(false);
    await createItchPurchase(deps)(channel);
    expect(deps.laso.read).toHaveBeenCalledTimes(1);
    deps.laso.read.mockReset().mockResolvedValueOnce(before).mockResolvedValueOnce({ ...before, balanceCents: 499, card });
    await createItchPurchase(deps)(channel);
    expect(session.complete).not.toHaveBeenCalled();
    expect(channel.sendDocument).not.toHaveBeenCalled();
  });

  it("recovers an ambiguous submission using the paid download key without reopening checkout", async () => {
    const { channel, deps, session, stateFile } = setup();
    vi.mocked(session.complete).mockImplementationOnce(async (_card, _signal, _receipt, submit) => {
      submit!();
      throw new ItchCheckoutError("payment_unconfirmed", true);
    });
    await createItchPurchase(deps)(channel);
    expect(JSON.parse(readFileSync(stateFile, "utf8")).stage).toBe("submitted");
    expect(channel.sendDocument).not.toHaveBeenCalled();
    await createItchPurchase(deps)(channel, "recover");
    expect(channel.approveDelivery).toHaveBeenCalledExactlyOnceWith(ITCH_PRODUCT.title);
    expect(channel.requestInput).toHaveBeenCalledExactlyOnceWith("purchase_link");
    expect(deps.resume).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ privateUrl }));
    expect(deps.open).toHaveBeenCalledOnce();
    expect(session.complete).toHaveBeenCalledOnce();
    expect(channel.sendDocument).toHaveBeenCalledOnce();
  });

  it("recovers a manual receipt with an expired Laso session, records delivery and later reconciles without resending", async () => {
    const { channel, deps, session, stateFile } = setup();
    deps.laso.read.mockReset().mockRejectedValue(new Error("expired"));
    const run = createItchPurchase(deps);
    await run(channel, "recover");
    expect(channel.approveDelivery).toHaveBeenCalledExactlyOnceWith(ITCH_PRODUCT.title);
    expect(channel.requestInput).toHaveBeenCalledExactlyOnceWith("purchase_link");
    expect(deps.resume).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ privateUrl }));
    expect(channel.sendDocument).toHaveBeenCalledExactlyOnceWith(ITCH_PRODUCT.filename, zip);
    expect(channel.notify).toHaveBeenLastCalledWith(expect.stringContaining("Списание Laso пока не подтверждено"));
    const stored = readFileSync(stateFile, "utf8");
    expect(JSON.parse(stored)).toMatchObject({ stage: "manual_delivered", reconciled: false, totalCents: 299 });
    expect(stored).not.toContain(privateUrl);

    deps.laso.read.mockResolvedValueOnce({ ...after, balanceCents: 200 }).mockResolvedValue(after);
    await run(channel, "buy");
    expect(JSON.parse(readFileSync(stateFile, "utf8")).reconciled).toBe(false);
    await run(channel, "recover");
    expect(JSON.parse(readFileSync(stateFile, "utf8")).reconciled).toBe(true);
    expect(channel.notify).toHaveBeenLastCalledWith(expect.stringContaining("Остаток $2.01"));
    expect(deps.laso.read.mock.calls.every(args => args.length === 1)).toBe(true);
    expect(deps.reportProvider).not.toHaveBeenCalled();
    expect(deps.open).not.toHaveBeenCalled();
    expect(session.complete).not.toHaveBeenCalled();
    expect(channel.approve).not.toHaveBeenCalled();
    expect(channel.sendDocument).toHaveBeenCalledOnce();
  });

  it("blocks automatic purchase and reupload when manual ZIP delivery is ambiguous", async () => {
    const { channel, deps, stateFile } = setup();
    const run = createItchPurchase(deps);
    channel.sendDocument.mockRejectedValueOnce(new Error("network timeout"));
    await run(channel, "recover");
    expect(JSON.parse(readFileSync(stateFile, "utf8")).stage).toBe("manual_delivery_pending");
    await run(channel, "recover");
    await run(channel, "buy");
    expect(channel.notify).toHaveBeenLastCalledWith(expect.stringContaining("скачай ZIP по ссылке из чека itch.io"));
    expect(channel.sendDocument).toHaveBeenCalledOnce();
    expect(deps.resume).toHaveBeenCalledOnce();
    expect(deps.open).not.toHaveBeenCalled();
  });

  it("allows recovery retry only after an explicit Telegram document rejection", async () => {
    const { channel, deps, stateFile } = setup();
    channel.sendDocument.mockRejectedValueOnce(new TelegramDocumentRejected());
    const run = createItchPurchase(deps);
    await run(channel, "recover");
    expect(JSON.parse(readFileSync(stateFile, "utf8")).stage).toBe("manual_delivery_retryable");
    await run(channel, "buy");
    expect(deps.open).not.toHaveBeenCalled();
    expect(channel.sendDocument).toHaveBeenCalledOnce();
    await run(channel, "recover");
    expect(channel.sendDocument).toHaveBeenCalledTimes(2);
    expect(JSON.parse(readFileSync(stateFile, "utf8")).stage).toBe("manual_delivered");
  });

  it("records a merchant receipt, blocks a corrupt ZIP and never resubmits on retry", async () => {
    const { channel, deps, session, stateFile } = setup();
    vi.mocked(session.complete).mockImplementationOnce(async (_card, _signal, receipt, submit) => {
      submit!();
      await receipt!({ receiptCents: 299, privateUrl });
      return { ...file, bytes: Buffer.from("invalid zip") };
    });
    await createItchPurchase(deps)(channel);
    expect(JSON.parse(readFileSync(stateFile, "utf8")).stage).toBe("receipted");
    expect(channel.sendDocument).not.toHaveBeenCalled();
    await createItchPurchase(deps)(channel);
    expect(deps.open).toHaveBeenCalledOnce();
    expect(channel.sendDocument).toHaveBeenCalledOnce();
  });

  it("records delivery while issuer data lags and reconciles on a subsequent invocation without redelivery", async () => {
    const { channel, deps, session, stateFile } = setup();
    deps.laso.read.mockResolvedValue(before);
    await createItchPurchase(deps)(channel);
    expect(deps.laso.refresh).toHaveBeenCalledOnce();
    expect(channel.sendDocument).toHaveBeenCalledOnce();
    expect(JSON.parse(readFileSync(stateFile, "utf8"))).toMatchObject({ stage: "delivered", reconciled: false });
    expect(deps.reportProvider.mock.calls).toEqual([
      [{ provider: "laso", operation: "card_checkout", status: "attempted" }],
    ]);
    const { providerSuccessId } = JSON.parse(readFileSync(stateFile, "utf8"));
    deps.laso.read.mockResolvedValue(after);
    await createItchPurchase(deps)(channel);
    expect(channel.sendDocument).toHaveBeenCalledOnce();
    expect(session.complete).toHaveBeenCalledOnce();
    expect(JSON.parse(readFileSync(stateFile, "utf8")).reconciled).toBe(true);
    expect(deps.reportProvider).toHaveBeenLastCalledWith(
      { provider: "laso", operation: "card_checkout", status: "succeeded" }, providerSuccessId,
    );
  });

  it("keeps Laso card credentials out of card summary and pins the origin, card and merchant", async () => {
    const request = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input));
      expect(url.origin).toBe("https://laso.finance");
      if (url.pathname === "/search-merchants") {
        expect(url.searchParams.get("q")).toBe("itch.io");
        return Response.json({ merchants: [{ name: "itch.io", status: "accepted" }] });
      }
      expect(url.searchParams.get("card_id")).toBe(cardId);
      return Response.json({ card_id: cardId, status: "ready", country: "US", usd_amount: 5,
        card_details: { card_number: card.number, exp_month: card.expMonth, exp_year: card.expYear, cvv: card.cvv, available_balance: 5 },
        transactions: [{ amount: -2.99, description: "ITCH.IO", is_credit: false }] });
    });
    const reportProvider = vi.fn();
    const laso = createLasoCheckoutCard({ id: cardId, token: async () => "fixture", request, reportProvider });
    const signal = new AbortController().signal;
    expect(await laso.accepted(signal)).toBe(true);
    expect(reportProvider).toHaveBeenCalledExactlyOnceWith({ provider: "laso", operation: "card_quote", status: "succeeded" });
    expect(await laso.read(signal)).toMatchObject({ balanceCents: 500, itchDebits: [299] });
    expect((await laso.read(signal)).card).toBeUndefined();
    expect((await laso.read(signal, true)).card).toEqual(card);
  });
});
