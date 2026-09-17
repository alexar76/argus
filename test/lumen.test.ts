import { describe, it, expect, vi, afterEach } from "vitest";
import { LumenOracle } from "../src/economy/lumen.js";
import { createLogger } from "../src/logger.js";
import type { TrustEdge } from "../src/types.js";

const log = createLogger("t", "error");

/** Fake fetch returning an AIMarket v2 envelope (or an HTTP error). */
function mockFetch(body: unknown, ok = true, status = 200): typeof fetch {
  return vi.fn(async () => ({
    ok,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  })) as unknown as typeof fetch;
}

afterEach(() => vi.unstubAllGlobals());

describe("LumenOracle.scoreEntity", () => {
  it("stays neutral/degraded with no trust edges and never calls the oracle", async () => {
    const f = mockFetch({});
    vi.stubGlobal("fetch", f);
    const o = new LumenOracle({ oracleFamilyUrl: "http://x", log });
    const r = await o.scoreEntity("server-a");
    expect(r.degraded).toBe(true);
    expect(r.score).toBe(0.5);
    expect(f).not.toHaveBeenCalled();
  });

  it("calls lumen.reputation@v1 and maps scores[] → top node score/rank/percentile", async () => {
    const envelope = {
      output: { scores: [0.4, 0.3, 0.2, 0.1], iterations: 12, converged: true },
      provenance: { input_hash: "deadbeef" },
    };
    const f = mockFetch(envelope);
    vi.stubGlobal("fetch", f);
    const o = new LumenOracle({ oracleFamilyUrl: "http://x", log });
    const edges: TrustEdge[] = [[1, 0, 1], [2, 0, 1], [3, 0, 1]];
    const r = await o.scoreEntity("server-a", edges); // server-a → index 0 → raw 0.4 (highest)

    // The real, non-existent capability id must NOT be used.
    const body = JSON.parse((f as any).mock.calls[0][1].body);
    expect(body.capability_id).toBe("lumen.reputation@v1");

    expect(r.degraded).toBe(false);
    expect(r.rank).toBe(1); // highest PageRank mass
    expect(r.percentile).toBeCloseTo(1.0); // every node scores <= the top node
    expect(r.score).toBeCloseTo(1.0);
    expect(r.graphCommitment).toBe("deadbeef"); // provenance.input_hash = graph commitment
  });

  it("ranks a low-mass node near the bottom of the field", async () => {
    const envelope = { output: { scores: [0.1, 0.4, 0.3, 0.2], iterations: 9, converged: true } };
    vi.stubGlobal("fetch", mockFetch(envelope));
    const o = new LumenOracle({ oracleFamilyUrl: "http://x", log });
    const r = await o.scoreEntity("server-a", [[1, 0, 1]]); // index 0 → raw 0.1 (lowest)
    expect(r.rank).toBe(4); // three nodes outrank it
    expect(r.percentile).toBeCloseTo(0.25);
    expect(r.score).toBeCloseTo(0.25);
  });

  it("degrades to neutral (non-blocking) when the oracle errors", async () => {
    vi.stubGlobal("fetch", mockFetch({}, false, 500));
    const o = new LumenOracle({ oracleFamilyUrl: "http://x", log });
    const r = await o.scoreEntity("server-a", [[1, 0, 1]]);
    expect(r.degraded).toBe(true);
    expect(r.score).toBe(0.5);
  });
});
