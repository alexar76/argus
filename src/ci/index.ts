/**
 * Sentinel-CI — read-side core.
 *
 * Ideology: ARGUS chooses what to invoke at *discover* time, before it spends a
 * cent. A capability that publishes a Sentinel-CI badge is telling you "my last
 * continuous-integration run looked like THIS". This module reads that badge off a
 * discovered capability and turns it into a decision input — without trusting the
 * badge blindly and, crucially, without *punishing* a capability merely for not
 * having one. The default posture is ADVISORY: a missing or unknown badge is never
 * a reason to block, only a reason to rank lower than a known-green peer. A caller
 * who wants the strict posture ("green or nothing") opts into it explicitly.
 *
 * The module is pure and self-contained: it reads only what is on the capability
 * record, makes no network calls, signs nothing, and has no dependency on any other
 * feature module. Everything it returns is recomputable from its inputs.
 *
 * Badge shape (all fields optional; the producer is on the supply side):
 *   cap.ci = {
 *     status?: "green" | "red" | "unknown",  // explicit verdict
 *     passRate?: number,    // 0..1 fraction of tests passing on the last run
 *     p95Ms?: number,       // 95th-percentile latency observed in CI (ms)
 *     lastGreen?: string,   // ISO timestamp of the last all-green run
 *     // any extra fields are ignored
 *   }
 */

/** A parsed, normalised view of a capability's CI badge. */
export interface CiBadge {
  /** "green" = healthy, "red" = failing, "unknown" = no usable badge. */
  status: "green" | "red" | "unknown";
  /** Fraction of tests passing on the last run, clamped to 0..1. Absent if not published. */
  passRate?: number;
  /** 95th-percentile latency from CI, in ms. Absent if not published or invalid. */
  p95Ms?: number;
  /** ISO timestamp of the last all-green run, if published. */
  lastGreen?: string;
}

/** Result of evaluating a CI policy against a capability. */
export interface CiGateDecision {
  /** Whether the capability passes the policy. */
  allow: boolean;
  /** Human-readable explanation of the decision (always populated). */
  reason: string;
}

/** Policy knobs for {@link gateByCi}. All optional → the default posture is advisory. */
export interface CiPolicy {
  /**
   * When true, a capability is blocked unless its badge is explicitly "green".
   * This also blocks "unknown" — the only case where unknown is ever blocked.
   * Default: false (advisory; unknown and green both allowed, only red is blocked).
   */
  requireGreen?: boolean;
  /**
   * Minimum acceptable passRate (0..1). A capability whose badge publishes a
   * passRate strictly below this is blocked. A capability with no published
   * passRate is NOT blocked by this rule alone (absence ≠ failure).
   */
  minPassRate?: number;
}

/** Coerce an unknown into a finite number, or return undefined. */
function asFiniteNumber(v: unknown): number | undefined {
  if (typeof v !== "number" || !Number.isFinite(v)) return undefined;
  return v;
}

/** Clamp a number into [lo, hi]. */
function clamp(n: number, lo: number, hi: number): number {
  return n < lo ? lo : n > hi ? hi : n;
}

/**
 * Read and normalise the optional `ci` badge off a discovered capability.
 *
 * - A missing, non-object, or unrecognised badge → `{ status: "unknown" }`.
 * - An explicit `status` of "green"/"red"/"unknown" is honoured verbatim.
 * - If `status` is absent but a numeric `passRate` is present, status is inferred:
 *   a perfect (1.0) passRate reads as "green", anything less as "red".
 * - `passRate` is clamped to 0..1; `p95Ms` must be a finite, non-negative number
 *   to be carried through; `lastGreen` is carried only when it is a string.
 *
 * Pure: depends only on `cap`. Never throws.
 */
export function parseCiBadge(cap: Record<string, unknown>): CiBadge {
  const raw = cap.ci;
  if (raw === null || typeof raw !== "object") return { status: "unknown" };
  const badge = raw as Record<string, unknown>;

  const passRateRaw = asFiniteNumber(badge.passRate);
  const passRate = passRateRaw === undefined ? undefined : clamp(passRateRaw, 0, 1);

  const p95Raw = asFiniteNumber(badge.p95Ms);
  const p95Ms = p95Raw === undefined || p95Raw < 0 ? undefined : p95Raw;

  const lastGreen = typeof badge.lastGreen === "string" ? badge.lastGreen : undefined;

  // Determine status: honour an explicit, valid verdict; otherwise infer from passRate.
  let status: CiBadge["status"];
  const explicit = badge.status;
  if (explicit === "green" || explicit === "red" || explicit === "unknown") {
    status = explicit;
  } else if (passRate !== undefined) {
    status = passRate >= 1 ? "green" : "red";
  } else {
    status = "unknown";
  }

  const out: CiBadge = { status };
  if (passRate !== undefined) out.passRate = passRate;
  if (p95Ms !== undefined) out.p95Ms = p95Ms;
  if (lastGreen !== undefined) out.lastGreen = lastGreen;
  return out;
}

/**
 * Evaluate a CI policy against a capability's badge.
 *
 * Posture (advisory by default):
 *  - "red"      → blocked (a self-reported failing build is a real signal).
 *  - "green"    → allowed, unless it fails an explicit `minPassRate` floor.
 *  - "unknown"  → allowed, UNLESS `policy.requireGreen` is set, in which case the
 *                 absence of a green badge is treated as not-green and blocked.
 *
 * `minPassRate` only blocks when the badge actually publishes a passRate below the
 * floor; a capability that publishes no passRate is not blocked by that rule alone.
 *
 * Pure: depends only on `cap` and `policy`. Never throws. `reason` is always set.
 */
export function gateByCi(cap: Record<string, unknown>, policy: CiPolicy): CiGateDecision {
  const badge = parseCiBadge(cap);

  if (badge.status === "red") {
    return { allow: false, reason: "CI badge is red — last build failed" };
  }

  if (badge.status === "unknown") {
    if (policy.requireGreen) {
      return { allow: false, reason: "no green CI badge and policy.requireGreen is set" };
    }
    return { allow: true, reason: "no CI badge (advisory mode — unknown allowed)" };
  }

  // status === "green" from here on.
  if (policy.minPassRate !== undefined && badge.passRate !== undefined && badge.passRate < policy.minPassRate) {
    return {
      allow: false,
      reason: `CI passRate ${badge.passRate} below required ${policy.minPassRate}`,
    };
  }

  return { allow: true, reason: "CI badge is green" };
}

/** Numeric tier for stable sorting: green (0) before unknown (1) before red (2). */
function statusTier(status: CiBadge["status"]): number {
  switch (status) {
    case "green":
      return 0;
    case "unknown":
      return 1;
    case "red":
      return 2;
    default:
      return 1;
  }
}

/**
 * Stable-rank capabilities by CI health for discover-time presentation.
 *
 * Order: green > unknown > red. Within the same status tier, a higher published
 * `passRate` ranks first (a missing passRate is treated as the lowest, so a peer
 * with a known passRate outranks one with none). Ties preserve the input order
 * (stable). The input array is NOT mutated — a new array is returned.
 *
 * Pure: depends only on `caps`. Never throws.
 */
export function rankByCi(caps: Record<string, unknown>[]): Record<string, unknown>[] {
  const decorated = caps.map((cap, index) => {
    const badge = parseCiBadge(cap);
    return {
      cap,
      index,
      tier: statusTier(badge.status),
      // -1 sorts after any real 0..1 rate, so "no passRate" loses to a known rate.
      passRate: badge.passRate ?? -1,
    };
  });

  decorated.sort((a, b) => {
    if (a.tier !== b.tier) return a.tier - b.tier;
    if (a.passRate !== b.passRate) return b.passRate - a.passRate; // higher first
    return a.index - b.index; // stable
  });

  return decorated.map((d) => d.cap);
}
