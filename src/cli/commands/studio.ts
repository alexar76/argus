import type { ArgusConfig } from "../../config.js";
import { createLogger } from "../../logger.js";
import { OracleClient } from "../../economy/oracles.js";
import { runVerb, listVerbs, toArtifact } from "../../studio/index.js";
import type { Args } from "../args.js";
import { safeWrite } from "../util.js";

export async function cmdStudio(config: ArgusConfig, args: Args): Promise<number> {
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
      return 2;
    }
    console.error(`· oracle unavailable (offline?) — ${msg}`);
    return 0;
  }
}
