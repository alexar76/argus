import type { StudioVerb } from "../types.js";
import { arr, asRecord, fmt, num } from "../helpers.js";

export const landauerVerbs: Readonly<Record<string, StudioVerb>> = {
  "compute-floor": {
    capabilityId: "landauer.audit@v1",
    productId: "prod-landauer",
    desc: "Audit the thermodynamic energy floor of a computation (Landauer).",
    buildInput(args) {
      const input: Record<string, unknown> = { ops: arr(args.ops ?? args.gates ?? args.circuit) };
      if (args.temperature_k !== undefined || args.temperature !== undefined) {
        input.temperature_k = num(args.temperature_k ?? args.temperature, 300);
      }
      return input;
    },
    summarize(output) {
      const o = asRecord(output);
      const bits = o.irreversible_bits;
      const floor = num(o.energy_floor_j, NaN);
      const eff = num(o.efficiency, NaN);
      const bitsStr = bits === undefined ? "?" : String(bits);
      const floorStr = Number.isFinite(floor) ? `${floor.toExponential(3)} J` : "unknown";
      const effTail = Number.isFinite(eff) ? ` (thermodynamic efficiency ${fmt(eff * 100, 1)}%)` : "";
      return `Compute floor: ${bitsStr} irreversible bits → ≥ ${floorStr}${effTail}.`;
    },
  },
};
