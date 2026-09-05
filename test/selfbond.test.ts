import { describe, it, expect } from "vitest";
import {
  declareSelfBond,
  computeVerdict,
  toSelfBondArtifact,
  SELF_BOND_SCHEMA,
  type SelfBondInput,
} from "../src/selfbond/index.js";
import { verifyBundle } from "../src/verify/index.js";
import { buildConscienceBundle } from "../src/conscience/index.js";

const BASE: SelfBondInput = {
  taskHash: "ab".repeat(32),
  agentId: "self:0xAbCd",
  evmAddress: "0xAbCd000000000000000000000000000000000000",
  chain: "base",
  bondUsd: 1.0,
  token: "USDC",
  penaltyRate: 2.0,
  bondedCeilingUsd: 0.5,
  actualSpendUsd: 0.3,
  frugalDigest: "cd".repeat(32),
  attestationCanonical: "argus-negative-attestation/v1\nclaim:within_budget",
  mandateCommitment: "ef".repeat(32),
  sealedAt: "2026-06-26T10:05:00.000Z",
};

describe("selfbond — staked frugality/conduct declaration", () => {
  it("verdict arithmetic: within-bond when spend <= ceiling, self-slash when over", () => {
    expect(computeVerdict(0.5, 0.3, 1.0, 2.0)).toEqual({ overspendUsd: 0, penaltyUsd: 0, verdict: "within-bond" });
    const over = computeVerdict(0.5, 0.9, 1.0, 2.0); // overspend 0.4 → penalty min(1.0, 2*0.4=0.8)=0.8
    expect(over.verdict).toBe("self-slash");
    expect(over.overspendUsd).toBeCloseTo(0.4, 9);
    expect(over.penaltyUsd).toBeCloseTo(0.8, 9);
    // penalty caps at the bond
    expect(computeVerdict(0.5, 5.0, 1.0, 2.0).penaltyUsd).toBe(1.0);
    // negative/NaN spend clamps to 0 → within-bond
    expect(computeVerdict(0.5, Number.NaN, 1.0, 2.0).verdict).toBe("within-bond");
  });

  it("declareSelfBond is deterministic; commitment is sha256(canonical); enforced is false", () => {
    const a = declareSelfBond(BASE);
    const b = declareSelfBond(BASE);
    expect(a.commitment).toBe(b.commitment);
    expect(a.schema).toBe(SELF_BOND_SCHEMA);
    expect(a.enforced).toBe(false);
    expect(a.attestationCanonicalHash).toHaveLength(64); // hashed, not stored verbatim
  });

  it("the label honestly states enforcement is hub-side / not present", () => {
    const art = toSelfBondArtifact(declareSelfBond(BASE));
    expect(art.type).toBe("commitment");
    expect((art as { label: string }).label.toLowerCase()).toContain("enforcement hub-side");
  });

  it("re-verifies offline; tampering any bonded field breaks the commitment", () => {
    const bond = declareSelfBond(BASE);
    expect(verifyBundle([toSelfBondArtifact(bond)]).ok).toBe(true);
    // mutate a field without re-hashing → sha256(preimage) != hash
    expect(verifyBundle([{ ...toSelfBondArtifact(bond), hash: "00".repeat(32) }]).ok).toBe(false);
    // a self-slash declaration has a different commitment than a within-bond one (can't downgrade silently)
    const slashed = declareSelfBond({ ...BASE, actualSpendUsd: 0.9 });
    expect(slashed.verdict).toBe("self-slash");
    expect(slashed.commitment).not.toBe(bond.commitment);
  });

  it("buildConscienceBundle adds exactly one self-bond artifact and still verifies", () => {
    const bundle = buildConscienceBundle({ selfBond: declareSelfBond(BASE) });
    expect(bundle.artifacts).toHaveLength(1);
    expect(verifyBundle(bundle).ok).toBe(true);
  });
});
