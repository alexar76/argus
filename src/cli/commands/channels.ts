import type { ArgusConfig } from "../../config.js";
import { createLogger } from "../../logger.js";
import { Runtime } from "../../runtime.js";
import { TelegramBot } from "../../telegram/bot.js";
import { HttpChannel } from "../../channels/http.js";
import { McpServerChannel } from "../../channels/mcp_server.js";
import { Arena } from "../../arena/arena.js";
import { renderAsciiCard } from "../../arena/card.js";
import { VERSION } from "../util.js";
import { resolveTelegramToken, telegramTokenStatus, encryptToken, saveTelegramToken, telegramTokenPath } from "../../economy/keystore.js";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

export function telegramEnabled(stateDir: string): boolean {
  const disabled = process.env.ARGUS_TELEGRAM_DISABLED;
  if (disabled === "1" || disabled?.toLowerCase() === "true") return false;
  return !!resolveTelegramToken(stateDir);
}

export async function cmdTelegram(config: ArgusConfig, args?: { rest: string[] }): Promise<number> {
  // ── Subcommands ──────────────────────────────────────────────────────────
  const sub = args?.rest[0] ?? "run";

  if (sub === "token-set") {
    return cmdTelegramTokenSet(config);
  }
  if (sub === "token-status") {
    return cmdTelegramTokenStatus(config);
  }
  if (sub !== "run") {
    console.error(`Usage: argus telegram [run|token-set|token-status]`);
    return 2;
  }

  // ── Run the bot ──────────────────────────────────────────────────────────
  if (!telegramEnabled(config.stateDir)) {
    const st = telegramTokenStatus(config.stateDir);
    console.error(`Telegram is disabled. Token status: ${st}. Set ARGUS_TELEGRAM_TOKEN (env) or encrypt it with \`argus telegram token-set\`.`);
    return 1;
  }
  const token = resolveTelegramToken(config.stateDir);
  if (!token) {
    console.error("Telegram token resolved to empty — Telegram disabled.");
    return 1;
  }
  const log = createLogger("argus");
  const rt = await Runtime.create(config, log);
  if (!rt.router.available) {
    console.error("No LLM provider configured. Try `argus doctor`.");
    return 1;
  }
  const ownerEnv = process.env.ARGUS_TELEGRAM_OWNER_ID?.trim();
  const ownerId = ownerEnv ? Number(ownerEnv) : config.telegram.ownerId;

  let bot: TelegramBot | undefined;
  const agent = await rt.buildAgent((req) => bot!.approver(req));
  const arena = new Arena(rt.memory, config, log.child("arena"), rt.economyEnabled);
  bot = new TelegramBot({ token, agent, arena, stateDir: config.stateDir, ownerId, log: log.child("telegram") });

  const shutdown = () => {
    log.info("shutting down telegram bot…");
    bot?.stop();
    void rt.dispose();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  log.info("telegram bot starting (owner-locked); Ctrl-C to stop");
  await bot.run();
  return 0;
}

export async function cmdFlex(config: ArgusConfig): Promise<number> {
  const log = createLogger("argus", "error");
  const rt = await Runtime.create(config, log);
  const arena = new Arena(rt.memory, config, log, rt.economyEnabled);
  const s = await arena.stats();
  console.log(renderAsciiCard(s));
  console.error(`\nLevel ${s.level} · 🔥 ${s.streak} · ${Math.round(s.winRate * 100)}% win · ${s.tasks} tasks`);
  console.error(`Web card (wow): run \`argus serve\` → http://127.0.0.1:${config.http.port}/arena`);
  return 0;
}

export async function cmdServe(config: ArgusConfig): Promise<number> {
  const log = createLogger("argus");
  const rt = await Runtime.create(config, log);
  if (!rt.router.available) {
    console.error("No LLM provider configured. Try `argus doctor`.");
    return 1;
  }
  const agent = await rt.buildAgent();
  const arena = new Arena(rt.memory, config, log.child("arena"), rt.economyEnabled);
  const stoppers: Array<() => unknown> = [];
  const longRunning: Promise<unknown>[] = [];

  if (config.http.enabled) {
    const wallet = rt.wallet();
    const chain = rt.chain;
    const http = new HttpChannel({
      agent,
      arena,
      port: config.http.port,
      token: process.env.ARGUS_HTTP_TOKEN?.trim(),
      tlsCert: config.http.tlsCert,
      tlsKey: config.http.tlsKey,
      maxConcurrent: config.http.maxConcurrent,
      info: {
        version: VERSION,
        model: config.models.core.ref,
        economy: rt.economyEnabled ? "on" : "off",
        mode: config.mode,
        ...(wallet ? { wallet: wallet.address } : {}),
        ...(chain && wallet
          ? {
              chain: config.economy.chain ?? "base",
              chainNetwork: chain.mode === "live" ? "Base" : chain.mode === "uni" ? "AICOM Universe · Anvil" : config.mode,
              chainId: chain.chainId,
              walletExplorer: chain.explorerAddr(wallet.address),
            }
          : {}),
      },
      log: log.child("http"),
    });
    await http.start();
    log.info(`agent arena UI: http://127.0.0.1:${config.http.port}/arena`);
    stoppers.push(() => http.stop());
  }

  const tgToken = telegramEnabled(config.stateDir) ? resolveTelegramToken(config.stateDir) : undefined;
  if (tgToken) {
    const ownerEnv = process.env.ARGUS_TELEGRAM_OWNER_ID?.trim();
    const ownerId = ownerEnv ? Number(ownerEnv) : config.telegram.ownerId;
    const bot = new TelegramBot({ token: tgToken, agent, arena, stateDir: config.stateDir, ownerId, log: log.child("telegram") });
    stoppers.push(() => bot.stop());
    longRunning.push(bot.run());
  } else {
    const st = telegramTokenStatus(config.stateDir);
    log.info(process.env.ARGUS_TELEGRAM_DISABLED ? "telegram disabled (ARGUS_TELEGRAM_DISABLED)" : `telegram disabled (token: ${st})`);
  }

  const shutdown = () => {
    log.info("shutting down…");
    for (const s of stoppers) void s();
    void rt.dispose();
    setTimeout(() => process.exit(0), 1500);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  log.info(`argus serve — ${config.http.enabled ? `http :${config.http.port}` : "http off"}${tgToken ? " + telegram" : ""}`);
  if (rt.monitorFeed.enabled()) {
    rt.monitorFeed.startHeartbeat();
    stoppers.push(() => rt.monitorFeed.stop());
    log.info("monitor run feed enabled — pushing verifiable runs to Alien Monitor");
  }
  if (longRunning.length === 0) await new Promise<void>(() => {});
  else await Promise.all(longRunning);
  return 0;
}

export async function cmdMcp(config: ArgusConfig): Promise<number> {
  const log = createLogger("argus", "warn");
  const rt = await Runtime.create(config, log);
  if (!rt.router.available) {
    console.error("No LLM provider configured. Try `argus doctor`.");
    return 1;
  }
  const agent = await rt.buildAgent();
  const ch = new McpServerChannel({ agent, log: log.child("mcp-server") });
  await ch.start();
  await new Promise<void>(() => {});
  return 0;
}

// ── Telegram token encryption commands (R3) ─────────────────────────────────

async function cmdTelegramTokenSet(config: ArgusConfig): Promise<number> {
  const pass = process.env.ARGUS_KEYSTORE_PASSPHRASE?.trim();
  if (!pass) {
    console.error("ARGUS_KEYSTORE_PASSPHRASE is required to encrypt the token.");
    console.error("Set it in your environment or use `argus keystore create` first.");
    return 1;
  }

  let token: string;
  if (stdin.isTTY) {
    const rl = createInterface({ input: stdin, output: stdout });
    try {
      token = (await rl.question("Telegram bot token (from @BotFather): ")).trim();
    } finally {
      rl.close();
    }
  } else {
    token = process.env.ARGUS_TELEGRAM_TOKEN?.trim() ?? "";
  }
  if (!token) {
    console.error("No token provided. Set ARGUS_TELEGRAM_TOKEN or paste it interactively.");
    return 1;
  }

  // Quick sanity: Telegram bot tokens are <bot_id>:<alphanumeric_hash>
  if (!/^\d+:[A-Za-z0-9_-]{35,}$/.test(token)) {
    console.error("Token does not look like a Telegram bot token (expected <id>:<hash>). Refusing to encrypt.");
    return 1;
  }

  const path = telegramTokenPath(config.stateDir);
  saveTelegramToken(path, encryptToken(token, pass));
  console.log(`Encrypted Telegram token saved: ${path} (mode 600)`);
  console.log("The token is now encrypted at rest. Unlocked at runtime by ARGUS_KEYSTORE_PASSPHRASE.");
  console.log("You can now remove ARGUS_TELEGRAM_TOKEN from your .env file.");
  return 0;
}

function cmdTelegramTokenStatus(config: ArgusConfig): number {
  const st = telegramTokenStatus(config.stateDir);
  const path = telegramTokenPath(config.stateDir);
  switch (st) {
    case "encrypted-file":
      console.log(`encrypted file: ${path}`);
      console.log("token is stored encrypted on disk — ARGUS_KEYSTORE_PASSPHRASE unlocks it at runtime");
      break;
    case "plaintext-env":
      console.log(`plaintext env var (ARGUS_TELEGRAM_TOKEN)`);
      console.log(`run \`argus telegram token-set\` to encrypt it to ${path}`);
      break;
    case "none":
      console.log("no token configured — Telegram disabled");
      console.log("set ARGUS_TELEGRAM_TOKEN (env) or run `argus telegram token-set`");
      break;
  }
  return 0;
}
