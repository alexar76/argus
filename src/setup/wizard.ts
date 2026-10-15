import { createInterface, type Interface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { readFileSync, writeFileSync, existsSync, chmodSync } from "node:fs";
import { resolve, join } from "node:path";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";
import { Wallet } from "../economy/wallet.js";
import { encryptKeystore, saveKeystore, keystorePath } from "../economy/keystore.js";
import { readSecretLine } from "./secret-prompt.js";

interface Preset {
  id: string;
  kind: "anthropic" | "openai" | "local";
  baseUrl?: string;
  apiKeyEnv?: string;
  model: string;
  pricing?: { inputPerM: number; outputPerM: number; cachedInputPerM?: number };
}

const PRESETS: Record<string, Preset> = {
  "1": { id: "deepseek", kind: "openai", baseUrl: "https://api.deepseek.com/v1", apiKeyEnv: "DEEPSEEK_API_KEY", model: "deepseek-chat", pricing: { inputPerM: 0.27, outputPerM: 1.1 } },
  "2": { id: "anthropic", kind: "anthropic", apiKeyEnv: "ANTHROPIC_API_KEY", model: "claude-sonnet-4-6", pricing: { inputPerM: 3, outputPerM: 15, cachedInputPerM: 0.3 } },
  "4": { id: "local", kind: "local", baseUrl: "http://127.0.0.1:11434/v1", model: "llama3.1", pricing: { inputPerM: 0, outputPerM: 0 } },
};

type AskFn = (q: string, d?: string) => Promise<string>;
type AskSecretFn = (label: string, opts?: { keepExisting?: boolean }) => Promise<string>;

const HIDDEN_INPUT_NOTE =
  "  ℹ️  Hidden input — characters won’t appear as you type (normal). Paste, then Enter.";

/**
 * Interactive setup — Claude Code-style menu: LLM keys, Telegram chat, wallet
 * (generate + show seed once, or import), optional HTTP token. Writes `.env`
 * (chmod 600) and `argus.config.json`.
 */
export async function runSetupWizard(): Promise<number> {
  if (!stdin.isTTY) {
    console.error("argus setup needs an interactive terminal (TTY).");
    console.error("Run:  cd ~/.argus/agent && argus setup");
    return 1;
  }
  const envPath = resolve(process.cwd(), ".env");
  const cfgPath = resolve(process.cwd(), "argus.config.json");
  const env = readEnv(envPath);
  const rl = createInterface({ input: stdin, output: stdout });
  const ask: AskFn = (q, d = "") => rl.question(d ? `${q} [${d}]: ` : `${q}: `).then((a) => a.trim() || d);
  const askSecret = makeAskSecret(rl);

  let mode = "live";
  let preset: Preset = PRESETS["1"]!;

  try {
    console.log("\n🛡️  ARGUS setup — configure your agent (like Claude Code onboarding)\n");
    console.log("  Secrets (API keys, bot tokens, passphrases) use hidden input — nothing echoes; that’s intentional.\n");
    printMainMenu();

    const pick = await ask("Choose", "5");
    if (pick === "0") {
      console.log("Nothing changed.");
      return 0;
    }

    const runAll = pick === "5" || pick === "";

    if (runAll || pick === "1") {
      const r = await configureLlm(ask, askSecret, env);
      preset = r.preset;
      mode = r.mode;
    }
    if (runAll || pick === "2") await configureTelegram(ask, askSecret, env);
    if (runAll || pick === "3") await configureWallet(ask, askSecret, env);
    if (runAll || pick === "4") await configureHttp(askSecret, env);

    if (!runAll && pick !== "1") {
      mode = (await ask("\nEnvironment mode: live / uni / test", readMode(cfgPath) ?? "live")).toLowerCase();
      if (!["live", "uni", "test"].includes(mode)) mode = "live";
    }

    const ref = `${preset.id}/${preset.model}`;
    const model = { ref, ...(preset.pricing ? { pricing: preset.pricing } : {}) };
    const provider = {
      id: preset.id,
      kind: preset.kind,
      ...(preset.baseUrl ? { baseUrl: preset.baseUrl } : {}),
      ...(preset.apiKeyEnv ? { apiKeyEnv: preset.apiKeyEnv } : {}),
    };
    const existing = readConfig(cfgPath);
    const config = {
      ...existing,
      mode,
      providers: [provider],
      models: { triage: model, core: model, heavy: model },
    };
    writeFileSync(cfgPath, JSON.stringify(config, null, 2) + "\n");
    writeEnv(envPath, env);

    console.log("\n✅ Setup complete.");
    console.log(`   config:   ${cfgPath}`);
    console.log(`   mode:     ${mode}`);
    console.log(`   provider: ${preset.id} · model ${preset.model}`);
    console.log(`   wallet:   ${env.get("ARGUS_WALLET_ADDRESS") ?? "(none)"}`);
    console.log(`   telegram: ${env.get("ARGUS_TELEGRAM_TOKEN") ? "on" : "off"} · http /ask: ${env.get("ARGUS_HTTP_TOKEN") ? "on" : "off"}`);
    console.log("\nRun:  argus chat  ·  argus serve  ·  argus doctor\n");
    return 0;
  } finally {
    rl.close();
  }
}

function printMainMenu(): void {
  console.log("  1) LLM provider + API key");
  console.log("  2) Telegram bot (chat with ARGUS in Telegram)");
  console.log("  3) Wallet — generate new (shows seed) or import existing");
  console.log("  4) HTTP /ask bearer token");
  console.log("  5) Full setup — all of the above (recommended first time)\n");
}

function makeAskSecret(rl: Interface): AskSecretFn {
  return async (label, opts) => {
    const suffix = opts?.keepExisting ? " (Enter=keep existing)" : "";
    stdout.write(`${HIDDEN_INPUT_NOTE}\n`);
    rl.pause();
    try {
      return await readSecretLine(`${label}${suffix}: `);
    } finally {
      rl.resume();
    }
  };
}

async function configureLlm(
  ask: AskFn,
  askSecret: AskSecretFn,
  env: Map<string, string>,
): Promise<{ preset: Preset; mode: string }> {
  console.log("\n── LLM provider ──");
  let mode = (await ask("Environment mode: live / uni / test", "live")).toLowerCase();
  if (!["live", "uni", "test"].includes(mode)) mode = "live";

  console.log("\n  1) DeepSeek   2) Anthropic (Claude)   3) OpenAI-compatible   4) Local (Ollama)");
  const choice = await ask("Choose 1-4", "1");
  let preset: Preset;
  if (choice === "3") {
    const id = (await ask("provider id (e.g. qwen, groq)", "openai")).replace(/[^a-z0-9_-]/gi, "");
    const baseUrl = await ask("base URL", "https://api.openai.com/v1");
    const apiKeyEnv = (await ask("API-key env var name", `${id.toUpperCase()}_API_KEY`)).toUpperCase();
    const model = await ask("model id", "gpt-4o-mini");
    preset = { id, kind: "openai", baseUrl, apiKeyEnv, model };
  } else {
    preset = PRESETS[choice] ?? PRESETS["1"]!;
    const model = await ask("model id", preset.model);
    preset = { ...preset, model };
  }
  if (preset.apiKeyEnv) {
    const cur = env.get(preset.apiKeyEnv);
    const key = await askSecret(`${preset.apiKeyEnv}`, { keepExisting: Boolean(cur) });
    if (key) env.set(preset.apiKeyEnv, key);
  }
  return { preset, mode };
}

async function configureTelegram(
  ask: AskFn,
  askSecret: AskSecretFn,
  env: Map<string, string>,
): Promise<void> {
  console.log("\n── Telegram (optional) ──");
  console.log("Create a bot via @BotFather, paste the token here to chat with ARGUS in Telegram.");
  const tg = await askSecret("Telegram bot token (blank=skip)", { keepExisting: Boolean(env.get("ARGUS_TELEGRAM_TOKEN")) });
  if (tg) env.set("ARGUS_TELEGRAM_TOKEN", tg);
  if (env.get("ARGUS_TELEGRAM_TOKEN")) {
    const owner = await ask(
      "Your Telegram user id (numeric — blank = first /start claims the bot)",
      env.get("ARGUS_TELEGRAM_OWNER_ID") ?? "",
    );
    if (owner) env.set("ARGUS_TELEGRAM_OWNER_ID", owner);
  }
}

async function configureWallet(
  ask: AskFn,
  askSecret: AskSecretFn,
  env: Map<string, string>,
): Promise<void> {
  console.log("\n── Wallet / on-chain economy (optional) ──");
  console.log("Enables paid Hub invokes, lottery, ACEX. OFF by default — ARGUS works without a wallet.");
  const wantCrypto = (await ask("Enable on-chain economy? y/N", env.get("ARGUS_CRYPTO_ENABLED") === "1" ? "y" : "n"))
    .toLowerCase()
    .startsWith("y");
  if (!wantCrypto) {
    env.set("ARGUS_CRYPTO_ENABLED", "0");
    console.log("→ Crypto OFF.");
    return;
  }
  env.set("ARGUS_CRYPTO_ENABLED", "1");

  console.log("\n  1) Generate NEW wallet (shows 12-word seed once)");
  console.log("  2) Import existing seed phrase");
  console.log("  3) Skip wallet for now");
  const wChoice = await ask("Choose 1-3", "1");
  if (wChoice === "3") return;

  let w: ReturnType<typeof Wallet.generate>;
  if (wChoice === "2") {
    const phrase = await askSecret("Paste your 12/24-word seed phrase");
    if (!phrase) {
      console.log("→ No seed entered — skipping wallet.");
      return;
    }
    try {
      w = Wallet.fromMnemonic(phrase);
    } catch (err) {
      console.error(`Invalid seed: ${(err as Error).message}`);
      return;
    }
    console.log(`\n✅ Imported wallet: ${w.address}\n`);
  } else {
    w = Wallet.generate();
    console.log("\n╔══════════════════════════════════════════════════════════════╗");
    console.log("║  SAVE THIS SEED — shown ONCE. Anyone with it controls funds. ║");
    console.log("╚══════════════════════════════════════════════════════════════╝");
    console.log(`\n  ${w.mnemonic}\n`);
    console.log(`  Address: ${w.address}\n`);
    await ask("Press Enter after you wrote the seed down");
  }

  const useVault = !(await ask("Encrypt into keystore vault (recommended)? Y/n", "y")).toLowerCase().startsWith("n");
  if (useVault) {
    let p1 = "";
    for (let i = 0; i < 3 && !p1; i++) {
      const a = await askSecret("Keystore passphrase");
      const b = await askSecret("Repeat passphrase");
      if (a && a === b) p1 = a;
      else console.log("   passphrases empty or mismatched — try again.");
    }
    if (!p1) {
      console.log("   no passphrase — storing in .env (dev mode only).");
      env.set("ARGUS_WALLET_MNEMONIC", w.mnemonic);
      env.set("ARGUS_WALLET_KEY", w.privateKey);
    } else {
      saveKeystore(keystorePath(stateDir()), encryptKeystore({ mnemonic: w.mnemonic, privateKey: w.privateKey }, p1, w.address));
      env.set("ARGUS_KEYSTORE_PASSPHRASE", p1);
      env.delete("ARGUS_WALLET_KEY");
      env.delete("ARGUS_WALLET_MNEMONIC");
      console.log("🔒 Wallet encrypted (~/.argus/keystore.json). Seed not stored in plaintext.");
    }
  } else {
    env.set("ARGUS_WALLET_MNEMONIC", w.mnemonic);
    env.set("ARGUS_WALLET_KEY", w.privateKey);
    console.log("🔑 Wallet saved to .env (plaintext — dev only).");
  }
  env.set("ARGUS_WALLET_ADDRESS", w.address);
}

async function configureHttp(askSecret: AskSecretFn, env: Map<string, string>): Promise<void> {
  console.log("\n── HTTP API (optional) ──");
  console.log("  blank=disable · type gen + Enter=auto-generate · paste token + Enter=save");
  const http = await askSecret("ARGUS_HTTP_TOKEN bearer for POST /ask", {
    keepExisting: Boolean(env.get("ARGUS_HTTP_TOKEN")),
  });
  if (http === "gen") env.set("ARGUS_HTTP_TOKEN", randomBytes(24).toString("hex"));
  else if (http) env.set("ARGUS_HTTP_TOKEN", http);
}

function stateDir(): string {
  return join(homedir(), ".argus");
}

function readMode(cfgPath: string): string | undefined {
  try {
    const c = JSON.parse(readFileSync(cfgPath, "utf8")) as { mode?: string };
    return c.mode;
  } catch {
    return undefined;
  }
}

function readConfig(cfgPath: string): Record<string, unknown> {
  if (!existsSync(cfgPath)) return {};
  try {
    return JSON.parse(readFileSync(cfgPath, "utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function readEnv(path: string): Map<string, string> {
  const m = new Map<string, string>();
  if (!existsSync(path)) return m;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i > 0) m.set(t.slice(0, i).trim(), t.slice(i + 1));
  }
  return m;
}

function writeEnv(path: string, m: Map<string, string>): void {
  const quote = (v: string) => (/[\s#"'$]/.test(v) ? `"${v.replace(/(["\\$`])/g, "\\$1")}"` : v);
  const body = [...m.entries()].map(([k, v]) => `${k}=${quote(v)}`).join("\n") + "\n";
  writeFileSync(path, body);
  try {
    chmodSync(path, 0o600);
  } catch {
    /* best-effort */
  }
}
