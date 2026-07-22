import type { StudioVerb } from "../types.js";
import { arr, asRecord, fmt, intIn, num } from "../helpers.js";

export const lumenVerbs: Readonly<Record<string, StudioVerb>> = {
  trust: {
    capabilityId: "lumen.reputation@v1",
    productId: "prod-lumen",
    desc: "Score how much to trust each party from a who-trusts-whom graph.",
    buildInput(args) {
      const edges = arr(args.edges ?? args.trust ?? args.links).map((e) => {
        const t = arr(e);
        return [num(t[0], 0), num(t[1], 0), num(t[2], 1)] as [number, number, number];
      });
      let nodes = intIn(args.nodes ?? args.n, 0, 0, 1_000_000);
      if (nodes <= 0) {
        let max = -1;
        for (const e of edges) {
          if (e[0] > max) max = e[0];
          if (e[1] > max) max = e[1];
        }
        nodes = max + 1;
      }
      const input: Record<string, unknown> = { nodes, edges };
      if (args.damping !== undefined) input.damping = num(args.damping, 0.85);
      return input;
    },
    summarize(output) {
      const scores = arr(asRecord(output).scores).map((s) => num(s, 0));
      if (scores.length === 0) return "Trust scores unavailable (empty graph).";
      let bestI = 0;
      let bestV = scores[0] ?? 0;
      for (let i = 1; i < scores.length; i++) {
        const v = scores[i] ?? 0;
        if (v > bestV) {
          bestV = v;
          bestI = i;
        }
      }
      return `Trust ranked ${scores.length} parties; most-trusted is #${bestI} (PageRank mass ${fmt(bestV, 4)}).`;
    },
  },
};
