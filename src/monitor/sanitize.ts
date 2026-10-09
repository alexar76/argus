/** Field length caps — must stay in sync with alien-monitor/backend/argus_feed.py */
export const MONITOR_LIMITS = {
  id: 64,
  goal: 240,
  beatTitle: 80,
  beatDetail: 240,
  beatMeta: 160,
  receiptHash: 80,
  signer: 80,
  verifyUrl: 300,
  maxBeats: 12,
} as const;

const SECRET_PATTERNS: RegExp[] = [
  /\bsk-[a-zA-Z0-9_-]{16,}\b/g,
  /\bBearer\s+[a-zA-Z0-9._-]+\b/gi,
  /\b(?:api[_-]?key|token|secret|password)\s*[:=]\s*\S+/gi,
  // 64-hex private keys / seeds (not 40-char addresses).
  /\b0x[a-fA-F0-9]{64}\b/g,
];

/** Strip control chars, collapse whitespace, redact obvious secrets. */
export function sanitizeMonitorText(input: string, maxLen: number): string {
  let s = input
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  for (const re of SECRET_PATTERNS) {
    s = s.replace(re, "[redacted]");
  }
  if (s.length > maxLen) s = s.slice(0, maxLen - 1) + "…";
  return s;
}

/** Display hash like `0x4b9e…e9` for monitor meta lines. */
export function shortHash(hex: string, head = 4, tail = 2): string {
  const raw = hex.replace(/^0x/i, "");
  if (!raw) return "";
  if (raw.length <= head + tail + 1) return raw.startsWith("0x") ? hex : `0x${raw}`;
  return `0x${raw.slice(0, head)}…${raw.slice(-tail)}`;
}

export function finiteUsd(n: unknown): number {
  const v = typeof n === "number" ? n : Number(n);
  return Number.isFinite(v) && v >= 0 ? Math.round(v * 1_000_000) / 1_000_000 : 0;
}
