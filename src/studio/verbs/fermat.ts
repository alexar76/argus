import type { StudioVerb } from "../types.js";
import { arr, asRecord, fmt, num } from "../helpers.js";

export const fermatVerbs: Readonly<Record<string, StudioVerb>> = {
  route: {
    capabilityId: "fermat.route@v1",
    productId: "prod-fermat",
    desc: "Compute the provably least-cost composition path through a service graph.",
    buildInput(args) {
      const input: Record<string, unknown> = {
        edges: arr(args.edges ?? args.links),
        start: args.start ?? args.from,
        goal: args.goal ?? args.to,
      };
      if (Array.isArray(args.nodes)) input.nodes = args.nodes;
      if (args.blend !== undefined && typeof args.blend === "object") input.blend = args.blend;
      return input;
    },
    summarize(output) {
      const o = asRecord(output);
      const reachable = o.reachable;
      const path = arr(o.path).map((x) => String(x));
      const total = num(o.total, NaN);
      if (reachable === false || path.length === 0) {
        return `No route from ${String(o.start ?? "?")} to ${String(o.goal ?? "?")} (unreachable).`;
      }
      const totStr = Number.isFinite(total) ? ` (total cost ${fmt(total)})` : "";
      return `Optimal route: ${path.join(" → ")}${totStr}, certified globally optimal.`;
    },
  },
};
