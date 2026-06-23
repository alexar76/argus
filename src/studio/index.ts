/**
 * Oracle Studio — friendly verbs over the eleven AICOM oracles.
 *
 * Ideology: AICOM's most under-used asset is its own oracle family — most of it sits
 * idle because *using* it means knowing arcane capability ids (`platon.random@v1`,
 * `murmuration.aggregate@v1`, …) and their bespoke input shapes. Studio is the demand
 * ramp: it maps a human verb ("flip a fair coin", "how much to trust X", "will this
 * network shatter") to (a) the right capability id, (b) a `buildInput` that translates
 * friendly arguments into the capability's exact input contract, and (c) a `summarize`
 * that renders the signed output as one short human sentence. The competitor's "fair
 * coin" is `Math.random()`; ours is a signed, re-verifiable VRF — the UX is copyable,
 * the verifiable math behind the buttons is not.
 *
 * This core is PURE and CLIENT-AGNOSTIC. It imports nothing but node builtins (none are
 * needed) and, type-only, the proof types from `../verify/index.js`. The network client
 * is taken as a PARAMETER to `runVerb`, so the registry is fully testable with a fake.
 */

import type { VerifiableArtifact } from "../verify/index.js";

/** Re-exported so callers can hand a runVerb result straight to `argus verify`. */
export type { VerifiableArtifact };

/** Minimal contract Studio needs from an oracle-family client (e.g. OracleClient). */
export interface StudioClient {
  invoke(
    capabilityId: string,
    input: unknown,
    productId?: string,
  ): Promise<{ output: unknown; priceUsd?: number; receipt?: unknown; signerPublicKey?: string }>;
}

/** One human verb bound to one oracle capability. */
export interface StudioVerb {
  /** The oracle-family capability this verb resolves to (e.g. "platon.random@v1"). */
  readonly capabilityId: string;
  /** Optional explicit product id; defaults from the capability prefix when omitted. */
  readonly productId?: string;
  /** One-line, owner-facing description of what the verb does. */
  readonly desc: string;
  /** Translate friendly args into the capability's exact input object. Pure. */
  buildInput(args: Record<string, unknown>): object;
  /** Render the capability output as one short human answer. Pure, defensive. */
  summarize(output: unknown): string;
}

/** What `runVerb` returns: the human answer plus the proof passthrough. */
export interface VerbResult {
  verb: string;
  capabilityId: string;
  answer: string;
  priceUsd?: number;
  receipt?: unknown;
  signerPublicKey?: string;
}

// ---------------------------------------------------------------------------
// small typed helpers (strict + noUncheckedIndexedAccess friendly)
// ---------------------------------------------------------------------------

/** Coerce to a finite number, else fallback. */
function num(v: unknown, fallback: number): number {
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? n : fallback;
}

/** Coerce to an integer in [lo, hi], else fallback (then clamped). */
function intIn(v: unknown, fallback: number, lo: number, hi: number): number {
  const n = Math.trunc(num(v, fallback));
  return Math.max(lo, Math.min(hi, n));
}

/** Read a record field as `unknown` without `any`. */
function field(o: unknown, k: string): unknown {
  return o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined;
}

/** Treat `output` as a record (oracle outputs are JSON objects). */
function asRecord(o: unknown): Record<string, unknown> {
  return o && typeof o === "object" ? (o as Record<string, unknown>) : {};
}

/** Format a number compactly (trims noisy trailing decimals). */
function fmt(n: number, digits = 4): string {
  if (!Number.isFinite(n)) return "n/a";
  if (Number.isInteger(n)) return String(n);
  return Number(n.toFixed(digits)).toString();
}

/** Coerce an unknown to an array, or [] — keeps element type `unknown`. */
function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

/** First N labels from a string-ish array, comma-joined. */
function labels(v: unknown, n: number): string {
  return arr(v).slice(0, n).map((x) => String(x)).join(", ");
}

// ---------------------------------------------------------------------------
// the verb registry — one entry per friendly verb
// ---------------------------------------------------------------------------

/**
 * The Studio verb registry. Keyed by human verb. Each entry knows its capability id,
 * how to build the capability input from friendly args, and how to summarize the
 * output. Pure data + pure functions: no I/O happens here.
 *
 * Verbs:
 *  - `coin`        flip a fair coin (Platon VRF)
 *  - `winner`      pick a fair winner among choices (Platon VRF)
 *  - `beacon`      next public randomness-beacon round (Platon)
 *  - `elapsed`     prove sequential time elapsed (Chronos VDF)
 *  - `even-coverage` low-discrepancy space-filling points (Lattice)
 *  - `aggregate`   robust, outlier-resistant consensus number (Murmuration)
 *  - `optimize`    cheapest tour over points, with optimality gap (Colony)
 *  - `blue-noise`  evenly-spaced (blue-noise) sample points (Turing)
 *  - `trust`       reputation / PageRank over a trust graph (LUMEN)
 *  - `resilience`  percolation threshold: when does a network shatter (Percola)
 *  - `route`       provably-optimal least-cost composition path (Fermat)
 *  - `cascade`     systemic cascade / contagion risk (Ablation)
 *  - `compute-floor` thermodynamic energy floor of a computation (Landauer)
 */
export const STUDIO_VERBS: Readonly<Record<string, StudioVerb>> = Object.freeze({
  // --- Platon: verifiable randomness -------------------------------------
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
      // Map the low bit of the first random byte to heads/tails.
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
      // Bind the candidate set into the draw via client_seed so the pick is
      // committed to *these* choices (commit-reveal entropy the server can't pick).
      const seedParts = [args.seed, ...choices.map((c) => String(c))].filter(
        (s) => s !== undefined && s !== null,
      );
      const input: Record<string, unknown> = { num_bytes: 8 };
      if (seedParts.length > 0) input.client_seed = seedParts.map(String).join("|");
      return input;
    },
    summarize(output) {
      // summarize is pure on output; the chosen index is derived from the draw.
      // We can only know the choice count if it was echoed; otherwise report the draw.
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

  // --- Chronos: verifiable delay (VDF) ----------------------------------
  elapsed: {
    capabilityId: "chronos.eval@v1",
    productId: "prod-chronos",
    desc: "Prove a fixed amount of sequential time elapsed (Wesolowski VDF).",
    buildInput(args) {
      const seed = args.seed ?? args.label ?? "";
      const difficulty = intIn(args.difficulty ?? args.steps ?? args.work, 100000, 1, 100_000_000);
      return { seed: String(seed), difficulty };
    },
    summarize(output) {
      const o = asRecord(output);
      const difficulty = o.difficulty;
      const valid = field(o.proof, "pi") !== undefined || o.y !== undefined;
      const d = difficulty === undefined ? "?" : String(difficulty);
      return valid
        ? `Elapsed proof: ${d} sequential squarings, verifiable without re-running the work.`
        : `Elapsed proof produced (difficulty ${d}).`;
    },
  },

  // --- Lattice: low-discrepancy sampling --------------------------------
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

  // --- Murmuration: robust consensus ------------------------------------
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

  // --- Colony: combinatorial optimization -------------------------------
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

  // --- Turing: blue-noise sampling --------------------------------------
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

  // --- LUMEN: reputation -------------------------------------------------
  trust: {
    capabilityId: "lumen.reputation@v1",
    productId: "prod-lumen",
    desc: "Score how much to trust each party from a who-trusts-whom graph.",
    buildInput(args) {
      const edges = arr(args.edges ?? args.trust ?? args.links).map((e) => {
        const t = arr(e);
        return [num(t[0], 0), num(t[1], 0), num(t[2], 1)] as [number, number, number];
      });
      // nodes: explicit count, else 1 + max index seen across edges.
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

  // --- Percola: network resilience --------------------------------------
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

  // --- Fermat: provably-optimal routing ---------------------------------
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

  // --- Ablation: systemic cascade risk ----------------------------------
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

  // --- Landauer: thermodynamic compute floor ----------------------------
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
});

/** All known verb names. */
export function verbNames(): string[] {
  return Object.keys(STUDIO_VERBS);
}

/** Catalogue for menus / help: verb, capability id, and one-line description. */
export function listVerbs(): { verb: string; capabilityId: string; desc: string }[] {
  return Object.entries(STUDIO_VERBS).map(([verb, v]) => ({
    verb,
    capabilityId: v.capabilityId,
    desc: v.desc,
  }));
}

/** Resolve a verb (case-insensitive, tolerant of spaces/underscores → hyphen). */
export function resolveVerb(verb: string): StudioVerb | undefined {
  const direct = STUDIO_VERBS[verb];
  if (direct) return direct;
  const norm = verb.trim().toLowerCase().replace(/[\s_]+/g, "-");
  return STUDIO_VERBS[norm];
}

/**
 * Run a Studio verb through an oracle client.
 *
 * Pure orchestration: resolves the verb, builds the input, invokes the client with the
 * verb's capability id (+ its product id), summarizes the output, and threads the
 * proof fields (receipt / signerPublicKey / priceUsd) straight through untouched so the
 * caller can hand them to Provenance / `argus verify`.
 *
 * @throws if the verb is unknown.
 */
export async function runVerb(
  client: StudioClient,
  verb: string,
  args: Record<string, unknown> = {},
): Promise<VerbResult> {
  const entry = resolveVerb(verb);
  if (!entry) {
    throw new Error(`unknown studio verb "${verb}". Known verbs: ${verbNames().join(", ")}`);
  }
  const input = entry.buildInput(args);
  const res = await client.invoke(entry.capabilityId, input, entry.productId);
  const result: VerbResult = {
    verb,
    capabilityId: entry.capabilityId,
    answer: entry.summarize(res.output),
  };
  if (res.priceUsd !== undefined) result.priceUsd = res.priceUsd;
  if (res.receipt !== undefined) result.receipt = res.receipt;
  if (res.signerPublicKey !== undefined) result.signerPublicKey = res.signerPublicKey;
  return result;
}

/**
 * Map a verifiable VRF draw (from the `winner` verb's output) to one of `choices`.
 * Pure + deterministic for a given draw — the index is `draw mod len`, read from the
 * first 8 hex chars of `random_hex`. Returns `undefined` if there is no usable draw or
 * no choices. Kept separate from `summarize` because it needs the caller's choice list.
 */
export function pickWinner<T>(output: unknown, choices: readonly T[]): T | undefined {
  if (choices.length === 0) return undefined;
  const hex = String(field(output, "random_hex") ?? "");
  if (hex.length === 0) return undefined;
  const draw = parseInt(hex.slice(0, 8), 16);
  if (!Number.isFinite(draw)) return undefined;
  const idx = ((draw % choices.length) + choices.length) % choices.length;
  return choices[idx];
}

/**
 * Build a `VerifiableArtifact` (oracle-receipt) from a `runVerb` result so it can be
 * fed straight to `verifyBundle` from `../verify`. Returns `undefined` when the result
 * lacks a receipt or signer key (e.g. crypto-off / offline) — fail-open, never throws.
 */
export function toArtifact(result: VerbResult): VerifiableArtifact | undefined {
  if (!result.signerPublicKey || result.receipt === undefined) return undefined;
  if (typeof result.receipt !== "object" || result.receipt === null) return undefined;
  return {
    type: "oracle-receipt",
    receipt: result.receipt as Record<string, unknown>,
    signerPublicKey: result.signerPublicKey,
    label: `studio:${result.verb} (${result.capabilityId})`,
  };
}
