import type { ArenaStats } from "./arena.js";

/**
 * ASCII Flex Card — the terminal/Telegram fallback (the SVG/PNG variants are
 * served by the /arena web page). Never fails on a headless box or over SSH.
 */
export function renderAsciiCard(s: ArenaStats): string {
  const W = 48;
  const top = [s.handle, `Lv ${s.level}`];
  const winPct = Math.round(s.winRate * 100);
  const barFilled = Math.round((winPct / 100) * 10);
  const bar = "▰".repeat(barFilled) + "▱".repeat(10 - barFilled);
  const unlocked = s.badges.filter((b) => b.unlocked).slice(0, 3);
  const badgeLine = unlocked.length ? unlocked.map((b) => `${b.glyph} ${b.name}`).join("   ") : "(no badges yet — go earn some)";

  const rows = [
    `ARGUS · AGENT ARENA          🎮  Lv ${s.level}`,
    `@${s.handle}`,
    "",
    `🔥 Streak   ${s.streak} days   (best ${s.longestStreak})`,
    `💸 Earned   $${s.earnedUsd.toFixed(2)}${s.economy === "off" ? "  (autonomous)" : ""}`,
    `🎯 Win-rate ${winPct}%   ${bar}   (${s.tasks} tasks)`,
    `🔮 LUMEN    ${s.lumenRank ?? "—  (connect wallet)"}`,
    `⭐ XP       ${s.xpIntoLevel}/${s.xpForLevel} to Lv ${s.level + 1}`,
    "",
    `Badges  ${badgeLine}`,
  ];

  const line = (c: string) => c.repeat(W);
  // Inner width = W. Layout: ║ + 2 leading spaces + body + trailing spaces + ║.
  // Emoji render ~2 cells wide but count as 1+ code points, so measure visually.
  const pad = (t: string) => {
    const trailing = Math.max(0, W - 2 - visualWidth(t));
    return `║  ${t}${" ".repeat(trailing)}║`;
  };
  void top;
  return [
    `╔${line("═")}╗`,
    ...rows.map(pad),
    `╟${line("─")}╢`,
    pad(`▲ AICOM  ·  alexar76.github.io/aicom`),
    `╚${line("═")}╝`,
  ].join("\n");
}

/** Approximate terminal display width: emoji + ⭐ are double-width; FE0F is zero. */
function visualWidth(s: string): number {
  let w = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp === 0xfe0f) continue;
    w += cp >= 0x1f300 || cp === 0x2b50 ? 2 : 1;
  }
  return w;
}
