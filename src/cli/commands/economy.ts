import type { ArgusConfig } from "../../config.js";
import { createLogger } from "../../logger.js";
import { Runtime } from "../../runtime.js";
import type { Args } from "../args.js";

export async function cmdEconomy(config: ArgusConfig, args: Args): Promise<number> {
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
