import type {
  TrustOracle,
  WardenFinding,
  WardenGate,
  WardenGateInput,
  WardenGateResult,
} from "../types.js";

/**
 * Reputation gate — the WARDEN differentiator.
 *
 * Static scanning catches a poisoned definition; reputation catches a clean-
 * looking server with no standing in the network. We ask the LUMEN trust oracle
 * for the server's PageRank/EigenTrust score and gate on it. Two deliberate
 * design calls:
 *   1. Oracle downtime must NOT break autonomy — if the oracle is unreachable we
 *      degrade to a neutral score rather than blocking everything.
 *   2. A genuinely low score is a hard signal: under a strict policy
 *      (!allowUnknownServers) it's fatal; otherwise it tanks the composite score
 *      but lets the user make the call.
 */
export class ReputationGate implements WardenGate {
  readonly name = "reputation";

  constructor(private readonly oracle: TrustOracle) {}

  async evaluate(input: WardenGateInput): Promise<WardenGateResult> {
    const result = await this.oracle.scoreEntity(input.server.id);

    if (result.degraded) {
      const finding: WardenFinding = {
        gate: this.name,
        severity: "info",
        code: "REPUTATION_UNAVAILABLE",
        message: `LUMEN trust oracle unreachable for "${input.server.id}"; proceeding on a neutral score (autonomy preserved).`,
      };
      return { findings: [finding], score: 0.6 };
    }

    const score = clamp01(result.score);

    if (score < input.policy.minReputation) {
      const finding: WardenFinding = {
        gate: this.name,
        severity: "high",
        code: "REPUTATION_LOW",
        message:
          `Server "${input.server.id}" trust score ${score.toFixed(3)} is below the ` +
          `minimum ${input.policy.minReputation.toFixed(3)}.`,
      };
      return {
        findings: [finding],
        score,
        fatal: input.policy.allowUnknownServers !== true,
      };
    }

    return {
      findings: [
        {
          gate: this.name,
          severity: "info",
          code: "REPUTATION_OK",
          message: `Server "${input.server.id}" trust score ${score.toFixed(3)} meets the minimum ${input.policy.minReputation.toFixed(3)}.`,
        },
      ],
      score,
    };
  }
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}
