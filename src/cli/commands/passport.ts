import type { ArgusConfig } from "../../config.js";
import { createLogger } from "../../logger.js";
import { Runtime } from "../../runtime.js";
import { Arena } from "../../arena/arena.js";
import { buildPassport, renderPassport, passportArtifact } from "../../passport/index.js";
import type { Args } from "../args.js";
import { safeWrite } from "../util.js";

export async function cmdPassport(config: ArgusConfig, args: Args): Promise<number> {
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
    const rep = await rt.oracle.scoreEntity(w.address);
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
