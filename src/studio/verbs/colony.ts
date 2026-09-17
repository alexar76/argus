import type { StudioVerb } from "../types.js";
import { arr, asRecord, fmt, intIn, num } from "../helpers.js";

export const colonyVerbs: Readonly<Record<string, StudioVerb>> = {
  optimize: {
    capabilityId: "colony.optimize@v1",
    productId: "prod-colony",
    desc: "Find the cheapest tour over points, with a proven optimality gap.",
    buildInput(args) {
      const pts = arr(args.points ?? args.coords ?? args.stops).map((p) => {
        const pair = arr(p);
        return [num(pair[0], 0), num(pair[1], 0)] as [number, number];
      });
      const input: Record<string, unknown> = { points: pts };
      if (args.iterations !== undefined) input.iterations = intIn(args.iterations, 1000, 1, 1_000_000);
      return input;
    },
    summarize(output) {
      const o = asRecord(output);
      const length = num(o.length, NaN);
      const gap = num(o.gap, NaN);
      const n = o.n;
      const nStr = n === undefined ? "?" : String(n);
      const gapPct = Number.isFinite(gap) ? `${fmt(gap * 100, 2)}% from optimal` : "gap unknown";
      return `Cheapest tour over ${nStr} points: length ${fmt(length)} (at most ${gapPct}).`;
    },
  },
};
