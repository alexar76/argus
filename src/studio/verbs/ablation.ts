import type { StudioVerb } from "../types.js";
import { arr, asRecord, field, fmt, intIn, num } from "../helpers.js";

export const ablationVerbs: Readonly<Record<string, StudioVerb>> = {
  cascade: {
    capabilityId: "ablation.cascade@v1",
    productId: "prod-ablation",
    desc: "Estimate systemic cascade / contagion risk of an exposure graph.",
    buildInput(args) {
      const input: Record<string, unknown> = { edges: arr(args.edges ?? args.links) };
      if (Array.isArray(args.nodes)) input.nodes = args.nodes;
      if (args.capacities && typeof args.capacities === "object") input.capacities = args.capacities;
      if (args.grains !== undefined) input.grains = intIn(args.grains, 4000, 1, 1_000_000);
      return input;
    },
    summarize(output) {
      const o = asRecord(output);
      const tau = num(o.tau, NaN);
      const meanA = num(o.mean_avalanche, NaN);
      const trigger = field(arr(o.triggers)[0], "node");
      const heavy = Number.isFinite(tau) && tau < 2 ? "HEAVY-tailed (one default ripples wide)" : "bounded tail";
      const tauStr = Number.isFinite(tau) ? `power-law tau ${fmt(tau, 3)} — ${heavy}` : "tail unknown";
      const trigTail = trigger !== undefined ? `; top trigger ${String(trigger)}` : "";
      const meanTail = Number.isFinite(meanA) ? `; mean cascade ${fmt(meanA, 2)}` : "";
      return `Cascade risk: ${tauStr}${meanTail}${trigTail}.`;
    },
  },
};
