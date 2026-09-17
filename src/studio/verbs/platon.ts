import type { StudioVerb } from "../types.js";
import { arr, field } from "../helpers.js";

export const platonVerbs: Readonly<Record<string, StudioVerb>> = {
  coin: {
    capabilityId: "platon.random@v1",
    productId: "prod-platon",
    desc: "Flip a provably-fair coin (signed VRF, not Math.random).",
    buildInput(args) {
      const input: Record<string, unknown> = { num_bytes: 1 };
      const seed = args.seed ?? args.client_seed;
      if (seed !== undefined && seed !== null) input.client_seed = String(seed);
      return input;
    },
    summarize(output) {
      const hex = String(field(output, "random_hex") ?? "");
      const first = hex.slice(0, 2);
      const byte = first ? parseInt(first, 16) : NaN;
      if (!Number.isFinite(byte)) return "Coin flip unavailable (no randomness in output).";
      const side = (byte & 1) === 0 ? "HEADS" : "TAILS";
      return `Fair coin: ${side} (verifiable VRF draw 0x${first}).`;
    },
  },

  winner: {
    capabilityId: "platon.random@v1",
    productId: "prod-platon",
    desc: "Pick a fair winner among choices using a signed VRF draw.",
    buildInput(args) {
      const choices = arr(args.choices ?? args.options ?? args.entries);
      const seedParts = [args.seed, ...choices.map((c) => String(c))].filter(
        (s) => s !== undefined && s !== null,
      );
      const input: Record<string, unknown> = { num_bytes: 8 };
      if (seedParts.length > 0) input.client_seed = seedParts.map(String).join("|");
      return input;
    },
    summarize(output) {
      const hex = String(field(output, "random_hex") ?? "");
      if (!hex) return "Winner draw unavailable (no randomness in output).";
      return `Winner drawn from verifiable VRF entropy 0x${hex.slice(0, 16)}… (use pickWinner() to map to a choice).`;
    },
  },

  beacon: {
    capabilityId: "platon.beacon@v1",
    productId: "prod-platon",
    desc: "Emit / read the next hash-chained public randomness-beacon round.",
    buildInput(args) {
      const input: Record<string, unknown> = {};
      const seed = args.seed ?? args.client_seed;
      if (seed !== undefined && seed !== null) input.client_seed = String(seed);
      return input;
    },
    summarize(output) {
      const round = field(output, "round");
      const hex = String(field(output, "random_hex") ?? "");
      const r = round === undefined ? "?" : String(round);
      if (!hex) return `Beacon round ${r} (no randomness in output).`;
      return `Beacon round ${r}: 0x${hex.slice(0, 16)}… (hash-chained, signed).`;
    },
  },
};
