import type { Logger } from "./types.js";
import type { ArgusConfig } from "./config.js";
import { JsonMemoryStore } from "./memory/store.js";
import { LessonDistiller } from "./memory/lessons.js";
import { createInjectionClassifier } from "./memory/classifier.js";
import { LumenOracle } from "./economy/lumen.js";
import { ThreatFeed, Warden } from "./warden/index.js";
import { ProviderRouter } from "./providers/router.js";
import { McpHost, WardenBlockedError } from "./mcp/host.js";
import { CatalogConnector } from "./mcp/catalog.js";
import { buildBuiltinTools } from "./tools/builtin.js";
import { buildEcosystemTools } from "./tools/ecosystem.js";
import { buildChainContext, shouldBuildChainContext, type ChainContext } from "./ecosystem/networks.js";
import { Agent, type ApproveFn } from "./core/agent.js";
import { AimarketConsumer } from "./economy/aimarket.js";
import { MeshProvider } from "./economy/mesh.js";
import { Wallet } from "./economy/wallet.js";

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

  private constructor(
    readonly config: ArgusConfig,
    readonly log: Logger,
    deps: { memory: JsonMemoryStore; router: ProviderRouter; warden: Warden; host: McpHost; oracle: LumenOracle; chain: ChainContext | null },
  ) {
    this.memory = deps.memory;
    this.router = deps.router;
    this.warden = deps.warden;
    this.host = deps.host;
    this.oracle = deps.oracle;
    this.chain = deps.chain;
  }

  static async create(config: ArgusConfig, log: Logger): Promise<Runtime> {
    const memory = new JsonMemoryStore(config.memory.dir);
    const oracle = new LumenOracle({ oracleFamilyUrl: config.warden.oracleFamilyUrl, log: log.child("lumen") });
    const threatFeed = new ThreatFeed({ feedPublicKey: config.warden.feedPublicKey, log: log.child("threat-feed") });
    await threatFeed.load(config.warden.threatFeedUrl);
    const warden = Warden.create({ oracle, store: memory, policy: config.warden, threatFeed, log: log.child("warden") });
    const router = new ProviderRouter(config, log.child("router"));
    const host = new McpHost(warden, config.warden, log.child("mcp"));
    // A chain context is built for UNI (a private/local Anvil chain — the default
    // value layer, independent of the PUBLIC-crypto switch) and for live ONLY when
    // crypto is on (so the default never touches Base mainnet). `test` mode → none.
    // UNI is play money, so the wallet (if any) is used there too; on a UNI chain it
    // operates on local Anvil, never on real Base funds.
    const chain = shouldBuildChainContext(config.mode, config.cryptoEnabled)
      ? buildChainContext({ mode: config.mode, walletKey: config.economy.walletKey, log: log.child("chain") })
      : null;
    return new Runtime(config, log, { memory, router, warden, host, oracle, chain });
  }

  get economyEnabled(): boolean {
    return this.config.economy.enabled && Boolean(this.config.economy.walletKey);
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
      walletKey: e.walletKey!,
      affiliate: e.affiliate,
      verifyTee: e.verifyTee,
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
        if (err instanceof WardenBlockedError) blocked += 1;
        else this.log.warn(`could not connect "${s.name}": ${(err as Error).message}`);
      }
    }
    return { connected, blocked };
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
      log: this.log,
    });
    const tools = [
      ...buildBuiltinTools({ memory: this.memory, log: this.log }),
      ...ecosystem,
      ...this.host.bridgedTools(),
    ];
    return new Agent({
      router: this.router,
      tools,
      memory: this.memory,
      config: this.config,
      log: this.log,
      approve,
      distiller,
    });
  }

  async dispose(): Promise<void> {
    await this.host.closeAll();
  }
}
