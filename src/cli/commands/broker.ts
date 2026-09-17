import type { ArgusConfig } from "../../config.js";
import { createLogger } from "../../logger.js";
import { Runtime } from "../../runtime.js";
import { decideMakeBuy, estimateInHouseUsd } from "../../broker/index.js";
import type { Args } from "../args.js";

export async function cmdBroker(config: ArgusConfig, args: Args): Promise<number> {
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
