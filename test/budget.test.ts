import { describe, it, expect } from "vitest";
import { Budget, BudgetExceededError } from "../src/core/budget.js";

describe("Budget — token meter", () => {
  it("converts usage to USD at model pricing", () => {
    const b = new Budget({ maxUsdPerTask: 100 });
    b.record({ inputTokens: 1_000_000, outputTokens: 1_000_000, cachedInputTokens: 0 }, { inputPerM: 3, outputPerM: 15 });
    const s = b.snapshot();
    expect(s.inputTokens).toBe(1_000_000);
    expect(s.costUsd).toBeCloseTo(18, 5); // 3 (in) + 15 (out)
  });

  it("charges cached input at the cheaper cached rate", () => {
    const b = new Budget({});
    b.record({ inputTokens: 1_000_000, outputTokens: 0, cachedInputTokens: 1_000_000 }, { inputPerM: 3, outputPerM: 15, cachedInputPerM: 0.3 });
    expect(b.snapshot().costUsd).toBeCloseTo(0.3, 5);
  });
});

describe("Budget — governor (anti-overspend)", () => {
  it("throws when the step ceiling is exceeded", () => {
    const b = new Budget({ maxSteps: 2 });
    b.step();
    b.step();
    expect(() => b.step()).toThrow(BudgetExceededError);
  });

  it("throws when the dollar ceiling is exceeded", () => {
    const b = new Budget({ maxUsdPerTask: 0.001 });
    b.record({ inputTokens: 1_000_000, outputTokens: 0, cachedInputTokens: 0 }, { inputPerM: 3, outputPerM: 15 });
    expect(() => b.step()).toThrow(BudgetExceededError);
  });

  it("throws when the tool-call ceiling is exceeded", () => {
    const b = new Budget({ maxToolCalls: 1 });
    b.tool();
    expect(() => b.tool()).toThrow(BudgetExceededError);
  });
});
