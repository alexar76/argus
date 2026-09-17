import type { StudioVerb } from "../types.js";
import { arr, asRecord, fmt, intIn, num } from "../helpers.js";

export const murmurationVerbs: Readonly<Record<string, StudioVerb>> = {
  aggregate: {
    capabilityId: "murmuration.aggregate@v1",
    productId: "prod-murmuration",
    desc: "Combine many estimates into one outlier-resistant consensus number.",
    buildInput(args) {
      const raw = arr(args.values ?? args.estimates ?? args.numbers);
      const values = raw.map((v) => num(v, NaN)).filter((n) => Number.isFinite(n));
      const input: Record<string, unknown> = { values };
      if (args.trim !== undefined) input.trim = Math.max(0, Math.min(0.499, num(args.trim, 0.1)));
      return input;
    },
    summarize(output) {
      const o = asRecord(output);
      const n = o.n;
      const median = num(o.median, NaN);
      const biweight = num(o.biweight, NaN);
      const consensus = num(o.converged_value, biweight);
      const nStr = n === undefined ? "?" : String(n);
      return `Robust consensus over ${nStr} estimates: ${fmt(consensus)} (median ${fmt(median)}, biweight ${fmt(biweight)}).`;
    },
  },
};
