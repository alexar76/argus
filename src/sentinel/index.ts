/**
 * Drift Sentinel — behavioral baseline + O(1) deviation detector.
 *
 * Ideology: WARDEN's tool-def pinning catches a server that *changes its declared
 * contract* (a rug-pull at the schema level). But a tool whose definition never
 * changes can still start *behaving* differently at runtime — phoning a brand-new
 * host, or suddenly emitting a megabyte where it always emitted a kilobyte. Those
 * are the runtime tells of exfiltration / prompt-injection takeover that a static
 * hash can never see. Drift Sentinel is the behavioral complement: it learns a cheap
 * per-tool baseline from observations the agent *already has* (which egress hosts a
 * call touched, how many bytes it returned) and flags when a fresh observation
 * deviates.
 *
 * It is deliberately cheap and honest about its own ignorance:
 *  - O(1) update and O(1) compare — no buffers, no history, no re-running an LLM.
 *    Output-size statistics use Welford's online algorithm (running mean + M2), so
 *    memory is constant regardless of how many calls a tool has made.
 *  - Cold-start safe: a null baseline, or one with too few samples, NEVER flags.
 *    A monitor that screams on its first observation is noise, not signal — so the
 *    detector earns the right to flag only after it has actually seen normal.
 *  - Pure functions. The baseline is plain data you persist however you like
 *    (per tool, in MemoryStore, in a JSON blob); nothing here imports a client,
 *    a clock, or another feature module.
 */

/** Per-tool behavioral baseline. Plain, serializable data — persist it as you like. */
export interface ToolBaseline {
  /** Number of observations folded into this baseline. */
  count: number;
  /** Union of every egress host this tool has ever been observed contacting. */
  egressHosts: string[];
  /** Running mean of output size in bytes (Welford). */
  meanBytes: number;
  /** Welford's M2 accumulator (sum of squared deviations) for output size. */
  m2Bytes: number;
}

/** A single behavioral observation of a tool call. */
export interface Observation {
  /** Egress hosts the call was observed contacting (hostnames; order/dupes don't matter). */
  egressHosts: string[];
  /** Size of the tool's output in bytes. */
  outputBytes: number;
}

/** Result of comparing an observation to a baseline. */
export interface DeviationResult {
  /** True iff at least one flag fired. Always false on a cold/low-count baseline. */
  deviation: boolean;
  /** Human-readable reason(s) the observation was flagged; empty when not flagged. */
  reasons: string[];
}

/** Tunable thresholds for {@link compareToBaseline}. */
export interface SentinelOptions {
  /**
   * Output size is flagged when `outputBytes > mean + k * stddev`.
   * Higher k = more tolerant. Default 6 (very conservative — only egregious blowups).
   */
  k?: number;
  /**
   * Minimum observation count before the *output-size* check is allowed to fire.
   * Below this the running variance is too unstable to trust. Default 8.
   */
  minSamples?: number;
}

const DEFAULT_K = 6;
const DEFAULT_MIN_SAMPLES = 8;

/** Normalize a host list: trim, lowercase, drop empties — host identity should be canonical. */
function normalizeHosts(hosts: readonly string[]): string[] {
  const out: string[] = [];
  for (const h of hosts) {
    const n = h.trim().toLowerCase();
    if (n.length > 0) out.push(n);
  }
  return out;
}

/** Coerce a possibly-bad byte count to a finite, non-negative number. */
function safeBytes(n: number): number {
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Fold one observation into a baseline, returning a NEW baseline (pure; never mutates
 * the input). A null baseline seeds a fresh one. O(1): egress hosts accumulate as a
 * deduped union; output size advances Welford's mean/M2 in constant time.
 */
export function updateBaseline(baseline: ToolBaseline | null, obs: Observation): ToolBaseline {
  const prevCount = baseline?.count ?? 0;
  const prevMean = baseline?.meanBytes ?? 0;
  const prevM2 = baseline?.m2Bytes ?? 0;

  // Union of egress hosts (Set keeps it O(hosts) per call, constant in history size).
  const hosts = new Set<string>(baseline?.egressHosts ?? []);
  for (const h of normalizeHosts(obs.egressHosts)) hosts.add(h);

  // Welford online update for output size.
  const x = safeBytes(obs.outputBytes);
  const count = prevCount + 1;
  const delta = x - prevMean;
  const meanBytes = prevMean + delta / count;
  const delta2 = x - meanBytes;
  const m2Bytes = prevM2 + delta * delta2;

  return {
    count,
    egressHosts: [...hosts].sort(),
    meanBytes,
    m2Bytes,
  };
}

/** Population standard deviation of output size from a baseline (0 until count >= 2). */
export function stddevBytes(baseline: ToolBaseline | null): number {
  if (!baseline || baseline.count < 2) return 0;
  const variance = baseline.m2Bytes / baseline.count;
  return variance > 0 ? Math.sqrt(variance) : 0;
}

/**
 * Compare a fresh observation against a baseline. Cold-start safe: a null baseline,
 * or one whose count is below `minSamples`, NEVER flags (returns `deviation:false`),
 * because a detector that hasn't seen "normal" cannot define "abnormal".
 *
 * Once warmed up it flags two independent behavioral drifts:
 *  - NEW egress host: a host in the observation that the baseline has never seen.
 *    (This fires as soon as the baseline has any samples — a never-before-seen
 *    destination is suspicious even early, and is itself the definition of new.)
 *  - OUTPUT BLOWUP: `outputBytes > mean + k * stddev`, gated on `count >= minSamples`
 *    so we don't flag on an unstable early variance.
 *
 * O(1). Never runs a model.
 */
export function compareToBaseline(
  baseline: ToolBaseline | null,
  obs: Observation,
  options: SentinelOptions = {},
): DeviationResult {
  const reasons: string[] = [];

  // Cold start: no baseline at all → cannot judge. Never flag.
  if (!baseline || baseline.count <= 0) {
    return { deviation: false, reasons };
  }

  const k = options.k ?? DEFAULT_K;
  const minSamples = options.minSamples ?? DEFAULT_MIN_SAMPLES;

  // New-egress-host check: any observed host the baseline has never recorded.
  const known = new Set<string>(baseline.egressHosts);
  const seenNew = new Set<string>();
  for (const h of normalizeHosts(obs.egressHosts)) {
    if (!known.has(h) && !seenNew.has(h)) {
      seenNew.add(h);
      reasons.push(`new egress host "${h}" (not in baseline of ${known.size} known host(s))`);
    }
  }

  // Output-size blowup check — only once we have enough samples for a stable variance.
  if (baseline.count >= minSamples) {
    const x = safeBytes(obs.outputBytes);
    const sd = stddevBytes(baseline);
    const threshold = baseline.meanBytes + k * sd;
    // If there has been zero variance so far (sd === 0), any strict increase past the
    // mean is, by definition, beyond k*0 — but treat that as a blowup only when it is a
    // genuine jump, not floating-point noise, by requiring x to strictly exceed mean.
    if (x > threshold) {
      reasons.push(
        `output ${x}B exceeds mean+${k}·σ (${threshold.toFixed(1)}B; mean ${baseline.meanBytes.toFixed(1)}B, σ ${sd.toFixed(1)}B over ${baseline.count} samples)`,
      );
    }
  }

  return { deviation: reasons.length > 0, reasons };
}
