import { describe, it, expect } from "vitest";
import {
  STUDIO_VERBS,
  listVerbs,
  verbNames,
  resolveVerb,
  runVerb,
  pickWinner,
  toArtifact,
  type StudioClient,
  type VerbResult,
} from "../src/studio/index.js";

/** A fake oracle client that records the last invoke and returns a scripted output. */
function fakeClient(
  output: unknown,
  extra: Partial<{ priceUsd: number; receipt: unknown; signerPublicKey: string }> = {},
) {
  const calls: { capabilityId: string; input: unknown; productId?: string }[] = [];
  const client: StudioClient = {
    async invoke(capabilityId, input, productId) {
      calls.push({ capabilityId, input, productId });
      return { output, ...extra };
    },
  };
  return { client, calls };
}

// The canonical verb -> capability mapping the integrator depends on.
const EXPECTED: Record<string, string> = {
  coin: "platon.random@v1",
  winner: "platon.random@v1",
  beacon: "platon.beacon@v1",
  elapsed: "chronos.eval@v1",
  "even-coverage": "lattice.sequence@v1",
  aggregate: "murmuration.aggregate@v1",
  optimize: "colony.optimize@v1",
  "blue-noise": "turing.bluenoise@v1",
  trust: "lumen.reputation@v1",
  resilience: "percola.threshold@v1",
  route: "fermat.route@v1",
  cascade: "ablation.cascade@v1",
  "compute-floor": "landauer.audit@v1",
};

describe("studio registry — shape & catalogue", () => {
  it("covers exactly the documented verbs, each mapped to the right capability", () => {
    expect(new Set(verbNames())).toEqual(new Set(Object.keys(EXPECTED)));
    for (const [verb, cap] of Object.entries(EXPECTED)) {
      expect(STUDIO_VERBS[verb], `verb ${verb} missing`).toBeDefined();
      expect(STUDIO_VERBS[verb]!.capabilityId).toBe(cap);
    }
  });

  it("every verb's product id matches its capability prefix", () => {
    for (const v of Object.values(STUDIO_VERBS)) {
      const prefix = v.capabilityId.split(".")[0]!;
      expect(v.productId).toBe(`prod-${prefix}`);
    }
  });

  it("listVerbs returns {verb, capabilityId, desc} for all verbs", () => {
    const list = listVerbs();
    expect(list).toHaveLength(Object.keys(EXPECTED).length);
    for (const e of list) {
      expect(typeof e.desc).toBe("string");
      expect(e.desc.length).toBeGreaterThan(0);
      expect(e.capabilityId).toBe(EXPECTED[e.verb]);
    }
  });

  it("resolveVerb is tolerant of spaces / underscores / case", () => {
    expect(resolveVerb("blue noise")).toBe(STUDIO_VERBS["blue-noise"]);
    expect(resolveVerb("BLUE_NOISE")).toBe(STUDIO_VERBS["blue-noise"]);
    expect(resolveVerb("Even Coverage")).toBe(STUDIO_VERBS["even-coverage"]);
    expect(resolveVerb("nope")).toBeUndefined();
  });
});

describe("studio buildInput — friendly args → capability input", () => {
  it("coin builds a 1-byte VRF draw and binds an optional seed", () => {
    expect(STUDIO_VERBS.coin!.buildInput({})).toEqual({ num_bytes: 1 });
    expect(STUDIO_VERBS.coin!.buildInput({ seed: "abc" })).toEqual({ num_bytes: 1, client_seed: "abc" });
  });

  it("winner binds the candidate set into client_seed (commit-reveal)", () => {
    const input = STUDIO_VERBS.winner!.buildInput({ seed: "s", choices: ["a", "b", "c"] }) as Record<string, unknown>;
    expect(input.num_bytes).toBe(8);
    expect(input.client_seed).toBe("s|a|b|c");
  });

  it("elapsed clamps difficulty and stringifies the seed", () => {
    expect(STUDIO_VERBS.elapsed!.buildInput({ seed: 42, difficulty: -5 })).toEqual({ seed: "42", difficulty: 1 });
    expect(STUDIO_VERBS.elapsed!.buildInput({ seed: "x" })).toEqual({ seed: "x", difficulty: 100000 });
  });

  it("even-coverage maps count/dim/skip with sane defaults & clamps", () => {
    expect(STUDIO_VERBS["even-coverage"]!.buildInput({})).toEqual({ count: 256, dim: 2, skip: 0 });
    expect(STUDIO_VERBS["even-coverage"]!.buildInput({ n: 10, d: 3, offset: 5 })).toEqual({ count: 10, dim: 3, skip: 5 });
  });

  it("aggregate filters non-numeric values and clamps trim", () => {
    const input = STUDIO_VERBS.aggregate!.buildInput({ values: [1, "2", "oops", 3], trim: 0.9 }) as Record<string, unknown>;
    expect(input.values).toEqual([1, 2, 3]);
    expect(input.trim).toBe(0.499);
  });

  it("optimize coerces points to [x,y] number pairs", () => {
    const input = STUDIO_VERBS.optimize!.buildInput({ points: [[0, 0], ["1", "2"]] }) as Record<string, unknown>;
    expect(input.points).toEqual([[0, 0], [1, 2]]);
  });

  it("blue-noise includes seed/candidates only when supplied", () => {
    expect(STUDIO_VERBS["blue-noise"]!.buildInput({ n: 12 })).toEqual({ count: 12 });
    expect(STUDIO_VERBS["blue-noise"]!.buildInput({ count: 12, candidates: 20, seed: 7 })).toEqual({
      count: 12,
      candidates: 20,
      seed: 7,
    });
  });

  it("trust infers node count from edge indices when not given", () => {
    const input = STUDIO_VERBS.trust!.buildInput({ edges: [[0, 2, 1], [2, 1]] }) as Record<string, unknown>;
    expect(input.nodes).toBe(3); // max index 2 => 3 nodes
    expect(input.edges).toEqual([[0, 2, 1], [2, 1, 1]]); // weight defaults to 1
  });

  it("trust honours an explicit node count", () => {
    const input = STUDIO_VERBS.trust!.buildInput({ nodes: 10, edges: [[0, 1, 1]] }) as Record<string, unknown>;
    expect(input.nodes).toBe(10);
  });

  it("resilience passes edges and optional attack/samples", () => {
    const input = STUDIO_VERBS.resilience!.buildInput({ edges: [["a", "b"]], attack: "targeted", samples: 30 }) as Record<string, unknown>;
    expect(input.edges).toEqual([["a", "b"]]);
    expect(input.attack).toBe("targeted");
    expect(input.samples).toBe(30);
  });

  it("route maps from/to to start/goal", () => {
    const input = STUDIO_VERBS.route!.buildInput({ edges: [["a", "b", 1]], from: "a", to: "b" }) as Record<string, unknown>;
    expect(input.start).toBe("a");
    expect(input.goal).toBe("b");
    expect(input.edges).toEqual([["a", "b", 1]]);
  });

  it("cascade forwards edges, capacities and grains", () => {
    const input = STUDIO_VERBS.cascade!.buildInput({ edges: [["a", "b"]], capacities: { a: 2 }, grains: 100 }) as Record<string, unknown>;
    expect(input.edges).toEqual([["a", "b"]]);
    expect(input.capacities).toEqual({ a: 2 });
    expect(input.grains).toBe(100);
  });

  it("compute-floor forwards ops and optional temperature", () => {
    const ops = [{ id: "a", gate: "input" }, { id: "b", gate: "and", inputs: ["a"] }];
    expect(STUDIO_VERBS["compute-floor"]!.buildInput({ gates: ops })).toEqual({ ops });
    const withTemp = STUDIO_VERBS["compute-floor"]!.buildInput({ ops, temperature: 4 }) as Record<string, unknown>;
    expect(withTemp.temperature_k).toBe(4);
  });
});

describe("studio summarize — output → human answer", () => {
  it("coin maps the low bit to HEADS/TAILS", () => {
    expect(STUDIO_VERBS.coin!.summarize({ random_hex: "00" })).toContain("HEADS");
    expect(STUDIO_VERBS.coin!.summarize({ random_hex: "01" })).toContain("TAILS");
    expect(STUDIO_VERBS.coin!.summarize({})).toContain("unavailable");
  });

  it("beacon reports the round and a draw prefix", () => {
    const s = STUDIO_VERBS.beacon!.summarize({ round: 7, random_hex: "deadbeefcafe" });
    expect(s).toContain("round 7");
    expect(s).toContain("0xdeadbeef");
  });

  it("aggregate renders consensus, median and biweight", () => {
    const s = STUDIO_VERBS.aggregate!.summarize({ n: 5, median: 10, biweight: 10.2, converged_value: 10.1 });
    expect(s).toContain("over 5 estimates");
    expect(s).toContain("10.1");
    expect(s).toContain("median 10");
  });

  it("optimize converts the gap to a percentage from optimal", () => {
    const s = STUDIO_VERBS.optimize!.summarize({ n: 6, length: 12.5, gap: 0.05 });
    expect(s).toContain("6 points");
    expect(s).toContain("12.5");
    expect(s).toContain("5%");
  });

  it("trust names the most-trusted index", () => {
    const s = STUDIO_VERBS.trust!.summarize({ scores: [0.1, 0.7, 0.2] });
    expect(s).toContain("#1");
    expect(s).toContain("3 parties");
  });

  it("route renders the path with arrows, or unreachable", () => {
    expect(STUDIO_VERBS.route!.summarize({ reachable: true, path: ["a", "b", "c"], total: 3 })).toContain("a → b → c");
    expect(STUDIO_VERBS.route!.summarize({ reachable: false, start: "a", goal: "z", path: [] })).toContain("unreachable");
  });

  it("cascade flags a heavy tail when tau < 2", () => {
    expect(STUDIO_VERBS.cascade!.summarize({ tau: 1.4, mean_avalanche: 8, triggers: [{ node: "bankX" }] })).toContain("HEAVY");
    expect(STUDIO_VERBS.cascade!.summarize({ tau: 2.6 })).toContain("bounded tail");
  });

  it("compute-floor renders bits, joules and efficiency", () => {
    const s = STUDIO_VERBS["compute-floor"]!.summarize({ irreversible_bits: 12, energy_floor_j: 3.4e-20, efficiency: 0.5 });
    expect(s).toContain("12 irreversible bits");
    expect(s).toContain("J");
    expect(s).toContain("50%");
  });

  it("summarize never throws on malformed/empty output", () => {
    for (const v of Object.values(STUDIO_VERBS)) {
      expect(() => v.summarize(undefined)).not.toThrow();
      expect(() => v.summarize({})).not.toThrow();
      expect(() => v.summarize("garbage")).not.toThrow();
    }
  });
});

describe("runVerb — orchestration & proof passthrough", () => {
  it("resolves the right capability + product id and builds the input", async () => {
    const { client, calls } = fakeClient({ random_hex: "00" });
    await runVerb(client, "coin", { seed: "z" });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.capabilityId).toBe("platon.random@v1");
    expect(calls[0]!.productId).toBe("prod-platon");
    expect(calls[0]!.input).toEqual({ num_bytes: 1, client_seed: "z" });
  });

  it("returns the summarized answer", async () => {
    const { client } = fakeClient({ n: 3, median: 5, biweight: 5, converged_value: 5 });
    const r = await runVerb(client, "aggregate", { values: [4, 5, 6] });
    expect(r.verb).toBe("aggregate");
    expect(r.capabilityId).toBe("murmuration.aggregate@v1");
    expect(r.answer).toContain("over 3 estimates");
  });

  it("threads receipt, signerPublicKey and priceUsd straight through", async () => {
    const receipt = { capability_id: "platon.random@v1", signature: { value: "sig" } };
    const { client } = fakeClient({ random_hex: "01" }, { priceUsd: 0.01, receipt, signerPublicKey: "PUBKEY" });
    const r = await runVerb(client, "coin");
    expect(r.priceUsd).toBe(0.01);
    expect(r.receipt).toBe(receipt);
    expect(r.signerPublicKey).toBe("PUBKEY");
  });

  it("omits proof fields when the client returns none (crypto-off / offline)", async () => {
    const { client } = fakeClient({ random_hex: "00" });
    const r = await runVerb(client, "coin");
    expect("priceUsd" in r).toBe(false);
    expect("receipt" in r).toBe(false);
    expect("signerPublicKey" in r).toBe(false);
  });

  it("accepts a fuzzy verb spelling", async () => {
    const { client, calls } = fakeClient({ count: 4, points: [] });
    await runVerb(client, "Blue Noise", { n: 4 });
    expect(calls[0]!.capabilityId).toBe("turing.bluenoise@v1");
  });

  it("throws a helpful error for an unknown verb", async () => {
    const { client } = fakeClient({});
    await expect(runVerb(client, "teleport")).rejects.toThrow(/unknown studio verb/);
  });
});

describe("pickWinner — deterministic mapping from a VRF draw", () => {
  it("maps a draw to a stable choice index (draw mod len)", () => {
    const choices = ["a", "b", "c", "d"];
    // 0x00000007 = 7 ; 7 mod 4 = 3 => "d"
    expect(pickWinner({ random_hex: "00000007ffff" }, choices)).toBe("d");
    // deterministic for the same draw
    expect(pickWinner({ random_hex: "00000007ffff" }, choices)).toBe("d");
  });

  it("degrades to undefined on no choices or no draw", () => {
    expect(pickWinner({ random_hex: "ab" }, [])).toBeUndefined();
    expect(pickWinner({}, ["a"])).toBeUndefined();
    expect(pickWinner(undefined, ["a"])).toBeUndefined();
  });
});

describe("toArtifact — bridge to argus verify", () => {
  it("produces an oracle-receipt artifact when receipt + signer are present", () => {
    const result: VerbResult = {
      verb: "coin",
      capabilityId: "platon.random@v1",
      answer: "HEADS",
      receipt: { capability_id: "platon.random@v1" },
      signerPublicKey: "PUBKEY",
    };
    const art = toArtifact(result);
    expect(art).toBeDefined();
    expect(art!.type).toBe("oracle-receipt");
    if (art!.type === "oracle-receipt") {
      expect(art.signerPublicKey).toBe("PUBKEY");
      expect(art.label).toContain("coin");
    }
  });

  it("returns undefined (fail-open) when proof material is missing", () => {
    expect(toArtifact({ verb: "coin", capabilityId: "platon.random@v1", answer: "x" })).toBeUndefined();
    expect(
      toArtifact({ verb: "coin", capabilityId: "platon.random@v1", answer: "x", signerPublicKey: "k", receipt: "not-an-object" }),
    ).toBeUndefined();
  });
});
