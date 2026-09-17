import type { ArgusConfig } from "../../config.js";
import { buildLotteryTools } from "../../economy/lottery.js";
import { createLogger } from "../../logger.js";
import { Runtime } from "../../runtime.js";
import type { Args } from "../args.js";

const LOTTERY_SUBS = new Set(["lottery-status", "lottery-enter"]);

export async function cmdEconomy(config: ArgusConfig, args: Args): Promise<number> {
  const sub = args.rest[0] ?? "status";
  const log = createLogger("argus", "error");
  const rt = await Runtime.create(config, log);

  if (!rt.economyEnabled && sub !== "status" && !LOTTERY_SUBS.has(sub)) {
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
    case "lottery-status":
    case "lottery-enter": {
      if (!rt.chain) {
        console.error("No chain context. UNI: ARGUS_MODE=uni. Live: AIFACTORY_CRYPTO_ENABLED=1.");
        return 1;
      }
      const name = sub === "lottery-enter" ? "lottery_enter" : "lottery_status";
      const tool = buildLotteryTools(rt.chain, log).find((t) => t.def.name === name)!;
      const r = await tool.run({}, { log, approved: true });
      console.log(r.content);
      if (r.data) console.log(JSON.stringify(r.data));
      await rt.dispose();
      return r.ok ? 0 : 1;
    }
    default:
      console.error("Usage: argus economy [status|discover <intent> --budget N|register|lottery-status|lottery-enter]");
      return 2;
  }
  await rt.dispose();
  return 0;
}
