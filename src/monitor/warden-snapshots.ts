import type { WardenVerdict } from "../types.js";

export interface WardenBlockSnapshot {
  serverName: string;
  score: number;
  decidedBy: string;
  topFinding: string;
  blockedTools: string[];
}

const MAX = 8;

function topFinding(verdict: WardenVerdict): string {
  const f = verdict.findings?.[0];
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
