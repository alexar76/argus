import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createHudsonPurchase } from "../src/checkout/hudson-purchase.js";
import { LasoCheckoutAuthError } from "../src/checkout/laso-card.js";
import type { TelegramPurchaseChannel } from "../src/telegram/purchase.js";

const orderId = "fixtureOrder123";
const receiptSha256 = "b".repeat(64);
const filename = "hudson-link-ticket.pdf";
const bytes = Buffer.from(`%PDF-1.4\n${"x".repeat(100)}\nstartxref\n1\n%%EOF\n`);
const billing = { name: "Laso Finance", street: "Billing address", city: "Covina", state: "CA", postalCode: "91723", country: "US" };
const state = { balanceCents: 500, itchDebits: [], hudsonDebits: [], billing, last4: "1111" };

function setup(stateDir: string, scenario: "approved" | "declined" | "lost_reply" | "delivered") {
  const channel: TelegramPurchaseChannel = {
    signal: new AbortController().signal,
    requestReceiptEmail: vi.fn(async () => null),
    requestInput: vi.fn(async (field: string) => field.endsWith("first_name") ? "Alice" : "Martin"),
    approve: vi.fn(async () => scenario !== "declined"),
    approveDelivery: vi.fn(async () => true),
    sendDocument: vi.fn(async () => {}),
    notify: vi.fn(async () => {}),
  };
  let charged = scenario === "delivered";
  const laso = {
    merchantAcceptance: vi.fn(async () => "unknown" as const),
    read: vi.fn(async (_signal: AbortSignal, credentials = false) => ({ ...state,
      ...(charged ? { balanceCents: 225, hudsonDebits: [275] } : {}),
      ...(credentials ? { card: { number: "4111111111111111", expMonth: "01", expYear: "2029", cvv: "123" } } : {}),
    })),
    refresh: vi.fn(async () => {}),
  };
  const complete = vi.fn(async (_card, _billing, _passenger, beforeSubmit: () => void, _signal?: AbortSignal, recordOrder?: (id: string) => void) => {
    beforeSubmit();
    charged = true;
    recordOrder?.(orderId);
    if (scenario === "lost_reply") throw new Error("disconnected after submission");
    return { totalCents: 275 as const, filename: "Hudson-Link-Ticket.pdf" as const, bytes, receiptVerified: true };
  });
  const open = vi.fn(async () => ({ totalCents: 275 as const, complete, close: async () => {} }));
  const verifyReceipt = vi.fn(async () => receiptSha256);
  const run = createHudsonPurchase({ stateDir, cardId: "O-test-hudson", laso, open, browserWsEndpoint: () => "private",
    receiptEmail: () => "person@example.com", verifyReceipt, wait: async () => undefined });
  return { channel, laso, complete, open, run, verifyReceipt };
}

describe("Hudson Link owner ticket runner", () => {
  it.each(["merchant", "charge"] as const)("stops before submission when the Laso session expires at %s", async step => {
    const dir = mkdtempSync(join(tmpdir(), "argus-hudson-test-"));
    try {
      const { channel, laso, complete, run } = setup(dir, "approved");
      if (step === "merchant") laso.merchantAcceptance.mockRejectedValueOnce(new LasoCheckoutAuthError());
      else laso.read.mockResolvedValueOnce(state).mockRejectedValueOnce(new LasoCheckoutAuthError());
      await run(channel);
      expect(channel.approve).toHaveBeenCalledTimes(step === "merchant" ? 0 : 1);
      expect(complete).not.toHaveBeenCalled();
      expect(channel.notify).toHaveBeenLastCalledWith(expect.stringMatching(/Сессия Laso истекла.*\/buy_hudson/));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it.each(["approved", "declined", "lost_reply"] as const)("gates the charge and keeps restarts safe for %s", async scenario => {
    const dir = mkdtempSync(join(tmpdir(), "argus-hudson-test-"));
    try {
      const check = setup(dir, scenario);
      await check.run(check.channel);
      expect(check.channel.approve).toHaveBeenCalledWith(expect.objectContaining({ totalCents: 275, maxCents: 275, passengerName: "Alice Martin" }));
      expect(check.complete).toHaveBeenCalledTimes(scenario === "declined" ? 0 : 1);
      expect(check.laso.read.mock.calls.filter(call => call[1] === true)).toHaveLength(scenario === "declined" ? 0 : 1);
      expect(check.channel.sendDocument).toHaveBeenCalledTimes(scenario === "approved" ? 1 : 0);
      if (scenario === "approved") expect(check.channel.sendDocument).toHaveBeenCalledWith(filename, bytes);
      if (scenario === "lost_reply") expect(check.channel.notify).toHaveBeenCalledWith(expect.stringContaining("Повторное списание заблокировано"));
      if (scenario !== "declined") {
        const journal = JSON.parse(readFileSync(join(dir, "hudson-link-purchase.json"), "utf8"));
        expect(journal.merchantOrderId).toBe(orderId);
        if (scenario === "approved") expect(journal).toMatchObject({ stage: "delivered", receiptVerified: true, reconciled: true, receiptSha256 });
        const restored = setup(dir, "delivered");
        await restored.run(restored.channel);
        expect(restored.channel.approve).not.toHaveBeenCalled();
        expect(restored.complete).not.toHaveBeenCalled();
        expect(restored.channel.sendDocument).not.toHaveBeenCalled();
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("links and verifies a delivered legacy ticket without entering checkout", async () => {
    const dir = mkdtempSync(join(tmpdir(), "argus-hudson-test-"));
    try {
      const path = join(dir, "hudson-link-purchase.json");
      writeFileSync(path, JSON.stringify({ v: 1, id: "eeeeeeee-eeee-4eee-aeee-eeeeeeeeeeee", stage: "delivered",
        cardId: "O-test-hudson", beforeCents: 500, priorDebits: 0, reconciled: false, receiptVerified: false }), { mode: 0o600 });
      const check = setup(dir, "delivered");
      const ticketReference = "ABCD1234";
      await check.run(check.channel, { ticketUrl: `https://www.ridehudsonlink.com/tickets?order_id=${orderId}`, ticketReference });
      expect(check.verifyReceipt).toHaveBeenCalledWith(expect.objectContaining({ orderId, ticketReference, last4: "1111" }));
      expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({ stage: "delivered", merchantOrderId: orderId,
        receiptVerified: true, reconciled: true, receiptSha256 });
      await check.run(check.channel);
      expect(check.verifyReceipt).toHaveBeenCalledOnce();
      expect(check.open).not.toHaveBeenCalled();
      expect(check.channel.approve).not.toHaveBeenCalled();
      expect(check.channel.sendDocument).not.toHaveBeenCalled();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
