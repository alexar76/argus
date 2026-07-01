import { describe, it, expect } from "vitest";
import {
  canonicalSpendCert,
  sealSpendCert,
  selectCheapestTrustworthy,
  toSpendCertArtifact,
  SPEND_CERT_SCHEMA,
  type SpendDecision,
} from "../src/spendcert/index.js";
import { verifyBundle } from "../src/verify/index.js";
import { buildConscienceBundle } from "../src/conscience/index.js";

const AT = "2026-06-26T10:00:00.000Z";

function decision(): SpendDecision {
  return {
    intent: "translate to 5 languages",
    candidates: [
      { capabilityId: "a@v1", priceUsd: 0.01, trustScore: 0.9 },
      { capabilityId: "b@v1", priceUsd: 0.005, trustScore: 0.1 }, // cheaper but BELOW floor
      { capabilityId: "c@v1", priceUsd: 0.02, trustScore: 0.8 }, // OVER budget cap
      { capabilityId: "d@v1", priceUsd: 0.012, trustScore: 0.9 },
    ],
    trustFloor: 0.25,
    budgetCap: 0.015,
    chosen: "a@v1",
    chosenPriceUsd: 0.01,
  };
}

describe("spendcert — cheapest-trustworthy pick", () => {
  it("selectCheapestTrustworthy is argmin above the floor and within budget", () => {
    const d = decision();
    const pick = selectCheapestTrustworthy(d.candidates, d.trustFloor, d.budgetCap);
    expect(pick?.capabilityId).toBe("a@v1"); // b below floor, c over cap, d pricier
  });

  it("canonical is stable under candidate reordering; commitment is sha256(canonical)", () => {
    const d = decision();
    const a = sealSpendCert([d], AT);
    const reordered = { ...d, candidates: [...d.candidates].reverse() };
    const b = sealSpendCert([reordered], AT);
    expect(a.commitment).toBe(b.commitment); // reorder doesn't change the hash
    expect(a.canonical).toBe(canonicalSpendCert([d], AT));
    expect(a.schema).toBe(SPEND_CERT_SCHEMA);
  });

  it("the artifact re-verifies offline; a tampered commitment fails", () => {
    const seal = sealSpendCert([decision()], AT);
    expect(verifyBundle([toSpendCertArtifact(seal)]).ok).toBe(true);
    expect(verifyBundle([{ ...toSpendCertArtifact(seal), hash: "00".repeat(32) }]).ok).toBe(false);
  });

  it("you cannot swap the winner without breaking the hash", () => {
    const honest = sealSpendCert([decision()], AT);
    const swapped = sealSpendCert([{ ...decision(), chosen: "d@v1", chosenPriceUsd: 0.012 }], AT);
    expect(swapped.commitment).not.toBe(honest.commitment); // a re-hash is required → detectable
  });

  it("buildConscienceBundle adds exactly one spend-cert artifact and still verifies", () => {
    const bundle = buildConscienceBundle({ spendCert: sealSpendCert([decision()], AT) });
    expect(bundle.artifacts).toHaveLength(1);
    expect(bundle.artifacts[0].type).toBe("commitment");
    expect(verifyBundle(bundle).ok).toBe(true);
  });

  it("graceful: empty decisions seal without throwing and normalize NaN", () => {
    expect(() => sealSpendCert([], AT)).not.toThrow();
    const nan = sealSpendCert([{ ...decision(), chosenPriceUsd: Number.NaN }], AT);
    expect(nan.canonical).toContain("chosenPriceUsd:0.000000");
  });
});
