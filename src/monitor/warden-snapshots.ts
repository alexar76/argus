import type { WardenVerdict } from "../types.js";

export interface WardenBlockSnapshot {
  serverName: string;
  score: number;
  decidedBy: string;
  topFinding: string;
  blockedTools: string[];
}

const MAX = 8;

const SEVERITY_RANK: Record<string, number> = { info: 0, low: 1, medium: 2, high: 3, critical: 4 };

/**
 * The finding that explains a block. Advisory findings never block, so reporting
 * one as the reason a server was refused would name the wrong cause — and they
 * sort first often enough (the scan walks descriptions before schemas) that
 * taking findings[0] picked them.
 */
function topFinding(verdict: WardenVerdict): string {
  const blocking = (verdict.findings ?? []).filter((f) => !f.advisory);
  const pool = blocking.length ? blocking : (verdict.findings ?? []);
  const f = pool.reduce<(typeof pool)[number] | undefined>(
    (best, cur) =>
      !best || (SEVERITY_RANK[cur.severity] ?? 0) > (SEVERITY_RANK[best.severity] ?? 0) ? cur : best,
    undefined,
  );
  if (!f) return "blocked by policy";
  return f.severity ? `${f.code} · ${f.severity}` : f.code;
}

/** Per-runtime buffer for MCP connect-time WARDEN blocks (avoids cross-run bleed). */
export class WardenBlockBuffer {
  private recent: WardenBlockSnapshot[] = [];

  record(serverName: string, verdict: WardenVerdict): void {
    this.recent.push({
      serverName,
      score: verdict.score,
      decidedBy: verdict.decidedBy ?? "warden",
      topFinding: topFinding(verdict),
      blockedTools: (verdict.blockedTools ?? []).slice(0, 6),
    });
    while (this.recent.length > MAX) this.recent.shift();
  }

  peek(): WardenBlockSnapshot[] {
    return [...this.recent];
  }

  drain(): void {
    this.recent = [];
  }

  clear(): void {
    this.recent = [];
  }
}
