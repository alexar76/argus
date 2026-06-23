import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { readFileSync, writeFileSync, existsSync, chmodSync } from "node:fs";
import { resolve, join } from "node:path";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";
import { Wallet } from "../economy/wallet.js";
import { encryptKeystore, saveKeystore, keystorePath } from "../economy/keystore.js";

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

/**
 * Interactive setup. Flow (as specified): generate the wallet FIRST — a BIP39
 * seed phrase plus its address and key are written to the environment, and the
 * seed is NEVER printed, logged, or passed to the model — then collect the
 * provider / model / API key and the other settings. Writes secrets to .env
 * (chmod 600) and non-secret config to argus.config.json.
 */
export async function runSetupWizard(): Promise<number> {
  if (!stdin.isTTY) {
    console.error("argus setup needs an interactive terminal.");
    return 1;
  }
  const envPath = resolve(process.cwd(), ".env");
  const cfgPath = resolve(process.cwd(), "argus.config.json");
  const env = readEnv(envPath);
  const rl = createInterface({ input: stdin, output: stdout });
  const ask = (q: string, d = "") => rl.question(d ? `${q} [${d}]: ` : `${q}: `).then((a) => a.trim() || d);

  try {
    console.log("\n🛡️  ARGUS setup — your keys, your wallet, your machine.\n");

    // ── 1. Crypto / wallet ───────────────────────────────────────────────────
    // Crypto is OFF by default — a real blockchain is NOT required to run ARGUS.
    console.log("Crypto / on-chain economy (wallet, lottery, ACEX, paid hub invokes).");
    console.log("This is OPTIONAL and OFF by default — ARGUS runs fully as a local agent without it.");
    const wantCrypto = (await ask("Enable the on-chain economy now? y/N", "n")).toLowerCase().startsWith("y");
    if (!wantCrypto) {
      env.set("ARGUS_CRYPTO_ENABLED", "0");
      console.log("→ Crypto stays OFF. (You can enable it later: `argus keystore create` + ARGUS_CRYPTO_ENABLED=1.)\n");
    } else {
      env.set("ARGUS_CRYPTO_ENABLED", "1");
      const existingKey = env.get("ARGUS_WALLET_KEY");
      let makeWallet = true;
      if (existingKey) {
        try {
          console.log(`Existing wallet detected: ${new Wallet(existingKey).address}`);
        } catch {
          /* invalid — will regenerate */
        }
        makeWallet = (await ask("Generate a NEW wallet (replaces the existing one)? y/N", "n")).toLowerCase().startsWith("y");
      } else {
        makeWallet = !(await ask("Create a Base wallet now? Y/n", "y")).toLowerCase().startsWith("n");
      }
      if (makeWallet) {
        const w = Wallet.generate();
        // Prefer the encrypted vault: the seed/key are written AES-256-GCM encrypted,
        // never as plaintext in .env. Only a passphrase (in .env / a secret manager)
        // unlocks them at runtime.
        const useVault = !(await ask("Encrypt the wallet into a keystore vault (recommended)? Y/n", "y")).toLowerCase().startsWith("n");
        if (useVault) {
          let p1 = "";
          for (let i = 0; i < 3 && !p1; i++) {
            const a = await ask("New keystore passphrase");
            const b = await ask("Repeat passphrase");
            if (a && a === b) p1 = a;
            else console.log("   passphrases empty or mismatched — try again.");
          }
          if (!p1) {
            console.log("   no passphrase set — falling back to plaintext .env for this wallet.");
            env.set("ARGUS_WALLET_MNEMONIC", w.mnemonic);
            env.set("ARGUS_WALLET_KEY", w.privateKey);
          } else {
            saveKeystore(keystorePath(stateDir()), encryptKeystore({ mnemonic: w.mnemonic, privateKey: w.privateKey }, p1, w.address));
            env.set("ARGUS_KEYSTORE_PASSPHRASE", p1);
            env.delete("ARGUS_WALLET_KEY");
            env.delete("ARGUS_WALLET_MNEMONIC");
            console.log("🔒 Wallet encrypted into the vault (~/.argus/keystore.json, mode 600).");
            console.log("   The seed/key are NEVER stored in plaintext. .env only holds the passphrase.");
          }
        } else {
          env.set("ARGUS_WALLET_MNEMONIC", w.mnemonic);
          env.set("ARGUS_WALLET_KEY", w.privateKey);
          console.log("🔑 12-word seed + key saved to .env (plaintext — dev mode).");
        }
        env.set("ARGUS_WALLET_ADDRESS", w.address);
        // Deliberately print ONLY the address — never the seed or key.
        console.log(`\n✅ Wallet created on Base: ${w.address}`);
        console.log("   BACK UP your secret now — it is the only copy. ARGUS never displays or transmits the seed.\n");
      }
    }

    // ── 2. Mode ──────────────────────────────────────────────────────────────
    let mode = (await ask("Environment mode: live / uni / test", "live")).toLowerCase();
    if (!["live", "uni", "test"].includes(mode)) mode = "live";

    // ── 3. Provider + model + key ────────────────────────────────────────────
    console.log("\nLLM provider:\n  1) DeepSeek   2) Anthropic (Claude)   3) OpenAI-compatible (custom)   4) Local (Ollama)");
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
      const key = await ask(`${preset.apiKeyEnv}${cur ? " (blank=keep existing)" : ""}`, cur ? "•keep" : "");
      if (key && key !== "•keep") env.set(preset.apiKeyEnv, key);
    }

    // ── 4. Telegram (optional, owner-locked) ─────────────────────────────────
    const tg = await ask("\nTelegram bot token (blank to skip)", env.get("ARGUS_TELEGRAM_TOKEN") ? "•keep" : "");
    if (tg && tg !== "•keep") env.set("ARGUS_TELEGRAM_TOKEN", tg);
    if (env.get("ARGUS_TELEGRAM_TOKEN")) {
      const owner = await ask("Telegram owner user id (blank = first /start claims it)", env.get("ARGUS_TELEGRAM_OWNER_ID") ?? "");
      if (owner) env.set("ARGUS_TELEGRAM_OWNER_ID", owner);
    }

    // ── 5. HTTP /ask token (optional) ────────────────────────────────────────
    const http = await ask("HTTP /ask bearer token (blank=disable, 'gen'=auto-generate)", env.get("ARGUS_HTTP_TOKEN") ? "•keep" : "");
    if (http === "gen") env.set("ARGUS_HTTP_TOKEN", randomBytes(24).toString("hex"));
    else if (http && http !== "•keep") env.set("ARGUS_HTTP_TOKEN", http);

    // ── Write config + env ───────────────────────────────────────────────────
    const ref = `${preset.id}/${preset.model}`;
    const model = { ref, ...(preset.pricing ? { pricing: preset.pricing } : {}) };
    const provider = {
      id: preset.id,
      kind: preset.kind,
      ...(preset.baseUrl ? { baseUrl: preset.baseUrl } : {}),
      ...(preset.apiKeyEnv ? { apiKeyEnv: preset.apiKeyEnv } : {}),
    };
    const config = { mode, providers: [provider], models: { triage: model, core: model, heavy: model } };
    writeFileSync(cfgPath, JSON.stringify(config, null, 2) + "\n");
    writeEnv(envPath, env);

    console.log("\n✅ Setup complete.");
    console.log(`   config:   ${cfgPath}`);
    console.log(`   mode:     ${mode}`);
    console.log(`   provider: ${preset.id} · model ${preset.model}`);
    console.log(`   wallet:   ${env.get("ARGUS_WALLET_ADDRESS") ?? "(none)"}`);
    console.log(`   telegram: ${env.get("ARGUS_TELEGRAM_TOKEN") ? "on" : "off"} · http /ask: ${env.get("ARGUS_HTTP_TOKEN") ? "on" : "off"}`);
    console.log("\nRun it:  argus serve     (or: argus doctor)\n");
    return 0;
  } finally {
    rl.close();
  }
}

/** Default keystore home — matches config's DEFAULT_STATE_DIR (~/.argus). */
function stateDir(): string {
  return join(homedir(), ".argus");
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
  // Quote values containing whitespace/specials (e.g. the seed phrase) so the
  // file is safe for `bash source` as well as systemd/docker env_file.
  const quote = (v: string) => (/[\s#"'$]/.test(v) ? `"${v.replace(/(["\\$`])/g, "\\$1")}"` : v);
  const body = [...m.entries()].map(([k, v]) => `${k}=${quote(v)}`).join("\n") + "\n";
  writeFileSync(path, body);
  try {
    chmodSync(path, 0o600);
  } catch {
    /* best-effort */
  }
}
