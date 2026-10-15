import type { StudioVerb } from "../types.js";
import { arr, asRecord, fmt, intIn, labels, num } from "../helpers.js";

export const latticeVerbs: Readonly<Record<string, StudioVerb>> = {
  "even-coverage": {
    capabilityId: "lattice.sequence@v1",
    productId: "prod-lattice",
    desc: "Generate evenly-spread (low-discrepancy) space-filling points.",
    buildInput(args) {
      const count = intIn(args.count ?? args.n ?? args.points, 256, 1, 65536);
      const dim = intIn(args.dim ?? args.dimensions ?? args.d, 2, 1, 64);
      const skip = intIn(args.skip ?? args.offset, 0, 0, 1_000_000);
      return { count, dim, skip };
    },
    summarize(output) {
      const o = asRecord(output);
      const count = num(o.count, arr(o.points).length);
      const dim = num(o.dim, 2);
      const bases = labels(o.bases, 4);
      const tail = bases ? ` (Halton bases ${bases})` : "";
      return `Even coverage: ${fmt(count)} low-discrepancy points in ${fmt(dim)}-D${tail}.`;
    },
  },
};
