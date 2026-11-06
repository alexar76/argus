import type { Logger } from "./types.js";
import type { ArgusConfig } from "./config.js";
import { egressPosture, productionMode } from "./config.js";
import { JsonMemoryStore, expandHome } from "./memory/store.js";
import { LessonDistiller } from "./memory/lessons.js";
import { createInjectionClassifier } from "./memory/classifier.js";
import { LumenOracle } from "./economy/lumen.js";
import { EgressGuard, ThreatFeed, Warden } from "@aimarket/warden";
import { ProviderRouter } from "./providers/router.js";
import { McpHost, WardenBlockedError, type McpServerState } from "./mcp/host.js";
import { notifyOwnerWhenReady } from "./channels/owner-notify.js";
import { CatalogConnector } from "./mcp/catalog.js";
import { buildBuiltinTools } from "./tools/builtin.js";
import { buildEcosystemTools } from "./tools/ecosystem.js";
import { buildChainContext, shouldBuildChainContext, type ChainContext } from "./ecosystem/networks.js";
import { Agent, type ApproveFn, type RunResult } from "./core/agent.js";
import { AimarketConsumer } from "./economy/aimarket.js";
import { AgentKey, MandateCredential } from "./economy/aimarket-mandate.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MeshProvider } from "./economy/mesh.js";
import { Wallet } from "./economy/wallet.js";
import type { Hex } from "viem";
import {
  buildMonitorRunPayload,
  MonitorFeed,
  WardenBlockBuffer,
} from "./monitor/index.js";

/**
 * Wires the five layers into one object. The key design point: the economy layer
 * is constructed ONLY when a wallet is present. With no wallet, `consumer()` and
 * `meshProvider()` return null and ARGUS is a fully autonomous local assistant.
 */
export class Runtime {
  readonly memory: JsonMemoryStore;
  readonly router: ProviderRouter;
  readonly warden: Warden;
  readonly host: McpHost;
  readonly oracle: LumenOracle;
  readonly chain: ChainContext | null;
  private _wallet: Wallet | null = null;
  /** MCP WARDEN blocks since last monitor push — scoped to this runtime instance. */
  readonly wardenBlocks = new WardenBlockBuffer();
  /** When the owner was last told that a server got blocked while running (see connectMcp). */
  private readonly blockNotedAt = new Map<string, number>();
  readonly monitorFeed: MonitorFeed;
  /** The loaded threat feed, for a reviewer Warden that shares it (argus warden pins). */
  readonly threatFeed: ThreatFeed;

  private constructor(
    readonly config: ArgusConfig,
    readonly log: Logger,
    deps: { memory: JsonMemoryStore; router: ProviderRouter; warden: Warden; host: McpHost; oracle: LumenOracle; chain: ChainContext | null; threatFeed: ThreatFeed },
  ) {
    this.memory = deps.memory;
    this.router = deps.router;
    this.warden = deps.warden;
    this.host = deps.host;
    this.oracle = deps.oracle;
    this.chain = deps.chain;
    this.threatFeed = deps.threatFeed;
    this.monitorFeed = new MonitorFeed(config.monitor, log.child("monitor"), config.stateDir, {
      version: process.env.npm_package_version || "0.0.0",
      mode: config.mode,
      economy: config.cryptoEnabled && config.economy.enabled ? "on" : "off",
      displayName: process.env.ARGUS_DISPLAY_NAME || undefined,
      host: process.env.ARGUS_HOST || process.env.HOSTNAME || undefined,
      wallet: (() => {
        try {
          return config.economy.walletKey ? new Wallet(config.economy.walletKey).address : undefined;
        } catch {
          return undefined;
        }
      })(),
    });
  }

  static async create(config: ArgusConfig, log: Logger): Promise<Runtime> {
    const memory = new JsonMemoryStore(config.memory.dir);
    const oracle = new LumenOracle({ oracleFamilyUrl: config.warden.oracleFamilyUrl, log: log.child("lumen") });
    const threatFeed = new ThreatFeed({
      feedPublicKey: config.warden.feedPublicKey,
      maxAgeMs: config.warden.feedMaxAgeMs,
      // The documented config says "~/.argus/memory"; fs would create a literal ./~ directory.
      stateDir: join(expandHome(config.memory.dir), "warden"),
      log: log.child("threat-feed"),
    });
    await threatFeed.load(config.warden.threatFeedUrl);
    const warden = Warden.create({ store: memory, policy: config.warden, threatFeed, log: log.child("warden") });
    const router = new ProviderRouter(config, log.child("router"));
    const host = new McpHost(warden, config.warden, log.child("mcp"), undefined, {
      settings: config.mcp.sandbox,
      stateDir: config.stateDir,
      memoryDir: config.memory.dir,
      configPath: config.configPath,
      production: productionMode(),
    });
    // A chain context is built for UNI (a private/local Anvil chain — the default
    // value layer, independent of the PUBLIC-crypto switch) and for live ONLY when
    // crypto is on (so the default never touches Base mainnet). `test` mode → none.
    // UNI is play money, so the wallet (if any) is used there too; on a UNI chain it
    // operates on local Anvil, never on real Base funds.
    const chain = shouldBuildChainContext(config.mode, config.cryptoEnabled)
      ? buildChainContext({ mode: config.mode, walletKey: config.economy.walletKey, log: log.child("chain") })
      : null;
    return new Runtime(config, log, { memory, router, warden, host, oracle, chain, threatFeed });
  }

  get economyEnabled(): boolean {
    return this.config.economy.enabled && (Boolean(this.config.economy.walletKey) || this.mandate() !== null);
  }

  /** How paid calls are paid: "mandate" (the owner's account, the owner's limits), "channel"
   *  (ARGUS's own wallet) or "off". A mandate wins when both are configured: it is the rail
   *  with limits someone other than ARGUS signed. */
  get paymentRail(): "mandate" | "channel" | "off" {
    if (!this.config.economy.enabled) return "off";
    if (this.mandate()) return "mandate";
    return this.config.economy.walletKey ? "channel" : "off";
  }

  private _mandate: MandateCredential | null | undefined;

  /** The owner-signed mandate ARGUS pays with, or null. Throws when one is configured but
   *  unusable — a broken mandate must not silently fall back to spending from a wallet. */
  mandate(): MandateCredential | null {
    if (this._mandate !== undefined) return this._mandate;
    const e = this.config.economy;
    if (!e.mandateFile || !e.agentKeySeedHex) return (this._mandate = null);
    let document: Record<string, unknown>;
    try {
      document = JSON.parse(readFileSync(e.mandateFile, "utf8")) as Record<string, unknown>;
    } catch (err) {
      throw new Error(`ARGUS_MANDATE_FILE ${e.mandateFile} is not readable JSON: ${(err as Error).message}`);
    }
    this._mandate = new MandateCredential(document, AgentKey.fromSeedHex(e.agentKeySeedHex), e.hubUrl);
    return this._mandate;
  }

  wallet(): Wallet | null {
    if (!this.config.economy.walletKey) return null;
    if (!this._wallet) this._wallet = new Wallet(this.config.economy.walletKey);
    return this._wallet;
  }

  /** Demand-side client, or null when running autonomously (no wallet). */
  consumer(): AimarketConsumer | null {
    if (!this.economyEnabled) return null;
    const e = this.config.economy;
    return new AimarketConsumer({
      hubUrl: e.hubUrl,
      walletKey: e.walletKey ?? "",
      mandate: this.mandate() ?? undefined,
      affiliate: e.affiliate,
      verifyTee: e.verifyTee,
      verifyOutputs: e.verifyOutputs,
      defaultDepositUsd: e.defaultDepositUsd,
      minHubTrust: e.minHubTrust,
      token: e.token,
      chain: e.chain,
      log: this.log.child("aimarket"),
    });
  }

  /** Supply-side client, or null when running autonomously (no wallet). */
  meshProvider(): MeshProvider | null {
    const w = this.wallet();
    if (!w) return null;
    return new MeshProvider({
      meshUrl: this.config.economy.meshUrl,
      name: "argus",
      evmAddress: w.address,
      log: this.log.child("mesh"),
    });
  }

  /** Connect + WARDEN-vet all configured + catalog-discovered MCP servers. */
  async connectMcp(): Promise<{ connected: number; blocked: number }> {
    const catalog = new CatalogConnector(this.log.child("catalog"));
    const discovered = this.config.mcp.catalogs.length ? await catalog.fetchAll(this.config.mcp.catalogs) : [];
    const servers = [...this.config.mcp.servers, ...discovered];
    let connected = 0;
    let blocked = 0;
    for (const s of servers) {
      try {
        await this.host.connect(s);
        connected += 1;
      } catch (err) {
        if (err instanceof WardenBlockedError) {
          blocked += 1;
          this.wardenBlocks.record(err.server.name, err.verdict);
        } else this.log.warn(`could not connect "${s.name}": ${(err as Error).message}`);
      }
    }
    const refused = this.host.serverStates().filter((st) => st.state === "blocked");
    if (refused.length) this.reportBlocked(refused);
    // From here on, a server whose tools change under it is reported as it happens. At startup one
    // message covers them all.
    this.host.onBlocked = (st) => {
      // A tool list that flaps would otherwise message the owner on every flip; the log keeps them all.
      const last = this.blockNotedAt.get(st.id) ?? 0;
      const quiet = Date.now() - last < BLOCK_NOTE_QUIET_MS;
      if (!quiet) this.blockNotedAt.set(st.id, Date.now());
      this.reportBlocked([st], !quiet);
    };
    return { connected, blocked };
  }

  /** Error log, and the owner once the Telegram channel is up; without a channel the log line is all there is. */
  private reportBlocked(states: McpServerState[], tellOwner = true): void {
    this.log.error(`WARDEN blocked ${states.length} MCP server(s); running without their tools: ` +
      states.map((st) => `${st.id}${st.source === "catalog" ? " (catalog)" : ""} (${st.reasons.join(", ") || "policy"})`).join("; "));
    if (tellOwner) notifyOwnerWhenReady({ text: blockedServersNote(states) });
  }

  /** Every MCP server this runtime was asked to use, and whether it got to. */
  mcpStates(): McpServerState[] {
    return this.host.serverStates();
  }

  async buildAgent(approve?: ApproveFn): Promise<Agent> {
    await this.connectMcp();
    const classifier = createInjectionClassifier({
      chat: async (prompt) => {
        const res = await this.router.chat("triage", {
          messages: [{ role: "user", content: prompt }],
          maxTokens: 16,
        });
        return res.content;
      },
      log: this.log.child("classifier"),
    });
    const distiller = new LessonDistiller({
      store: this.memory,
      log: this.log.child("lessons"),
      classifier,
    });
    // Native, trusted ecosystem tools (oracles/lottery/acex/hub) sit between the
    // built-ins and the firewalled third-party MCP tools.
    const ecosystem = buildEcosystemTools({
      cryptoEnabled: this.config.cryptoEnabled,
      chain: this.chain,
      oracleFamilyUrl: this.config.economy.oracleFamilyUrl,
      consumer: this.consumer(),
      acexEnabled: this.config.economy.acexEnabled,
      defaultBudgetUsd: this.config.economy.defaultDepositUsd,
      minHubTrust: this.config.economy.minHubTrust,
      esim: {
        seller: this.config.economy.esimSeller,
        hubs: this.config.economy.esimHubs,
        shareDeliveries: this.config.economy.shareDeliveries,
        maxUsd: this.config.economy.esimMaxUsd,
        walletKey: () => (this.wallet()?.privateKey as Hex | undefined) ?? null,
        stateDir: this.config.stateDir,
      },
      log: this.log,
    });
    // config.egressPosture is the single definition — `doctor` prints the same call.
    const posture = egressPosture(this.config);
    const egress = posture.gated ? new EgressGuard(posture.allowlist) : undefined;
    const tools = [
      ...buildBuiltinTools({ memory: this.memory, log: this.log, egress }),
      ...ecosystem,
      ...this.host.bridgedTools(),
    ];
    const monitor = this.config.monitor;
    const signerAddress = this.wallet()?.address;
    if (signerAddress) {
      this.monitorFeed.setIdentity({
        wallet: signerAddress,
        economy: this.config.cryptoEnabled ? "on" : "off",
      });
    }
    const onRunComplete =
      this.monitorFeed.enabled()
        ? async (task: string, result: RunResult) => {
            const payload = buildMonitorRunPayload({
              task,
              result,
              wardenBlocks: this.wardenBlocks.peek(),
              signerAddress,
            });
            await this.monitorFeed.push(payload);
            this.wardenBlocks.drain();
          }
        : undefined;
    return new Agent({
      router: this.router,
      tools,
      memory: this.memory,
      config: this.config,
      log: this.log,
      approve,
      distiller,
      onRunComplete,
    });
  }

  async dispose(): Promise<void> {
    await this.host.closeAll();
  }
}

const BLOCK_NOTE_QUIET_MS = 60 * 60 * 1000;

/** Codes that `argus warden pins approve` resolves, when every other gate passes. */
const APPROVABLE = new Set(["TOOL_DEF_DRIFT", "PIN_FORMAT_UPGRADE_REQUIRED", "SERVER_IDENTITY_DRIFT"]);

/**
 * The owner's message about servers WARDEN refused. Configured servers are named, with their WARDEN
 * codes; servers a remote catalog listed are only counted, because their ids are text the catalog
 * chose. The approve command is offered only where it applies: a configured server, an id that needed
 * no cleaning, and a pin problem as the reason.
 */
export function blockedServersNote(states: McpServerState[]): string {
  const own = states.filter((s) => s.source === "config");
  const listed = states.length - own.length;
  const lines = [`WARDEN blocked ${states.length} MCP server(s). ARGUS is running without their tools.`];
  for (const s of own) lines.push(`• ${s.id}: ${s.reasons.join(", ") || "blocked by policy"}`);
  if (listed) lines.push(`• ${listed} server(s) from a remote catalog`);
  const approvable = own.filter((s) => !s.id.includes("?") && s.reasons.length > 0 && s.reasons.every((r) => APPROVABLE.has(r)));
  if (approvable.length) {
    lines.push(
      "Their approved tool definitions or launch settings changed. Review and re-approve at a terminal on this host, then restart ARGUS:",
      ...approvable.map((s) => `argus warden pins approve ${s.id}`),
    );
  }
  if (approvable.length < states.length) lines.push("For the others, see the findings with: argus warden scan");
  return lines.join("\n");
}
