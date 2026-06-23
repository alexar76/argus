import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { loadConfig, type ArgusConfig } from "./config.js";
import { createLogger } from "./logger.js";
import { Runtime } from "./runtime.js";
import type { ApprovalRequest } from "./core/agent.js";
import type { MeterSnapshot } from "./types.js";
import { TelegramBot } from "./telegram/bot.js";
import { HttpChannel } from "./channels/http.js";
import { McpServerChannel } from "./channels/mcp_server.js";
import { Arena } from "./arena/arena.js";
import { renderAsciiCard } from "./arena/card.js";
import { runSetupWizard } from "./setup/wizard.js";
import { encryptKeystore, saveKeystore, keystorePath, loadKeystore, keystoreStatus, type WalletSecret } from "./economy/keystore.js";
import { Wallet } from "./economy/wallet.js";
import { mnemonicToAccount } from "viem/accounts";
import { toHex } from "viem";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, isAbsolute } from "node:path";
import { verifyBundle } from "./verify/index.js";
import { renderTrailer, toVerifyBundle } from "./provenance/index.js";
import { OracleClient } from "./economy/oracles.js";
import { runVerb, listVerbs, toArtifact } from "./studio/index.js";
import { buildPassport, renderPassport, passportArtifact } from "./passport/index.js";
import { buildAttestation, verifyAttestation } from "./attest/index.js";
import { buildFrugalProof, toVerifiableArtifact, renderFrugalLine } from "./frugalproof/index.js";
import { decideMakeBuy, estimateInHouseUsd } from "./broker/index.js";
import { createHash } from "node:crypto";

const VERSION = "0.1.0";

/** Restricted file-write helper — only allows writes to cwd or stateDir. */
function safeWrite(dest: string, data: string, stateDir: string): void {
  const abs = resolve(dest);
  const cwd = resolve(process.cwd());
  const std = resolve(stateDir);
  if (!abs.startsWith(cwd + "/") && !abs.startsWith(std + "/") && abs !== cwd && abs !== std) {
    throw new Error(`Refusing to write outside cwd (${cwd}) or state dir (${std}): ${dest}`);
  }
  writeFileSync(abs, data);
}

interface Args {
  cmd: string;
  rest: string[];
  flags: Record<string, string | boolean>;
}

function parse(argv: string[]): Args {
  const a = argv.slice(2);
  const cmd = a[0] ?? "help";
  const rest: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 1; i < a.length; i++) {
    const t = a[i]!;
    if (t.startsWith("--")) {
      const key = t.slice(2);
      const next = a[i + 1];
      if (next && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else flags[key] = true;
    } else rest.push(t);
  }
  return { cmd, rest, flags };
}

export async function main(argv: string[]): Promise<number> {
  const args = parse(argv);
  if (args.flags.verbose) process.env.ARGUS_LOG_LEVEL = "debug";
  const log = createLogger("argus");
  const { config, path } = loadConfig(typeof args.flags.config === "string" ? args.flags.config : undefined);

  switch (args.cmd) {
    case "setup":
      return runSetupWizard();
    case "keystore":
      return cmdKeystore(config, args);
    case "ask":
      return cmdAsk(config, args);
    case "chat":
      return cmdChat(config, args);
    case "doctor":
      return cmdDoctor(config, path);
    case "warden":
      return cmdWarden(config, args);
    case "economy":
      return cmdEconomy(config, args);
    case "telegram":
      return cmdTelegram(config);
    case "serve":
      return cmdServe(config);
    case "mcp":
      return cmdMcp(config);
    case "flex":
      return cmdFlex(config);
    case "verify":
      return cmdVerify(args);
    case "oracle":
    case "studio":
      return cmdStudio(config, args);
    case "passport":
      return cmdPassport(config, args);
    case "broker":
      return cmdBroker(config, args);
    case "help":
    default:
      printHelp();
      return 0;
  }
}

// ── ask / chat ───────────────────────────────────────────────────────────────

async function cmdAsk(config: ArgusConfig, args: Args): Promise<number> {
  const task = args.rest.join(" ").trim();
  if (!task) {
    console.error('Usage: argus ask "your question"');
    return 2;
  }
  const log = createLogger("argus");
  const rt = await Runtime.create(config, log);
  if (!rt.router.available) {
    console.error("No LLM provider configured. Set an API key (e.g. ANTHROPIC_API_KEY) or run a local model (Ollama). Try `argus doctor`.");
    return 1;
  }
  const approve = makeApprover(Boolean(args.flags.yes));
  const agent = await rt.buildAgent(approve);
  const res = await agent.run(task);
  console.log(res.answer);
  console.error(`\n${renderTrailer(res.provenance)}`);
  console.error(`— ${meterLine(res.meter)} · ${res.outcome}`);
  if (typeof args.flags.provenance === "string") {
    const bundle = toVerifyBundle(res.provenance);
    safeWrite(args.flags.provenance, JSON.stringify(bundle, null, 2), config.stateDir);
    console.error(`provenance bundle → ${args.flags.provenance}  (re-check: argus verify ${args.flags.provenance})`);
  }
  // Defensive audit (read-side, no extra tokens): sealed consent + behavioral drift.
  const a = res.audit;
  if (a.approvals.count > 0) console.error(`consent · ${a.approvals.count} sealed approval(s) · chain ${a.approvals.intact ? "intact ✓" : "BROKEN ✕"}`);
  if (a.drift.length) console.error(`⚠ behavioral drift · ${a.drift.map((d) => `${d.tool}: ${d.reasons.join(", ")}`).join(" · ")}`);
  if (typeof args.flags.attest === "string") {
    const att = buildAttestation({ session: a.session });
    safeWrite(args.flags.attest, JSON.stringify(att, null, 2), config.stateDir);
    console.error(`negative attestation → ${args.flags.attest}  (claims: ${att.claims.join(", ") || "none"}; verifies: ${verifyAttestation(att)})`);
  }
  if (typeof args.flags.frugalproof === "string") {
    const m = res.meter;
    const client = new OracleClient(config.economy.oracleFamilyUrl, log.child("oracle"));
    const proof = await buildFrugalProof({
      snapshot: { tokensIn: m.inputTokens, tokensOut: m.outputTokens, steps: m.steps, costUsd: m.costUsd },
      taskHash: createHash("sha256").update(task).digest("hex"),
      modelTier: config.models.core.ref,
      client,
    });
    safeWrite(args.flags.frugalproof, JSON.stringify([toVerifiableArtifact(proof)], null, 2), config.stateDir);
    console.error(`${renderFrugalLine(proof)}  → ${args.flags.frugalproof}`);
  }
  await rt.dispose();
  return res.outcome === "failure" ? 1 : 0;
}

async function cmdChat(config: ArgusConfig, args: Args): Promise<number> {
  const log = createLogger("argus");
  const rt = await Runtime.create(config, log);
  if (!rt.router.available) {
    console.error("No LLM provider configured. Try `argus doctor`.");
    return 1;
  }
  const approve = makeApprover(Boolean(args.flags.yes));
  const agent = await rt.buildAgent(approve);
  const rl = createInterface({ input: stdin, output: stdout });
  console.log("ARGUS chat — Ctrl-D or 'exit' to quit.\n");
  try {
    for (;;) {
      const task = (await rl.question("you › ")).trim();
      if (!task) continue;
      if (task === "exit" || task === "quit") break;
      const res = await agent.run(task);
      console.log(`\nargus › ${res.answer}\n`);
      console.error(`${renderTrailer(res.provenance)}\n— ${meterLine(res.meter)}\n`);
    }
  } catch {
    /* EOF */
  } finally {
    rl.close();
    await rt.dispose();
  }
  return 0;
}

// ── telegram ─────────────────────────────────────────────────────────────────

function telegramEnabled(): boolean {
  const disabled = process.env.ARGUS_TELEGRAM_DISABLED;
  if (disabled === "1" || disabled?.toLowerCase() === "true") return false;
  return !!process.env.ARGUS_TELEGRAM_TOKEN?.trim();
}

async function cmdTelegram(config: ArgusConfig): Promise<number> {
  if (!telegramEnabled()) {
    console.error("Telegram is disabled (ARGUS_TELEGRAM_DISABLED) or ARGUS_TELEGRAM_TOKEN is unset.");
    return 1;
  }
  const token = process.env.ARGUS_TELEGRAM_TOKEN!.trim();
  const log = createLogger("argus");
  const rt = await Runtime.create(config, log);
  if (!rt.router.available) {
    console.error("No LLM provider configured. Try `argus doctor`.");
    return 1;
  }
  const ownerEnv = process.env.ARGUS_TELEGRAM_OWNER_ID?.trim();
  const ownerId = ownerEnv ? Number(ownerEnv) : config.telegram.ownerId;

  // The bot owns the sensitive-tool approval flow; wire it into the agent.
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

// ── flex (Agent Arena card) ──────────────────────────────────────────────────

async function cmdFlex(config: ArgusConfig): Promise<number> {
  const log = createLogger("argus", "error");
  const rt = await Runtime.create(config, log);
  const arena = new Arena(rt.memory, config, log, rt.economyEnabled);
  const s = await arena.stats();
  console.log(renderAsciiCard(s));
  console.error(`\nLevel ${s.level} · 🔥 ${s.streak} · ${Math.round(s.winRate * 100)}% win · ${s.tasks} tasks`);
  console.error(`Web card (wow): run \`argus serve\` → http://127.0.0.1:${config.http.port}/arena`);
  return 0;
}

// ── serve (multi-channel daemon) ─────────────────────────────────────────────

async function cmdServe(config: ArgusConfig): Promise<number> {
  const log = createLogger("argus");
  const rt = await Runtime.create(config, log);
  if (!rt.router.available) {
    console.error("No LLM provider configured. Try `argus doctor`.");
    return 1;
  }
  // One shared agent; each channel passes its own approval policy per task.
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

  const tgToken = telegramEnabled() ? process.env.ARGUS_TELEGRAM_TOKEN!.trim() : undefined;
  if (tgToken) {
    const ownerEnv = process.env.ARGUS_TELEGRAM_OWNER_ID?.trim();
    const ownerId = ownerEnv ? Number(ownerEnv) : config.telegram.ownerId;
    const bot = new TelegramBot({ token: tgToken, agent, arena, stateDir: config.stateDir, ownerId, log: log.child("telegram") });
    stoppers.push(() => bot.stop());
    longRunning.push(bot.run());
  } else {
    log.info(process.env.ARGUS_TELEGRAM_DISABLED ? "telegram disabled (ARGUS_TELEGRAM_DISABLED)" : "telegram disabled (no ARGUS_TELEGRAM_TOKEN)");
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
  if (longRunning.length === 0) await new Promise<void>(() => {}); // keep alive for HTTP-only
  else await Promise.all(longRunning);
  return 0;
}

// ── mcp (expose ARGUS as an MCP server over stdio) ───────────────────────────

async function cmdMcp(config: ArgusConfig): Promise<number> {
  // stdout is the MCP wire protocol — keep logs quiet and on stderr only.
  const log = createLogger("argus", "warn");
  const rt = await Runtime.create(config, log);
  if (!rt.router.available) {
    console.error("No LLM provider configured. Try `argus doctor`.");
    return 1;
  }
  const agent = await rt.buildAgent();
  const ch = new McpServerChannel({ agent, log: log.child("mcp-server") });
  await ch.start();
  await new Promise<void>(() => {}); // stay attached to stdio
  return 0;
}

// ── keystore (the vault) ─────────────────────────────────────────────────────

async function cmdKeystore(config: ArgusConfig, args: Args): Promise<number> {
  const sub = args.rest[0] ?? "create";
  const path = keystorePath(config.stateDir);

  if (sub === "address") {
    const ks = loadKeystore(path);
    if (!ks) {
      console.error(`No keystore at ${path}`);
      return 1;
    }
    console.log(ks.address ?? "(address not stored)");
    return 0;
  }
  if (sub !== "create" && sub !== "import") {
    console.error("Usage: argus keystore [create|import|address] [--force]");
    return 2;
  }
  if (loadKeystore(path) && !args.flags.force) {
    console.error(`Keystore already exists at ${path} — use --force to overwrite.`);
    return 1;
  }

  let pass = process.env.ARGUS_KEYSTORE_PASSPHRASE?.trim();
  let secret: WalletSecret;

  if (stdin.isTTY) {
    const rl = createInterface({ input: stdin, output: stdout });
    try {
      const wantImport = sub === "import" || (await rl.question("Generate a NEW wallet or IMPORT a seed? [new/import] (new): ")).trim().toLowerCase().startsWith("i");
      if (wantImport) {
        const m = (await rl.question("Enter your 12/24-word seed phrase: ")).trim();
        secret = secretFromMnemonic(m);
      } else {
        const w = Wallet.generate();
        secret = { mnemonic: w.mnemonic, privateKey: w.privateKey };
      }
      if (!pass) {
        const p1 = await rl.question("New keystore passphrase: ");
        const p2 = await rl.question("Repeat passphrase: ");
        if (!p1 || p1 !== p2) {
          console.error("passphrases empty or do not match.");
          return 1;
        }
        pass = p1;
      }
    } finally {
      rl.close();
    }
  } else {
    // Non-interactive (e.g. server migration): env-driven.
    if (!pass) {
      console.error("Non-interactive keystore create needs ARGUS_KEYSTORE_PASSPHRASE.");
      return 1;
    }
    const m = process.env.ARGUS_WALLET_MNEMONIC?.trim();
    const k = process.env.ARGUS_WALLET_KEY?.trim();
    if (m) {
      secret = secretFromMnemonic(m);
    } else if (k) {
      const pk = k.startsWith("0x") ? k : `0x${k}`;
      if (!/^0x[0-9a-fA-F]{64}$/.test(pk)) {
        console.error(`Invalid ARGUS_WALLET_KEY: must be a 64-char hex private key (got ${k.length} chars).`);
        return 1;
      }
      secret = { privateKey: pk };
    }
    else {
      const w = Wallet.generate();
      secret = { mnemonic: w.mnemonic, privateKey: w.privateKey };
    }
  }

  const address = new Wallet(secret.privateKey).address;
  saveKeystore(path, encryptKeystore(secret, pass, address));
  console.log(`✅ Encrypted keystore written: ${path} (mode 600)`);
  console.log(`   vault: post-quantum hybrid (ML-KEM-768 + ML-DSA-65 + AES-256-GCM)`);
  console.log(`   address: ${address}`);
  console.log("   The seed/key are stored ENCRYPTED — never in plaintext.");
  console.log("   Unlock at runtime by setting ARGUS_KEYSTORE_PASSPHRASE (env / secret manager).");
  console.log("   ⚠ Back up the passphrase — without it the keystore CANNOT be decrypted.");
  console.log("   You can now remove ARGUS_WALLET_KEY / ARGUS_WALLET_MNEMONIC from .env.");
  return 0;
}

function secretFromMnemonic(mnemonic: string): WalletSecret {
  const hd = mnemonicToAccount(mnemonic).getHdKey();
  if (!hd.privateKey) throw new Error("could not derive a private key from that seed phrase");
  return { mnemonic, privateKey: toHex(hd.privateKey) };
}

function keystoreLabel(stateDir: string): string {
  switch (keystoreStatus(stateDir)) {
    case "vault-pqc": return "🔒 PQC vault (ML-KEM-768 + ML-DSA-65, unlocked via ARGUS_KEYSTORE_PASSPHRASE)";
    case "vault": return "🔒 encrypted vault (v1 classical, unlocked via ARGUS_KEYSTORE_PASSPHRASE)";
    case "vault-locked": return "🔒 encrypted vault — LOCKED (set ARGUS_KEYSTORE_PASSPHRASE to unlock)";
    case "plaintext-env": return "⚠ plaintext ARGUS_WALLET_KEY (run `argus keystore create` to encrypt)";
    case "none": return "none (run `argus keystore create` to make an encrypted wallet)";
  }
}

// ── doctor ───────────────────────────────────────────────────────────────────

async function cmdDoctor(config: ArgusConfig, path?: string): Promise<number> {
  const log = createLogger("argus", "error");
  const rt = await Runtime.create(config, log);
  const w = rt.wallet();
  const lines = [
    "ARGUS doctor",
    `  config:     ${path ?? "(defaults — no argus.config.json found)"}`,
    `  mode:       ${config.mode}  (live=Base mainnet · uni=Universe sim · test=mocks)`,
    `  crypto:     ${config.cryptoEnabled ? "ENABLED (wallet/chain/payments on)" : "OFF — default; no blockchain required (ARGUS_CRYPTO_ENABLED=1 to enable)"}`,
    `  providers:  ${rt.router.list().join(", ") || "(none — set an API key or run Ollama)"}`,
    `  models:     core=${config.models.core.ref}  triage=${config.models.triage?.ref ?? "-"}  heavy=${config.models.heavy?.ref ?? "-"}`,
    `  budget:     $${config.budget.maxUsdPerTask}/task · ${config.budget.maxSteps} steps · ${config.budget.maxToolCalls} tools`,
    `  warden:     minRep=${config.warden.minReputation} blockAt=${config.warden.blockAtSeverity} pin=${config.warden.pinToolDefs} oracle=${config.warden.oracleFamilyUrl}`,
    `  mcp:        ${config.mcp.servers.length} server(s), ${config.mcp.catalogs.length} catalog(s)`,
    `  economy:    ${rt.economyEnabled ? `ON · wallet ${w?.short} · hub ${config.economy.hubUrl}` : "OFF (autonomous — no ARGUS_WALLET_KEY)"}`,
    `  keystore:   ${keystoreLabel(config.stateDir)}`,
    `  telegram:   ${process.env.ARGUS_TELEGRAM_TOKEN ? `token set · owner ${process.env.ARGUS_TELEGRAM_OWNER_ID ?? config.telegram.ownerId ?? "(TOFU: first /start)"}` : "off (no ARGUS_TELEGRAM_TOKEN)"}`,
    `  http:       ${config.http.enabled ? `:${config.http.port} · /ask ${process.env.ARGUS_HTTP_TOKEN ? "token-gated" : "disabled"}` : "off"}`,
    `  memory:     ${config.memory.dir}`,
  ];
  console.log(lines.join("\n"));
  await rt.dispose();
  return rt.router.available ? 0 : 1;
}

// ── warden scan ──────────────────────────────────────────────────────────────

async function cmdWarden(config: ArgusConfig, args: Args): Promise<number> {
  if (args.rest[0] !== "scan") {
    console.error("Usage: argus warden scan");
    return 2;
  }
  const log = createLogger("argus", "error");
  const rt = await Runtime.create(config, log);
  const servers = config.mcp.servers;
  if (!servers.length) {
    console.log("No MCP servers configured. Add them under mcp.servers in argus.config.json.");
    return 0;
  }
  console.log(`WARDEN scanning ${servers.length} server(s)…\n`);
  for (const s of servers) {
    try {
      const v = await rt.host.connect(s);
      console.log(`✓ ${s.name}  score ${v.score.toFixed(2)}  allow ${v.allowedTools.length}/${v.allowedTools.length + v.blockedTools.length} tools`);
      printFindings(v.findings);
    } catch (err: any) {
      const v = err?.verdict;
      if (v) {
        console.log(`✕ ${s.name}  BLOCKED by ${v.decidedBy}  score ${v.score.toFixed(2)}`);
        printFindings(v.findings);
      } else {
        console.log(`! ${s.name}  unreachable: ${err.message}`);
      }
    }
  }
  await rt.dispose();
  return 0;
}

function printFindings(findings: { severity: string; code: string; message: string; tool?: string }[]): void {
  for (const f of findings) {
    if (f.severity === "info") continue;
    console.log(`    [${f.severity}] ${f.code}${f.tool ? ` (${f.tool})` : ""}: ${f.message}`);
  }
}

// ── economy ──────────────────────────────────────────────────────────────────

async function cmdEconomy(config: ArgusConfig, args: Args): Promise<number> {
  const sub = args.rest[0] ?? "status";
  const log = createLogger("argus", "error");
  const rt = await Runtime.create(config, log);

  if (!rt.economyEnabled && sub !== "status") {
    console.error("Economy is OFF (no ARGUS_WALLET_KEY). ARGUS runs fully autonomously; set a wallet key to enable.");
    return 1;
  }

  switch (sub) {
    case "status": {
      const w = rt.wallet();
      console.log(rt.economyEnabled
        ? `economy ON · wallet ${w?.address} · hub ${config.economy.hubUrl} · ${config.economy.chain}/${config.economy.token}`
        : "economy OFF (autonomous). Set ARGUS_WALLET_KEY to enable paid discovery, invocation, and selling.");
      break;
    }
    case "discover": {
      const intent = args.rest.slice(1).join(" ");
      const budget = Number(args.flags.budget ?? config.economy.defaultDepositUsd);
      const caps = await rt.consumer()!.discover(intent, budget);
      if (!caps.length) console.log("No capabilities matched.");
      for (const c of caps) {
        console.log(`• ${c.name}  $${c.priceUsd}/call  trust ${c.trustScore ?? "?"}  [${c.capabilityId}]`);
        if (c.description) console.log(`    ${c.description}`);
      }
      break;
    }
    case "register": {
      const r = await rt.meshProvider()!.register();
      console.log(`registered: ${r.agentId} · trust ${r.trustScore} · ${r.status}`);
      break;
    }
    default:
      console.error("Usage: argus economy [status|discover <intent> --budget N|register]");
      return 2;
  }
  await rt.dispose();
  return 0;
}

// ── verify (offline, dependency-free proof re-verifier) ──────────────────────

async function cmdVerify(args: Args): Promise<number> {
  const file = args.rest[0];
  if (!file) {
    console.error("Usage: argus verify <bundle.json>     (or pipe JSON: … | argus verify -)");
    console.error("Re-checks ARGUS proof bundles LOCALLY — Ed25519 receipt signatures, sha256");
    console.error("commitments, WARDEN tool-def hashes. No network, no wallet. A failing proof");
    console.error("was a claim, not a proof.");
    return 2;
  }
  let raw: string;
  try {
    raw = readFileSync(file === "-" ? 0 : file, "utf8");
  } catch (err) {
    console.error(`cannot read ${file}: ${(err as Error).message}`);
    return 2;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    console.error(`not valid JSON: ${(err as Error).message}`);
    return 2;
  }
  const report = verifyBundle(parsed);
  for (const c of report.claims) console.log(`${c.ok ? "✓" : "✕"} ${c.label} — ${c.detail}`);
  const passed = report.claims.filter((c) => c.ok).length;
  console.log(`\n${report.ok ? "✅ all proofs verified" : "❌ verification FAILED"}  (${passed}/${report.claims.length})`);
  console.error("offline · no network · no wallet — re-checked locally with public keys + sha256");
  return report.ok ? 0 : 1;
}

// ── oracle studio (friendly verbs over all 11 oracles) ───────────────────────

async function cmdStudio(config: ArgusConfig, args: Args): Promise<number> {
  const log = createLogger("argus", "error");
  const sub = args.rest[0] ?? "list";
  if (sub === "list" || sub === "help") {
    console.log("Oracle Studio — verifiable math in one word. Verbs:\n");
    for (const v of listVerbs()) console.log(`  ${v.verb.padEnd(13)} ${v.capabilityId.padEnd(24)} ${v.desc}`);
    console.log('\nUsage: argus oracle <verb> [--json \'{"…":…}\'] [--proof out.json]');
    return 0;
  }
  let verbArgs: Record<string, unknown> = {};
  if (typeof args.flags.json === "string") {
    try {
      verbArgs = JSON.parse(args.flags.json) as Record<string, unknown>;
    } catch {
      console.error("--json must be a valid JSON object");
      return 2;
    }
  }
  const client = new OracleClient(config.economy.oracleFamilyUrl, log.child("oracle"));
  try {
    const r = await runVerb(client, sub, verbArgs);
    console.log(r.answer);
    console.error(`\n— oracle ${r.capabilityId}${r.priceUsd != null ? ` · $${r.priceUsd}` : " · free"}`);
    const art = toArtifact(r);
    if (art) {
      console.error("✓ signed, re-verifiable receipt");
      if (typeof args.flags.proof === "string") {
        safeWrite(args.flags.proof, JSON.stringify([art], null, 2), config.stateDir);
        console.error(`  proof → ${args.flags.proof}  (re-check: argus verify ${args.flags.proof})`);
      }
    } else {
      console.error("· receipt unavailable (offline) — answer is informational");
    }
    return 0;
  } catch (err) {
    const msg = (err as Error).message;
    if (/unknown studio verb/i.test(msg)) {
      console.error(msg);
      return 2; // genuine usage error
    }
    // Degrade, don't fail: an unreachable oracle (offline / crypto-off) is informational,
    // mirroring the agent loop's degrade-don't-throw posture.
    console.error(`· oracle unavailable (offline?) — ${msg}`);
    return 0;
  }
}

// ── passport (portable, verifiable reputation) ───────────────────────────────

async function cmdPassport(config: ArgusConfig, args: Args): Promise<number> {
  const log = createLogger("argus", "error");
  const rt = await Runtime.create(config, log);
  const arena = new Arena(rt.memory, config, log, rt.economyEnabled);
  const s = await arena.stats();
  const w = rt.wallet();

  const input: Parameters<typeof buildPassport>[0] = {
    handle: process.env.ARGUS_HANDLE?.trim() || "argus",
    arena: { level: s.level, streak: s.streak, winRate: s.winRate, tasks: s.tasks },
  };
  if (w) {
    input.address = w.address;
    const rep = await rt.oracle.scoreEntity(w.address); // no trust edges → degraded → stays unattested (honest)
    if (!rep.degraded) {
      input.lumenScore = rep.score;
      if (rep.percentile != null) input.lumenRank = `top ${Math.max(1, Math.round((1 - rep.percentile) * 100))}%`;
      if (rep.graphCommitment) input.graphCommitment = rep.graphCommitment;
    }
  }
  const p = buildPassport(input);
  console.log(renderPassport(p));
  const art = passportArtifact(p);
  if (art && typeof args.flags.proof === "string") {
    safeWrite(args.flags.proof, JSON.stringify([art], null, 2), config.stateDir);
    console.error(`\nproof → ${args.flags.proof}  (re-check: argus verify ${args.flags.proof})`);
  } else if (!p.attested) {
    console.error("\n· local · unattested — connect a wallet + LUMEN trust graph to make it re-verifiable");
  }
  await rt.dispose();
  return 0;
}

// ── broker (spend-to-save make/buy advice) ───────────────────────────────────

async function cmdBroker(config: ArgusConfig, args: Args): Promise<number> {
  const intent = args.rest.join(" ").trim();
  if (!intent) {
    console.error('Usage: argus broker "<intent>" [--budget N]');
    return 2;
  }
  const log = createLogger("argus", "error");
  const rt = await Runtime.create(config, log);
  const budget = Number(args.flags.budget ?? config.budget.maxUsdPerTask);
  const pricing = config.models.core.pricing ?? { inputPerM: 0, outputPerM: 0 };
  const inHouseUsd = estimateInHouseUsd(1500, 600, { inputPerMTok: pricing.inputPerM, outputPerMTok: pricing.outputPerM });

  let cheapest: { capabilityId: string; priceUsd: number; trustScore?: number } | null = null;
  const consumer = rt.consumer();
  if (consumer) {
    try {
      const caps = await consumer.discover(intent, budget);
      const top = [...caps].sort((x, y) => x.priceUsd - y.priceUsd)[0];
      if (top) {
        cheapest = { capabilityId: top.capabilityId, priceUsd: top.priceUsd };
        if (top.trustScore != null) cheapest.trustScore = top.trustScore;
      }
    } catch (err) {
      log.debug(`discover failed: ${(err as Error).message}`);
    }
  }

  const decision = decideMakeBuy({ inHouseUsd, cheapest, remainingUsd: budget });
  console.log(decision.line);
  console.error(
    `decision: ${decision.action} (${decision.reason}) · in-house ~$${inHouseUsd.toFixed(4)}` +
      (cheapest ? ` · cheapest ${cheapest.capabilityId} $${cheapest.priceUsd}` : " · no market (economy off or nothing matched)"),
  );
  await rt.dispose();
  return 0;
}

// ── helpers ──────────────────────────────────────────────────────────────────

function makeApprover(autoYes: boolean) {
  return async (req: ApprovalRequest): Promise<boolean> => {
    if (autoYes) return true;
    if (!stdin.isTTY) return false; // non-interactive: deny sensitive tools by default
    const rl = createInterface({ input: stdin, output: stdout });
    try {
      const where = req.server ? ` (server ${req.server})` : "";
      const ans = (await rl.question(`⚠ approve sensitive tool "${req.tool}"${where}? [y/N] `)).trim().toLowerCase();
      return ans === "y" || ans === "yes";
    } finally {
      rl.close();
    }
  };
}

function meterLine(m: MeterSnapshot): string {
  const cacheRate = m.inputTokens ? Math.round((m.cachedTokens / m.inputTokens) * 100) : 0;
  return `tok ${m.inputTokens}/${m.outputTokens} (cache ${cacheRate}%) · ${m.steps} steps · ${m.toolCalls} tools · $${m.costUsd.toFixed(4)}`;
}

function printHelp(): void {
  console.log(`ARGUS — wallet-native, security-hardened personal agent

Usage:
  argus setup                        interactive setup (wallet seed → provider/keys) — start here
  argus keystore create              create an encrypted wallet vault (new seed or --import)
  argus keystore address             print the vaulted wallet's public address
  argus ask "<task>"                 one-shot task
  argus chat                         interactive session
  argus doctor                       show config, providers, economy status
  argus serve                        run channels (HTTP /health + Telegram) — for Docker/servers
  argus telegram                     run only the owner-locked Telegram bot
  argus mcp                          expose ARGUS as an MCP server (stdio) for other agents/IDEs
  argus flex                         show your 🎮 Agent Arena card (web UI at /arena via serve)
  argus warden scan                  WARDEN-vet configured MCP servers
  argus verify <bundle.json>         offline-re-verify a proof bundle (no network/wallet)
  argus oracle <verb>                verifiable math in one word — Oracle Studio (try: oracle list)
  argus passport                     your portable, verifiable reputation card
  argus broker "<intent>"            make/buy advice — think locally vs buy a capability
  argus economy status               economy on/off + wallet
  argus economy discover "<intent>"  find paid capabilities (needs wallet)
  argus economy register             register this agent in the AI Service Mesh

Flags:
  --config <path>   use a specific config file
  --budget <usd>    budget for economy discovery
  --provenance <f>  (with ask) write the answer's verifiable proof bundle to a file
  --attest <f>      (with ask) write a signed negative attestation of the session
  --frugalproof <f> (with ask) write a verifiable cost receipt (oracle-anchored if reachable)
  --yes             auto-approve sensitive tools (use with care)
  --verbose         debug logging

ARGUS runs fully autonomously with no wallet. Set ARGUS_WALLET_KEY to connect to
the AICOM economy. See docs/ for architecture, security, and economy details.`);
}
