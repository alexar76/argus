import { describe, expect, it, vi } from "vitest";
import { TelegramBot } from "../src/telegram/bot.js";
import { TelegramMail, type MailKeyboard } from "../src/telegram/mail.js";
import { Agent } from "../src/core/agent.js";
import { loadConfig } from "../src/config.js";
import type { MailSettings } from "../src/mail/index.js";
import type { ProviderRouter } from "../src/providers/router.js";
import { createLogger } from "../src/logger.js";
import { makeApprover } from "../src/cli/util.js";

function setup() {
  const settings: MailSettings = {
    accountId: "owner-mailbox", auth: "password", username: "owner@example.com", email: "owner@example.com",
    provider: "Test", source: "manual", incoming: { protocol: "imap", host: "imap.example.com", port: 993 },
    outgoing: { host: "smtp.example.com", port: 465 }, permissions: { read: true, otp: false, send: true },
  };
  const message = {
    id: "provider-id", from: "customer@example.net", subject: "Invoice", date: "2026-11-12T20:00:00Z",
    text: "Can you send me a status update?", messageId: "<invoice@example.net>",
  };
  const mail = {
    settings: vi.fn(() => settings),
    setPermissions: vi.fn((patch: Partial<MailSettings["permissions"]>, accountId?: string) => {
      if (accountId && accountId !== settings.accountId) throw new Error("mailbox changed");
      Object.assign(settings.permissions, patch);
      return settings;
    }),
    list: vi.fn(async () => [message]), read: vi.fn(async () => message),
    send: vi.fn(async ({ accountId }: { accountId?: string }) => {
      if (accountId !== settings.accountId || !settings.permissions.send) throw new Error("mailbox changed");
    }),
  };
  const send = vi.fn(async (_text: string, _keyboard?: MailKeyboard) => {});
  function action(label: string): string {
    const result = send.mock.lastCall?.[1]?.flat().find(([name]) => name.startsWith(label));
    if (!result) throw new Error(`missing ${label} action`);
    return result[1];
  }
  return { settings, message, mail, send, action };
}

describe("Telegram mail", () => {
  it.each([false, true])("keeps inbox closed in verification-only mode and enables read independently (Graph: %s)", async (graph) => {
    const { settings, mail, send, action } = setup();
    if (graph) Object.assign(settings, { graph: true, incoming: undefined, outgoing: undefined, auth: "microsoft-oauth" });
    settings.permissions = { read: false, otp: true, send: false };
    const ui = new TelegramMail(mail);
    await ui.command("/mail_inbox", send);
    expect(mail.list).not.toHaveBeenCalled();
    await ui.command("/mail_settings", send);
    expect(send.mock.lastCall?.[0]).toContain("On · Retrieve a matching verification code");
    await ui.action(action("Enable read"), send);
    expect(settings.permissions).toEqual({ read: true, otp: true, send: false });
    await ui.command("/mail_inbox", send);
    expect(mail.list).toHaveBeenCalledWith(8, "owner-mailbox");
  });

  it("sends only the previewed recipient and body once, after exact confirmation", async () => {
    const { mail, send, action } = setup();
    const ui = new TelegramMail(mail);
    await ui.command("/mail_inbox", send);
    const ref = action("Invoice").split(":").at(-1);
    await ui.command(`/mail_reply ${ref} I will send an update tomorrow.`, send);
    expect(send.mock.lastCall?.[0]).toContain("To: customer@example.net\nSubject: Re: Invoice");
    const confirmation = action("Send this reply");
    await ui.action("mail:send:made-up", send);
    expect(mail.send).not.toHaveBeenCalled();
    await Promise.all([ui.action(confirmation, send), ui.action(confirmation, send)]);
    await ui.action(confirmation, send);
    expect(mail.send).toHaveBeenCalledExactlyOnceWith({
      accountId: "owner-mailbox", to: "customer@example.net", subject: "Re: Invoice",
      text: "I will send an update tomorrow.", inReplyTo: "<invoice@example.net>",
    });
  });

  it("does not reuse a pending reply after a mailbox change", async () => {
    const { settings, mail, send, action } = setup();
    const ui = new TelegramMail(mail);
    await ui.command("/mail_inbox", send);
    await ui.command(`/mail_reply ${action("Invoice").split(":").at(-1)} Original message`, send);
    const confirmation = action("Send this reply");
    settings.accountId = "new-mailbox";
    await ui.action(confirmation, send);
    expect(send.mock.lastCall?.[0]).not.toContain("accepted by");
  });

  it("requires a separate provider confirmation for draft generation and never gives the model tools", async () => {
    const { mail, send, action } = setup();
    const chat = vi.fn(async () => ({ content: "I will share an update.", toolCalls: [], stopReason: "stop" }));
    const router = {
      available: true,
      resolveTier: () => ({ provider: { id: "test-provider", chat }, modelId: "test-model" }),
    } as unknown as ProviderRouter;
    const ui = new TelegramMail(mail, router);
    await ui.command("/mail_inbox", send);
    const ref = action("Invoice").split(":").at(-1);
    await ui.command(`/mail_draft ${ref} Be brief`, send);
    expect(chat).not.toHaveBeenCalled();
    expect(send.mock.lastCall?.[0]).toContain("share the selected email subject and an excerpt");
    await ui.action(action("Share and draft"), send);
    expect(chat).toHaveBeenCalledTimes(1);
    expect(chat.mock.lastCall?.[0]).not.toHaveProperty("tools");
    expect(mail.send).not.toHaveBeenCalled();
    expect(send.mock.lastCall?.[0]).toContain("I will share an update.");
  });

  it("keeps mailbox commands and callbacks inside the owner's private chat", async () => {
    const { mail } = setup();
    const bot = new TelegramBot({
      token: "test", agent: { run: vi.fn() } as unknown as Agent, stateDir: ".",
      ownerId: 123, mail, log: createLogger("test", "error"),
    });
    const api = vi.spyOn(bot as any, "api").mockResolvedValue(undefined);
    await bot["onMessage"]({ message_id: 1, from: { id: 123 }, chat: { id: -50, type: "group" }, text: "/mail_inbox" });
    await bot["onCallback"]({ id: "bystander", from: { id: 456 }, message: { message_id: 2, chat: { id: 456, type: "private" } }, data: "mail:inbox" });
    expect(mail.list).not.toHaveBeenCalled();
    await bot["onCallback"]({ id: "owner", from: { id: 123 }, message: { message_id: 3, chat: { id: 123, type: "private" } }, data: "mail:inbox" });
    expect(mail.list).toHaveBeenCalledTimes(1);
    expect(api).toHaveBeenCalledWith("sendMessage", expect.objectContaining({
      chat_id: 123, link_preview_options: { is_disabled: true }, reply_markup: { inline_keyboard: expect.any(Array) },
    }));
  });

  it("shows full purchase arguments and binds approval to the private owner button", async () => {
    const { mail } = setup();
    const bot = new TelegramBot({
      token: "test", agent: { run: vi.fn() } as unknown as Agent, stateDir: ".",
      ownerId: 123, mail, log: createLogger("test", "error"),
    });
    const api = vi.spyOn(bot as any, "api").mockImplementation(async (method: unknown) =>
      method === "getChat" ? { type: "private", id: 123 } : undefined);
    const summary = `${"terms ".repeat(70)}maximum USD 10.00`;
    const decision = bot.approver({ tool: "travel_book_approve", args: { offerId: "test-offer", summary } });
    try {
      await vi.waitFor(() => expect(bot["pendingApproval"]).toBeTruthy());
      const [, prompt] = api.mock.calls.find(([method]) => method === "sendMessage") ?? [];
      const approval = (prompt as any).reply_markup.inline_keyboard[0][0].callback_data;
      expect(prompt).toMatchObject({ text: expect.stringContaining(summary), link_preview_options: { is_disabled: true } });
      await bot["onMessage"]({ message_id: 1, from: { id: 123 }, chat: { id: 123, type: "private" }, text: "/yes" });
      await bot["onCallback"]({ id: "group", from: { id: 123 }, message: { message_id: 2, chat: { id: -10, type: "group" } }, data: approval });
      expect(bot["pendingApproval"]).toBeTruthy();
      await bot["onCallback"]({ id: "owner", from: { id: 123 }, message: { message_id: 3, chat: { id: 123, type: "private" } }, data: approval });
      await expect(decision).resolves.toBe(true);
      await expect(bot.approver({ tool: "cmc_buy_quotes", args: { symbols: "x".repeat(3000) } })).resolves.toBe(false);
    } finally {
      bot.stop();
    }
    if (!process.stdin.isTTY) await expect(makeApprover(true)({ tool: "cmc_buy_quotes", args: {} })).resolves.toBe(false);
  });

  it.each(["cmc_buy_quotes", "tavily_buy_search", "laso_buy_card"])("executes %s only after the private owner's exact button", async (toolName) => {
    const { config } = loadConfig();
    config.warden.sensitiveToolPatterns = [];
    const log = createLogger("telegram-owner-approval-test", "error");
    const args = { fixture: "exact" };
    const pay = vi.fn(async () => ({ ok: true, content: "Fixture paid" }));
    const router = {
      resolveTier: () => ({ provider: { id: "local-fixture" } }),
      chat: async (_tier: string, request: { messages: { role: string; content: string }[] }) => {
        const last = request.messages.at(-1);
        const usage = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 };
        if (last?.role === "tool") return { toolCalls: [], content: last.content, usage };
        return { toolCalls: [{ id: "fixture", name: toolName, arguments: args }], content: "", usage };
      },
    } as unknown as ProviderRouter;
    const memory = { recall: async () => [], addEpisode: async () => {} } as unknown as ConstructorParameters<typeof Agent>[0]["memory"];
    const agent = new Agent({ config, router, memory, log, tools: [{ source: { kind: "builtin" },
      def: { name: toolName, description: "Fixture", inputSchema: { type: "object" } }, run: pay }] });
    const direct = await agent.run("Buy the fixture");
    expect(direct.answer).toContain("user did not approve");
    expect(pay).not.toHaveBeenCalled();

    const bot = new TelegramBot({ token: "fixture", agent, stateDir: ".", ownerId: 123, log });
    const api = vi.spyOn(bot as any, "api").mockResolvedValue(undefined);
    const message = (id: number, text: string) => bot["onMessage"]({ message_id: 1, from: { id }, chat: { id, type: "private" }, text });
    await message(456, "Buy the fixture");
    const task = message(123, "Buy the fixture");
    try {
      await vi.waitFor(() => expect(bot["pendingApproval"]).toBeTruthy());
      const [, prompt] = api.mock.calls.find(([method, p]) => method === "sendMessage" && (p as any).reply_markup) ?? [];
      const approval = (prompt as any).reply_markup.inline_keyboard[0][0].callback_data;
      expect(prompt).toMatchObject({ text: expect.stringContaining(JSON.stringify(args)), link_preview_options: { is_disabled: true } });
      const callback = (id: number, type: string, data = approval) => bot["onCallback"]({ id: "test-callback", from: { id }, message: { message_id: 2, chat: { id, type } }, data });
      await message(123, "/yes");
      await callback(123, "group");
      await callback(456, "private");
      expect(pay).not.toHaveBeenCalled();
      await callback(123, "private");
      await callback(123, "private");
      await task;
      expect(pay).toHaveBeenCalledExactlyOnceWith(args, expect.objectContaining({ approved: true }));
    } finally {
      bot.stop();
    }
  });

  it("disables URL previews for sensitive owner notes and rejects a nonprivate destination", async () => {
    const { mail } = setup();
    const bot = new TelegramBot({
      token: "test", agent: { run: vi.fn() } as unknown as Agent, stateDir: ".",
      ownerId: 123, mail, log: createLogger("test", "error"),
    });
    const api = vi.spyOn(bot as any, "api").mockResolvedValue({ type: "group", id: 123 });
    const note = { text: "Order accepted", copyable: "https://example.com/single-use" };
    await expect(bot["toOwner"](note)).rejects.toThrow("private Telegram owner chat");
    expect(api).toHaveBeenCalledExactlyOnceWith("getChat", { chat_id: 123 });
    api.mockResolvedValue({ type: "private", id: 123 });
    await bot["toOwner"](note);
    const deliveries = api.mock.calls.filter(([method]) => method === "sendMessage");
    expect(deliveries).toHaveLength(2);
    expect(deliveries.every(([, params]) => (params as any).link_preview_options.is_disabled)).toBe(true);
  });
});
