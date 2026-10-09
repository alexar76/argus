import { describe, it, expect } from "vitest";
import {
  canonicalMandate,
  sealMandate,
  anchorWithAestus,
  toMandateArtifact,
  MANDATE_SCHEMA,
  type MandateOracleClient,
} from "../src/mandate/index.js";
import { verifyBundle } from "../src/verify/index.js";
import { buildConscienceBundle } from "../src/conscience/index.js";

const INPUT = {
  taskHash: "ab".repeat(32),
  budgetUsd: 0.5,
  toolsHash: "cd".repeat(32),
  sealedAt: "2026-06-26T10:00:00.000Z",
};

describe("mandate — seal-before-discover", () => {
  it("canonical is stable and the commitment is sha256(canonical)", () => {
    const seal = sealMandate(INPUT);
    expect(seal.schema).toBe(MANDATE_SCHEMA);
    expect(seal.canonical).toBe(canonicalMandate(INPUT));
    // re-derivable: a verifier recomputes the same commitment from the same inputs
    expect(sealMandate(INPUT).commitment).toBe(seal.commitment);
    expect(seal.commitment).toHaveLength(64);
  });

  it("the mandate artifact re-verifies offline; a tampered commitment fails", () => {
    const seal = sealMandate(INPUT);
    expect(verifyBundle([toMandateArtifact(seal)]).ok).toBe(true);
    const forged = { ...toMandateArtifact(seal), hash: "00".repeat(32) };
    expect(verifyBundle([forged]).ok).toBe(false);
  });

  it("buildConscienceBundle puts the mandate first and it verifies", () => {
    const bundle = buildConscienceBundle({ mandate: sealMandate(INPUT) });
    expect(bundle.artifacts[0].type).toBe("commitment");
    expect(verifyBundle(bundle).ok).toBe(true);
  });

  it("anchorWithAestus attaches a time-lock anchor; the offline commitment is unchanged", async () => {
    const mock: MandateOracleClient = {
      async invoke(cap, input) {
        expect(cap).toBe("aestus.seal@v1");
        expect((input as { data: string }).data).toContain("taskHash:");
        return { output: { scheme: "rsw-timelock/v1", N: "0xfff", a: "0x02", T: (input as { T: number }).T, key_commitment: "0xabc", modulus_bits: 2048 } };
      },
    };
    const seal = await anchorWithAestus(sealMandate(INPUT), mock, { T: 1234 });
    expect(seal.aestus?.N).toBe("0xfff");
    expect(seal.aestus?.T).toBe(1234);
    expect(verifyBundle([toMandateArtifact(seal)]).ok).toBe(true); // commitment unaffected
  });

  it("anchorWithAestus is graceful when the oracle is unreachable", async () => {
    const failing: MandateOracleClient = { async invoke() { throw new Error("oracle unreachable"); } };
    const seal = await anchorWithAestus(sealMandate(INPUT), failing);
    expect(seal.aestus).toBeUndefined();
    expect(verifyBundle([toMandateArtifact(seal)]).ok).toBe(true);
  });
});
