import type { ArgusConfig } from "../../config.js";
import { createLogger } from "../../logger.js";
import { Runtime } from "../../runtime.js";
import { keystoreLabel } from "./keystore.js";

export async function cmdDoctor(config: ArgusConfig, path?: string): Promise<number> {
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
