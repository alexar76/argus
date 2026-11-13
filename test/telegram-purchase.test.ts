import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Agent } from "../src/core/agent.js";
import { createLogger } from "../src/logger.js";
import { TelegramBot, type TelegramBotOptions } from "../src/telegram/bot.js";

const OWNER = 42;
const PRIVATE = { id: OWNER, type: "private" };
const GROUP = { id: -1, type: "group" };
const PRODUCT = "https://aiimperium.itch.io/co-working-startup-office-icon-pack";
const LINK = `${PRODUCT}/download/secret-token`;
const EMAIL = "private-owner@example.com";
const ZIP = Uint8Array.from([0x50, 0x4b, 5, 6, ...Array<number>(18).fill(0)]);

function setup(purchase?: TelegramBotOptions["purchase"], options?: { stateDir: string; ownerId?: number }) {
  const run = vi.fn();
  const log = createLogger("telegram-purchase-test", "error");
  const bot = new TelegramBot({ token: "test", agent: { run } as unknown as Agent, log, purchase, ...(options ?? { ownerId: OWNER, stateDir: "." }) });
  const api = vi.spyOn(bot as unknown as { api: (method: string, params: unknown, timeoutMs?: number) => Promise<unknown> }, "api")
    .mockImplementation(async (method) => method === "sendMessage" ? { message_id: 100 + api.mock.calls.length } : true);

  function message(text: string, options: { user?: number; chat?: typeof PRIVATE; reply?: { message_id: number; text?: string } } = {}) {
    return bot["onMessage"]({ text, message_id: 1, from: { id: options.user ?? OWNER }, chat: options.chat ?? PRIVATE, reply_to_message: options.reply });
  }

  function callback(data: string, messageId: number, chat = PRIVATE, user = OWNER) {
    return bot["onCallback"]({ id: "test", from: { id: user }, data, message: { chat, message_id: messageId } });
  }

  function prompts() {
    return api.mock.calls.flatMap(([method, params], index) => {
      if (method !== "sendMessage" || typeof params !== "object" || !params || !("reply_markup" in params)) return [];
      return [{ id: 101 + index, params: params as { text: string; reply_markup: { inline_keyboard?: { callback_data: string }[][]; force_reply?: boolean } } }];
    });
  }

  return { bot, api, run, message, callback, prompts };
}

describe("private Telegram purchase", () => {
  it("accepts the owner's exact private replies and approval once, then uploads the ZIP only to that owner", async () => {
    const checkout = vi.fn();
    const { api, run, message, callback, prompts } = setup(async (channel) => {
      const email = await channel.requestReceiptEmail();
      expect(email).toBe(EMAIL);
      await expect(channel.requestReceiptEmail()).resolves.toBeNull();
      await expect(channel.sendDocument("icons.zip", ZIP)).rejects.toThrow("unavailable");
      expect(await channel.approve({ title: "Icon Pack", merchant: "itch.io", totalCents: 335, taxCents: 36, receiptEmail: email!, itemUrl: PRODUCT })).toBe(true);
      checkout();
      expect(await channel.requestInput("purchase_link")).toBe(LINK);
      await expect(channel.sendDocument("../icons.zip", ZIP)).rejects.toThrow("Invalid purchase ZIP");
      await expect(channel.sendDocument("icons.zip", new Uint8Array(22))).rejects.toThrow("Invalid purchase ZIP");
      await channel.sendDocument("icons.zip", ZIP);
      await expect(channel.sendDocument("icons.zip", ZIP)).rejects.toThrow("unavailable");
      await channel.notify("Purchase complete.");
    });

    await message("/buy_itch", { chat: GROUP });
    await message("/buy_itch@argus_test_bot", { chat: GROUP });
    await message("купи иконки", { user: 43, chat: { id: 43, type: "private" } });
    expect(prompts()).toEqual([]);
    const operation = message("buy the icons");
    const emailPrompt = prompts()[0];
    expect(emailPrompt.params.reply_markup.force_reply).toBe(true);
    await message("/buy_itch");
    await message(EMAIL, { reply: { message_id: emailPrompt.id - 1 } });
    await message(EMAIL, { reply: { message_id: emailPrompt.id }, chat: GROUP });
    await message("bad-address", { reply: { message_id: emailPrompt.id } });
    expect(prompts()).toHaveLength(1);
    await message(EMAIL, { reply: { message_id: emailPrompt.id } });

    await vi.waitFor(() => expect(prompts()).toHaveLength(2));
    const approval = prompts()[1];
    expect(approval.params.text).toContain("Total · $3.35 USD");
    expect(approval.params.text).toContain("Included tax · $0.36 USD");
    expect(approval.params.text).toContain("Maximum · $5.00 USD");
    expect(approval.params.text).toContain("p…@example.com");
    expect(approval.params.text).toContain(PRODUCT);
    const yes = approval.params.reply_markup.inline_keyboard![0][0].callback_data;
    await message("/yes");
    await callback(yes, approval.id, GROUP);
    await callback(yes, approval.id, PRIVATE, 43);
    await callback(yes, approval.id - 1);
    expect(checkout).not.toHaveBeenCalled();
    await Promise.all([callback(yes, approval.id), callback(yes, approval.id)]);

    await vi.waitFor(() => expect(prompts()).toHaveLength(3));
    const linkPrompt = prompts()[2];
    await message("https://itch.io.example.net/private", { reply: { message_id: linkPrompt.id } });
    await message(LINK, { reply: { message_id: linkPrompt.id } });
    await operation;
    await callback(yes, approval.id);
    await message(EMAIL, { reply: { message_id: emailPrompt.id, text: emailPrompt.params.text } });
    await message(LINK);
    await message(LINK, { chat: GROUP });
    expect(checkout).toHaveBeenCalledTimes(1);
    expect(run).not.toHaveBeenCalled();
    const uploads = api.mock.calls.filter(([method]) => method === "sendDocument");
    expect(uploads).toHaveLength(1);
    const form = uploads[0][1] as FormData;
    expect(form.get("chat_id")).toBe(String(OWNER));
    const document = form.get("document") as File;
    expect(document.name).toBe("icons.zip");
    expect(document.type).toBe("application/zip");
    expect(new Uint8Array(await document.arrayBuffer())).toEqual(ZIP);
    expect(JSON.stringify(api.mock.calls)).not.toContain(EMAIL);
    expect(JSON.stringify(api.mock.calls)).not.toContain(LINK);
    expect(JSON.stringify(api.mock.calls)).toContain("Purchase complete.");
  });

  it("requires a separate delivery-only confirmation before recovering a previous purchase", async () => {
    const recovered = vi.fn();
    const { api, message, prompts, callback } = setup(async (channel, intent) => {
      expect(intent).toBe("recover");
      expect(await channel.requestInput("purchase_link")).toBeNull();
      expect(await channel.approveDelivery("Icon Pack")).toBe(true);
      expect(await channel.approve({ title: "Icon Pack", merchant: "itch.io", totalCents: 299, receiptEmail: EMAIL })).toBe(false);
      expect(await channel.requestInput("purchase_link")).toBe(LINK);
      await channel.sendDocument("icons.zip", ZIP);
      recovered();
    });

    await message("/recover_itch", { chat: GROUP });
    await message("/recover_itch@argus_test_bot", { chat: GROUP });
    await message("получи иконки", { user: 43, chat: { id: 43, type: "private" } });
    expect(prompts()).toEqual([]);
    const operation = message("получи иконки");
    await vi.waitFor(() => expect(prompts()).toHaveLength(1));
    const approval = prompts()[0];
    expect(approval.params.text).toContain("Оплаты не будет.");
    await callback(approval.params.reply_markup.inline_keyboard![0][0].callback_data, approval.id);
    await vi.waitFor(() => expect(prompts()).toHaveLength(2));
    await message(LINK, { reply: { message_id: prompts()[1].id } });
    await operation;
    expect(recovered).toHaveBeenCalledTimes(1);
    expect(api.mock.calls.filter(([method]) => method === "sendDocument")).toHaveLength(1);
  });

  it("aborts pending sensitive input with /cancel and stop", async () => {
    const { bot, message, prompts, run } = setup(async (channel) => {
      await expect(channel.requestInput("billing_country")).resolves.toBeNull();
      expect(channel.signal.aborted).toBe(true);
    });
    const first = message("/buy_itch");
    await message("/cancel");
    await first;
    const second = message("купи иконки");
    bot.stop();
    await second;
    expect(prompts()).toHaveLength(2);
    expect(run).not.toHaveBeenCalled();
  });

  it("rejects an over-budget approval and keeps a disabled purchase out of model context", async () => {
    const enabled = setup(async (channel) => {
      await expect(channel.approve({ title: "Icon Pack", merchant: "itch.io", totalCents: 501, receiptEmail: EMAIL })).resolves.toBe(false);
    });
    await enabled.message("/buy_itch");
    expect(enabled.prompts()).toHaveLength(0);
    expect(enabled.run).not.toHaveBeenCalled();

    const disabled = setup();
    await disabled.message("/buy_itch");
    expect(disabled.run).not.toHaveBeenCalled();
  });

  it("does not enable purchases for a stored first claimant without an explicit owner pin", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "argus-telegram-purchase-"));
    try {
      writeFileSync(join(stateDir, "telegram-owner.json"), JSON.stringify({ ownerId: OWNER }));
      const purchase = vi.fn(async () => {});
      const { api, message, run } = setup(purchase, { stateDir });
      await message("/buy_itch");
      expect(purchase).not.toHaveBeenCalled();
      expect(run).not.toHaveBeenCalled();
      expect(api.mock.lastCall?.[1]).toMatchObject({ text: "Purchases are unavailable in this ARGUS instance." });
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });
});
