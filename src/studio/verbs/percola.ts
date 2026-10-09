import type { StudioVerb } from "../types.js";
import { arr, asRecord, field, fmt, intIn, labels, num } from "../helpers.js";

export const percolaVerbs: Readonly<Record<string, StudioVerb>> = {
  resilience: {
    capabilityId: "percola.threshold@v1",
    productId: "prod-percola",
    desc: "Find the attack fraction at which a network shatters (percolation).",
    buildInput(args) {
      const edges = arr(args.edges ?? args.links).map((e) => {
        const t = arr(e);
        return [t[0] ?? 0, t[1] ?? 0] as [unknown, unknown];
      });
      const input: Record<string, unknown> = { edges };
      const nodes = args.nodes;
      if (Array.isArray(nodes)) input.nodes = nodes;
      if (args.attack !== undefined) input.attack = String(args.attack);
      if (args.samples !== undefined) input.samples = intIn(args.samples, 50, 2, 10000);
      return input;
    },
    summarize(output) {
      const o = asRecord(output);
      const robustness = num(o.robustness, NaN);
      const fc = num(field(o.targeted, "f_c"), NaN);
      const keystones = labels(field(o.targeted, "keystones"), 3);
      const fcStr = Number.isFinite(fc) ? `${fmt(fc * 100, 1)}% of nodes removed` : "threshold unknown";
      const ksTail = keystones ? `; keystones: ${keystones}` : "";
      const robTail = Number.isFinite(robustness) ? ` (robustness ${fmt(robustness, 3)})` : "";
      return `Network shatters at ~${fcStr}${robTail}${ksTail}.`;
    },
  },
};
