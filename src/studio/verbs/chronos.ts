import type { StudioVerb } from "../types.js";
import { asRecord, field, intIn, num } from "../helpers.js";

export const chronosVerbs: Readonly<Record<string, StudioVerb>> = {
  elapsed: {
    capabilityId: "chronos.eval@v1",
    productId: "prod-chronos",
    desc: "Prove a fixed amount of sequential time elapsed (Wesolowski VDF).",
    buildInput(args) {
      const seed = args.seed ?? args.label ?? "";
      const difficulty = intIn(args.difficulty ?? args.steps ?? args.work, 100000, 1, 100_000_000);
      return { seed: String(seed), difficulty };
    },
    summarize(output) {
      const o = asRecord(output);
      const difficulty = o.difficulty;
      const valid = field(o.proof, "pi") !== undefined || o.y !== undefined;
      const d = difficulty === undefined ? "?" : String(difficulty);
      return valid
        ? `Elapsed proof: ${d} sequential squarings, verifiable without re-running the work.`
        : `Elapsed proof produced (difficulty ${d}).`;
    },
  },
};
