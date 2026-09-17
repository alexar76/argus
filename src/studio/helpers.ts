/** Coerce to a finite number, else fallback. */
export function num(v: unknown, fallback: number): number {
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? n : fallback;
}

/** Coerce to an integer in [lo, hi], else fallback (then clamped). */
export function intIn(v: unknown, fallback: number, lo: number, hi: number): number {
  const n = Math.trunc(num(v, fallback));
  return Math.max(lo, Math.min(hi, n));
}

/** Read a record field as `unknown` without `any`. */
export function field(o: unknown, k: string): unknown {
  return o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined;
}

/** Treat `output` as a record (oracle outputs are JSON objects). */
export function asRecord(o: unknown): Record<string, unknown> {
  return o && typeof o === "object" ? (o as Record<string, unknown>) : {};
}

/** Format a number compactly (trims noisy trailing decimals). */
export function fmt(n: number, digits = 4): string {
  if (!Number.isFinite(n)) return "n/a";
  if (Number.isInteger(n)) return String(n);
  return Number(n.toFixed(digits)).toString();
}

/** Coerce an unknown to an array, or [] — keeps element type `unknown`. */
export function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

/** First N labels from a string-ish array, comma-joined. */
export function labels(v: unknown, n: number): string {
  return arr(v).slice(0, n).map((x) => String(x)).join(", ");
}
