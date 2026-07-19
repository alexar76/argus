import type {
  Logger,
  McpServerRef,
  MemoryStore,
  Severity,
  ToolDef,
  TrustOracle,
  WardenFinding,
  WardenGate,
  WardenPolicy,
  WardenVerdict,
} from "../types.js";
import { StaticScanGate } from "./static-scan.js";
import { PinningGate } from "./pinning.js";
import { ReputationGate } from "./reputation.js";
import { ThreatFeed, ThreatGate } from "./threat-feed.js";
import { classifyTools } from "./sandbox.js";

export { StaticScanGate } from "./static-scan.js";
export { PinningGate, canonicalToolsHash } from "./pinning.js";
export { ReputationGate } from "./reputation.js";
export { ThreatFeed, ThreatGate } from "./threat-feed.js";
export { EgressGuard, isSensitiveTool, classifyTools } from "./sandbox.js";

const SEVERITY_RANK: Record<Severity, number> = {
  info: 0,
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

export interface WardenInit {
  gates: WardenGate[];
  policy: WardenPolicy;
  log: Logger;
}

export interface WardenCreateDeps {
  oracle: TrustOracle;
  store: MemoryStore;
  policy: WardenPolicy;
  threatFeed: ThreatFeed;
  log: Logger;
}

/**
 * WARDEN — the MCP security firewall.
 *
 * Every MCP server is vetted through an ordered gate chain before its tools are
 * exposed to the agent: cheap static scanning first, then the known-bad threat
 * feed, then network reputation, then drift/pinning. Findings accumulate across
 * gates; the verdict is allow/block plus a composite 0..1 safety score and a
 * per-tool partition so a mostly-trusted server can have one poisoned tool
 * quarantined without severing the whole connection.
 */
export class Warden {
  private readonly gates: WardenGate[];
  private readonly policy: WardenPolicy;
  private readonly log: Logger;

  constructor(init: WardenInit) {
    this.gates = init.gates;
    this.policy = init.policy;
    this.log = init.log.child("warden");
    this.validatePolicy();
  }

  /**
   * Guard against config typos that silently disable blocking. If blockAtSeverity
   * isn't a valid Severity key, SEVERITY_RANK[bad] is undefined and every
   * comparison `number >= undefined` is false — zero blocks, zero warnings.
   */
  private validatePolicy(): void {
    const valid: Severity[] = ["info", "low", "medium", "high", "critical"];
    if (!valid.includes(this.policy.blockAtSeverity)) {
      const fallback: Severity = "high";
      this.log.warn(
        `WARDEN: invalid blockAtSeverity "${String(this.policy.blockAtSeverity)}" ` +
        `(expected one of ${valid.join(", ")}) — falling back to "${fallback}" to keep blocking enabled`,
      );
      (this.policy as WardenPolicy).blockAtSeverity = fallback;
    }
  }

  /** Build the standard gate chain: static → threat → reputation → pinning. */
  static create(deps: WardenCreateDeps): Warden {
    const gates: WardenGate[] = [
      new StaticScanGate(),
      new ThreatGate(deps.threatFeed),
      new ReputationGate(deps.oracle),
      new PinningGate(deps.store),
    ];
    return new Warden({ gates, policy: deps.policy, log: deps.log });
  }

  /**
   * Vet a server and its advertised tools. Runs every gate in order, short-
   * circuiting only on a fatal gate result. A connection is blocked if any gate
   * is fatal or any finding reaches policy.blockAtSeverity.
   */
  async vet(server: McpServerRef, tools: ToolDef[]): Promise<WardenVerdict> {
    const findings: WardenFinding[] = [];
    const scores: number[] = [];
    let allow = true;
    let decidedBy: string | undefined;
    const blockThreshold = SEVERITY_RANK[this.policy.blockAtSeverity];

    for (const gate of this.gates) {
      const result = await gate.evaluate({
        server,
        tools,
        prior: [...findings],
        policy: this.policy,
      });
      findings.push(...result.findings);
      scores.push(clamp01(result.score));

      const tripped = result.findings.some((f) => SEVERITY_RANK[f.severity] >= blockThreshold);
      if (result.fatal || tripped) {
        if (allow) {
          allow = false;
          decidedBy = gate.name;
        }
        if (result.fatal) {
          this.log.warn(`gate "${gate.name}" returned fatal for server ${server.id}`);
          break; // short-circuit only on an explicit fatal
        }
      }
    }

    // Composite score: product of gate contributions (one bad gate drags it down).
    const score = scores.reduce((acc, s) => acc * s, 1);

    const { allowedTools, blockedTools } = this.partitionTools(tools, findings, blockThreshold);

    if (!allow) {
      this.log.warn(`BLOCK ${server.id} (decidedBy=${decidedBy}, score=${score.toFixed(3)}, findings=${findings.length})`);
    } else {
      this.log.info(`ALLOW ${server.id} (score=${score.toFixed(3)}, sensitive=${blockedTools.length === 0 ? this.sensitiveCount(tools) : "?"})`);
    }

    return { allow, score: clamp01(score), decidedBy, findings, allowedTools, blockedTools };
  }

  /**
   * Record the user's approval: pin the current tool defs so future drift is
   * detected. Idempotent — re-approving just refreshes the snapshot.
   */
  async approve(server: McpServerRef, tools: ToolDef[]): Promise<void> {
    const pinning = this.gates.find((g): g is PinningGate => g instanceof PinningGate);
    if (!pinning) {
      this.log.warn("approve() called but no PinningGate in the chain; nothing to pin");
      return;
    }
    await pinning.pin(server, tools);
    this.log.info(`pinned tool defs for ${server.id} (${tools.length} tools)`);
  }

  /**
   * A tool is blocked if a finding naming it reaches the block threshold.
   * Sensitive tools (per policy) stay allowed but are surfaced as flagged so the
   * agent loop can demand per-call approval at run time.
   */
  private partitionTools(
    tools: ToolDef[],
    findings: WardenFinding[],
    blockThreshold: number,
  ): { allowedTools: string[]; blockedTools: string[] } {
    const blockedByFinding = new Set<string>();
    for (const f of findings) {
      if (f.tool && SEVERITY_RANK[f.severity] >= blockThreshold) blockedByFinding.add(f.tool);
    }

    const allowedTools: string[] = [];
    const blockedTools: string[] = [];
    for (const tool of tools) {
      if (blockedByFinding.has(tool.name)) blockedTools.push(tool.name);
      else allowedTools.push(tool.name);
    }
    return { allowedTools, blockedTools };
  }

  private sensitiveCount(tools: ToolDef[]): number {
    return classifyTools(tools, this.policy).sensitive.length;
  }
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}
