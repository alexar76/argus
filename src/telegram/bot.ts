import { fetchNoRedirect } from "../credential-fetch.js";
import { randomBytes } from "node:crypto";
import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import type { Logger, MeterSnapshot } from "../types.js";
import type { Agent, ApprovalRequest, ChatTurn } from "../core/agent.js";
import { MAX_EXACT_APPROVAL_LENGTH, renderApprovalArgs, requiresExactApproval } from "../core/approval-preview.js";
import type { ArenaStats } from "../arena/arena.js";
import { renderAsciiCard } from "../arena/card.js";
import { retryOwnerNotes, setOwnerSink, type OwnerNote } from "../channels/owner-notify.js";
import { MailService } from "../mail/index.js";
import type { ProviderRouter } from "../providers/router.js";
import { isMailCommand, TelegramMail, type MailKeyboard } from "./mail.js";
import { purchaseCommand, isPurchaseInputPrompt, isPurchaseLink, TelegramDocumentRejected, TelegramPurchase, type TelegramPurchaseChannel, type TelegramPurchaseIntent } from "./purchase.js";

export interface TelegramBotOptions {
  token: string;
  agent: Agent;
  stateDir: string;
  log: Logger;
  /** If set, ONLY this Telegram user id may command the bot. Overrides TOFU. */
  ownerId?: number;
  /** Agent Arena — enables the /flex command. */
  arena?: { stats(): Promise<ArenaStats> };
  mail?: Pick<MailService, "settings" | "setPermissions" | "list" | "read" | "send">;
  mailModels?: ProviderRouter;
  purchase?: (channel: TelegramPurchaseChannel, intent: TelegramPurchaseIntent) => Promise<void>;
}

interface TgUser { id: number; username?: string; first_name?: string }
interface TgMessage { message_id: number; from?: TgUser; chat: { id: number; type: string }; text?: string; reply_to_message?: { message_id: number; text?: string } }
interface TgCallback { id: string; from: TgUser; message?: TgMessage; data?: string }
interface TgUpdate { update_id: number; message?: TgMessage; callback_query?: TgCallback }

const API = "https://api.telegram.org";
const MAX_MSG = 4000;
/** Max prior user+assistant turns kept per chat (multi-turn context). */
const MAX_CHAT_TURNS = 8;

/**
 * Telegram interface with OWNER-GATING BAKED IN.
 *
 * Only the owner may command the bot. The owner is bound trust-on-first-use:
 * the first user to /start claims the bot (mirrors the ecosystem's Hermes lock),
 * persisted to disk. Every other user is rejected. An explicit
 * ARGUS_TELEGRAM_OWNER_ID overrides TOFU. Sensitive tools trigger an in-chat
 * approval the owner must confirm with /yes before the tool runs.
 */
export class TelegramBot {
  private offset = 0;
  private ownerId: number | null;
  private verifiedOwnerChat: number | null = null;
  private busy = false;
  private purchase: TelegramPurchase | undefined;
  private pendingApproval: { resolve: (ok: boolean) => void; token?: string; timeout: ReturnType<typeof setTimeout> } | null = null;
  private stopped = false;
  private readonly ownerFile: string;
  private readonly mail: TelegramMail;
  /** Per-chat prior turns so short follow-ups ("да", "проверь") keep context. */
  private readonly chatHistory = new Map<number, ChatTurn[]>();

  constructor(private readonly o: TelegramBotOptions) {
    this.ownerFile = join(o.stateDir, "telegram-owner.json");
    if (o.ownerId !== undefined && !isUserId(o.ownerId)) throw new Error("Telegram owner must be a positive user ID");
    this.ownerId = o.ownerId ?? this.loadOwner();
    this.mail = new TelegramMail(o.mail ?? new MailService(o.stateDir), o.mailModels);
  }

  /** Approval callback to wire into the Agent for sensitive tools. */
  approver = async (req: ApprovalRequest): Promise<boolean> => {
    if (this.ownerId == null || this.pendingApproval || this.purchase || this.stopped) return false;
    const where = req.server ? ` (server ${req.server})` : "";
    const exact = requiresExactApproval(req.tool);
    const raw = renderApprovalArgs(req.args);
    if (exact && raw.length > MAX_EXACT_APPROVAL_LENGTH) return false;
    const token = exact ? randomBytes(12).toString("hex") : undefined;
    try {
      const message = `⚠ Approve sensitive tool "${req.tool}"${where}?\nargs: ${exact ? raw : truncate(raw, 300)}`;
      const ownerChat = await this.privateOwnerChat();
      await this.sendText(ownerChat, token ? message : `${message}\nReply /yes or /no.`, token ? {
        disableLinkPreview: true,
        keyboard: [[["Approve this action", `appr:${token}:yes`], ["Decline", `appr:${token}:no`]]],
      } : undefined);
    } catch {
      return false;
    }
    if (this.stopped) return false;
    return new Promise<boolean>((resolve) => {
      const timeout = setTimeout(() => this.resolveApproval(false), 120_000);
      this.pendingApproval = { resolve, token, timeout };
    });
  };

  async run(): Promise<void> {
    const me = await this.api("getMe", {});
    this.o.log.info(`telegram @${me.username} online; owner=${this.ownerId ?? "(unclaimed — first /start wins)"}`);
    if (this.ownerId == null) {
      this.o.log.warn("⚠ Telegram owner is UNSET — the FIRST user to /start claims this bot. For any shared/public deployment set ARGUS_TELEGRAM_OWNER_ID to your own id.");
    }
    // Tools reach the owner here directly, around the model (an eSIM's QR and activation code).
    setOwnerSink((note) => this.toOwner(note));
    while (!this.stopped) {
      let updates: TgUpdate[] = [];
      try {
        updates = await this.api("getUpdates", { offset: this.offset, timeout: 50, allowed_updates: ["message", "callback_query"] }, 60_000);
      } catch (err) {
        this.o.log.warn(`getUpdates: ${(err as Error).message}`);
        await sleep(2000);
        continue;
      }
      for (const u of updates) {
        this.offset = Math.max(this.offset, u.update_id + 1);
        const msg = u.message;
        // Not awaited: a task that waits for /yes needs this loop to keep reading, or the approval
        // can never arrive and times out as a "no". One task at a time is kept by `busy`.
        if (msg?.text) void this.onMessage(msg).catch((e) => this.o.log.error(`onMessage: ${e}`));
        if (u.callback_query) void this.onCallback(u.callback_query).catch(() => this.o.log.warn("Telegram callback failed"));
      }
    }
  }

  stop(): void {
    this.stopped = true;
    setOwnerSink(null);
    this.mail.clear();
    this.purchase?.cancel();
    // Resolve any pending sensitive-tool approval so the promise doesn't hang
    // and the agent loop can exit cleanly (M3 fix).
    this.resolveApproval(false);
  }

  private async onMessage(msg: TgMessage): Promise<void> {
    const uid = msg.from?.id;
    const chatId = msg.chat.id;
    const text = (msg.text ?? "").trim();
    if (uid == null) return;
    const privateChat = msg.chat.type === "private" && chatId === uid;

    // ── Owner gating (baked in) ──────────────────────────────────────────────
    if (this.ownerId == null) {
      if (privateChat && /^\/?start$/i.test(text)) {
        this.ownerId = uid;
        this.verifiedOwnerChat = chatId;
        this.saveOwner(uid);
        this.o.log.info(`owner claimed: ${uid} (@${msg.from?.username ?? "?"})`);
        await this.send(chatId, `🛡️ ARGUS is now locked to you (id ${uid}). All other Telegram users are rejected.\nSend a task, or open /mail.`);
        retryOwnerNotes();
      } else {
        await this.send(chatId, "Send /start in a private chat to claim this ARGUS bot (first user only).");
      }
      return;
    }
    if (uid !== this.ownerId) {
      this.o.log.warn(`rejected non-owner ${uid} (@${msg.from?.username ?? "?"})`);
      await this.send(chatId, "⛔ This ARGUS instance is locked to its owner.");
      return;
    }
    if (privateChat) this.verifiedOwnerChat = chatId;

    // ── Owner path ───────────────────────────────────────────────────────────
    const purchaseIntent = purchaseCommand(text);
    if (!privateChat && /^\/(?:buy|recover)_itch@[a-z0-9_]{5,32}$/i.test(text)) return this.send(chatId, "Open the private ARGUS chat to use purchases.");
    if (this.purchase || purchaseIntent || isPurchaseInputPrompt(msg.reply_to_message?.text) || isPurchaseLink(text)) {
      if (!privateChat) return this.send(chatId, "Open the private ARGUS chat to use purchases.");
      if (this.purchase) {
        if (purchaseIntent) return this.send(chatId, "A purchase is already in progress.");
        return this.purchase.handleMessage(text, msg.reply_to_message?.message_id).catch(() => {
          this.o.log.warn("Telegram purchase reply failed");
        });
      }
      if (isPurchaseInputPrompt(msg.reply_to_message?.text)) return this.send(chatId, "That purchase prompt has expired.");
      if (isPurchaseLink(text)) return this.send(chatId, "Open /recover_itch and reply directly to the private recovery prompt.");
      if (!purchaseIntent) return;
      if (this.o.ownerId === undefined || !this.o.purchase || this.stopped) return this.send(chatId, "Purchases are unavailable in this ARGUS instance.");
      if (this.busy || this.pendingApproval) return this.send(chatId, "ARGUS is busy with another task.");
      return this.runPurchase(chatId, this.o.purchase, purchaseIntent, /^(?:купи|получи) /iu.test(text));
    }
    // Approval replies take priority so /yes resolves a pending gate mid-task.
    if (this.pendingApproval) {
      if (!privateChat) return void (await this.send(chatId, "Open the private ARGUS chat to review the pending approval."));
      if (this.pendingApproval.token) return void (await this.send(chatId, "Review the pending action and use its approval buttons."));
      if (/^(y|yes|да|\/yes|approve|ok)$/i.test(text)) return this.resolveApproval(true);
      if (/^(n|no|нет|\/no|deny|cancel)$/i.test(text)) return this.resolveApproval(false);
      await this.send(chatId, "Awaiting approval — reply /yes or /no.");
      return;
    }
    if (/^\/(start|help)$/i.test(text)) {
      const purchaseHelp = privateChat && this.o.ownerId !== undefined && this.o.purchase ? "\n/buy_itch to purchase the icon pack. /recover_itch to deliver an existing purchase." : "";
      await this.send(chatId, `🛡️ ARGUS — your owner-locked agent.\nSend a task. /mail for inbox and mail setup. /flex for your 🎮 Agent Arena card. /status for state. Sensitive tools ask for /yes first.${purchaseHelp}`);
      return;
    }
    if (isMailCommand(text)) {
      if (!privateChat) return void (await this.send(chatId, "Open the private ARGUS chat to use mail."));
      return this.mail.command(text, (message, keyboard) => this.sendText(chatId, message, { keyboard, disableLinkPreview: true }));
    }
    if (/^\/flex$/i.test(text)) {
      if (!this.o.arena) return void (await this.send(chatId, "Arena not available."));
      const s = await this.o.arena.stats();
      await this.sendMono(chatId, renderAsciiCard(s));
      return;
    }
    if (/^\/status$/i.test(text)) {
      await this.send(chatId, `ARGUS online · owner-locked (id ${this.ownerId})${this.busy ? " · busy" : ""}`);
      return;
    }
    if (this.busy) {
      await this.send(chatId, "⏳ Still working on the previous task — one at a time.");
      return;
    }

    this.busy = true;
    const typing = setInterval(() => void this.sendChatAction(chatId, "typing"), 5000);
    void this.sendChatAction(chatId, "typing");
    try {
      const history = this.chatHistory.get(chatId) ?? [];
      const res = await this.o.agent.run(text, { approve: this.approver, history });
      const answer = res.answer || "(no answer)";
      this.appendHistory(chatId, { role: "user", content: text }, { role: "assistant", content: answer });
      await this.send(chatId, `${answer}\n\n— ${fmtMeter(res.meter)} · ${res.outcome}`);
    } catch (err) {
      await this.send(chatId, `⚠ error: ${(err as Error).message}`);
    } finally {
      clearInterval(typing);
      this.busy = false;
    }
  }

  private async onCallback(query: TgCallback): Promise<void> {
    const chat = query.message?.chat;
    const authorized = query.from.id === this.ownerId && chat?.type === "private" && chat.id === query.from.id;
    await this.api("answerCallbackQuery", {
      callback_query_id: query.id,
      ...(authorized ? {} : { text: "Open the private ARGUS chat to use this action." }),
    }).catch(() => undefined);
    if (!authorized || !query.data) return;
    this.verifiedOwnerChat = chat.id;
    if (query.data.startsWith("purchase:")) {
      if (query.message) await this.purchase?.handleCallback(query.data, query.message.message_id);
      return;
    }
    if (this.purchase) return;
    const approval = /^appr:([a-f0-9]{24}):(yes|no)$/.exec(query.data);
    if (approval && this.pendingApproval?.token === approval[1]) return this.resolveApproval(approval[2] === "yes");
    if (query.data.startsWith("mail:")) {
      await this.mail.action(query.data, (message, keyboard) => this.sendText(chat.id, message, { keyboard, disableLinkPreview: true }));
    }
  }

  private async runPurchase(chatId: number, run: NonNullable<TelegramBotOptions["purchase"]>, intent: TelegramPurchaseIntent, russian: boolean): Promise<void> {
    const purchase = new TelegramPurchase({
      prompt: async (text, replyMarkup) => {
        const message = await this.api("sendMessage", {
          chat_id: chatId,
          text,
          reply_markup: replyMarkup,
          link_preview_options: { is_disabled: true },
        });
        if (!isUserId(message?.message_id)) throw new Error("Invalid Telegram prompt response");
        return message.message_id;
      },
      send: (text) => this.sendText(chatId, text, { disableLinkPreview: true }),
      upload: async (filename, bytes) => {
        const form = new FormData();
        form.set("chat_id", String(chatId));
        form.set("document", new Blob([new Uint8Array(bytes)], { type: "application/zip" }), filename);
        await this.api("sendDocument", form, 30_000);
      },
    }, russian);
    this.purchase = purchase;
    this.busy = true;
    try {
      await run(purchase, intent);
    } catch {
      this.o.log.warn("Telegram purchase workflow failed");
      if (!purchase.signal.aborted) await this.send(chatId, "ARGUS could not finish the purchase workflow. Check your receipt and card activity before starting another purchase.");
    } finally {
      purchase.cancel();
      this.purchase = undefined;
      this.busy = false;
    }
  }

  private appendHistory(chatId: number, ...turns: ChatTurn[]): void {
    const hist = [...(this.chatHistory.get(chatId) ?? []), ...turns];
    while (hist.length > MAX_CHAT_TURNS * 2) hist.shift();
    this.chatHistory.set(chatId, hist);
  }

  private resolveApproval(ok: boolean): void {
    const pending = this.pendingApproval;
    this.pendingApproval = null;
    if (!pending) return;
    clearTimeout(pending.timeout);
    pending.resolve(ok);
  }

  // ── Telegram API ───────────────────────────────────────────────────────────
  private async api(method: string, params: Record<string, unknown> | FormData, timeoutMs = 15_000): Promise<any> {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const multipart = params instanceof FormData;
      const res = await fetchNoRedirect(`${API}/bot${this.o.token}/${method}`, {
        method: "POST",
        headers: multipart ? undefined : { "content-type": "application/json" },
        body: multipart ? params : JSON.stringify(params),
        signal: ctrl.signal,
      });
      const json: any = await res.json();
      if (method === "sendDocument" && json.ok === false && json.error_code === res.status
        && [400, 403, 429].includes(res.status)) throw new TelegramDocumentRejected();
      if (!json.ok) throw new Error(json.description ?? `telegram ${method} failed`);
      return json.result;
    } finally {
      clearTimeout(t);
    }
  }

  /** Send text, chunked to Telegram's per-message limit. Plain text (no markdown) for robustness. */
  private async send(chatId: number, text: string): Promise<void> {
    await this.sendText(chatId, text).catch((e) => this.o.log.warn(`sendMessage: ${e}`));
  }

  /** Like send(), but a failure reaches the caller: a note to the owner must not count as delivered when it was not. */
  private async sendText(chatId: number, text: string, options?: { keyboard?: MailKeyboard; disableLinkPreview?: boolean }): Promise<void> {
    for (let i = 0; i < text.length; i += MAX_MSG) {
      const keyboard = options?.keyboard;
      const replyMarkup = keyboard && i + MAX_MSG >= text.length
        ? { reply_markup: { inline_keyboard: keyboard.map((row) => row.map(([label, command]) => ({ text: label, callback_data: command }))) } }
        : {};
      const preview = options?.disableLinkPreview ? { link_preview_options: { is_disabled: true } } : {};
      await this.api("sendMessage", { chat_id: chatId, text: text.slice(i, i + MAX_MSG), ...preview, ...replyMarkup });
    }
  }

  /** A tool's note to the owner: a photo by URL with the text as caption, then anything to copy, monospace. */
  private async toOwner(note: OwnerNote): Promise<void> {
    const ownerChat = await this.privateOwnerChat();
    if (note.photoUrl) {
      await this.api("sendPhoto", { chat_id: ownerChat, photo: note.photoUrl, caption: note.text.slice(0, 1000) })
        .catch(() => this.sendText(ownerChat, `${note.text}\n${note.photoUrl}`, { disableLinkPreview: true }));
    } else {
      await this.sendText(ownerChat, note.text, { disableLinkPreview: true });
    }
    if (note.copyable) {
      const esc = note.copyable.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
      await this.api("sendMessage", { chat_id: ownerChat, text: `<code>${esc}</code>`, parse_mode: "HTML", link_preview_options: { is_disabled: true } });
    }
  }

  private async privateOwnerChat(): Promise<number> {
    const id = this.ownerId;
    if (!isUserId(id)) throw new Error("No Telegram owner has been set");
    if (this.verifiedOwnerChat === id) return id;
    const chat: unknown = await this.api("getChat", { chat_id: id });
    if (!chat || typeof chat !== "object" || !("type" in chat) || chat.type !== "private" || !("id" in chat) || chat.id !== id) {
      throw new Error("The private Telegram owner chat is unavailable");
    }
    this.verifiedOwnerChat = id;
    return id;
  }

  /** Send monospace (so the ASCII Flex Card stays aligned). */
  private async sendMono(chatId: number, text: string): Promise<void> {
    const esc = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    await this.api("sendMessage", { chat_id: chatId, text: `<pre>${esc}</pre>`, parse_mode: "HTML" }).catch(() => this.send(chatId, text));
  }

  private sendChatAction(chatId: number, action: string): Promise<unknown> {
    return this.api("sendChatAction", { chat_id: chatId, action }).catch(() => undefined);
  }

  private loadOwner(): number | null {
    try {
      if (existsSync(this.ownerFile)) {
        const id: unknown = JSON.parse(readFileSync(this.ownerFile, "utf8")).ownerId;
        if (isUserId(id)) return id;
      }
    } catch {
      /* ignore */
    }
    return null;
  }

  private saveOwner(id: number): void {
    try {
      mkdirSync(dirname(this.ownerFile), { recursive: true });
      writeFileSync(this.ownerFile, JSON.stringify({ ownerId: id, claimedAt: new Date().toISOString() }));
    } catch (err) {
      this.o.log.warn(`could not persist owner: ${(err as Error).message}`);
    }
  }
}

function fmtMeter(m: MeterSnapshot): string {
  return `tok ${m.inputTokens}/${m.outputTokens} · ${m.steps} steps · ${m.toolCalls} tools · $${m.costUsd.toFixed(4)}`;
}
function isUserId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "…" : s;
}
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
