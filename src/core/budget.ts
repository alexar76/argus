import type { BudgetLimits, MeterSnapshot, Pricing, Usage } from "../types.js";

export class BudgetExceededError extends Error {
  constructor(public readonly reason: string, public readonly snapshot: MeterSnapshot) {
    super(`Budget exceeded: ${reason}`);
    this.name = "BudgetExceededError";
  }
}

/**
 * Token meter + reasoning-budget governor.
 *
 * This is the structural answer to "no self-reflection on someone else's
 * budget": every step is metered in tokens AND dollars, and hard ceilings throw
 * rather than silently overspend. The live snapshot makes the "cheaper" claim
 * auditable instead of marketing.
 */
export class Budget {
  private inputTokens = 0;
  private outputTokens = 0;
  private cachedTokens = 0;
  private costUsd = 0;
  private steps = 0;
  private toolCalls = 0;

  constructor(private readonly limits: BudgetLimits) {}

  /** Record one LLM call's usage at the given model's pricing. */
  record(usage: Usage, pricing?: Pricing): void {
    this.inputTokens += usage.inputTokens;
    this.outputTokens += usage.outputTokens;
    this.cachedTokens += usage.cachedInputTokens;
    if (pricing) {
      const freshInput = Math.max(0, usage.inputTokens - usage.cachedInputTokens);
      const cachedRate = pricing.cachedInputPerM ?? pricing.inputPerM * 0.1;
      this.costUsd +=
        (freshInput / 1_000_000) * pricing.inputPerM +
        (usage.cachedInputTokens / 1_000_000) * cachedRate +
        (usage.outputTokens / 1_000_000) * pricing.outputPerM;
    }
  }

  /** Call before each agent step; throws if a ceiling is hit. */
  step(): void {
    this.steps += 1;
    this.enforce();
  }

  /** Call before each tool invocation. */
  tool(): void {
    this.toolCalls += 1;
    this.enforce();
  }

  private enforce(): void {
    const s = this.snapshot();
    if (this.limits.maxSteps != null && this.steps > this.limits.maxSteps)
      throw new BudgetExceededError(`maxSteps (${this.limits.maxSteps})`, s);
    if (this.limits.maxToolCalls != null && this.toolCalls > this.limits.maxToolCalls)
      throw new BudgetExceededError(`maxToolCalls (${this.limits.maxToolCalls})`, s);
    if (this.limits.maxTokensPerTask != null && this.inputTokens + this.outputTokens > this.limits.maxTokensPerTask)
      throw new BudgetExceededError(`maxTokensPerTask (${this.limits.maxTokensPerTask})`, s);
    if (this.limits.maxUsdPerTask != null && this.costUsd > this.limits.maxUsdPerTask)
      throw new BudgetExceededError(`maxUsdPerTask ($${this.limits.maxUsdPerTask})`, s);
  }

  /** Fraction of the dollar budget consumed (0..1+), for soft warnings. */
  get usedFraction(): number {
    if (!this.limits.maxUsdPerTask) return 0;
    return this.costUsd / this.limits.maxUsdPerTask;
  }

  snapshot(): MeterSnapshot {
    return {
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      cachedTokens: this.cachedTokens,
      costUsd: round(this.costUsd, 6),
      steps: this.steps,
      toolCalls: this.toolCalls,
    };
  }

  format(): string {
    const s = this.snapshot();
    const cacheRate = s.inputTokens ? Math.round((s.cachedTokens / s.inputTokens) * 100) : 0;
    return `tokens in/out ${s.inputTokens}/${s.outputTokens} (cache ${cacheRate}%) · steps ${s.steps} · tools ${s.toolCalls} · $${s.costUsd.toFixed(4)}`;
  }
}

function round(n: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}
