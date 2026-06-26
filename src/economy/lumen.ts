import type { Logger, ReputationScore, TrustEdge, TrustOracle } from "../types.js";

export interface LumenOptions {
  oracleFamilyUrl: string;
  log: Logger;
  timeoutMs?: number;
}

/**
 * Trust oracle backed by LUMEN (PageRank / EigenTrust) via the oracle-family
 * endpoint. This is the differentiator behind WARDEN: server safety is scored by
 * a *verifiable* reputation oracle, not a static blocklist.
 *
 * Autonomy contract: if the oracle is unreachable, OR we don't yet have trust
 * edges for an entity, we return a NEUTRAL `degraded` result rather than a hard
 * fail. The reputation gate treats degraded results as non-blocking, so oracle
 * downtime can never break local autonomy.
 */
export class LumenOracle implements TrustOracle {
  private readonly url: string;
  private readonly log: Logger;
  private readonly timeoutMs: number;
  /** Max entries in nodeIndex before LRU eviction kicks in. */
  private static readonly MAX_NODES = 10_000;
  /** Stable entityId → node-index mapping for graph construction. Bounded via LRU. */
  private readonly nodeIndex = new Map<string, number>();

  constructor(opts: LumenOptions) {
    this.url = opts.oracleFamilyUrl.replace(/\/$/, "");
    this.log = opts.log;
    this.timeoutMs = opts.timeoutMs ?? 8000;
  }

  private indexOf(entityId: string): number {
    let i = this.nodeIndex.get(entityId);
    if (i !== undefined) {
      // LRU: move to end on access (Map preserves insertion order).
      this.nodeIndex.delete(entityId);
      this.nodeIndex.set(entityId, i);
      return i;
    }
    // Evict oldest entries when the map grows too large.
    while (this.nodeIndex.size >= LumenOracle.MAX_NODES) {
      const oldest = this.nodeIndex.keys().next().value as string;
      this.nodeIndex.delete(oldest);
    }
    i = this.nodeIndex.size;
    this.nodeIndex.set(entityId, i);
    return i;
  }

  async scoreEntity(entityId: string, edges?: TrustEdge[]): Promise<ReputationScore> {
    const target = this.indexOf(entityId);

    // Without trust edges there is nothing for PageRank to chew on — stay neutral.
    if (!edges || edges.length === 0) {
      return { score: 0.5, degraded: true };
    }
    const nodes = this.nodeIndex.size;

    try {
      // lumen.reputation@v1 — input { nodes: count, edges: [i,j,w][] } → output
      // { scores: number[] (PageRank mass, sums to 1), iterations, converged }.
      const { output, provenance } = await this.invoke("lumen.reputation@v1", { nodes, edges });
      const scores = Array.isArray(output.scores) ? (output.scores as unknown[]).map((s) => num(s, 0)) : null;
      if (!scores || scores.length === 0 || target >= scores.length) {
        return { score: 0.5, degraded: true };
      }
      // Raw PageRank mass averages 1/n, so it is not itself a 0..1 trust level.
      // Map it to a bounded signal: the target's percentile in the field (the most
      // trusted node → 1.0). rank is 1 = highest. This is what the gate thresholds.
      const raw = scores[target] ?? 0;
      const n = scores.length;
      const rank = 1 + scores.filter((s) => s > raw).length;
      const percentile = clamp01(scores.filter((s) => s <= raw).length / n);
      const commitment = typeof provenance?.input_hash === "string" ? provenance.input_hash : undefined;
      return { score: percentile, rank, percentile, graphCommitment: commitment, degraded: false };
    } catch (err) {
      this.log.debug(`LUMEN unreachable, neutral score: ${(err as Error).message}`);
      return { score: 0.5, degraded: true };
    }
  }

  /**
   * Call a capability on the oracle-family AI-Market v2 endpoint. Returns the
   * capability `output` plus the signed envelope's `provenance` — whose
   * `input_hash` is the sha256 commitment of the graph LUMEN scored.
   */
  private async invoke(
    capabilityId: string,
    input: unknown,
  ): Promise<{ output: Record<string, unknown>; provenance?: Record<string, unknown> }> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const res = await fetch(`${this.url}/ai-market/v2/invoke`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ capability_id: capabilityId, input }),
        signal: ctrl.signal,
      });
      if (!res.ok) throw new Error(`oracle HTTP ${res.status}`);
      const json: any = await res.json();
      // Tolerate both {output:{...}} envelopes and bare outputs.
      const output = (json.output ?? json) as Record<string, unknown>;
      const provenance = (json.provenance ?? undefined) as Record<string, unknown> | undefined;
      return { output, provenance };
    } finally {
      clearTimeout(timer);
    }
  }
}

function num(v: unknown, d: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}
function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}
