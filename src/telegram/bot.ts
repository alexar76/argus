import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import type { Logger, MeterSnapshot } from "../types.js";
import type { Agent, ApprovalRequest, ChatTurn } from "../core/agent.js";
import type { ArenaStats } from "../arena/arena.js";
import { renderAsciiCard } from "../arena/card.js";

export interface TelegramBotOptions {
  token: string;
  agent: Agent;
  stateDir: string;
  log: Logger;
  /** If set, ONLY this Telegram user id may command the bot. Overrides TOFU. */
  ownerId?: number;
  /** Agent Arena — enables the /flex command. */
  arena?: { stats(): Promise<ArenaStats> };
}

interface TgUser { id: number; username?: string; first_name?: string }
interface TgMessage { message_id: number; from?: TgUser; chat: { id: number }; text?: string }
interface TgUpdate { update_id: number; message?: TgMessage; edited_message?: TgMessage }

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
  private busy = false;
  private pendingApproval: ((ok: boolean) => void) | null = null;
  private stopped = false;
  private readonly ownerFile: string;
  /** Per-chat prior turns so short follow-ups ("да", "проверь") keep context. */
  private readonly chatHistory = new Map<number, ChatTurn[]>();

  constructor(private readonly o: TelegramBotOptions) {
    this.ownerFile = join(o.stateDir, "telegram-owner.json");
    this.ownerId = o.ownerId ?? this.loadOwner();
  }

  /** Approval callback to wire into the Agent for sensitive tools. */
  approver = async (req: ApprovalRequest): Promise<boolean> => {
    if (this.ownerId == null) return false;
    const where = req.server ? ` (server ${req.server})` : "";
    await this.send(this.ownerId, `⚠ Approve sensitive tool "${req.tool}"${where}?\nargs: ${truncate(JSON.stringify(req.args), 300)}\nReply /yes or /no.`);
    return new Promise<boolean>((resolve) => {
      this.pendingApproval = resolve;
      setTimeout(() => {
        if (this.pendingApproval === resolve) {
          this.pendingApproval = null;
          resolve(false);
        }
      }, 120_000);
    });
  };

  async run(): Promise<void> {
    const me = await this.api("getMe", {});
    this.o.log.info(`telegram @${me.username} online; owner=${this.ownerId ?? "(unclaimed — first /start wins)"}`);
    if (this.ownerId == null) {
      this.o.log.warn("⚠ Telegram owner is UNSET — the FIRST user to /start claims this bot. For any shared/public deployment set ARGUS_TELEGRAM_OWNER_ID to your own id.");
    }
    while (!this.stopped) {
      let updates: TgUpdate[] = [];
      try {
        updates = await this.api("getUpdates", { offset: this.offset, timeout: 50, allowed_updates: ["message"] }, 60_000);
      } catch (err) {
        this.o.log.warn(`getUpdates: ${(err as Error).message}`);
        await sleep(2000);
        continue;
      }
      for (const u of updates) {
        this.offset = Math.max(this.offset, u.update_id + 1);
        const msg = u.message ?? u.edited_message;
        if (msg?.text) await this.onMessage(msg).catch((e) => this.o.log.error(`onMessage: ${e}`));
      }
    }
  }

  stop(): void {
    this.stopped = true;
  }

  private async onMessage(msg: TgMessage): Promise<void> {
    const uid = msg.from?.id;
    const chatId = msg.chat.id;
    const text = (msg.text ?? "").trim();
    if (uid == null) return;

    // ── Owner gating (baked in) ──────────────────────────────────────────────
    if (this.ownerId == null) {
      if (/^\/?start$/i.test(text)) {
        this.ownerId = uid;
        this.saveOwner(uid);
        this.o.log.info(`owner claimed: ${uid} (@${msg.from?.username ?? "?"})`);
        await this.send(chatId, `🛡️ ARGUS is now locked to you (id ${uid}). All other Telegram users are rejected.\nSend a task and I'll answer.`);
      } else {
        await this.send(chatId, "Send /start to claim this ARGUS bot (first user only).");
      }
      return;
    }
    if (uid !== this.ownerId) {
      this.o.log.warn(`rejected non-owner ${uid} (@${msg.from?.username ?? "?"})`);
      await this.send(chatId, "⛔ This ARGUS instance is locked to its owner.");
      return;
    }

    // ── Owner path ───────────────────────────────────────────────────────────
    // Approval replies take priority so /yes resolves a pending gate mid-task.
    if (this.pendingApproval) {
      if (/^(y|yes|да|\/yes|approve|ok)$/i.test(text)) return this.resolveApproval(true);
      if (/^(n|no|нет|\/no|deny|cancel)$/i.test(text)) return this.resolveApproval(false);
      await this.send(chatId, "Awaiting approval — reply /yes or /no.");
      return;
    }
    if (/^\/(start|help)$/i.test(text)) {
      await this.send(chatId, "🛡️ ARGUS — your owner-locked agent.\nSend a task. /flex for your 🎮 Agent Arena card. /status for state. Sensitive tools ask for /yes first.");
      return;
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

  private appendHistory(chatId: number, ...turns: ChatTurn[]): void {
    const hist = [...(this.chatHistory.get(chatId) ?? []), ...turns];
    while (hist.length > MAX_CHAT_TURNS * 2) hist.shift();
    this.chatHistory.set(chatId, hist);
  }

  private resolveApproval(ok: boolean): void {
    const r = this.pendingApproval;
    this.pendingApproval = null;
    r?.(ok);
  }

  // ── Telegram API ───────────────────────────────────────────────────────────
  private async api(method: string, params: Record<string, unknown>, timeoutMs = 15_000): Promise<any> {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(`${API}/bot${this.o.token}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(params),
        signal: ctrl.signal,
      });
      const json: any = await res.json();
      if (!json.ok) throw new Error(json.description ?? `telegram ${method} failed`);
      return json.result;
    } finally {
      clearTimeout(t);
    }
  }

  /** Send text, chunked to Telegram's per-message limit. Plain text (no markdown) for robustness. */
  private async send(chatId: number, text: string): Promise<void> {
    for (let i = 0; i < text.length; i += MAX_MSG) {
      const chunk = text.slice(i, i + MAX_MSG);
      await this.api("sendMessage", { chat_id: chatId, text: chunk }).catch((e) => this.o.log.warn(`sendMessage: ${e}`));
    }
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
      if (existsSync(this.ownerFile)) return JSON.parse(readFileSync(this.ownerFile, "utf8")).ownerId ?? null;
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
function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "…" : s;
}
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
