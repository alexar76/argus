import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { expect, it, vi } from "vitest";
import { externalBasePayment, externalBrowserbasePayment, externalTavilyPayment, CMC_QUOTES } from "../src/economy/external-payment.js";
import { createLogger } from "../src/logger.js";
import { buildCoinMarketCapTool } from "../src/tools/cmc.js";
import { buildLasoCardTools } from "../src/tools/laso.js";

const log = createLogger("assistant-payment-test", "error");
const asset = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const payTo = "0x1111111111111111111111111111111111111111";
const anotherPayee = "0x2222222222222222222222222222222222222222";
const tx = `0x${"c".repeat(64)}`;
const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64");

function gateway({ version, resource, recipient = payTo, units = "10000" }: { version: 1 | 2; resource: string; recipient?: string; units?: string }) {
  const key = generatePrivateKey();
  const payer = privateKeyToAccount(key).address;
  const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
    const headers = new Headers(init?.headers);
    const credential = headers.get(version === 1 ? "x-payment" : "payment-signature");
    const network = version === 1 ? "base" : "eip155:8453";
    expect(init?.redirect).toBe("error");
    if (!credential) {
      const terms = { scheme: "exact", network, asset, payTo: recipient, maxTimeoutSeconds: 60, extra: { name: "USD Coin", version: "2" } };
      if (version === 1) return Response.json({ x402Version: 1, accepts: [{ ...terms, maxAmountRequired: units, resource }] }, { status: 402 });
      return Response.json({}, { status: 402, headers: { "payment-required": encode({ x402Version: 2, resource: { url: resource }, accepts: [{ ...terms, amount: units }] }) } });
    }
    const payload = JSON.parse(Buffer.from(credential, "base64").toString("utf8"));
    expect(payload.x402Version).toBe(version);
    expect(payload.payload.authorization.from.toLowerCase()).toBe(payer.toLowerCase());
    expect(payload.payload.authorization.to.toLowerCase()).toBe(recipient);
    expect(payload.payload.authorization.value).toBe(units);
    expect(payload.payload.signature).toMatch(/^0x[a-f0-9]{130}$/i);
    const header = version === 1 ? "x-payment-response" : "payment-response";
    return Response.json({ ok: true }, { headers: { [header]: encode({ success: true, payer, network, transaction: tx }) } });
  });
  return { key, fetch };
}

it("accepts the fixed CoinMarketCap GET resource, keeps its query and pins the payee", async () => {
  const url = `${CMC_QUOTES}?id=1,1027`;
  const { key, fetch } = gateway({ version: 2, resource: CMC_QUOTES });
  const pay = externalBasePayment(() => key, fetch);
  await expect(pay({ url, method: "GET", maxUsd: 0.01, expectedPayTo: anotherPayee })).rejects.toThrow("no exact Base USDC offer");
  expect(fetch).toHaveBeenCalledTimes(1);
  await expect(pay({ url, method: "GET", maxUsd: 0.009, expectedPayTo: payTo })).rejects.toThrow("no exact Base USDC offer");
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(await pay({ url, method: "GET", maxUsd: 0.01, expectedPayTo: payTo })).toMatchObject({ transaction: tx, amountUsd: 0.01 });
  expect(fetch.mock.calls.map(([arg, init]) => [String(arg), init?.method])).toEqual(Array.from({ length: 4 }, () => [url, "GET"]));
});

it("binds rotating payees to the designated first-party Browserbase and Tavily routes", async () => {
  const browser = "https://x402.browserbase.com/browser/session/create";
  const tavily = "https://x402.tavily.com/search";
  const first = gateway({ version: 1, resource: browser, recipient: anotherPayee });
  const second = gateway({ version: 2, resource: tavily });
  const browserPay = externalBrowserbasePayment(() => first.key, first.fetch);
  const tavilyPay = externalTavilyPayment(() => second.key, second.fetch);
  expect(() => browserPay({ url: `${browser}/elsewhere`, maxUsd: 0.01 })).toThrow();
  expect(() => tavilyPay({ url: tavily, maxUsd: 0.02 })).toThrow();
  expect(await browserPay({ url: browser, maxUsd: 0.01, body: { estimatedMinutes: 5 } })).toMatchObject({ transaction: tx });
  expect(await tavilyPay({ url: tavily, maxUsd: 0.01, body: { query: "test" } })).toMatchObject({ transaction: tx });
  expect(first.fetch).toHaveBeenCalledTimes(2);
  expect(second.fetch).toHaveBeenCalledTimes(2);
});

it("formats CoinMarketCap's v3 array schema and requires consent before buying", async () => {
  const pay = vi.fn(async () => ({ transaction: tx, amountUsd: 0.01, body: { status: { error_code: "0" }, data: [
    { id: 1, quote: [{ symbol: "USD", price: 125, last_updated: "2026-11-12T12:00:00Z" }] },
  ] } }));
  const reportProvider = vi.fn();
  const tool = buildCoinMarketCapTool(pay, payTo, reportProvider);
  expect((await tool.run({ ids: [1] }, { log })).ok).toBe(false);
  expect(pay).not.toHaveBeenCalled();
  expect(reportProvider).not.toHaveBeenCalled();
  const result = await tool.run({ ids: [1, 1] }, { log, approved: true });
  expect(pay).toHaveBeenCalledWith({ url: `${CMC_QUOTES}?id=1`, method: "GET", maxUsd: 0.01, expectedPayTo: payTo });
  expect(result).toMatchObject({ ok: true, content: expect.stringContaining('"usd":125') });
  expect((await tool.run({ ids: [1, 2] }, { log, approved: true })).ok).toBe(false);
  expect(reportProvider.mock.calls).toEqual([
    [{ provider: "coinmarketcap", operation: "quotes", status: "succeeded" }],
    [{ provider: "coinmarketcap", operation: "quotes", status: "failed" }],
  ]);
});

it("previews a Laso card for the allowed merchant and sends the private dashboard link only to the owner", async () => {
  const link = "https://laso.finance/agent/dashboard/auth?code=one-time-test";
  const fetch = vi.fn<typeof globalThis.fetch>(async (input) => new URL(String(input)).pathname === "/search-merchants"
    ? Response.json({ merchants: [{ name: "Example Store", status: "accepted" }] }) : Response.json({ auth_url: link }));
  const pay = vi.fn(async () => ({ transaction: tx, amountUsd: 5, body: { card: { card_id: "card_test", status: "pending", card_number: "sensitive" }, auth: { id_token: "private-token" } } }));
  const notify = vi.fn(async () => true);
  const reportProvider = vi.fn();
  const [quote, buy] = buildLasoCardTools({ pay, token: () => "operator-token", merchant: "Example Store", maxCents: 500, fetch, notify, hasOwnerChannel: () => true, reportProvider });
  const prepared = await quote!.run({ checkoutCents: 500 }, { log });
  const [, quoteId, summary] = /^Prepared (\S+)\. For laso_buy_card use this exact summary: (.*?)\. The owner/.exec(prepared.content)!;
  expect((await buy!.run({ quoteId, summary }, { log })).ok).toBe(false);
  expect(pay).not.toHaveBeenCalled();
  const purchased = await buy!.run({ quoteId, summary }, { log, approved: true });
  expect(purchased.ok).toBe(true);
  expect(pay).toHaveBeenCalledWith(expect.objectContaining({ maxUsd: 5, exactUsd: 5, method: "GET" }));
  expect(notify).toHaveBeenCalledWith(expect.objectContaining({ copyable: link }));
  expect(purchased.content).not.toMatch(/private-token|sensitive|one-time-test/);
  expect((await buy!.run({ quoteId, summary }, { log, approved: true })).ok).toBe(false);
  expect(pay).toHaveBeenCalledTimes(1);
  expect(reportProvider.mock.calls).toEqual([
    [{ provider: "laso", operation: "card_quote", status: "succeeded" }],
    [{ provider: "laso", operation: "card_issue", status: "succeeded" }],
  ]);
});

it("signs the approved five-dollar Laso quote and rejects a higher quote", async () => {
  const url = "https://laso.finance/get-card?amount=5.00";
  const request = { url, method: "GET" as const, maxUsd: 5, exactUsd: 5, expectedPayTo: payTo };
  const accepted = gateway({ version: 2, resource: url, units: "5000000" });
  const higher = gateway({ version: 2, resource: url, units: "5000001" });
  await expect(externalBasePayment(() => accepted.key, accepted.fetch)(request)).resolves.toMatchObject({
    transaction: tx, amountUsd: 5,
  });
  await expect(externalBasePayment(() => higher.key, higher.fetch)(request)).rejects.toThrow("no exact Base USDC offer");
  expect(accepted.fetch).toHaveBeenCalledTimes(2);
  expect(higher.fetch).toHaveBeenCalledTimes(1);
});
