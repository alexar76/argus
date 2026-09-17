import type { ArgusConfig } from "../config.js";
import type { Episode, Logger, MemoryStore } from "../types.js";

export interface BadgeView {
  id: string;
  glyph: string;
  name: string;
  unlocked: boolean;
  color: string;
}

export interface ArenaStats {
  handle: string;
  level: number;
  tier: string;
  xp: number;
  xpIntoLevel: number;
  xpForLevel: number;
  streak: number;
  longestStreak: number;
  earnedUsd: number;
  winRate: number;
  tasks: number;
  lumenRank: string | null;
  economy: "on" | "off";
  badges: BadgeView[];
  leaderboard: Array<{ rank: number; handle: string; metric: string; level: number; you?: boolean }>;
  updatedAt: string;
}

/** Cumulative XP required to REACH level n (doc §2). */
function xpToReach(n: number): number {
  return 50 * n * (n + 1);
}
function levelFromXp(xp: number): number {
  let n = 0;
  while (xpToReach(n + 1) <= xp) n++;
  return n;
}
function tierFor(level: number): string {
  if (level >= 50) return "economy legend";
  if (level >= 20) return "economy regular";
  if (level >= 10) return "frugal power-user";
  if (level >= 5) return "rising agent";
  return "newcomer";
}

/**
 * Agent Arena — a PURE READ-PROJECTION over the memory store. It adds no writes
 * to the hot path: XP, levels, streaks and badges are all derived from episodes
 * the bounded agent loop already records. Economy/lottery/LUMEN-linked metrics
 * stay at zero/locked until those native integrations land (see docs/arena.md),
 * so Arena works fully in autonomous, wallet-less mode.
 */
export class Arena {
  private readonly frugalUsd: number;
  private readonly polyglotMin: number;

  constructor(
    private readonly memory: MemoryStore,
    private readonly config: ArgusConfig,
    private readonly log: Logger,
    private readonly economyOn: boolean,
  ) {
    this.frugalUsd = config.arena.frugalUsd ?? 0.001;
    this.polyglotMin = config.arena.polyglotMin ?? 4;
  }

  async stats(): Promise<ArenaStats> {
    const eps = await this.memory.recentEpisodes(5000).catch(() => [] as Episode[]);
    const successes = eps.filter((e) => e.outcome === "success");
    const frugal = eps.filter((e) => e.costUsd < this.frugalUsd);
    const nightOwl = eps.filter((e) => {
      const h = new Date(e.createdAt).getHours();
      return h >= 0 && h < 5;
    });
    const providers = new Set(eps.map((e) => e.provider).filter(Boolean));

    // XP: 10 per successful task, +15 for a frugal one.
    let xp = 0;
    for (const e of successes) {
      xp += 10;
      if (e.costUsd < this.frugalUsd) xp += 15;
    }
    const level = levelFromXp(xp);
    const base = xpToReach(level);
    const next = xpToReach(level + 1);

    const { current, longest } = streaks(eps.map((e) => e.createdAt));
    const winRate = eps.length ? successes.length / eps.length : 0;

    const badges: BadgeView[] = [
      { id: "frugal", glyph: "🪙", name: "Frugal", color: "gold", unlocked: frugal.length > 0 },
      { id: "nightowl", glyph: "🦉", name: "Night Owl", color: "violet", unlocked: nightOwl.length >= 10 },
      { id: "polyglot", glyph: "🌐", name: "Polyglot", color: "violet", unlocked: providers.size >= this.polyglotMin },
      // Pending native integration — locked until their sources connect.
      { id: "warden", glyph: "🛡️", name: "Warden", color: "cyan", unlocked: false },
      { id: "rainmaker", glyph: "🌧️", name: "Rainmaker", color: "green", unlocked: false },
      { id: "firstblood", glyph: "🩸", name: "First Blood", color: "pink", unlocked: false },
      { id: "trusted", glyph: "🔮", name: "Trusted", color: "violet", unlocked: false },
      { id: "whale", glyph: "🐋", name: "Whale", color: "cyan", unlocked: false },
    ];

    const handle = this.config.arena.handle ?? "argus";
    const medianCost = median(successes.map((e) => e.costUsd));

    return {
      handle,
      level,
      tier: tierFor(level),
      xp,
      xpIntoLevel: xp - base,
      xpForLevel: next - base,
      streak: current,
      longestStreak: longest,
      earnedUsd: 0, // pending native economy
      winRate,
      tasks: eps.length,
      lumenRank: null, // pending LUMEN read
      economy: this.economyOn ? "on" : "off",
      badges,
      leaderboard: [
        { rank: 1, handle, metric: medianCost ? `$${medianCost.toFixed(4)}/task` : "—", level, you: true },
      ],
      updatedAt: new Date().toISOString(),
    };
  }
}

/** Current + longest run of consecutive local-days that have ≥1 episode. */
function streaks(timestamps: string[]): { current: number; longest: number } {
  const days = new Set<string>();
  for (const t of timestamps) {
    const d = new Date(t);
    if (!Number.isNaN(d.getTime())) days.add(dayKey(d));
  }
  if (days.size === 0) return { current: 0, longest: 0 };
  const sorted = [...days].sort();
  let longest = 1;
  let run = 1;
  for (let i = 1; i < sorted.length; i++) {
    if (isNextDay(sorted[i - 1]!, sorted[i]!)) run++;
    else run = 1;
    if (run > longest) longest = run;
  }
  // Current streak: consecutive days ending today or yesterday.
  const today = dayKey(new Date());
  const last = sorted[sorted.length - 1]!;
  let current = 0;
  if (last === today || isNextDay(last, today)) {
    current = 1;
    for (let i = sorted.length - 1; i > 0; i--) {
      if (isNextDay(sorted[i - 1]!, sorted[i]!)) current++;
      else break;
    }
  }
  return { current, longest };
}

function dayKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function isNextDay(a: string, b: string): boolean {
  const da = new Date(a + "T00:00:00");
  const db = new Date(b + "T00:00:00");
  return db.getTime() - da.getTime() === 86_400_000;
}
function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}
