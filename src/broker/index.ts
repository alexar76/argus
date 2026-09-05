/**
 * Budget Broker decision core — the make/buy frontier.
 *
 * Ideology: ARGUS earns its keep by being honest about money. For every task it can
 * either *make* a capability itself (burn its own LLM tokens) or *buy* it from the
 * AICOM economy (pay another agent's oracle/capability). This module is the pure,
 * side-effect-free arithmetic that decides which — and, just as importantly, emits an
 * auditable one-liner so the choice can be re-checked after the fact. It performs NO
 * I/O: callers pass in the live token meter's in-house estimate, the cheapest market
 * quote, the remaining budget, and an optional trust floor. Everything here is a pure
 * function so the frontier is testable in isolation and identical offline and online.
 *
 * The buy rule is intentionally conservative — ARGUS only spends external money when
 * it is strictly cheaper than making it locally, fits inside the remaining budget, and
 * (when a trust floor is set) comes from a counterparty trusted enough to rely on.
 */

/** A market quote for a capability ARGUS could buy instead of making. */
export interface CapabilityQuote {
  /** Capability identifier (e.g. "translate", "summarize"). */
  capabilityId: string;
  /** Price to buy this capability, in USD. */
  priceUsd: number;
  /** Optional trust score for the counterparty offering it (e.g. LUMEN reputation). */
  trustScore?: number;
}

/** Inputs to the make/buy decision. */
export interface MakeBuyInput {
  /** Marginal USD cost to make the capability in-house (from the live token meter). */
  inHouseUsd: number;
  /** The cheapest available market quote, or `null` if nothing is on offer. */
  cheapest: CapabilityQuote | null;
  /** USD still available to spend on this task. */
  remainingUsd: number;
  /**
   * Optional trust floor. When set, a buy is only allowed from a counterparty whose
   * `trustScore` is at least this value (a missing score is treated as 0 — untrusted).
   */
  minTrust?: number;
}

/** The broker's verdict. */
export interface MakeBuyDecision {
  /** Whether to make the capability locally or buy it from the economy. */
  action: "make" | "buy";
  /** Machine-readable short reason code-ish phrase for the decision. */
  reason: string;
  /** Human-readable, auditable one-liner suitable for a journal/receipt. */
  line: string;
}

/** Per-million-token pricing for a model, used to estimate the in-house cost. */
export interface TokenPricing {
  /** USD per 1,000,000 input tokens. */
  inputPerMTok: number;
  /** USD per 1,000,000 output tokens. */
  outputPerMTok: number;
}

/** Format a USD amount for the audit line: trims to a stable, readable precision. */
function usd(n: number): string {
  if (!Number.isFinite(n)) return "$?";
  // Up to 6 significant decimals, but strip trailing zeros so "$0.004" not "$0.004000".
  const fixed = n.toFixed(6);
  const trimmed = fixed.replace(/\.?0+$/, "");
  return `$${trimmed === "" ? "0" : trimmed}`;
}

/**
 * Decide whether to MAKE a capability in-house or BUY it from the economy.
 *
 * BUY iff ALL of:
 *  - a cheapest quote exists, AND
 *  - `cheapest.priceUsd < inHouseUsd` (strictly cheaper to buy), AND
 *  - `cheapest.priceUsd <= remainingUsd` (we can afford it), AND
 *  - the trust gate passes: `minTrust == null` OR `(cheapest.trustScore ?? 0) >= minTrust`.
 *
 * Otherwise MAKE. The decision is total and pure; ties (equal price) make locally.
 */
export function decideMakeBuy(opts: MakeBuyInput): MakeBuyDecision {
  const { inHouseUsd, cheapest, remainingUsd, minTrust } = opts;

  if (cheapest === null) {
    return {
      action: "make",
      reason: "no-capability",
      line: `made locally (~${usd(inHouseUsd)}; no capability on offer to buy)`,
    };
  }

  const { capabilityId, priceUsd } = cheapest;
  // Negative prices are bogus — reject the quote before any comparison.
  if (priceUsd < 0) {
    return {
      action: "make",
      reason: "invalid-price",
      line: `made locally (~${usd(inHouseUsd)}; cheapest buy ${capabilityId} has invalid price ${usd(priceUsd)})`,
    };
  }
  const trust = cheapest.trustScore ?? 0;
  const gated = minTrust != null && trust < minTrust;
  const cheaperToBuy = priceUsd < inHouseUsd;
  const affordable = priceUsd <= remainingUsd;

  if (cheaperToBuy && affordable && !gated) {
    return {
      action: "buy",
      reason: "cheaper-and-trusted",
      line: `bought ${capabilityId} (${usd(priceUsd)}) vs ~${usd(inHouseUsd)} in-house`,
    };
  }

  // MAKE — pick the most specific reason, in priority order, for the audit line.
  if (gated) {
    const trustStr = cheapest.trustScore == null ? "no trust score" : `trust ${trust} < min ${minTrust}`;
    return {
      action: "make",
      reason: "untrusted",
      line: `made locally (~${usd(inHouseUsd)}; cheapest buy ${capabilityId} ${usd(priceUsd)} blocked: ${trustStr})`,
    };
  }
  if (!cheaperToBuy) {
    return {
      action: "make",
      reason: "in-house-cheaper",
      line: `made locally (~${usd(inHouseUsd)}; cheapest buy ${usd(priceUsd)} exceeds it)`,
    };
  }
  // affordable === false (price is cheaper than in-house, but over the remaining budget)
  return {
    action: "make",
    reason: "over-budget",
    line: `made locally (~${usd(inHouseUsd)}; cheapest buy ${usd(priceUsd)} over remaining ${usd(remainingUsd)})`,
  };
}

/**
 * Estimate the marginal in-house USD cost of producing `tokensOut` tokens given
 * `tokensIn` of context, at the supplied model pricing. Pure mirror of the live meter:
 *
 *   cost = tokensIn / 1e6 * inputPerMTok + tokensOut / 1e6 * outputPerMTok
 *
 * Negative token counts are clamped to 0 so a bad caller can never produce a negative
 * cost that would make every buy look "expensive".
 */
export function estimateInHouseUsd(
  tokensIn: number,
  tokensOut: number,
  pricing: TokenPricing,
): number {
  const inTok = Math.max(0, tokensIn);
  const outTok = Math.max(0, tokensOut);
  const inputCost = (inTok / 1_000_000) * pricing.inputPerMTok;
  const outputCost = (outTok / 1_000_000) * pricing.outputPerMTok;
  return inputCost + outputCost;
}
