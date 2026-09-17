import { describe, it, expect } from "vitest";
import {
  decideMakeBuy,
  estimateInHouseUsd,
  type CapabilityQuote,
} from "../src/broker/index.js";

const cap = (over: Partial<CapabilityQuote> = {}): CapabilityQuote => ({
  capabilityId: "translate",
  priceUsd: 0.004,
  ...over,
});

describe("decideMakeBuy — the make/buy frontier", () => {
  it("BUYS when a capability is strictly cheaper and affordable", () => {
    const d = decideMakeBuy({
      inHouseUsd: 0.011,
      cheapest: cap({ priceUsd: 0.004 }),
      remainingUsd: 1,
    });
    expect(d.action).toBe("buy");
    expect(d.reason).toBe("cheaper-and-trusted");
    expect(d.line).toBe("bought translate ($0.004) vs ~$0.011 in-house");
  });

  it("MAKES when in-house is cheaper than the cheapest quote", () => {
    const d = decideMakeBuy({
      inHouseUsd: 0.002,
      cheapest: cap({ priceUsd: 0.006 }),
      remainingUsd: 1,
    });
    expect(d.action).toBe("make");
    expect(d.reason).toBe("in-house-cheaper");
    expect(d.line).toBe("made locally (~$0.002; cheapest buy $0.006 exceeds it)");
  });

  it("MAKES on a price tie (buy must be STRICTLY cheaper)", () => {
    const d = decideMakeBuy({
      inHouseUsd: 0.005,
      cheapest: cap({ priceUsd: 0.005 }),
      remainingUsd: 1,
    });
    expect(d.action).toBe("make");
    expect(d.reason).toBe("in-house-cheaper");
  });

  it("MAKES when the cheaper quote is over the remaining budget", () => {
    const d = decideMakeBuy({
      inHouseUsd: 0.5,
      cheapest: cap({ priceUsd: 0.2 }),
      remainingUsd: 0.1,
    });
    expect(d.action).toBe("make");
    expect(d.reason).toBe("over-budget");
    expect(d.line).toBe("made locally (~$0.5; cheapest buy $0.2 over remaining $0.1)");
  });

  it("BUYS when the price exactly equals the remaining budget (<= is affordable)", () => {
    const d = decideMakeBuy({
      inHouseUsd: 0.01,
      cheapest: cap({ priceUsd: 0.005 }),
      remainingUsd: 0.005,
    });
    expect(d.action).toBe("buy");
  });

  it("MAKES when there is no capability on offer", () => {
    const d = decideMakeBuy({
      inHouseUsd: 0.011,
      cheapest: null,
      remainingUsd: 1,
    });
    expect(d.action).toBe("make");
    expect(d.reason).toBe("no-capability");
    expect(d.line).toBe("made locally (~$0.011; no capability on offer to buy)");
  });

  describe("trust gate", () => {
    it("BLOCKS a cheap-but-untrusted buy (score below floor) → MAKE", () => {
      const d = decideMakeBuy({
        inHouseUsd: 0.011,
        cheapest: cap({ priceUsd: 0.004, trustScore: 0.3 }),
        remainingUsd: 1,
        minTrust: 0.7,
      });
      expect(d.action).toBe("make");
      expect(d.reason).toBe("untrusted");
      expect(d.line).toBe(
        "made locally (~$0.011; cheapest buy translate $0.004 blocked: trust 0.3 < min 0.7)",
      );
    });

    it("BLOCKS a buy when the quote has no trust score at all (treated as 0)", () => {
      const d = decideMakeBuy({
        inHouseUsd: 0.011,
        cheapest: cap({ priceUsd: 0.004 }), // no trustScore
        remainingUsd: 1,
        minTrust: 0.5,
      });
      expect(d.action).toBe("make");
      expect(d.reason).toBe("untrusted");
      expect(d.line).toContain("blocked: no trust score");
    });

    it("ALLOWS a buy when trust meets the floor exactly", () => {
      const d = decideMakeBuy({
        inHouseUsd: 0.011,
        cheapest: cap({ priceUsd: 0.004, trustScore: 0.7 }),
        remainingUsd: 1,
        minTrust: 0.7,
      });
      expect(d.action).toBe("buy");
    });

    it("ignores trust entirely when no floor is set", () => {
      const d = decideMakeBuy({
        inHouseUsd: 0.011,
        cheapest: cap({ priceUsd: 0.004 }), // no trustScore, no minTrust
        remainingUsd: 1,
      });
      expect(d.action).toBe("buy");
    });

    it("a minTrust of 0 still allows a zero-trust quote (>= 0)", () => {
      const d = decideMakeBuy({
        inHouseUsd: 0.011,
        cheapest: cap({ priceUsd: 0.004 }),
        remainingUsd: 1,
        minTrust: 0,
      });
      expect(d.action).toBe("buy");
    });
  });

  it("reason precedence: trust gate is reported even if also over-budget/dearer", () => {
    // Untrusted AND over budget AND not cheaper — the trust block is the headline reason.
    const d = decideMakeBuy({
      inHouseUsd: 0.001,
      cheapest: cap({ priceUsd: 0.5, trustScore: 0.1 }),
      remainingUsd: 0.01,
      minTrust: 0.9,
    });
    expect(d.action).toBe("make");
    expect(d.reason).toBe("untrusted");
  });
});

describe("estimateInHouseUsd — marginal cost from the live meter", () => {
  it("computes input + output cost at per-MTok pricing", () => {
    // 1M in @ $3 + 1M out @ $15 = $18
    expect(
      estimateInHouseUsd(1_000_000, 1_000_000, { inputPerMTok: 3, outputPerMTok: 15 }),
    ).toBeCloseTo(18, 9);
  });

  it("scales linearly for small token counts", () => {
    // 1000 in @ $3/M = $0.003 ; 500 out @ $15/M = $0.0075 ; total $0.0105
    expect(
      estimateInHouseUsd(1_000, 500, { inputPerMTok: 3, outputPerMTok: 15 }),
    ).toBeCloseTo(0.0105, 9);
  });

  it("is zero for zero tokens", () => {
    expect(estimateInHouseUsd(0, 0, { inputPerMTok: 3, outputPerMTok: 15 })).toBe(0);
  });

  it("clamps negative token counts to 0 (never negative cost)", () => {
    expect(
      estimateInHouseUsd(-100, -100, { inputPerMTok: 3, outputPerMTok: 15 }),
    ).toBe(0);
    expect(
      estimateInHouseUsd(-100, 1_000_000, { inputPerMTok: 3, outputPerMTok: 15 }),
    ).toBeCloseTo(15, 9);
  });

  it("feeds the broker: a tiny task is cheaper to make than a $0.006 buy", () => {
    const inHouseUsd = estimateInHouseUsd(200, 100, { inputPerMTok: 3, outputPerMTok: 15 });
    const d = decideMakeBuy({
      inHouseUsd,
      cheapest: { capabilityId: "summarize", priceUsd: 0.006 },
      remainingUsd: 1,
    });
    expect(d.action).toBe("make");
    expect(d.reason).toBe("in-house-cheaper");
  });
});
