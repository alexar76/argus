import { describe, it, expect } from "vitest";
import {
  updateBaseline,
  compareToBaseline,
  stddevBytes,
  type ToolBaseline,
  type Observation,
} from "../src/sentinel/index.js";

/** Fold a sequence of observations into a baseline, starting cold. */
function buildBaseline(obs: Observation[]): ToolBaseline | null {
  let b: ToolBaseline | null = null;
  for (const o of obs) b = updateBaseline(b, o);
  return b;
}

/** A stable "normal" observation: one known host, ~1000-byte output. */
function normal(bytes = 1000): Observation {
  return { egressHosts: ["api.oracle.aicom"], outputBytes: bytes };
}

describe("sentinel — updateBaseline (Welford + host union)", () => {
  it("seeds a fresh baseline from null", () => {
    const b = updateBaseline(null, { egressHosts: ["a.com"], outputBytes: 500 });
    expect(b.count).toBe(1);
    expect(b.egressHosts).toEqual(["a.com"]);
    expect(b.meanBytes).toBe(500);
    expect(b.m2Bytes).toBe(0);
  });

  it("does not mutate the input baseline (pure)", () => {
    const b1 = updateBaseline(null, { egressHosts: ["a.com"], outputBytes: 100 });
    const snapshot = JSON.parse(JSON.stringify(b1));
    updateBaseline(b1, { egressHosts: ["b.com"], outputBytes: 9999 });
    expect(b1).toEqual(snapshot);
  });

  it("accumulates a deduped, normalized, sorted union of egress hosts", () => {
    let b = updateBaseline(null, { egressHosts: ["B.com", "a.com"], outputBytes: 1 });
    b = updateBaseline(b, { egressHosts: ["  A.COM ", "c.com", ""], outputBytes: 1 });
    expect(b.egressHosts).toEqual(["a.com", "b.com", "c.com"]);
  });

  it("tracks a correct running mean over many observations", () => {
    const b = buildBaseline([100, 200, 300, 400, 500].map((n) => normal(n)))!;
    expect(b.count).toBe(5);
    expect(b.meanBytes).toBeCloseTo(300, 6);
  });

  it("computes population stddev matching a direct calculation", () => {
    const vals = [10, 12, 23, 23, 16, 23, 21, 16];
    const b = buildBaseline(vals.map((n) => normal(n)))!;
    const mean = vals.reduce((s, v) => s + v, 0) / vals.length;
    const variance = vals.reduce((s, v) => s + (v - mean) ** 2, 0) / vals.length;
    expect(b.meanBytes).toBeCloseTo(mean, 6);
    expect(stddevBytes(b)).toBeCloseTo(Math.sqrt(variance), 6);
  });

  it("coerces non-finite / negative byte counts to 0", () => {
    const b = updateBaseline(null, { egressHosts: [], outputBytes: Number.NaN });
    expect(b.meanBytes).toBe(0);
    const b2 = updateBaseline(b, { egressHosts: [], outputBytes: -50 });
    expect(b2.meanBytes).toBe(0);
    expect(b2.count).toBe(2);
  });
});

describe("sentinel — stddevBytes", () => {
  it("is 0 for null and for a single-sample baseline", () => {
    expect(stddevBytes(null)).toBe(0);
    expect(stddevBytes(buildBaseline([normal(1000)]))).toBe(0);
  });
});

describe("sentinel — compareToBaseline (cold start safety)", () => {
  it("never flags against a null baseline", () => {
    const r = compareToBaseline(null, { egressHosts: ["brand.new.host"], outputBytes: 10_000_000 });
    expect(r.deviation).toBe(false);
    expect(r.reasons).toEqual([]);
  });

  it("never flags a huge output before the warmup sample threshold", () => {
    // 3 samples << default minSamples (8): output-size check must stay silent.
    const b = buildBaseline([normal(1000), normal(1010), normal(990)]);
    const r = compareToBaseline(b, normal(50_000_000));
    expect(r.reasons.some((x) => x.includes("output"))).toBe(false);
  });
});

describe("sentinel — compareToBaseline (stable normal)", () => {
  it("does not flag a typical observation after warmup", () => {
    const b = buildBaseline(Array.from({ length: 20 }, (_, i) => normal(1000 + (i % 5) * 10)));
    const r = compareToBaseline(b, normal(1020));
    expect(r.deviation).toBe(false);
    expect(r.reasons).toEqual([]);
  });

  it("does not flag a known host even when listed with different case/whitespace", () => {
    const b = buildBaseline(Array.from({ length: 10 }, () => normal()));
    const r = compareToBaseline(b, { egressHosts: ["  API.ORACLE.AICOM "], outputBytes: 1000 });
    expect(r.deviation).toBe(false);
  });
});

describe("sentinel — compareToBaseline (new egress host)", () => {
  it("flags a never-before-seen egress host", () => {
    const b = buildBaseline(Array.from({ length: 10 }, () => normal()));
    const r = compareToBaseline(b, { egressHosts: ["api.oracle.aicom", "evil.exfil.xyz"], outputBytes: 1000 });
    expect(r.deviation).toBe(true);
    expect(r.reasons.some((x) => x.includes("evil.exfil.xyz"))).toBe(true);
    // The known host must NOT be reported as new.
    expect(r.reasons.some((x) => x.includes("api.oracle.aicom"))).toBe(false);
  });

  it("reports each distinct new host once, not duplicated", () => {
    const b = buildBaseline(Array.from({ length: 10 }, () => normal()));
    const r = compareToBaseline(b, { egressHosts: ["new.one", "new.one", "new.two"], outputBytes: 1000 });
    const hostReasons = r.reasons.filter((x) => x.startsWith("new egress host"));
    expect(hostReasons).toHaveLength(2);
  });

  it("flags a new host even with few samples (a new destination is suspicious early)", () => {
    const b = buildBaseline([normal(), normal()]); // count 2, below output-warmup threshold
    const r = compareToBaseline(b, { egressHosts: ["sudden.new.host"], outputBytes: 1000 });
    expect(r.deviation).toBe(true);
    expect(r.reasons.some((x) => x.includes("sudden.new.host"))).toBe(true);
  });
});

describe("sentinel — compareToBaseline (output blowup)", () => {
  it("flags a huge output after warmup", () => {
    const b = buildBaseline(Array.from({ length: 12 }, (_, i) => normal(1000 + (i % 4) * 5)));
    const r = compareToBaseline(b, normal(5_000_000));
    expect(r.deviation).toBe(true);
    expect(r.reasons.some((x) => x.includes("output"))).toBe(true);
  });

  it("respects a custom (tighter) k", () => {
    const vals = [1000, 1100, 900, 1050, 950, 1000, 1020, 980, 1010, 990];
    const b = buildBaseline(vals.map((n) => normal(n)))!;
    const sd = stddevBytes(b);
    const justOverMean2Sigma = Math.ceil(b.meanBytes + 2.0001 * sd);
    // Tolerant default k=6 should NOT flag a mild 2σ-ish bump...
    expect(compareToBaseline(b, normal(justOverMean2Sigma)).deviation).toBe(false);
    // ...but k=2 should.
    expect(compareToBaseline(b, normal(justOverMean2Sigma), { k: 2 }).deviation).toBe(true);
  });

  it("does not flag output exactly at the mean after warmup with zero variance", () => {
    const b = buildBaseline(Array.from({ length: 10 }, () => normal(1000)));
    expect(stddevBytes(b)).toBe(0);
    // Exactly the mean: not a strict increase, must not flag.
    expect(compareToBaseline(b, normal(1000)).deviation).toBe(false);
    // A real jump on a zero-variance baseline IS a blowup (threshold === mean).
    expect(compareToBaseline(b, normal(2000)).deviation).toBe(true);
  });
});

describe("sentinel — combined drift", () => {
  it("reports both a new host and an output blowup together", () => {
    const b = buildBaseline(Array.from({ length: 12 }, () => normal(1000)));
    const r = compareToBaseline(b, { egressHosts: ["api.oracle.aicom", "leak.host"], outputBytes: 9_000_000 });
    expect(r.deviation).toBe(true);
    expect(r.reasons.some((x) => x.includes("leak.host"))).toBe(true);
    expect(r.reasons.some((x) => x.includes("output"))).toBe(true);
    expect(r.reasons.length).toBeGreaterThanOrEqual(2);
  });
});
