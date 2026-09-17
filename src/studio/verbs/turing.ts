import type { StudioVerb } from "../types.js";
import { arr, asRecord, fmt, intIn, num } from "../helpers.js";

export const turingVerbs: Readonly<Record<string, StudioVerb>> = {
  "blue-noise": {
    capabilityId: "turing.bluenoise@v1",
    productId: "prod-turing",
    desc: "Generate blue-noise (evenly-spaced, no clumps) sample points.",
    buildInput(args) {
      const count = intIn(args.count ?? args.n ?? args.points, 256, 1, 100000);
      const input: Record<string, unknown> = { count };
      if (args.candidates !== undefined) input.candidates = intIn(args.candidates, 10, 1, 1000);
      if (args.seed !== undefined && args.seed !== null) input.seed = intIn(args.seed, 0, 0, Number.MAX_SAFE_INTEGER);
      return input;
    },
    summarize(output) {
      const o = asRecord(output);
      const count = num(o.count, arr(o.points).length);
      const minD = num(o.min_distance, NaN);
      const dTail = Number.isFinite(minD) ? `, min spacing ${fmt(minD)}` : "";
      return `Blue-noise sample: ${fmt(count)} evenly-spaced points${dTail}.`;
    },
  },
};
